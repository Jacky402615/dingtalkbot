import { bootstrapWorkspace } from '../config.js';
import { loadBotEnv } from '../env.js';
import { createFileLogger } from '../logger.js';
import { writePidFile, clearPidFile } from '../pid.js';
import { TokenManager } from '../openapi/token.js';
import { RobotReplyer } from '../openapi/robot.js';
import { createEchoHandler } from '../handlers/echo.js';
import { Gateway } from '../gateway.js';
import { DingtalkSdkTransport } from '../transport/dingtalk-sdk-adapter.js';
import type { DingtalkTransport, TransportOptions } from '../transport/types.js';

export interface RunOverrides { transportFactory?: (opts: TransportOptions) => DingtalkTransport }

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
  const pid = process.pid;
  const startedAt = new Date().toISOString();
  const tokenManager = new TokenManager({ clientId: env.clientId, clientSecret: env.clientSecret, cacheFile: paths.tokenCacheFile, logger });
  const replyer = new RobotReplyer({ tokenManager, logger });
  const handler = createEchoHandler({ replyer, logger });
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
    await gateway.stop();
    if (!clearPidFile(paths.pidFile)) logger.warn('run', `pidfile 清理失败: ${paths.pidFile}`);
    logger.info('run', '已退出');
    exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  // 全部依赖构造成功后才登记 pidfile：构造期抛错不残留 pidfile
  writePidFile(paths.pidFile, pid);
  try {
    await gateway.start(); // Gateway 内部失败已 stop 清理（Task 10）
  } catch (err) {
    logger.error('run', `启动失败: ${String(err)}`);
    if (!clearPidFile(paths.pidFile)) logger.warn('run', `pidfile 清理失败: ${paths.pidFile}`);
    throw err; // cli 层转非零退出（AC1）
  }
}
