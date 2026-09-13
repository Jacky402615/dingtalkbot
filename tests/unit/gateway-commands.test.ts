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
  const calls: string[] = [];
  const { deps, md } = makeDeps({
    runner: { activeCountOf: () => 1, abortChat: async (c: string, r: string) => { calls.push(`${c}:${r}`); return 1; } },
    queue: { depthOf: () => 2 },
  });
  const exec = createCommandExecutor(deps as never);
  await exec('stop', msg({ senderStaffId: 'stX' })); // fake 的 activeCountOf 恒 1 → 走中止路径
  expect(calls).toEqual(['p2p:stX:用户 /stop']);
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
