import type { Logger } from '../logger.js';

export interface TurnQueueOptions { maxPerChat: number; logger: Logger }

interface ChatQueue { chain: Promise<void>; depth: number; running: number }

export class TurnQueue {
  private readonly chats = new Map<string, ChatQueue>();
  private closedFlag = false;

  constructor(private readonly opts: TurnQueueOptions) {}

  get closed(): boolean { return this.closedFlag; }

  close(): void { this.closedFlag = true; }

  depthOf(chatKey: string): number { return this.chats.get(chatKey)?.depth ?? 0; }

  // 在飞 job 数（含 bridge.start 等尚未 spawn runner 的窗口——/stop 判"有无在飞"用，D3）
  runningCountOf(chatKey: string): number { return this.chats.get(chatKey)?.running ?? 0; }

  // 仅"排队未开始"的深度（在飞回合的收尾不计入）——/stop 终报的排队披露用（D3）
  queuedDepthOf(chatKey: string): number {
    const q = this.chats.get(chatKey);
    return q === undefined ? 0 : Math.max(0, q.depth - q.running);
  }

  waitIdle(chatKey: string): Promise<void> { return this.chats.get(chatKey)?.chain ?? Promise.resolve(); }

  // 等待全部在飞回合的外围 job 收尾（bridge.fail/持久化等）；close 丢弃的排队回合链会快速自了
  drainActive(): Promise<void> {
    return Promise.all([...this.chats.values()].map((c) => c.chain)).then(() => {});
  }

  enqueue(chatKey: string, job: () => Promise<void>): boolean {
    if (this.closedFlag) {
      this.opts.logger.warn('queue', `队列已关闭，拒绝 chat ${chatKey} 新消息`);
      return false;
    }
    let q = this.chats.get(chatKey);
    if (q === undefined) { q = { chain: Promise.resolve(), depth: 0, running: 0 }; this.chats.set(chatKey, q); }
    if (q.depth >= this.opts.maxPerChat) {
      this.opts.logger.warn('queue', `chat ${chatKey} 队列已满（${q.depth}），拒绝新消息`);
      return false;
    }
    q.depth += 1;
    const entry = q;
    entry.chain = entry.chain
      .then(() => {
        if (this.closedFlag) {
          this.opts.logger.warn('queue', `队列已关闭，丢弃 chat ${chatKey} 排队回合`);
          return;
        }
        entry.running += 1; // 在飞计数先于 job（job 内 bridge 收尾期间 depth 仍含本回合）
        return job();
      })
      .catch((err) => { this.opts.logger.error('queue', `chat ${chatKey} 回合失败: ${String(err)}`); })
      .finally(() => {
        if (entry.running > 0) entry.running -= 1;
        const cur = this.chats.get(chatKey);
        if (cur === undefined) return;
        cur.depth -= 1;
        if (cur.depth === 0) this.chats.delete(chatKey); // 链空摘项防泄漏
      });
    return true;
  }
}
