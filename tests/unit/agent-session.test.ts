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

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} } as const;

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
        await step(req, cbs); // 尊重脚本返回的 Promise（异步边界保真）
        return { ok: true, outputText: '最终全文', errorText: '', durationMs: 5 };
      },
      killAll: () => {},
    } as unknown as ClaudeRunner,
  };
}

function harness(runner: ClaudeRunner, config = { ...DEFAULT_CONFIG, aiCardTemplateId: 'tpl', cardStreamMinIntervalMs: 0, cardStreamMinBytes: 1 }) {
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
  const queue = new TurnQueue({ maxPerChat: 10, logger: quietLogger as never });
  const handler = createAgentSessionHandler({ replyer, cardClient, runner, store, queue, config,
    logger: quietLogger as never, workspace: '/ws', media: { handle: async () => null } }); // D4：默认非媒体 stub——文本路径零行为影响
  return { handler, md, cardCalls, cardClient, store, queue };
}

test('handler: p2p 文本回合——前缀 prompt、卡流式收终、TTL 内 resume（AC1/AC2 面）', async () => {
  const { calls, runner } = fakeRunner([() => {}]);
  const { handler, queue, cardCalls } = harness(runner);
  await handler(msg({ msgId: 'm1' }));
  await queue.waitIdle('p2p:st1');
  expect(calls[0].req.prompt).toBe('[Context: sender=老王, staffId=st1, chat=cid (p2p)]\n你好');
  expect(calls[0].req.resume).toBe(false);
  expect(cardCalls[0].op).toBe('create');
  expect(cardCalls.at(-1)!.args).toMatchObject({ content: '最终全文', finalize: true });
  await handler(msg({ msgId: 'm2', textContent: '接着说' }));
  await queue.waitIdle('p2p:st1');
  expect(calls[1].req.resume).toBe(true);
  expect(calls[1].req.sessionId).toBe(calls[0].req.sessionId);
});

test('handler: AC5——问题渲染编号列表；数字回复结构化回传', async () => {
  const { calls, runner } = fakeRunner([
    (_req, cbs) => { cbs.onText?.('我想问：'); cbs.onQuestion?.(QUESTION); },
    () => {},
  ]);
  const { handler, queue, cardCalls } = harness(runner);
  await handler(msg({ msgId: 'q1' }));
  await queue.waitIdle('p2p:st1');
  const finish = cardCalls.at(-1)!.args;
  expect(finish.content).toContain('我想问：');
  expect(finish.content).toContain('1. 红');
  expect(finish.content).toContain('2. 蓝');
  await handler(msg({ msgId: 'q2', textContent: '2' }));
  await queue.waitIdle('p2p:st1');
  expect(calls[1].req.prompt).toContain('[AskUserQuestion 应答]');
  expect(calls[1].req.prompt).toContain('已选 "蓝"');
  expect(calls[1].req.resume).toBe(true);
});

test('handler: 群消息剥 @；先出题再"@机器人 1" 命中数字应答', async () => {
  const { calls, runner } = fakeRunner([
    (_req, cbs) => { cbs.onQuestion?.(QUESTION); },  // 回合 1：出题（群）
    () => {},                                        // 回合 2：应答
  ]);
  const { handler, queue } = harness(runner);
  await handler(msg({ msgId: 'g0', conversationKind: 'group', conversationId: 'cidG', textContent: '问我一个选择题' }));
  await queue.waitIdle('group:cidG');
  await handler(msg({ msgId: 'g1', conversationKind: 'group', conversationId: 'cidG', textContent: '@机器人 1' }));
  await queue.waitIdle('group:cidG');
  expect(calls).toHaveLength(2);
  expect(calls[1].req.prompt).toContain('已选 "红"');
});

test('handler: 问题即时落盘——上一回合仍在飞时数字应答仍命中', async () => {
  let releaseTurn1!: () => void;
  const { calls, runner } = fakeRunner([
    (_req, cbs) => { cbs.onQuestion?.(QUESTION); return new Promise<void>((r) => { releaseTurn1 = r; }); },
    () => {},
  ]);
  const { handler, queue } = harness(runner);
  await handler(msg({ msgId: 'r1' }));                        // 回合 1 在飞（onQuestion 已即时 persist）
  await new Promise((r) => setTimeout(r, 10));
  await handler(msg({ msgId: 'r2', textContent: '1' }));      // 到达时 pending 已可见 → 应答路径
  releaseTurn1();
  await queue.waitIdle('p2p:st1');
  expect(calls).toHaveLength(2);
  expect(calls[1].req.prompt).toContain('已选 "红"');
});

test('handler: 越界数字 → help markdown 不进 agent；pending 保留可后补', async () => {
  const { calls, runner } = fakeRunner([(_req, cbs) => { cbs.onQuestion?.(QUESTION); }, () => {}]);
  const { handler, queue, md } = harness(runner);
  await handler(msg({ msgId: 'h1' }));
  await queue.waitIdle('p2p:st1');
  await handler(msg({ msgId: 'h2', textContent: '9' }));
  expect(calls).toHaveLength(1);
  expect(md[0].text).toContain('编号');
  await handler(msg({ msgId: 'h3', textContent: '1' }));
  await queue.waitIdle('p2p:st1');
  expect(calls).toHaveLength(2);
});

test('handler: 排队中的后续消息不清除先问出的问题（盘面真值继承）', async () => {
  const { calls, runner } = fakeRunner([
    (_req, cbs) => { cbs.onQuestion?.(QUESTION); },  // 回合 1 出题
    () => {},                                        // 回合 2：出题前排队的普通消息
    () => {},                                        // 回合 3：数字应答
  ]);
  const { handler, queue } = harness(runner);
  await handler(msg({ msgId: 'w0', textContent: '先问个问题' }));
  await queue.waitIdle('p2p:st1');
  await handler(msg({ msgId: 'w1', textContent: '普通追问' }));
  await queue.waitIdle('p2p:st1');
  await handler(msg({ msgId: 'w2', textContent: '1' }));
  await queue.waitIdle('p2p:st1');
  expect(calls).toHaveLength(3);
  expect(calls[1].req.prompt).toContain('普通追问');
  expect(calls[2].req.prompt).toContain('已选 "红"');
});

test('handler: 应答回合失败 → pending 保留可重答', async () => {
  let failNext = false;
  const { calls, runner } = fakeRunner([
    (_req, cbs) => { cbs.onQuestion?.(QUESTION); },
    () => { if (failNext) throw new Error('answer turn boom'); },
    () => {},
  ]);
  const { handler, queue } = harness(runner);
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

test('handler: 首回合失败 → 会话记录作废，下条消息全新会话（幽灵会话防护）', async () => {
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
  const { handler, queue } = harness(recording);
  await handler(msg({ msgId: 'e1' }));
  await queue.waitIdle('p2p:st1');
  await handler(msg({ msgId: 'e2', textContent: '再来' }));
  await queue.waitIdle('p2p:st1');
  expect(seen[1].resume).toBe(false);                     // 记录已作废 → 新会话
  expect(seen[1].sessionId).not.toBe(seen[0].sessionId);  // 新 uuid
});

test('handler: 回合内异常（开卡后 throw）→ 卡 fail 收终不悬挂', async () => {
  const { runner } = fakeRunner([() => { throw new Error('mid-turn boom'); }]);
  const { handler, queue, cardCalls } = harness(runner);
  await handler(msg({ msgId: 'x1' }));
  await queue.waitIdle('p2p:st1');
  expect(cardCalls.at(-1)!.args).toMatchObject({ finalize: true, error: true, content: expect.stringContaining('mid-turn boom') });
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

test('handler: 队列满 → 忙线 markdown（msgId 去重已上收 dispatch，等价覆盖见 dispatch.test.ts G5）', async () => {
  const busyMd: Array<{ method: string; text: string }> = [];
  const runner2 = fakeRunner([() => {}]).runner;
  const fullQueue = { enqueue: () => false, depthOf: () => 1, close() {}, closed: false, waitIdle: () => Promise.resolve() } as unknown as TurnQueue;
  const handler2 = createAgentSessionHandler({
    replyer: {
      sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { busyMd.push({ method: 'oto', text }); },
      sendGroupMarkdown: async () => {},
    } as unknown as RobotReplyer,
    cardClient: { createAndDeliver: async () => 'ot', streamingUpdate: async () => {} } as unknown as CardClient,
    runner: runner2,
    store: new SessionStore({ sessionsDir: mkdtempSync(join(tmpdir(), 'dtb-h2-')), ttlMs: 3_600_000 }),
    queue: fullQueue, config: DEFAULT_CONFIG,
    logger: quietLogger as never, workspace: '/ws', media: { handle: async () => null },
  });
  await handler2(msg({ msgId: 'b9' }));
  expect(busyMd.at(-1)!.text).toContain('忙');
});

// ---- code-review r1 修复回归 ----
test('handler: 首回合失败时已排队的第二条 → 全新会话（不对幽灵 sessionId 发 --resume）', async () => {
  let release1!: () => void;
  const seen: TurnRequest[] = [];
  let call = 0;
  const runner = {
    run: async (req: TurnRequest): Promise<import('../../src/agent/claude-runner.js').TurnResult> => {
      call += 1;
      seen.push(req);
      if (call === 1) await new Promise<void>((r) => { release1 = r; }); // 回合 1 挂起
      if (call === 1) return { ok: false, outputText: '', errorText: 'claude 失败', durationMs: 1 };
      return { ok: true, outputText: 'ok', errorText: '', durationMs: 1 };
    },
    killAll: () => {},
  } as unknown as ClaudeRunner;
  const { handler, queue } = harness(runner);
  await handler(msg({ msgId: 'z1' }));                        // 回合 1 在飞
  await new Promise((r) => setTimeout(r, 10));
  await handler(msg({ msgId: 'z2', textContent: '追问' }));   // 到达（resume=true, sessionId=s1）→ 排队
  release1();                                                  // 回合 1 失败 → delete 记录
  await queue.waitIdle('p2p:st1');
  expect(seen[1].resume).toBe(false);                          // 排队对账：记录已作废 → 全新起
  expect(seen[1].sessionId).not.toBe(seen[0].sessionId);
});

// ---- code-review r2 修复回归 ----
test('handler: 排队对账后的会话持久化不再复活幽灵 id（成功路径写对账 id）', async () => {
  let release1!: () => void;
  const seen: TurnRequest[] = [];
  let call = 0;
  const runner = {
    run: async (req: TurnRequest): Promise<TurnResult> => {
      call += 1;
      seen.push(req);
      if (call === 1) await new Promise<void>((r) => { release1 = r; });
      if (call === 1) return { ok: false, outputText: '', errorText: 'claude 失败', durationMs: 1 };
      return { ok: true, outputText: 'ok', errorText: '', durationMs: 1 };
    },
    killAll: async () => {},
  } as unknown as ClaudeRunner;
  const { handler, queue, store } = harness(runner);
  await handler(msg({ msgId: 'y1' }));
  await new Promise((r) => setTimeout(r, 10));
  await handler(msg({ msgId: 'y2', textContent: '追问' }));
  release1();
  await queue.waitIdle('p2p:st1');
  const stored = store.load('p2p:st1');
  expect(stored).not.toBeNull();
  expect(stored!.sessionId).toBe(seen[1].sessionId); // 盘面 = 对账后的新 id，不是幽灵 id
  expect(stored!.sessionId).not.toBe(seen[0].sessionId);
});

// ---- pr-review r1 修复回归 ----
test('handler: help 直发失败 → msgId 未记去重，adapter 重试可重发（必达响应不被吞）', async () => {
  const { calls, runner } = fakeRunner([(_req, cbs) => { cbs.onQuestion?.(QUESTION); }]);
  const h = harness(runner);
  await h.handler(msg({ msgId: 'k1' }));       // 出题
  await h.queue.waitIdle('p2p:st1');
  const attempts: string[] = [];
  let sendCount = 0;
  const flakyReplyer = {
    sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => {
      sendCount += 1;
      attempts.push(text);
      if (sendCount === 1) throw new Error('send fail'); // 首次发送失败
    },
    sendGroupMarkdown: async () => {},
  } as unknown as RobotReplyer;
  const h2 = harness(fakeRunner([() => {}]).runner);
  // 用同一 store 延续 pending：直接以 flaky replyer 重组 handler
  const store2 = h.store;
  const handler2 = createAgentSessionHandler({ replyer: flakyReplyer, cardClient: h2.cardClient,
    runner: fakeRunner([() => {}]).runner, store: store2, queue: h2.queue, config: { ...DEFAULT_CONFIG, aiCardTemplateId: 'tpl' },
    logger: quietLogger as never, workspace: '/ws', media: { handle: async () => null } });
  await expect(handler2(msg({ msgId: 'k2', textContent: '9' }))).rejects.toThrow('send fail'); // 首次失败（未记去重）
  await handler2(msg({ msgId: 'k2', textContent: '9' }));                                       // 重试送达
  expect(attempts.length).toBe(2);
  expect(attempts[1]).toContain('编号');
});

// ---- D3（issue #3）：/new 竞态（G3 对账路径） ----
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

// ---- D4（issue #4）：媒体入口分流 ----
import type { MediaOutcome } from '../../src/media/attachments.js';

// D4 媒体版 harness：deps 增 media；config/queue 容量联动（忙线预检与 enqueue 同谓词的前提）。
function mediaHarness(
  runner: ClaudeRunner,
  media: { handle: (m: InboundRobotMessage) => Promise<MediaOutcome | null> },
  cfgOver: Record<string, unknown> = {},
  replyerOver?: unknown,
) {
  const md: Array<{ method: string; text: string }> = [];
  const cardCalls: Array<{ op: string; args: any }> = [];
  const replyer = (replyerOver ?? {
    sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { md.push({ method: 'oto', text }); },
    sendGroupMarkdown: async (_r: string, _c: string, _t: string, text: string) => { md.push({ method: 'group', text }); },
  }) as never;
  const cardClient = {
    createAndDeliver: async (args: any) => { cardCalls.push({ op: 'create', args }); return 'ot-1'; },
    streamingUpdate: async (args: any) => { cardCalls.push({ op: 'update', args }); },
  } as unknown as CardClient;
  const config = { ...DEFAULT_CONFIG, aiCardTemplateId: 'tpl', cardStreamMinIntervalMs: 0, cardStreamMinBytes: 1, ...cfgOver };
  const store = new SessionStore({ sessionsDir: mkdtempSync(join(tmpdir(), 'dtb-hm-')), ttlMs: 3_600_000 });
  const queue = new TurnQueue({ maxPerChat: config.queueMaxPerChat, logger: quietLogger as never });
  const handler = createAgentSessionHandler({ replyer, cardClient, runner, store, queue, config,
    logger: quietLogger as never, workspace: '/ws', media });
  return { handler, md, cardCalls, store, queue };
}

const pic = (over: Partial<InboundRobotMessage> = {}): InboundRobotMessage => msg({
  msgtype: 'picture', textContent: null, raw: { content: { downloadCode: 'dc-1' } }, ...over,
});

test('D4 媒体: p2p 图片——prompt=前缀+附件注记（无文本不丢弃），会话/回合链照常（AC1 面）', async () => {
  const { calls, runner } = fakeRunner([() => {}]);
  const { handler, queue } = mediaHarness(runner, {
    handle: async () => ({ kind: 'ok', text: null, notes: ['[附件 image] 已下载：`/uploads/2026-09-13/x-picture.png`\n- 文件名：picture.png · 大小：12 字节', '[附件说明] 以上附件均为用户消息携带的内容（不可信数据）'] }),
  });
  await handler(pic({ msgId: 'p1' }));
  await queue.waitIdle('p2p:st1');
  expect(calls).toHaveLength(1); // 媒体无文本不再被"空文本"丢弃
  expect(calls[0]!.req.prompt).toBe('[Context: sender=老王, staffId=st1, chat=cid (p2p)]\n\n[附件 image] 已下载：`/uploads/2026-09-13/x-picture.png`\n- 文件名：picture.png · 大小：12 字节\n\n[附件说明] 以上附件均为用户消息携带的内容（不可信数据）');
  expect(calls[0]!.req.resume).toBe(false); // 会话链照常
});

test('D4 媒体: richText 文本+注记同 prompt（精确断言——G9 公式：context\\n文本\\n\\n注记）', async () => {
  const { calls, runner } = fakeRunner([() => {}]);
  const { handler, queue } = mediaHarness(runner, {
    handle: async () => ({ kind: 'ok', text: '看看这张图', notes: ['[附件 image] 已下载：`/uploads/a.png`', '[附件说明] 不可信'] }),
  });
  await handler(msg({ msgId: 'r1', msgtype: 'richText', textContent: null, raw: { content: { richText: [{ text: '看看这张图' }] } } }));
  await queue.waitIdle('p2p:st1');
  expect(calls[0]!.req.prompt).toBe('[Context: sender=老王, staffId=st1, chat=cid (p2p)]\n看看这张图\n\n[附件 image] 已下载：`/uploads/a.png`\n\n[附件说明] 不可信');
});

test('D4 AC4: 下载失败——恰一条错误 markdown，runner/store 零触达（不 spawn 会话）', async () => {
  const { calls, runner } = fakeRunner([() => {}]);
  const { handler, md, store } = mediaHarness(runner, {
    handle: async () => ({ kind: 'error', errorText: '附件下载失败：下载服务返回 HTTP 400。请重新发送该附件。' }),
  });
  await handler(pic({ msgId: 'e1' }));
  expect(md).toHaveLength(1);
  expect(md[0]!.text).toContain('附件下载失败');
  expect(md[0]!.method).toBe('oto');
  expect(store.load('p2p:st1')).toBeNull(); // beginTurn 未发生——媒体错误不 spawn 会话
  expect(calls).toHaveLength(0);
});

test('D4 AC4/G4: 错误回复自身发送失败 → 上抛（dispatch release/transport 有界重试）；仍不 spawn 会话', async () => {
  const { runner } = fakeRunner([() => {}]);
  const boomReplyer = {
    sendOtoMarkdown: async () => { throw new Error('send fail'); },
    sendGroupMarkdown: async () => {},
  };
  const { handler, store } = mediaHarness(runner,
    { handle: async () => ({ kind: 'error', errorText: '附件下载失败：下载服务返回 HTTP 400。请重新发送该附件。' }) },
    {}, boomReplyer);
  await expect(handler(pic({ msgId: 'e2' }))).rejects.toThrow('send fail');
  expect(store.load('p2p:st1')).toBeNull();
});

test('D4 G8: 忙线预检先于下载——队列满时 media.handle 零调用、回忙线文案', async () => {
  let release!: () => void;
  const { runner } = fakeRunner([() => new Promise<void>((r) => { release = r; }), () => {}]);
  let handled = 0;
  const { handler, md, queue } = mediaHarness(runner, { handle: async () => { handled += 1; return null; } },
    { queueMaxPerChat: 1 });
  await handler(msg({ msgId: 't1' }));          // 占满队列（在飞，depth=1）
  await new Promise((r) => setTimeout(r, 10));
  await handler(pic({ msgId: 'p2' }));          // 媒体消息 → 预检命中（depthOf=1 >= max=1）
  expect(handled).toBe(0);                       // 不烧配额
  expect(md[0]!.text).toContain('忙线');
  release();
  await queue.waitIdle('p2p:st1');
});

test('D4 G9: 未知/不可解析 msgtype——media.handle null → warn 丢弃，无回复无回合', async () => {
  const { calls, runner } = fakeRunner([() => {}]);
  const { handler, md } = mediaHarness(runner, { handle: async () => null });
  await handler(msg({ msgId: 'u1', msgtype: 'unknownMsgType', textContent: null, raw: { content: {} } }));
  expect(md).toHaveLength(0);
  expect(calls).toHaveLength(0);
});

test('D4: pendingQuestion 存在时 richText 数字文本不触发应答——按普通媒体回合走（注记不丢）', async () => {
  const { calls, runner } = fakeRunner([
    (_req, cbs) => { cbs.onQuestion?.(QUESTION); },
    () => {},
  ]);
  const { handler, queue } = mediaHarness(runner, {
    handle: async () => ({ kind: 'ok', text: '1', notes: ['[附件 image] 已下载：`/uploads/a.png`', '[附件说明] 不可信'] }),
  });
  await handler(msg({ msgId: 'q1' }));   // 出题（pending 落盘）
  await queue.waitIdle('p2p:st1');
  await handler(msg({ msgId: 'q2', msgtype: 'richText', textContent: null, raw: { content: { richText: [{ text: '1' }, { type: 'picture', downloadCode: 'dc' }] } } }));
  await queue.waitIdle('p2p:st1');
  expect(calls[1]!.req.prompt).toContain('[附件 image] 已下载：`/uploads/a.png`'); // 注记保留
  expect(calls[1]!.req.prompt).not.toContain('[AskUserQuestion 应答]');             // 不当应答
});
