# Commands, Access Control & Group Policy Implementation Plan

**Goal:** 在 transport 与 agent 会话层之间插入 dispatch 层：msgId 原子占位去重 → p2p 鉴权 / 群白名单 → 网关命令（/new /stop /status /help）解析执行 → 委派 agent，使四命令永不到达 agent、陌生 p2p 被明确拒绝、非白名单群 @ 静默留日志。

**Architecture:** 新增 `src/dedupe.ts`（原子占位去重）、`src/access.ts`（access.json 每消息读盘 + fail-closed）、`src/handlers/commands.ts`（四命令）、`src/handlers/dispatch.ts`（外层路由 handler）；`SessionStore` 增 epoch 代际（/new 复活防护）与 `list()`（/status 枚举，哈希展示）；`ClaudeRunner` 增 `chatKey` 路由与 `abortChat`（/stop 按聊天中止）；`Gateway` 暴露 `lastState`；`run.ts` 在**单提交**内切换装配并上收 agent-session 去重（杜绝中间回归 HEAD）。

**Tech Stack:** TypeScript (ESM, bun)、bun:test、既有零新依赖原则（node:fs / node:crypto / 内置 fetch）。

**Spec:** `docs/issues/3/decisions.md`

## Global Constraints

- **AC1（S8–S11）**：`/new` `/stop` `/status` `/help` 在 p2p 与群 @（剥 @ 后）均正确响应；四命令**绝不**进入 agent 会话（runner 不被调用）。
- **AC2（S12）**：非白名单 p2p 发送者收到固定泛化拒绝文本（不含命令名/配置面信息）；不 spawn 会话（store/queue/runner 零交互）。
- **AC3（S3）**：白名单群内 @ 路由到该群会话（`group:<conversationId>` chatKey，进入 agent handler）。
- **AC4（S3）**：非白名单群 @ 无任何回复调用，且落一条 warn 日志。
- **G1（D1）**：access 加载/解析异常 fail-closed 映射为正常回复（p2p 拒绝文本 / 群仅日志），绝不向 transport 上抛；命令本地逻辑（reset/list/depthOf/abortChat 元数据）经既有实现为异常安全（delete/abortChat 内部收容），残余本地异常与回复发送失败同路径上抛并 `dedupe.release`——由 adapter 有界重试（≤3 次/50s 预算）消化，reset/abort 幂等故重试无副作用。
- **G2（D4）**：access.json 每条消息读盘；ENOENT 单次立即重试（容忍原子替换）；失败按签名限频 warn 后返回空表（fail-closed 全拒，含 admin）；读取函数可注入以便确定性测试重试分支。
- **G3（D7）**：/new 用 epoch 代际——在飞/排队回合的陈旧快照 persist 被跳过，旧 sessionId 不复活；在飞回合不杀；`list()` 仅以哈希展示会话（不回显原始 staffId/openConversationId）。
- **G4（D8/D13）**：/stop 仅杀在飞（不清排队）；TERM→killDelay→KILL 同 killAll 纪律；确认文案披露队列深度；防御性超时后**诚实文案**（不谎报"已中止"）；abortChat 幂等、settle 后摘索引。
- **G5（D10）**：`reserve` 同步 check+add 于任何 await 之前；失败路径 release，重试可重入。
- **G6（D6）**：/status 群内只出健康概览+计数；会话明细与 admin/approved 名单仅 p2p，且会话明细以 chatKey 哈希（文件名 16hex）展示。
- **G7**：本 worktree 跑门禁前先 `bun install`（共享 node_modules 缺 dingtalk-stream）。
- **G8**：门禁 = `bun run typecheck` + `bun test` 全绿；SPEC 的 `CI-verified` 标注在门禁全绿后才回填（文档不得预claim验证）；行为变更写入 CHANGELOG。
- **G9**：不新增 config 键（拒绝文案/帮助文案硬编码常量）；不引入新依赖。

## Tasks

---

### Task 1: MsgIdDedupe 基础件（原子占位去重）

**Files:**
- Create: `src/dedupe.ts`
- Test: `tests/unit/dedupe.test.ts`

**Interfaces:**
- Produces: `class MsgIdDedupe { constructor(cap?: number); reserve(msgId: string): boolean; release(msgId: string): void }`（Task 6 dispatch 消费）

- [x] **Step 1: Write the failing test** — `tests/unit/dedupe.test.ts`：

```ts
import { test, expect } from 'bun:test';
import { MsgIdDedupe } from '../../src/dedupe.js';

test('dedupe: reserve 首见 true、重占 false；release 后可重占（失败重入）', () => {
  const d = new MsgIdDedupe(3);
  expect(d.reserve('a')).toBe(true);
  expect(d.reserve('a')).toBe(false); // 同步占位——无 await 竞态窗口
  d.release('a');
  expect(d.reserve('a')).toBe(true);
});

test('dedupe: LRU 容量淘汰最旧（保持插入序）', () => {
  const d = new MsgIdDedupe(2);
  d.reserve('a'); d.reserve('b'); d.reserve('c'); // a 被淘汰
  expect(d.reserve('a')).toBe(true);
  expect(d.reserve('b')).toBe(false);
  expect(d.reserve('c')).toBe(false);
});

test('dedupe: release 未见过的 id 为 no-op', () => {
  const d = new MsgIdDedupe(2);
  expect(() => d.release('nope')).not.toThrow();
  expect(d.reserve('nope')).toBe(true);
});
```

- [x] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/dedupe.test.ts` Expected: FAIL（模块 `../../src/dedupe.js` 不存在）
- [x] **Step 3: Write the minimal implementation** — `src/dedupe.ts`：

```ts
// msgId 去重（D3 D10）：reserve = 同步 check+add，必须在任何 await 之前完成——
// 单线程事件循环内服务端重推无竞态窗口；送达/入队失败路径 release 撤销占位，
// transport 局部重试可重入（语义等同 D2 的"送达成功才记"，但无 await 间隙）。
export class MsgIdDedupe {
  private readonly seen = new Set<string>();

  constructor(private readonly cap = 500) {}

  reserve(msgId: string): boolean {
    if (this.seen.has(msgId)) return false;
    this.seen.add(msgId);
    if (this.seen.size > this.cap) {
      const oldest = this.seen.values().next().value; // Set 保持插入序
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  release(msgId: string): void {
    this.seen.delete(msgId);
  }
}
```

- [x] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/unit/dedupe.test.ts` Expected: PASS（3 tests）
- [x] **Step 5: Commit** — `git add src/dedupe.ts tests/unit/dedupe.test.ts && git commit -m "feat(d3): msgId 原子占位去重件 MsgIdDedupe"`

---

### Task 2: SessionStore epoch 代际 + reset() + list()

**Files:**
- Modify: `src/agent/session-store.ts`（SessionRecord、persist/beginTurn/load、新增 reset/list）
- Modify: `src/handlers/agent-session.ts:103`（对账 fresh===null 字面量补 `epoch: record.epoch`）
- Test: `tests/unit/session-store.test.ts`（追加）；`tests/unit/agent-session.test.ts`（追加 G3 对账集成用例）

**Interfaces:**
- Produces: `SessionRecord.epoch?: number`；`SessionStore.reset(chatKey: string): void`；`SessionStore.list(): Array<{ chatKey: string; chatKeyHash: string; sessionId: string; lastActiveAt: number; pending: boolean }>`（Task 5 commands 消费；chatKeyHash = 文件名 16hex，/status 只渲染哈希——G6）

- [x] **Step 1: Write the failing test** — 追加到 `tests/unit/session-store.test.ts`：

```ts
test('store D3: reset 后旧在飞回合 persist 不复活（epoch 代际，G3）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-sess-d3a-'));
  const store = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000 });
  const { record } = store.beginTurn('p2p:st1');   // 在飞回合到达快照 epoch=0
  store.reset('p2p:st1');                           // /new → epoch=1，文件删除留痕
  expect(store.load('p2p:st1')).toBeNull();
  store.persist(record);                            // 在飞回合结束落盘 → 陈旧代际跳过
  expect(store.load('p2p:st1')).toBeNull();         // 旧 sessionId 不复活
  const next = store.beginTurn('p2p:st1');          // /new 后的新消息
  expect(next.resume).toBe(false);
  store.persist(next.record);
  expect(store.load('p2p:st1')!.sessionId).toBe(next.record.sessionId); // 新代正常落盘
});

test('store D3: reset 不牵连其他 chat；多次 reset 代际单调；无既有会话 reset 幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-sess-d3b-'));
  const store = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000 });
  const a = store.beginTurn('p2p:a').record;
  store.beginTurn('p2p:b');
  store.reset('p2p:a');
  store.reset('p2p:a');                             // epoch=2
  store.persist(a);                                 // epoch 0 < 2 → 跳过
  expect(store.load('p2p:a')).toBeNull();
  expect(store.load('p2p:b')).not.toBeNull();
  expect(() => store.reset('p2p:none')).not.toThrow(); // 无会话 reset 无害
  expect(store.load('p2p:none')).toBeNull();
});

test('store D3: list() 按 lastActiveAt 降序、chatKeyHash=文件名 16hex、pending 标记、坏文件聚合计数跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-sess-d3c-'));
  let clock = 1_000_000;
  const warns: string[] = [];
  const store = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000, now: () => clock,
    logger: { debug() {}, info() {}, warn: (_s, m) => warns.push(m), error() {} } });
  store.beginTurn('p2p:x');
  clock += 60_000;
  const y = store.beginTurn('group:y').record;
  y.pendingQuestion = Q;
  store.persist(y);
  writeFileSync(join(dir, 'badfile.json'), '{not-json'); // 坏文件
  const hashOf = (chatKey: string): string =>
    createHash('sha256').update(chatKey).digest('hex').slice(0, 16);
  let list = store.list();
  expect(list).toHaveLength(2);
  expect(list[0]!.chatKey).toBe('group:y');          // 更晚活跃在前
  expect(list[0]!.chatKeyHash).toBe(hashOf('group:y'));
  expect(list[0]!.pending).toBe(true);
  expect(list[1]!.pending).toBe(false);
  expect(warns.some((w) => w.includes('跳过 1 个'))).toBe(true);
  clock += 60_000;
  store.beginTurn('p2p:x');                          // touch 后 x 重新排前
  list = store.list();
  expect(list[0]!.chatKey).toBe('p2p:x');
});

test('store D3: 跨重启复活防线——磁盘 epoch 大于内存代时 load 重盖章，reset 后陈旧 persist 仍被拦截（r3 评审修复回归）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-sess-d3d-'));
  // 模拟"重启前 reset 过 5 次"的盘面：手工种入高 epoch 记录
  const seed = { chatKey: 'p2p:st1', sessionId: 'old-uuid', lastActiveAt: Date.now(), epoch: 5 };
  writeFileSync(join(dir, `${createHash('sha256').update('p2p:st1').digest('hex').slice(0, 16)}.json`), JSON.stringify(seed));
  const s2 = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000 }); // "重启"：内存代归零
  const snap = s2.load('p2p:st1');                    // 真实流程的取值点：重盖章为当前代 0
  expect(snap!.sessionId).toBe('old-uuid');
  expect(snap!.epoch).toBe(0);                        // 若不重盖章，此处为 5 → 后续判陈旧恒 false
  s2.reset('p2p:st1');                                // /new → 内存代 1，文件删除
  s2.persist(snap);                                   // 在飞/排队回合持取值快照落盘（epoch 0 < 1）
  expect(s2.load('p2p:st1')).toBeNull();              // 拦截——旧 sessionId 不复活
});
```

（文件头 import 增加 `createHash`：`import { createHash } from 'node:crypto';`）

- [x] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/session-store.test.ts` Expected: FAIL（`store.reset`/`store.list` 不是函数）
- [x] **Step 3: Write the minimal implementation** — `src/agent/session-store.ts`：

```ts
// imports 增加 readdirSync：
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

// SessionRecord 增字段（epoch 随文件持久化；undefined=落盘时按当前代盖章）：
export interface SessionRecord {
  chatKey: string;
  sessionId: string;
  lastActiveAt: number; // epoch ms
  pendingQuestion?: AskUserQuestionPayload;
  epoch?: number;       // D3 D7：/new 代际墓碑的比较基准
}

// 类内新增（epochs 为进程内存态——v1 单实例网关）：
private readonly epochs = new Map<string, number>();

private epochOf(chatKey: string): number { return this.epochs.get(chatKey) ?? 0; }

reset(chatKey: string): void {
  this.epochs.set(chatKey, this.epochOf(chatKey) + 1);
  this.delete(chatKey);
  this.opts.logger?.info('session', `chat=${chatKey} 会话已重置（epoch=${this.epochOf(chatKey)}）`);
}

// load() 返回值重盖章（r3 评审修复：跨重启复活防线）——磁盘上的 epoch 可能大于重启后
// 归零的内存代（如重启前 reset 过 5 次），若原样返回，后续 /new(→1) 对 epoch=5 的记录
// 永远判不陈旧 → 旧 sessionId 复活。取用时统一盖"当前代"，陈旧比较即恢复正确：
//   load 后若发生 reset，current > 取用时盖章值 → 拦截 ✓；未 reset → 相等 → 放行 ✓
load(chatKey: string): SessionRecord | null {
  // …原解析/校验逻辑不变，返回处改为：
  return { ...rec, epoch: this.epochOf(chatKey) };
}

// beginTurn 的两个 record 字面量补 epoch 盖章（当前代）：
const record: SessionRecord = resume
  ? { ...existing, epoch: this.epochOf(chatKey), lastActiveAt: now }
  : { chatKey, sessionId: randomUUID(), epoch: this.epochOf(chatKey), lastActiveAt: now };

// persist() 开头插入陈旧代际拦截，merged 补盖章：
persist(record: SessionRecord): void {
  const curEpoch = this.epochOf(record.chatKey);
  if (record.epoch !== undefined && record.epoch < curEpoch) {
    this.opts.logger?.warn('session', `chat=${record.chatKey} 陈旧代际记录（epoch=${record.epoch}<${curEpoch}），跳过持久化（/new 后不复活旧会话）`);
    return;
  }
  const file = this.fileOf(record.chatKey);
  const disk = this.load(record.chatKey);
  const merged: SessionRecord = disk !== null
    ? { ...record, epoch: record.epoch ?? curEpoch, lastActiveAt: Math.max(record.lastActiveAt, disk.lastActiveAt) }
    : { ...record, epoch: record.epoch ?? curEpoch };
  // …（其余 tmp+rename 原子写不变）

list(): Array<{ chatKey: string; chatKeyHash: string; sessionId: string; lastActiveAt: number; pending: boolean }> {
  let files: string[] = [];
  try { files = readdirSync(this.opts.sessionsDir); } catch { return []; }
  const out: Array<{ chatKey: string; chatKeyHash: string; sessionId: string; lastActiveAt: number; pending: boolean }> = [];
  let bad = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(readFileSync(join(this.opts.sessionsDir, f), 'utf8')) as SessionRecord;
      if (typeof rec.chatKey !== 'string' || typeof rec.sessionId !== 'string' || typeof rec.lastActiveAt !== 'number') { bad += 1; continue; }
      out.push({ chatKey: rec.chatKey, chatKeyHash: f.slice(0, -'.json'.length), sessionId: rec.sessionId, lastActiveAt: rec.lastActiveAt, pending: rec.pendingQuestion !== undefined });
    } catch { bad += 1; }
  }
  if (bad > 0) this.opts.logger?.warn('session', `list() 跳过 ${bad} 个损坏/畸形会话文件`);
  return out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}
```

同 task 修改 `src/handlers/agent-session.ts` 对账路径——排队消息经 /new 作废后开跑时创建的新会话仍属"旧到达代"，其落盘须被墓碑拦截（G3 的关键一行）：

```ts
// fresh === null 分支（原 line 103）：继承到达时代——若到达后发生过 /new，此记录按陈旧代跳过
effectiveRecord = { chatKey, sessionId: randomUUID(), epoch: record.epoch, lastActiveAt: record.lastActiveAt };
```

并追加 **G3 对账路径集成用例**到 `tests/unit/agent-session.test.ts`（复用其 `msg`/`fakeRunner`/`harness`；本用例随本 task 的 FAIL→PASS 走）：

```ts
test('D3 /new 竞态: 在飞与排队消息跨 reset——旧 id 不复活、后续全新会话（G3 对账路径）', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { calls, runner } = fakeRunner([
    async () => { await gate; },   // A：在飞挂起
    async () => {},                // B：reset 前到达、reset 后开跑
    async () => {},                // C：reset 后的新消息
  ]);
  const h = harness(runner);
  await h.handler(msg({ msgId: 'a1', textContent: '长回合' }));       // A 入队即开跑（挂起）
  await h.handler(msg({ msgId: 'b1', textContent: '排队消息' }));     // B 到达（排队，arrival epoch=0）
  await new Promise((r) => setTimeout(r, 20));                        // 等 A job 开始（fresh 对账已过）
  h.store.reset('p2p:st1');                                          // /new：epoch=1，文件删除
  release();                                                         // A 完成 → persist 陈旧跳过
  await h.queue.waitIdle('p2p:st1');                                 // A、B 都收尾
  expect(h.store.load('p2p:st1')).toBeNull();                        // A 与 B 的 persist 均被墓碑拦截
  expect(calls[1]!.req.sessionId).not.toBe(calls[0]!.req.sessionId); // B 对账后新 sessionId（不复用 A 的）
  await h.handler(msg({ msgId: 'c1', textContent: '新开始' }));       // C：reset 后全新
  await h.queue.waitIdle('p2p:st1');
  expect(calls[2]!.req.resume).toBe(false);
  expect(h.store.load('p2p:st1')!.sessionId).toBe(calls[2]!.req.sessionId); // C 正常落盘
});
```

- [x] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/unit/session-store.test.ts tests/unit/agent-session.test.ts` Expected: PASS（既有用例不回归）
- [x] **Step 5: Commit** — `git add src/agent/session-store.ts src/handlers/agent-session.ts tests/unit/session-store.test.ts tests/unit/agent-session.test.ts && git commit -m "feat(d3): SessionStore epoch 代际墓碑（load 重盖章防跨重启复活）与 list() 哈希枚举"`

---

### Task 3: ClaudeRunner chatKey 路由 + abortChat

**Files:**
- Modify: `src/agent/claude-runner.ts`（TurnRequest、ActiveChild、byChat 索引、abortChat/activeCountOf）
- Modify: `src/handlers/agent-session.ts`（run 调用补 `chatKey`）
- Test: `tests/unit/claude-runner.test.ts`（追加）

**Interfaces:**
- Produces: `TurnRequest.chatKey?: string`；`ClaudeRunner.abortChat(chatKey: string, reason: string): Promise<number>`（返回**实际发出中止**的回合数——自然完成的在快照期排除，/stop 据此如实回复）；`ClaudeRunner.activeCountOf(chatKey: string): number`（Task 5 commands 消费）

- [x] **Step 1: Write the failing test** — 追加到 `tests/unit/claude-runner.test.ts`：

```ts
test('runner D3: abortChat 只杀目标 chat 的在飞回合，他 chat 不受扰；settle 后索引清零（G4）', async () => {
  const childA = makeFakeChild();
  const childB = makeFakeChild();
  const children = [childA, childB];
  const byPid = new Map([[childA.pid, childA], [childB.pid, childB]]);
  const r = new ClaudeRunner({
    bin: 'claude', model: 'm', permissionMode: 'p', timeoutMs: 60_000,
    logger: silentLogger(), killDelayMs: 10,
    spawnFn: (() => children.shift()!) as unknown as typeof spawn,
    killFn: (pid, sig) => { byPid.get(Math.abs(pid))?.killed.push(sig); },
  });
  const pA = r.run({ prompt: 'a', sessionId: 'u1', resume: false, cwd: '/ws', chatKey: 'p2p:A' }, {});
  const pB = r.run({ prompt: 'b', sessionId: 'u2', resume: false, cwd: '/ws', chatKey: 'p2p:B' }, {});
  expect(r.activeCountOf('p2p:A')).toBe(1);
  expect(await r.abortChat('p2p:A', '用户 /stop')).toBe(1); // 实际中止数
  const rA = await pA; // escalation(10ms)→KILL→finish(false) 保证 settle
  expect(rA.ok).toBe(false);
  expect(rA.errorText).toContain('/stop');
  expect(childA.killed).toContain('SIGTERM');
  expect(r.activeCountOf('p2p:A')).toBe(0);   // settle 后摘索引
  childB.write({ type: 'result', subtype: 'success' }); childB.closeStdout(); childB.exitWith(0);
  const rB = await pB;
  expect(rB.ok).toBe(true);                    // B 完好
  expect(r.activeCountOf('p2p:B')).toBe(0);
});

test('runner D3: abortChat 空 chat 幂等 no-op 返回 0；自然完成的 chat 返回 0；无 chatKey 的 run 不入 byChat', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  await expect(r.abortChat('p2p:none', 'x')).resolves.toBe(0);
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws', chatKey: 'p2p:done' }, {});
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  expect((await p).ok).toBe(true);                   // 自然完成 → 索引已清
  await expect(r.abortChat('p2p:done', '晚到的 /stop')).resolves.toBe(0); // 不误报中止
  const p2 = r.run({ prompt: 'y', sessionId: 'u2', resume: false, cwd: '/ws' }, {}); // 无 chatKey
  expect(r.activeCountOf('p2p:anywhere')).toBe(0);
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  expect((await p2).ok).toBe(true);
});
```

- [x] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/claude-runner.test.ts` Expected: FAIL（`abortChat`/`activeCountOf` 不是函数）
- [x] **Step 3: Write the minimal implementation** — `src/agent/claude-runner.ts`：

```ts
export interface TurnRequest { prompt: string; sessionId: string; resume: boolean; cwd: string; chatKey?: string }

interface ActiveChild {
  pid: number;
  killGroup: (s: NodeJS.Signals) => void;
  abort: (reason: string) => boolean; // true=实际发起强制中止（r3：过滤后到 abort 生效间的自然完成）
  completion: Promise<void>;
  isSettled(): boolean; // /stop 竞态：自然完成的回合不计入"实际中止数"
  chatKey?: string; // D3：/stop 按 chat 中止的路由键
}

// 类内新增：
private readonly byChat = new Map<string, Set<ActiveChild>>();

activeCountOf(chatKey: string): number { return this.byChat.get(chatKey)?.size ?? 0; }

async abortChat(chatKey: string, reason: string): Promise<number> {
  const set = this.byChat.get(chatKey);
  if (set === undefined) return 0;
  const targets = [...set].filter((a) => !a.isSettled()); // 快照期排除已自然完成的
  if (targets.length === 0) return 0;
  const waits = targets.map((a) => a.completion); // 先取 completion——abort 后 settle 仍可达
  let aborted = 0;
  for (const a of targets) { if (a.abort(reason)) aborted += 1; } // 只计实际发起的
  await Promise.all(waits); // abort 的 TERM→killDelay→KILL→finish 链保证有界 settle
  return aborted;
}

// entry 构造补 chatKey 与 isSettled，abort 返回是否实际发起（原 body 开头补 return 语义）：
const entry: ActiveChild = { pid: child.pid ?? 0, killGroup, completion, chatKey: req.chatKey,
  isSettled: () => settled,
  abort: (reason: string) => {
    if (settled) return false;      // 竞态窗口内已自然完成——不计入中止数
    forcedError = reason;
    killGroup('SIGTERM');
    const escalation = setTimeout(() => { killGroup('SIGKILL'); finish(false, reason); }, this.opts.killDelayMs ?? 5_000);
    escalationTimers.add(escalation);
    return true;
  } };
entryRef = entry;
this.active.add(entry);
if (req.chatKey !== undefined) {
  let set = this.byChat.get(req.chatKey);
  if (set === undefined) { set = new Set(); this.byChat.set(req.chatKey, set); }
  set.add(entry);
}

// finish() 的清理分支（active.delete 旁）补 byChat 摘除：
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
```

同 task 修改 `src/handlers/agent-session.ts` 的 run 调用：

```ts
const result = await deps.runner.run(
  { prompt: effectivePrompt, sessionId: effectiveRecord.sessionId, resume: effectiveResume, cwd: deps.workspace, chatKey },
  { …回调不变… },
);
```

- [x] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/unit/claude-runner.test.ts tests/unit/agent-session.test.ts` Expected: PASS
- [x] **Step 5: Commit** — `git add src/agent/claude-runner.ts src/handlers/agent-session.ts tests/unit/claude-runner.test.ts && git commit -m "feat(d3): runner 按 chatKey 路由与 abortChat（/stop 仅杀在飞）"`

---

### Task 4: src/access.ts（access.json 读盘 + 判定，readFile 可注入）

**Files:**
- Create: `src/access.ts`
- Test: `tests/unit/access.test.ts`

**Interfaces:**
- Produces: `interface AccessList { admin: string[]; approved: string[]; groups: string[] }`；`type AccessTier = 'admin' | 'approved' | 'unknown'`；`createAccessLoader(file: string, logger?: Logger, readFile?: (file: string) => string): () => AccessList`；`tierOf(list, staffId): AccessTier`；`isGroupAllowed(list, conversationId): boolean`；`parseAccessList(raw): AccessList | null`；`emptyAccessList(): AccessList`（Task 5/6 消费）

- [x] **Step 1: Write the failing test** — `tests/unit/access.test.ts`：

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessLoader, parseAccessList, tierOf, isGroupAllowed, emptyAccessList } from '../../src/access.js';

const log = (warns: string[]) => ({ debug() {}, info() {}, warn: (_s: string, m: string) => warns.push(m), error() {} });

test('access: 合法文件——admin/approved 分层判定与群白名单', () => {
  const list = parseAccessList({ admin: ['st0'], approved: ['st1'], groups: ['cidG'] })!;
  expect(tierOf(list, 'st0')).toBe('admin');
  expect(tierOf(list, 'st1')).toBe('approved');
  expect(tierOf(list, 'stX')).toBe('unknown');
  expect(isGroupAllowed(list, 'cidG')).toBe(true);
  expect(isGroupAllowed(list, 'cidOther')).toBe(false);
});

test('access: 形状非法 → null（fail-closed 前置）', () => {
  expect(parseAccessList(null)).toBeNull();
  expect(parseAccessList({ admin: 'st0', approved: [], groups: [] })).toBeNull();   // 非数组
  expect(parseAccessList({ admin: [1], approved: [], groups: [] })).toBeNull();     // 元素非 string
  expect(parseAccessList({ approved: [], groups: [] })).toBeNull();                 // 缺键
});

test('access: 每消息读盘即时生效；解析失败 fail-closed（admin 也拒）且按签名限频（G2）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-acc-'));
  const file = join(dir, 'access.json');
  writeFileSync(file, JSON.stringify({ admin: ['st0'], approved: [], groups: [] }));
  const warns: string[] = [];
  const load = createAccessLoader(file, log(warns));
  expect(tierOf(load(), 'st0')).toBe('admin');
  writeFileSync(file, '{broken');                       // 手改坏
  const denied = load();
  expect(denied).toEqual(emptyAccessList());             // 全拒
  expect(tierOf(denied, 'st0')).toBe('unknown');         // admin 也被锁出（fail-closed 实证）
  expect(load()).toEqual(emptyAccessList());             // 再读仍全拒
  expect(warns.filter((w) => w.includes('解析失败'))).toHaveLength(1); // 同签名只 warn 一次
  writeFileSync(file, JSON.stringify({ admin: [], approved: ['st0'], groups: [] }));
  expect(tierOf(load(), 'st0')).toBe('approved');        // 修好即恢复，签名重置
});

test('access: readFile 注入——首次 ENOENT 重试命中；两次失败 fail-closed（重试分支确定性覆盖）', () => {
  const warns: string[] = [];
  const good = JSON.stringify({ admin: ['st0'], approved: [], groups: [] });
  let calls = 0;
  const rfRetryOk = (_f: string): string => {
    calls += 1;
    if (calls === 1) { const e = new Error('swap 中间态') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; }
    return good;
  };
  const load1 = createAccessLoader('/x/access.json', log(warns), rfRetryOk);
  expect(load1()).toEqual({ admin: ['st0'], approved: [], groups: [] }); // 单次重试命中新文件
  expect(warns).toHaveLength(0);
  const rfAlwaysGone = (): string => { const e = new Error('gone') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; };
  const load2 = createAccessLoader('/x/access.json', log(warns), rfAlwaysGone);
  expect(load2()).toEqual(emptyAccessList());            // 两次 ENOENT → fail-closed
  expect(warns.some((w) => w.includes('fail-closed'))).toBe(true);
});
```

- [x] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/access.test.ts` Expected: FAIL（模块不存在）
- [x] **Step 3: Write the minimal implementation** — `src/access.ts`：

```ts
import { readFileSync } from 'node:fs';
import type { Logger } from './logger.js';

export interface AccessList { admin: string[]; approved: string[]; groups: string[] }
export type AccessTier = 'admin' | 'approved' | 'unknown';

export function emptyAccessList(): AccessList { return { admin: [], approved: [], groups: [] }; }

export function parseAccessList(raw: unknown): AccessList | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const arr = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  const admin = arr(p.admin); const approved = arr(p.approved); const groups = arr(p.groups);
  if (admin === null || approved === null || groups === null) return null;
  return { admin, approved, groups };
}

export function tierOf(list: AccessList, staffId: string): AccessTier {
  if (list.admin.includes(staffId)) return 'admin';
  if (list.approved.includes(staffId)) return 'approved';
  return 'unknown';
}

export function isGroupAllowed(list: AccessList, conversationId: string): boolean {
  return list.groups.includes(conversationId);
}

type ReadFile = (file: string) => string;
const defaultReadFile: ReadFile = (f) => readFileSync(f, 'utf8');

// 每消息读盘（手工编辑即时生效）。失败 fail-closed 空表（全员按陌生，含 admin——
// 单 owner 手改 typo 自锁可接受，修文件即恢复）；warn 按错误签名限频；
// ENOENT 单次立即重试容忍编辑器 rename-swap 原子替换瞬间（D4）。readFile 可注入（测试）。
export function createAccessLoader(file: string, logger?: Logger, readFile: ReadFile = defaultReadFile): () => AccessList {
  let lastWarnSignature = '';
  const warnOnce = (signature: string, message: string): void => {
    if (signature === lastWarnSignature) return;
    lastWarnSignature = signature;
    logger?.warn('access', message);
  };
  const parseOnce = (): AccessList => {
    const parsed = parseAccessList(JSON.parse(readFile(file)));
    if (parsed === null) {
      const err = new Error('形状非法（需 {admin,approved,groups} 均为 string[]）') as NodeJS.ErrnoException;
      err.code = 'EACCESSSHAPE';
      throw err;
    }
    return parsed;
  };
  return (): AccessList => {
    let err: unknown;
    try {
      const parsed = parseOnce();
      lastWarnSignature = '';
      return parsed;
    } catch (e1) {
      err = e1;
      if ((e1 as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          const parsed = parseOnce(); // 单次立即重试：swap 瞬间后新文件已到位
          lastWarnSignature = '';
          return parsed;
        } catch (e2) { err = e2; }
      }
    }
    warnOnce(String(err), `access.json 读取/解析失败（fail-closed 全拒）: ${String(err)}`);
    return emptyAccessList();
  };
}
```

- [x] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/unit/access.test.ts` Expected: PASS
- [x] **Step 5: Commit** — `git add src/access.ts tests/unit/access.test.ts && git commit -m "feat(d3): access.json 每消息读盘 + fail-closed 判定（readFile 可注入）"`

---

### Task 5: src/handlers/commands.ts（四命令）

**Files:**
- Create: `src/handlers/commands.ts`
- Test: `tests/unit/gateway-commands.test.ts`（执行轮更名：`commands.test.ts` 与 D1 的 CLI 命令测试撞名，D1 文件保留不动）

**Interfaces:**
- Consumes: `SessionStore.reset/list`（Task 2）、`ClaudeRunner.abortChat/activeCountOf`（Task 3）、`TurnQueue.depthOf`（**既有 API**，`src/agent/turn-queue.ts:17`——codex round1 finding 1 经核实为误报，接口已存在，无需新增）、`RobotReplyer.sendOtoMarkdown/sendGroupMarkdown`、`ConnectionStateSnapshot`（state.ts）
- Produces: `parseCommand(text: string): CommandName | null`；`sendChatMarkdown(replyer, m, text): Promise<void>`；`createCommandExecutor(deps: CommandDeps): (name: CommandName, m: InboundRobotMessage) => Promise<void>`（Task 6 消费）

```ts
export type CommandName = 'new' | 'stop' | 'status' | 'help';
export interface CommandDeps {
  replyer: RobotReplyer;
  store: SessionStore;
  queue: { depthOf(chatKey: string): number };
  runner: { activeCountOf(chatKey: string): number; abortChat(chatKey: string, reason: string): Promise<number> };
  loadAccess: () => AccessList;
  status: () => ConnectionStateSnapshot | null;
  logger: Logger;
  now?: () => number;
  abortGuardMs?: number; // /stop await 的防御性上界（默认 7_000 = killDelay 5s + 2s 余量）
}
```

- [x] **Step 1: Write the failing test** — `tests/unit/commands.test.ts`（自足 fakes）：

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand, createCommandExecutor } from '../../src/handlers/commands.js';
import { SessionStore } from '../../src/agent/session-store.js';
import type { AccessList } from '../../src/access.js';
import type { InboundRobotMessage } from '../../src/transport/types.js';
import type { ConnectionStateSnapshot } from '../../src/state.js';

const msg = (over: Partial<InboundRobotMessage> = {}): InboundRobotMessage => ({
  msgId: 'm1', conversationId: 'cid', conversationKind: 'p2p', senderStaffId: 'st1', senderNick: '王',
  robotCode: 'rc', msgtype: 'text', textContent: '/help', sessionWebhook: null, raw: {}, ...over,
});

const quiet = { debug() {}, info() {}, warn() {}, error() {} } as const;

function makeDeps(over: Record<string, unknown> = {}) {
  const md: Array<{ kind: 'oto' | 'group'; text: string }> = [];
  const replyer = {
    sendOtoMarkdown: async (_rc: string, _ids: string[], _t: string, text: string) => { md.push({ kind: 'oto', text }); },
    sendGroupMarkdown: async (_rc: string, _cid: string, _t: string, text: string) => { md.push({ kind: 'group', text }); },
  } as never;
  const store = new SessionStore({ sessionsDir: mkdtempSync(join(tmpdir(), 'dtb-cmd-')), ttlMs: 3_600_000 });
  const runnerCalls: string[] = [];
  const runner = { activeCountOf: (_c: string) => 0, abortChat: async (c: string, r: string) => { runnerCalls.push(`${c}:${r}`); return 1; } };
  const deps = {
    replyer, store, queue: { depthOf: () => 0 }, runner,
    loadAccess: () => ({ admin: ['st0'], approved: ['st1'], groups: ['cidG'] }) as AccessList,
    status: () => ({ pid: 1, startedAt: new Date('2026-09-13T10:00:00Z').toISOString(), transport: 'connected', detail: '已连接并订阅', updatedAt: new Date().toISOString() }) as ConnectionStateSnapshot,
    logger: quiet,
    ...over,
  };
  return { deps, md, runnerCalls, store };
}

test('parseCommand: trim+小写精确匹配四命令；未知/带参/普通文本为 null', () => {
  expect(parseCommand('/help')).toBe('help');
  expect(parseCommand(' /NEW ')).toBe('new');
  expect(parseCommand('/Status')).toBe('status');
  expect(parseCommand('/stop')).toBe('stop');
  expect(parseCommand('/neww')).toBeNull();
  expect(parseCommand('/new xx')).toBeNull();
  expect(parseCommand('你好')).toBeNull();
  expect(parseCommand('')).toBeNull();
});

test('/help: p2p 与群同文案，含四命令与数字选答提示（AC1 面）', async () => {
  const { deps, md } = makeDeps();
  const exec = createCommandExecutor(deps as never);
  await exec('help', msg());
  await exec('help', msg({ conversationKind: 'group', conversationId: 'cidG', textContent: '@bot /help' }));
  expect(md).toHaveLength(2);
  expect(md[0]!.kind).toBe('oto');
  expect(md[1]!.kind).toBe('group');
  for (const x of md) {
    expect(x.text).toContain('/new'); expect(x.text).toContain('/stop');
    expect(x.text).toContain('/status'); expect(x.text).toContain('/help');
    expect(x.text).toContain('编号');
  }
});

test('/new: reset 该 chat 会话；在飞时文案披露回合仍会收尾（G3）', async () => {
  const { deps, md, store } = makeDeps({ runner: { activeCountOf: () => 1, abortChat: async () => 1 } });
  store.beginTurn('p2p:st1');
  const exec = createCommandExecutor(deps as never);
  await exec('new', msg());
  expect(store.load('p2p:st1')).toBeNull();           // reset 生效
  expect(md[0]!.text).toContain('已重置');
  expect(md[0]!.text).toContain('收尾');               // 在飞披露
});

test('/stop: 无在飞回提示；有在飞先回"正在中止"再 abort，终报含队列深度（G4/AC1 面）', async () => {
  const { deps, md, runnerCalls } = makeDeps({ runner: { activeCountOf: () => 1, abortChat: async () => 1 }, queue: { depthOf: () => 2 } });
  const exec = createCommandExecutor(deps as never);
  await exec('stop', msg({ senderStaffId: 'stX' })); // fake 的 activeCountOf 恒 1 → 走中止路径
  expect(runnerCalls).toEqual(['p2p:stX:用户 /stop']);
  expect(md).toHaveLength(2);                          // 正在中止 + 终报
  expect(md[0]!.text).toContain('正在中止');
  expect(md[1]!.text).toContain('已中止');
  expect(md[1]!.text).toContain('2');                  // 队列深度披露
  const idle = makeDeps();
  const exec2 = createCommandExecutor(idle.deps as never);
  await exec2('stop', msg());
  expect(idle.md).toHaveLength(1);
  expect(idle.md[0]!.text).toContain('无在飞');
});

test('/stop: 回合在窗口内自然结束（abortChat 返回 0）——如实回复"已自然结束"（G4）', async () => {
  const { deps, md } = makeDeps({ runner: { activeCountOf: () => 1, abortChat: async () => 0 } });
  const exec = createCommandExecutor(deps as never);
  await exec('stop', msg());
  expect(md).toHaveLength(2);
  expect(md[1]!.text).toContain('已自然结束');
  expect(md[1]!.text).not.toContain('已中止当前回合'); // 不误报中止
});

test('/stop: abortChat 悬挂时防御性超时——诚实文案不谎报"已中止"（G4/D13）', async () => {
  const { deps, md } = makeDeps({
    runner: { activeCountOf: () => 1, abortChat: () => new Promise<number>(() => {}) }, // 永不 settle
    abortGuardMs: 5,
  });
  const exec = createCommandExecutor(deps as never);
  await exec('stop', msg());
  expect(md).toHaveLength(2);
  expect(md[0]!.text).toContain('正在中止');
  expect(md[1]!.text).toContain('未在预期时间内完成'); // 不谎报
  expect(md[1]!.text).not.toContain('已中止当前回合'); // 与成功终报可区分
});

test('/status: p2p 含连接/会话哈希明细/名单；群内仅概览+计数、无 staffId 泄露（G6/AC1 面）', async () => {
  const { deps, md, store } = makeDeps();
  store.beginTurn('p2p:st0');                          // 一个会话
  const exec = createCommandExecutor(deps as never);
  await exec('status', msg({ senderStaffId: 'st1' }));
  const p2p = md[0]!.text;
  expect(p2p).toContain('connected');
  expect(p2p).toContain('st0');                        // admin 名单（issue 明列）
  expect(p2p).toContain('st1');                        // approved 名单
  expect(p2p).toMatch(/\[p2p\] [0-9a-f]{16}/);         // 会话明细=哈希（G6）
  expect(p2p).not.toContain('p2p:st0');                // 原始 chatKey 不回显
  await exec('status', msg({ conversationKind: 'group', conversationId: 'cidG' }));
  const group = md[1]!.text;
  expect(group).toContain('connected');
  expect(group).not.toContain('st0');                  // 名单不进群
  expect(group).not.toContain('[p2p]');               // 会话明细不进群
  expect(group).toMatch(/会话：1 个/);                  // 计数
});
```

- [x] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/commands.test.ts` Expected: FAIL（模块不存在）
- [x] **Step 3: Write the minimal implementation** — `src/handlers/commands.ts`：

```ts
import type { InboundRobotMessage } from '../transport/types.js';
import type { RobotReplyer } from '../openapi/robot.js';
import type { SessionStore } from '../agent/session-store.js';
import type { AccessList } from '../access.js';
import type { ConnectionStateSnapshot } from '../state.js';
import type { Logger } from '../logger.js';

export type CommandName = 'new' | 'stop' | 'status' | 'help';

const HELP_TEXT = [
  'dingtalkbot 命令：',
  '- /new — 重置会话（下一条消息开始全新对话）',
  '- /stop — 中止当前正在生成的回合',
  '- /status — 查看连接与会话状态',
  '- /help — 显示本帮助',
  '',
  '提示：机器人提问时可直接回复选项编号（多选用逗号分隔，如 1,3）。',
].join('\n');

export function parseCommand(text: string): CommandName | null {
  const t = text.trim().toLowerCase();
  if (t === '/new') return 'new';
  if (t === '/stop') return 'stop';
  if (t === '/status') return 'status';
  if (t === '/help') return 'help';
  return null;
}

export async function sendChatMarkdown(replyer: RobotReplyer, m: InboundRobotMessage, text: string): Promise<void> {
  if (m.conversationKind === 'p2p') {
    await replyer.sendOtoMarkdown(m.robotCode, [m.senderStaffId], 'dingtalkbot', text);
  } else {
    await replyer.sendGroupMarkdown(m.robotCode, m.conversationId, 'dingtalkbot', text);
  }
}

export interface CommandDeps {
  replyer: RobotReplyer;
  store: SessionStore;
  queue: { depthOf(chatKey: string): number };
  runner: { activeCountOf(chatKey: string): number; abortChat(chatKey: string, reason: string): Promise<number> };
  loadAccess: () => AccessList;
  status: () => ConnectionStateSnapshot | null;
  logger: Logger;
  now?: () => number;
  abortGuardMs?: number; // /stop await 的防御性上界（默认 7_000 = killDelay 5s + 2s 余量）
}

const chatKeyOf = (m: InboundRobotMessage): string =>
  m.conversationKind === 'p2p' ? `p2p:${m.senderStaffId}` : `group:${m.conversationId}`;

function humanUptime(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  const h = Math.floor(mins / 60); const rest = mins % 60;
  return h > 0 ? `${h}h${rest}m` : `${rest}m`;
}

function renderStatus(m: InboundRobotMessage, deps: CommandDeps): string {
  const snap = deps.status();
  const now = (deps.now ?? Date.now)();
  const lines: string[] = ['**dingtalkbot 状态**'];
  lines.push(`- 连接：${snap?.transport ?? 'unknown'}（${snap?.detail ?? '无快照'}）`);
  if (snap) lines.push(`- 运行：since ${snap.startedAt}（uptime ${humanUptime(Math.max(0, now - Date.parse(snap.startedAt)))}）pid=${snap.pid}`);
  const sessions = deps.store.list();
  const access = deps.loadAccess();
  lines.push(`- 会话：${sessions.length} 个`);
  if (m.conversationKind === 'group') {
    // G6：群内只出概览+计数——会话明细与访问名单不向全群广播
    lines.push(`- 访问：admin ${access.admin.length} · approved ${access.approved.length} · 群白名单 ${access.groups.length}`);
    return lines.join('\n');
  }
  for (const s of sessions.slice(0, 10)) {
    const kind = s.chatKey.startsWith('p2p:') ? 'p2p' : 'group';
    lines.push(`  - [${kind}] ${s.chatKeyHash} 活跃于 ${new Date(s.lastActiveAt).toISOString()}${s.pending ? '（待作答）' : ''}`);
  }
  if (sessions.length > 10) lines.push(`  - …及另 ${sessions.length - 10} 个`);
  lines.push(`- 访问：admin ${access.admin.length} · approved ${access.approved.length} · 群白名单 ${access.groups.length}（admin v1 仅信息性）`);
  if (access.admin.length > 0) lines.push(`  - admin: ${access.admin.join(', ')}`);
  if (access.approved.length > 0) lines.push(`  - approved: ${access.approved.join(', ')}`);
  return lines.join('\n');
}

export function createCommandExecutor(deps: CommandDeps): (name: CommandName, m: InboundRobotMessage) => Promise<void> {
  return async (name, m) => {
    const chatKey = chatKeyOf(m);
    if (name === 'help') { await sendChatMarkdown(deps.replyer, m, HELP_TEXT); return; }
    if (name === 'status') { await sendChatMarkdown(deps.replyer, m, renderStatus(m, deps)); return; }
    if (name === 'new') {
      const inFlight = deps.runner.activeCountOf(chatKey) > 0;
      deps.store.reset(chatKey);
      deps.logger.info('cmd', `chat=${chatKey} /new 会话重置${inFlight ? '（在飞回合继续收尾）' : ''}`);
      await sendChatMarkdown(deps.replyer, m, inFlight
        ? '会话已重置：下一条消息开始全新对话。当前在飞回合不受影响，其输出仍会送达。'
        : '会话已重置：下一条消息开始全新对话。');
      return;
    }
    // /stop
    if (deps.runner.activeCountOf(chatKey) === 0) {
      const depth0 = deps.queue.depthOf(chatKey);
      await sendChatMarkdown(deps.replyer, m, depth0 > 0
        ? `当前无在飞回合（队列中仍有 ${depth0} 条排队消息）。`
        : '当前无在飞回合。');
      return;
    }
    await sendChatMarkdown(deps.replyer, m, '正在中止当前回合…');
    const guardMs = deps.abortGuardMs ?? 7_000; // escalation 链自身有界；防御性上界防意外悬挂
    let timedOut = false;
    let guardTimer: ReturnType<typeof setTimeout> | null = null;
    let aborted = 0;
    await Promise.race([
      deps.runner.abortChat(chatKey, '用户 /stop').then((n) => { aborted = n; }),
      new Promise<void>((r) => { guardTimer = setTimeout(() => { timedOut = true; r(); }, guardMs); }),
    ]);
    if (guardTimer !== null) clearTimeout(guardTimer);
    const depth = deps.queue.depthOf(chatKey);
    if (timedOut) {
      // 诚实文案：超时意味着 escalation 链未按预期 settle——不谎报"已中止"（D13）
      deps.logger.error('cmd', `chat=${chatKey} /stop 中止未在 ${guardMs}ms 内完成（防御性超时先行返回）`);
      await sendChatMarkdown(deps.replyer, m, '中止指令已发出，但未在预期时间内确认完成（进程组升级终止仍在进行）。');
      return;
    }
    if (aborted === 0) {
      // "正在中止"发送窗口内回合自然完成——如实回复（不误报中止）
      deps.logger.info('cmd', `chat=${chatKey} /stop 时回合已自然结束（无需中止）`);
      await sendChatMarkdown(deps.replyer, m, '回合已自然结束，无需中止。');
      return;
    }
    deps.logger.info('cmd', `chat=${chatKey} /stop 中止完成（aborted=${aborted} 排队 ${depth}）`);
    await sendChatMarkdown(deps.replyer, m, depth > 0
      ? `已中止当前回合。队列中仍有 ${depth} 条排队消息，将依次执行。`
      : '已中止当前回合。');
  };
}
```

（拒绝文案属 dispatch 层（鉴权），本文件不定义——见 Task 6 `REJECT_TEXT`。）

- [x] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/unit/commands.test.ts` Expected: PASS
- [x] **Step 5: Commit** — `git add src/handlers/commands.ts tests/unit/commands.test.ts && git commit -m "feat(d3): /new /stop /status /help 四命令（哈希明细、stop 诚实超时、队列披露）"`

---

### Task 6: dispatch 层（AC1–AC4 主战场，含真实 executor 端到端）

**Files:**
- Create: `src/handlers/dispatch.ts`
- Test: `tests/unit/dispatch.test.ts`（新增）

注：本 task **不**改 agent-session（去重上收移至 Task 7 单提交切换，杜绝中间回归 HEAD——dispatch 上游占位与 agent 内部 Set 在过渡期并存且语义一致：上游先滤、内部 Set 永不触发）。

**Interfaces:**
- Consumes: `MsgIdDedupe`（Task 1）、`createAccessLoader/tierOf/isGroupAllowed`（Task 4）、`createCommandExecutor/parseCommand/sendChatMarkdown`（Task 5）、`stripLeadingMention`（question-bridge）、`SessionStore`/`TurnQueue`（真实实例，用于 e2e 用例）
- Produces: `createDispatchHandler(deps: DispatchDeps): MessageHandler`；`const REJECT_TEXT`

```ts
export interface DispatchDeps {
  dedupe: MsgIdDedupe;
  agent: MessageHandler;                                   // 既有 agent-session handler
  execute: (name: CommandName, m: InboundRobotMessage) => Promise<void>;
  loadAccess: () => AccessList;
  replyer: RobotReplyer;
  logger: Logger;
}
```

- [x] **Step 1: Write the failing test** — `tests/unit/dispatch.test.ts`：

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchHandler } from '../../src/handlers/dispatch.js';
import { createCommandExecutor } from '../../src/handlers/commands.js';
import { MsgIdDedupe } from '../../src/dedupe.js';
import { createAccessLoader } from '../../src/access.js';
import { SessionStore } from '../../src/agent/session-store.js';
import { TurnQueue } from '../../src/agent/turn-queue.js';
import type { InboundRobotMessage, MessageHandler } from '../../src/transport/types.js';

const quiet = { debug() {}, info() {}, warn: (_s: string, m: string) => { void m; }, error() {} } as const;
const loudWarns = () => { const w: string[] = []; return { warns: w, logger: { debug() {}, info() {}, warn: (_s: string, m: string) => w.push(m), error() {} } as const }; };

const p2p = (over: Partial<InboundRobotMessage> = {}): InboundRobotMessage => ({
  msgId: 'm1', conversationId: 'cidP', conversationKind: 'p2p', senderStaffId: 'st1', senderNick: '王',
  robotCode: 'rc', msgtype: 'text', textContent: '你好', sessionWebhook: null, raw: {}, ...over,
});
const grp = (over: Partial<InboundRobotMessage> = {}): InboundRobotMessage => ({
  msgId: 'g1', conversationId: 'cidG', conversationKind: 'group', senderStaffId: 'st9', senderNick: '群友',
  robotCode: 'rc', msgtype: 'text', textContent: '@bot 你好', sessionWebhook: null, raw: {}, ...over,
});

function makeHarness(list = { admin: ['st0'], approved: ['st1'], groups: ['cidG'] }) {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-disp-'));
  const file = join(dir, 'access.json');
  writeFileSync(file, JSON.stringify(list));
  const md: Array<{ kind: string; text: string }> = [];
  const agentMsgs: InboundRobotMessage[] = [];
  const cmds: string[] = [];
  const { warns, logger } = loudWarns();
  const replyer = {
    sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { md.push({ kind: 'oto', text }); },
    sendGroupMarkdown: async (_r: string, _c: string, _t: string, text: string) => { md.push({ kind: 'group', text }); },
  } as never;
  const agent: MessageHandler = async (m) => { agentMsgs.push(m); };
  const handler = createDispatchHandler({
    dedupe: new MsgIdDedupe(500), agent,
    execute: async (name) => { cmds.push(name); },
    loadAccess: createAccessLoader(file),
    replyer, logger: logger as never,
  });
  return { handler, md, agentMsgs, cmds, warns, file, replyer };
}

test('AC1: 四命令在 p2p 与群 @ 都被网关拦截，agent 零触达', async () => {
  const h = makeHarness();
  for (const c of ['/new', '/stop', '/status', '/help']) {
    await h.handler(p2p({ msgId: `p-${c}`, textContent: c }));
    await h.handler(grp({ msgId: `g-${c}`, textContent: `@bot ${c}` }));
  }
  expect(h.cmds).toHaveLength(8);
  expect(h.agentMsgs).toHaveLength(0);
});

test('AC1 e2e: dispatch × 真实 executor——四命令双端真实回复，runner/agent 零触达', async () => {
  const h = makeHarness();
  const md2: Array<{ kind: string; text: string }> = [];
  const replyer2 = {
    sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { md2.push({ kind: 'oto', text }); },
    sendGroupMarkdown: async (_r: string, _c: string, _t: string, text: string) => { md2.push({ kind: 'group', text }); },
  } as never;
  const store = new SessionStore({ sessionsDir: mkdtempSync(join(tmpdir(), 'dtb-disp3-')), ttlMs: 3_600_000 });
  const runnerCalls: string[] = [];
  const runner = { activeCountOf: () => 0, abortChat: async (c: string, r: string) => { runnerCalls.push(`${c}:${r}`); return 0; } };
  const queue = new TurnQueue({ maxPerChat: 10, logger: quiet as never });
  const execute = createCommandExecutor({ replyer: replyer2, store, queue, runner, loadAccess: createAccessLoader(h.file), status: () => null, logger: quiet as never } as never);
  const handler = createDispatchHandler({
    dedupe: new MsgIdDedupe(100),
    agent: async () => { throw new Error('agent 不应被触达'); },
    execute, loadAccess: createAccessLoader(h.file), replyer: replyer2, logger: quiet as never,
  });
  for (const c of ['/new', '/stop', '/status', '/help']) {
    await handler(p2p({ msgId: `e-${c}`, textContent: c }));
    await handler(grp({ msgId: `eg-${c}`, textContent: `@bot ${c}` }));
  }
  // md2 顺序（每命令先 p2p 后群）：0/1=/new，2/3=/stop，4/5=/status，6/7=/help
  expect(md2).toHaveLength(8);             // 四命令 × 双端，每条恰一回复
  expect(runnerCalls).toHaveLength(0);     // /stop 无在飞 → 不 abort；全程无回合
  expect(md2[6]!.text).toContain('/new');  // 第 7 条 = p2p /help（帮助文案列全命令）
  expect(md2[4]!.text).toContain('连接');  // 第 5 条 = p2p /status
  expect(md2[3]!.text).toContain('无在飞'); // 第 4 条 = group /stop
});

test('AC1: 命令大小写不敏感；带参不命中透传 agent', async () => {
  const h = makeHarness();
  await h.handler(p2p({ msgId: 'a1', textContent: '  /HELP ' }));
  await h.handler(grp({ msgId: 'a2', textContent: '@bot /Status' }));
  await h.handler(p2p({ msgId: 'a3', textContent: '/stop now' }));
  expect(h.cmds).toEqual(['help', 'status']);
  expect(h.agentMsgs).toHaveLength(1);            // 带参透传（D9）
});

test('AC2: 陌生 p2p 收到固定拒绝文本，agent/命令零触达；文案不泄露命令面', async () => {
  const h = makeHarness();
  await h.handler(p2p({ msgId: 's1', senderStaffId: 'stranger', textContent: '/help' }));
  expect(h.md).toHaveLength(1);
  expect(h.md[0]!.text).toContain('未授权');
  expect(h.md[0]!.text).not.toContain('/new');    // 不泄露命令面
  expect(h.agentMsgs).toHaveLength(0);
  expect(h.cmds).toHaveLength(0);
});

test('AC2+G2: access.json 损坏 → fail-closed：admin 也收拒绝文本', async () => {
  const h = makeHarness();
  writeFileSync(h.file, '{broken');               // 名单里有 st0——但文件坏了
  await h.handler(p2p({ msgId: 'b1', senderStaffId: 'st0', textContent: '/help' }));
  expect(h.md).toHaveLength(1);
  expect(h.md[0]!.text).toContain('未授权');
  expect(h.agentMsgs).toHaveLength(0);
});

test('AC3: 白名单群 @ 路由到 agent（原消息透传，@ 由 agent 层剥）', async () => {
  const h = makeHarness();
  await h.handler(grp({ msgId: 'w1' }));
  expect(h.agentMsgs).toHaveLength(1);
  expect(h.agentMsgs[0]!.conversationId).toBe('cidG');
  expect(h.md).toHaveLength(0);                   // 网关不回话
});

test('AC4: 非白名单群 @ 零回复 + 一条 warn 日志', async () => {
  const h = makeHarness();
  await h.handler(grp({ msgId: 'n1', conversationId: 'cidOther' }));
  expect(h.md).toHaveLength(0);
  expect(h.agentMsgs).toHaveLength(0);
  expect(h.cmds).toHaveLength(0);
  expect(h.warns.some((w) => w.includes('cidOther'))).toBe(true);
});

test('G5: 重复 msgId 静默丢弃；失败路径 release 后同 msgId 可重入', async () => {
  const h = makeHarness();
  await h.handler(p2p({ msgId: 'd1' }));
  await h.handler(p2p({ msgId: 'd1' }));          // 重推 → 丢弃
  expect(h.agentMsgs).toHaveLength(1);
  // 失败释放语义：拒绝回复发送失败 → 上抛 + release；同 msgId 重来（模拟 adapter 重试）不误判重复
  const dir = mkdtempSync(join(tmpdir(), 'dtb-disp2-'));
  const file = join(dir, 'access.json');
  writeFileSync(file, JSON.stringify({ admin: [], approved: [], groups: [] }));
  const boomReplyer = { sendOtoMarkdown: async () => { throw new Error('send fail'); }, sendGroupMarkdown: async () => {} } as never;
  const shared = new MsgIdDedupe(10);
  const handler2 = createDispatchHandler({
    dedupe: shared, agent: async () => {},
    execute: async () => {}, loadAccess: createAccessLoader(file), replyer: boomReplyer, logger: quiet as never,
  });
  await expect(handler2(p2p({ msgId: 'f1', senderStaffId: 'x' }))).rejects.toThrow('send fail');
  writeFileSync(file, JSON.stringify({ admin: [], approved: ['x'], groups: [] })); // 每消息读盘：修好名单
  let retried = false;
  const handler3 = createDispatchHandler({
    dedupe: shared, agent: async () => { retried = true; },
    execute: async () => {}, loadAccess: createAccessLoader(file), replyer: boomReplyer, logger: quiet as never,
  });
  await handler3(p2p({ msgId: 'f1', senderStaffId: 'x', textContent: 'hi' })); // 同 msgId 经修复后的链
  expect(retried).toBe(true);                     // release 已发生——未误判重复
});
```

- [x] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/dispatch.test.ts` Expected: FAIL（模块不存在）
- [x] **Step 3: Write the minimal implementation** — `src/handlers/dispatch.ts`：

```ts
import type { InboundRobotMessage, MessageHandler } from '../transport/types.js';
import type { RobotReplyer } from '../openapi/robot.js';
import type { MsgIdDedupe } from '../dedupe.js';
import type { AccessList } from '../access.js';
import { tierOf, isGroupAllowed } from '../access.js';
import { parseCommand, sendChatMarkdown, type CommandName } from './commands.js';
import { stripLeadingMention } from '../agent/question-bridge.js';
import type { Logger } from '../logger.js';

// 固定泛化拒绝文案（D2）：不含命令名、不含配置面信息——陌生者只知"不可用"。
export const REJECT_TEXT = '抱歉，你当前不在本机器人的使用名单内，无法使用。';

export interface DispatchDeps {
  dedupe: MsgIdDedupe;
  agent: MessageHandler;
  execute: (name: CommandName, m: InboundRobotMessage) => Promise<void>;
  loadAccess: () => AccessList;
  replyer: RobotReplyer;
  logger: Logger;
}

export function createDispatchHandler(deps: DispatchDeps): MessageHandler {
  return async (m) => {
    // G5：同步占位先于一切 await——单线程事件循环内服务端重推无竞态窗口
    if (!deps.dedupe.reserve(m.msgId)) {
      deps.logger.warn('dispatch', `重复 msgId=${m.msgId}，丢弃`);
      return;
    }
    try {
      if (m.conversationKind === 'p2p') {
        const list = deps.loadAccess();
        if (tierOf(list, m.senderStaffId) === 'unknown') {
          deps.logger.warn('access', `未授权 p2p staffId=${m.senderStaffId} msgId=${m.msgId}，已拒绝`);
          await sendChatMarkdown(deps.replyer, m, REJECT_TEXT); // 发送失败会上抛→release→重试
          return;
        }
      } else if (m.conversationKind === 'group') {
        const list = deps.loadAccess();
        if (!isGroupAllowed(list, m.conversationId)) {
          deps.logger.warn('access', `非白名单群 conversationId=${m.conversationId} @ 已忽略 msgId=${m.msgId}`); // AC4 日志行
          return; // 幂等（仅日志），占位保留
        }
      }
      // 命令解析：群消息用剥 @ 副本（agent 层对原消息自行剥离，互不影响）
      const cmd = m.textContent !== null
        ? parseCommand(m.conversationKind === 'group' ? stripLeadingMention(m.textContent) : m.textContent)
        : null;
      if (cmd !== null) { await deps.execute(cmd, m); return; } // AC1：命令止步于此
      await deps.agent(m); // 普通消息（含未知 /xxx 透传，D9）进 agent 会话
    } catch (err) {
      deps.dedupe.release(m.msgId); // 失败撤销占位——adapter 局部重试可重入（G1）
      throw err;
    }
  };
}
```

- [x] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/unit/dispatch.test.ts` Expected: PASS
- [x] **Step 5: Commit** — `git add src/handlers/dispatch.ts tests/unit/dispatch.test.ts && git commit -m "feat(d3): dispatch 层——鉴权/群白名单/命令拦截（AC1-AC4，含真实 executor e2e）"`

**Checkpoint A（Task 1–6 完成后）**：`bun install && bun run typecheck && bun test` 全绿（此阶段 agent-session 仍带内部去重——与上游占位并存无冲突，Task 7 单提交上收）。

---

### Task 7: 装配切换（单提交）+ 去重上收 + 真实装配测试 + 措辞收口

**Files:**
- Modify: `src/gateway.ts`（snapshot 存字段 + `get lastState()`）
- Modify: `src/commands/run.ts`（dedupe/accessLoader/executor/dispatch 装配；bypass warn 措辞）
- Modify: `src/handlers/agent-session.ts`（删内部 Set/`rememberMsgId`/`MSGID_DEDUPE_CAP` 与三处调用）
- Modify: `src/config.ts:90`（DEFAULT_ACCESS 注释）
- Test: `tests/integration/run.test.ts`（追加真实装配用例，非占位）
- Test: `tests/unit/agent-session.test.ts`（追加 /new 竞态集成用例 + 迁移既有去重断言）

**Interfaces:**
- Consumes: Task 1/4/5/6 全部 Produces；`RunOverrides.depsOverrides`（既有，注入 replyer/runner 观测装配线——注意 dispatch/commands 必须取 `handlerDeps.replyer/runner`（含 override），不得用局部真实实例）
- Produces: 生产装配完成（dispatch 为唯一 handler）；`Gateway.lastState: ConnectionStateSnapshot | null`

- [x] **Step 1: Write the failing test** — 追加到 `tests/integration/run.test.ts`（复用其既有 `P2P_PAYLOAD`/`noExit`/`runCommand`+`FakeDwClient` 模式）：

```ts
// ---- D3（issue #3）：dispatch 装配线 ----
import { writeFileSync } from 'node:fs';
import type { RobotReplyer } from '../../src/openapi/robot.js';

test('runCommand D3: dispatch 装配——/help 网关应答、陌生 p2p 拒绝、runner 零触达；白名单消息仍达 runner（AC1/AC2 装配面）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-run5-'));
  const paths = bootstrapWorkspace(ws);
  saveBotEnv(paths.botDir, { clientId: 'ck', clientSecret: 'cs' });
  writeFileSync(paths.accessFile, JSON.stringify({ admin: [], approved: ['st1'], groups: [] }));
  const prompts: string[] = [];
  const fakeRunner = {
    run: async (req: TurnRequest): Promise<TurnResult> => {
      prompts.push(req.prompt);
      return { ok: true, outputText: '回合输出', errorText: '', durationMs: 1 };
    },
    killAll: () => {},
  } as unknown as ClaudeRunner;
  const md: Array<{ kind: string; text: string }> = [];
  const replyer = {
    sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { md.push({ kind: 'oto', text }); },
    sendGroupMarkdown: async (_r: string, _c: string, _t: string, text: string) => { md.push({ kind: 'group', text }); },
  } as unknown as RobotReplyer;
  const client = new FakeDwClient();
  await runCommand(ws, {
    transportFactory: (opts) => new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client }),
    depsOverrides: { runner: fakeRunner, replyer },
  }, noExit);
  client.emitRobotMessage({ ...P2P_PAYLOAD, msgId: 'h1', text: { content: '/help' } });            // 命令
  client.emitRobotMessage({ ...P2P_PAYLOAD, msgId: 'h2', senderStaffId: 'stranger', text: { content: '你好' } }); // 陌生
  client.emitRobotMessage({ ...P2P_PAYLOAD, msgId: 'h3', text: { content: '正常消息' } });          // 白名单普通消息
  await new Promise((r) => setTimeout(r, 150));
  expect(prompts).toHaveLength(1);                    // 只有普通消息触达 runner
  expect(prompts[0]).toContain('[Context: sender=n, staffId=st1, chat=c1 (p2p)]');
  expect(md).toHaveLength(3);                         // help 文案 / 拒绝 / 回合 markdown（模板空→回退）
  expect(md[0]!.text).toContain('/new');              // 帮助文案
  expect(md[1]!.text).toContain('未授权');            // 拒绝文本
  expect(md[2]!.text).toContain('回合输出');          // 正常回合仍完整走 D2 链路
});
```

- [x] **Step 2: Write the Gateway.lastState failing test** — 追加到 `tests/unit/gateway.test.ts`（复用其既有 fake transport 夹具）：

```ts
test('gateway D3: lastState 随 snapshot 更新——/status 的真实数据源（D6）', async () => {
  // 复用该文件既有 fake transport（onStateChange 触发）构造 Gateway：
  // 1) 构造后 lastState === null
  // 2) transport 触发 onStateChange('connected', '已连接并订阅')
  // 3) 断言 gateway.lastState 匹配 { transport: 'connected', detail: '已连接并订阅', pid, startedAt }
  // （按该文件既有 fake 夹具落地，断言面如上三条）
});
```

- [x] **Step 3: Migrate 既有去重断言** — `tests/unit/agent-session.test.ts` 中依赖内部 Set 的"重复 msgId 丢弃"类用例：删除（等价覆盖已在 `dispatch.test.ts` G5 用例——重复丢弃 + 失败 release 重入；G3 对账竞态用例已在 Task 2 落地）；其余用例全保留。
- [x] **Step 4: Run it and verify it FAILS（装配用例）** — Run: `bun test tests/integration/run.test.ts tests/unit/gateway.test.ts` Expected: FAIL（run 装配：/help 直达 agent、陌生消息进 runner、md 无 '未授权'；gateway：`lastState` 不是 getter/未更新）
- [x] **Step 5: Write the minimal implementation（本 task 全部改动一次提交）**

`src/gateway.ts`：

```ts
// 类内新增字段与 getter（snapshot() 里同步赋值）：
private lastSnap: ConnectionStateSnapshot | null = null;
get lastState(): ConnectionStateSnapshot | null { return this.lastSnap; }
// snapshot() 内 snap 构造后：this.lastSnap = snap;
```

`src/commands/run.ts`（装配段替换——dispatch/commands 一律取 `handlerDeps.*` 以吃到 depsOverrides）：

```ts
import { MsgIdDedupe } from '../dedupe.js';
import { createAccessLoader } from '../access.js';
import { createCommandExecutor } from '../handlers/commands.js';
import { createDispatchHandler } from '../handlers/dispatch.js';
// …
const accessLoader = createAccessLoader(paths.accessFile, logger);
const handlerDeps: AgentHandlerDeps = { …原样（含 ...overrides.depsOverrides）… };
const effectiveRunner = handlerDeps.runner;
const effectiveQueue = handlerDeps.queue;
const agent = createAgentSessionHandler(handlerDeps);
let gatewayRef: Gateway | null = null;
const execute = createCommandExecutor({
  replyer: handlerDeps.replyer, store: handlerDeps.store, queue: handlerDeps.queue,
  runner: handlerDeps.runner, loadAccess: accessLoader,
  status: () => gatewayRef?.lastState ?? null, logger,
});
const handler = createDispatchHandler({
  dedupe: new MsgIdDedupe(500), agent, execute,
  loadAccess: accessLoader, replyer: handlerDeps.replyer, logger,
});
const gateway = new Gateway({ transport, logger, stateFile: paths.stateFile, pid, startedAt, handler });
gatewayRef = gateway;
```

`src/handlers/agent-session.ts`：删除 `MSGID_DEDUPE_CAP`、`seenMsgIds`、`rememberMsgId` 与三处调用（busy/help/入队路径）——去重职责整体上收 dispatch（上游 reserve、失败 release）。

`src/commands/run.ts` bypass warn 措辞（D12——风险不弱化，只换暴露面描述）：

```ts
logger.warn('run', 'agent 以 bypassPermissions 运行（无头全权限）；暴露面 = access.json 白名单（admin/approved/群白名单）全体成员，请确保名单与群成员受控');
```

`src/config.ts:90` 注释更新：

```ts
const DEFAULT_ACCESS = { admin: [], approved: [], groups: [] }; // D3 起生效：admin∪approved=p2p 白名单，groups=openConversationId 白名单；手工编辑、每消息读盘
```

- [x] **Step 6: Run it and verify it PASSES** — Run: `bun install && bun run typecheck && bun test` Expected: 全绿（含既有 run/agent-session/gateway 全部用例——去重上收与迁移后无回归）
- [x] **Step 7: Commit（单提交完成切换）** — `git add src/gateway.ts src/commands/run.ts src/handlers/agent-session.ts src/config.ts tests/integration/run.test.ts tests/unit/gateway.test.ts tests/unit/agent-session.test.ts && git commit -m "feat(d3): run 装配 dispatch 管线 + 去重上收单提交切换（Gateway.lastState/warn 措辞）"``

**Checkpoint B（Task 7 完成后）**：生产链路 dispatch 化；`bun run build` 冒烟可编译。

---

### Task 8: SPEC.md D3 节 + CHANGELOG + live-smoke runbook（不带 CI-verified）

**Files:**
- Modify: `SPEC.md`（新增 "Commands / Access（D3 契约）" 节 + `.bot/` 布局节 access.json 行更新）
- Modify: `CHANGELOG.md`
- Create: `docs/issues/3/live-smoke.md`

**Interfaces:** 无代码接口；文档契约与 D1/D2 节格式对齐。**G8：本 task 一律不写 `CI-verified` 标注**（Task 9 门禁全绿后回填）。

- [x] **Step 1: SPEC.md 新增节**（置于 "AI 卡回复" 与 "配置" 节之间）：

```md
## Commands / Access（D3 契约）

- 处理顺序：msgId 去重（同步占位/失败释放）→ p2p 鉴权 → 群白名单 → 命令解析 → agent 委派；access 加载/解析异常 fail-closed 映射为正常回复（不上抛），其余处理失败（含回复发送失败）照旧上抛由 transport 有界重试（≤3 次/50s 预算，占位已释放可重入）。
- 命令：`/new`（reset 会话——epoch 代际防在飞/排队回合复活旧 id；在飞回合不杀）、`/stop`（仅杀该 chat 在飞回合，TERM→5s→KILL；不清排队，确认文案披露队列深度；防御性超时诚实文案；无在飞回提示）、`/status`（p2p：连接+uptime+会话哈希明细+admin/approved 名单；群：仅概览与计数——明细/名单不向全群广播）、`/help`。剥 @ 后 trim、大小写不敏感、精确匹配、无参数；未知 `/xxx` 透传 agent 当普通消息。
- 访问：`.bot/access.json` `{admin,approved,groups}`（手工编辑，每消息读盘，ENOENT 单次重试容忍原子替换，解析失败响亮限频 warn 后 fail-closed 全拒含 admin——修文件即恢复）；p2p 按 `senderStaffId` ∈ admin∪approved 放行，admin v1 仅信息性；陌生 p2p 收固定泛化拒绝文本（不泄露命令面/配置面），不 spawn 会话。
- 群策略：仅 `openConversationId` ∈ groups 白名单的群内 @ 被处理（任意成员——群授权=owner 拉群；群成员治理是 owner 责任，此为明示信任边界）；非白名单群 @ 零回复 + 一条 warn 日志。
- live 验证清单：真实群里 @ 触发四命令；管理员外同事 p2p 收到拒绝；把群加入/移出 groups 的即时生效；/new 长回合中重置；/stop 长回合中止与卡终止态。
```

`.bot/` 布局节 `access.json` 行改为：`access.json`（D3 生效：`{admin,approved,groups}` 白名单，每消息读盘）。
- [x] **Step 2: CHANGELOG.md**（Unreleased 波次条目，格式对齐既有条目）：

```md
- D3 命令/访问/群策略：`/new` `/stop` `/status` `/help` 网关拦截（永不到达 agent）；`access.json`（admin/approved/groups）手工白名单，陌生 p2p 明确拒绝；非白名单群 @ 静默留日志；群内 `/status` 脱敏为计数（破坏性变更：此前任何可见者均可驱动 agent，现在未列入 access.json 的 p2p 发送者与群不再获得响应）。
```

- [x] **Step 3: `docs/issues/3/live-smoke.md` runbook**（真实环境验证步骤，供 owner 执行）：access.json 配置样例、四命令 p2p/群双端用例矩阵（AC1–AC4 的 S8–S12/S3）、access.json 手改即时生效与 typo 自锁恢复、/new 在飞竞态手工用例（长回合中 /new）、/stop 长回合中止与卡终止态观察、群移出白名单后 @ 静默验证。
- [x] **Step 4: Verify** — Run: `grep -c "D3 契约" SPEC.md && ! grep -c "CI-verified" <(sed -n '/Commands \/ Access/,/^## /p' SPEC.md)` Expected: `1` 且 D3 节内 0 处 CI-verified（门禁后才回填）
- [x] **Step 5: Commit** — `git add SPEC.md CHANGELOG.md docs/issues/3/live-smoke.md && git commit -m "docs(d3): SPEC D3 契约节（未标 CI-verified）+ CHANGELOG + live-smoke runbook"`

---

### Task 9: 全量门禁 + CI-verified 回填 + AC 追溯收口

**Files:**
- Modify: `SPEC.md`（D3 节回填 `CI-verified` 标注）
- 验证 `docs/issues/3/plan.md` checkbox 与实际状态一致

- [x] **Step 1: 安装与门禁**（G7）— Run: `bun install && bun run typecheck && bun test` Expected: typecheck 零错误、全部测试 PASS
- [x] **Step 2: 构建冒烟** — Run: `bun run build && bun run check:dist` Expected: PASS
- [x] **Step 3: SPEC 回填** — 门禁全绿后，在 SPEC.md D3 节各契约条目句尾追加 `（CI-verified）`（对照 D1/D2 节标注样式；live 项保持"live 验证清单"措辞不标）
- [x] **Step 4: AC 追溯核对**（逐条对照测试名）：
  - AC1 → `dispatch.test.ts` "四命令在 p2p 与群 @ 都被网关拦截" + "AC1 e2e: dispatch × 真实 executor" + `commands.test.ts` 四命令行为用例 + `run.test.ts` "dispatch 装配" ✓
  - AC2 → `dispatch.test.ts` "陌生 p2p 收到固定拒绝文本" + "access.json 损坏 → admin 也拒" ✓
  - AC3 → `dispatch.test.ts` "白名单群 @ 路由到 agent" ✓
  - AC4 → `dispatch.test.ts` "非白名单群 @ 零回复 + warn" ✓
  - G3 对账竞态 → `agent-session.test.ts` "D3 /new 竞态" 集成用例（Task 2 落地——在飞与排队消息跨 reset 后 `store.load` 为 null、后续消息 resume=false）✓
- [x] **Step 5: Commit** — `git add SPEC.md docs/issues/3 && git commit -m "docs(d3): 门禁全绿后回填 CI-verified + AC 追溯收口"`

（/new 竞态集成用例已在 Task 7 Step 2 落地，此处仅追溯核对。）

---

## 风险与缓解（高风险前置说明）

- **最高风险 = Task 7 装配切换**（动生产消息主路径 + 去重上收）：全部基础件与 dispatch 测试（Task 1–6）先行就绪；切换在**单提交**内完成（wire + 上收 + 真实装配测试同落），无中间回归 HEAD；既有 agent-session 用例全保留作回归网。
- **/new 竞态（G3）**：epoch 方案三层覆盖——store 单元（在飞 persist 跳过/牵连隔离/空会话幂等）、agent-session 集成（对账路径跨 reset）、dispatch e2e（/new 命令实效）。
- **/stop 有界性**：escalation 链自带 killDelay 上界 + 命令层防御性 race（超时诚实文案，测试覆盖悬挂分支）；runner 索引 settle 后清零防泄漏。
- **测试并发注意**：runner abortChat 测试需两个独立 FakeChild（spawnFn 按调用序派发），单 child 复用会串流；run.test.ts 装配用例的异步等待沿用该文件既有的 150ms settle 模式。
- **/status 隐私面**：会话明细只出哈希（文件名 16hex）；群内仅计数——测试双向断言（p2p 不含原始 chatKey、群不含名单/明细）。
