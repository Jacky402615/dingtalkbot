import { randomUUID } from 'node:crypto';
import type { InboundRobotMessage, MessageHandler } from '../transport/types.js';
import type { RobotReplyer } from '../openapi/robot.js';
import type { CardClient } from '../openapi/card.js';
import type { ClaudeRunner, AskUserQuestionPayload } from '../agent/claude-runner.js';
import { AiCardBridge } from '../cards/ai-card-bridge.js';
import type { SessionStore, SessionRecord } from '../agent/session-store.js';
import type { TurnQueue } from '../agent/turn-queue.js';
import type { ResolvedConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { MediaHandler } from '../media/attachments.js';
import { stripLeadingMention, isNumericReply, renderQuestionList, parseNumericReply } from '../agent/question-bridge.js';

// msgId 去重已上收 dispatch 层（D3 D10：原子占位/失败释放）；本层只管会话回合。
const BUSY_TEXT = '忙线中：本会话排队已满，请稍后再试';

export interface AgentHandlerDeps {
  replyer: RobotReplyer;
  cardClient: CardClient;
  runner: ClaudeRunner;
  store: SessionStore;
  queue: TurnQueue;
  config: ResolvedConfig;
  logger: Logger;
  workspace: string;
  media: MediaHandler; // D4：媒体消息（picture/file/audio/video/richText）下载与注记
}

export function createAgentSessionHandler(deps: AgentHandlerDeps): MessageHandler {

  const sendMarkdown = async (m: InboundRobotMessage, text: string): Promise<void> => {
    if (m.conversationKind === 'p2p') {
      await deps.replyer.sendOtoMarkdown(m.robotCode, [m.senderStaffId], 'dingtalkbot', text);
    } else {
      await deps.replyer.sendGroupMarkdown(m.robotCode, m.conversationId, 'dingtalkbot', text);
    }
  };

  return async (m: InboundRobotMessage) => {
    if (m.conversationKind !== 'p2p' && m.conversationKind !== 'group') {
      deps.logger.warn('session', `未知会话类型，丢弃 msgId=${m.msgId}`);
      return;
    }
    const chatKey = m.conversationKind === 'p2p' ? `p2p:${m.senderStaffId}` : `group:${m.conversationId}`;
    const contextPrefix = `[Context: sender=${m.senderNick}, staffId=${m.senderStaffId}, chat=${m.conversationId} (${m.conversationKind})]`;

    let text: string | null = null;        // 用户文本（媒体消息可为 null）
    let attachmentNotes: string[] = [];
    if (m.msgtype === 'text') {
      if (m.textContent === null || m.textContent.trim() === '') {
        deps.logger.warn('session', `丢弃非文本/空消息 msgId=${m.msgId} msgtype=${m.msgtype} kind=${m.conversationKind}`);
        return;
      }
      text = m.conversationKind === 'group' ? stripLeadingMention(m.textContent) : m.textContent;
      if (text.trim() === '') {
        deps.logger.warn('session', `群消息剥 @ 后为空，丢弃 msgId=${m.msgId}`);
        return;
      }
    } else {
      // D4 媒体路径（G8）：忙线预检（与 enqueue 同谓词 q.depth >= maxPerChat）先于下载——满则不烧配额；
      // 下载失败终态回复后 return（不 beginTurn 不入队，不 spawn 会话）；TOCTOU 由下方 enqueue false 兜底。
      if (deps.queue.depthOf(chatKey) >= deps.config.queueMaxPerChat) {
        deps.logger.warn('session', `chat=${chatKey} 忙线（媒体预检），拒绝 msgId=${m.msgId}`);
        await sendMarkdown(m, BUSY_TEXT);
        return;
      }
      const outcome = await deps.media.handle(m);
      if (outcome === null) return; // service 已 warn（非媒体/载荷不可解析）——保持 D2 丢弃语义
      if (outcome.kind === 'error') {
        deps.logger.warn('session', `媒体下载失败 msgId=${m.msgId}: ${outcome.errorText}`);
        await sendMarkdown(m, outcome.errorText); // 发送失败上抛 → dispatch release → transport 有界重试
        return;
      }
      text = outcome.text;
      attachmentNotes = outcome.notes;
    }

    // 到达时判定：TTL 与 pending 应答都按此刻盘面决定（decisions D4）
    const { record, resume } = deps.store.beginTurn(chatKey);
    // G9 零变化公式：无注记时与原 `${contextPrefix}\n${text}` 字节等价；有注记时 text 有无各一段式
    let prompt = attachmentNotes.length > 0
      ? (text !== null && text.trim() !== ''
          ? `${contextPrefix}\n${text}\n\n${attachmentNotes.join('\n\n')}`
          : `${contextPrefix}\n\n${attachmentNotes.join('\n\n')}`)
      : `${contextPrefix}\n${text ?? ''}`;
    let isAnswerTurn = false;
    let answeredToolUseId: string | null = null;
    // 数字应答门控=仅 text 消息（richText 提取的数字文本是媒体配文，不当应答——注记不被丢弃）
    if (record.pendingQuestion !== undefined && m.msgtype === 'text' && text !== null && isNumericReply(text)) {
      const parsed = parseNumericReply(text, record.pendingQuestion);
      if (parsed.kind === 'answer') {
        isAnswerTurn = true;
        answeredToolUseId = record.pendingQuestion.toolUseId;
        prompt = `${contextPrefix}\n${parsed.answerText}`; // 数字应答只可能是 text 消息——注记不参与
      } else {
        await sendMarkdown(m, parsed.message); // help：不进 agent，pending 保留（msgId 占位在 dispatch 层）
        return;
      }
    }

    const enqueued = deps.queue.enqueue(chatKey, async () => {
      // 盘面真值：排队期间盘面可能已变（新问题覆盖/会话重置）
      const fresh = deps.store.load(chatKey);
      let effectivePrompt = prompt;
      let answerTurn = isAnswerTurn;
      if (isAnswerTurn && fresh?.pendingQuestion?.toolUseId !== answeredToolUseId) {
        deps.logger.warn('session', `chat=${chatKey} 应答的目标问题已被覆盖，降级为普通消息`);
        answerTurn = false;
        effectivePrompt = `${contextPrefix}\n${text ?? ''}`; // 类型适配：text 现为 string|null（answerTurn 语义下必为 string，行为不变）
      }

      // 盘面会话对账（code-review 修复）：排队期间会话可能已被作废（首回合失败 delete）
      // 或换代（TTL 过期被后续消息重置）——到达时快照不得对幽灵 sessionId 发 --resume，
      // 且后续一切持久化都用对账后的 effectiveRecord（不得复活幽灵 id / 倒写换代 id）。
      let effectiveRecord: SessionRecord = { ...record };
      let effectiveResume = resume;
      if (fresh === null) {
        // 继承到达时代（D3 G3）：若到达后发生过 /new，此记录按陈旧代跳过持久化
        effectiveRecord = { chatKey, sessionId: randomUUID(), epoch: record.epoch, lastActiveAt: record.lastActiveAt };
        effectiveResume = false;
        deps.logger.warn('session', `chat=${chatKey} 排队期间会话记录已作废，全新会话起`);
      } else if (fresh.sessionId !== record.sessionId) {
        effectiveRecord = { ...fresh, lastActiveAt: Math.max(fresh.lastActiveAt, record.lastActiveAt) };
        effectiveResume = true;
        deps.logger.warn('session', `chat=${chatKey} 排队期间会话已换代，跟随盘面 sessionId`);
      }

      const bridge = new AiCardBridge({
        cardClient: deps.cardClient, replyer: deps.replyer, logger: deps.logger, msg: m,
        templateId: deps.config.aiCardTemplateId, contentKey: deps.config.cardContentKey,
        minIntervalMs: deps.config.cardStreamMinIntervalMs, minBytes: deps.config.cardStreamMinBytes,
      });
      let pending: AskUserQuestionPayload | null = null;
      let preQuestionText = '';
      let lastText = '';
      const recordToPersist: SessionRecord = { ...effectiveRecord };
      try {
        await bridge.start();
        const result = await deps.runner.run(
          { prompt: effectivePrompt, sessionId: effectiveRecord.sessionId, resume: effectiveResume, cwd: deps.workspace, chatKey },
          {
            onText: (t) => { lastText = t; return bridge.pushText(t); },
            onQuestion: (p) => {
              pending = p;
              preQuestionText = lastText;
              recordToPersist.pendingQuestion = p;
              deps.store.persist({ ...recordToPersist, pendingQuestion: p }); // 即时落盘：应答可在回合结束前到达
            },
          },
        );
        if (!result.ok) {
          await bridge.fail(result.errorText, result.outputText);
          // 失败：pending 回退到盘面真值（本轮新题不成立；旧题保留可继续应答）
          recordToPersist.pendingQuestion = fresh?.pendingQuestion;
          if (!effectiveResume) {
            deps.store.delete(chatKey); // 本回合即全新会话且失败：作废记录，下条消息全新起
          } else {
            deps.store.persist(recordToPersist);
          }
        } else if (pending !== null) {
          await bridge.finish(`${preQuestionText}\n\n${renderQuestionList(pending)}`);
          recordToPersist.pendingQuestion = pending;
          deps.store.persist(recordToPersist);
        } else if (answerTurn) {
          await bridge.finish(result.outputText !== '' ? result.outputText : '（本轮无文本输出）');
          recordToPersist.pendingQuestion = undefined; // 应答成功且目标匹配 → 清除
          deps.store.persist(recordToPersist);
        } else {
          await bridge.finish(result.outputText !== '' ? result.outputText : '（本轮无文本输出）');
          recordToPersist.pendingQuestion = fresh?.pendingQuestion; // 普通回合不清除旧 pending
          deps.store.persist(recordToPersist);
        }
        deps.logger.info('session', `回合完成 chat=${chatKey} ok=${result.ok} 时长=${result.durationMs}ms 卡flush=${bridge.flushes} 抑制=${bridge.suppressed}`);
      } catch (err) {
        // 回合内异常：卡收终不悬挂，盘面回退真值后 rethrow（队列记日志）
        await bridge.fail(String(err), lastText);
        recordToPersist.pendingQuestion = fresh?.pendingQuestion;
        if (!effectiveResume) deps.store.delete(chatKey);
        else deps.store.persist(recordToPersist);
        throw err;
      }
    });
    if (!enqueued) {
      deps.logger.warn('session', `chat=${chatKey} 忙线，拒绝 msgId=${m.msgId}`);
      await sendMarkdown(m, BUSY_TEXT); // 送达失败会上抛（dispatch 层 release 占位，adapter 可重试）
    }
  };
}
