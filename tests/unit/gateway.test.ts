import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../../src/gateway.js';
import { consoleLogger } from '../../src/logger.js';
import type { DingtalkTransport, MessageHandler, TransportState } from '../../src/transport/types.js';

function fakeTransport(events: string[]) {
  let stateListener: ((s: TransportState, d: string) => void) | null = null;
  return {
    onStateChange: (l: (s: TransportState, d: string) => void) => { stateListener = l; },
    onMessage: (h: MessageHandler) => { events.push(`handler-wired:${typeof h === 'function'}`); },
    start: async () => { events.push('start'); stateListener?.('connected', 'fake'); },
    stop: async () => { events.push('stop'); },
  } as unknown as DingtalkTransport;
}

test('gateway: start 装配 handler + 状态快照落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-gw-'));
  const stateFile = join(dir, 'state.json');
  const events: string[] = [];
  const transport = fakeTransport(events);
  const gw = new Gateway({ transport, logger: consoleLogger, stateFile, pid: 42, startedAt: 'T0', handler: async () => {} });
  await gw.start();
  expect(events).toContain('start');
  expect(events.some((e) => e.startsWith('handler-wired:true'))).toBe(true);
  const snap = JSON.parse(readFileSync(stateFile, 'utf8'));
  expect(snap).toMatchObject({ pid: 42, transport: 'connected' });
  await gw.stop();
  expect(events).toContain('stop');
});

test('gateway: 启动失败 → 先 stop 清理再向外抛（不残留活动资源）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-gw2-'));
  const events: string[] = [];
  const failing = { ...fakeTransport(events), start: async () => { events.push('start-fail'); throw new Error('connect refused'); } } as unknown as DingtalkTransport;
  const gw = new Gateway({ transport: failing, logger: consoleLogger, stateFile: join(dir, 'state.json'), pid: 1, startedAt: 'T' });
  await expect(gw.start()).rejects.toThrow('connect refused');
  expect(events).toContain('stop'); // 失败路径也走了清理
});

// ---- D3（issue #3）：lastState（/status 数据源） ----
test('gateway D3: lastState 随 snapshot 更新——/status 的真实数据源（D6）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-gw-d3-'));
  let listener: ((s: TransportState, d: string) => void) | null = null;
  const transport = {
    onStateChange: (l: (s: TransportState, d: string) => void) => { listener = l; },
    onMessage: () => {},
    start: async () => {},
    stop: async () => {},
  } as unknown as DingtalkTransport;
  const gw = new Gateway({ transport, logger: consoleLogger, stateFile: join(dir, 'state.json'), pid: 42, startedAt: 'T0' });
  expect(gw.lastState).toBeNull();                 // 构造后无快照
  await gw.start();                                // onStateChange 在 start() 内接线
  listener!('connected', '已连接并订阅');
  expect(gw.lastState).toMatchObject({ transport: 'connected', detail: '已连接并订阅', pid: 42, startedAt: 'T0' });
  await gw.stop();
});
