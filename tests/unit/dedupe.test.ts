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
  d.reserve('a'); d.reserve('b'); d.reserve('c'); // a 被淘汰 → {b,c}
  expect(d.reserve('a')).toBe(true);              // a 重入，淘汰次旧 b → {c,a}
  expect(d.reserve('c')).toBe(false);
  expect(d.reserve('a')).toBe(false);
  expect(d.reserve('b')).toBe(true);              // b 已被淘汰，可重入
});

test('dedupe: release 未见过的 id 为 no-op', () => {
  const d = new MsgIdDedupe(2);
  expect(() => d.release('nope')).not.toThrow();
  expect(d.reserve('nope')).toBe(true);
});
