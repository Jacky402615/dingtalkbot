import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from '../logger.js';

export interface AskOption { label: string; description: string }
export interface AskQuestion { question: string; header: string; multiSelect: boolean; options: AskOption[] }
export interface AskUserQuestionPayload { toolUseId: string; questions: AskQuestion[] }

export interface TurnRequest { prompt: string; sessionId: string; resume: boolean; cwd: string; chatKey?: string }

export interface TurnCallbacks {
  onText?(fullTextSoFar: string): void | Promise<void>;
  onQuestion?(payload: AskUserQuestionPayload): void | Promise<void>;
}

export interface TurnResult { ok: boolean; outputText: string; errorText: string; durationMs: number }

export interface ClaudeRunnerOptions {
  bin: string;
  model: string;
  permissionMode: string;
  timeoutMs: number;
  logger: Logger;
  spawnFn?: typeof spawn;
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  killDelayMs?: number;
}

interface ActiveChild {
  pid: number;
  killGroup: (s: NodeJS.Signals) => void;
  abort: (reason: string) => boolean; // true=实际发起强制中止（过滤后到 abort 生效间的自然完成）
  completion: Promise<void>; // 本回合 settle（含 TERM→KILL 升级收尾）
  isSettled(): boolean;
  chatKey?: string; // D3：/stop 按 chat 中止的路由键
}

export class ClaudeRunner {
  private readonly active = new Set<ActiveChild>();
  private readonly byChat = new Map<string, Set<ActiveChild>>(); // D3：/stop 按 chat 路由索引
  private closed = false;

  constructor(private readonly opts: ClaudeRunnerOptions) {}

  activeCountOf(chatKey: string): number { return this.byChat.get(chatKey)?.size ?? 0; }

  // 仅杀该 chat 的在飞回合；返回实际发出中止的回合数（自然完成的在快照期排除）。
  // settle 由 abort 的 TERM→killDelay→KILL→finish 链保证有界。
  async abortChat(chatKey: string, reason: string): Promise<number> {
    const set = this.byChat.get(chatKey);
    if (set === undefined) return 0;
    const targets = [...set].filter((a) => !a.isSettled());
    if (targets.length === 0) return 0;
    const waits = targets.map((a) => a.completion); // 先取 completion——abort 后 settle 仍可达
    let aborted = 0;
    for (const a of targets) { if (a.abort(reason)) aborted += 1; }
    await Promise.all(waits);
    return aborted;
  }

  async killAll(): Promise<void> {
    this.closed = true; // 关停后拒绝新 run
    const waits: Array<Promise<void>> = [];
    for (const a of this.active) {
      a.abort('runner 已关停（killAll）'); // TERM→KILL 升级 + 中止在飞 run
      waits.push(a.completion);
    }
    this.active.clear();
    await Promise.all(waits); // 升级收尾完成才返回——关停不再先于 SIGKILL 退出
  }

  async run(req: TurnRequest, cbs: TurnCallbacks): Promise<TurnResult> {
    if (this.closed) return { ok: false, outputText: '', errorText: 'runner 已关停', durationMs: 0 };
    const started = (this.opts.now ?? Date.now)();
    const args = ['-p', req.prompt, '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--model', this.opts.model, '--permission-mode', this.opts.permissionMode,
      ...(req.resume ? ['--resume', req.sessionId] : ['--session-id', req.sessionId])];
    return new Promise<TurnResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let closeFallbackTimer: ReturnType<typeof setTimeout> | null = null;
      // 文本累计三态（r3 定稿）：partial 与 authoritative 分离，权威替换而非提交
      let committedText = '';
      let inflightAuthoritative: string | null = null;
      let inflightPartial: string | null = null;
      let currentMsgId: string | null = null;
      let questionSeen = false;
      // 回调串行链：异步 onText 不乱序、settle 前排空；链空闲时首回调同步触发（事件即达）
      let emitChain: Promise<void> = Promise.resolve();
      let pendingEmits = 0;
      const logCbErr = (err: unknown): void => {
        this.opts.logger.error('agent', `回合回调抛错（响亮记录，回合继续）: ${String(err)}`);
      };
      const enqueueEmit = (fn: () => void | Promise<void>): void => {
        if (pendingEmits === 0) {
          try {
            const r = fn();
            if (r != null && typeof (r as Promise<void>).then === 'function') {
              pendingEmits = 1;
              emitChain = Promise.resolve(r).catch(logCbErr).then(() => { pendingEmits = 0; });
            }
          } catch (err) { logCbErr(err); }
          return;
        }
        pendingEmits += 1;
        emitChain = emitChain.then(fn).catch(logCbErr).then(() => { pendingEmits -= 1; });
      };
      const fullText = (): string => committedText + (inflightAuthoritative ?? inflightPartial ?? '');
      const killFn = this.opts.killFn ?? ((pid, sig) => process.kill(pid, sig));
      let exitInfo: { code: number | null } | null = null;
      let stdoutClosed = false;
      let forcedError: string | null = null; // 看门狗/killAll 已定性的失败——exit 事件不得改判成功
      const escalationTimers = new Set<ReturnType<typeof setTimeout>>();
      let entryRef: ActiveChild | null = null;
      let markSettled: () => void = () => {};
      const completion = new Promise<void>((r) => { markSettled = r; });
      const finish = (ok: boolean, errorText: string) => {
        if (settled) return;
        settled = true;
        if (forcedError !== null) {
          // 看门狗/关停定性后主进程若已先退（TERM 生效），升级定时器会被下面的 clear 取消——
          // 在此立即补发进程组 SIGKILL，保证 TERM→KILL 纪律（killGroup 对已死组捕获忽略）。
          try { killGroup('SIGKILL'); } catch { /* 已死 */ }
        }
        if (timer !== null) clearTimeout(timer);
        if (closeFallbackTimer !== null) clearTimeout(closeFallbackTimer);
        for (const t of escalationTimers) clearTimeout(t);
        escalationTimers.clear();
        if (entryRef !== null) {
          this.active.delete(entryRef);
          if (entryRef.chatKey !== undefined) {
            const set = this.byChat.get(entryRef.chatKey);
            if (set !== undefined) {
              set.delete(entryRef);
              if (set.size === 0) this.byChat.delete(entryRef.chatKey); // 防泄漏
            }
          }
        }
        const outputText = fullText();
        void emitChain.then(() => {
          resolve({ ok, outputText, errorText, durationMs: (this.opts.now ?? Date.now)() - started });
          markSettled();
        });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = (this.opts.spawnFn ?? spawn)(this.opts.bin, args,
          { cwd: req.cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        this.opts.logger.error('agent', `claude 进程创建失败: ${String(err)}`);
        finish(false, `claude 进程创建失败: ${String(err)}`);
        return;
      }
      const killGroup = (signal: NodeJS.Signals) => {
        try { killFn(-child.pid!, signal); } catch { try { killFn(child.pid!, signal); } catch { /* 已死 */ } }
      };
      const entry: ActiveChild = {
        pid: child.pid ?? 0,
        killGroup,
        completion,
        chatKey: req.chatKey,
        isSettled: () => settled,
        abort: (reason: string) => {
          if (settled) return false; // 竞态窗口内已自然完成——不计入中止数
          forcedError = reason;
          killGroup('SIGTERM');
          const escalation = setTimeout(() => { killGroup('SIGKILL'); finish(false, reason); }, this.opts.killDelayMs ?? 5_000);
          escalationTimers.add(escalation);
          return true;
        },
      };
      entryRef = entry;
      this.active.add(entry);
      if (req.chatKey !== undefined) {
        let set = this.byChat.get(req.chatKey);
        if (set === undefined) { set = new Set(); this.byChat.set(req.chatKey, set); }
        set.add(entry);
      }
      timer = setTimeout(() => {
        this.opts.logger.error('agent', `回合超时 ${this.opts.timeoutMs}ms，进程组杀灭 pid=${child.pid}`);
        forcedError = `回合超时（${this.opts.timeoutMs}ms）`;
        killGroup('SIGTERM');
        // escalation 完成后才 settle——TERM→KILL 序列对测试确定性成立；exit 提前到达也按 forcedError 定性
        const escalation = setTimeout(() => { killGroup('SIGKILL'); finish(false, forcedError!); }, this.opts.killDelayMs ?? 5_000);
        escalationTimers.add(escalation);
      }, this.opts.timeoutMs);
      const settleOnExit = () => {
        if (forcedError !== null) { finish(false, forcedError); return; } // 超时/关停杀灭：不得改判成功
        const code = exitInfo?.code;
        if (code === 0) {
          finish(true, '');
        } else if (code === null) {
          this.opts.logger.error('agent', 'claude 被信号终止（exit code=null）');
          finish(false, 'claude 被信号终止（code=null）');
        } else {
          this.opts.logger.error('agent', `claude 非零退出 code=${code}${stderrTail !== '' ? ` stderr尾=${stderrTail}` : ''}`);
          finish(false, `claude 退出码 ${code}${stderrTail !== '' ? ` stderr: ${stderrTail}` : ''}`);
        }
      };
      const trySettleOnExit = () => {
        if (exitInfo === null) return;
        if (stdoutClosed) { settleOnExit(); return; }
        // close 信号丢失 → 2s 兜底（不吃整个回合超时预算）
        if (closeFallbackTimer === null) {
          closeFallbackTimer = setTimeout(() => { stdoutClosed = true; settleOnExit(); }, 2_000);
        }
      };
      const handleLine = (line: string) => {
        if (line.trim() === '') return;
        let ev: any;
        try { ev = JSON.parse(line); } catch {
          this.opts.logger.warn('agent', `CLI stdout 非 JSON 行（跳过，CLI 契约漂移征兆）: ${line.slice(0, 80)}`);
          return;
        }
        if (ev?.type === 'system' && ev.subtype === 'init') {
          if (ev.session_id !== req.sessionId) {
            this.opts.logger.warn('agent', `init session_id=${ev.session_id} 与请求 ${req.sessionId} 不符`);
          }
          return;
        }
        if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
          const msgId = typeof ev.message.id === 'string' ? ev.message.id : null;
          // 域切换：id 变化；防御回退——id 缺失时每个 complete 事件即新消息。
          // 换域只提交上一消息的权威全文；in-flight partial 属即将到来的消息，由权威全文替换。
          if (msgId === null || currentMsgId === null || msgId !== currentMsgId) {
            committedText += inflightAuthoritative ?? '';
          }
          currentMsgId = msgId;
          // 有序扫描：可见快照只累计到首个 AskUserQuestion 为止（同消息内问题后文本不泄漏进卡流）；
          // 全量累计（含问题后文本）仍写入 inflightAuthoritative 供最终 outputText。
          const allText: string[] = [];
          const preVisible: string[] = [];
          for (const block of ev.message.content as any[]) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              allText.push(block.text);
              if (!questionSeen) {
                preVisible.push(block.text);
                const snapshot = committedText + preVisible.join('');
                enqueueEmit(() => cbs.onText?.(snapshot));
              }
            } else if (block?.type === 'tool_use' && block.name === 'AskUserQuestion' && !questionSeen) {
              questionSeen = true;
              const qs = Array.isArray(block.input?.questions) ? block.input.questions : [];
              const payload: AskUserQuestionPayload = { toolUseId: String(block.id ?? ''), questions: qs };
              enqueueEmit(() => cbs.onQuestion?.(payload));
            }
          }
          inflightAuthoritative = allText.join(''); // 权威替换 partial；无 text 块亦重置为 ''（防旧消息文本被重复提交）
          inflightPartial = null;
          return;
        }
        if (ev?.type === 'stream_event' && ev.event?.type === 'content_block_delta'
          && ev.event.delta?.type === 'text_delta' && typeof ev.event.delta.text === 'string') {
          // 完整事件之后到达的 delta = 下一消息的起点：先提交上一消息权威全文，partial 从零累计
          if (inflightAuthoritative !== null) {
            committedText += inflightAuthoritative;
            inflightAuthoritative = null;
          }
          inflightPartial = (inflightPartial ?? '') + ev.event.delta.text;
          if (!questionSeen) {
            const snapshot = fullText();
            enqueueEmit(() => cbs.onText?.(snapshot));
          }
          return;
        }
      };
      // 行协议解析：手工 buffer split（兼容注入的 fake 流——仅 data/close 事件）
      let buf = '';
      const decoder = new StringDecoder('utf8'); // 多字节 UTF-8 跨 chunk 不破坏（中文回复保真）
      child.stdout!.on('data', (chunk: Buffer) => {
        buf += decoder.write(chunk);
        let idx = buf.indexOf('\n');
        while (idx >= 0) {
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
          idx = buf.indexOf('\n');
        }
      });
      child.stdout!.on('close', () => {
        buf += decoder.end();
        if (buf.trim() !== '') handleLine(buf);
        stdoutClosed = true;
        if (exitInfo !== null) settleOnExit();
      });
      let stderrTail = '';
      child.stderr?.on('data', (b: Buffer) => { stderrTail = (stderrTail + b.toString()).slice(-500); });
      child.on('error', (err: Error) => {
        this.opts.logger.error('agent', `claude 进程错误（ENOENT/权限）: ${String(err)}`);
        stdoutClosed = true; // stdio 不可用
        finish(false, `claude 进程启动失败: ${err.message}`);
      });
      child.on('exit', (code: number | null) => { exitInfo = { code }; trySettleOnExit(); });
    });
  }
}
