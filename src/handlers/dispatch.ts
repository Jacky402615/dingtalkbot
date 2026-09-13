import type { InboundRobotMessage, MessageHandler } from '../transport/types.js';
import type { RobotReplyer } from '../openapi/robot.js';
import type { MsgIdDedupe } from '../dedupe.js';
import type { AccessList } from '../access.js';
import { tierOf, isGroupAllowed } from '../access.js';
import { parseCommand, sendChatMarkdown, type CommandName } from './commands.js';
import { stripLeadingMention } from '../agent/question-bridge.js';
import type { Logger } from '../logger.js';

// 固定泛化拒绝文案（D2）：不含命令名、不含配置面信息——陌生者只知"不可用"。
export const REJECT_TEXT = '抱歉，你未授权使用本机器人（不在使用名单内）。';

export interface DispatchDeps {
  dedupe: MsgIdDedupe;
  agent: MessageHandler;
  execute: (name: CommandName, m: InboundRobotMessage) => Promise<void>;
  loadAccess: () => AccessList;
  replyer: RobotReplyer;
  logger: Logger;
}

export function createDispatchHandler(deps: DispatchDeps): MessageHandler {
  return async (m) => {
    // G5：同步占位先于一切 await——单线程事件循环内服务端重推无竞态窗口
    if (!deps.dedupe.reserve(m.msgId)) {
      deps.logger.warn('dispatch', `重复 msgId=${m.msgId}，丢弃`);
      return;
    }
    try {
      if (m.conversationKind === 'p2p') {
        const list = deps.loadAccess();
        if (tierOf(list, m.senderStaffId) === 'unknown') {
          deps.logger.warn('access', `未授权 p2p staffId=${m.senderStaffId} msgId=${m.msgId}，已拒绝`);
          await sendChatMarkdown(deps.replyer, m, REJECT_TEXT); // 发送失败会上抛→release→重试
          return;
        }
      } else if (m.conversationKind === 'group') {
        const list = deps.loadAccess();
        if (!isGroupAllowed(list, m.conversationId)) {
          deps.logger.warn('access', `非白名单群 conversationId=${m.conversationId} @ 已忽略 msgId=${m.msgId}`); // AC4 日志行
          return; // 幂等（仅日志），占位保留
        }
      }
      // 命令解析：群消息用剥 @ 副本（agent 层对原消息自行剥离，互不影响）
      const cmd = m.textContent !== null
        ? parseCommand(m.conversationKind === 'group' ? stripLeadingMention(m.textContent) : m.textContent)
        : null;
      if (cmd !== null) { await deps.execute(cmd, m); return; } // AC1：命令止步于此
      await deps.agent(m); // 普通消息（含未知 /xxx 透传，D9）进 agent 会话
    } catch (err) {
      deps.dedupe.release(m.msgId); // 失败撤销占位——adapter 局部重试可重入（G1）
      throw err;
    }
  };
}
