// 入口（import 即执行 main；bun build 的打包根）
import { readFileSync } from 'node:fs';
import { parseArgs } from './cli-args.js';
import { runCommand } from './commands/run.js';
import { startCommand, MissingEnvError, AlreadyRunningError } from './commands/start.js';
import { stopCommand, NotRunningError } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { setupCommand, SetupSmokeError } from './commands/setup.js';

const USAGE = `dingtalkbot — DingTalk Stream 网关
用法: dingtalkbot <setup|run|start|stop|status> [-r <workspace>] [--client-id <id> --client-secret <secret>]
  setup   交互/旗标录入凭据 + 冒烟（token + Stream 连接）
  run     前台运行
  start   后台守护启动
  stop    停止守护
  status  连接状态
  -v/--version`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.error(USAGE);
    process.exit(1);
  }
  const workspace = args.root ?? process.cwd();
  try {
    switch (args.command) {
      case '__version': {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        console.log(pkg.version);
        break;
      }
      case 'setup': await setupCommand({ root: workspace, clientId: args.clientId, clientSecret: args.clientSecret }); break;
      case 'run': await runCommand(workspace); break;
      case 'start': startCommand(workspace); break;
      case 'stop': await stopCommand(workspace); break;
      case 'status': statusCommand(workspace); break;
      default:
        console.error(USAGE);
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof MissingEnvError || err instanceof AlreadyRunningError || err instanceof NotRunningError || err instanceof SetupSmokeError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(`[dingtalkbot] 致命错误: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  }
}

void main();
