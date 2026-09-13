import { spawn } from 'node:child_process';
import type { Logger } from '../logger.js';

export interface AskOption { label: string; description: string }
export interface AskQuestion { question: string; header: string; multiSelect: boolean; options: AskOption[] }
export interface AskUserQuestionPayload { toolUseId: string; questions: AskQuestion[] }

export interface TurnRequest { prompt: string; sessionId: string; resume: boolean; cwd: string }

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

interface ActiveChild { pid: number; killGroup: (s: NodeJS.Signals) => void }

export class ClaudeRunner {
  private readonly active = new Set<ActiveChild>();
  private closed = false;

  constructor(private readonly opts: ClaudeRunnerOptions) {}

  killAll(): void {
    this.closed = true; // 关停后拒绝新 run
    const delay = this.opts.killDelayMs ?? 5_000;
    for (const a of this.active) {
      a.killGroup('SIGTERM');
      setTimeout(() => a.killGroup('SIGKILL'), delay); // TERM 被忽略 → KILL 升级
    }
    this.active.clear();
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
      let entryRef: ActiveChild | null = null;
      const finish = (ok: boolean, errorText: string) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (closeFallbackTimer !== null) clearTimeout(closeFallbackTimer);
        if (entryRef !== null) this.active.delete(entryRef);
        const outputText = fullText();
        void emitChain.then(() => resolve({ ok, outputText, errorText, durationMs: (this.opts.now ?? Date.now)() - started }));
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
      const entry: ActiveChild = { pid: child.pid ?? 0, killGroup };
      entryRef = entry;
      this.active.add(entry);
      timer = setTimeout(() => {
        this.opts.logger.error('agent', `回合超时 ${this.opts.timeoutMs}ms，进程组杀灭 pid=${child.pid}`);
        killGroup('SIGTERM');
        // escalation 完成后才 settle——TERM→KILL 序列对测试确定性成立
        setTimeout(() => { killGroup('SIGKILL'); finish(false, `回合超时（${this.opts.timeoutMs}ms）`); }, this.opts.killDelayMs ?? 5_000);
      }, this.opts.timeoutMs);
      const settleOnExit = () => {
        const code = exitInfo?.code;
        if (code === 0 || (code === null && stdoutClosed)) {
          finish(true, '');
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
        try { ev = JSON.parse(line); } catch { return; } // 防御：非 JSON 行丢弃
        if (ev?.type === 'system' && ev.subtype === 'init') {
          if (ev.session_id !== req.sessionId) {
            this.opts.logger.warn('agent', `init session_id=${ev.session_id} 与请求 ${req.sessionId} 不符`);
          }
          return;
        }
        if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
          const msgId = typeof ev.message.id === 'string' ? ev.message.id : null;
          // 域切换：id 变化；防御回退——id 缺失时已有在飞内容即视为新消息
          const isNewMessage = currentMsgId === null
            ? (inflightAuthoritative !== null || inflightPartial !== null)
            : msgId !== currentMsgId;
          if (isNewMessage) committedText += inflightAuthoritative ?? '';
          currentMsgId = msgId;
          const authoritative: string[] = [];
          let hasText = false;
          for (const block of ev.message.content as any[]) {
            if (block?.type === 'text' && typeof block.text === 'string') { authoritative.push(block.text); hasText = true; }
          }
          if (hasText) inflightAuthoritative = authoritative.join(''); // 权威替换 partial
          inflightPartial = null;
          // 同消息保序：text 块按序流出；遇到问题 tool_use 后抑制（不补发快照——前置 text 已按序 enqueue）
          for (const block of ev.message.content as any[]) {
            if (block?.type === 'text' && !questionSeen) {
              const snapshot = fullText();
              enqueueEmit(() => cbs.onText?.(snapshot));
            }
            if (block?.type === 'tool_use' && block.name === 'AskUserQuestion' && !questionSeen) {
              questionSeen = true;
              const qs = Array.isArray(block.input?.questions) ? block.input.questions : [];
              const payload: AskUserQuestionPayload = { toolUseId: String(block.id ?? ''), questions: qs };
              enqueueEmit(() => cbs.onQuestion?.(payload));
            }
          }
          return;
        }
        if (ev?.type === 'stream_event' && ev.event?.type === 'content_block_delta'
          && ev.event.delta?.type === 'text_delta' && typeof ev.event.delta.text === 'string') {
          inflightPartial = (inflightAuthoritative ?? inflightPartial ?? '') + ev.event.delta.text;
          if (!questionSeen) {
            const snapshot = fullText();
            enqueueEmit(() => cbs.onText?.(snapshot));
          }
          return;
        }
      };
      // 行协议解析：手工 buffer split（兼容注入的 fake 流——仅 data/close 事件）
      let buf = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let idx = buf.indexOf('\n');
        while (idx >= 0) {
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
          idx = buf.indexOf('\n');
        }
      });
      child.stdout!.on('close', () => {
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
