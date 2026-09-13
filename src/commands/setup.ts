import * as readline from 'node:readline/promises';
import { bootstrapWorkspace } from '../config.js';
import { saveBotEnv } from '../env.js';
import { TokenManager } from '../openapi/token.js';
import { DingtalkSdkTransport, type DwClientLike } from '../transport/dingtalk-sdk-adapter.js';
import { consoleLogger } from '../logger.js';

export class SetupSmokeError extends Error {}

export interface SetupArgs {
  root?: string;
  clientId?: string;
  clientSecret?: string;
  transportClient?: DwClientLike; // 测试注入
  fetchFn?: typeof fetch;         // 测试注入
  startTimeoutMs?: number;        // 测试注入
}

export async function setupCommand(args: SetupArgs): Promise<void> {
  const paths = bootstrapWorkspace(args.root ?? process.cwd());
  // 旗标语义：undefined=未提供（可交互询问）；空串=显式给空 → 立即响亮失败（不进 readline）
  let clientId = args.clientId === undefined ? undefined : args.clientId.trim();
  let clientSecret = args.clientSecret === undefined ? undefined : args.clientSecret.trim();
  if (clientId === '' || clientSecret === '') throw new SetupSmokeError('凭据为空 —— 放弃 setup');
  if (clientId === undefined || clientSecret === undefined) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (clientId === undefined) clientId = (await rl.question('DINGTALK_CLIENT_ID (clientId): ')).trim();
      if (clientSecret === undefined) clientSecret = (await rl.question('DINGTALK_CLIENT_SECRET (clientSecret): ')).trim();
    } finally {
      rl.close();
    }
  }
  if (!clientId || !clientSecret) throw new SetupSmokeError('凭据为空 —— 放弃 setup');
  saveBotEnv(paths.botDir, { clientId, clientSecret });
  console.log(`已写入 ${paths.envFile}（0600）`);
  // 冒烟：token 获取 + Stream 连接订阅（响亮成败，AC5）
  const fetchFn = args.fetchFn ?? fetch;
  try {
    const tm = new TokenManager({ clientId, clientSecret, cacheFile: paths.tokenCacheFile, logger: consoleLogger, fetchFn });
    const token = await tm.getAccessToken();
    consoleLogger.info('setup', `token 获取成功（${token.slice(0, 6)}…）`);
    const transport = new DingtalkSdkTransport({
      clientId, clientSecret, logger: consoleLogger,
      startTimeoutMs: args.startTimeoutMs ?? 20_000,
      clientFactory: args.transportClient ? () => args.transportClient! : undefined,
    });
    await transport.start();
    consoleLogger.info('setup', 'Stream 连接+订阅成功');
    await transport.stop();
    console.log('smoke: PASS');
  } catch (err) {
    console.error(`smoke: FAIL —— ${String(err instanceof Error ? err.message : err)}`);
    throw new SetupSmokeError(`凭据冒烟失败: ${String(err)}`);
  }
}
