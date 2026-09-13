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
      let resp: Response;
      try {
        // token 获取与 abort 竞速——媒体 30s deadline 可打断挂起的 token 请求（G1）
        const token = await Promise.race([
          this.opts.tokenManager.getAccessToken(),
          new Promise<never>((_, rej) => {
            if (sig.aborted) { rej(new Error('网络错误')); return; }
            sig.addEventListener('abort', () => rej(new Error('网络错误')), { once: true });
          }),
        ]);
        resp = await doFetch(base + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
          body: JSON.stringify({ downloadCode, robotCode }),
          signal: sig,
        });
      } catch {
        // G7 fail-safe：网络异常文本可能含 URL/连接细节——就地泛化，绝不透传原始串
        throw new Error('网络错误');
      }
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
      // 此处 err 均为自有安全文案（HTTP <n>/网络错误/响应…/超时）——可安全入日志（G7）
      const e = new Error(`OpenAPI ${path} 失败: ${String((err as Error)?.message ?? err)}`);
      this.opts.logger?.error('media-api', e.message);
      throw e;
    }
  }
}
