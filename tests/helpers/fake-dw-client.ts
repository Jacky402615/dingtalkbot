import { EventEmitter } from 'node:events';
import type { DwClientLike, DWClientDownStreamLike } from '../../src/transport/dingtalk-sdk-adapter.js';

export const ROBOT_TOPIC = '/v1.0/im/bot/messages/get';

export class FakeSocket {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, cb: (...args: unknown[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }
  emitClose(): void {
    for (const cb of this.listeners.get('close') ?? []) cb();
  }
}

export class FakeDwClient extends EventEmitter implements DwClientLike {
  config: { autoReconnect?: boolean } = { autoReconnect: true };
  connected = false;
  registered = false;
  socket: FakeSocket | null = null;
  connectCalls = 0;
  failNextConnects = 0;
  failForever = false;   // 永远连不上（坏凭据场景；避免有限次数被快速耗尽）
  hangConnects = 0;      // connect() 永不 resolve（挂起场景，验证 per-attempt 超时）
  disconnectThrows = false; // disconnect() 抛错（验证废弃失败后重建 client）
  registerDelayMs = 0;
  acks: Array<{ messageId: string; result: unknown }> = [];
  private seq = 0;

  registerCallbackListener(topic: string, cb: (d: DWClientDownStreamLike) => void): this {
    this.on(topic, cb as never);
    return this;
  }

  socketCallBackResponse(messageId: string, result: unknown): void {
    this.acks.push({ messageId, result });
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.hangConnects > 0) {
      this.hangConnects -= 1;
      await new Promise<void>(() => {}); // 永不 resolve
    }
    if (this.failForever || this.failNextConnects > 0) {
      if (!this.failForever) this.failNextConnects -= 1; // 模拟 SDK 吞掉连接失败：connect() 正常返回但没连上
      this.connected = false;
      this.registered = false;
      this.socket = null;
      return;
    }
    this.connected = true;
    this.socket = new FakeSocket();
    setTimeout(() => { if (this.connected) this.registered = true; }, this.registerDelayMs);
  }

  disconnect(): void {
    if (this.disconnectThrows) throw new Error('disconnect broken');
    this.connected = false;
    this.registered = false;
    this.socket?.emitClose();
    this.socket = null;
  }

  emitRobotMessage(data: unknown, messageId?: string): void {
    this.seq += 1;
    const mid = messageId ?? `msg-${this.seq}`;
    this.emit(ROBOT_TOPIC, { headers: { messageId: mid, topic: ROBOT_TOPIC }, data: typeof data === 'string' ? data : JSON.stringify(data) } as never);
  }

  killSocket(): void { // 模拟断线：boolean 翻转 + close 事件（真 SDK close 处理器同样置 false）
    this.connected = false;
    this.registered = false;
    this.socket?.emitClose();
    this.socket = null;
  }
}
