// msgId 去重（D3 D10）：reserve = 同步 check+add，必须在任何 await 之前完成——
// 单线程事件循环内服务端重推无竞态窗口；送达/入队失败路径 release 撤销占位，
// transport 局部重试可重入（语义等同 D2 的"送达成功才记"，但无 await 间隙）。
export class MsgIdDedupe {
  private readonly seen = new Set<string>();

  constructor(private readonly cap = 500) {}

  reserve(msgId: string): boolean {
    if (this.seen.has(msgId)) return false;
    this.seen.add(msgId);
    if (this.seen.size > this.cap) {
      const oldest = this.seen.values().next().value; // Set 保持插入序
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  release(msgId: string): void {
    this.seen.delete(msgId);
  }
}
