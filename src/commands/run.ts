import { bootstrapWorkspace, loadConfig, resolveConfig } from '../config.js';
import { loadBotEnv } from '../env.js';
import { createFileLogger } from '../logger.js';
import { writePidFile, clearPidFile } from '../pid.js';
import { TokenManager } from '../openapi/token.js';
import { RobotReplyer } from '../openapi/robot.js';
import { CardClient } from '../openapi/card.js';
import { ClaudeRunner } from '../agent/claude-runner.js';
import { SessionStore } from '../agent/session-store.js';
import { TurnQueue } from '../agent/turn-queue.js';
import { createAgentSessionHandler, type AgentHandlerDeps } from '../handlers/agent-session.js';
import { Gateway } from '../gateway.js';
import { DingtalkSdkTransport } from '../transport/dingtalk-sdk-adapter.js';
import type { DingtalkTransport, TransportOptions } from '../transport/types.js';

export interface RunOverrides {
  transportFactory?: (opts: TransportOptions) => DingtalkTransport;
  depsOverrides?: Partial<AgentHandlerDeps>; // 装配线可测（注入 fake runner/queue 等）
  signalHook?: (handler: (sig: string) => Promise<void>) => void; // 观察真实 shutdown 处理器（测试直接调用）
}

export async function runCommand(
  workspace: string,
  overrides: RunOverrides = {},
  exit: (code: number) => never = (c) => process.exit(c),
): Promise<void> {
  const paths = bootstrapWorkspace(workspace);
  const { logger, logFilePath, linkLatest } = createFileLogger(paths.logsDir);
  linkLatest();
  logger.info('run', `工作区 ${workspace}；日志 ${logFilePath}`);
  const env = loadBotEnv(paths.botDir); // 缺失/缺键 → EnvError 抛给 cli（exit 1，AC1）；此时尚未写 pidfile
  const config = resolveConfig(loadConfig(paths), logger);
  if (config.aiCardTemplateId === '') {
    logger.warn('run', 'config 未配置 ai_card_template_id —— 回复将以纯 markdown 输出（请在钉钉卡片平台创建 AI 卡模板后填入）');
  }
  if (config.agentPermissionMode === 'bypassPermissions') {
    logger.warn('run', 'agent 以 bypassPermissions 运行（无头全权限）；D3 访问控制落地前，请确保机器人仅暴露于受控会话');
  }
  const pid = process.pid;
  const startedAt = new Date().toISOString();
  const tokenManager = new TokenManager({ clientId: env.clientId, clientSecret: env.clientSecret, cacheFile: paths.tokenCacheFile, logger });
  const replyer = new RobotReplyer({ tokenManager, logger });
  const cardClient = new CardClient({ tokenManager, logger });
  const runner = new ClaudeRunner({ bin: config.claudeBin, model: config.model, permissionMode: config.agentPermissionMode, timeoutMs: config.agentTurnTimeoutMs, logger });
  const store = new SessionStore({ sessionsDir: paths.sessionsDir, ttlMs: config.sessionIdleTtlMinutes * 60_000, logger });
  const queue = new TurnQueue({ maxPerChat: config.queueMaxPerChat, logger });
  const handlerDeps: AgentHandlerDeps = { replyer, cardClient, runner, store, queue, config, logger, workspace, ...overrides.depsOverrides };
  const effectiveRunner = handlerDeps.runner; // 关停作用于实际跑回合的实例（可被 overrides 注入替换）
  const effectiveQueue = handlerDeps.queue;
  const handler = createAgentSessionHandler(handlerDeps);
  const baseOpts: TransportOptions = { clientId: env.clientId, clientSecret: env.clientSecret, logger };
  const transport = overrides.transportFactory
    ? overrides.transportFactory(baseOpts)
    : new DingtalkSdkTransport(baseOpts);
  const gateway = new Gateway({ transport, logger, stateFile: paths.stateFile, pid, startedAt, handler });
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('run', `收到 ${signal}，关停中`);
    effectiveQueue.close();         // 拒新 + 丢弃排队回合（关停后不再 spawn）
    await effectiveRunner.killAll(); // detached 子进程组不随父退出——TERM→KILL 升级收尾完成才继续
    await effectiveQueue.drainActive(); // 在飞回合的卡收终/会话持久化完成才退出（卡不悬挂）
    await gateway.stop();
    if (!clearPidFile(paths.pidFile)) logger.warn('run', `pidfile 清理失败: ${paths.pidFile}`);
    logger.info('run', '已退出');
    exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  overrides.signalHook?.(shutdown); // 观察者拿到的就是真实处理器
  // 全部依赖构造成功后才登记 pidfile：构造期抛错不残留 pidfile
  writePidFile(paths.pidFile, pid);
  try {
    await gateway.start(); // Gateway 内部失败已 stop 清理
  } catch (err) {
    logger.error('run', `启动失败: ${String(err)}`);
    effectiveQueue.close();
    await effectiveRunner.killAll();
    if (!clearPidFile(paths.pidFile)) logger.warn('run', `pidfile 清理失败: ${paths.pidFile}`);
    throw err; // cli 层转非零退出（AC1）
  }
}
