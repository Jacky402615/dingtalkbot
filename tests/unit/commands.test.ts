import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapWorkspace } from '../../src/config.js';
import { stopCommand, NotRunningError } from '../../src/commands/stop.js';
import { startCommand, MissingEnvError, AlreadyRunningError } from '../../src/commands/start.js';
import { statusCommand } from '../../src/commands/status.js';
import { writePidFile, isProcessAlive } from '../../src/pid.js';

function captureConsole(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(String(args[0])); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test('stopCommand: 无 pidfile → NotRunningError', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-cmd-'));
  await expect(stopCommand(ws)).rejects.toBeInstanceOf(NotRunningError);
});

test('stopCommand: 死 pid 或 pid 复用（startedAt 不匹配）→ 清 pidfile 不发信号', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-cmd2-'));
  const paths = bootstrapWorkspace(ws);
  writePidFile(paths.pidFile, 999_999_999); // 死 pid：readProcessStartedAt → null → 不匹配
  await stopCommand(ws); // 不抛、不杀
  expect(existsSync(paths.pidFile)).toBe(false);
});

test('stopCommand: 真实子进程 SIGTERM 退出 + pidfile 清理（daemon 生命周期）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-cmd6-'));
  const paths = bootstrapWorkspace(ws);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150)); // 等 /proc 就绪
  writePidFile(paths.pidFile, child.pid!);
  await stopCommand(ws);
  expect(isProcessAlive(child.pid!)).toBe(false);
  expect(existsSync(paths.pidFile)).toBe(false);
});

test('startCommand: 缺 .env → MissingEnvError', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-cmd3-'));
  bootstrapWorkspace(ws);
  expect(() => startCommand(ws)).toThrow(MissingEnvError);
});

test('startCommand: pidfile 指向存活且匹配的进程 → AlreadyRunningError（不重复拉起）', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-cmd4-'));
  const paths = bootstrapWorkspace(ws);
  writeFileSync(paths.envFile, 'DINGTALK_CLIENT_ID=a\nDINGTALK_CLIENT_SECRET=b\n');
  writePidFile(paths.pidFile, process.pid); // 当前测试进程：存活 + startedAt 匹配
  expect(() => startCommand(ws)).toThrow(AlreadyRunningError);
});

test('statusCommand: 未运行 / 运行中+connected / 陈旧 三态输出正确', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-cmd5-'));
  const paths = bootstrapWorkspace(ws);
  expect(captureConsole(() => statusCommand(ws))).toContain('状态: 未运行（无 pidfile）');
  writePidFile(paths.pidFile, process.pid);
  writeFileSync(paths.stateFile, JSON.stringify({ pid: process.pid, startedAt: 't', transport: 'connected', detail: 'ok', updatedAt: 'u' }));
  const running = captureConsole(() => statusCommand(ws));
  expect(running.join('\n')).toContain('（运行中）');
  expect(running.join('\n')).toContain('连接状态: connected');
  writePidFile(paths.pidFile, 999_999_999); // 死 pid → 陈旧
  const stale = captureConsole(() => statusCommand(ws));
  expect(stale.join('\n')).toContain('（已退出/陈旧 pidfile）');
});
