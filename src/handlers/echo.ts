import type { InboundRobotMessage, MessageHandler } from '../transport/types.js';
import type { RobotReplyer } from '../openapi/robot.js';
import type { Logger } from '../logger.js';

export const ECHO_TITLE = 'dingtalkbot';

export function createEchoHandler(deps: { replyer: RobotReplyer; logger: Logger }): MessageHandler {
  return async (msg: InboundRobotMessage) => {
    if (msg.msgtype !== 'text' || msg.textContent === null || msg.textContent.trim() === '') {
      deps.logger.warn('echo', `丢弃非文本/空消息 msgId=${msg.msgId} msgtype=${msg.msgtype} kind=${msg.conversationKind}`);
      return;
    }
    if (msg.conversationKind === 'p2p') {
      await deps.replyer.sendOtoMarkdown(msg.robotCode, [msg.senderStaffId], ECHO_TITLE, msg.textContent);
      deps.logger.info('echo', `p2p 回显完成 msgId=${msg.msgId} -> staffId=${msg.senderStaffId}`);
    } else if (msg.conversationKind === 'group') {
      // 假设（live-smoke 验证）：入站 conversationId 即群发 openConversationId
      await deps.replyer.sendGroupMarkdown(msg.robotCode, msg.conversationId, ECHO_TITLE, msg.textContent);
      deps.logger.info('echo', `群回显完成 msgId=${msg.msgId} -> conversationId=${msg.conversationId}`);
    } else {
      deps.logger.warn('echo', `未知 conversationType，丢弃 msgId=${msg.msgId}`);
    }
  };
}
