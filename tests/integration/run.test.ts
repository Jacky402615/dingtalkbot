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
  const paths = bootstrapWorkspace(ws);
  saveBotEnv(join(ws, '.bot'), { clientId: 'ck', clientSecret: 'cs' });
  writeFileSync(paths.accessFile, JSON.stringify({ admin: ['st1'], approved: [], groups: [] })); // D3：装配线测试须先放行 st1
  const seen: string[] = [];
  const fakeRunner = {
    run: async (req: TurnRequest): Promise<TurnResult> => {
      seen.push(req.prompt);
      return { ok: true, outputText: 'r', errorText: '', durationMs: 1 };
    },
    killAll: () => {},
  } as unknown as ClaudeRunner;
  const md: Array<{ kind: string; text: string }> = [];
  const fakeReplyer = {
    sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { md.push({ kind: 'oto', text }); },
    sendGroupMarkdown: async (_r: string, _c: string, _t: string, text: string) => { md.push({ kind: 'group', text }); },
  } as unknown as RobotReplyer; // HTTP 边界 fake（code-review F4）：模板空 → 回退 markdown 不打真 API
  const client = new FakeDwClient();
  await runCommand(ws, {
    transportFactory: (opts) => new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client }),
    depsOverrides: { runner: fakeRunner, replyer: fakeReplyer },
  }, noExit);
  client.emitRobotMessage(P2P_PAYLOAD);
  await new Promise((r) => setTimeout(r, 150));
  expect(seen[0]).toContain('[Context: sender=n, staffId=st1, chat=c1 (p2p)]');
  expect(md.some((x) => x.text.includes('r'))).toBe(true); // markdown 回退走 fake
});

test('runCommand: 关停序——queue.close 先于 runner.killAll；排队回合不再执行', async () => {
  const ws2 = mkdtempSync(join(tmpdir(), 'dtb-run4-'));
  const paths2 = bootstrapWorkspace(ws2);
  saveBotEnv(paths2.botDir, { clientId: 'ck', clientSecret: 'cs' });
  writeFileSync(paths2.accessFile, JSON.stringify({ admin: ['st1'], approved: [], groups: [] })); // D3：关停序测试须先放行 st1
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
  const fakeReplyer2 = {
    sendOtoMarkdown: async () => {},
    sendGroupMarkdown: async () => {},
  } as unknown as RobotReplyer; // HTTP 边界 fake（code-review F4）
  const client = new FakeDwClient();
  let capturedShutdown: ((sig: string) => Promise<void>) | null = null;
  const exits: number[] = [];
  const recordingExit = (code: number): never => { exits.push(code); throw new Error('exit-sentinel'); };
  await runCommand(ws2, {
    transportFactory: (opts) => new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client }),
    depsOverrides: { runner: fakeRunner, queue: wrappedQueue, replyer: fakeReplyer2 },
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

// ---- D3（issue #3）：dispatch 装配线 ----
import { writeFileSync } from 'node:fs';
import type { RobotReplyer } from '../../src/openapi/robot.js';

test('runCommand D3: dispatch 装配——/help 网关应答、陌生 p2p 拒绝、runner 零触达；白名单消息仍达 runner（AC1/AC2 装配面）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-run5-'));
  const paths = bootstrapWorkspace(ws);
  saveBotEnv(paths.botDir, { clientId: 'ck', clientSecret: 'cs' });
  writeFileSync(paths.accessFile, JSON.stringify({ admin: [], approved: ['st1'], groups: [] }));
  const prompts: string[] = [];
  const fakeRunner = {
    run: async (req: TurnRequest): Promise<TurnResult> => {
      prompts.push(req.prompt);
      return { ok: true, outputText: '回合输出', errorText: '', durationMs: 1 };
    },
    killAll: () => {},
  } as unknown as ClaudeRunner;
  const md: Array<{ kind: string; text: string }> = [];
  const replyer = {
    sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { md.push({ kind: 'oto', text }); },
    sendGroupMarkdown: async (_r: string, _c: string, _t: string, text: string) => { md.push({ kind: 'group', text }); },
  } as unknown as RobotReplyer;
  const client = new FakeDwClient();
  await runCommand(ws, {
    transportFactory: (opts) => new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client }),
    depsOverrides: { runner: fakeRunner, replyer },
  }, noExit);
  client.emitRobotMessage({ ...P2P_PAYLOAD, msgId: 'h1', text: { content: '/help' } });            // 命令
  client.emitRobotMessage({ ...P2P_PAYLOAD, msgId: 'h2', senderStaffId: 'stranger', text: { content: '你好' } }); // 陌生
  client.emitRobotMessage({ ...P2P_PAYLOAD, msgId: 'h3', text: { content: '正常消息' } });          // 白名单普通消息
  await new Promise((r) => setTimeout(r, 150));
  expect(prompts).toHaveLength(1);                    // 只有普通消息触达 runner
  expect(prompts[0]).toContain('[Context: sender=n, staffId=st1, chat=c1 (p2p)]');
  expect(md).toHaveLength(3);                         // help 文案 / 拒绝 / 回合 markdown（模板空→回退）
  expect(md[0]!.text).toContain('/new');              // 帮助文案
  expect(md[1]!.text).toContain('未授权');            // 拒绝文本
  expect(md[2]!.text).toContain('回合输出');          // 正常回合仍完整走 D2 链路
});

// ---- D4（issue #4）：媒体装配线 ----
import { mkdirSync, utimesSync } from 'node:fs';
import type { MediaHandler, MediaOutcome } from '../../src/media/attachments.js';
import type { InboundRobotMessage } from '../../src/transport/types.js';

function makeD4Media(handled: string[], failIds: string[] = []): MediaHandler {
  return {
    handle: async (m: InboundRobotMessage): Promise<MediaOutcome | null> => {
      handled.push(`${m.msgtype}:${m.msgId}`);
      if (failIds.includes(m.msgId)) return { kind: 'error', errorText: '附件下载失败：下载服务返回 HTTP 400。请重新发送该附件。' };
      // richText 载荷按序提取文本段（模拟真实服务的 text 提取——集成层验证混排组装）
      const els = (m.raw as { content?: { richText?: unknown[] } })?.content?.richText;
      const text = Array.isArray(els)
        ? els.filter((e): e is { text: string } => typeof (e as { text?: unknown })?.text === 'string')
            .map((e) => e.text).join(' ') : null;
      return { kind: 'ok', text, notes: ['[附件 image] 已下载：`/uploads/a.png`', '[附件说明] 不可信'] };
    },
  };
}

test('runCommand D4: 媒体装配——picture 经 dispatch→agent→runner prompt 含注记；错误/陌生路径正确（AC4/鉴权装配面）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-run-d4-'));
  const paths = bootstrapWorkspace(ws);
  saveBotEnv(paths.botDir, { clientId: 'ck', clientSecret: 'cs' });
  writeFileSync(paths.accessFile, JSON.stringify({ admin: [], approved: ['st1'], groups: [] }));
  const prompts: string[] = [];
  const fakeRunner = {
    run: async (req: TurnRequest): Promise<TurnResult> => {
      prompts.push(req.prompt);
      return { ok: true, outputText: '已收到图片', errorText: '', durationMs: 1 };
    },
    killAll: () => {},
  } as unknown as ClaudeRunner;
  const md: Array<{ kind: string; text: string }> = [];
  const replyer = {
    sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { md.push({ kind: 'oto', text }); },
    sendGroupMarkdown: async (_r: string, _c: string, _t: string, text: string) => { md.push({ kind: 'group', text }); },
  } as unknown as RobotReplyer;
  const handled: string[] = [];
  const client = new FakeDwClient();
  await runCommand(ws, {
    transportFactory: (opts) => new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client }),
    depsOverrides: { runner: fakeRunner, replyer, media: makeD4Media(handled, ['err1']) },
  }, noExit);
  client.emitRobotMessage({ ...P2P_PAYLOAD, msgId: 'pic1', msgtype: 'picture', text: undefined, content: { downloadCode: 'dc' } });
  client.emitRobotMessage({ ...P2P_PAYLOAD, msgId: 'err1', msgtype: 'picture', text: undefined, content: { downloadCode: 'dc2' } });
  client.emitRobotMessage({ ...P2P_PAYLOAD, msgId: 'str1', senderStaffId: 'stranger', msgtype: 'picture', text: undefined, content: { downloadCode: 'dc3' } });
  await new Promise((r) => setTimeout(r, 150));
  expect(prompts).toHaveLength(1);                          // err1 终态不入队；stranger 被 dispatch 拒
  expect(prompts[0]).toContain('[附件 image] 已下载：`/uploads/a.png`');
  expect(prompts[0]).toContain('[Context: sender=n, staffId=st1, chat=c1 (p2p)]');
  expect(md.map((x) => x.text).join('\n')).toContain('已收到图片'); // 回合输出照常送达
  expect(md.map((x) => x.text).join('\n')).toContain('附件下载失败'); // AC4 错误回复
  expect(md.map((x) => x.text).join('\n')).toContain('未授权');      // 陌生媒体消息同样被拒（dispatch 不变）
  expect(handled).toEqual(['picture:pic1', 'picture:err1']); // stranger 未达 media（鉴权先行）
});

test('runCommand D4: 白名单群 @ 发 richText（文本+图混排）——群会话链路照常走注记 prompt 与群回复（群 richText 平台投递面）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-run-d4g-'));
  const paths = bootstrapWorkspace(ws);
  saveBotEnv(paths.botDir, { clientId: 'ck', clientSecret: 'cs' });
  writeFileSync(paths.accessFile, JSON.stringify({ admin: [], approved: [], groups: ['cidG'] }));
  const prompts: string[] = [];
  const fakeRunner = {
    run: async (req: TurnRequest): Promise<TurnResult> => {
      prompts.push(req.prompt);
      return { ok: true, outputText: '群图已收', errorText: '', durationMs: 1 };
    },
    killAll: () => {},
  } as unknown as ClaudeRunner;
  const md: Array<{ kind: string; text: string }> = [];
  const replyer = {
    sendOtoMarkdown: async (_r: string, _u: string[], _t: string, text: string) => { md.push({ kind: 'oto', text }); },
    sendGroupMarkdown: async (_r: string, _c: string, _t: string, text: string) => { md.push({ kind: 'group', text }); },
  } as unknown as RobotReplyer;
  const handled: string[] = [];
  const client = new FakeDwClient();
  await runCommand(ws, {
    transportFactory: (opts) => new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client }),
    depsOverrides: { runner: fakeRunner, replyer, media: makeD4Media(handled) },
  }, noExit);
  client.emitRobotMessage({ msgId: 'g1', conversationId: 'cidG', conversationType: '2', senderStaffId: 'st9',
    senderNick: '群友', robotCode: 'rc1', msgtype: 'richText',
    content: { richText: [{ text: '问题示例图如下：' }, { type: 'picture', downloadCode: 'dcg' }, { text: '通过以上示意图' }] } });
  await new Promise((r) => setTimeout(r, 150));
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('[Context: sender=群友, staffId=st9, chat=cidG (group)]');
  expect(prompts[0]).toContain('问题示例图如下： 通过以上示意图');            // richText 文本按序提取进 prompt
  expect(prompts[0]).toContain('[附件 image] 已下载：`/uploads/a.png`');   // 群注记进 prompt
  expect(handled).toEqual(['richText:g1']);                                 // 群 richText 到达媒体层
  expect(md.some((x) => x.kind === 'group' && x.text.includes('群图已收'))).toBe(true); // 群回复通道
});

test('runCommand D4: mediaFactory 接到真实装配参数（uploadsDir/mediaMaxBytes 自 config）+ prune 启动即清理旧文件', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-run-d4b-'));
  const paths = bootstrapWorkspace(ws);
  saveBotEnv(paths.botDir, { clientId: 'ck', clientSecret: 'cs' });
  writeFileSync(paths.configFile, JSON.stringify({ media_max_bytes: 4096 }));
  writeFileSync(paths.accessFile, JSON.stringify({ admin: [], approved: ['st1'], groups: [] }));
  // 种一个 31 天前的旧文件（prune 启动 kick 应删）
  const oldDay = join(paths.uploadsDir, '2026-08-01');
  mkdirSync(oldDay, { recursive: true });
  const oldFile = join(oldDay, 'x.png');
  writeFileSync(oldFile, 'x');
  const oldTime = new Date(Date.now() - 31 * 86_400_000); // utimes 数字=秒——用 Date 对象
  utimesSync(oldFile, oldTime, oldTime);
  const factoryArgs: Array<{ uploadsDir: string; maxBytes: number }> = [];
  const fakeRunner = { run: async (): Promise<TurnResult> => ({ ok: true, outputText: '', errorText: '', durationMs: 1 }), killAll: () => {} } as unknown as ClaudeRunner;
  const fakeReplyer = { sendOtoMarkdown: async () => {}, sendGroupMarkdown: async () => {} } as unknown as RobotReplyer;
  const client = new FakeDwClient();
  let capturedShutdown: ((sig: string) => Promise<void>) | null = null;
  const exits: number[] = [];
  const recordingExit = (code: number): never => { exits.push(code); throw new Error('exit-sentinel'); };
  await runCommand(ws, {
    transportFactory: (opts) => new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client }),
    depsOverrides: { runner: fakeRunner, replyer: fakeReplyer },
    mediaFactory: (args) => { factoryArgs.push(args); return makeD4Media([]); },
    signalHook: (handler) => { capturedShutdown = handler; },
  }, recordingExit);
  await new Promise((r) => setTimeout(r, 50));
  expect(existsSync(oldFile)).toBe(false);                     // 真实 startPruneLoop 已随启动执行（AC5 装配面）
  expect(factoryArgs).toEqual([{ uploadsDir: paths.uploadsDir, maxBytes: 4096 }]); // 装配参数真实（config 键生效）
  await expect(capturedShutdown!('SIGTERM')).rejects.toThrow('exit-sentinel'); // 关停完整走完（pruneLoop.stop 路径）
});
