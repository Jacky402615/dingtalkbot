import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { bootstrapWorkspace } from '../config.js';
import { readPidFile, writePidFile, clearPidFile, isProcessAlive, pidStartMatches } from '../pid.js';

export class MissingEnvError extends Error {}
export class AlreadyRunningError extends Error {}

export function resolveBotBin(): string {
  const here = fileURLToPath(new URL('.', import.meta.url)); // src/commands/ 或 dist/（打包后平铺）
  const candidates = [join(here, '../../dist/cli.js'), join(here, 'cli.js'), join(here, '../cli.js')];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`找不到 cli.js（尝试过: ${candidates.join(', ')}）`);
}

export function startCommand(workspace: string): void {
  const paths = bootstrapWorkspace(workspace);
  if (!existsSync(paths.envFile)) throw new MissingEnvError(`缺少 ${paths.envFile} —— 先运行 dingtalkbot setup`);
  const existing = readPidFile(paths.pidFile);
  if (existing && isProcessAlive(existing.pid) && pidStartMatches(paths.pidFile, existing.pid)) {
    throw new AlreadyRunningError(`已在运行 (pid ${existing.pid})`);
  }
  if (existing && !clearPidFile(paths.pidFile)) console.warn(`陈旧 pidfile 清理失败: ${paths.pidFile}`);
  const binPath = resolveBotBin();
  const child = spawn(process.execPath, [binPath, 'run', '-r', workspace], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  if (child.pid === undefined) throw new Error('子进程启动失败（无 pid）');
  writePidFile(paths.pidFile, child.pid);
  console.log(`已启动 pid=${child.pid}；日志 ${join(paths.logsDir, 'latest.log')}`);
}
