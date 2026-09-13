import type { Logger } from '../logger.js';

export interface TurnQueueOptions { maxPerChat: number; logger: Logger }

interface ChatQueue { chain: Promise<void>; depth: number }

export class TurnQueue {
  private readonly chats = new Map<string, ChatQueue>();
  private closedFlag = false;

  constructor(private readonly opts: TurnQueueOptions) {}

  get closed(): boolean { return this.closedFlag; }

  close(): void { this.closedFlag = true; }

  depthOf(chatKey: string): number { return this.chats.get(chatKey)?.depth ?? 0; }

  waitIdle(chatKey: string): Promise<void> { return this.chats.get(chatKey)?.chain ?? Promise.resolve(); }

  enqueue(chatKey: string, job: () => Promise<void>): boolean {
    if (this.closedFlag) {
      this.opts.logger.warn('queue', `队列已关闭，拒绝 chat ${chatKey} 新消息`);
      return false;
    }
    let q = this.chats.get(chatKey);
    if (q === undefined) { q = { chain: Promise.resolve(), depth: 0 }; this.chats.set(chatKey, q); }
    if (q.depth >= this.opts.maxPerChat) {
      this.opts.logger.warn('queue', `chat ${chatKey} 队列已满（${q.depth}），拒绝新消息`);
      return false;
    }
    q.depth += 1;
    q.chain = q.chain
      .then(() => {
        if (this.closedFlag) {
          this.opts.logger.warn('queue', `队列已关闭，丢弃 chat ${chatKey} 排队回合`);
          return;
        }
        return job();
      })
      .catch((err) => { this.opts.logger.error('queue', `chat ${chatKey} 回合失败: ${String(err)}`); })
      .finally(() => {
        const cur = this.chats.get(chatKey);
        if (cur === undefined) return;
        cur.depth -= 1;
        if (cur.depth === 0) this.chats.delete(chatKey); // 链空摘项防泄漏
      });
    return true;
  }
}
