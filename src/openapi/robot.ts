import type { Logger } from '../logger.js';
import type { TokenManager } from './token.js';
import { withDeadline } from '../deadline.js';

export const API_BASE = 'https://api.dingtalk.com';

export interface RobotReplyerOptions {
  tokenManager: TokenManager;
  logger?: Logger;
  fetchFn?: typeof fetch;
  apiBase?: string;
  requestTimeoutMs?: number; // default 10_000：挂起的回复请求不得卡死消息处理（60s ack 窗口预算）
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class RobotReplyer {
  constructor(private readonly opts: RobotReplyerOptions) {}

  private async post(path: string, body: unknown): Promise<void> {
    const doFetch = this.opts.fetchFn ?? fetch;
    const base = this.opts.apiBase ?? API_BASE;
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const token = await this.opts.tokenManager.getAccessToken();
    try {
      // deadline 覆盖 fetch + body 读取
      await withDeadline(`OpenAPI ${path}`, timeoutMs, async (signal) => {
        const resp = await doFetch(base + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
          body: JSON.stringify(body),
          signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(`HTTP ${resp.status} ${text}`);
        }
      });
    } catch (err) {
      const e = new Error(`OpenAPI ${path} 失败: ${String(err)}`);
      this.opts.logger?.error('reply', e.message);
      throw e;
    }
  }

  async sendOtoMarkdown(robotCode: string, userIds: string[], title: string, text: string): Promise<void> {
    await this.post('/v1.0/robot/oToMessages/batchSend', {
      robotCode, userIds, msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title, text }),
    });
  }

  async sendGroupMarkdown(robotCode: string, openConversationId: string, title: string, text: string): Promise<void> {
    await this.post('/v1.0/robot/groupMessages/send', {
      robotCode, openConversationId, msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title, text }),
    });
  }
}
