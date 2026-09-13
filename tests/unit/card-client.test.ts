import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardClient } from '../../src/openapi/card.js';
import { TokenManager } from '../../src/openapi/token.js';

function okTokenFetch() {
  return (async () => new Response(JSON.stringify({ accessToken: 'TKN', expireIn: 7_200 }), { status: 200 })) as unknown as typeof fetch;
}

function captureFetch(calls: Array<{ method: string; url: string; headers: Record<string, string>; body: any }>, status = 200) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response(status === 200 ? '{}' : '{"code":"Card.NotFound"}', { status });
  }) as unknown as typeof fetch;
}

const TARGET_P2P = { kind: 'p2p' as const, conversationId: 'cid-p', senderStaffId: 'st1', robotCode: 'rc1' };
const TARGET_GROUP = { kind: 'group' as const, conversationId: 'cidG', senderStaffId: 'st2', robotCode: 'rc1' };

function makeClient(calls: Array<{ method: string; url: string; headers: Record<string, string>; body: any }>, status = 200) {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-card-'));
  return new CardClient({
    tokenManager: new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 't.json'), fetchFn: okTokenFetch() }),
    fetchFn: captureFetch(calls, status),
  });
}

test('card: p2p createAndDeliver 载荷形状（IM_ROBOT 路由）', async () => {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: any }> = [];
  const outTrackId = await makeClient(calls).createAndDeliver({ templateId: 'tpl-9', contentKey: 'content', target: TARGET_P2P });
  expect(outTrackId).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.dingtalk.com/v1.0/card/instances/createAndDeliver' });
  expect(calls[0].headers['x-acs-dingtalk-access-token']).toBe('TKN');
  expect(calls[0].body).toMatchObject({
    cardTemplateId: 'tpl-9', outTrackId, callbackType: 'STREAM',
    cardData: { cardParamMap: { content: '' } },
    openSpaceId: 'dtv1.card//IM_ROBOT.st1',
    imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT' },
  });
  expect(calls[0].body.imGroupOpenDeliverModel).toBeUndefined();
});

test('card: 群 createAndDeliver 载荷形状（IM_GROUP 路由 + robotCode）', async () => {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: any }> = [];
  await makeClient(calls).createAndDeliver({ templateId: 'tpl-9', contentKey: 'c', target: TARGET_GROUP });
  expect(calls[0].body).toMatchObject({
    openSpaceId: 'dtv1.card//IM_GROUP.cidG',
    imGroupOpenDeliverModel: { robotCode: 'rc1' },
  });
});

test('card: streamingUpdate PUT 载荷（isFull 恒真；finalize/error 旗标；guid 每次唯一）', async () => {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: any }> = [];
  const client = makeClient(calls);
  await client.streamingUpdate({ outTrackId: 'ot-1', contentKey: 'content', content: '部分', finalize: false });
  await client.streamingUpdate({ outTrackId: 'ot-1', contentKey: 'content', content: '全文', finalize: true, error: false });
  expect(calls.map((c) => c.method)).toEqual(['PUT', 'PUT']);
  for (const c of calls) expect(c.url).toBe('https://api.dingtalk.com/v1.0/card/streaming');
  expect(calls[0].body).toMatchObject({ outTrackId: 'ot-1', key: 'content', content: '部分', isFull: true, isFinalize: false, isError: false });
  expect(calls[0].body.guid).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[1].body.guid).not.toBe(calls[0].body.guid);
  expect(calls[1].body).toMatchObject({ content: '全文', isFinalize: true });
});

test('card: 非 2xx → 响亮抛错（带响应体）', async () => {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: any }> = [];
  const client = makeClient(calls, 404);
  await expect(client.createAndDeliver({ templateId: 't', contentKey: 'c', target: TARGET_P2P })).rejects.toThrow('Card.NotFound');
  await expect(client.streamingUpdate({ outTrackId: 'o', contentKey: 'c', content: 'x', finalize: true })).rejects.toThrow('404');
});
