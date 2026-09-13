export interface StreamThrottleOptions { minIntervalMs: number; minBytes: number; now?: () => number }

export class StreamThrottle {
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private suppressed = 0;

  constructor(private readonly opts: StreamThrottleOptions) {}

  shouldFlush(newBytes: number): boolean {
    const now = (this.opts.now ?? Date.now)();
    const ok = now - this.lastFlushAt >= this.opts.minIntervalMs && newBytes >= this.opts.minBytes;
    if (!ok) this.suppressed += 1;
    return ok;
  }

  markFlushed(): void {
    this.lastFlushAt = (this.opts.now ?? Date.now)();
    this.suppressed = 0;
  }

  get suppressedSinceFlush(): number { return this.suppressed; }
}
