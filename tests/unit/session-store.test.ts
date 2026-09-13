import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readdirSync, statSync, existsSync, chmodSync } from 'node:fs';
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

// ---- D3（issue #3）：epoch 代际 / reset / list ----
import { createHash } from 'node:crypto';

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
  s2.persist(snap!);                                  // 在飞/排队回合持取值快照落盘（epoch 0 < 1）
  expect(s2.load('p2p:st1')).toBeNull();              // 拦截——旧 sessionId 不复活
});

test('store D3: 作废三级兜底——rename 失败原地覆写；双失败才认输（code-review r2）', () => {
  // 场景 A：目录只读但文件可写 → rename 失败、覆写成功 → reset 成功且旧会话不可 resume
  const dir = mkdtempSync(join(tmpdir(), 'dtb-sess-d3e-'));
  const store = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000 });
  store.beginTurn('p2p:st1');
  chmodSync(dir, 0o555);                               // 目录去写位 → rename 失败
  try {
    store.reset('p2p:st1');                            // 覆写路径——不抛
    expect(store.load('p2p:st1')).toBeNull();          // 无效载荷按不存在处理
    store.delete('p2p:st1');                           // delete 同样不抛
  } finally {
    chmodSync(dir, 0o755);
  }
  // 场景 B：目录与文件均只读 → rename+覆写双失败 → reset 响亮上抛、delete 只留 error
  const dir2 = mkdtempSync(join(tmpdir(), 'dtb-sess-d3f-'));
  const errs: string[] = [];
  const store2 = new SessionStore({ sessionsDir: dir2, ttlMs: 3_600_000,
    logger: { debug() {}, info() {}, warn() {}, error: (_s, m) => errs.push(m) } });
  const ghost = store2.beginTurn('p2p:st2').record.sessionId; // 磁盘残留的 sessionId
  const file2 = readdirSync(dir2).find((f) => f.endsWith('.json'))!;
  chmodSync(dir2, 0o555);
  chmodSync(join(dir2, file2), 0o444);
  try {
    expect(() => store2.reset('p2p:st2')).toThrow();
    expect(() => store2.delete('p2p:st2')).not.toThrow(); // delete 不抛（error 日志留痕）
    expect(errs.some((e) => e.includes('作废失败'))).toBe(true);
    // r3：双失败后内存兜底墓碑——已知幽灵 sessionId 拒 resume（下条消息全新会话）
    const next = store2.beginTurn('p2p:st2');
    expect(next.resume).toBe(false);
    expect(next.record.sessionId).not.toBe(ghost);         // 全新 id——墓碑拒绝 resume 磁盘残留
  } finally {
    chmodSync(join(dir2, file2), 0o600);
    chmodSync(dir2, 0o755);
  }
  // 恢复可写后新记录成功落盘 → 墓碑退役，正常 resume 恢复
  store2.persist(store2.beginTurn('p2p:st2').record);
  const again = store2.beginTurn('p2p:st2');
  expect(again.resume).toBe(true);
});

test('store D3/r4: TTL 换代不被在飞旧回合倒拨——旧代 persist 跳过、新 sessionId 存续', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-sess-d3g-'));
  let clock = 1_000_000;
  const store = new SessionStore({ sessionsDir: dir, ttlMs: 3_600_000, now: () => clock });
  const a = store.beginTurn('p2p:st1');                 // A 到达（S1，epoch 0）——回合将挂起
  expect(a.resume).toBe(false);
  clock += 3_600_001;                                   // TTL 过期（A 仍在飞）
  const b = store.beginTurn('p2p:st1');                 // B 到达 → 换代 S2（epoch+1）
  expect(b.resume).toBe(false);
  expect(b.record.sessionId).not.toBe(a.record.sessionId);
  store.persist(a.record);                              // A 在飞结束落盘 → 陈旧代跳过
  const disk = store.load('p2p:st1');
  expect(disk!.sessionId).toBe(b.record.sessionId);     // 不倒拨回过期 S1
  const resumeB = store.beginTurn('p2p:st1');           // 后续消息正常 resume S2
  expect(resumeB.resume).toBe(true);
  expect(resumeB.record.sessionId).toBe(b.record.sessionId);
});
