import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
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
  store.persist(record); // 回合中即时持久化
  const again = store.beginTurn('p2p:st1');
  expect(again.record.pendingQuestion).toEqual(Q);
  const group = store.beginTurn('group:cidG');
  expect(group.resume).toBe(false);
  expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(2);
});

test('store: 跨实例（网关重启）——同目录新 SessionStore resume 同 uuid 与 pending（AC2 重启面）', () => {
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

test('store: delete 作废会话记录（幽灵会话防护）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-sess6-'));
  const store = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000 });
  store.beginTurn('p2p:st9');
  expect(store.load('p2p:st9')).not.toBeNull();
  store.delete('p2p:st9');
  expect(store.load('p2p:st9')).toBeNull();
  const next = store.beginTurn('p2p:st9');
  expect(next.resume).toBe(false);
});

test('store: 损坏 JSON → warn + 新会话；0600；构造自建目录（评审修复）', () => {
  const base = mkdtempSync(join(tmpdir(), 'dtb-sess3-'));
  const dir = join(base, 'not-exist-yet', 'sessions'); // 不存在的嵌套路径
  const warns: string[] = [];
  let clock = 5_000_000;
  const store = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000, now: () => clock,
    logger: { debug() {}, info() {}, warn: (_m, m) => warns.push(m), error() {} } });
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
