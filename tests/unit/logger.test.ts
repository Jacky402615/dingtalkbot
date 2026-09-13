import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileLogger } from '../../src/logger.js';

test('createFileLogger: 文件名格式 + JSONL 追加 + latest.log 链接', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-log-'));
  const { logger, logFilePath, linkLatest } = createFileLogger(dir);
  expect(logFilePath).toMatch(/\d{8}_\d{6}\.log$/);
  logger.info('transport', 'hello', { k: 1 });
  logger.debug('transport', '隐藏（默认 info 级）');
  linkLatest();
  const lines = readFileSync(logFilePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ level: 'info', module: 'transport', msg: 'hello', extra: { k: 1 } });
  expect(existsSync(join(dir, 'latest.log'))).toBe(true);
});

test('createFileLogger: DEBUG 环境变量放开 debug 级；同秒两次创建不碰撞', () => {
  const prev = process.env.DEBUG;
  process.env.DEBUG = '1';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dtb-log-'));
    const { logger, logFilePath } = createFileLogger(dir);
    logger.debug('x', '可见');
    const lines = readFileSync(logFilePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const second = createFileLogger(dir); // 同一秒内再次创建（快速重启）
    expect(second.logFilePath).not.toBe(logFilePath);
  } finally { process.env.DEBUG = prev; }
});

test('createFileLogger: 相对路径 logsDir 的 latest.log 链接仍可用（绝对化 target）', () => {
  const rel = join('.', `dtb-rel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  try {
    const { logger, logFilePath, linkLatest } = createFileLogger(rel);
    logger.info('transport', 'hello');
    linkLatest();
    const latest = readFileSync(join(rel, 'latest.log'), 'utf8'); // 经符号链接读到内容 = 链接有效
    expect(latest).toContain('hello');
    expect(existsSync(logFilePath)).toBe(true);
  } finally {
    rmSync(rel, { recursive: true, force: true });
  }
});
