import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { AskUserQuestionPayload } from './claude-runner.js';

export interface SessionRecord {
  chatKey: string;
  sessionId: string;
  lastActiveAt: number; // epoch ms
  pendingQuestion?: AskUserQuestionPayload;
  epoch?: number;       // D3 D7：/new 代际墓碑的比较基准（随文件持久化；取用时以内存当前代重盖章）
}

export interface SessionStoreOptions { sessionsDir: string; ttlMs: number; logger?: Logger; now?: () => number }

export class SessionStore {
  // D3 D7：/new 代际墓碑（进程内存态——v1 单实例网关）。重启归零无害：load() 取用时
  // 以内存当前代重盖章，磁盘上更大的旧代不会让陈旧比较失效（防跨重启复活）。
  private readonly epochs = new Map<string, number>();

  constructor(private readonly opts: SessionStoreOptions) {
    mkdirSync(opts.sessionsDir, { recursive: true, mode: 0o700 }); // 净部署/嵌套路径首回合不炸
  }

  private fileOf(chatKey: string): string {
    const hash = createHash('sha256').update(chatKey).digest('hex').slice(0, 16);
    return join(this.opts.sessionsDir, `${hash}.json`);
  }

  private epochOf(chatKey: string): number { return this.epochs.get(chatKey) ?? 0; }

  reset(chatKey: string): void {
    this.epochs.set(chatKey, this.epochOf(chatKey) + 1);
    this.delete(chatKey);
    this.opts.logger?.info('session', `chat=${chatKey} 会话已重置（epoch=${this.epochOf(chatKey)}）`);
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
      return { ...rec, epoch: this.epochOf(chatKey) }; // 重盖章：陈旧比较以取用时代为准
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
      ? { ...existing, epoch: this.epochOf(chatKey), lastActiveAt: now }
      : { chatKey, sessionId: randomUUID(), epoch: this.epochOf(chatKey), lastActiveAt: now }; // 新会话：pending 丢弃
    this.persist(record);
    return { record, resume };
  }

  persist(record: SessionRecord): void {
    const curEpoch = this.epochOf(record.chatKey);
    if (record.epoch !== undefined && record.epoch < curEpoch) {
      this.opts.logger?.warn('session', `chat=${record.chatKey} 陈旧代际记录（epoch=${record.epoch}<${curEpoch}），跳过持久化（/new 后不复活旧会话）`);
      return;
    }
    const file = this.fileOf(record.chatKey);
    // 盘面合并：lastActiveAt 取 max——旧在飞回合的落盘不把会话 TTL 倒拨
    const disk = this.load(record.chatKey);
    const merged: SessionRecord = disk !== null
      ? { ...record, epoch: record.epoch ?? curEpoch, lastActiveAt: Math.max(record.lastActiveAt, disk.lastActiveAt) }
      : { ...record, epoch: record.epoch ?? curEpoch };
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

  list(): Array<{ chatKey: string; chatKeyHash: string; sessionId: string; lastActiveAt: number; pending: boolean }> {
    let files: string[] = [];
    try { files = readdirSync(this.opts.sessionsDir); } catch { return []; }
    const out: Array<{ chatKey: string; chatKeyHash: string; sessionId: string; lastActiveAt: number; pending: boolean }> = [];
    let bad = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.opts.sessionsDir, f), 'utf8')) as SessionRecord;
        if (typeof rec.chatKey !== 'string' || typeof rec.sessionId !== 'string' || typeof rec.lastActiveAt !== 'number') { bad += 1; continue; }
        out.push({ chatKey: rec.chatKey, chatKeyHash: f.slice(0, -'.json'.length), sessionId: rec.sessionId, lastActiveAt: rec.lastActiveAt, pending: rec.pendingQuestion !== undefined });
      } catch { bad += 1; }
    }
    if (bad > 0) this.opts.logger?.warn('session', `list() 跳过 ${bad} 个损坏/畸形会话文件`);
    return out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }
}
