import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupCommand } from '../../src/commands/setup.js';
import { FakeDwClient } from '../helpers/fake-dw-client.js';

function okFetch() {
  return (async () => new Response(JSON.stringify({ accessToken: 'TKN', expireIn: 7_200 }), { status: 200 })) as unknown as typeof fetch;
}

test('setup: 非交互凭据 → 写 .env 内容 + smoke PASS（token + stream 连接）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-su-'));
  const client = new FakeDwClient();
  await setupCommand({ root: ws, clientId: 'ck', clientSecret: 'cs', transportClient: client, fetchFn: okFetch(), startTimeoutMs: 500 });
  const text = readFileSync(join(ws, '.bot', '.env'), 'utf8');
  expect(text).toContain('DINGTALK_CLIENT_ID=ck');
  expect(text).toContain('DINGTALK_CLIENT_SECRET=cs');
  expect(client.connectCalls).toBeGreaterThanOrEqual(1);
});

test('setup: 空字符串凭据 → 抛错且不进 readline、不写 .env', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-su2-'));
  await expect(setupCommand({ root: ws, clientId: '', clientSecret: '' })).rejects.toThrow(/凭据/);
  expect(existsSync(join(ws, '.bot', '.env'))).toBe(false);
});

test('setup: smoke 失败响亮（SetupSmokeError）—— token 401 场景', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-su3-'));
  const bad = (async () => new Response('{"code":"InvalidAuthentication"}', { status: 401 })) as unknown as typeof fetch;
  await expect(setupCommand({ root: ws, clientId: 'bad', clientSecret: 'bad', fetchFn: bad, startTimeoutMs: 300 })).rejects.toThrow(/access token/);
});
