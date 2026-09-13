import type { Logger } from '../logger.js';
import type { TokenManager } from './token.js';
import { withDeadline } from '../deadline.js';
import { API_BASE } from './robot.js';

export interface MediaClientOptions {
  tokenManager: TokenManager;
  logger?: Logger;
  fetchFn?: typeof fetch;
  apiBase?: string;
  requestTimeoutMs?: number; // 默认 10s——仅在外部 signal 缺席时兜底；服务层 30s 总 deadline 经 signal 覆盖
}

// 下载机器人接收消息的文件内容（D4）：downloadCode → 临时下载 URL。
// 注意：错误日志/抛错不携带 downloadCode（G7 脱敏）——只含路径与状态。
export class MediaClient {
  constructor(private readonly opts: MediaClientOptions) {}

  async exchangeDownloadUrl(robotCode: string, downloadCode: string, signal?: AbortSignal): Promise<string> {
    const doFetch = this.opts.fetchFn ?? fetch;
    const base = this.opts.apiBase ?? API_BASE;
    const path = '/v1.0/robot/messageFiles/download';
    const invoke = async (sig: AbortSignal): Promise<string> => {
      const resp = await doFetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': await this.opts.tokenManager.getAccessToken() },
        body: JSON.stringify({ downloadCode, robotCode }),
        signal: sig,
      });
      if (!resp.ok) {
        // G7：不读错误体（可能含平台回显标识/URL）——只保留状态码，服务层映射安全文案
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = await resp.json().catch(() => { throw new Error('响应体非 JSON'); }) as { downloadUrl?: unknown };
      if (typeof data.downloadUrl !== 'string' || data.downloadUrl === '') throw new Error('响应缺少 downloadUrl');
      return data.downloadUrl;
    };
    try {
      return signal !== undefined ? await invoke(signal)
        : await withDeadline(`OpenAPI ${path}`, this.opts.requestTimeoutMs ?? 10_000, invoke);
    } catch (err) {
      // G7：错误日志只含阶段与路径——绝无响应体/downloadCode/URL
      const e = new Error(`OpenAPI ${path} 失败: ${String(err)}`);
      this.opts.logger?.error('media-api', e.message);
      throw e;
    }
  }
}
