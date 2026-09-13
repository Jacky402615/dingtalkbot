import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

export interface PidRecord { pid: number; startedAt: number } // startedAt = /proc/<pid>/stat 第22字段（ticks）

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readProcessStartedAt(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = afterComm.split(' ');
    const ticks = Number(fields[19]); // comm(2) state(3)…：')' 后 fields[0]=state，第22字段 = fields[19]
    return Number.isFinite(ticks) && ticks > 0 ? ticks : null;
  } catch { return null; }
}

export function writePidFile(pidFile: string, pid: number): void {
  writeFileSync(pidFile, JSON.stringify({ pid, startedAt: readProcessStartedAt(pid) ?? 0 }) + '\n', { mode: 0o600 });
}

export function readPidFile(pidFile: string): PidRecord | null {
  if (!existsSync(pidFile)) return null;
  try {
    const rec = JSON.parse(readFileSync(pidFile, 'utf8')) as PidRecord;
    return typeof rec.pid === 'number' ? rec : null;
  } catch { return null; }
}

export function clearPidFile(pidFile: string): boolean {
  try {
    if (existsSync(pidFile)) rmSync(pidFile);
    return true;
  } catch {
    return false; // 调用方负责告警（清理失败不阻断关停，但不得静默）
  }
}

export function pidStartMatches(pidFile: string, pid: number): boolean {
  const rec = readPidFile(pidFile);
  if (!rec || rec.pid !== pid) return false;
  const current = readProcessStartedAt(pid);
  return current !== null && current === rec.startedAt;
}
