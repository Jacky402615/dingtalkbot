import type { Logger } from '../logger.js';
import type { TokenManager } from './token.js';

export const API_BASE = 'https://api.dingtalk.com';

export interface RobotReplyerOptions {
  tokenManager: TokenManager;
  logger?: Logger;
  fetchFn?: typeof fetch;
  apiBase?: string;
  requestTimeoutMs?: number; // default 15_000：挂起的回复请求不得卡死消息处理（60s ack 窗口）
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class RobotReplyer {
  constructor(private readonly opts: RobotReplyerOptions) {}

  private async post(path: string, body: unknown): Promise<void> {
    const doFetch = this.opts.fetchFn ?? fetch;
    const base = this.opts.apiBase ?? API_BASE;
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const token = await this.opts.tokenManager.getAccessToken();
    let resp: Response;
    try {
      resp = await Promise.race([
        doFetch(base + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs), // 真实 fetch 的中断；race 兜底忽略 signal 的实现
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`OpenAPI ${path} 请求超时 ${timeoutMs}ms`)), timeoutMs)),
      ]);
    } catch (err) {
      const e = new Error(`OpenAPI ${path} 网络失败: ${String(err)}`);
      this.opts.logger?.error('reply', e.message);
      throw e;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const e = new Error(`OpenAPI ${path} 失败: HTTP ${resp.status} ${text}`);
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
