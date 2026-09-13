import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { TokenManager } from './token.js';
import { withDeadline } from '../deadline.js';
import { API_BASE } from './robot.js';

export interface CardTarget { kind: 'p2p' | 'group'; conversationId: string; senderStaffId: string; robotCode: string }

export interface CardClientOptions { tokenManager: TokenManager; logger?: Logger; fetchFn?: typeof fetch; apiBase?: string; requestTimeoutMs?: number }

export class CardClient {
  constructor(private readonly opts: CardClientOptions) {}

  private async request(method: 'POST' | 'PUT', path: string, body: unknown): Promise<void> {
    const doFetch = this.opts.fetchFn ?? fetch;
    const base = this.opts.apiBase ?? API_BASE;
    const timeoutMs = this.opts.requestTimeoutMs ?? 10_000;
    const token = await this.opts.tokenManager.getAccessToken();
    try {
      await withDeadline(`OpenAPI ${method} ${path}`, timeoutMs, async (signal) => {
        const resp = await doFetch(base + path, {
          method,
          headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
          body: JSON.stringify(body),
          signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch((e) => `（错误体读取失败: ${String(e)}）`);
          throw new Error(`HTTP ${resp.status} ${text}`);
        }
      });
    } catch (err) {
      const e = new Error(`OpenAPI ${path} 失败: ${String(err)}`);
      this.opts.logger?.error('card', e.message);
      throw e;
    }
  }

  async createAndDeliver(args: { templateId: string; contentKey: string; target: CardTarget }): Promise<string> {
    const outTrackId = randomUUID();
    const body: Record<string, unknown> = {
      cardTemplateId: args.templateId,
      outTrackId,
      cardData: { cardParamMap: { [args.contentKey]: '' } },
      callbackType: 'STREAM',
    };
    if (args.target.kind === 'group') {
      body.openSpaceId = `dtv1.card//IM_GROUP.${args.target.conversationId}`;
      body.imGroupOpenDeliverModel = { robotCode: args.target.robotCode };
    } else {
      body.openSpaceId = `dtv1.card//IM_ROBOT.${args.target.senderStaffId}`;
      body.imRobotOpenDeliverModel = { spaceType: 'IM_ROBOT' };
    }
    await this.request('POST', '/v1.0/card/instances/createAndDeliver', body);
    return outTrackId;
  }

  async streamingUpdate(args: { outTrackId: string; contentKey: string; content: string; finalize: boolean; error?: boolean }): Promise<void> {
    await this.request('PUT', '/v1.0/card/streaming', {
      outTrackId: args.outTrackId,
      guid: randomUUID(),
      key: args.contentKey,
      content: args.content,
      isFull: true,
      isFinalize: args.finalize,
      isError: args.error ?? false,
    });
  }
}
