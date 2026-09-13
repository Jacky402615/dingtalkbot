import { existsSync } from 'node:fs';
import { bootstrapWorkspace } from '../config.js';
import { readPidFile, clearPidFile, isProcessAlive, pidStartMatches } from '../pid.js';

export class NotRunningError extends Error {}
const STOP_GRACE_MS = 15_000;

export async function stopCommand(workspace: string): Promise<void> {
  const paths = bootstrapWorkspace(workspace);
  const rec = readPidFile(paths.pidFile);
  if (rec === null) {
    if (existsSync(paths.pidFile)) {
      // 损坏 pidfile：无法安全发信号，只能响亮清理
      if (!clearPidFile(paths.pidFile)) console.error(`pidfile 损坏且清理失败: ${paths.pidFile}`);
      console.warn(`pidfile 损坏（不可解析），已清理，未发送信号: ${paths.pidFile}`);
      return;
    }
    throw new NotRunningError('没有 pidfile —— 未在运行');
  }
  // pid 复用防护：存活但 startedAt 不匹配 → 视为陈旧记录，绝不向陌生进程发信号
  if (!isProcessAlive(rec.pid) || !pidStartMatches(paths.pidFile, rec.pid)) {
    if (!clearPidFile(paths.pidFile)) console.error(`陈旧 pidfile 清理失败: ${paths.pidFile}`);
    console.warn(`pid ${rec.pid} 已不存在或 pid 复用（startedAt 不匹配），仅清理 pidfile，不发送信号`);
    return;
  }
  process.kill(rec.pid, 'SIGTERM');
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && isProcessAlive(rec.pid)) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (isProcessAlive(rec.pid)) {
    console.warn(`宽限 ${STOP_GRACE_MS}ms 超时，SIGKILL pid=${rec.pid}`);
    process.kill(rec.pid, 'SIGKILL');
    for (let i = 0; i < 8 && isProcessAlive(rec.pid); i++) {
      await new Promise((r) => setTimeout(r, 250)); // SIGKILL 后短暂等待回收
    }
  }
  if (!clearPidFile(paths.pidFile)) console.error(`停止完成但 pidfile 清理失败: ${paths.pidFile}`);
  console.log(`已停止 pid=${rec.pid}`);
}
