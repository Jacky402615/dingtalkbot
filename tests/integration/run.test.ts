import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../../src/commands/run.js';
import { saveBotEnv } from '../../src/env.js';
import { bootstrapWorkspace } from '../../src/config.js';
import { FakeDwClient } from '../helpers/fake-dw-client.js';
import { DingtalkSdkTransport } from '../../src/transport/dingtalk-sdk-adapter.js';
import { readPidFile } from '../../src/pid.js';

test('runCommand: 假 transport 下全链路启动（env→gateway→state/pid 落盘）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-run-'));
  const paths = bootstrapWorkspace(ws);
  saveBotEnv(paths.botDir, { clientId: 'ck', clientSecret: 'cs' });
  const client = new FakeDwClient();
  const seenOpts: Array<{ clientId: string }> = [];
  await runCommand(ws, {
    transportFactory: (opts) => {
      seenOpts.push(opts);
      return new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client });
    },
  });
  expect(seenOpts[0]?.clientId).toBe('ck');
  expect(client.connectCalls).toBeGreaterThanOrEqual(1);
  expect(existsSync(paths.stateFile)).toBe(true);
  expect(JSON.parse(readFileSync(paths.stateFile, 'utf8')).transport).toBe('connected');
  expect(readPidFile(paths.pidFile)?.pid).toBe(process.pid);
});

test('runCommand: 缺 .env → 抛 EnvError（不写 pidfile）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-run2-'));
  await expect(runCommand(ws)).rejects.toThrow(/setup/);
});

// ---- D2（issue #2）：装配线与关停序 ----
import type { ClaudeRunner, TurnRequest, TurnResult } from '../../src/agent/claude-runner.js';
import { TurnQueue } from '../../src/agent/turn-queue.js';
import type { Logger } from '../../src/logger.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
function deferred() { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); return { p, release }; }

const P2P_PAYLOAD = { msgId: 'm1', conversationId: 'c1', conversationType: '1', senderStaffId: 'st1', senderNick: 'n', robotCode: 'rc1', msgtype: 'text', text: { content: ' 你好 ' } };
const noExit: (code: number) => never = () => { throw new Error('不应退出'); };

test('runCommand: 真实装配线——消息 → session handler → runner 收 [Context: 前缀 prompt', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-run3-'));
  bootstrapWorkspace(ws);
  saveBotEnv(join(ws, '.bot'), { clientId: 'ck', clientSecret: 'cs' });
  const seen: string[] = [];
  const fakeRunner = {
    run: async (req: TurnRequest): Promise<TurnResult> => {
      seen.push(req.prompt);
      return { ok: true, outputText: 'r', errorText: '', durationMs: 1 };
    },
    killAll: () => {},
  } as unknown as ClaudeRunner;
  const client = new FakeDwClient();
  await runCommand(ws, {
    transportFactory: (opts) => new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client }),
    depsOverrides: { runner: fakeRunner },
  }, noExit);
  client.emitRobotMessage(P2P_PAYLOAD);
  await new Promise((r) => setTimeout(r, 150));
  expect(seen[0]).toContain('[Context: sender=n, staffId=st1, chat=c1 (p2p)]');
});

test('runCommand: 关停序——queue.close 先于 runner.killAll；排队回合不再执行', async () => {
  const ws2 = mkdtempSync(join(tmpdir(), 'dtb-run4-'));
  const paths2 = bootstrapWorkspace(ws2);
  saveBotEnv(paths2.botDir, { clientId: 'ck', clientSecret: 'cs' });
  const order: string[] = [];
  let started = 0;
  const release = deferred();
  const fakeRunner = {
    run: async (): Promise<TurnResult> => { started += 1; await release.p; return { ok: true, outputText: '', errorText: '', durationMs: 0 }; },
    killAll: () => order.push('runner.killAll'),
  } as unknown as ClaudeRunner;
  // 真队列 + 关停序观测包装（enqueue/waitIdle 走真链，close 先记录再委派）
  const realQueue = new TurnQueue({ maxPerChat: 10, logger: quiet });
  const wrappedQueue = {
    enqueue: (k: string, j: () => Promise<void>) => realQueue.enqueue(k, j),
    depthOf: (k: string) => realQueue.depthOf(k),
    waitIdle: (k: string) => realQueue.waitIdle(k),
    drainActive: () => { order.push('queue.drain'); return realQueue.drainActive(); },
    close: () => { order.push('queue.close'); realQueue.close(); },
    closed: false,
  } as unknown as TurnQueue;
  const client = new FakeDwClient();
  let capturedShutdown: ((sig: string) => Promise<void>) | null = null;
  const exits: number[] = [];
  const recordingExit = (code: number): never => { exits.push(code); throw new Error('exit-sentinel'); };
  await runCommand(ws2, {
    transportFactory: (opts) => new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client }),
    depsOverrides: { runner: fakeRunner, queue: wrappedQueue },
    signalHook: (handler) => { capturedShutdown = handler; },
  }, recordingExit);
  expect(capturedShutdown).not.toBeNull();
  client.emitRobotMessage(P2P_PAYLOAD);                       // 回合 1 在飞
  await new Promise((r) => setTimeout(r, 50));
  client.emitRobotMessage({ ...P2P_PAYLOAD, msgId: 'm2' });   // 回合 2 排队
  await new Promise((r) => setTimeout(r, 50));
  expect(started).toBe(1);
  // 触发真实关停：drainActive 会等在飞 job 收尾——释放必须与 shutdown 并发（fake killAll 不中止 fake run）
  const shutdownPromise = capturedShutdown!('SIGTERM');
  release.release();
  await expect(shutdownPromise).rejects.toThrow('exit-sentinel'); // exit 哨兵止步（关停完整走完）
  await new Promise((r) => setTimeout(r, 50));
  expect(order).toEqual(['queue.close', 'runner.killAll', 'queue.drain']);
  expect(exits).toEqual([0]);
  expect(started).toBe(1);                                     // 排队回合被 close 丢弃，未 spawn
});
