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
    logger: quietLogger as never, workspace: '/ws' });
  return { handler, md, cardCalls, store, queue };
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

test('handler: 队列满 → 忙线 markdown；msgId 重复丢弃', async () => {
  const { calls, runner } = fakeRunner([() => {}]);
  const dup = harness(runner);
  await dup.handler(msg({ msgId: 'd1' }));
  await dup.queue.waitIdle('p2p:st1');
  await dup.handler(msg({ msgId: 'd1' }));   // 重复 msgId → 丢弃
  expect(calls).toHaveLength(1);
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
    logger: quietLogger as never, workspace: '/ws',
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
