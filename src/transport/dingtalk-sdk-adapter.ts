import { DWClient, EventAck, TOPIC_ROBOT } from 'dingtalk-stream';
import type { DingtalkTransport, MessageHandler, StateListener, TransportOptions, TransportState } from './types.js';
import { normalizeRobotMessage } from './types.js';

export class TransportStartError extends Error {}
export class TransportStoppedError extends Error {}

export interface DWClientDownStreamLike { headers: { messageId: string; topic: string }; data: string }

export interface DwClientLike {
  config: { autoReconnect?: boolean };
  connected: boolean;
  registered: boolean;
  socket: { on(event: string, cb: (...args: unknown[]) => void): void } | null;
  registerCallbackListener(topic: string, cb: (downstream: DWClientDownStreamLike) => void): unknown;
  socketCallBackResponse(messageId: string, result: unknown): void;
  connect(): Promise<void>;
  disconnect(): void;
}

export type DwClientFactory = (opts: { clientId: string; clientSecret: string }) => DwClientLike;

// SDK 的 socket 在 .d.ts 中声明为 private（运行时为公有字段）——结构不兼容，
// 在此唯一收口点做显式 cast；adapter 内部一律经由 DwClientLike 访问。
export const defaultDwClientFactory: DwClientFactory = (opts) =>
  new DWClient({ clientId: opts.clientId, clientSecret: opts.clientSecret, keepAlive: true }) as unknown as DwClientLike;

export interface AdapterOptions extends TransportOptions { clientFactory?: DwClientFactory }

export class DingtalkSdkTransport implements DingtalkTransport {
  private handler: MessageHandler | null = null;
  private stateListener: StateListener | null = null;
  private state: TransportState = 'stopped';
  private stopped = true;
  private client: DwClientLike | null = null;
  private firstReject: ((err: Error) => void) | null = null; // stop() 用它结算当前未决的 start()
  private dropSignal: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0; // supervisor 代际：stop()/restart() 使旧代循环就地退出，不复活

  constructor(private readonly opts: AdapterOptions) {}

  getState(): TransportState { return this.state; }

  onMessage(handler: MessageHandler): void { this.handler = handler; }
  onStateChange(listener: StateListener): void { this.stateListener = listener; }

  private setState(state: TransportState, detail: string): void {
    this.state = state;
    this.opts.logger.info('transport', `state=${state} ${detail}`);
    this.stateListener?.(state, detail);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    const factory = this.opts.clientFactory ?? defaultDwClientFactory;
    const client = this.initClient(factory); // autoReconnect 关闭 + 回调注册（decisions D2，单一初始化路径）
    this.client = client;
    this.stopped = false;
    this.generation += 1;
    const gen = this.generation;
    let resolveFirst!: () => void;
    let rejectFirst!: (err: Error) => void;
    const first = new Promise<void>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    this.firstReject = (err) => rejectFirst(err); // stop() 结算的是"当前未决"的 start
    // settle 按代闭包传递：旧代 supervisor 只能结算自己那代（已结算的 Promise 再结算为 no-op）
    void this.supervise(client, gen, resolveFirst, rejectFirst, factory);
    return first;
  }

  private initClient(factory: DwClientFactory): DwClientLike {
    const client = factory({ clientId: this.opts.clientId, clientSecret: this.opts.clientSecret });
    client.config.autoReconnect = false;
    client.registerCallbackListener(TOPIC_ROBOT, (downstream) => { void this.handleDownstream(downstream, client); });
    return client;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1; // 旧代 supervisor（可能挂在 withTimeout/退避上）随后自行退出
    if (this.timer !== null) clearTimeout(this.timer);
    this.dropSignal?.(); // 唤醒 watchdog 等待
    try { this.client?.disconnect(); } catch (err) { this.opts.logger.error('transport', `disconnect 出错（继续）: ${String(err)}`); }
    const err = new TransportStoppedError('transport 已被 stop()');
    this.firstReject?.(err); // 结算未决的 start()，防悬挂
    this.firstReject = null;
    this.setState('stopped', 'stop() 调用');
    this.client = null;
  }

  private defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => { this.timer = setTimeout(() => { this.timer = null; resolve(); }, ms); });
  }

  private watchSocket(client: DwClientLike): void {
    try {
      const socket = client.socket; // 代际守卫：旧 socket / 旧 client 的迟到事件不唤醒新连接
      if (socket === null) return;
      const current = (): boolean => this.client === client && client.socket === socket;
      socket.on('close', () => { if (current()) this.dropSignal?.(); }); // 立即唤醒重连
      socket.on('error', (err) => {
        this.opts.logger.error('transport', `socket error: ${String(err)}`);
        if (current()) this.dropSignal?.(); // SDK terminate→close 兜底外再显式唤醒
      });
    } catch (err) {
      this.opts.logger.warn('transport', `socket 监听挂载失败（仅靠 watchdog 轮询）: ${String(err)}`);
    }
  }

  private withTimeout(promise: Promise<void>, ms: number, label: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
      promise.then(() => { clearTimeout(timer); resolve(); }, (err) => { clearTimeout(timer); reject(err); });
    });
  }

  private async supervise(client: DwClientLike, gen: number, resolveFirst: () => void, rejectFirst: (err: Error) => void, factory: DwClientFactory): Promise<void> {
    const startTimeoutMs = this.opts.startTimeoutMs ?? 30_000;
    const registeredWaitMs = this.opts.registeredWaitMs ?? 5_000;
    const baseMs = this.opts.backoffBaseMs ?? 1_000;
    const capMs = this.opts.backoffCapMs ?? 60_000;
    const pollMs = this.opts.watchdogPollMs ?? 500;
    const attemptTimeoutMs = this.opts.connectAttemptTimeoutMs ?? 30_000; // 挂起的 connect 不得 wedge 监督
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ? (ms: number) => this.opts.sleep!(ms) : (ms: number) => this.defaultSleep(ms);
    const alive = (): boolean => !this.stopped && this.generation === gen; // 代际守卫：旧 supervisor 不得复活
    const deadline = now() + startTimeoutMs; // 仅约束首次注册（AC3：运行期永续）
    let firstRegisteredDone = false;
    let attempt = 0;
    this.setState('starting', `首次连接 deadline=${startTimeoutMs}ms`);
    while (alive()) {
      try {
        // SDK 的 connect() 永不 reject 且内部 axios 无超时——必须外部设限。
        // 首次阶段与 start deadline 赛跑；运行期（已注册过）用固定 per-attempt 上限。
        const timeoutMs = firstRegisteredDone
          ? attemptTimeoutMs
          : Math.min(attemptTimeoutMs, Math.max(1, deadline - now()));
        await this.withTimeout(client.connect(), timeoutMs, 'connect()');
      } catch (err) {
        this.opts.logger.error('transport', `connect() 失败/超时（监督循环继续）: ${String(err)}`);
        // 序列化尝试：废弃半途连接的残留 socket/状态；废弃失败则重建 client（同代续用）
        try {
          client.disconnect();
        } catch (dErr) {
          this.opts.logger.error('transport', `废弃超时尝试时 disconnect 失败，重建 client: ${String(dErr)}`);
          try {
            client = this.initClient(factory);
            this.client = client;
          } catch (rErr) {
            this.opts.logger.error('transport', `重建 client 失败，本代监督终止: ${String(rErr)}`);
            rejectFirst(new TransportStartError(`无法恢复的连接状态（重建 client 失败）: ${String(rErr)}`));
            return;
          }
        }
      }
      if (!alive()) return; // stop/重启：本代 supervisor 就地退出
      this.watchSocket(client);
      const ok = await this.waitForRegistered(client, registeredWaitMs, now);
      if (!alive()) return; // 等待注册期间被 stop/重启：迟到的注册不得结算新代
      // 首次注册也受 deadline 约束：迟到（在 registeredWaitMs 内完成但已过线）同样响亮失败
      if (ok && (firstRegisteredDone || now() < deadline)) {
        firstRegisteredDone = true;
        attempt = 0;
        this.setState('connected', '已连接并订阅');
        resolveFirst();
        await this.awaitDrop(client, pollMs); // socket close 信号优先；轮询双保险
        if (!alive()) return;
        this.setState('reconnecting', '检测到断线');
      } else if (!firstRegisteredDone && now() >= deadline) {
        const detail = `启动超时 ${startTimeoutMs}ms：connected=${client.connected} registered=${client.registered}`;
        this.opts.logger.error('transport', `启动失败（响亮失败）: ${detail}`);
        this.setState('stopped', detail);
        this.stopped = true;
        try { client.disconnect(); } catch { /* 已断 */ }
        rejectFirst(new TransportStartError(`dingtalk-stream 连接超时: ${detail}`));
        return;
      }
      attempt += 1;
      const delay = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      this.setState('reconnecting', `attempt=${attempt}，${delay}ms 后重连`);
      await sleep(delay);
    }
  }

  private async awaitDrop(client: DwClientLike, pollMs: number): Promise<void> {
    let signal: () => void = () => {};
    const dropped = new Promise<void>((r) => { signal = r; });
    this.dropSignal = signal;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      while (!this.stopped && client.connected && client.registered) {
        await Promise.race([
          dropped,
          new Promise<void>((r) => { pollTimer = setTimeout(() => r(), pollMs); }),
        ]);
        if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; } // 输了的轮询定时器必须清（防悬挂）
      }
    } finally {
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (this.dropSignal === signal) this.dropSignal = null;
    }
  }

  private async waitForRegistered(client: DwClientLike, waitMs: number, now: () => number): Promise<boolean> {
    const end = now() + waitMs;
    for (;;) {
      if (this.stopped) return false;
      if (client.registered && client.connected) return true;
      if (!client.connected || now() >= end) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private async handleDownstream(downstream: DWClientDownStreamLike, owner: DwClientLike): Promise<void> {
    const messageId = downstream?.headers?.messageId ?? '';
    const ack = (message: string) => {
      if (this.client !== owner) {
        // stop/换代后迟到的消息：绝不向新连接发旧 messageId 的 ack，也不静默
        this.opts.logger.warn('transport', `ack 丢弃（transport 已换代）: messageId=${messageId}`);
        return;
      }
      try {
        owner.socketCallBackResponse(messageId, { status: EventAck.SUCCESS, message });
      } catch (err) {
        this.opts.logger.error('transport', `ack 发送失败: ${String(err)}`);
      }
    };
    let payload: unknown;
    try {
      payload = JSON.parse(downstream?.data ?? '');
    } catch (err) {
      this.opts.logger.error('transport', `消息 data JSON 解析失败（丢弃并 ack）: ${String(err)}`);
      ack('parse-error');
      return;
    }
    const msg = normalizeRobotMessage(payload);
    if (msg === null) {
      this.opts.logger.warn('transport', '消息载荷非对象（丢弃并 ack）');
      ack('bad-payload');
      return;
    }
    this.opts.logger.info('transport', `收到消息 msgId=${msg.msgId || '?'} kind=${msg.conversationKind} msgtype=${msg.msgtype} sender=${msg.senderStaffId || '?'}`);
    const maxAttempts = this.opts.maxHandlerAttempts ?? 3;
    const retryDelay = this.opts.handlerRetryDelayMs ?? 500;
    for (let a = 1; a <= maxAttempts; a++) {
      try {
        await this.handler?.(msg);
        ack('OK');
        return;
      } catch (err) {
        this.opts.logger.error('transport', `handler 第 ${a}/${maxAttempts} 次失败: ${String(err)}`);
        if (a < maxAttempts) await new Promise((r) => setTimeout(r, retryDelay * a));
      }
    }
    this.opts.logger.error('transport', `handler 全部 ${maxAttempts} 次失败，丢弃并 ack（避免服务端 60s 重推）`);
    ack('handler-failed');
  }
}
