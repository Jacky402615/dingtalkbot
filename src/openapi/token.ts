import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger.js';
import { withDeadline } from '../deadline.js';

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
  requestTimeoutMs?: number; // default 10_000：挂起的 token 请求不得卡死消息处理（60s ack 窗口预算）
  logger?: Logger;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export function normalizeExpiry(expireIn: number): number {
  // 文档歧义：v1.0 端点示意为毫秒（7200000），旧语义为秒（7200）——smoke 实测后固化
  return expireIn > 200_000 ? expireIn : expireIn * 1_000;
}

export class TokenManager {
  private cache: TokenCache | null = null;
  private inflight: Promise<string> | null = null;
  private fetchCount = 0;
  private invalidationGen = 0; // invalidate 与 in-flight 刷新的竞态防护
  private readonly cacheKey: string;

  constructor(private readonly opts: TokenManagerOptions) {
    this.cacheKey = opts.clientId; // 凭据指纹：换 app 不复用旧 token
  }

  get fetchCallCount(): number { return this.fetchCount; }

  async getAccessToken(): Promise<string> {
    const now = this.opts.now ?? Date.now;
    const margin = this.opts.refreshMarginMs ?? REFRESH_MARGIN_MS;
    if (this.cache && this.cache.key === this.cacheKey && this.cache.expiresAt - now() > margin) return this.cache.accessToken;
    if (this.inflight === null) {
      // finally 只在仍是"当前" in-flight 时清位：invalidate 脱离后的旧请求不得清掉新请求的槽位
      const promise = this.resolveToken().finally(() => { if (this.inflight === promise) this.inflight = null; });
      this.inflight = promise;
    }
    return this.inflight;
  }

  invalidate(): void {
    this.cache = null;
    this.invalidationGen += 1; // in-flight 刷新完成后不得再把结果写回缓存/磁盘
    this.inflight = null; // 脱离旧 in-flight：invalidate 之后的新调用必须发起新请求
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
    const gen = this.invalidationGen;
    const cached = this.readDisk();
    if (cached && cached.key === this.cacheKey && cached.expiresAt - now() > margin) {
      this.cache = cached;
      this.opts.logger?.debug('token', '命中磁盘缓存');
      return cached.accessToken;
    }
    const doFetch = this.opts.fetchFn ?? fetch;
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // deadline 覆盖 fetch + body 读取（headers 到达但 body 挂起同样超时）
    let data: { accessToken?: string; expireIn?: number } | null;
    try {
      data = await withDeadline('token 请求', timeoutMs, async (signal) => {
        const resp = await doFetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appKey: this.opts.clientId, appSecret: this.opts.clientSecret }),
          signal,
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(`HTTP ${resp.status} ${body}`);
        }
        return (await resp.json().catch(() => null)) as { accessToken?: string; expireIn?: number } | null;
      });
    } catch (err) {
      throw new Error(`获取 access token 失败: ${String(err)}`);
    }
    if (!data || !data.accessToken || typeof data.expireIn !== 'number') {
      throw new Error(`获取 access token 失败: 响应缺字段 ${JSON.stringify(data)}`);
    }
    this.fetchCount += 1;
    const ttlMs = normalizeExpiry(data.expireIn);
    if (gen !== this.invalidationGen) {
      // 等待期间被 invalidate：本次调用者仍拿到新 token，但不写回缓存/磁盘（防复活）
      this.opts.logger?.info('token', '刷新期间被 invalidate，结果不落缓存');
      return data.accessToken;
    }
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
    mkdirSync(dirname(this.opts.cacheFile), { recursive: true });
    // 独占创建（wx）：planted 的同名文件不可能收到 token 内容；每次用唯一名
    const tmp = `${this.opts.cacheFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      try {
        writeFileSync(tmp, JSON.stringify(cache), { flag: 'wx', mode: 0o600 });
      } catch (err) {
        throw new Error(`独占创建 tmp 失败（可能被抢占）: ${String(err)}`);
      }
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.opts.cacheFile);
      chmodSync(this.opts.cacheFile, 0o600); // rename 到已存在路径不继承权限位——显式收紧
    } catch (err) {
      try { if (existsSync(tmp)) rmSync(tmp); } catch (rmErr) { this.opts.logger?.error('token', `tmp 清理失败（可能残留可读临时文件）: ${tmp} ${String(rmErr)}`); }
      this.opts.logger?.warn('token', `token 磁盘缓存写入失败（降级仅内存）: ${String(err)}`);
    }
  }
}
