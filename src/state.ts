import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type TransportState = 'stopped' | 'starting' | 'connected' | 'reconnecting';

export interface ConnectionStateSnapshot {
  pid: number;
  startedAt: string;
  transport: TransportState;
  detail: string;
  updatedAt: string;
}

export function writeStateJson(stateFile: string, snapshot: ConnectionStateSnapshot): void {
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, stateFile);
  chmodSync(stateFile, 0o600); // rename 到已存在的路径不继承新权限位——显式收紧
}

export function readStateJson(stateFile: string): ConnectionStateSnapshot | null {
  if (!existsSync(stateFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as ConnectionStateSnapshot;
    return typeof parsed.transport === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
