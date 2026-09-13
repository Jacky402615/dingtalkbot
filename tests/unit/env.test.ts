import { test, expect } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile, loadBotEnv, saveBotEnv, EnvError } from '../../src/env.js';

test('parseEnvFile: 键值/引号/注释/空行/格式异常行', () => {
  const parsed = parseEnvFile('# 注释\nA=1\nB = "two"\nC=x\'y\n\nD=\n不是键值行');
  expect(parsed).toEqual({ A: '1', B: 'two', C: "x'y", D: '' });
});

test('loadBotEnv: 缺文件/缺键响亮抛 EnvError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-env-'));
  expect(() => loadBotEnv(dir)).toThrow(EnvError);
  writeFileSync(join(dir, '.env'), 'DINGTALK_CLIENT_ID=abc\n');
  try {
    loadBotEnv(dir);
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvError);
    expect(String(err)).toContain('DINGTALK_CLIENT_SECRET');
  }
});

test('saveBotEnv + loadBotEnv 往返，权限 0600（含覆写 planted 0644 文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-env-'));
  saveBotEnv(dir, { clientId: 'cid', clientSecret: 'sec' });
  const text = readFileSync(join(dir, '.env'), 'utf8');
  expect(text).toContain('DINGTALK_CLIENT_ID=cid');
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  // 已存在的 0644 文件被覆写后必须被显式收紧
  writeFileSync(join(dir, '.env'), 'x', { mode: 0o644 });
  saveBotEnv(dir, { clientId: 'cid2', clientSecret: 'sec2' });
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  expect(loadBotEnv(dir)).toEqual({ clientId: 'cid2', clientSecret: 'sec2' });
});

test('loadBotEnv: 权限漂移到 0644 → 读取前收紧为 0600 并正常加载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-env-'));
  saveBotEnv(dir, { clientId: 'cid', clientSecret: 'sec' });
  chmodSync(join(dir, '.env'), 0o644); // 模拟漂移
  expect(loadBotEnv(dir)).toEqual({ clientId: 'cid', clientSecret: 'sec' });
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
});
