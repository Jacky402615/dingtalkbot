import { test, expect } from 'bun:test';
import { DingtalkSdkTransport, TransportStartError, TransportStoppedError } from '../../src/transport/dingtalk-sdk-adapter.js';
import { FakeDwClient } from '../helpers/fake-dw-client.js';
import { consoleLogger } from '../../src/logger.js';
import type { InboundRobotMessage } from '../../src/transport/types.js';

const TEXT_PAYLOAD = { msgId: 'm1', conversationId: 'cid', conversationType: '1', senderStaffId: 's1', senderNick: 'n', robotCode: 'rc', msgtype: 'text', text: { content: 'hi' } };

function makeTransport(client: FakeDwClient, sleeps: number[] = [], opts: Record<string, unknown> = {}) {
  return new DingtalkSdkTransport({
    clientId: 'id', clientSecret: 'sec', logger: consoleLogger,
    backoffBaseMs: 10, backoffCapMs: 40, registeredWaitMs: 300, watchdogPollMs: 20,
    sleep: async (ms: number) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, 0)); }, // 记录后退让一个宏任务节拍：立即返回会饿死测试的定时器
    clientFactory: () => client,
    ...opts,
  });
}

test('adapter: start 成功（registered）且关闭 SDK autoReconnect', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client);
  await t.start();
  expect(client.config.autoReconnect).toBe(false);
  expect(client.connectCalls).toBeGreaterThanOrEqual(1);
  await t.stop();
});

test('adapter: 一直连不上 → 首次 startTimeoutMs 后 TransportStartError（AC1 响亮）且已断开', async () => {
  const client = new FakeDwClient();
  client.failForever = true;
  const t = makeTransport(client, [], { startTimeoutMs: 80 });
  await expect(t.start()).rejects.toBeInstanceOf(TransportStartError);
  expect(client.connected).toBe(false);
  await t.stop();
});

test('adapter: connect() 挂起不 resolve → per-attempt 超时兜底，首次 deadline 内响亮失败（不 wedge）', async () => {
  const client = new FakeDwClient();
  client.hangConnects = 100; // 每次 connect 都挂起
  const t = makeTransport(client, [], { startTimeoutMs: 120, connectAttemptTimeoutMs: 40 });
  await expect(t.start()).rejects.toBeInstanceOf(TransportStartError);
  await t.stop();
});

test('adapter: 挂起一次后恢复——超时的尝试被 disconnect 废弃，后续尝试成功', async () => {
  const client = new FakeDwClient();
  client.hangConnects = 1; // 首次 connect 挂起，第二次成功
  const t = makeTransport(client, [], { startTimeoutMs: 2_000, connectAttemptTimeoutMs: 30 });
  await t.start(); // 不 wedge：超时 → 废弃 → 退避 → 重连成功
  expect(client.connectCalls).toBeGreaterThanOrEqual(2);
  expect(client.registered).toBe(true);
  await t.stop();
});

test('adapter: 超时尝试的 disconnect 也失败 → 重建 client 后续用（不与半途连接重叠）', async () => {
  const clients: FakeDwClient[] = [];
  const t = new DingtalkSdkTransport({
    clientId: 'id', clientSecret: 'sec', logger: consoleLogger,
    backoffBaseMs: 5, registeredWaitMs: 300, watchdogPollMs: 20, connectAttemptTimeoutMs: 30, startTimeoutMs: 3_000,
    sleep: async () => { await new Promise((r) => setTimeout(r, 0)); },
    clientFactory: () => {
      const c = new FakeDwClient();
      if (clients.length === 0) { c.hangConnects = 1; c.disconnectThrows = true; } // 首个 client：挂起 + 报废失败
      clients.push(c);
      return c;
    },
  });
  await t.start(); // 重建的第二个 client 连接成功
  expect(clients.length).toBeGreaterThanOrEqual(2);
  expect(clients[1].registered).toBe(true);
  expect(clients[1].config.autoReconnect).toBe(false); // 重建路径同样关掉 SDK 自动重连
  await t.stop();
});

test('adapter: stop 后立即 start——旧 supervisor 的迟到注册不得结算新 start', async () => {
  const clients: FakeDwClient[] = [];
  const t = new DingtalkSdkTransport({
    clientId: 'id', clientSecret: 'sec', logger: consoleLogger,
    backoffBaseMs: 10, registeredWaitMs: 2_000, watchdogPollMs: 20,
    sleep: async () => {},
    clientFactory: () => { const c = new FakeDwClient(); c.registerDelayMs = 120; clients.push(c); return c; },
  });
  const first = t.start();  // client1（注册延迟 120ms）
  await new Promise((r) => setTimeout(r, 30));
  await t.stop();           // 此刻 client1 尚未 registered
  const second = t.start(); // client2
  await expect(first).rejects.toBeInstanceOf(TransportStoppedError);
  await second;             // 只能由 client2 自己的注册结算
  expect(clients[1].registered).toBe(true);
  await t.stop();
});

test('adapter: 换代后迟到的入站消息不进 handler 也不 ack（丢弃 + 留痕）', async () => {
  const clients: FakeDwClient[] = [];
  const t = new DingtalkSdkTransport({
    clientId: 'id', clientSecret: 'sec', logger: consoleLogger,
    backoffBaseMs: 10, watchdogPollMs: 20, handlerRetryDelayMs: 1,
    sleep: async () => {},
    clientFactory: () => { const c = new FakeDwClient(); clients.push(c); return c; },
  });
  let handled = 0;
  t.onMessage(async () => { handled += 1; }); // handler 计数：旧代消息绝不进 handler（防重复回显）
  await t.start();             // client1
  await t.stop();
  await t.start();             // client2（换代会）
  clients[0].emitRobotMessage(TEXT_PAYLOAD, 'stale-1'); // 旧 client 的迟到消息
  await new Promise((r) => setTimeout(r, 30));
  expect(handled).toBe(0);
  expect(clients[0].acks).toHaveLength(0); // 旧 client 已断开无从 ack
  expect(clients[1].acks).toHaveLength(0); // 绝不向新 client 发旧 messageId 的 ack
  clients[1].emitRobotMessage(TEXT_PAYLOAD, 'fresh-1'); // 新代消息正常 ack
  await new Promise((r) => setTimeout(r, 30));
  expect(handled).toBe(1);
  expect(clients[1].acks).toEqual([{ messageId: 'fresh-1', result: { status: 'SUCCESS', message: 'OK' } }]);
  await t.stop();
});

test('adapter: 迟到才 resolve 的 connect 不与下一次尝试重叠（超时后必重建，废弃 socket 事后清理）', async () => {
  const clients: FakeDwClient[] = [];
  const t = new DingtalkSdkTransport({
    clientId: 'id', clientSecret: 'sec', logger: consoleLogger,
    backoffBaseMs: 5, registeredWaitMs: 300, watchdogPollMs: 20, connectAttemptTimeoutMs: 30, startTimeoutMs: 3_000,
    sleep: async () => { await new Promise((r) => setTimeout(r, 0)); },
    clientFactory: () => {
      const c = new FakeDwClient();
      if (clients.length === 0) c.lateResolveMs = 150; // 首个 connect 晚于 attempt 超时才成功
      clients.push(c);
      return c;
    },
  });
  await t.start(); // client1 超时被弃 → 重建的 client2 立即注册成功
  expect(clients.length).toBe(2);
  expect(clients[1].registered).toBe(true);
  expect(clients[1].connectCalls).toBe(1);
  await new Promise((r) => setTimeout(r, 250)); // client1 的迟到 connect 已 settle
  expect(clients[0].connected).toBe(false);     // 废弃 socket 被迟到清理断开（无泄漏活连接）
  expect(t.getState()).toBe('connected');       // 传输仍由 client2 支配
  expect(clients[1].connectCalls).toBe(1);
  await t.stop();
});

test('adapter: 挂起 connect 期间 stop→restart，旧 supervisor 不得劫持新代的 client', async () => {
  const clients: FakeDwClient[] = [];
  const t = new DingtalkSdkTransport({
    clientId: 'id', clientSecret: 'sec', logger: consoleLogger,
    backoffBaseMs: 5, registeredWaitMs: 300, watchdogPollMs: 20, connectAttemptTimeoutMs: 30, startTimeoutMs: 5_000,
    sleep: async () => { await new Promise((r) => setTimeout(r, 0)); },
    clientFactory: () => {
      const c = new FakeDwClient();
      if (clients.length === 0) c.hangConnects = 5; // 首个 client 的 connect 长时间挂起
      clients.push(c);
      return c;
    },
  });
  let handled = 0;
  t.onMessage(async () => { handled += 1; });
  const first = t.start(); // client1（挂起）
  await new Promise((r) => setTimeout(r, 30));
  await t.stop();          // 挂起期间 stop
  const second = t.start(); // 重启（client2，或旧代先重建时为 client3——两种交错都要成立）
  await expect(first).rejects.toBeInstanceOf(TransportStoppedError);
  await second;
  // 挂起的旧代在超时后醒来也不得改写换代后的 this.client：新代消息必须正常处理+ack。
  // 定位"已注册"的客户端（即当前代持有的那个），避免依赖 factory 调用次序的交错细节。
  await new Promise((r) => setTimeout(r, 80)); // 等旧代超时路径跑完
  const live = clients.find((c) => c.registered);
  expect(live).toBeDefined();
  live!.emitRobotMessage(TEXT_PAYLOAD, 'post-restart');
  await new Promise((r) => setTimeout(r, 40));
  expect(handled).toBe(1);
  expect(live!.acks).toEqual([{ messageId: 'post-restart', result: { status: 'SUCCESS', message: 'OK' } }]);
  await t.stop();
});

test('adapter: 首次注册等待钳制在 30s deadline 内（不被 registeredWaitMs 突破）', async () => {
  const client = new FakeDwClient();
  client.registerDelayMs = 150; // 注册延迟超过 deadline
  const t = makeTransport(client, [], { startTimeoutMs: 80, registeredWaitMs: 60_000 });
  const t0 = Date.now();
  await expect(t.start()).rejects.toBeInstanceOf(TransportStartError);
  expect(Date.now() - t0).toBeLessThan(2_000); // 快速响亮失败，而非等满 registeredWaitMs
  await t.stop();
});

test('adapter: 运行期重建失败不退出监督——沿用旧 client 恢复（AC3 无 wedge）', async () => {
  const clients: FakeDwClient[] = [];
  let factoryCalls = 0;
  const t = new DingtalkSdkTransport({
    clientId: 'id', clientSecret: 'sec', logger: consoleLogger,
    backoffBaseMs: 5, registeredWaitMs: 300, watchdogPollMs: 20, connectAttemptTimeoutMs: 30, startTimeoutMs: 3_000,
    sleep: async () => { await new Promise((r) => setTimeout(r, 0)); },
    clientFactory: () => {
      factoryCalls += 1;
      if (factoryCalls === 2) throw new Error('factory broken'); // 首次重建时失败
      const c = new FakeDwClient();
      clients.push(c);
      return c;
    },
  });
  await t.start(); // client1 注册成功
  expect(clients).toHaveLength(1);
  clients[0].killSocket();
  clients[0].hangConnects = 1; // 重连尝试挂起 → 超时 → disconnect → 重建失败 → 沿用旧 client 退避
  await new Promise((r) => setTimeout(r, 250));
  expect(clients[0].registered).toBe(true); // 旧 client 第二次 connect 成功，监督未退出
  expect(factoryCalls).toBe(2);             // 初次 + 失败的重建，之后不再需要
  await t.stop();
});

test('adapter: handler 总预算耗尽 → 停止重试并 ack handler-failed（60s 重推窗口防护）', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client, [], { handlerRetryDelayMs: 1, handlerBudgetMs: 40 });
  let calls = 0;
  t.onMessage(async () => { calls += 1; await new Promise((r) => setTimeout(r, 100)); }); // 单次即超预算
  await t.start();
  client.emitRobotMessage(TEXT_PAYLOAD, 'm-b');
  await new Promise((r) => setTimeout(r, 160));
  expect(calls).toBe(1); // 预算截断，不再重试
  expect(client.acks[0]).toMatchObject({ messageId: 'm-b', result: { status: 'SUCCESS', message: 'handler-failed' } });
  await t.stop();
});

test('adapter: 启动等待期间 stop() → start() 以 TransportStoppedError 结算（不悬挂）', async () => {
  const client = new FakeDwClient();
  client.failForever = true;
  const t = makeTransport(client, [], { startTimeoutMs: 60_000 });
  const started = t.start();
  await new Promise((r) => setTimeout(r, 30));
  await t.stop();
  await expect(started).rejects.toBeInstanceOf(TransportStoppedError);
});

test('adapter: 消息→归一→handler→ack SUCCESS（EventAck 形状）', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client);
  const got: InboundRobotMessage[] = [];
  t.onMessage(async (m) => { got.push(m); });
  await t.start();
  client.emitRobotMessage(TEXT_PAYLOAD);
  await new Promise((r) => setTimeout(r, 50));
  expect(got).toHaveLength(1);
  expect(got[0].textContent).toBe('hi');
  expect(client.acks).toEqual([{ messageId: 'msg-1', result: { status: 'SUCCESS', message: 'OK' } }]);
  await t.stop();
});

test('adapter: data 非 JSON → 不进 handler，仍 ack + error 日志', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client);
  let called = 0;
  t.onMessage(async () => { called += 1; });
  await t.start();
  client.emitRobotMessage('不是json', 'bad-1');
  await new Promise((r) => setTimeout(r, 30));
  expect(called).toBe(0);
  expect(client.acks[0]).toMatchObject({ messageId: 'bad-1', result: { status: 'SUCCESS', message: 'parse-error' } });
  await t.stop();
});

test('adapter: handler 失败重试 3 次后尽弃 ack（防 60s 重推毒消息）', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client, [], { handlerRetryDelayMs: 1 });
  let calls = 0;
  t.onMessage(async () => { calls += 1; throw new Error('boom'); });
  await t.start();
  client.emitRobotMessage(TEXT_PAYLOAD, 'm-x');
  await new Promise((r) => setTimeout(r, 30));
  expect(calls).toBe(3);
  expect(client.acks[0]).toMatchObject({ messageId: 'm-x', result: { message: 'handler-failed' } });
  await t.stop();
});

test('adapter: handler 第 2 次成功 → 重试生效 ack OK', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client, [], { handlerRetryDelayMs: 1 });
  let calls = 0;
  t.onMessage(async () => { calls += 1; if (calls === 1) throw new Error('transient'); });
  await t.start();
  client.emitRobotMessage(TEXT_PAYLOAD, 'm-y');
  await new Promise((r) => setTimeout(r, 30));
  expect(calls).toBe(2);
  expect(client.acks[0]).toMatchObject({ messageId: 'm-y', result: { message: 'OK' } });
  await t.stop();
});

test('adapter: socket close 立即触发重连（不等 watchdog 轮询）', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client, [], { watchdogPollMs: 60_000 }); // 轮询故意拉长：只有 close 信号能唤醒
  await t.start();
  const before = client.connectCalls;
  client.killSocket();
  await new Promise((r) => setTimeout(r, 100));
  expect(client.connectCalls).toBe(before + 1);
  expect(client.registered).toBe(true);
  await t.stop();
});

test('adapter: 运行期连续失败不退出监督（AC3 无 wedge），恢复后退避重置', async () => {
  const client = new FakeDwClient();
  const sleeps: number[] = [];
  const t = makeTransport(client, sleeps); // 注入 sleep 只接收退避时长（poll 走内部 setTimeout）
  await t.start();
  client.killSocket();
  client.failNextConnects = 3; // 连续失败 3 轮
  await new Promise((r) => setTimeout(r, 300));
  expect(client.connectCalls).toBeGreaterThanOrEqual(5); // 1 首连 + 3 失败 + ≥1 成功
  expect(client.registered).toBe(true); // 恢复且监督未退出
  expect(sleeps.slice(0, 4)).toEqual([10, 20, 40, 40]); // 指数退避 → 封顶
  client.killSocket(); // 恢复后再次断线：attempt 已重置 → 又从 base 起步
  await new Promise((r) => setTimeout(r, 100));
  expect(sleeps[sleeps.length - 1]).toBe(10);
  await t.stop();
});

test('adapter: stop 后不再重连', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client);
  await t.start();
  await t.stop();
  const calls = client.connectCalls;
  client.killSocket();
  await new Promise((r) => setTimeout(r, 120));
  expect(client.connectCalls).toBe(calls);
});
