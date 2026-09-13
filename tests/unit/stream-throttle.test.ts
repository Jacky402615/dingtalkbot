import { test, expect } from 'bun:test';
import { StreamThrottle } from '../../src/cards/stream-throttle.js';

test('throttle: AND 语义——时间够但字节不够 → 不刷', () => {
  let clock = 0;
  const t = new StreamThrottle({ minIntervalMs: 1_000, minBytes: 64, now: () => clock });
  t.markFlushed();
  clock += 2_000;
  expect(t.shouldFlush(10)).toBe(false);
  expect(t.suppressedSinceFlush).toBe(1);
  expect(t.shouldFlush(64)).toBe(true);
});

test('throttle: 字节够但时间不够 → 不刷；首次只看字节', () => {
  let clock = 1_000_000;
  const t = new StreamThrottle({ minIntervalMs: 1_500, minBytes: 64, now: () => clock });
  expect(t.shouldFlush(64)).toBe(true);
  const t2 = new StreamThrottle({ minIntervalMs: 1_500, minBytes: 64, now: () => clock });
  t2.markFlushed();
  expect(t2.shouldFlush(1_000)).toBe(false);
});
