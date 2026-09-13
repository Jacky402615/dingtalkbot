import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger.js';

export const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface TokenCache { key: string; accessToken: string; expiresAt: number } // key = clientId；expiresAt = epoch ms

export interface TokenManagerOptions {
  clientId: string;
  clientSecret: string;
  cacheFile: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  refreshMarginMs?: number;
  logger?: Logger;
}

export function normalizeExpiry(expireIn: number): number {
  // 文档歧义：v1.0 端点示意为毫秒（7200000），旧语义为秒（7200）——smoke 实测后固化
  return expireIn > 200_000 ? expireIn : expireIn * 1_000;
}

export class TokenManager {
  private cache: TokenCache | null = null;
  private inflight: Promise<string> | null = null;
  private fetchCount = 0;
  private readonly cacheKey: string;

  constructor(private readonly opts: TokenManagerOptions) {
    this.cacheKey = opts.clientId; // 凭据指纹：换 app 不复用旧 token
  }

  get fetchCallCount(): number { return this.fetchCount; }

  async getAccessToken(): Promise<string> {
    const now = this.opts.now ?? Date.now;
    const margin = this.opts.refreshMarginMs ?? REFRESH_MARGIN_MS;
    if (this.cache && this.cache.key === this.cacheKey && this.cache.expiresAt - now() > margin) return this.cache.accessToken;
    this.inflight ??= this.resolveToken().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  invalidate(): void {
    this.cache = null;
    // 磁盘也必须清：否则下次 resolveToken 会把已失效 token 从磁盘"复活"
    try {
      rmSync(this.opts.cacheFile);
    } catch (err) {
      this.opts.logger?.warn('token', `invalidate 清理磁盘缓存失败: ${String(err)}`);
    }
  }

  private async resolveToken(): Promise<string> {
    const now = this.opts.now ?? Date.now;
    const margin = this.opts.refreshMarginMs ?? REFRESH_MARGIN_MS;
    const cached = this.readDisk();
    if (cached && cached.key === this.cacheKey && cached.expiresAt - now() > margin) {
      this.cache = cached;
      this.opts.logger?.debug('token', '命中磁盘缓存');
      return cached.accessToken;
    }
    const doFetch = this.opts.fetchFn ?? fetch;
    let resp: Response;
    try {
      resp = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appKey: this.opts.clientId, appSecret: this.opts.clientSecret }),
      });
    } catch (err) {
      throw new Error(`获取 access token 网络失败: ${String(err)}`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`获取 access token 失败: HTTP ${resp.status} ${body}`);
    }
    const data = (await resp.json().catch(() => null)) as { accessToken?: string; expireIn?: number } | null;
    if (!data || !data.accessToken || typeof data.expireIn !== 'number') {
      throw new Error(`获取 access token 失败: 响应缺字段 ${JSON.stringify(data)}`);
    }
    this.fetchCount += 1;
    const ttlMs = normalizeExpiry(data.expireIn);
    this.cache = { key: this.cacheKey, accessToken: data.accessToken, expiresAt: now() + ttlMs };
    this.writeDisk(this.cache);
    // TTL/expiry 落日志：live smoke 的 expireIn 单位验证位直接引用本行（不含凭据）
    this.opts.logger?.info('token', `token 已刷新 expireIn=${data.expireIn} → TTL=${ttlMs}ms expiresAt=${this.cache.expiresAt}`);
    return data.accessToken;
  }

  private readDisk(): TokenCache | null {
    try {
      if (!existsSync(this.opts.cacheFile)) return null;
      const c = JSON.parse(readFileSync(this.opts.cacheFile, 'utf8')) as TokenCache;
      return typeof c.accessToken === 'string' && typeof c.expiresAt === 'number' && typeof c.key === 'string' ? c : null;
    } catch {
      return null;
    }
  }

  private writeDisk(cache: TokenCache): void {
    try {
      mkdirSync(dirname(this.opts.cacheFile), { recursive: true });
      const tmp = `${this.opts.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
      renameSync(tmp, this.opts.cacheFile);
      chmodSync(this.opts.cacheFile, 0o600); // rename 到已存在路径不继承权限位——显式收紧
    } catch (err) {
      this.opts.logger?.warn('token', `token 磁盘缓存写入失败（降级仅内存）: ${String(err)}`);
    }
  }
}
