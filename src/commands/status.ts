import { existsSync } from 'node:fs';
import { bootstrapWorkspace } from '../config.js';
import { readPidFile, isProcessAlive, pidStartMatches } from '../pid.js';
import { readStateJson } from '../state.js';

export function statusCommand(workspace: string): void {
  const paths = bootstrapWorkspace(workspace);
  const rec = readPidFile(paths.pidFile);
  if (rec === null) {
    console.log('状态: 未运行（无 pidfile）');
    return;
  }
  const alive = isProcessAlive(rec.pid) && pidStartMatches(paths.pidFile, rec.pid);
  console.log(`pid: ${rec.pid} ${alive ? '（运行中）' : '（已退出/陈旧 pidfile）'}`);
  const snap = readStateJson(paths.stateFile);
  if (snap === null) {
    console.log(`连接状态: 未知${existsSync(paths.stateFile) ? '（state.json 损坏）' : '（无 state.json，可能尚未完成首次连接）'}`);
    return;
  }
  console.log(`连接状态: ${snap.transport}`);
  console.log(`明细: ${snap.detail}`);
  console.log(`更新时间: ${snap.updatedAt}`);
}
