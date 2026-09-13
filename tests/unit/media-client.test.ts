import { test, expect } from 'bun:test';
import { MediaClient } from '../../src/openapi/media.js';

const TOKEN = { getAccessToken: async () => 'tk-1' } as never;
const log = () => ({ debug() {}, info() {}, warn() {}, error() {} });

function makeClient(fetchFn: typeof fetch, calls: Array<{ url: string; init: RequestInit }>) {
  return new MediaClient({
    tokenManager: TOKEN, logger: log() as never, fetchFn: ((url: any, init: any) => {
      calls.push({ url: String(url), init });
      return fetchFn(url, init);
    }) as unknown as typeof fetch, apiBase: 'https://api.test',
  });
}

test('media-client: 交换请求形状——POST /v1.0/robot/messageFiles/download，token header，body {downloadCode, robotCode}；返回 downloadUrl', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const c = makeClient((async () => new Response(JSON.stringify({ downloadUrl: 'https://cdn.test/a.png' }), { status: 200 })) as unknown as typeof fetch, calls);
  const url = await c.exchangeDownloadUrl('rc-1', 'dc-1');
  expect(url).toBe('https://cdn.test/a.png');
  expect(calls[0]!.url).toBe('https://api.test/v1.0/robot/messageFiles/download');
  expect(calls[0]!.init.method).toBe('POST');
  expect((calls[0]!.init.headers as Record<string, string>)['x-acs-dingtalk-access-token']).toBe('tk-1');
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ downloadCode: 'dc-1', robotCode: 'rc-1' });
});

test('media-client: HTTP 错误抛错只含状态码（G7 不读不记响应体）；响应缺 downloadUrl 抛错', async () => {
  const errs: string[] = [];
  const c1 = new MediaClient({
    tokenManager: TOKEN, logger: { debug() {}, info() {}, warn() {}, error: (_s: string, m: string) => { errs.push(m); } } as never,
    fetchFn: (async () => new Response('{"code":"invalidDownloadCode","message":"downloadCode 不存在或已过期"}', { status: 400 })) as unknown as typeof fetch,
    apiBase: 'https://api.test',
  });
  await expect(c1.exchangeDownloadUrl('rc', 'dc-bad')).rejects.toThrow('HTTP 400');
  expect(errs.join('\n')).not.toContain('不存在或已过期');   // 错误体不进日志
  expect(errs.join('\n')).not.toContain('dc-bad');          // downloadCode 不进日志
  const c2 = makeClient((async () => new Response('{}', { status: 200 })) as unknown as typeof fetch, []);
  await expect(c2.exchangeDownloadUrl('rc', 'dc')).rejects.toThrow('downloadUrl');
});

test('media-client: 外部 signal 透传给 fetch（服务层 30s 总 deadline 打断交换）；aborted signal → fetch 拒绝', async () => {
  const calls: Array<RequestInit> = [];
  const c = new MediaClient({
    tokenManager: TOKEN, logger: log() as never,
    fetchFn: (async (_u: any, init: any) => {
      calls.push(init);
      if ((init as RequestInit).signal?.aborted) throw new Error('aborted');
      return new Response(JSON.stringify({ downloadUrl: 'https://cdn.test/a' }), { status: 200 });
    }) as unknown as typeof fetch,
    apiBase: 'https://api.test',
  });
  const ac = new AbortController();
  const url = await c.exchangeDownloadUrl('rc', 'dc', ac.signal);
  expect(url).toBe('https://cdn.test/a');
  expect(calls[0]!.signal).toBe(ac.signal); // 同一 signal 实例直达 fetch——deadline 可打断交换
  ac.abort();
  await expect(c.exchangeDownloadUrl('rc', 'dc2', ac.signal)).rejects.toThrow();
});
