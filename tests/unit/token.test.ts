import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenManager, normalizeExpiry, TOKEN_URL } from '../../src/openapi/token.js';

function fakeFetch(tokens: Array<{ token: string; expireIn: number }>, log: Array<unknown>) {
  let call = 0;
  return (async (url: string, init?: RequestInit) => {
    log.push({ url, body: JSON.parse(String(init?.body)) });
    await new Promise((r) => setTimeout(r, 10)); // 制造并发窗口
    const t = tokens[Math.min(call, tokens.length - 1)];
    call += 1;
    return new Response(JSON.stringify({ accessToken: t.token, expireIn: t.expireIn }), { status: 200 });
  }) as unknown as typeof fetch;
}

test('normalizeExpiry: ms/s 归一', () => {
  expect(normalizeExpiry(7_200_000)).toBe(7_200_000);
  expect(normalizeExpiry(7_200)).toBe(7_200_000);
});

test('single-flight: 并发 5 个请求只打一次远端（AC4）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const calls: Array<{ url: string; body: { appKey: string } }> = [];
  const tm = new TokenManager({
    clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'),
    fetchFn: fakeFetch([{ token: 'T1', expireIn: 7_200 }], calls),
  });
  const got = await Promise.all([1, 2, 3, 4, 5].map(() => tm.getAccessToken()));
  expect(got).toEqual(['T1', 'T1', 'T1', 'T1', 'T1']);
  expect(tm.fetchCallCount).toBe(1);
  expect(calls[0].url).toBe(TOKEN_URL);
  expect(calls[0].body.appKey).toBe('ck');
});

test('内存缓存命中：余量内不重新 fetch；margin 之外刷新（AC4）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const calls: Array<unknown> = [];
  let clock = 1_000_000;
  const tm = new TokenManager({
    clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'),
    fetchFn: fakeFetch([{ token: 'T1', expireIn: 7_200 }, { token: 'T2', expireIn: 7_200 }], calls),
    now: () => clock,
  });
  expect(await tm.getAccessToken()).toBe('T1');
  clock += 1_000;
  expect(await tm.getAccessToken()).toBe('T1');
  expect(tm.fetchCallCount).toBe(1);
  clock += 7_200_000;
  expect(await tm.getAccessToken()).toBe('T2');
  expect(tm.fetchCallCount).toBe(2);
});

test('磁盘缓存：新实例命中旧缓存不 fetch；损坏 JSON 降级远端', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const cacheFile = join(dir, 'token.json');
  const calls: Array<unknown> = [];
  const t1 = new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile, fetchFn: fakeFetch([{ token: 'T1', expireIn: 7_200 }], calls) });
  await t1.getAccessToken();
  const t2 = new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile, fetchFn: fakeFetch([{ token: 'T2', expireIn: 7_200 }], calls) });
  expect(await t2.getAccessToken()).toBe('T1'); // 磁盘命中
  writeFileSync(cacheFile, '{bad');
  const t3 = new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile, fetchFn: fakeFetch([{ token: 'T3', expireIn: 7_200 }], calls) });
  expect(await t3.getAccessToken()).toBe('T3');
});

test('凭据轮换：换 clientId 后不复用旧 token（磁盘 key 不匹配即失效）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const cacheFile = join(dir, 'token.json');
  const calls: Array<unknown> = [];
  const t1 = new TokenManager({ clientId: 'ck-A', clientSecret: 'cs', cacheFile, fetchFn: fakeFetch([{ token: 'TA', expireIn: 7_200 }], calls) });
  await t1.getAccessToken();
  const t2 = new TokenManager({ clientId: 'ck-B', clientSecret: 'cs', cacheFile, fetchFn: fakeFetch([{ token: 'TB', expireIn: 7_200 }], calls) });
  expect(await t2.getAccessToken()).toBe('TB'); // 不复用 A 的 token
  expect(t2.fetchCallCount).toBe(1);
});

test('invalidate：内存+磁盘双清，下次必重取（旧 token 不从磁盘复活）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const cacheFile = join(dir, 'token.json');
  const calls: Array<unknown> = [];
  const tm = new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile, fetchFn: fakeFetch([{ token: 'T1', expireIn: 7_200 }, { token: 'T2', expireIn: 7_200 }], calls) });
  await tm.getAccessToken();
  tm.invalidate();
  expect(await tm.getAccessToken()).toBe('T2'); // 不是磁盘里的 T1
  expect(tm.fetchCallCount).toBe(2);
});

test('非 2xx：带响应体的响亮错误', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const tm = new TokenManager({
    clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'),
    fetchFn: (async () => new Response('{"code":"InvalidAuthentication","message":"bad"}', { status: 401 })) as unknown as typeof fetch,
  });
  await expect(tm.getAccessToken()).rejects.toThrow('InvalidAuthentication');
});

test('挂起的 token 请求按 requestTimeoutMs 响亮超时（不卡死消息处理）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const tm = new TokenManager({
    clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'),
    requestTimeoutMs: 40,
    fetchFn: (async () => new Promise<never>(() => {})) as unknown as typeof fetch, // 永不返回且忽略 signal
  });
  await expect(tm.getAccessToken()).rejects.toThrow(/超时/);
});

test('invalidate 与 in-flight 刷新竞态：结果不写回缓存（防复活）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const cacheFile = join(dir, 'token.json');
  const calls: Array<unknown> = [];
  const tm = new TokenManager({
    clientId: 'ck', clientSecret: 'cs', cacheFile,
    fetchFn: (async () => {
      calls.push(1);
      await new Promise((r) => setTimeout(r, 40)); // 刷新进行中触发 invalidate
      return new Response(JSON.stringify({ accessToken: 'T1', expireIn: 7_200 }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const inFlight = tm.getAccessToken();
  await new Promise((r) => setTimeout(r, 10));
  tm.invalidate(); // 刷新期间失效
  expect(await inFlight).toBe('T1'); // 发起方仍拿到结果
  expect(await tm.getAccessToken()).toBe('T1'); // 但缓存未采纳 → 重新 fetch（第二次调用）
  expect(calls).toHaveLength(2);
  expect(tm.fetchCallCount).toBe(2);
});
