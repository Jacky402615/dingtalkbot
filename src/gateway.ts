import type { DingtalkTransport, MessageHandler, TransportState } from './transport/types.js';
import type { Logger } from './logger.js';
import { writeStateJson, type ConnectionStateSnapshot } from './state.js';

export interface GatewayDeps {
  transport: DingtalkTransport;
  logger: Logger;
  stateFile: string;
  pid: number;
  startedAt: string;
  handler?: MessageHandler;
}

export class Gateway {
  constructor(private readonly deps: GatewayDeps) {}

  async start(): Promise<void> {
    if (this.deps.handler) this.deps.transport.onMessage(this.deps.handler);
    this.deps.transport.onStateChange((state, detail) => this.snapshot(state, detail));
    this.snapshot('starting', 'gateway 启动');
    try {
      await this.deps.transport.start(); // 响亮失败（AC1）
    } catch (err) {
      await this.stop(); // 失败也走完整清理（不留活动 socket/定时器）
      throw err;
    }
  }

  private snapshot(state: TransportState, detail: string): void {
    const snap: ConnectionStateSnapshot = {
      pid: this.deps.pid, startedAt: this.deps.startedAt, transport: state, detail,
      updatedAt: new Date().toISOString(),
    };
    try {
      writeStateJson(this.deps.stateFile, snap);
    } catch (err) {
      this.deps.logger.error('gateway', `state.json 写入失败（继续运行）: ${String(err)}`);
    }
    this.deps.logger.info('gateway', `transport=${state} ${detail}`);
  }

  async stop(): Promise<void> {
    try {
      await this.deps.transport.stop();
    } catch (err) {
      this.deps.logger.error('gateway', `transport 停止出错（继续）: ${String(err)}`);
    }
    this.snapshot('stopped', 'gateway 停止');
  }
}
