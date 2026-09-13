import type { Logger } from '../logger.js';
import type { TransportState } from '../state.js';

export type { TransportState } from '../state.js';

export type ConversationKind = 'p2p' | 'group' | 'unknown';

export interface InboundRobotMessage {
  msgId: string;
  conversationId: string;
  conversationKind: ConversationKind;
  senderStaffId: string;
  senderNick: string;
  robotCode: string;
  msgtype: string;            // SDK 仅类型化 text；其余防御透传
  textContent: string | null; // text 时为原始 content（不 trim，echo 按字节原样回显）
  sessionWebhook: string | null; // 携带仅供观测；回复不走它（Q4）
  raw: unknown;
}

export type MessageHandler = (msg: InboundRobotMessage) => Promise<void>;
export type StateListener = (state: TransportState, detail: string) => void;

export interface DingtalkTransport {
  start(): Promise<void>;   // 首次 connected+registered 才 resolve；首次超时 reject（AC1）
  stop(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onStateChange(listener: StateListener): void;
}

export interface TransportOptions {
  clientId: string;
  clientSecret: string;
  logger: Logger;
  startTimeoutMs?: number;      // default 30_000（仅约束首次注册）
  registeredWaitMs?: number;    // default 5_000
  backoffBaseMs?: number;       // default 1_000
  backoffCapMs?: number;        // default 60_000
  watchdogPollMs?: number;      // default 500（socket close 信号之外的双保险轮询）
  maxHandlerAttempts?: number;  // default 3（D3 本地有界重试）
  handlerRetryDelayMs?: number; // default 500
  handlerBudgetMs?: number;     // default 50_000：全部尝试总预算，压在 60s 重推窗口内
  connectAttemptTimeoutMs?: number; // default 30_000：挂起的 connect() 不得 wedge 监督
  sleep?: (ms: number) => Promise<void>; // 测试注入（记录退避时长/即时返回）
  now?: () => number;                      // 测试注入
}

export function conversationKindOf(rawType: unknown): ConversationKind {
  return rawType === '1' ? 'p2p' : rawType === '2' ? 'group' : 'unknown';
}

export function normalizeRobotMessage(payload: unknown): InboundRobotMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const msgtype = str(p.msgtype);
  const content = p.text && typeof p.text === 'object' ? (p.text as Record<string, unknown>).content : undefined;
  return {
    msgId: str(p.msgId),
    conversationId: str(p.conversationId),
    conversationKind: conversationKindOf(p.conversationType),
    senderStaffId: str(p.senderStaffId),
    senderNick: str(p.senderNick),
    robotCode: str(p.robotCode),
    msgtype,
    textContent: msgtype === 'text' && typeof content === 'string' ? content : null,
    sessionWebhook: str(p.sessionWebhook) || null,
    raw: payload,
  };
}
