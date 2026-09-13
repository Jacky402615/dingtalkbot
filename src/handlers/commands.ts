import type { InboundRobotMessage } from '../transport/types.js';
import type { RobotReplyer } from '../openapi/robot.js';
import type { SessionStore } from '../agent/session-store.js';
import type { AccessList } from '../access.js';
import type { ConnectionStateSnapshot } from '../state.js';
import type { Logger } from '../logger.js';

export type CommandName = 'new' | 'stop' | 'status' | 'help';

const HELP_TEXT = [
  'dingtalkbot 命令：',
  '- /new — 重置会话（下一条消息开始全新对话）',
  '- /stop — 中止当前正在生成的回合',
  '- /status — 查看连接与会话状态',
  '- /help — 显示本帮助',
  '',
  '提示：机器人提问时可直接回复选项编号（多选用逗号分隔，如 1,3）。',
].join('\n');

export function parseCommand(text: string): CommandName | null {
  const t = text.trim().toLowerCase();
  if (t === '/new') return 'new';
  if (t === '/stop') return 'stop';
  if (t === '/status') return 'status';
  if (t === '/help') return 'help';
  return null;
}

export async function sendChatMarkdown(replyer: RobotReplyer, m: InboundRobotMessage, text: string): Promise<void> {
  if (m.conversationKind === 'p2p') {
    await replyer.sendOtoMarkdown(m.robotCode, [m.senderStaffId], 'dingtalkbot', text);
  } else {
    await replyer.sendGroupMarkdown(m.robotCode, m.conversationId, 'dingtalkbot', text);
  }
}

export interface CommandDeps {
  replyer: RobotReplyer;
  store: SessionStore;
  queue: { queuedDepthOf(chatKey: string): number; runningCountOf(chatKey: string): number };
  runner: { activeCountOf(chatKey: string): number; abortChat(chatKey: string, reason: string): Promise<number> };
  loadAccess: () => AccessList;
  status: () => ConnectionStateSnapshot | null;
  logger: Logger;
  now?: () => number;
  abortGuardMs?: number; // /stop await 的防御性上界（默认 7_000 = killDelay 5s + 2s 余量）
}

const chatKeyOf = (m: InboundRobotMessage): string =>
  m.conversationKind === 'p2p' ? `p2p:${m.senderStaffId}` : `group:${m.conversationId}`;

function humanUptime(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  const h = Math.floor(mins / 60); const rest = mins % 60;
  return h > 0 ? `${h}h${rest}m` : `${rest}m`;
}

function renderStatus(m: InboundRobotMessage, deps: CommandDeps): string {
  const snap = deps.status();
  const now = (deps.now ?? Date.now)();
  const lines: string[] = ['**dingtalkbot 状态**'];
  lines.push(`- 连接：${snap?.transport ?? 'unknown'}（${snap?.detail ?? '无快照'}）`);
  if (snap) lines.push(`- 运行：since ${snap.startedAt}（uptime ${humanUptime(Math.max(0, now - Date.parse(snap.startedAt)))}）pid=${snap.pid}`);
  const sessions = deps.store.list();
  const access = deps.loadAccess();
  lines.push(`- 会话：${sessions.length} 个`);
  if (m.conversationKind === 'group') {
    // G6：群内只出概览+计数——会话明细与访问名单不向全群广播
    lines.push(`- 访问：admin ${access.admin.length} · approved ${access.approved.length} · 群白名单 ${access.groups.length}`);
    return lines.join('\n');
  }
  for (const s of sessions.slice(0, 10)) {
    const kind = s.chatKey.startsWith('p2p:') ? 'p2p' : 'group';
    lines.push(`  - [${kind}] ${s.chatKeyHash} 活跃于 ${new Date(s.lastActiveAt).toISOString()}${s.pending ? '（待作答）' : ''}`);
  }
  if (sessions.length > 10) lines.push(`  - …及另 ${sessions.length - 10} 个`);
  lines.push(`- 访问：admin ${access.admin.length} · approved ${access.approved.length} · 群白名单 ${access.groups.length}（admin v1 仅信息性）`);
  if (access.admin.length > 0) lines.push(`  - admin: ${access.admin.join(', ')}`);
  if (access.approved.length > 0) lines.push(`  - approved: ${access.approved.join(', ')}`);
  return lines.join('\n');
}

export function createCommandExecutor(deps: CommandDeps): (name: CommandName, m: InboundRobotMessage) => Promise<void> {
  return async (name, m) => {
    const chatKey = chatKeyOf(m);
    if (name === 'help') { await sendChatMarkdown(deps.replyer, m, HELP_TEXT); return; }
    if (name === 'status') { await sendChatMarkdown(deps.replyer, m, renderStatus(m, deps)); return; }
    if (name === 'new') {
      const inFlight = deps.runner.activeCountOf(chatKey) > 0;
      try {
        deps.store.reset(chatKey);
      } catch (err) {
        // 删除失败不谎报成功（reset 响亮上抛）；也不上抛——命令层收容后回失败文案
        deps.logger.error('cmd', `chat=${chatKey} /new 重置失败: ${String(err)}`);
        await sendChatMarkdown(deps.replyer, m, '会话重置失败：会话文件无法删除（检查磁盘/权限后重试）。');
        return;
      }
      deps.logger.info('cmd', `chat=${chatKey} /new 会话重置${inFlight ? '（在飞回合继续收尾）' : ''}`);
      await sendChatMarkdown(deps.replyer, m, inFlight
        ? '会话已重置：下一条消息开始全新对话。当前在飞回合不受影响，将继续收尾，其输出仍会送达。'
        : '会话已重置：下一条消息开始全新对话。');
      return;
    }
    // /stop
    if (deps.runner.activeCountOf(chatKey) === 0) {
      const depth0 = deps.queue.queuedDepthOf(chatKey);
      if (deps.queue.runningCountOf(chatKey) > 0) {
        // job 在飞但 runner 未注册——可能是启动窗口（bridge.start→spawn），也可能是
        // 收尾窗口（runner 已 settle、桥仍在收终）。单一诚实文案覆盖两态，不误报"无在飞"。
        deps.logger.info('cmd', `chat=${chatKey} /stop 落在回合启动/收尾窗口（job 在飞、runner 无注册）`);
        await sendChatMarkdown(deps.replyer, m, depth0 > 0
          ? `当前没有可中止的运行回合（正在启动或收尾）；队列中仍有 ${depth0} 条排队消息。若回合仍在生成，请稍后再次发送 /stop。`
          : '当前没有可中止的运行回合（正在启动或收尾）。若回合仍在生成，请稍后再次发送 /stop。');
        return;
      }
      await sendChatMarkdown(deps.replyer, m, depth0 > 0
        ? `当前无在飞回合（队列中仍有 ${depth0} 条排队消息）。`
        : '当前无在飞回合。');
      return;
    }
    await sendChatMarkdown(deps.replyer, m, '正在中止当前回合…');
    const guardMs = deps.abortGuardMs ?? 7_000; // escalation 链自身有界；防御性上界防意外悬挂
    let timedOut = false;
    let guardTimer: ReturnType<typeof setTimeout> | null = null;
    let aborted = 0;
    await Promise.race([
      deps.runner.abortChat(chatKey, '用户 /stop').then((n) => { aborted = n; }),
      new Promise<void>((r) => { guardTimer = setTimeout(() => { timedOut = true; r(); }, guardMs); }),
    ]);
    if (guardTimer !== null) clearTimeout(guardTimer);
    const depth = deps.queue.queuedDepthOf(chatKey);
    if (timedOut) {
      // 诚实文案：超时意味着 escalation 链未按预期 settle——不谎报"已中止"（D13）
      deps.logger.error('cmd', `chat=${chatKey} /stop 中止未在 ${guardMs}ms 内完成（防御性超时先行返回）`);
      await sendChatMarkdown(deps.replyer, m, '中止指令已发出，但未在预期时间内完成（进程组升级终止仍在进行）。');
      return;
    }
    if (aborted === 0) {
      // "正在中止"发送窗口内回合自然完成——如实回复（不误报中止），排队状态照披露
      deps.logger.info('cmd', `chat=${chatKey} /stop 时回合已自然结束（无需中止）`);
      await sendChatMarkdown(deps.replyer, m, depth > 0
        ? `回合已自然结束，无需中止。队列中仍有 ${depth} 条排队消息，将依次执行。`
        : '回合已自然结束，无需中止。');
      return;
    }
    deps.logger.info('cmd', `chat=${chatKey} /stop 中止完成（aborted=${aborted} 排队 ${depth}）`);
    await sendChatMarkdown(deps.replyer, m, depth > 0
      ? `已中止当前回合。队列中仍有 ${depth} 条排队消息，将依次执行。`
      : '已中止当前回合。');
  };
}
