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

// ---- D2（issue #2）resolveConfig ----
import { resolveConfig, DEFAULT_CONFIG } from '../../src/config.js';
import type { Logger } from '../../src/logger.js';

test('resolveConfig: 空对象 → 全默认；合法值透传', () => {
  expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
  const cfg = resolveConfig({ session_idle_ttl_minutes: 30, ai_card_template_id: 'tpl-1', model: 'glm-5.3' });
  expect(cfg.sessionIdleTtlMinutes).toBe(30);
  expect(cfg.aiCardTemplateId).toBe('tpl-1');
  expect(cfg.model).toBe('glm-5.3');
  expect(cfg.cardStreamMinIntervalMs).toBe(DEFAULT_CONFIG.cardStreamMinIntervalMs);
});

test('resolveConfig: 非法数值/未知权限模式 → warn + 默认', () => {
  const lines: string[] = [];
  const logger: Logger = { debug(){}, info(){}, warn: (_m, msg) => lines.push(msg), error(){} };
  const cfg = resolveConfig({ session_idle_ttl_minutes: -5, agent_turn_timeout_ms: 0, agent_permission_mode: 'yolo' }, logger);
  expect(cfg.sessionIdleTtlMinutes).toBe(DEFAULT_CONFIG.sessionIdleTtlMinutes);
  expect(cfg.agentTurnTimeoutMs).toBe(DEFAULT_CONFIG.agentTurnTimeoutMs);
  expect(cfg.agentPermissionMode).toBe(DEFAULT_CONFIG.agentPermissionMode);
  expect(lines.filter((l) => l.includes('config')).length).toBeGreaterThanOrEqual(3);
});

// ---- D4（issue #4）media_max_bytes ----
test('config D4: media_max_bytes 默认 20 MiB；非法值 warn 回默认；合法值生效', () => {
  const warns: string[] = [];
  const logger = { debug() {}, info() {}, warn: (_s: string, m: string) => warns.push(m), error() {} } as never;
  expect(resolveConfig({}, logger as never).mediaMaxBytes).toBe(20 * 1024 * 1024);
  expect(resolveConfig({ media_max_bytes: 1024 }, logger as never).mediaMaxBytes).toBe(1024);
  const bad = resolveConfig({ media_max_bytes: -1 }, logger as never);
  expect(bad.mediaMaxBytes).toBe(20 * 1024 * 1024);
  expect(warns.some((w) => w.includes('media_max_bytes'))).toBe(true);
});
