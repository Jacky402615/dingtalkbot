// AC2 的 CI 面：真实 adapter+gateway+echo 装配，仅网络层为 fake
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapWorkspace } from '../../src/config.js';
import { DingtalkSdkTransport } from '../../src/transport/dingtalk-sdk-adapter.js';
import { FakeDwClient } from '../helpers/fake-dw-client.js';
import { TokenManager } from '../../src/openapi/token.js';
import { RobotReplyer } from '../../src/openapi/robot.js';
import { createEchoHandler } from '../../src/handlers/echo.js';
import { Gateway } from '../../src/gateway.js';
import { consoleLogger } from '../../src/logger.js';

function wire(sendStatus: number[] = []) {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-rt-'));
  const paths = bootstrapWorkspace(ws);
  const client = new FakeDwClient();
  const http: Array<{ url: string; body: any }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    http.push({ url, body });
    if (String(url).includes('accessToken')) return new Response(JSON.stringify({ accessToken: 'TKN', expireIn: 7_200 }), { status: 200 });
    const idx = http.filter((c) => !String(c.url).includes('accessToken')).length - 1;
    const status = sendStatus[idx] ?? 200;
    return new Response(status === 200 ? '{}' : '{"code":"err"}', { status });
  }) as unknown as typeof fetch;
  const tokenManager = new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile: paths.tokenCacheFile, fetchFn });
  const replyer = new RobotReplyer({ tokenManager, fetchFn });
  const transport = new DingtalkSdkTransport({
    clientId: 'ck', clientSecret: 'cs', logger: consoleLogger,
    handlerRetryDelayMs: 1, backoffBaseMs: 5, clientFactory: () => client,
  });
  const gateway = new Gateway({
    transport, logger: consoleLogger, stateFile: paths.stateFile,
    pid: process.pid, startedAt: 'T', handler: createEchoHandler({ replyer, logger: consoleLogger }),
  });
  return { client, http, gateway };
}

test('round-trip: p2p 文本 → OpenAPI 体正确 + ack SUCCESS（AC2 CI 面）', async () => {
  const { client, http, gateway } = wire();
  await gateway.start();
  client.emitRobotMessage({ msgId: 'm1', conversationId: 'c1', conversationType: '1', senderStaffId: 'st1', senderNick: 'n', robotCode: 'rc1', msgtype: 'text', text: { content: ' 你好 ' } });
  await new Promise((r) => setTimeout(r, 80));
  const send = http.find((c) => String(c.url).endsWith('/v1.0/robot/oToMessages/batchSend'));
  expect(send?.body).toEqual({ robotCode: 'rc1', userIds: ['st1'], msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 'dingtalkbot', text: ' 你好 ' }) });
  expect(client.acks).toEqual([{ messageId: 'msg-1', result: { status: 'SUCCESS', message: 'OK' } }]);
  await gateway.stop();
});

test('round-trip: 群 @ 文本走 groupMessages/send', async () => {
  const { client, http, gateway } = wire();
  await gateway.start();
  client.emitRobotMessage({ msgId: 'm2', conversationId: 'cidG', conversationType: '2', senderStaffId: 'st2', senderNick: 'n', robotCode: 'rc1', msgtype: 'text', text: { content: '@bot hello' } });
  await new Promise((r) => setTimeout(r, 80));
  const send = http.find((c) => String(c.url).endsWith('/v1.0/robot/groupMessages/send'));
  expect(send?.body).toEqual({ robotCode: 'rc1', openConversationId: 'cidG', msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 'dingtalkbot', text: '@bot hello' }) });
  expect(client.acks).toHaveLength(1);
  await gateway.stop();
});

test('round-trip: 回复持续 500 → 3 次重试后 ack handler-failed（不静默）', async () => {
  const { client, gateway } = wire([500, 500, 500]);
  await gateway.start();
  client.emitRobotMessage({ msgId: 'm3', conversationId: 'c1', conversationType: '1', senderStaffId: 'st1', senderNick: 'n', robotCode: 'rc1', msgtype: 'text', text: { content: 'x' } });
  await new Promise((r) => setTimeout(r, 100));
  expect(client.acks[0]).toMatchObject({ messageId: 'msg-1', result: { message: 'handler-failed' } });
  await gateway.stop();
});
