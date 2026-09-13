import { test, expect } from 'bun:test';
import { conversationKindOf, normalizeRobotMessage } from '../../src/transport/types.js';

test('conversationKindOf: 1→p2p 2→group 其他→unknown', () => {
  expect(conversationKindOf('1')).toBe('p2p');
  expect(conversationKindOf('2')).toBe('group');
  expect(conversationKindOf('9')).toBe('unknown');
  expect(conversationKindOf(undefined)).toBe('unknown');
});

test('normalizeRobotMessage: text 全字段且空白原样保留；非 text textContent=null；非对象 null', () => {
  const text = normalizeRobotMessage({
    msgId: 'm1', conversationId: 'cid', conversationType: '1', senderStaffId: 's1',
    senderNick: 'n', robotCode: 'rc', msgtype: 'text', sessionWebhook: 'wh',
    text: { content: ' 你好\n' },
  });
  expect(text).toMatchObject({ msgId: 'm1', conversationKind: 'p2p', senderStaffId: 's1', msgtype: 'text', textContent: ' 你好\n' });
  const pic = normalizeRobotMessage({ msgtype: 'picture', conversationType: '2', downloadCode: 'dc' });
  expect(pic?.textContent).toBeNull();
  expect(pic?.conversationKind).toBe('group');
  expect(pic?.msgId).toBe(''); // 缺省字段安全降级为空串
  expect(normalizeRobotMessage('不是对象')).toBeNull();
  expect(normalizeRobotMessage(null)).toBeNull();
});
