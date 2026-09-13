# dingtalkbot D2（Agent session layer: spawn claude, per-chat sessions + TTL resume, AI-card streaming bridge）Implementation Plan

**Goal:** 把 D1 的 echo 网关升级为真 agent 指挥面——每条消息生成一个 claude CLI 无头回合，per-chat 会话 idle-TTL 内 resume，回复以 AI 卡流式（打字机）呈现，卡片任一失败回退恰好一条 markdown 全文。

**Architecture:** 每 chat（p2p=staffId / group=conversationId）一个会话文件（`.bot/sessions/`，gateway 预指派 uuid、`--resume` 续接）；session handler 入口去重→剥前导 @→数字应答判定→入 per-chat 有界串行队列后立即 ack；回合 = 开卡（`createAndDeliver`）→ spawn `claude -p --output-format stream-json` 逐行解析（token 级增量 + AskUserQuestion tool_use 拦截，回调经内部串行链异步化）→ 双阈值节流 `streamingUpdate` 全量推送 → `isFinalize` 收终；任何卡失败降级"恰好一条 markdown 全文"。claude 子进程按进程组监督（wall-clock 看门狗）；队列与 runner 具备关停语义（close 后不再 spawn）。

**Tech Stack:** TypeScript strict + bun（构建/测试）+ node 内建（child_process/crypto/fs）+ 零新增运行时依赖（`dingtalk-stream` 仍是唯一外部依赖，仅 adapter）+ claude CLI（外部二进制，`claude_bin` 可配）。

**Spec:** `docs/issues/2/decisions.md`

## Global Constraints

- **AC1**: p2p 文本往返真实 agent 回复流式进入 AI 卡并以 finished 态收终（spec S1）。CI 面 = 假 claude + 假 HTTP 断言全链路（含 `isFinalize:true` 载荷）；活体面 = runbook（依赖 owner 建卡模板）。
- **AC2**: TTL 内追问 resume 同一会话（上下文保留）；超 TTL 新起会话（spec S2）。CI 面 = SessionStore 时钟注入 + runner 参数断言。
- **AC3**: 同 chat 两条快消息串行执行，无交错流（spec S14）。CI 面 = 集成测试受控 runner 观测串行事件序。
- **AC4**: AI 卡创建/流式更新任一失败 ⇒ 恰好一条 markdown 全文回复 + error 日志，绝不静默丢（spec S4）。
- **AC5**: AskUserQuestion 在卡内渲染为编号列表；纯数字回复（含 `1,3` 多选）解析为结构化应答回传。
- **AC6**: `streamingUpdate` 刷新受时间+字节双阈值节流，日志可观察（每次 flush 记录字节/间隔/抑制次数）。
- **feishubot #62 教训**：一切错误/丢弃路径留 error/warn 日志，禁止静默。
- **node-builtin-only**：`src/` 仅 node 内建 + `dingtalk-stream`（仅 adapter）+ 自有模块；零新增运行时依赖。
- **每任务门禁**：每个 commit 前全量 `bun run typecheck && bun test`。
- **无占位实现**：任何 commit 不含空函数/TODO 桩；计划内测试代码块必须可直接落盘执行。
- **SPEC 只写已验证行为**：live 项标 `live-verified`（待回填）或 `CI-verified`。
- **进程组纪律**：claude 子进程 detached 生成、组信号杀灭（覆盖孙进程）；看门狗超时必杀；关停 = 队列 close（不 spawn 新回合）+ runner.killAll（杀在飞回合）。
- 提交信息 conventional commits（`feat(scope): …` / `test(scope): …` / `docs: …`）。

## Tasks

### Task 1: 配置解析（src/config.ts 扩展）

**Files:**
- Modify: `src/config.ts`
- Test: `tests/unit/config.test.ts`（追加用例）

**Interfaces:**
- Produces: `BotConfig`（10 个可选键的原始形状）；`ResolvedConfig`（全具体字段）；`DEFAULT_CONFIG: ResolvedConfig`；`resolveConfig(raw: BotConfig, logger?: Logger): ResolvedConfig`（非法数值/未知权限模式 → warn + 默认值）。
- Consumes: `Logger`（已有）。

- [x] **Step 1: 写失败测试**（追加到 `tests/unit/config.test.ts`）

```ts
import { resolveConfig, DEFAULT_CONFIG } from '../../src/config.js';
import type { Logger } from '../../src/logger.js';

test('resolveConfig: 空对象 → 全默认；合法值透传', () => {
  expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
  const cfg = resolveConfig({ session_idle_ttl_minutes: 30, ai_card_template_id: 'tpl-1', model: 'glm-5.3' });
  expect(cfg.sessionIdleTtlMinutes).toBe(30);
  expect(cfg.aiCardTemplateId).toBe('tpl-1');
  expect(cfg.model).toBe('glm-5.3');
  expect(cfg.cardStreamMinIntervalMs).toBe(DEFAULT_CONFIG.cardStreamMinIntervalMs);
});

test('resolveConfig: 非法数值/未知权限模式 → warn + 默认', () => {
  const lines: string[] = [];
  const logger: Logger = { debug(){}, info(){}, warn: (_m, msg) => lines.push(msg), error(){} };
  const cfg = resolveConfig({ session_idle_ttl_minutes: -5, agent_turn_timeout_ms: 0, agent_permission_mode: 'yolo' }, logger);
  expect(cfg.sessionIdleTtlMinutes).toBe(DEFAULT_CONFIG.sessionIdleTtlMinutes);
  expect(cfg.agentTurnTimeoutMs).toBe(DEFAULT_CONFIG.agentTurnTimeoutMs);
  expect(cfg.agentPermissionMode).toBe(DEFAULT_CONFIG.agentPermissionMode);
  expect(lines.filter((l) => l.includes('config')).length).toBeGreaterThanOrEqual(3);
});
```

- [x] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/config.test.ts` Expected: FAIL — `resolveConfig` 未导出。
- [x] **Step 3: 实现**（`src/config.ts` 追加；`BotConfig` 从空接口替换为键形状）

```ts
export interface BotConfig {
  session_idle_ttl_minutes?: number;
  ai_card_template_id?: string;
  card_content_key?: string;
  model?: string;
  agent_permission_mode?: string;
  agent_turn_timeout_ms?: number;
  claude_bin?: string;
  card_stream_min_interval_ms?: number;
  card_stream_min_bytes?: number;
  queue_max_per_chat?: number;
}

export interface ResolvedConfig {
  sessionIdleTtlMinutes: number;
  aiCardTemplateId: string;
  cardContentKey: string;
  model: string;
  agentPermissionMode: string; // 'bypassPermissions' | 'acceptEdits'
  agentTurnTimeoutMs: number;
  claudeBin: string;
  cardStreamMinIntervalMs: number;
  cardStreamMinBytes: number;
  queueMaxPerChat: number;
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  sessionIdleTtlMinutes: 60,
  aiCardTemplateId: '',
  cardContentKey: 'content',
  model: 'glm-5.3-flash',
  agentPermissionMode: 'bypassPermissions',
  agentTurnTimeoutMs: 600_000,
  claudeBin: 'claude',
  cardStreamMinIntervalMs: 1_500,
  cardStreamMinBytes: 64,
  queueMaxPerChat: 10,
};

const POSITIVE_KEYS: Array<[keyof BotConfig & string, keyof ResolvedConfig & string]> = [
  ['session_idle_ttl_minutes', 'sessionIdleTtlMinutes'],
  ['agent_turn_timeout_ms', 'agentTurnTimeoutMs'],
  ['card_stream_min_interval_ms', 'cardStreamMinIntervalMs'],
  ['card_stream_min_bytes', 'cardStreamMinBytes'],
  ['queue_max_per_chat', 'queueMaxPerChat'],
];

export function resolveConfig(raw: BotConfig, logger?: Logger): ResolvedConfig {
  const cfg = { ...DEFAULT_CONFIG };
  for (const [rawKey, key] of POSITIVE_KEYS) {
    const v = raw[rawKey];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      logger?.warn('config', `config.json 键 ${rawKey} 非正数（${String(v)}），用默认 ${cfg[key]}`);
    } else {
      (cfg as Record<string, unknown>)[key] = v;
    }
  }
  if (typeof raw.ai_card_template_id === 'string') cfg.aiCardTemplateId = raw.ai_card_template_id;
  if (typeof raw.card_content_key === 'string' && raw.card_content_key !== '') cfg.cardContentKey = raw.card_content_key;
  if (typeof raw.model === 'string' && raw.model !== '') cfg.model = raw.model;
  if (typeof raw.claude_bin === 'string' && raw.claude_bin !== '') cfg.claudeBin = raw.claude_bin;
  const pm = raw.agent_permission_mode;
  if (pm !== undefined) {
    if (pm === 'bypassPermissions' || pm === 'acceptEdits') cfg.agentPermissionMode = pm;
    else logger?.warn('config', `agent_permission_mode 未知（${String(pm)}），用默认 ${cfg.agentPermissionMode}`);
  }
  return cfg;
}
```

- [x] **Step 4: 验证 PASS** — Run: `bun test tests/unit/config.test.ts` Expected: PASS。
- [x] **Step 5: Commit** — `bun run typecheck && bun test && git add src/config.ts tests/unit/config.test.ts && git commit -m "feat(config): D2 agent/card/session config keys with validation"`

### Task 2: claude 子进程 runner（最高风险任务：进程监督 + stream-json 解析 + 异步回调串行化）

**Files:**
- Create: `src/agent/claude-runner.ts`
- Test: `tests/unit/claude-runner.test.ts`
- Create: `tests/helpers/fake-child-process.ts`

**Interfaces:**
- Produces:
  - `AskOption { label: string; description: string }`；`AskQuestion { question: string; header: string; multiSelect: boolean; options: AskOption[] }`；`AskUserQuestionPayload { toolUseId: string; questions: AskQuestion[] }`。
  - `TurnRequest { prompt: string; sessionId: string; resume: boolean; cwd: string }`。
  - `TurnCallbacks { onText?(fullTextSoFar: string): void | Promise<void>; onQuestion?(payload: AskUserQuestionPayload): void | Promise<void> }` —— **回调可异步，runner 内部以串行 promise 链顺序 await**（pushText 的 HTTP PUT 不会乱序/被 finish 越过）；回调抛错 → error 日志（响亮，不静默吞），不使回合失败（桥自管降级）。
  - `TurnResult { ok: boolean; outputText: string; errorText: string; durationMs: number }`（r2 修订：全文与错误原因分列——`outputText` = 全回合累计文本（含 !ok 时的部分文本）；`errorText` = !ok 原因（超时/退出码/ENOENT），ok 时空串）。
  - `ClaudeRunnerOptions { bin; model; permissionMode; timeoutMs; logger: Logger; spawnFn?: typeof spawn; killFn?: (pid: number, signal: NodeJS.Signals) => void; now?: () => number; killDelayMs?: number }`。
  - `ClaudeRunner`：`run(req, cbs): Promise<TurnResult>`；`killAll(): void`。
  - 行为契约：
    - `resume:false` → `--session-id <uuid>`；`resume:true` → `--resume <uuid>`；旗标含 `--output-format stream-json --verbose --include-partial-messages --model --permission-mode`；spawn 选项 `{ cwd, env: process.env, detached: true, stdio: ['ignore','pipe','pipe'] }`。
    - **文本累计（r3 定稿：partial 与 authoritative 分离，杜绝 delta 被误提交/重复）**：`committedText: string`（已完成消息全文之和）+ `inflightAuthoritative: string | null`（当前消息完整事件到达后的权威全文）+ `inflightPartial: string | null`（当前消息完整事件**之前**的 delta 累计）；`fullText = committedText + (inflightAuthoritative ?? inflightPartial ?? '')`。规则：
      - `stream_event.content_block_delta.text_delta` → `inflightPartial = (inflightAuthoritative ?? inflightPartial ?? '') + delta`（完整事件已到则不再有 delta，天然互斥）。
      - assistant 完整事件（**id 存在性已实测** 2026-09-13，`msg_2026…` 形状；**防御回退**：id 缺失时视每个 assistant 事件为新消息）→ 若是新消息：`committedText += inflightAuthoritative ?? ''`；随后 `inflightAuthoritative = 该消息全部 text 块拼接`、`inflightPartial = null`——**权威全文替换 partial，不把 partial 提交进 committed**。
      - result/exit 收尾：`committedText += inflightAuthoritative ?? inflightPartial ?? ''`。
    - **同消息内 text→tool_use 顺序保真**（r2 修订，r3 去重）：content 块按序扫描，text 块就地 enqueue onText；遇到首个 `AskUserQuestion` tool_use 直接置 questionSeen 并 enqueue onQuestion——**不再补发快照**（同消息内前置 text 块已按序 enqueue，避免双发）。
    - **回调串行化**：所有 onText/onQuestion 经内部链 `emitChain = emitChain.then(() => cb(...))`；`run()` 的 settle（exit/error/超时）**等待 emitChain 排空后再 resolve**（stdout 可能晚于 exit 事件抵达的行不丢）。
    - `system/init` 的 `session_id` 与请求 uuid 不一致 → warn 日志（不中断）。
    - 子进程 exit 收尾：`exit` 与 readline `close` **Promise.race 双信号 + 2s 兜底定时器**（close 丢失不等待整个回合超时；settle 时清理兜底定时器）；spawn 同步 throw 路径不触碰 entry（TDZ 安全）。
    - 超时 → 组 SIGTERM → 等 `killDelayMs`（默认 5_000）→ 组 SIGKILL → **此时才 settle** !ok（outputText=部分文本、errorText=超时文案；r3 修订：escalation 完成后 resolve，测试断言 TERM→KILL 序列确定性成立）；spawn `error`（ENOENT）→ error 日志 + settle !ok；非零退出 → error 日志（含 stderr 尾 500 字符）+ settle !ok（outputText=已有文本、errorText=退出码文案）。
    - `killAll()`：置 closed（新 `run()` 直接 `{ok:false, errorText:'runner 已关停'}`）+ 对全部在飞子进程组 SIGTERM、`killDelayMs` 后组 SIGKILL 升级（r2 修订：TERM 被忽略不泄漏）。
- Consumes: `Logger`。

- [x] **Step 1: 写 fake helper** `tests/helpers/fake-child-process.ts`

```ts
export interface FakeChild {
  pid: number;
  killed: string[];
  stdout: { on(event: 'data', cb: (b: Buffer) => void): void; on(event: 'close', cb: () => void): void };
  stderr: { on(event: 'data', cb: (b: Buffer) => void): void };
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  write(line: unknown): void;
  writeRaw(line: string): void;
  closeStdout(): void;
  failSpawn(err: Error): void;
  exitWith(code: number): void;
}

export function makeFakeChild(): FakeChild {
  const errors: Array<(e: Error) => void> = [];
  const exits: Array<(c: number | null) => void> = [];
  const datas: Array<(b: Buffer) => void> = [];
  const closes: Array<() => void> = [];
  return {
    pid: 4321,
    killed: [],
    stdout: { on: (event: string, cb: never) => {
      if (event === 'data') datas.push(cb as unknown as (b: Buffer) => void);
      if (event === 'close') closes.push(cb as unknown as () => void);
    } },
    stderr: { on: () => {} },
    on: (event: string, cb: never) => {
      if (event === 'error') errors.push(cb as unknown as (e: Error) => void);
      if (event === 'exit') exits.push(cb as unknown as (c: number | null) => void);
    },
    write: (line) => { for (const cb of datas) cb(Buffer.from(JSON.stringify(line) + '\n')); },
    writeRaw: (line) => { for (const cb of datas) cb(Buffer.from(line + '\n')); },
    closeStdout: () => { for (const cb of closes) cb(); },
    failSpawn: (err) => { for (const cb of errors) cb(err); },
    exitWith: (code) => { for (const cb of exits) cb(code); },
  };
}
```

（`killed` 由测试注入的 `killFn` 填充：`killFn: (pid, sig) => child.killed.push(`${sig}${pid < 0 ? '-' + (-pid) : ''}`)`——runner 对组发负 pid。）

- [x] **Step 2: 写失败测试** `tests/unit/claude-runner.test.ts`

```ts
import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { ClaudeRunner } from '../../src/agent/claude-runner.js';
import { makeFakeChild, type FakeChild } from '../helpers/fake-child-process.js';
import type { Logger } from '../../src/logger.js';

const silentLogger = (extra: { error?: (m: string) => void } = {}): Logger => ({
  debug(){}, info(){}, warn(){}, error: (_m, msg) => extra.error?.(msg),
});

function makeRunner(child: FakeChild, opts: Record<string, unknown> = {}, spawnCalls: unknown[][] = []) {
  return new ClaudeRunner({
    bin: 'claude', model: 'glm-5.3-flash', permissionMode: 'bypassPermissions', timeoutMs: 60_000,
    logger: silentLogger(), killDelayMs: 10,
    spawnFn: ((...args: unknown[]) => { spawnCalls.push(args); return child as never; }) as unknown as typeof spawn,
    killFn: (pid, sig) => { child.killed.push(`${sig}${pid < 0 ? '-' + String(-pid) : ''}`); },
    ...opts,
  });
}

function assistantMsg(id: string, content: unknown[]) {
  return { type: 'assistant', message: { id, role: 'assistant', content } };
}

test('runner: 旗标/cwd/detached；首回合 --session-id、续回合 --resume', async () => {
  const child = makeFakeChild();
  const calls: unknown[][] = [];
  const r = makeRunner(child, {}, calls);
  const p = r.run({ prompt: 'hi', sessionId: 'uuid-1', resume: false, cwd: '/ws' }, {});
  child.write({ type: 'system', subtype: 'init', session_id: 'uuid-1' });
  child.write(assistantMsg('m1', [{ type: 'text', text: '答案' }]));
  child.write({ type: 'result', subtype: 'success', session_id: 'uuid-1', result: '答案' });
  child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(res.ok).toBe(true);
  const args = calls[0]![1] as string[];
  expect(args).toContain('--session-id'); expect(args).toContain('uuid-1');
  expect(args).toContain('--output-format'); expect(args).toContain('stream-json');
  expect(args).toContain('--verbose'); expect(args).toContain('--include-partial-messages');
  expect(args).toContain('--model'); expect(args).toContain('glm-5.3-flash');
  expect(args).toContain('--permission-mode'); expect(args).toContain('bypassPermissions');
  expect(calls[0]![2]).toMatchObject({ cwd: '/ws', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const p2 = r.run({ prompt: 'again', sessionId: 'uuid-1', resume: true, cwd: '/ws' }, {});
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  await p2;
  expect((calls[1]![1] as string[])).toContain('--resume');
});

test('runner: 多消息文本域隔离——两条 assistant 消息全文拼接不覆盖（评审修复项）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const seen: string[] = [];
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, { onText: (t) => { seen.push(t); return Promise.resolve(); } });
  child.write(assistantMsg('m1', [{ type: 'text', text: '第一段' }]));
  child.write(assistantMsg('m2', [{ type: 'text', text: '第二段' }]));  // 新消息域：committed=['第一段']
  expect(seen.at(-1)).toBe('第一段第二段');
  child.write(assistantMsg('m2b', [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '第三段（index 0 覆写当前域）' }]));
  child.write({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '+增量' } } });
  expect(seen.at(-1)).toBe('第一段第二段第三段（index 0 覆写当前域）+增量');
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(res.outputText).toBe('第一段第二段第三段（index 0 覆写当前域）+增量');
});

test('runner: delta 级增量先于 message 级到达（同域内先加后覆写）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const seen: string[] = [];
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, { onText: (t) => { seen.push(t); } });
  child.write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } } });
  child.write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } } });
  expect(seen.at(-1)).toBe('你好');
  child.write(assistantMsg('m1', [{ type: 'text', text: '你好（权威）' }]));
  expect(seen.at(-1)).toBe('你好（权威）');
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(res.outputText).toBe('你好（权威）');
});

test('runner: 同消息内 text→AskUserQuestion——问题前文本先流出再抑制（r2 修订回归）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const order: string[] = [];
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {
    onText: (t) => { order.push(`text:${t}`); },
    onQuestion: (q) => { order.push(`question:${q.questions[0]!.question}`); },
  });
  child.write(assistantMsg('m1', [
    { type: 'text', text: '先说一句' },
    { type: 'tool_use', id: 'call_9', name: 'AskUserQuestion',
      input: { questions: [{ question: '选哪个？', header: 'H', multiSelect: false, options: [{ label: 'A', description: '' }] }] } },
  ]));
  child.write(assistantMsg('m2', [{ type: 'text', text: '被抑制的后续' }]));
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  await p;
  expect(order).toEqual(['text:先说一句', 'question:选哪个？']); // 前文本先出、后文本抑制
});

test('runner: 超时但已有部分文本 → outputText 与 errorText 分列（r2 修订回归）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child, { timeoutMs: 30 });
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.write(assistantMsg('m1', [{ type: 'text', text: '写了一半' }]));
  const res = await p;
  expect(res.ok).toBe(false);
  expect(res.outputText).toBe('写了一半');
  expect(res.errorText).toContain('超时');
});

test('runner: exit 后 stdout close 丢失 → 2s 兜底定时器仍 settle（r2 修订回归）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.write(assistantMsg('m1', [{ type: 'text', text: 'ok' }]));
  child.exitWith(0); // 不 closeStdout
  const res = await p;
  expect(res.ok).toBe(true);
  expect(res.outputText).toBe('ok');
});

test('runner: AskUserQuestion 拦截 + 其后文本抑制（decisions D2）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const questions: unknown[] = [];
  const texts: string[] = [];
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' },
    { onQuestion: (q) => { questions.push(q); }, onText: (t) => { texts.push(t); } });
  child.write(assistantMsg('m1', [{ type: 'text', text: '我想问：' }]));
  child.write(assistantMsg('m2', [{ type: 'tool_use', id: 'call_1', name: 'AskUserQuestion',
    input: { questions: [{ question: '红还是蓝？', header: 'Color', multiSelect: false,
      options: [{ label: '红', description: 'red' }, { label: '蓝', description: 'blue' }] }] } }]));
  child.write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'Answer questions?' }] } });
  child.write(assistantMsg('m3', [{ type: 'text', text: '问题被拒了（应被抑制）' }]));
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  await p;
  expect(questions).toHaveLength(1);
  expect((questions[0] as { toolUseId: string }).toolUseId).toBe('call_1');
  expect(texts.at(-1)).toBe('我想问：');
});

test('runner: 异步 onText 串行化——finish 前所有 PUT 完成、顺序不乱（评审修复项）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const order: string[] = [];
  let gate = Promise.resolve();
  const slowOnText = (t: string) => {
    const run = gate.then(() => { order.push(`text:${t}`); });
    gate = run; // 人为让每次回调排队且慢
    return run;
  };
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, { onText: slowOnText });
  child.write(assistantMsg('m1', [{ type: 'text', text: '一' }]));
  child.write(assistantMsg('m2', [{ type: 'text', text: '二' }]));
  child.write({ type: 'result', subtype: 'success' });
  child.closeStdout(); child.exitWith(0);
  await p; // settle 等待 emitChain 排空
  expect(order).toEqual(['text:一', 'text:一二']); // 无乱序、无丢失
});

test('runner: init session_id 与请求不符 → warn', async () => {
  const child = makeFakeChild();
  const warns: string[] = [];
  const r = makeRunner(child, {}, []);
  (r as unknown as { opts: { logger: Logger } }).opts.logger.warn = (_m, msg) => warns.push(msg);
  const p = r.run({ prompt: 'x', sessionId: 'uuid-A', resume: false, cwd: '/ws' }, {});
  child.write({ type: 'system', subtype: 'init', session_id: 'uuid-B' });
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  await p;
  expect(warns.some((w) => w.includes('session'))).toBe(true);
});

test('runner: 非零退出 → ok:false；exit 后晚到 stdout 行不丢（评审修复项）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const texts: string[] = [];
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, { onText: (t) => { texts.push(t); } });
  child.write(assistantMsg('m1', [{ type: 'text', text: '部分输出' }]));
  child.exitWith(2);          // exit 先到
  child.write(assistantMsg('m1z', [{ type: 'text', text: '迟到行' }])); // close 前仍可达（readline 已缓冲）
  child.closeStdout();
  const res = await p;
  expect(res.ok).toBe(false);
  expect(res.outputText).toContain('部分输出'); // !ok 时部分文本在 outputText
  expect(res.errorText).toContain('2');         // 错误原因在 errorText
});

test('runner: 看门狗超时 → 组 SIGTERM→SIGKILL，ok:false', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child, { timeoutMs: 30 });
  const res = await r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  expect(res.ok).toBe(false);
  expect(res.errorText).toContain('超时');
  expect(child.killed[0]).toBe('SIGTERM-4321');
  expect(child.killed.at(-1)).toBe('SIGKILL-4321');
});

test('runner: ENOENT → 响亮 ok:false', async () => {
  const child = makeFakeChild();
  const errs: string[] = [];
  const r = new ClaudeRunner({ bin: 'nope', model: 'm', permissionMode: 'bypassPermissions', timeoutMs: 1_000,
    logger: silentLogger({ error: (m) => errs.push(m) }), killDelayMs: 5,
    spawnFn: (() => child) as unknown as typeof spawn,
    killFn: () => {} });
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.failSpawn(new Error('spawn nope ENOENT'));
  const res = await p;
  expect(res.ok).toBe(false);
  expect(res.errorText).toContain('claude');
  expect(errs.some((e) => e.includes('ENOENT') || e.includes('spawn'))).toBe(true);
});

test('runner: 非 JSON 行防御跳过（不崩）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.writeRaw('not-json');
  child.writeRaw('');
  child.write({ type: 'result', subtype: 'success' });
  child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(res.ok).toBe(true);
});
```

（fake helper 增补 `writeRaw(line: string)`：直接把原始字符串喂给 data 回调（绕过 JSON.stringify）——`not-json`/空行用例走它。）

- [x] **Step 3: 验证 FAIL** — Run: `bun test tests/unit/claude-runner.test.ts` Expected: FAIL — 模块不存在。
- [x] **Step 4: 实现** `src/agent/claude-runner.ts`（按行为契约直写；关键骨架）

```ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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
  bin: string; model: string; permissionMode: string; timeoutMs: number; logger: Logger;
  spawnFn?: typeof spawn; killFn?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number; killDelayMs?: number;
}

export class ClaudeRunner {
  private readonly active = new Set<{ pid: number; killGroup: (s: NodeJS.Signals) => void }>();
  private closed = false;

  constructor(private readonly opts: ClaudeRunnerOptions) {}

  killAll(): void {
    this.closed = true; // 关停后拒绝新 run（评审修复）
    const delay = this.opts.killDelayMs ?? 5_000;
    for (const a of this.active) {
      a.killGroup('SIGTERM'); // r2 修订：TERM → delay → KILL 升级
      setTimeout(() => a.killGroup('SIGKILL'), delay);
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
      let committedText = '';            // 已完成消息全文之和（r3 定稿）
      let inflightAuthoritative: string | null = null; // 当前消息完整事件后的权威全文
      let inflightPartial: string | null = null;       // 完整事件前的 delta 累计
      let currentMsgId: string | null = null;
      let questionSeen = false;
      let emitChain: Promise<void> = Promise.resolve(); // 回调串行链
      const enqueueEmit = (fn: () => void | Promise<void>) => {
        emitChain = emitChain.then(fn).catch((err) => {
          this.opts.logger.error('agent', `回合回调抛错（响亮记录，回合继续）: ${String(err)}`); // 不静默
        });
      };
      const fullText = () => committedText + (inflightAuthoritative ?? inflightPartial ?? '');
      const killFn = this.opts.killFn ?? ((pid, sig) => process.kill(pid, sig));
      let exitInfo: { code: number | null } | null = null;
      let stdoutClosed = false;
      let entryRef: { pid: number; killGroup: (s: NodeJS.Signals) => void } | null = null;
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
        finish(false, `claude 进程创建失败: ${String(err)}`); // entryRef 为 null——安全
        return;
      }
      const killGroup = (signal: NodeJS.Signals) => {
        try { killFn(-child.pid!, signal); } catch { try { killFn(child.pid!, signal); } catch { /* 已死 */ } }
      };
      const entry = { pid: child.pid ?? 0, killGroup };
      entryRef = entry;
      this.active.add(entry);
      timer = setTimeout(() => {
        this.opts.logger.error('agent', `回合超时 ${this.opts.timeoutMs}ms，进程组杀灭 pid=${child.pid}`);
        killGroup('SIGTERM');
        // r3 修订：escalation 完成后才 settle——TERM→KILL 序列对测试确定性成立
        setTimeout(() => { killGroup('SIGKILL'); finish(false, `回合超时（${this.opts.timeoutMs}ms）`); }, this.opts.killDelayMs ?? 5_000);
      }, this.opts.timeoutMs);
      const settleOnExit = () => {
        const code = exitInfo?.code;
        if (code === 0 || code === null && stdoutClosed) finish(true, '');
        else {
          this.opts.logger.error('agent', `claude 非零退出 code=${code}`);
          finish(false, `claude 退出码 ${code}`);
        }
      };
      const trySettleOnExit = () => {
        if (exitInfo === null) return;
        if (stdoutClosed) { settleOnExit(); return; }
        // r2 修订：close 信号丢失 → 2s 兜底（不吃掉整个回合超时预算）
        if (closeFallbackTimer === null) {
          closeFallbackTimer = setTimeout(() => { stdoutClosed = true; settleOnExit(); }, 2_000);
        }
      };
      const handleLine = (line: string) => {
        if (line.trim() === '') return;
        let ev: any;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev?.type === 'system' && ev.subtype === 'init') {
          if (ev.session_id !== req.sessionId) this.opts.logger.warn('agent', `init session_id=${ev.session_id} 与请求 ${req.sessionId} 不符`);
          return;
        }
        if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
          const msgId = typeof ev.message.id === 'string' ? ev.message.id : null;
          const isNewMessage = currentMsgId === null ? (inflightAuthoritative !== null || inflightPartial !== null) : msgId !== currentMsgId;
          if (isNewMessage) { committedText += inflightAuthoritative ?? ''; } // 防御回退：id 缺失时每个事件即新消息
          currentMsgId = msgId;
          const authoritative: string[] = [];
          let hasText = false;
          for (const block of ev.message.content as any[]) {
            if (block?.type === 'text' && typeof block.text === 'string') { authoritative.push(block.text); hasText = true; }
          }
          inflightAuthoritative = hasText ? authoritative.join('') : inflightAuthoritative; // 权威替换 partial
          inflightPartial = null;
          // 同消息保序（r3 去重：text 块已在上面的权威替换中生效，这里只按序处理 tool_use 拦截）
          for (const block of ev.message.content as any[]) {
            if (block?.type === 'text' && !questionSeen) { const snapshot = fullText(); enqueueEmit(() => cbs.onText?.(snapshot)); }
            if (block?.type === 'tool_use' && block.name === 'AskUserQuestion' && !questionSeen) {
              questionSeen = true; // 不补发快照——前置 text 块已在循环内按序 enqueue
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
          if (!questionSeen) { const snapshot = fullText(); enqueueEmit(() => cbs.onText?.(snapshot)); }
          return;
        }
      };
      createInterface({ input: child.stdout! }).on('line', handleLine).on('close', () => { stdoutClosed = true; if (exitInfo !== null) settleOnExit(); });
      let stderrTail = '';
      child.stderr?.on('data', (b: Buffer) => { stderrTail = (stderrTail + b.toString()).slice(-500); });
      child.on('error', (err) => {
        this.opts.logger.error('agent', `claude 进程错误（ENOENT/权限）: ${String(err)}`);
        stdoutClosed = true; // stdio 不可用
        finish(false, `claude 进程启动失败: ${err.message}`);
      });
      child.on('exit', (code) => { exitInfo = { code }; trySettleOnExit(); });
    });
  }
}
```

（strict 注：`stderrTail` 在非零退出 errorText 中拼接（`claude 退出码 ${code}${stderrTail ? ` stderr: ${stderrTail}` : ''}`）；`settleOnExit` 的 `code === null && stdoutClosed` 分支覆盖信号致死场景。）
- [x] **Step 5: 验证 PASS** — Run: `bun test tests/unit/claude-runner.test.ts` Expected: PASS（13 tests）。`bun run typecheck` 绿。
- [x] **Step 6: Commit** — `bun run typecheck && bun test && git add src/agent/claude-runner.ts tests/helpers/fake-child-process.ts tests/unit/claude-runner.test.ts && git commit -m "feat(agent): supervised headless claude runner — message-scoped text accumulation, serialized async callbacks, process-group watchdog"`

**--- 检查点 A：最高风险面（子进程监督/流解析/回调串行化）落地 ---**

### Task 3: AI 卡 OpenAPI client（src/openapi/card.ts）

**Files:**
- Create: `src/openapi/card.ts`
- Test: `tests/unit/card-client.test.ts`

**Interfaces:**
- Consumes: `TokenManager`、`Logger`、`withDeadline`（均已有）。
- Produces: `CardTarget { kind: 'p2p' | 'group'; conversationId: string; senderStaffId: string; robotCode: string }`；`CardClientOptions { tokenManager; logger?; fetchFn?; apiBase?; requestTimeoutMs? }`；`CardClient`：
  - `createAndDeliver(args: { templateId: string; contentKey: string; target: CardTarget }): Promise<string>`（返回 outTrackId=randomUUID()）→ `POST /v1.0/card/instances/createAndDeliver`，body：`{cardTemplateId, outTrackId, cardData:{cardParamMap:{[contentKey]:''}}, callbackType:'STREAM', openSpaceId, imGroupOpenDeliverModel:{robotCode}}`（群）或 `{..., imRobotOpenDeliverModel:{spaceType:'IM_ROBOT'}}`（p2p）；openSpaceId = `dtv1.card//IM_GROUP.<conversationId>` / `dtv1.card//IM_ROBOT.<senderStaffId>`。
  - `streamingUpdate(args: { outTrackId: string; contentKey: string; content: string; finalize: boolean; error?: boolean }): Promise<void>` → `PUT /v1.0/card/streaming`，body `{outTrackId, guid: randomUUID(), key: contentKey, content, isFull: true, isFinalize: finalize, isError: error ?? false}`。
  - 非 2xx/网络错误：error 日志 + 抛错（deadline 10s，同 RobotReplyer 模式）。

- [x] **Step 1: 写失败测试**

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardClient } from '../../src/openapi/card.js';
import { TokenManager } from '../../src/openapi/token.js';

function okTokenFetch() {
  return (async () => new Response(JSON.stringify({ accessToken: 'TKN', expireIn: 7_200 }), { status: 200 })) as unknown as typeof fetch;
}
function captureFetch(calls: Array<{ method: string; url: string; headers: Record<string, string>; body: any }>, status = 200) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response(status === 200 ? '{}' : '{"code":"Card.NotFound"}', { status });
  }) as unknown as typeof fetch;
}
const TARGET_P2P = { kind: 'p2p' as const, conversationId: 'cid-p', senderStaffId: 'st1', robotCode: 'rc1' };
const TARGET_GROUP = { kind: 'group' as const, conversationId: 'cidG', senderStaffId: 'st2', robotCode: 'rc1' };

function makeClient(calls: Array<{ method: string; url: string; body: any }>, status = 200) {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-card-'));
  return new CardClient({ tokenManager: new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 't.json'), fetchFn: okTokenFetch() }), fetchFn: captureFetch(calls as never, status) });
}

test('card: p2p createAndDeliver 载荷形状（IM_ROBOT 路由）', async () => {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const outTrackId = await makeClient(calls).createAndDeliver({ templateId: 'tpl-9', contentKey: 'content', target: TARGET_P2P });
  expect(outTrackId).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.dingtalk.com/v1.0/card/instances/createAndDeliver' });
  expect((calls[0] as { headers: Record<string, string> }).headers['x-acs-dingtalk-access-token']).toBe('TKN');
  expect(calls[0].body).toMatchObject({
    cardTemplateId: 'tpl-9', outTrackId, callbackType: 'STREAM',
    cardData: { cardParamMap: { content: '' } },
    openSpaceId: 'dtv1.card//IM_ROBOT.st1',
    imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT' },
  });
  expect(calls[0].body.imGroupOpenDeliverModel).toBeUndefined();
});

test('card: 群 createAndDeliver 载荷形状（IM_GROUP 路由 + robotCode）', async () => {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  await makeClient(calls).createAndDeliver({ templateId: 'tpl-9', contentKey: 'c', target: TARGET_GROUP });
  expect(calls[0].body).toMatchObject({ openSpaceId: 'dtv1.card//IM_GROUP.cidG', imGroupOpenDeliverModel: { robotCode: 'rc1' } });
});

test('card: streamingUpdate PUT 载荷（isFull 恒真；finalize/error 旗标；guid 每次唯一）', async () => {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const client = makeClient(calls);
  await client.streamingUpdate({ outTrackId: 'ot-1', contentKey: 'content', content: '部分', finalize: false });
  await client.streamingUpdate({ outTrackId: 'ot-1', contentKey: 'content', content: '全文', finalize: true, error: false });
  expect(calls.map((c) => c.method)).toEqual(['PUT', 'PUT']);
  for (const c of calls) expect(c.url).toBe('https://api.dingtalk.com/v1.0/card/streaming');
  expect(calls[0].body).toMatchObject({ outTrackId: 'ot-1', key: 'content', content: '部分', isFull: true, isFinalize: false, isError: false });
  expect(calls[0].body.guid).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[1].body.guid).not.toBe(calls[0].body.guid);
  expect(calls[1].body).toMatchObject({ content: '全文', isFinalize: true });
});

test('card: 非 2xx → 响亮抛错（带响应体）', async () => {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const client = makeClient(calls, 404);
  await expect(client.createAndDeliver({ templateId: 't', contentKey: 'c', target: TARGET_P2P })).rejects.toThrow('Card.NotFound');
  await expect(client.streamingUpdate({ outTrackId: 'o', contentKey: 'c', content: 'x', finalize: true })).rejects.toThrow('404');
});
```

- [x] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/card-client.test.ts` Expected: FAIL。
- [x] **Step 3: 实现** `src/openapi/card.ts`

```ts
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { TokenManager } from './token.js';
import { withDeadline } from '../deadline.js';
import { API_BASE } from './robot.js';

export interface CardTarget { kind: 'p2p' | 'group'; conversationId: string; senderStaffId: string; robotCode: string }
export interface CardClientOptions { tokenManager: TokenManager; logger?: Logger; fetchFn?: typeof fetch; apiBase?: string; requestTimeoutMs?: number }

export class CardClient {
  constructor(private readonly opts: CardClientOptions) {}

  private async request(method: 'POST' | 'PUT', path: string, body: unknown): Promise<void> {
    const doFetch = this.opts.fetchFn ?? fetch;
    const base = this.opts.apiBase ?? API_BASE;
    const timeoutMs = this.opts.requestTimeoutMs ?? 10_000;
    const token = await this.opts.tokenManager.getAccessToken();
    try {
      await withDeadline(`OpenAPI ${method} ${path}`, timeoutMs, async (signal) => {
        const resp = await doFetch(base + path, {
          method, headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
          body: JSON.stringify(body), signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch((e) => `（错误体读取失败: ${String(e)}）`);
          throw new Error(`HTTP ${resp.status} ${text}`);
        }
      });
    } catch (err) {
      const e = new Error(`OpenAPI ${path} 失败: ${String(err)}`);
      this.opts.logger?.error('card', e.message);
      throw e;
    }
  }

  async createAndDeliver(args: { templateId: string; contentKey: string; target: CardTarget }): Promise<string> {
    const outTrackId = randomUUID();
    const body: Record<string, unknown> = {
      cardTemplateId: args.templateId, outTrackId,
      cardData: { cardParamMap: { [args.contentKey]: '' } }, callbackType: 'STREAM',
    };
    if (args.target.kind === 'group') {
      body.openSpaceId = `dtv1.card//IM_GROUP.${args.target.conversationId}`;
      body.imGroupOpenDeliverModel = { robotCode: args.target.robotCode };
    } else {
      body.openSpaceId = `dtv1.card//IM_ROBOT.${args.target.senderStaffId}`;
      body.imRobotOpenDeliverModel = { spaceType: 'IM_ROBOT' };
    }
    await this.request('POST', '/v1.0/card/instances/createAndDeliver', body);
    return outTrackId;
  }

  async streamingUpdate(args: { outTrackId: string; contentKey: string; content: string; finalize: boolean; error?: boolean }): Promise<void> {
    await this.request('PUT', '/v1.0/card/streaming', {
      outTrackId: args.outTrackId, guid: randomUUID(), key: args.contentKey,
      content: args.content, isFull: true, isFinalize: args.finalize, isError: args.error ?? false,
    });
  }
}
```

- [x] **Step 4: 验证 PASS** — Run: `bun test tests/unit/card-client.test.ts` Expected: PASS（4 tests）。
- [x] **Step 5: Commit** — `bun run typecheck && bun test && git add src/openapi/card.ts tests/unit/card-client.test.ts && git commit -m "feat(card): AI-card createAndDeliver + streamingUpdate OpenAPI client"`

### Task 4: 双阈值节流器（src/cards/stream-throttle.ts）

**Files:**
- Create: `src/cards/stream-throttle.ts`
- Test: `tests/unit/stream-throttle.test.ts`

**Interfaces:**
- Produces: `StreamThrottleOptions { minIntervalMs: number; minBytes: number; now?: () => number }`；`StreamThrottle`：
  - `shouldFlush(newBytes: number): boolean` —— 距上次 flush ≥ minIntervalMs **且** newBytes ≥ minBytes；从未 flush 时只看字节阈值（lastFlush 初始 -Infinity）。
  - `markFlushed(): void`；`get suppressedSinceFlush(): number`。

- [x] **Step 1: 写失败测试**

```ts
import { test, expect } from 'bun:test';
import { StreamThrottle } from '../../src/cards/stream-throttle.js';

test('throttle: AND 语义——时间够但字节不够 → 不刷', () => {
  let clock = 0;
  const t = new StreamThrottle({ minIntervalMs: 1_000, minBytes: 64, now: () => clock });
  t.markFlushed();
  clock += 2_000;
  expect(t.shouldFlush(10)).toBe(false);
  expect(t.suppressedSinceFlush).toBe(1);
  expect(t.shouldFlush(64)).toBe(true);
});

test('throttle: 字节够但时间不够 → 不刷；首次只看字节', () => {
  let clock = 1_000_000;
  const t = new StreamThrottle({ minIntervalMs: 1_500, minBytes: 64, now: () => clock });
  expect(t.shouldFlush(64)).toBe(true);
  const t2 = new StreamThrottle({ minIntervalMs: 1_500, minBytes: 64, now: () => clock });
  t2.markFlushed();
  expect(t2.shouldFlush(1_000)).toBe(false);
});
```

- [x] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/stream-throttle.test.ts` Expected: FAIL。
- [x] **Step 3: 实现**

```ts
export interface StreamThrottleOptions { minIntervalMs: number; minBytes: number; now?: () => number }

export class StreamThrottle {
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private suppressed = 0;

  constructor(private readonly opts: StreamThrottleOptions) {}

  shouldFlush(newBytes: number): boolean {
    const now = (this.opts.now ?? Date.now)();
    const ok = now - this.lastFlushAt >= this.opts.minIntervalMs && newBytes >= this.opts.minBytes;
    if (!ok) this.suppressed += 1;
    return ok;
  }

  markFlushed(): void {
    this.lastFlushAt = (this.opts.now ?? Date.now)();
    this.suppressed = 0;
  }

  get suppressedSinceFlush(): number { return this.suppressed; }
}
```

- [x] **Step 4: 验证 PASS** — Run: `bun test tests/unit/stream-throttle.test.ts` Expected: PASS。
- [x] **Step 5: Commit** — `bun run typecheck && bun test && git add src/cards/stream-throttle.ts tests/unit/stream-throttle.test.ts && git commit -m "feat(card): dual-threshold stream throttle for quota protection"`

### Task 5: AI 卡桥（src/cards/ai-card-bridge.ts）

**Files:**
- Create: `src/cards/ai-card-bridge.ts`
- Test: `tests/unit/ai-card-bridge.test.ts`

**Interfaces:**
- Consumes: `CardClient`（Task 3）、`StreamThrottle`（Task 4）、`RobotReplyer`、`InboundRobotMessage`、`Logger`。
- Produces: `AiCardBridgeDeps { cardClient: CardClient; replyer: RobotReplyer; logger: Logger; msg: InboundRobotMessage; templateId: string; contentKey: string; minIntervalMs: number; minBytes: number; now?: () => number }`；`AiCardBridge`：
  - `start(): Promise<void>` —— templateId 空 → `markdownOnly`（info 日志，一次性，非错误）；createAndDeliver 失败 → dead + error 日志（回合继续）。
  - `pushText(full: string): Promise<void>` —— dead → noop；**newBytes = Buffer.byteLength(clamp(full)) - Buffer.byteLength(lastFlushedContent)**（增量字节，评审修复）；节流决策：刷 → `streamingUpdate(clamp(full))`（成功记 lastFlushedContent + 记录本次 intervalMs（距上次 flush 毫秒）+ markFlushed + info 日志 `卡片流式 bytes=<累计> delta=<增量> intervalMs=<间隔> suppressed=<n>`（r3 修订：AC6 三要素 bytes/interval/suppressed 齐全）；失败 → error 日志 + **尽力一次 isError finalize（decisions D6）** → dead）；不刷 → 计数。
  - `finish(finalFull: string): Promise<void>` —— dead → `sendFallbackMarkdown(clamp(finalFull))`（恰好一次守卫）；活 → `streamingUpdate(finalize:true)`（成功 → info `卡片收终 bytes=… flushes=… suppressed=…`；失败 → error 日志 + sendFallbackMarkdown）。
  - `fail(errorText: string, partialText?: string): Promise<void>` —— 活卡 → 尽力一次 isError finalize（content = `回复中断：${errorText}` + 已有部分文本）；**该 finalize 再失败 → dead + `sendFallbackMarkdown(错误+部分文本)` 恰好一次（r2 修订：任何卡失败路径都有一条用户可见终态，不留无终卡）**；dead 卡 → `sendFallbackMarkdown(拼接 errorText 与 partialText)` 恰好一次。
  - `get alive(): boolean`；`get flushCount(): number`（日志/测试用）。
  - `clamp(text)`：>30_000 字符截断 + `…（超长截断）` + 一次性 warn。
  - `sendFallbackMarkdown`：p2p→`sendOtoMarkdown(robotCode,[senderStaffId],'dingtalkbot',text)`；group→`sendGroupMarkdown`；`fallbackSent` 恰好一次；自身失败 → error 日志（通道穷尽）。

- [x] **Step 1: 写失败测试** `tests/unit/ai-card-bridge.test.ts`

```ts
import { test, expect } from 'bun:test';
import { AiCardBridge } from '../../src/cards/ai-card-bridge.js';
import type { CardClient } from '../../src/openapi/card.js';
import type { RobotReplyer } from '../../src/openapi/robot.js';
import type { InboundRobotMessage } from '../../src/transport/types.js';
import type { Logger } from '../../src/logger.js';

function msg(kind: 'p2p' | 'group' = 'p2p'): InboundRobotMessage {
  return { msgId: 'm1', conversationId: 'cid', conversationKind: kind, senderStaffId: 's1', senderNick: 'n',
    robotCode: 'rc', msgtype: 'text', textContent: 'hi', sessionWebhook: null, raw: {} };
}

interface Harness {
  bridge: AiCardBridge;
  cardCalls: Array<{ op: string; args: any }>;
  mdCalls: Array<{ method: string; text: string }>;
  infos: string[]; errs: string[]; warns: string[];
}

function harness(msgKind: 'p2p' | 'group', opts: { cardFailsAt?: number; createFails?: boolean; minBytes?: number; minIntervalMs?: number } = {}): Harness {
  const cardCalls: Array<{ op: string; args: any }> = [];
  const mdCalls: Array<{ method: string; text: string }> = [];
  const infos: string[] = []; const errs: string[] = []; const warns: string[] = [];
  let cardCall = 0;
  const cardClient = {
    createAndDeliver: async (args: any) => {
      cardCalls.push({ op: 'create', args });
      if (opts.createFails) throw new Error('HTTP 404 Card.NotFound');
      return 'ot-1';
    },
    streamingUpdate: async (args: any) => {
      cardCall += 1; cardCalls.push({ op: 'update', args });
      if (opts.cardFailsAt === cardCall) throw new Error('stream boom');
    },
  } as unknown as CardClient;
  const replyer = {
    sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { mdCalls.push({ method: 'oto', text }); },
    sendGroupMarkdown: async (_r: string, _c: string, _t: string, text: string) => { mdCalls.push({ method: 'group', text }); },
  } as unknown as RobotReplyer;
  const logger: Logger = { debug(){}, info: (_m, m) => infos.push(m), warn: (_m, m) => warns.push(m), error: (_m, m) => errs.push(m) };
  const bridge = new AiCardBridge({ cardClient, replyer, logger, msg: msg(msgKind), templateId: 'tpl', contentKey: 'content',
    minIntervalMs: opts.minIntervalMs ?? 0, minBytes: opts.minBytes ?? 1 });
  return { bridge, cardCalls, mdCalls, infos, errs, warns };
}

test('bridge: 正常流——开卡→节流推送→finalize 收终；无 markdown 回退', async () => {
  const h = harness('p2p');
  await h.bridge.start();
  await h.bridge.pushText('第一');
  await h.bridge.pushText('第一第二');
  await h.bridge.finish('第一第二（终）');
  expect(h.cardCalls.map((c) => c.op)).toEqual(['create', 'update', 'update', 'update']);
  expect(h.cardCalls[3].args).toMatchObject({ content: '第一第二（终）', finalize: true, error: false });
  expect(h.mdCalls).toHaveLength(0);
  expect(h.infos.some((m) => m.includes('卡片收终'))).toBe(true);
});

test('bridge: AC6——增量字节阈值：10+10 抑制、再 +64 刷（评审修复项）', async () => {
  const h = harness('p2p', { minBytes: 64, minIntervalMs: 0 });
  await h.bridge.start();
  await h.bridge.pushText('0123456789');            // 10 字节 <64 → 抑制
  await h.bridge.pushText('01234567890123456789');  // 增量 10 <64 → 抑制
  expect(h.cardCalls.filter((c) => c.op === 'update')).toHaveLength(0);
  await h.bridge.pushText('01234567890123456789' + 'x'.repeat(64)); // 增量 ≥64 → 刷
  expect(h.cardCalls.filter((c) => c.op === 'update')).toHaveLength(1);
  expect(h.infos.some((m) => m.includes('suppressed=2'))).toBe(true);
  expect(h.infos.some((m) => m.includes('intervalMs='))).toBe(true); // r3：间隔字段在场
  await h.bridge.finish('终稿');
  expect(h.cardCalls.at(-1)!.args).toMatchObject({ finalize: true });
});

test('bridge: AC4——开卡失败 → 恰好一条 markdown 全文 + error 日志', async () => {
  const h = harness('p2p', { createFails: true });
  await h.bridge.start();
  await h.bridge.pushText('部分');
  await h.bridge.finish('完整回复全文');
  expect(h.mdCalls).toEqual([{ method: 'oto', text: '完整回复全文' }]);
  expect(h.errs.some((e) => e.includes('404'))).toBe(true);
});

test('bridge: AC4——流更新中途失败 → 尽力 isError 收终 + 停更 + 恰好一条 markdown 全文', async () => {
  const h = harness('group', { cardFailsAt: 2 });
  await h.bridge.start();
  await h.bridge.pushText('一');        // update 1 成功
  await h.bridge.pushText('一二');      // update 2 失败 → 尝试 isError finalize（update 3）→ dead
  await h.bridge.pushText('一二三');    // dead noop
  await h.bridge.finish('一二三（终）');
  const updates = h.cardCalls.filter((c) => c.op === 'update');
  expect(updates).toHaveLength(3);                                  // 1 成功 + 1 失败 + 1 isError 收终
  expect(updates[2].args).toMatchObject({ finalize: true, error: true });
  expect(h.mdCalls).toEqual([{ method: 'group', text: '一二三（终）' }]); // 恰好一条全文
});

test('bridge: fail——活卡 isError 收终；dead 卡 markdown 含错误+部分文本；双降级不叠加', async () => {
  const h = harness('p2p', { cardFailsAt: 1 });
  await h.bridge.start();
  await h.bridge.pushText('x');                  // update 1 失败 → isError 收终亦失败 → dead
  await h.bridge.fail('claude 失败：超时', '部分生成的内容');
  await h.bridge.finish('迟到的全文');            // fallback 已发 → 不再发
  expect(h.mdCalls).toHaveLength(1);
  expect(h.mdCalls[0].text).toContain('claude 失败：超时');
  expect(h.mdCalls[0].text).toContain('部分生成的内容');
});

test('bridge: fail 时 isError finalize 失败 → markdown 回退兜底（r2 修订：任何失败路径都有可见终态）', async () => {
  // isError 收终是失败后的第 2 次调用：cardFailsAt=2 → 首次 update 成功、fail 的 isError 失败
  const h = harness('p2p', { cardFailsAt: 2 });
  await h.bridge.start();
  await h.bridge.pushText('正常推送');           // update 1 成功
  await h.bridge.fail('claude 失败：超时', '部分生成的内容'); // isError finalize（update 2）失败 → markdown 兜底
  expect(h.mdCalls).toHaveLength(1);
  expect(h.mdCalls[0].text).toContain('claude 失败：超时');
  expect(h.mdCalls[0].text).toContain('部分生成的内容');
  expect(h.errs.some((e) => e.includes('isError') || e.includes('收终'))).toBe(true);
});

test('bridge: 模板为空 → markdown-only 模式（info 不 error）', async () => {
  const cardCalls: Array<{ op: string; args: any }> = [];
  const mdCalls: Array<{ method: string; text: string }> = [];
  const infos: string[] = [];
  const cardClient = {
    createAndDeliver: async (args: any) => { cardCalls.push({ op: 'create', args }); return 'ot-1'; },
    streamingUpdate: async (args: any) => { cardCalls.push({ op: 'update', args }); },
  } as unknown as CardClient;
  const replyer = {
    sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { mdCalls.push({ method: 'oto', text }); },
    sendGroupMarkdown: async () => {},
  } as unknown as RobotReplyer;
  const logger: Logger = { debug(){}, info: (_m, m) => infos.push(m), warn(){}, error(){} };
  const bridge = new AiCardBridge({ cardClient, replyer, logger, msg: msg(), templateId: '', contentKey: 'content', minIntervalMs: 0, minBytes: 1 });
  await bridge.start();
  await bridge.finish('全文');
  expect(cardCalls).toHaveLength(0);
  expect(mdCalls).toEqual([{ method: 'oto', text: '全文' }]);
  expect(infos.some((m) => m.includes('markdown'))).toBe(true);
});

test('bridge: 超长截断 30000 字符 + warn', async () => {
  const h = harness('p2p');
  await h.bridge.start();
  await h.bridge.finish('x'.repeat(40_000));
  expect(h.cardCalls.at(-1)!.args.content.length).toBeLessThanOrEqual(30_000 + 20);
  expect(h.cardCalls.at(-1)!.args.content).toContain('截断');
  expect(h.warns.some((w) => w.includes('截断'))).toBe(true);
});
```


- [x] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/ai-card-bridge.test.ts` Expected: FAIL。
- [x] **Step 3: 实现**（按 Produces 契约直写：状态机 `unstarted → streaming | markdownOnly | dead`；`lastFlushedContent` 初 `''`；`flushCount` 计数；`fail` 的 isError 内容 = `回复中断：${errorText}${partialText ? '\n\n' + partialText : ''}` 截断后推送。）

- [x] **Step 4: 验证 PASS** — Run: `bun test tests/unit/ai-card-bridge.test.ts` Expected: PASS（8 tests）。
- [x] **Step 5: Commit** — `bun run typecheck && bun test && git add src/cards/ai-card-bridge.ts tests/unit/ai-card-bridge.test.ts && git commit -m "feat(card): turn-scoped AI-card bridge with dual-throttle flushing and exactly-once markdown fallback"`

**--- 检查点 B：卡链路（client/throttle/bridge）全绿 ---**

### Task 6: 会话存储（src/agent/session-store.ts）

**Files:**
- Create: `src/agent/session-store.ts`
- Test: `tests/unit/session-store.test.ts`

**Interfaces:**
- Consumes: `AskUserQuestionPayload`（Task 2）、`Logger`。
- Produces: `SessionRecord { chatKey: string; sessionId: string; lastActiveAt: number; pendingQuestion?: AskUserQuestionPayload }`；`SessionStoreOptions { sessionsDir: string; ttlMs: number; logger?: Logger; now?: () => number }`；`SessionStore`：
  - 构造时 `mkdirSync(sessionsDir, { recursive: true, mode: 0o700 })`（评审修复：净部署/嵌套路径首回合不炸）。
  - `beginTurn(chatKey): { record: SessionRecord; resume: boolean }` —— 文件存在且 `now-lastActiveAt < ttlMs` → resume=true（保留 pendingQuestion）；否则全新 record（uuid，pending 丢弃）；两情形都置 `lastActiveAt=now` 并立即落盘（**TTL 判定在消息到达时**，decisions D4）。
  - `load(chatKey): SessionRecord | null`（r2 修订：回合 job 开始时读盘面真值，防到达时快照覆写后续持久化的问题）。
  - `persist(record)`/`endTurn(record)` **与盘面合并**（r3 修订：`lastActiveAt = max(record.lastActiveAt, 盘面.lastActiveAt)`；pendingQuestion 以 record 为准（handler 已按盘面真值继承）——旧在飞回合的落盘不会把会话 TTL 倒拨）。
  - `persist(record): void` —— tmp+rename 原子写 0600（供回合中即时持久化 pendingQuestion——评审修复）。
  - `delete(chatKey): void`（r2 修订：首回合失败（`!ok && !resume`）作废会话记录，防幽灵 sessionId 被 `--resume` 连环失败）。
  - `endTurn(record): void` —— 同 persist（语义别名：回合结束落盘）。
  - 文件名 `sha256(chatKey).slice(0,16)+'.json'`；损坏 JSON → warn + 当作不存在。

- [x] **Step 1: 写失败测试**

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/agent/session-store.js';
import type { AskUserQuestionPayload } from '../../src/agent/claude-runner.js';

const Q: AskUserQuestionPayload = { toolUseId: 'c1', questions: [{ question: 'q', header: 'H', multiSelect: false, options: [{ label: 'A', description: '' }] }] };

test('store: 首次新 uuid resume=false；TTL 内同 sessionId resume=true；超 TTL 新 uuid（AC2）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-sess-'));
  let clock = 1_000_000;
  const store = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000, now: () => clock });
  const first = store.beginTurn('p2p:st1');
  expect(first.resume).toBe(false);
  expect(first.record.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  clock += 60_000;
  const second = store.beginTurn('p2p:st1');
  expect(second.resume).toBe(true);
  expect(second.record.sessionId).toBe(first.record.sessionId);
  clock += 3_600_000;
  const third = store.beginTurn('p2p:st1');
  expect(third.resume).toBe(false);
  expect(third.record.sessionId).not.toBe(first.record.sessionId);
});

test('store: pendingQuestion 持久化与 resume 保留；p2p/group 键互不串', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-sess2-'));
  const store = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000 });
  const { record } = store.beginTurn('p2p:st1');
  record.pendingQuestion = Q;
  store.persist(record); // 回合中即时持久化（评审修复路径）
  const again = store.beginTurn('p2p:st1');
  expect(again.record.pendingQuestion).toEqual(Q);
  const group = store.beginTurn('group:cidG');
  expect(group.resume).toBe(false);
  expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(2);
});

test('store: 跨实例（网关重启）——同目录新 SessionStore resume 同 uuid 与 pending（r3 修订：AC2 重启面）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-sess4-'));
  const s1 = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000 });
  const { record } = s1.beginTurn('p2p:st7');
  record.pendingQuestion = Q;
  s1.endTurn(record);
  const s2 = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000 }); // 新进程
  const again = s2.beginTurn('p2p:st7');
  expect(again.resume).toBe(true);
  expect(again.record.sessionId).toBe(record.sessionId);
  expect(again.record.pendingQuestion).toEqual(Q);
});

test('store: persist 与盘面合并——旧回合落盘不倒拨 lastActiveAt（r3 修订回归）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-sess5-'));
  let clock = 1_000_000;
  const store = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000, now: () => clock });
  const { record } = store.beginTurn('p2p:st8');       // 到达 t=1000000
  clock += 60_000;
  store.beginTurn('p2p:st8');                           // 后来的到达 touch 到 1060000
  store.endTurn(record);                                // 旧回合的到达时快照落盘（1000000）
  const after = store.load('p2p:st8')!;
  expect(after.lastActiveAt).toBe(1_060_000);           // max 合并，不倒拨
});

test('store: 损坏 JSON → warn + 新会话；0600；构造自建目录（评审修复）', () => {
  const base = mkdtempSync(join(tmpdir(), 'dtb-sess3-'));
  const dir = join(base, 'not-exist-yet', 'sessions'); // 不存在的嵌套路径
  const warns: string[] = [];
  let clock = 5_000_000;
  const store = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000, now: () => clock,
    logger: { debug(){}, info(){}, warn: (_m, m) => warns.push(m), error(){} } });
  const { record } = store.beginTurn('p2p:st9');
  store.endTurn(record);
  expect(existsSync(dir)).toBe(true);
  const file = readdirSync(dir).find((f) => f.endsWith('.json'))!;
  writeFileSync(join(dir, file), '{oops', { mode: 0o644 });
  const next = store.beginTurn('p2p:st9');
  expect(next.resume).toBe(false);
  expect(warns.some((w) => w.includes('损坏') || w.includes('解析'))).toBe(true);
  store.endTurn(next.record);
  expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
});
```

- [x] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/session-store.test.ts` Expected: FAIL。
- [x] **Step 3: 实现**（`createHash('sha256')` 文件名；read→parse try/catch→warn 视为不存在；write 走 `tmp(wx)+renameSync+chmodSync(0o600)`；构造器 mkdir recursive 0700。）

- [x] **Step 4: 验证 PASS** — Run: `bun test tests/unit/session-store.test.ts` Expected: PASS（5 tests）。
- [x] **Step 5: Commit** — `bun run typecheck && bun test && git add src/agent/session-store.ts tests/unit/session-store.test.ts && git commit -m "feat(agent): per-chat session store — idle-TTL resume, immediate persist, atomic writes"`

### Task 7: 问题桥——@ 剥离 / 编号渲染 / 数字应答解析（src/agent/question-bridge.ts）

**Files:**
- Create: `src/agent/question-bridge.ts`
- Test: `tests/unit/question-bridge.test.ts`

**Interfaces:**
- Consumes: `AskUserQuestionPayload`（Task 2）。
- Produces:
  - `stripLeadingMention(text: string): string` —— 剥一次 `^@[^\s@]+\s+`（decisions D12 窄规则）。
  - `isNumericReply(text: string): boolean` —— `^\d+(\s*,\s*\d+)*$`。
  - `renderQuestionList(p: AskUserQuestionPayload): string` —— 单题：问题 + 编号选项（`1. <label> — <description>`）+ 回复格式提示（multiSelect 加"可多选，逗号分隔如 1,3"）；多题：按题分组编号 + "多题时按顺序逗号回复（第 i 个数字答第 i 题）"；**任一题 multiSelect 时追加"多题+多选组合暂不支持编号作答，请直接用文字回复"**（评审修复：不可表示组合显式降级）。
  - `parseNumericReply(text, p): { kind: 'answer'; answerText: string } | { kind: 'help'; message: string }` —— 单题：非 multi 给多数字 → help；越界/0 → help；multiSelect 可多数字。多题：**若任一题 multiSelect → help（提示用文字回复）**；否则逗号个数须等于题数且各在范围，按题逐行 `[AskUserQuestion 应答]\n<question>: 已选 "<label>"`；其余 help（decisions D13 + 评审修订）。

- [x] **Step 1: 写失败测试**

```ts
import { test, expect } from 'bun:test';
import { stripLeadingMention, isNumericReply, renderQuestionList, parseNumericReply } from '../../src/agent/question-bridge.js';
import type { AskUserQuestionPayload } from '../../src/agent/claude-runner.js';

const SINGLE: AskUserQuestionPayload = { toolUseId: 'c1', questions: [
  { question: '红还是蓝？', header: 'Color', multiSelect: false,
    options: [{ label: '红', description: '暖色' }, { label: '蓝', description: '冷色' }] } ] };
const MULTI_PICK: AskUserQuestionPayload = { toolUseId: 'c2', questions: [
  { question: '要哪些？', header: 'Pick', multiSelect: true,
    options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'C', description: '' }] } ] };
const TWO_Q: AskUserQuestionPayload = { toolUseId: 'c3', questions: [
  { question: '语言？', header: 'Lang', multiSelect: false, options: [{ label: 'TS', description: '' }, { label: 'Py', description: '' }] },
  { question: '深度？', header: 'Depth', multiSelect: false, options: [{ label: '浅', description: '' }, { label: '深', description: '' }] } ] };
const TWO_Q_MULTI: AskUserQuestionPayload = { toolUseId: 'c4', questions: [
  { question: '语言？', header: 'Lang', multiSelect: false, options: [{ label: 'TS', description: '' }, { label: 'Py', description: '' }] },
  { question: '附些啥？', header: 'Extra', multiSelect: true, options: [{ label: 'X', description: '' }, { label: 'Y', description: '' }] } ] };

test('stripLeadingMention: 剥一个前导 @token；其余不动', () => {
  expect(stripLeadingMention('@机器人 你好')).toBe('你好');
  expect(stripLeadingMention('你好 @某人')).toBe('你好 @某人');
  expect(stripLeadingMention('1')).toBe('1');
});

test('isNumericReply', () => {
  expect(isNumericReply('1')).toBe(true);
  expect(isNumericReply('1,3')).toBe(true);
  expect(isNumericReply(' 1 , 3 ')).toBe(true);
  expect(isNumericReply('1、3')).toBe(false);
  expect(isNumericReply('选1')).toBe(false);
});

test('renderQuestionList: 单题编号 + 回复格式提示；多题分组；多题+多选降级提示', () => {
  const single = renderQuestionList(SINGLE);
  expect(single).toContain('红还是蓝？'); expect(single).toContain('1. 红'); expect(single).toContain('2. 蓝');
  expect(single).toContain('回复编号');
  const two = renderQuestionList(TWO_Q);
  expect(two).toContain('语言？'); expect(two).toContain('深度？');
  expect(two).toContain('按顺序');
  const mixed = renderQuestionList(TWO_Q_MULTI);
  expect(mixed).toContain('暂不支持'); // 不可表示组合的显式降级（评审修复）
});

test('parseNumericReply: 单题单选/多选/越界/单选多数字', () => {
  expect(parseNumericReply('1', SINGLE)).toEqual({ kind: 'answer', answerText: '[AskUserQuestion 应答]\n红还是蓝？: 已选 "红"' });
  expect(parseNumericReply('2', SINGLE)).toMatchObject({ kind: 'answer' });
  const multi = parseNumericReply('1,3', MULTI_PICK);
  expect(multi).toMatchObject({ kind: 'answer' });
  expect((multi as { answerText: string }).answerText).toContain('已选 "A"、"C"');
  expect(parseNumericReply('3', SINGLE).kind).toBe('help');
  expect(parseNumericReply('0', SINGLE).kind).toBe('help');
  expect(parseNumericReply('1,2', SINGLE).kind).toBe('help');
});

test('parseNumericReply: 多题按位映射；个数不匹配 help；任一 multiSelect → help（评审修复）', () => {
  const r = parseNumericReply('2,1', TWO_Q);
  expect(r).toMatchObject({ kind: 'answer' });
  expect((r as { answerText: string }).answerText).toContain('语言？: 已选 "Py"');
  expect((r as { answerText: string }).answerText).toContain('深度？: 已选 "浅"');
  expect(parseNumericReply('1', TWO_Q).kind).toBe('help');
  expect(parseNumericReply('9,1', TWO_Q).kind).toBe('help');
  expect(parseNumericReply('1,2', TWO_Q_MULTI).kind).toBe('help'); // 多题+多选不可表示
});
```

- [x] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/question-bridge.test.ts` Expected: FAIL。
- [x] **Step 3: 实现**（纯函数直写：`stripLeadingMention = (t) => t.replace(/^@[^\s@]+\s+/, '')`；render/parse 按上述规则；多选 labels `"A"、"C"` 用 `、` 连接。）

- [x] **Step 4: 验证 PASS** — Run: `bun test tests/unit/question-bridge.test.ts` Expected: PASS（4 tests）。
- [x] **Step 5: Commit** — `bun run typecheck && bun test && git add src/agent/question-bridge.ts tests/unit/question-bridge.test.ts && git commit -m "feat(agent): question bridge — mention strip, numbered rendering, numeric reply parsing with multi-select degradation"`

### Task 8: per-chat 有界串行队列 + 关停语义（src/agent/turn-queue.ts）

**Files:**
- Create: `src/agent/turn-queue.ts`
- Test: `tests/unit/turn-queue.test.ts`

**Interfaces:**
- Produces: `TurnQueueOptions { maxPerChat: number; logger: Logger }`；`TurnQueue`：
  - `enqueue(chatKey, job): boolean` —— closed → warn + false；depth ≥ max → warn + false；否则挂链尾 true。
  - `close(): void` —— 置 closed：enqueue 拒绝；**已排队未开始的 job 在轮到时丢弃**（warn 日志，不执行——评审修复：关停后不再 spawn）。
  - `depthOf(chatKey): number`；链空摘项；job 抛错 error 日志链不断。
  - `waitIdle(chatKey): Promise<void>`（r3 修订：返回该 chat 当前链尾 promise——handler 测试确定性等回合完成，替代定时器 sleep）。
  - `get closed(): boolean`。

- [x] **Step 1: 写失败测试**

```ts
import { test, expect } from 'bun:test';
import { TurnQueue } from '../../src/agent/turn-queue.js';
import type { Logger } from '../../src/logger.js';

function deferred() { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); return { p, release }; }
function logger(sink: { warns?: string[]; errs?: string[] } = {}): Logger {
  return { debug(){}, info(){}, warn: (_m, m) => sink.warns?.push(m), error: (_m, m) => sink.errs?.push(m) };
}

test('queue: 同 chat 严格串行，不同 chat 并行（AC3 面）', async () => {
  const q = new TurnQueue({ maxPerChat: 10, logger: logger() });
  const events: string[] = [];
  const a1 = deferred(), a2 = deferred(), b1 = deferred();
  q.enqueue('c1', async () => { events.push('a1-start'); await a1.p; events.push('a1-end'); });
  q.enqueue('c1', async () => { events.push('a2-start'); await a2.p; events.push('a2-end'); });
  q.enqueue('c2', async () => { events.push('b1-start'); await b1.p; events.push('b1-end'); });
  await new Promise((r) => setTimeout(r, 10));
  expect(events).toEqual(['a1-start', 'b1-start']);
  a1.release();
  await new Promise((r) => setTimeout(r, 10));
  expect(events).toContain('a2-start');
  a2.release(); b1.release();
  await new Promise((r) => setTimeout(r, 10));
  expect(q.depthOf('c1')).toBe(0);
});

test('queue: 有界——超限拒绝（false + warn）', async () => {
  const warns: string[] = [];
  const q = new TurnQueue({ maxPerChat: 2, logger: logger({ warns }) });
  const d1 = deferred(), d2 = deferred();
  expect(q.enqueue('c1', async () => { await d1.p; })).toBe(true);
  expect(q.enqueue('c1', async () => { await d2.p; })).toBe(true);
  expect(q.enqueue('c1', async () => {})).toBe(false);
  expect(q.depthOf('c1')).toBe(2);
  expect(warns.some((w) => w.includes('c1'))).toBe(true);
  d1.release(); d2.release();
  await new Promise((r) => setTimeout(r, 10));
  expect(q.depthOf('c1')).toBe(0);
});

test('queue: job 抛错 → error 日志，链不断', async () => {
  const errs: string[] = [];
  const q = new TurnQueue({ maxPerChat: 5, logger: logger({ errs }) });
  const ran: string[] = [];
  q.enqueue('c1', async () => { throw new Error('boom'); });
  await q.enqueue('c1', async () => { ran.push('after'); });
  expect(ran).toEqual(['after']);
  expect(errs.some((e) => e.includes('boom'))).toBe(true);
});

test('queue: close——拒绝新入队；排队未开始的 job 轮到时丢弃（评审修复）', async () => {
  const warns: string[] = [];
  const q = new TurnQueue({ maxPerChat: 5, logger: logger({ warns }) });
  const d1 = deferred();
  const ran: string[] = [];
  q.enqueue('c1', async () => { ran.push('t1'); await d1.p; ran.push('t1-end'); });
  q.enqueue('c1', async () => { ran.push('t2'); }); // 排队中
  q.close();
  expect(q.closed).toBe(true);
  expect(q.enqueue('c1', async () => {})).toBe(false); // 拒新
  d1.release(); // t1 完成；t2 轮到但已 close → 丢弃
  await new Promise((r) => setTimeout(r, 10));
  expect(ran).toEqual(['t1', 't1-end']); // t2 未执行
  expect(warns.some((w) => w.includes('丢弃') || w.includes('close'))).toBe(true);
});
```

- [x] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/turn-queue.test.ts` Expected: FAIL。
- [x] **Step 3: 实现**

```ts
import type { Logger } from '../logger.js';

export interface TurnQueueOptions { maxPerChat: number; logger: Logger }

export class TurnQueue {
  private readonly chats = new Map<string, { chain: Promise<void>; depth: number }>();
  private closed = false;

  constructor(private readonly opts: TurnQueueOptions) {}

  get closed(): boolean { return this.closed; }

  close(): void { this.closed = true; }

  depthOf(chatKey: string): number { return this.chats.get(chatKey)?.depth ?? 0; }

  waitIdle(chatKey: string): Promise<void> { return this.chats.get(chatKey)?.chain ?? Promise.resolve(); }

  enqueue(chatKey: string, job: () => Promise<void>): boolean {
    if (this.closed) { this.opts.logger.warn('queue', `队列已关闭，拒绝 chat ${chatKey} 新消息`); return false; }
    let q = this.chats.get(chatKey);
    if (q === undefined) { q = { chain: Promise.resolve(), depth: 0 }; this.chats.set(chatKey, q); }
    if (q.depth >= this.opts.maxPerChat) {
      this.opts.logger.warn('queue', `chat ${chatKey} 队列已满（${q.depth}），拒绝新消息`);
      return false;
    }
    q.depth += 1;
    q.chain = q.chain
      .then(() => {
        if (this.closed) { this.opts.logger.warn('queue', `队列已关闭，丢弃 chat ${chatKey} 排队回合`); return; }
        return job();
      })
      .catch((err) => { this.opts.logger.error('queue', `chat ${chatKey} 回合失败: ${String(err)}`); })
      .finally(() => {
        const cur = this.chats.get(chatKey);
        if (cur === undefined) return;
        cur.depth -= 1;
        if (cur.depth === 0) this.chats.delete(chatKey);
      });
    return true;
  }
}
```

- [x] **Step 4: 验证 PASS** — Run: `bun test tests/unit/turn-queue.test.ts` Expected: PASS（4 tests）。
- [x] **Step 5: Commit** — `bun run typecheck && bun test && git add src/agent/turn-queue.ts tests/unit/turn-queue.test.ts && git commit -m "feat(agent): bounded per-chat serial turn queue with close semantics"`

**--- 检查点 C：会话层组件（runner/store/question/queue）全绿 ---**

### Task 9: agent session handler（src/handlers/agent-session.ts）

**Files:**
- Create: `src/handlers/agent-session.ts`
- Test: `tests/unit/agent-session.test.ts`

**Interfaces:**
- Consumes: `RobotReplyer`、`CardClient`、`ClaudeRunner`、`SessionStore`、`TurnQueue`、`AiCardBridge`、`StreamThrottle`、`ResolvedConfig`、`stripLeadingMention/isNumericReply/renderQuestionList/parseNumericReply`、`InboundRobotMessage/MessageHandler`。
- Produces: `AgentHandlerDeps { replyer: RobotReplyer; cardClient: CardClient; runner: ClaudeRunner; store: SessionStore; queue: TurnQueue; config: ResolvedConfig; logger: Logger; workspace: string }`；`createAgentSessionHandler(deps): MessageHandler`。行为契约：
  1. 非 text / 空文本 → warn 丢弃；`conversationKind === 'unknown'` → warn 丢弃。
  2. `msgId` LRU 去重（Set 容量 500，超限删最早键；重复 → warn + return）。
  3. text = group 时 `stripLeadingMention(textContent)`；p2p 原样。
  4. `beginTurn(chatKey)` **到达时**调用（chatKey = `p2p:<senderStaffId>` / `group:<conversationId>`）。
  5. pending 应答判定（读 `record.pendingQuestion`）：`isNumericReply` → `parseNumericReply`；answer → 该回合 prompt = answerText、标记 `isAnswerTurn` 并**携带 `answeredToolUseId = record.pendingQuestion.toolUseId`**（回合仍走完整流程 + resume）；help → 一条简短 markdown 帮助（不进 agent），return。非数字 → 正常 prompt（pending 保留）。
     r3 修订（应答与新题竞态）：回合 job 开始时 `store.load` 重验——若盘面 `pendingQuestion.toolUseId !== answeredToolUseId`（排队期间新问题覆盖了旧题），**降级为普通消息回合**（answerText 不发，原文走 prompt）；清 pending 仅当 `ok && isAnswerTurn && 盘面 toolUseId 仍匹配`。
  6. `queue.enqueue` false → 一条忙线 markdown（`忙线中：本会话排队已满，请稍后再试`）+ return。
  7. 回合 job（**整体 try/catch**——异常时 `bridge.fail(String(err), 部分文本)` 兜底后 rethrow，队列记日志；卡永不悬挂，r2 修订）：
     - job 开始先 `store.load(chatKey)` 取**盘面真值** `fresh`（r2 修订：到达时快照不覆写后续持久化——pendingQuestion 继承 `fresh.pendingQuestion`）；sessionId/resume 用到达时判定值。
     - `AiCardBridge.start()` → `runner.run({prompt, sessionId, resume, cwd: workspace}, { onText: (t) => bridge.pushText(t), onQuestion: (p) => { pending=p; preQuestionText=当前 t; **store.persist({...record, pendingQuestion: p}) 立即落盘**（评审修复：数字应答可在回合结束前到达）} })`
     - 终态判定（r2 修订：先判 ok，再判 pending）：
       - `!ok`：`bridge.fail(result.errorText, result.outputText)`；**清除 pending**（record.pendingQuestion=undefined 持久化——回合失败则问题不成立）；**且 `!resume`（首回合失败）→ `store.delete(chatKey)`**（幽灵会话作废，下条消息全新起）。
       - `ok && pending`：`bridge.finish(preQuestionText + '\n\n' + renderQuestionList(p))`；持久化 pendingQuestion=p。
       - `ok && isAnswerTurn && 盘面 toolUseId 匹配`：`bridge.finish(result.outputText || '（本轮无文本输出）')`；持久化 pendingQuestion=undefined（应答成功且仍是对应问题才清除，r3 修订）。
       - `ok` 其余：`bridge.finish(result.outputText || '（本轮无文本输出）')`；pendingQuestion 沿用 `fresh.pendingQuestion` 持久化（不清除）。
     - 回合 info 日志（时长/flush/抑制计数）。
  8. prompt 前缀（issue 明文规定，feishubot 同型）：`[Context: sender=<senderNick>, staffId=<senderStaffId>, chat=<conversationId> (p2p|group)]\n<text>`。

- [x] **Step 1: 写失败测试** `tests/unit/agent-session.test.ts`

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSessionHandler } from '../../src/handlers/agent-session.js';
import { SessionStore } from '../../src/agent/session-store.js';
import { TurnQueue } from '../../src/agent/turn-queue.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { RobotReplyer } from '../../src/openapi/robot.js';
import type { CardClient } from '../../src/openapi/card.js';
import type { ClaudeRunner, TurnRequest, TurnCallbacks, TurnResult, AskUserQuestionPayload } from '../../src/agent/claude-runner.js';
import type { InboundRobotMessage } from '../../src/transport/types.js';

const QUESTION: AskUserQuestionPayload = { toolUseId: 'c1', questions: [
  { question: '红还是蓝？', header: 'Color', multiSelect: false,
    options: [{ label: '红', description: '' }, { label: '蓝', description: '' }] } ] };

function msg(over: Partial<InboundRobotMessage> = {}): InboundRobotMessage {
  return { msgId: 'm1', conversationId: 'cid', conversationKind: 'p2p', senderStaffId: 'st1', senderNick: '老王',
    robotCode: 'rc', msgtype: 'text', textContent: '你好', sessionWebhook: null, raw: {}, ...over };
}

function fakeRunner(script: Array<(req: TurnRequest, cbs: TurnCallbacks) => void | Promise<void>>) {
  const calls: Array<{ req: TurnRequest }> = [];
  return {
    calls,
    runner: {
      run: async (req: TurnRequest, cbs: TurnCallbacks): Promise<TurnResult> => {
        calls.push({ req });
        const step = script[Math.min(calls.length - 1, script.length - 1)];
        await step(req, cbs); // r3：尊重脚本返回的 Promise（异步边界保真）
        return { ok: true, outputText: '最终全文', errorText: '', durationMs: 5 };
      },
      killAll: () => {},
    } as unknown as ClaudeRunner,
  };
}

function harness(runner: ClaudeRunner, config = DEFAULT_CONFIG) {
  const md: Array<{ method: string; text: string }> = [];
  const cardCalls: Array<{ op: string; args: any }> = [];
  const replyer = {
    sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { md.push({ method: 'oto', text }); },
    sendGroupMarkdown: async (_r: string, _c: string, _t: string, text: string) => { md.push({ method: 'group', text }); },
  } as unknown as RobotReplyer;
  const cardClient = {
    createAndDeliver: async (args: any) => { cardCalls.push({ op: 'create', args }); return 'ot-1'; },
    streamingUpdate: async (args: any) => { cardCalls.push({ op: 'update', args }); },
  } as unknown as CardClient;
  const store = new SessionStore({ sessionsDir: mkdtempSync(join(tmpdir(), 'dtb-h-')), ttlMs: 3_600_000 });
  const queue = new TurnQueue({ maxPerChat: 10, logger: { debug(){}, info(){}, warn(){}, error(){} } });
  const handler = createAgentSessionHandler({ replyer, cardClient, runner, store, queue, config,
    logger: { debug(){}, info(){}, warn(){}, error(){} }, workspace: '/ws' });
  return { handler, md, cardCalls, store, queue };
}

test('handler: p2p 文本回合——前缀 prompt、卡流式收终、TTL 内 resume（AC1/AC2 面）', async () => {
  const { calls, runner } = fakeRunner([() => {}]);
  const { handler, cardCalls } = harness(runner);
  await handler(msg({ msgId: 'm1' }));
  await queue.waitIdle('p2p:st1'); // r3：确定性等回合完成
  expect(calls[0].req.prompt).toBe('[Context: sender=老王, staffId=st1, chat=cid (p2p)]\n你好');
  expect(calls[0].req.resume).toBe(false);
  expect(cardCalls[0].op).toBe('create');
  expect(cardCalls.at(-1)!.args).toMatchObject({ content: '最终全文', finalize: true });
  await handler(msg({ msgId: 'm2', textContent: '接着说' }));
  expect(calls[1].req.resume).toBe(true);
  expect(calls[1].req.sessionId).toBe(calls[0].req.sessionId);
});

test('handler: AC5——问题渲染编号列表；数字回复结构化回传', async () => {
  const { calls, runner } = fakeRunner([
    (_req, cbs) => { cbs.onText?.('我想问：'); cbs.onQuestion?.(QUESTION); },
    () => {},
  ]);
  const { handler, cardCalls } = harness(runner);
  await handler(msg({ msgId: 'q1' }));
  await queue.waitIdle('p2p:st1');
  const finish = cardCalls.at(-1)!.args;
  expect(finish.content).toContain('我想问：');
  expect(finish.content).toContain('1. 红');
  expect(finish.content).toContain('2. 蓝');
  await handler(msg({ msgId: 'q2', textContent: '2' }));
  expect(calls[1].req.prompt).toContain('[AskUserQuestion 应答]');
  expect(calls[1].req.prompt).toContain('已选 "蓝"');
  expect(calls[1].req.resume).toBe(true);
});

test('handler: 群消息剥 @；先出题再"@bot 1" 命中数字应答（评审修复：先播种 pending）', async () => {
  const { calls, runner } = fakeRunner([
    (_req, cbs) => { cbs.onQuestion?.(QUESTION); },  // 回合 1：出题（群）
    () => {},                                        // 回合 2：应答
  ]);
  const { handler } = harness(runner);
  await handler(msg({ msgId: 'g0', conversationKind: 'group', conversationId: 'cidG', textContent: '问我一个选择题' }));
  await queue.waitIdle('group:cidG');
  await handler(msg({ msgId: 'g1', conversationKind: 'group', conversationId: 'cidG', textContent: '@机器人 1' }));
  await queue.waitIdle('group:cidG');
  expect(calls).toHaveLength(2);
  expect(calls[1].req.prompt).toContain('已选 "红"');
});

test('handler: 问题即时落盘——上一回合未 endTurn 时数字应答仍命中（评审修复回归）', async () => {
  let releaseTurn1!: () => void;
  const { calls, runner } = fakeRunner([
    (_req, cbs) => { cbs.onQuestion?.(QUESTION); return new Promise<void>((r) => { releaseTurn1 = r; }) as unknown as void; },
    () => {},
  ]);
  const { handler } = harness(runner);
  const t1 = handler(msg({ msgId: 'r1' }));          // 回合 1 挂起（onQuestion 已即时 persist）
  await new Promise((r) => setTimeout(r, 10));
  const t2 = handler(msg({ msgId: 'r2', textContent: '1' })); // 到达时 pending 已可见 → 应答路径
  releaseTurn1();
  await Promise.all([t1, t2]);
  expect(calls).toHaveLength(2);
  expect(calls[1].req.prompt).toContain('已选 "红"');
});

test('handler: 越界数字 → help markdown 不进 agent；pending 保留可后补', async () => {
  const { calls, runner } = fakeRunner([(_req, cbs) => { cbs.onQuestion?.(QUESTION); }, () => {}]);
  const { handler, md } = harness(runner);
  await handler(msg({ msgId: 'h1' }));
  await queue.waitIdle('p2p:st1');
  await handler(msg({ msgId: 'h2', textContent: '9' }));
  expect(calls).toHaveLength(1);
  expect(md[0].text).toContain('编号');
  await handler(msg({ msgId: 'h3', textContent: '1' }));
  await queue.waitIdle('p2p:st1');
  expect(calls).toHaveLength(2);
});

test('handler: 排队中的后续消息不清除先问出的问题（r2 修订回归：盘面真值继承）', async () => {
  const { calls, runner } = fakeRunner([
    (_req, cbs) => { cbs.onQuestion?.(QUESTION); },  // 回合 1 出题
    () => {},                                        // 回合 2：出题前排队的普通消息
    () => {},                                        // 回合 3：数字应答
  ]);
  const { handler } = harness(runner);
  await handler(msg({ msgId: 'w0', textContent: '先问个问题' }));   // 回合 1（出题+持久化）
  await queue.waitIdle('p2p:st1');
  await handler(msg({ msgId: 'w1', textContent: '普通追问' }));     // 回合 2（到达时 pending 未见 → 普通 prompt）
  await queue.waitIdle('p2p:st1');
  await handler(msg({ msgId: 'w2', textContent: '1' }));            // 回合 3（命中 pending → 应答）
  await queue.waitIdle('p2p:st1');
  expect(calls).toHaveLength(3);
  expect(calls[1].req.prompt).toContain('普通追问');                 // 回合 2 是普通消息
  expect(calls[2].req.prompt).toContain('已选 "红"');                // 回合 2 结束后 pending 仍在
});

test('handler: 应答回合失败 → pending 保留可重答（r2 修订回归）', async () => {
  let failNext = false;
  const { calls, runner } = fakeRunner([
    (_req, cbs) => { cbs.onQuestion?.(QUESTION); },
    () => { if (failNext) throw new Error('answer turn boom'); },
    () => {},
  ]);
  const { handler } = harness(runner);
  await handler(msg({ msgId: 'a1' }));
  await queue.waitIdle('p2p:st1');
  failNext = true;
  await handler(msg({ msgId: 'a2', textContent: '1' }));   // 应答回合异常 → 桥 fail 兜底、pending 不清
  await queue.waitIdle('p2p:st1');
  failNext = false;
  await handler(msg({ msgId: 'a3', textContent: '1' }));   // 仍可重答
  await queue.waitIdle('p2p:st1');
  expect(calls).toHaveLength(3);
  expect(calls[2].req.prompt).toContain('已选 "红"');
});

test('handler: 首回合失败 → 会话记录作废，下条消息全新会话（r2 修订回归）', async () => {
  let call = 0;
  const stateful = {
    run: async (): Promise<TurnResult> => {
      call += 1;
      if (call === 1) return { ok: false, outputText: '', errorText: 'claude 进程启动失败: ENOENT', durationMs: 1 };
      return { ok: true, outputText: 'ok', errorText: '', durationMs: 1 };
    },
    killAll: () => {},
  } as unknown as ClaudeRunner;
  const seen: TurnRequest[] = [];
  const recording = {
    run: async (req: TurnRequest, cbs: TurnCallbacks) => { seen.push(req); return stateful.run(req, cbs); },
    killAll: () => {},
  } as unknown as ClaudeRunner;
  const { handler } = harness(recording);
  await handler(msg({ msgId: 'e1' }));
  await queue.waitIdle('p2p:st1');
  await handler(msg({ msgId: 'e2', textContent: '再来' }));
  await queue.waitIdle('p2p:st1');
  expect(seen[1].resume).toBe(false);                     // 记录已作废 → 新会话
  expect(seen[1].sessionId).not.toBe(seen[0].sessionId);  // 新 uuid
});

test('handler: 回合内异常（开卡后 throw）→ 卡 fail 收终不悬挂（r2 修订回归）', async () => {
  const { runner } = fakeRunner([() => { throw new Error('mid-turn boom'); }]);
  const { handler, queue, cardCalls } = harness(runner);
  await handler(msg({ msgId: 'x1' }));
  await queue.waitIdle('p2p:st1');
  expect(cardCalls.at(-1)!.args).toMatchObject({ finalize: true, error: true, content: expect.stringContaining('mid-turn boom') });
});

test('handler: 队列满 → 忙线 markdown；msgId 重复丢弃', async () => {
  const { calls, runner } = fakeRunner([() => {}]);
  const dup = harness(runner);
  await dup.handler(msg({ msgId: 'd1' }));
  await dup.queue.waitIdle('p2p:st1');
  await dup.handler(msg({ msgId: 'd1' }));   // 重复 msgId → 丢弃
  expect(calls).toHaveLength(1);
  const busyMd: Array<{ method: string; text: string }> = [];
  const runner2 = fakeRunner([() => {}]).runner;
  const fullQueue = { enqueue: () => false, depthOf: () => 1, close() {}, closed: false } as unknown as TurnQueue;
  const handler2 = createAgentSessionHandler({
    replyer: {
      sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { busyMd.push({ method: 'oto', text }); },
      sendGroupMarkdown: async () => {},
    } as unknown as RobotReplyer,
    cardClient: { createAndDeliver: async () => 'ot', streamingUpdate: async () => {} } as unknown as CardClient,
    runner: runner2,
    store: new SessionStore({ sessionsDir: mkdtempSync(join(tmpdir(), 'dtb-h2-')), ttlMs: 3_600_000 }),
    queue: fullQueue, config: DEFAULT_CONFIG,
    logger: { debug(){}, info(){}, warn(){}, error(){} }, workspace: '/ws',
  });
  await handler2(msg({ msgId: 'b9' }));
  expect(busyMd.at(-1)!.text).toContain('忙');
});

test('handler: 非文本/空文本/unknown kind 丢弃', async () => {
  const { calls, runner } = fakeRunner([() => {}]);
  const { handler } = harness(runner);
  await handler(msg({ msgtype: 'picture', textContent: null }));
  await handler(msg({ textContent: '   ' }));
  await handler(msg({ conversationKind: 'unknown' }));
  expect(calls).toHaveLength(0);
});

test('handler: 回合失败（!ok）→ 桥 fail 路径（活卡 isError 收终）', async () => {
  const failing = { run: async () => ({ ok: false, outputText: '', errorText: '回合超时（60000ms）', durationMs: 5 }), killAll: () => {} } as unknown as ClaudeRunner;
  const { handler, queue, cardCalls, md } = harness(failing);
  await handler(msg({ msgId: 'f1' }));
  await queue.waitIdle('p2p:st1');
  expect(cardCalls.at(-1)!.args).toMatchObject({ finalize: true, error: true, content: expect.stringContaining('超时') });
  expect(md).toHaveLength(0);
});
```


- [x] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/agent-session.test.ts` Expected: FAIL。
- [x] **Step 3: 实现** `src/handlers/agent-session.ts`（按行为契约 1–8 直写；`seenMsgIds: Set<string>` 超 500 删最早；onQuestion 回调内立即 `store.persist`；job 开始 `store.load` 取盘面真值；终态按"先 ok 后 pending"判定；`!ok && !resume` → `store.delete`；回合 job 整体 try/catch → `bridge.fail` 兜底后 rethrow。）

- [x] **Step 4: 验证 PASS** — Run: `bun test tests/unit/agent-session.test.ts` Expected: PASS（11 tests）。
- [x] **Step 5: Commit** — `bun run typecheck && bun test && git add src/handlers/agent-session.ts tests/unit/agent-session.test.ts && git commit -m "feat(handler): agent session handler — dedupe, arrival-time TTL claim, immediate question persist, queued turns"`

### Task 10: run.ts 重接线 + echo 移除 + 集成测试重写

**Files:**
- Modify: `src/commands/run.ts`
- Delete: `src/handlers/echo.ts`, `tests/unit/echo.test.ts`, `tests/integration/round-trip.test.ts`
- Create: `tests/integration/agent-round-trip.test.ts`
- Modify: `tests/integration/run.test.ts`（追加分件注入用例）

**Interfaces:**
- Consumes: Task 1–9 全部产物。
- Produces:
  - `RunOverrides` 扩展：`{ transportFactory?; depsOverrides?: Partial<AgentHandlerDeps> }` —— runCommand 组装真实 deps 后以 overrides 覆盖（评审修复：run.ts 装配线本身可测）。
  - `runCommand` 装配新增：`loadConfig → resolveConfig`（启动 warn：空模板 markdown-only；bypassPermissions 暴露提示）+ `CardClient` + `ClaudeRunner` + `SessionStore({ttlMs: minutes*60_000})` + `TurnQueue` + `createAgentSessionHandler`；shutdown 序：`queue.close()` → `runner.killAll()` → `gateway.stop()` → pidfile 清理（评审修复：关停后不再 spawn、在飞组杀）。
  - 集成测试（AC1/AC3/AC4 CI 面）：真实 transport（FakeDwClient）+ 真实 handler/store/queue/bridge/throttle + 受控 fake runner + fake HTTP。

- [x] **Step 1: 写失败集成测试** `tests/integration/agent-round-trip.test.ts`

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapWorkspace } from '../../src/config.js';
import { DingtalkSdkTransport } from '../../src/transport/dingtalk-sdk-adapter.js';
import { FakeDwClient } from '../helpers/fake-dw-client.js';
import { TokenManager } from '../../src/openapi/token.js';
import { RobotReplyer } from '../../src/openapi/robot.js';
import { CardClient } from '../../src/openapi/card.js';
import { SessionStore } from '../../src/agent/session-store.js';
import { TurnQueue } from '../../src/agent/turn-queue.js';
import { createAgentSessionHandler } from '../../src/handlers/agent-session.js';
import { Gateway } from '../../src/gateway.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { ClaudeRunner, TurnRequest, TurnCallbacks, TurnResult } from '../../src/agent/claude-runner.js';
import type { Logger } from '../../src/logger.js';

const quiet: Logger = { debug(){}, info(){}, warn(){}, error(){} };

function deferred() { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); return { p, release }; }

function scriptedRunner(steps: Array<(cbs: TurnCallbacks) => void | Promise<void>>) {
  const events: string[] = [];
  const calls: TurnRequest[] = [];
  let i = 0;
  const gates: Array<ReturnType<typeof deferred>> = steps.map(() => deferred());
  const runner = {
    run: async (req: TurnRequest, cbs: TurnCallbacks): Promise<TurnResult> => {
      const idx = Math.min(i, steps.length - 1); i += 1;
      calls.push(req);
      events.push(`start${idx + 1}`);
      await steps[idx](cbs); // r3：尊重脚本/回调返回的 Promise（异步边界保真）
      await gates[idx].p;
      events.push(`finish${idx + 1}`);
      return { ok: true, outputText: `回复${idx + 1}`, errorText: '', durationMs: 1 };
    },
    killAll: () => {},
    release: (idx: number) => gates[idx].release(),
    events, calls,
  };
  return runner;
}

function wireHttp(opts: { cardCreateStatus?: number } = {}) {
  const http: Array<{ method: string; url: string; body: any }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    http.push({ method: init?.method ?? 'GET', url, body });
    if (String(url).includes('accessToken')) return new Response(JSON.stringify({ accessToken: 'TKN', expireIn: 7_200 }), { status: 200 });
    if (String(url).includes('createAndDeliver') && opts.cardCreateStatus && opts.cardCreateStatus !== 200) {
      return new Response('{"code":"Card.NotFound"}', { status: opts.cardCreateStatus });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { http, fetchFn };
}

function assemble(runner: unknown, fetchFn: typeof fetch, configOver: Record<string, unknown> = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-rt-'));
  const paths = bootstrapWorkspace(ws);
  const client = new FakeDwClient();
  const tokenManager = new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile: paths.tokenCacheFile, fetchFn });
  const replyer = new RobotReplyer({ tokenManager, fetchFn });
  const cardClient = new CardClient({ tokenManager, fetchFn });
  const store = new SessionStore({ sessionsDir: paths.sessionsDir, ttlMs: 3_600_000 });
  const queue = new TurnQueue({ maxPerChat: 10, logger: quiet });
  const handler = createAgentSessionHandler({ replyer, cardClient, runner: runner as ClaudeRunner, store, queue,
    config: { ...DEFAULT_CONFIG, aiCardTemplateId: 'tpl-9', cardStreamMinIntervalMs: 0, cardStreamMinBytes: 1, ...configOver }, logger: quiet, workspace: ws });
  const transport = new DingtalkSdkTransport({ clientId: 'ck', clientSecret: 'cs', logger: quiet,
    handlerRetryDelayMs: 1, backoffBaseMs: 5, clientFactory: () => client });
  const gateway = new Gateway({ transport, logger: quiet, stateFile: paths.stateFile, pid: process.pid, startedAt: 'T', handler });
  return { client, gateway, paths, queue };
}

const P2P_MSG = { msgId: 'm1', conversationId: 'c1', conversationType: '1', senderStaffId: 'st1', senderNick: 'n', robotCode: 'rc1', msgtype: 'text', text: { content: ' 你好 ' } };

test('round-trip: p2p 全链——createAndDeliver + 流式 + finalize 收终 + ack（AC1 CI 面）', async () => {
  const runner = scriptedRunner([ (cbs) => { cbs.onText?.('部分'); } ]);
  const { http } = wireHttp();
  const { client, gateway } = assemble(runner, http.fetchFn);
  await gateway.start();
  client.emitRobotMessage(P2P_MSG);
  await new Promise((r) => setTimeout(r, 120)); // handler 返回（ack）后回合在队列中
  runner.release(0);
  await queue.waitIdle('p2p:st1');              // r3：确定性等回合链尾
  const create = http.find((c) => String(c.url).endsWith('/v1.0/card/instances/createAndDeliver'));
  expect(create?.method).toBe('POST');
  expect(create?.body).toMatchObject({
    cardTemplateId: 'tpl-9', callbackType: 'STREAM',
    cardData: { cardParamMap: { content: '' } },
    openSpaceId: 'dtv1.card//IM_ROBOT.st1',
    imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT' },
  });
  expect(typeof create?.body.outTrackId).toBe('string');
  const streams = http.filter((c) => String(c.url).endsWith('/v1.0/card/streaming'));
  expect(streams.length).toBeGreaterThanOrEqual(2);          // ≥1 次 flush + finalize
  expect(streams.every((c) => c.method === 'PUT' && c.body.isFull === true)).toBe(true);
  const finalize = streams.at(-1)!;
  expect(finalize.body.isFinalize).toBe(true);
  expect(finalize.body.content).toBe('回复1');
  expect(finalize.body.outTrackId).toBe(create!.body.outTrackId);
  expect(client.acks[0]).toMatchObject({ messageId: 'msg-1', result: { status: 'SUCCESS' } }); // handler 立即返回 → 快速 ack
  await gateway.stop();
});

test('round-trip: 同 chat 两条快消息串行、无交错（AC3 CI 面）', async () => {
  const runner = scriptedRunner([ () => {}, () => {} ]);
  const { http } = wireHttp();
  const { client, gateway, queue } = assemble(runner, http.fetchFn);
  await gateway.start();
  client.emitRobotMessage({ ...P2P_MSG, msgId: 'a' });
  client.emitRobotMessage({ ...P2P_MSG, msgId: 'b' }); // 第一条仍在飞
  await new Promise((r) => setTimeout(r, 80));
  expect(runner.events).toEqual(['start1']);            // 第二条未插队
  runner.release(0);
  await new Promise((r) => setTimeout(r, 80));
  expect(runner.events).toEqual(['start1', 'finish1', 'start2']);
  runner.release(1);
  await queue.waitIdle('p2p:st1');
  expect(runner.events).toEqual(['start1', 'finish1', 'start2', 'finish2']);
  expect(client.acks).toHaveLength(2);
  await gateway.stop();
});

test('round-trip: 卡创建失败 → 恰好一条 markdown 全文 + ack（AC4 CI 面）', async () => {
  const runner = scriptedRunner([ () => {} ]);
  const { http, fetchFn } = wireHttp({ cardCreateStatus: 404 });
  const { client, gateway, queue } = assemble(runner, fetchFn);
  await gateway.start();
  client.emitRobotMessage(P2P_MSG);
  await new Promise((r) => setTimeout(r, 80));
  runner.release(0);
  await queue.waitIdle('p2p:st1');
  const markdowns = http.filter((c) => String(c.url).endsWith('/v1.0/robot/oToMessages/batchSend'));
  expect(markdowns).toHaveLength(1);                    // 恰好一条
  expect(markdowns[0].body.msgKey).toBe('sampleMarkdown');
  expect(JSON.parse(markdowns[0].body.msgParam).text).toBe('回复1'); // 全文
  expect(client.acks[0]).toMatchObject({ result: { status: 'SUCCESS' } });
  await gateway.stop();
});
```

（AC3 用例的 assemble 用同一默认 `aiCardTemplateId: 'tpl-9'`——卡流量正常但断言只看 runner 事件序；AC4 用例同。）

- [x] **Step 2: 验证 FAIL** — Run: `bun test tests/integration/agent-round-trip.test.ts` Expected: FAIL — handler 未接线。
- [x] **Step 3: 改 run.ts + 删 echo + run.test.ts 追加**

```ts
// src/commands/run.ts：RunOverrides 扩展 + 装配替换（生命周期骨架不变）
export interface RunOverrides {
  transportFactory?: (opts: TransportOptions) => DingtalkTransport;
  depsOverrides?: Partial<AgentHandlerDeps>; // 评审修复：装配线可测
  signalHook?: (handler: (sig: string) => Promise<void>) => void; // r3：run.ts 注册 SIGINT/SIGTERM 时把真实 shutdown 处理器交给观察者（测试直接调用，不真发信号）
}
// …在 tokenManager/replyer 构造之后：
const config = resolveConfig(loadConfig(paths), logger);
if (config.aiCardTemplateId === '') logger.warn('run', 'config 未配置 ai_card_template_id —— 回复将以纯 markdown 输出（请在钉钉卡片平台创建 AI 卡模板后填入）');
if (config.agentPermissionMode === 'bypassPermissions') logger.warn('run', 'agent 以 bypassPermissions 运行（无头全权限）；D3 访问控制落地前，请确保机器人仅暴露于受控会话');
const cardClient = new CardClient({ tokenManager, logger });
const runner = new ClaudeRunner({ bin: config.claudeBin, model: config.model, permissionMode: config.agentPermissionMode, timeoutMs: config.agentTurnTimeoutMs, logger });
const store = new SessionStore({ sessionsDir: paths.sessionsDir, ttlMs: config.sessionIdleTtlMinutes * 60_000, logger });
const queue = new TurnQueue({ maxPerChat: config.queueMaxPerChat, logger });
const handler = createAgentSessionHandler({ replyer, cardClient, runner, store, queue, config, logger, workspace, ...overrides.depsOverrides });
// shutdown 序（gateway.stop 之前；shutdown 处理器构造后经 overrides.signalHook?.(shutdown) 交给观察者）：
queue.close();    // 拒新 + 丢弃排队回合（评审修复）
runner.killAll(); // detached 子进程组不随父退出——TERM→KILL 升级杀在飞回合
```

`tests/integration/run.test.ts` 追加两用例（r2 修订后定稿）：

```ts
// 1) 装配线证据：depsOverrides 换入受控 fake runner，消息经真实 runCommand 装配送达
test('runCommand: 真实装配线——消息 → session handler → runner 收 [Context: 前缀 prompt', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-run3-'));
  const paths = bootstrapWorkspace(ws);
  saveBotEnv(paths.botDir, { clientId: 'ck', clientSecret: 'cs' });
  const seen: string[] = [];
  const fakeRunner = { run: async (req: TurnRequest) => { seen.push(req.prompt); return { ok: true, outputText: 'r', errorText: '', durationMs: 1 }; }, killAll: () => {} } as unknown as ClaudeRunner;
  const client = new FakeDwClient();
  await runCommand(ws, {
    transportFactory: (opts) => new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client }),
    depsOverrides: { runner: fakeRunner },
    exit: () => { throw new Error('不应退出'); } as never,
  });
  client.emitRobotMessage(P2P_PAYLOAD);
  await new Promise((r) => setTimeout(r, 100));
  expect(seen[0]).toContain('[Context: sender=n, staffId=st1, chat=c1 (p2p)]');
});

// 2) 关停序证据：queue.close → runner.killAll → gateway.stop（signalHook 捕获，不真发信号）
test('runCommand: 关停序——queue.close 先于 runner.killAll；排队回合不再执行', async () => {
  const order: string[] = [];
  let started = 0;
  const release = deferred();
  const fakeRunner = {
    run: async () => { started += 1; await release.p; return { ok: true, outputText: '', errorText: '', durationMs: 0 }; },
    killAll: () => order.push('runner.killAll'),
  } as unknown as ClaudeRunner;
  const fakeQueue = {
    enqueue: async () => true, depthOf: () => 0,
    close: () => order.push('queue.close'),
    waitIdle: () => Promise.resolve(),
    closed: false,
  } as unknown as TurnQueue;
  const client = new FakeDwClient();
  let capturedShutdown: ((sig: string) => Promise<void>) | null = null;
  await runCommand(ws2, {
    transportFactory: (opts) => new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client }),
    depsOverrides: { runner: fakeRunner, queue: fakeQueue },
    signalHook: (handler) => { capturedShutdown = handler; }, // 捕获真实 shutdown 处理器
  }, () => { throw new Error('不应退出'); } as never);
  expect(capturedShutdown).not.toBeNull();
  client.emitRobotMessage(P2P_PAYLOAD);        // 回合 1 在飞
  await new Promise((r) => setTimeout(r, 50));
  client.emitRobotMessage({ ...P2P_PAYLOAD, msgId: 'm2' }); // 回合 2 排队
  await new Promise((r) => setTimeout(r, 50));
  expect(started).toBe(1);
  await capturedShutdown!('SIGTERM');          // 触发真实关停（不真发信号）
  release.release();
  await new Promise((r) => setTimeout(r, 50));
  expect(order).toEqual(['queue.close', 'runner.killAll']);
  expect(started).toBe(1);                     // 排队回合被 close 丢弃，未 spawn
});
```

（`ws2` 为另一 tmp 工作区（saveBotEnv + bootstrapWorkspace 预置）；`P2P_PAYLOAD`/`deferred` 为本文件既有 fixture；落地时严格保持断言：order 数组与 started 计数。）

删除 `src/handlers/echo.ts`、`tests/unit/echo.test.ts`、`tests/integration/round-trip.test.ts`（传输层断言由新集成测试承接，decisions D10）。

- [x] **Step 4: 验证 PASS** — Run: `bun run typecheck && bun test` Expected: 全绿。
- [x] **Step 5: Commit** — `bun run typecheck && bun test && git add -A && git commit -m "feat(gateway): wire agent session handler, retire echo, full round-trip integration coverage"`

**--- 检查点 D：全链路（transport→queue→agent→card）CI 绿 ---**

### Task 11: SPEC.md D2 章节 + CHANGELOG + README + live-smoke runbook

**Files:**
- Modify: `SPEC.md`, `CHANGELOG.md`, `README.md`
- Create: `docs/issues/2/live-smoke.md`

**Interfaces:**
- Consumes: 已实现行为（Task 1–10）。
- Produces: 行为契约与活体验证清单。

- [ ] **Step 1: SPEC.md** 追加 `## Session / Agent（D2 契约）` 与 `## AI 卡回复（D2 契约）` 两节、修订 Reply 节 echo 行为条目为"已由 D2 取代"；逐条标注 `CI-verified` / `live-verified`（待回填）。要点：per-chat 会话与 TTL 到达时判定、claude 无头回合形状（--session-id/--resume、消息域文本累计、回调串行化、进程组看门狗）、AI 卡 createAndDeliver/streaming 载荷与双阈值节流、恰好一条 markdown 回退链、AskUserQuestion 编号降级与数字应答（多题+多选降级为文字回复）、配置键全表（DEFAULT_CONFIG）、关停语义（queue.close + killAll）。
- [ ] **Step 2: CHANGELOG** `[Unreleased]` 增 Added：agent 会话层、AI 卡流式桥、串行队列、问题桥（issue #2）。
- [ ] **Step 3: README** 快速开始补 config.json 示例（模板 id、TTL、模型）与"卡模板创建前置"一句。
- [ ] **Step 4: live-smoke runbook** `docs/issues/2/live-smoke.md`（中文；FLAGGED-FOR-HUMAN 项步骤化）：
  1. 前置：钉钉卡片平台创建含 AI markdown 组件（变量名 `content`）模板 → 取模板 ID 填 `ai_card_template_id`；确认应用可见范围受控（D5 风险项）。
  2. AC1：p2p 发"用一句话介绍你自己"→ 观察打字机 + 卡终态 finished；`latest.log` 查 `卡片收终` 行。
  3. AC2：60 分钟内追问"我上一句问了什么"→ 上下文保留；等 TTL 过后再问 → 新会话 + `sessions/` 文件 sessionId 变化。
  4. AC5：诱导 agent 调 AskUserQuestion（"问我一个选择题"）→ 卡内编号列表 → 回复 `2` → agent 按选择继续。
  5. AC6：日志 `卡片收终 bytes=… flushes=… suppressed=…` 行摘录——配额余量据此校准 `card_stream_min_interval_ms/min_bytes`（decisions FLAGGED 2）。
  6. AC4（可选破坏性）：临时改错模板 ID 重启 → 回复降级为一条 markdown 全文 + error 日志。
  7. 关停验证：`stop` 后确认无残留 `claude` 子进程（`pgrep -f 'claude -p'` 为空）。
- [ ] **Step 5: 终检 + Commit** — Run: `bun run typecheck && bun test && bun run build && bun run check:dist` Expected: 全绿。`git add SPEC.md CHANGELOG.md README.md docs/issues/2/live-smoke.md && git commit -m "docs: D2 behavior contract, changelog, and live-smoke runbook"`

## 风险与缓解（显式）

1. **AI 卡模板为 owner 侧前置**（FLAGGED-FOR-HUMAN 3）：模板未建/变量名不符 → 空模板 markdown-only 模式兜底；`card_content_key` 可对齐；runbook 步骤 1 步骤化。
2. **bypassPermissions 暴露窗口**（FLAGGED-FOR-HUMAN 1）：启动 warn + runbook 可见范围确认 + D3 尽快跟进；config 可收紧 acceptEdits。
3. **claude CLI 版本漂移**（stream-json 事件形状）：`claude_bin` 可配；解析防御（非 JSON 跳过、未知事件忽略）；CLI 升级破坏时单测先红（fake 事件形状契约钉住）。
4. **AskUserQuestion headless 自动拒绝的副产物**：模型多跑一个子回合并看到一次 denial（实测行为，接受）；应答以结构化用户消息回传，AC5 语义达成（decisions D2 已记录与 spec 措辞的偏差）。
5. **节流默认值（1500ms/64B）未经 live 配额验证**（FLAGGED-FOR-HUMAN 2）：finalize 恒全量兜底无数据丢失；runbook 步骤 5 校准。
6. **argv 传 prompt 的长度上限**（~2MB）：聊天消息远小于上限；消息平台自身长度限制兜底，不另设防护。
7. **detach 进程组泄漏**：killAll 注册表 + 看门狗 + 队列 close 三重保险；runbook 步骤 7 活体核查无残留。
8. **runner 的 fake 与真实 stream-json 的形状漂移**：fake 钉住的是 CLI 实测形状（2026-09-13 探测记录于 decisions.md）；CLI 升级时以 live-smoke 复测为准。
