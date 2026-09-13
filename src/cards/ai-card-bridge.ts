import type { CardClient } from '../openapi/card.js';
import type { RobotReplyer } from '../openapi/robot.js';
import type { InboundRobotMessage } from '../transport/types.js';
import type { Logger } from '../logger.js';
import { StreamThrottle } from './stream-throttle.js';

const MAX_CONTENT_CHARS = 30_000;
const FALLBACK_TITLE = 'dingtalkbot';

export interface AiCardBridgeDeps {
  cardClient: CardClient;
  replyer: RobotReplyer;
  logger: Logger;
  msg: InboundRobotMessage;
  templateId: string;
  contentKey: string;
  minIntervalMs: number;
  minBytes: number;
  now?: () => number;
}

type BridgeState = 'unstarted' | 'streaming' | 'markdownOnly' | 'dead';

export class AiCardBridge {
  private state: BridgeState = 'unstarted';
  private outTrackId: string | null = null;
  private readonly throttle: StreamThrottle;
  private lastFlushedContent = '';
  private fallbackSent = false;
  private flushCount = 0;
  private suppressedTotal = 0;
  private truncatedWarned = false;
  private readonly startedAt: number;
  private lastFlushAt: number;

  constructor(private readonly deps: AiCardBridgeDeps) {
    this.throttle = new StreamThrottle({ minIntervalMs: deps.minIntervalMs, minBytes: deps.minBytes, now: deps.now });
    this.startedAt = (deps.now ?? Date.now)();
    this.lastFlushAt = this.startedAt;
  }

  get alive(): boolean { return this.state === 'streaming'; }

  get flushes(): number { return this.flushCount; }

  get suppressed(): number { return this.suppressedTotal; }

  private clamp(text: string): string {
    if (text.length <= MAX_CONTENT_CHARS) return text;
    if (!this.truncatedWarned) {
      this.truncatedWarned = true;
      this.deps.logger.warn('card', `回复超长（${text.length} 字符），卡片内容截断至 ${MAX_CONTENT_CHARS}`);
    }
    return text.slice(0, MAX_CONTENT_CHARS) + '…（超长截断）';
  }

  async start(): Promise<void> {
    if (this.state !== 'unstarted') return;
    if (this.deps.templateId === '') {
      this.state = 'markdownOnly';
      this.deps.logger.info('card', '未配置 ai_card_template_id —— 本回合以纯 markdown 输出');
      return;
    }
    try {
      this.outTrackId = await this.deps.cardClient.createAndDeliver({
        templateId: this.deps.templateId,
        contentKey: this.deps.contentKey,
        target: {
          kind: this.deps.msg.conversationKind === 'group' ? 'group' : 'p2p',
          conversationId: this.deps.msg.conversationId,
          senderStaffId: this.deps.msg.senderStaffId,
          robotCode: this.deps.msg.robotCode,
        },
      });
      this.state = 'streaming';
    } catch (err) {
      this.deps.logger.error('card', `AI 卡创建失败，本回合降级 markdown 回退: ${String(err)}`);
      this.state = 'dead';
    }
  }

  async pushText(full: string): Promise<void> {
    if (this.state !== 'streaming') return;
    const clamped = this.clamp(full);
    const newBytes = Buffer.byteLength(clamped) - Buffer.byteLength(this.lastFlushedContent);
    if (!this.throttle.shouldFlush(newBytes)) return; // 双阈值不达标：抑制（finalize 恒全量兜底，无数据丢失）
    const intervalStart = (this.deps.now ?? Date.now)();
    const intervalMs = intervalStart - this.lastFlushAt; // 距上次 flush（首次距回合开始）
    try {
      await this.deps.cardClient.streamingUpdate({
        outTrackId: this.outTrackId!, contentKey: this.deps.contentKey, content: clamped, finalize: false,
      });
    } catch (err) {
      this.deps.logger.error('card', `AI 卡流式更新失败（停更，尽力 isError 收终）: ${String(err)}`);
      await this.tryErrorFinalize(clamped);
      return;
    }
    this.flushCount += 1;
    const suppressed = this.throttle.suppressedSinceFlush;
    this.suppressedTotal += suppressed;
    this.lastFlushedContent = clamped;
    this.throttle.markFlushed();
    this.lastFlushAt = intervalStart;
    this.deps.logger.info('card', `卡片流式 bytes=${Buffer.byteLength(clamped)} delta=${newBytes} intervalMs=${intervalMs} suppressed=${suppressed}`);
  }

  private async tryErrorFinalize(content: string): Promise<void> {
    try {
      await this.deps.cardClient.streamingUpdate({
        outTrackId: this.outTrackId!, contentKey: this.deps.contentKey, content, finalize: true, error: true,
      });
      this.deps.logger.info('card', '流式失败后已 isError 收终（半成品卡可见终止态）');
    } catch (err) {
      this.deps.logger.error('card', `isError 收终失败（接受残留半成品卡，终态由 markdown 回退承担）: ${String(err)}`);
    }
    this.state = 'dead';
  }

  async finish(finalFull: string): Promise<void> {
    const clamped = this.clamp(finalFull);
    if (this.state !== 'streaming') {
      await this.sendFallbackMarkdown(clamped);
      return;
    }
    try {
      await this.deps.cardClient.streamingUpdate({
        outTrackId: this.outTrackId!, contentKey: this.deps.contentKey, content: clamped, finalize: true, error: false,
      });
      this.deps.logger.info('card', `卡片收终 bytes=${Buffer.byteLength(clamped)} flushes=${this.flushCount} suppressed=${this.suppressedTotal}`);
    } catch (err) {
      this.deps.logger.error('card', `AI 卡收终失败（降级 markdown 回退）: ${String(err)}`);
      this.state = 'dead';
      await this.sendFallbackMarkdown(clamped);
    }
  }

  async fail(errorText: string, partialText?: string): Promise<void> {
    const content = this.clamp(`回复中断：${errorText}${partialText !== undefined && partialText !== '' ? `\n\n${partialText}` : ''}`);
    if (this.state === 'streaming') {
      try {
        await this.deps.cardClient.streamingUpdate({
          outTrackId: this.outTrackId!, contentKey: this.deps.contentKey, content, finalize: true, error: true,
        });
        return;
      } catch (err) {
        this.deps.logger.error('card', `isError 收终失败（降级 markdown 回退）: ${String(err)}`);
      }
    }
    this.state = 'dead';
    await this.sendFallbackMarkdown(content);
  }

  private async sendFallbackMarkdown(text: string): Promise<void> {
    if (this.fallbackSent) return; // 恰好一次
    this.fallbackSent = true;
    try {
      if (this.deps.msg.conversationKind === 'p2p') {
        await this.deps.replyer.sendOtoMarkdown(this.deps.msg.robotCode, [this.deps.msg.senderStaffId], FALLBACK_TITLE, text);
      } else {
        await this.deps.replyer.sendGroupMarkdown(this.deps.msg.robotCode, this.deps.msg.conversationId, FALLBACK_TITLE, text);
      }
      this.deps.logger.info('card', 'markdown 回退已发送（恰好一条）');
    } catch (err) {
      this.deps.logger.error('card', `markdown 回退发送失败（通道穷尽，响亮留痕）: ${String(err)}`);
    }
  }
}
