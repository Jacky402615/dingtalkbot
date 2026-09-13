import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStateJson, readStateJson } from '../../src/state.js';

test('writeStateJson: 原子写 + 读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-st-'));
  const f = join(dir, 'state.json');
  writeStateJson(f, { pid: 1, startedAt: 't', transport: 'connected', detail: 'x', updatedAt: 'u' });
  expect(readStateJson(f)).toEqual({ pid: 1, startedAt: 't', transport: 'connected', detail: 'x', updatedAt: 'u' });
  expect(existsSync(f + '.tmp')).toBe(false); // tmp 已 rename
});

test('readStateJson: 缺文件 null；损坏 null（status 层区分打印）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-st-'));
  const f = join(dir, 'state.json');
  expect(readStateJson(f)).toBeNull();
  writeFileSync(f, '{bad');
  expect(readStateJson(f)).toBeNull();
});
