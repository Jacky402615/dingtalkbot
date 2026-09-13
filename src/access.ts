import { readFileSync } from 'node:fs';
import type { Logger } from './logger.js';

export interface AccessList { admin: string[]; approved: string[]; groups: string[] }
export type AccessTier = 'admin' | 'approved' | 'unknown';

export function emptyAccessList(): AccessList { return { admin: [], approved: [], groups: [] }; }

export function parseAccessList(raw: unknown): AccessList | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const arr = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  const admin = arr(p.admin); const approved = arr(p.approved); const groups = arr(p.groups);
  if (admin === null || approved === null || groups === null) return null;
  return { admin, approved, groups };
}

export function tierOf(list: AccessList, staffId: string): AccessTier {
  if (list.admin.includes(staffId)) return 'admin';
  if (list.approved.includes(staffId)) return 'approved';
  return 'unknown';
}

export function isGroupAllowed(list: AccessList, conversationId: string): boolean {
  return list.groups.includes(conversationId);
}

type ReadFile = (file: string) => string;
const defaultReadFile: ReadFile = (f) => readFileSync(f, 'utf8');

// 每消息读盘（手工编辑即时生效）。失败 fail-closed 空表（全员按陌生，含 admin——
// 单 owner 手改 typo 自锁可接受，修文件即恢复）；warn 按错误签名限频；
// ENOENT 单次立即重试容忍编辑器 rename-swap 原子替换瞬间（D4）。readFile 可注入（测试）。
export function createAccessLoader(file: string, logger?: Logger, readFile: ReadFile = defaultReadFile): () => AccessList {
  let lastWarnSignature = '';
  const warnOnce = (signature: string, message: string): void => {
    if (signature === lastWarnSignature) return;
    lastWarnSignature = signature;
    logger?.warn('access', message);
  };
  const parseOnce = (): AccessList => {
    const parsed = parseAccessList(JSON.parse(readFile(file)));
    if (parsed === null) {
      const err = new Error('形状非法（需 {admin,approved,groups} 均为 string[]）') as NodeJS.ErrnoException;
      err.code = 'EACCESSSHAPE';
      throw err;
    }
    return parsed;
  };
  return (): AccessList => {
    let err: unknown;
    try {
      const parsed = parseOnce();
      lastWarnSignature = '';
      return parsed;
    } catch (e1) {
      err = e1;
      if ((e1 as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          const parsed = parseOnce(); // 单次立即重试：swap 瞬间后新文件已到位
          lastWarnSignature = '';
          return parsed;
        } catch (e2) { err = e2; }
      }
    }
    warnOnce(String(err), `access.json 读取/解析失败（fail-closed 全拒）: ${String(err)}`);
    return emptyAccessList();
  };
}
