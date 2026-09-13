import { test, expect } from 'bun:test';
import { createEchoHandler } from '../../src/handlers/echo.js';
import type { Logger } from '../../src/logger.js';
import type { InboundRobotMessage } from '../../src/transport/types.js';

function msg(over: Partial<InboundRobotMessage>): InboundRobotMessage {
  return { msgId: 'm', conversationId: 'cid', conversationKind: 'p2p', senderStaffId: 's1', senderNick: 'n', robotCode: 'rc', msgtype: 'text', textContent: 'hi', sessionWebhook: null, raw: {}, ...over };
}

function fakeReplyer() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    replyer: {
      sendOtoMarkdown: async (...args: unknown[]) => { calls.push({ method: 'oto', args }); },
      sendGroupMarkdown: async (...args: unknown[]) => { calls.push({ method: 'group', args }); },
    } as never,
  };
}

function recordingLogger() {
  const lines: Array<{ level: string; msg: string }> = [];
  const rec: Logger = {
    debug: () => {}, info: () => {},
    warn: (m, msg) => { lines.push({ level: 'warn', msg }); },
    error: (m, msg) => { lines.push({ level: 'error', msg }); },
  };
  return { lines, logger: rec };
}

test('echo: p2p 文本 → oToMessages batchSend（markdown，空白原样）', async () => {
  const { calls, replyer } = fakeReplyer();
  await createEchoHandler({ replyer, logger: recordingLogger().logger })(msg({ textContent: ' 你好 \n' }));
  expect(calls).toEqual([{ method: 'oto', args: ['rc', ['s1'], 'dingtalkbot', ' 你好 \n'] }]);
});

test('echo: 群文本 → groupMessages/send，用 conversationId 当 openConversationId', async () => {
  const { calls, replyer } = fakeReplyer();
  await createEchoHandler({ replyer, logger: recordingLogger().logger })(msg({ conversationKind: 'group', conversationId: 'cidG' }));
  expect(calls).toEqual([{ method: 'group', args: ['rc', 'cidG', 'dingtalkbot', 'hi'] }]);
});

test('echo: 非文本/空文本/未知会话类型 → 不回复且留 warn（#62 不静默）', async () => {
  const { calls, replyer } = fakeReplyer();
  const { lines, logger } = recordingLogger();
  const h = createEchoHandler({ replyer, logger });
  await h(msg({ msgtype: 'picture', textContent: null }));
  await h(msg({ textContent: '   ' }));
  await h(msg({ conversationKind: 'unknown' }));
  expect(calls).toHaveLength(0);
  expect(lines.filter((l) => l.level === 'warn')).toHaveLength(3);
});

test('echo: 回复抛错向上传播（adapter 层重试/ack 兜底）', async () => {
  const replyer = { sendOtoMarkdown: async () => { throw new Error('send fail'); }, sendGroupMarkdown: async () => {} } as never;
  await expect(createEchoHandler({ replyer, logger: recordingLogger().logger })(msg({}))).rejects.toThrow('send fail');
});
