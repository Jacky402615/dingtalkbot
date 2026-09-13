import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapWorkspace, resolveWorkspace, loadConfig } from '../../src/config.js';

test('bootstrapWorkspace: 建全目录树 + 默认 config/access 幂等', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-ws-'));
  const p1 = bootstrapWorkspace(ws);
  expect(p1.botDir).toBe(join(ws, '.bot'));
  for (const dir of [p1.logsDir, p1.sessionsDir, p1.uploadsDir, p1.pidsDir]) {
    expect(existsSync(dir)).toBe(true);
  }
  expect(JSON.parse(readFileSync(p1.accessFile, 'utf8'))).toEqual({ admin: [], approved: [], groups: [] });
  writeFileSync(p1.configFile, '{"x":1}');
  const p2 = bootstrapWorkspace(ws); // 二次引导不覆盖已有文件
  expect(JSON.parse(readFileSync(p2.configFile, 'utf8'))).toEqual({ x: 1 });
});

test('resolveWorkspace: 显式优先，缺省 cwd', () => {
  expect(resolveWorkspace('/tmp/w')).toBe('/tmp/w');
  expect(resolveWorkspace(undefined)).toBe(process.cwd());
});

test('loadConfig: 损坏 JSON 警告并回退空对象（不抛）', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-ws-'));
  const p = bootstrapWorkspace(ws);
  writeFileSync(p.configFile, '{oops');
  expect(loadConfig(p)).toEqual({});
});
