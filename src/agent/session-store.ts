import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { AskUserQuestionPayload } from './claude-runner.js';

export interface SessionRecord {
  chatKey: string;
  sessionId: string;
  lastActiveAt: number; // epoch ms
  pendingQuestion?: AskUserQuestionPayload;
}

export interface SessionStoreOptions { sessionsDir: string; ttlMs: number; logger?: Logger; now?: () => number }

export class SessionStore {
  constructor(private readonly opts: SessionStoreOptions) {
    mkdirSync(opts.sessionsDir, { recursive: true, mode: 0o700 }); // 净部署/嵌套路径首回合不炸
  }

  private fileOf(chatKey: string): string {
    const hash = createHash('sha256').update(chatKey).digest('hex').slice(0, 16);
    return join(this.opts.sessionsDir, `${hash}.json`);
  }

  load(chatKey: string): SessionRecord | null {
    const file = this.fileOf(chatKey);
    if (!existsSync(file)) return null;
    try {
      const rec = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord;
      if (typeof rec.sessionId !== 'string' || typeof rec.lastActiveAt !== 'number' || rec.chatKey !== chatKey) {
        this.opts.logger?.warn('session', `会话文件结构异常（chatKey=${chatKey}），当作不存在`);
        return null;
      }
      return rec;
    } catch (err) {
      this.opts.logger?.warn('session', `会话文件损坏/不可解析（chatKey=${chatKey}），当作不存在: ${String(err)}`);
      return null;
    }
  }

  delete(chatKey: string): void {
    const file = this.fileOf(chatKey);
    try {
      if (existsSync(file)) renameSync(file, `${file}.dead-${Date.now()}`); // 留痕删除（审计），不复活
    } catch (err) {
      this.opts.logger?.warn('session', `会话记录作废失败（忽略，下次覆盖）: ${String(err)}`);
    }
  }

  beginTurn(chatKey: string): { record: SessionRecord; resume: boolean } {
    const now = (this.opts.now ?? Date.now)();
    const existing = this.load(chatKey);
    const resume = existing !== null && now - existing.lastActiveAt < this.opts.ttlMs;
    const record: SessionRecord = resume
      ? { ...existing, lastActiveAt: now }
      : { chatKey, sessionId: randomUUID(), lastActiveAt: now }; // 新会话：pending 丢弃
    this.persist(record);
    return { record, resume };
  }

  persist(record: SessionRecord): void {
    const file = this.fileOf(record.chatKey);
    // 盘面合并：lastActiveAt 取 max——旧在飞回合的落盘不把会话 TTL 倒拨
    const disk = this.load(record.chatKey);
    const merged: SessionRecord = disk !== null
      ? { ...record, lastActiveAt: Math.max(record.lastActiveAt, disk.lastActiveAt) }
      : record;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(merged), { flag: 'wx', mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
      chmodSync(file, 0o600); // rename 到已存在路径不继承权限位——显式收紧
    } catch (err) {
      try { if (existsSync(tmp)) renameSync(tmp, `${file}.tmp-failed-${Date.now()}`); } catch { /* 尽力 */ }
      this.opts.logger?.error('session', `会话记录写入失败（回合继续，重启后该 chat 会话可能丢失）: ${String(err)}`);
    }
  }

  endTurn(record: SessionRecord): void {
    this.persist(record);
  }
}
