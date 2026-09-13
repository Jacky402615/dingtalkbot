import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RobotReplyer } from '../../src/openapi/robot.js';
import { TokenManager } from '../../src/openapi/token.js';

function tokenFetch() {
  return (async () => new Response(JSON.stringify({ accessToken: 'TKN', expireIn: 7_200 }), { status: 200 })) as unknown as typeof fetch;
}

test('sendOtoMarkdown: 端点/头/载荷形状', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-rep-'));
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const replyer = new RobotReplyer({
    tokenManager: new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'), fetchFn: tokenFetch() }),
    fetchFn,
  });
  await replyer.sendOtoMarkdown('RC1', ['staff1'], '标题', '正文');
  expect(calls[0].url).toBe('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend');
  expect(calls[0].headers['x-acs-dingtalk-access-token']).toBe('TKN');
  expect(calls[0].body).toEqual({ robotCode: 'RC1', userIds: ['staff1'], msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: '标题', text: '正文' }) });
});

test('sendGroupMarkdown: 端点/载荷形状', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-rep-'));
  const calls: Array<{ url: string; body: any }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const replyer = new RobotReplyer({
    tokenManager: new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'), fetchFn: tokenFetch() }),
    fetchFn,
  });
  await replyer.sendGroupMarkdown('RC2', 'cid-9', 't', 'x');
  expect(calls[0].url).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send');
  expect(calls[0].body).toEqual({ robotCode: 'RC2', openConversationId: 'cid-9', msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 't', text: 'x' }) });
});

test('非 2xx：抛带响应体的错误（不吞）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-rep-'));
  const replyer = new RobotReplyer({
    tokenManager: new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'), fetchFn: tokenFetch() }),
    fetchFn: (async () => new Response('{"code":"forbidden"}', { status: 403 })) as unknown as typeof fetch,
  });
  await expect(replyer.sendOtoMarkdown('RC', ['u'], 't', 'x')).rejects.toThrow('403');
});

test('挂起的回复请求按 requestTimeoutMs 响亮超时（60s ack 窗口内兜底）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-rep-'));
  const replyer = new RobotReplyer({
    tokenManager: new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'), fetchFn: tokenFetch() }),
    requestTimeoutMs: 40,
    fetchFn: (async () => new Promise<never>(() => {})) as unknown as typeof fetch, // 永不返回且忽略 signal
  });
  await expect(replyer.sendOtoMarkdown('RC', ['u'], 't', 'x')).rejects.toThrow(/超时/);
});
