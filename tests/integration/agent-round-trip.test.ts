import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapWorkspace, DEFAULT_CONFIG } from '../../src/config.js';
import { DingtalkSdkTransport } from '../../src/transport/dingtalk-sdk-adapter.js';
import { FakeDwClient } from '../helpers/fake-dw-client.js';
import { TokenManager } from '../../src/openapi/token.js';
import { RobotReplyer } from '../../src/openapi/robot.js';
import { CardClient } from '../../src/openapi/card.js';
import { SessionStore } from '../../src/agent/session-store.js';
import { TurnQueue } from '../../src/agent/turn-queue.js';
import { createAgentSessionHandler } from '../../src/handlers/agent-session.js';
import { Gateway } from '../../src/gateway.js';
import type { ClaudeRunner, TurnRequest, TurnCallbacks, TurnResult } from '../../src/agent/claude-runner.js';
import type { Logger } from '../../src/logger.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function deferred() { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); return { p, release }; }

function scriptedRunner(steps: Array<(cbs: TurnCallbacks) => void | Promise<void>>) {
  const events: string[] = [];
  const calls: TurnRequest[] = [];
  let i = 0;
  const gates = steps.map(() => deferred());
  const runner = {
    run: async (req: TurnRequest, cbs: TurnCallbacks): Promise<TurnResult> => {
      const idx = Math.min(i, steps.length - 1); i += 1;
      calls.push(req);
      events.push(`start${idx + 1}`);
      await steps[idx](cbs); // 尊重脚本/回调返回的 Promise（异步边界保真）
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
    if (String(url).includes('createAndDeliver') && opts.cardCreateStatus !== undefined && opts.cardCreateStatus !== 200) {
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
  const { http, fetchFn } = wireHttp();
  const { client, gateway, queue } = assemble(runner, fetchFn);
  await gateway.start();
  client.emitRobotMessage(P2P_MSG);
  await new Promise((r) => setTimeout(r, 120)); // handler 返回（ack）后回合在队列中
  runner.release(0);
  await queue.waitIdle('p2p:st1');
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
  expect(streams.length).toBeGreaterThanOrEqual(2); // ≥1 次 flush + finalize
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
  const { http, fetchFn } = wireHttp();
  const { client, gateway, queue } = assemble(runner, fetchFn);
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
