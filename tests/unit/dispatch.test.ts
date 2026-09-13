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

const quiet = { debug() {}, info() {}, warn() {}, error() {} } as const;
const loudWarns = () => {
  const w: string[] = [];
  return { warns: w, logger: { debug() {}, info() {}, warn: (_s: string, m: string) => w.push(m), error() {} } as const };
};

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

test('G1: unknown 会话类型——不鉴权不进命令/agent，静默丢弃留 warn（code-review r2）', async () => {
  const h = makeHarness();
  await h.handler(p2p({ msgId: 'u1', conversationKind: 'unknown' as never, textContent: '/help' }));
  expect(h.md).toHaveLength(0);
  expect(h.cmds).toHaveLength(0);
  expect(h.agentMsgs).toHaveLength(0);
  expect(h.warns.some((w) => w.includes('未知会话类型'))).toBe(true);
});
