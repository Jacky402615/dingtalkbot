import type { Logger } from '../logger.js';
import type { TokenManager } from './token.js';

export const API_BASE = 'https://api.dingtalk.com';

export interface RobotReplyerOptions {
  tokenManager: TokenManager;
  logger?: Logger;
  fetchFn?: typeof fetch;
  apiBase?: string;
}

export class RobotReplyer {
  constructor(private readonly opts: RobotReplyerOptions) {}

  private async post(path: string, body: unknown): Promise<void> {
    const doFetch = this.opts.fetchFn ?? fetch;
    const base = this.opts.apiBase ?? API_BASE;
    const token = await this.opts.tokenManager.getAccessToken();
    let resp: Response;
    try {
      resp = await doFetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify(body),
      });
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
