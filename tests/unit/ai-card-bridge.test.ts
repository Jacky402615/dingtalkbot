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
      if (opts.createFails) throw new Error('OpenAPI /v1.0/card/instances/createAndDeliver 失败: HTTP 404 {"code":"Card.NotFound"}');
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
  const logger: Logger = { debug() {}, info: (_m, m) => infos.push(m), warn: (_m, m) => warns.push(m), error: (_m, m) => errs.push(m) };
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

test('bridge: AC6——增量字节阈值：10+10 抑制、再 +64 刷；intervalMs 在场', async () => {
  const h = harness('p2p', { minBytes: 64, minIntervalMs: 0 });
  await h.bridge.start();
  await h.bridge.pushText('0123456789');            // 10 字节 <64 → 抑制
  await h.bridge.pushText('01234567890123456789');  // 增量 10 <64 → 抑制
  expect(h.cardCalls.filter((c) => c.op === 'update')).toHaveLength(0);
  await h.bridge.pushText('01234567890123456789' + 'x'.repeat(64)); // 增量 ≥64 → 刷
  expect(h.cardCalls.filter((c) => c.op === 'update')).toHaveLength(1);
  expect(h.infos.some((m) => m.includes('suppressed=2'))).toBe(true);
  expect(h.infos.some((m) => m.includes('intervalMs='))).toBe(true);
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
  await h.bridge.pushText('一二');      // update 2 失败 → 尝试 isError 收终（update 3）→ dead
  await h.bridge.pushText('一二三');    // dead noop
  await h.bridge.finish('一二三（终）');
  const updates = h.cardCalls.filter((c) => c.op === 'update');
  expect(updates).toHaveLength(3);
  expect(updates[2].args).toMatchObject({ finalize: true, error: true });
  expect(h.mdCalls).toEqual([{ method: 'group', text: '一二三（终）' }]);
});

test('bridge: fail——活卡 isError 收终失败 → markdown 兜底（错误+部分文本）', async () => {
  const h = harness('p2p', { cardFailsAt: 2 });
  await h.bridge.start();
  await h.bridge.pushText('正常推送');  // update 1 成功
  await h.bridge.fail('claude 失败：超时', '部分生成的内容'); // isError finalize（update 2）失败 → markdown 兜底
  expect(h.mdCalls).toHaveLength(1);
  expect(h.mdCalls[0].text).toContain('claude 失败：超时');
  expect(h.mdCalls[0].text).toContain('部分生成的内容');
  expect(h.errs.some((e) => e.includes('isError') || e.includes('收终'))).toBe(true);
});

test('bridge: fail——dead 卡 markdown 含错误+部分文本；双降级不叠加', async () => {
  const h = harness('p2p', { cardFailsAt: 1 });
  await h.bridge.start();
  await h.bridge.pushText('x');                  // update 1 失败 → isError 收终亦失败 → dead
  await h.bridge.fail('claude 失败：超时', '部分生成的内容');
  await h.bridge.finish('迟到的全文');            // fallback 已发 → 不再发
  expect(h.mdCalls).toHaveLength(1);
  expect(h.mdCalls[0].text).toContain('claude 失败：超时');
  expect(h.mdCalls[0].text).toContain('部分生成的内容');
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
  const logger: Logger = { debug() {}, info: (_m, m) => infos.push(m), warn() {}, error() {} };
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
