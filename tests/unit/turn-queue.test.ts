import { test, expect } from 'bun:test';
import { TurnQueue } from '../../src/agent/turn-queue.js';
import type { Logger } from '../../src/logger.js';

function deferred() { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); return { p, release }; }
function logger(sink: { warns?: string[]; errs?: string[] } = {}): Logger {
  return { debug() {}, info() {}, warn: (_m, m) => sink.warns?.push(m), error: (_m, m) => sink.errs?.push(m) };
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
  await q.waitIdle('c1');
  expect(q.depthOf('c1')).toBe(0);
});

test('queue: job 抛错 → error 日志，链不断', async () => {
  const errs: string[] = [];
  const q = new TurnQueue({ maxPerChat: 5, logger: logger({ errs }) });
  const ran: string[] = [];
  q.enqueue('c1', async () => { throw new Error('boom'); });
  q.enqueue('c1', async () => { ran.push('after'); });
  await q.waitIdle('c1'); // 确定性等链尾（enqueue 返回值不等链执行）
  expect(ran).toEqual(['after']);
  expect(errs.some((e) => e.includes('boom'))).toBe(true);
});

test('queue: close——拒绝新入队；排队未开始的 job 轮到时丢弃', async () => {
  const warns: string[] = [];
  const q = new TurnQueue({ maxPerChat: 5, logger: logger({ warns }) });
  const d1 = deferred();
  const ran: string[] = [];
  q.enqueue('c1', async () => { ran.push('t1'); await d1.p; ran.push('t1-end'); });
  await new Promise((r) => setTimeout(r, 10)); // 等 t1 真正开跑（在飞）再排队/关闭——消除微任务时序竞态
  q.enqueue('c1', async () => { ran.push('t2'); }); // 排队中
  q.close();
  expect(q.closed).toBe(true);
  expect(q.enqueue('c1', async () => {})).toBe(false); // 拒新
  d1.release(); // t1 完成；t2 轮到但已 close → 丢弃
  await q.waitIdle('c1');
  expect(ran).toEqual(['t1', 't1-end']); // t2 未执行
  expect(warns.some((w) => w.includes('丢弃') || w.includes('关闭'))).toBe(true);
});

// ---- pr-review r1 修复回归 ----
test('queue: drainActive——close 后等待在飞 job 完整收尾（含排队丢弃链快速自了）', async () => {
  const q = new TurnQueue({ maxPerChat: 5, logger: logger() });
  const d1 = deferred();
  const events: string[] = [];
  q.enqueue('c1', async () => { events.push('job-start'); await d1.p; events.push('job-end'); });
  await new Promise((r) => setTimeout(r, 10));
  q.enqueue('c1', async () => { events.push('queued-should-drop'); });
  q.close();
  d1.release();
  await q.drainActive();
  expect(events).toEqual(['job-start', 'job-end']); // 在飞收尾完成 + 排队被丢弃
});

// ---- D3（issue #3 code-review F1）：queuedDepthOf 只计排队未开始 ----
test('queue D3: queuedDepthOf 区分在飞与排队——在飞收尾期间不计入排队数', async () => {
  const q = new TurnQueue({ maxPerChat: 10, logger: logger() });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let inJob = false;
  q.enqueue('p2p:a', async () => { inJob = true; await gate; }); // 回合 1（将挂起）
  await new Promise((r) => setTimeout(r, 10));                    // 等回合 1 开跑
  q.enqueue('p2p:a', async () => {});                             // 回合 2 排队
  expect(q.depthOf('p2p:a')).toBe(2);                             // 总深度
  expect(q.runningCountOf('p2p:a')).toBe(1);                      // 在飞（含未 spawn 窗口）
  expect(q.queuedDepthOf('p2p:a')).toBe(1);                       // 仅排队
  release();
  await q.waitIdle('p2p:a');
  expect(inJob).toBe(true);
  expect(q.queuedDepthOf('p2p:a')).toBe(0);
  expect(q.depthOf('p2p:a')).toBe(0);
});
