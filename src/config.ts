import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkspacePaths {
  workspace: string;
  botDir: string;
  logsDir: string;
  sessionsDir: string;
  uploadsDir: string;
  pidsDir: string;
  envFile: string;
  configFile: string;
  accessFile: string;
  stateFile: string;
  tokenCacheFile: string;
  pidFile: string;
}

export interface BotConfig { /* D1 无运行时键；D2/D3 保留 */ }

const DEFAULT_ACCESS = { admin: [], approved: [], groups: [] }; // D3 前无语义，占位

export function resolveWorkspace(explicit?: string): string {
  return explicit ?? process.cwd();
}

export function bootstrapWorkspace(workspace: string): WorkspacePaths {
  const botDir = join(workspace, '.bot');
  const paths: WorkspacePaths = {
    workspace,
    botDir,
    logsDir: join(botDir, 'logs'),
    sessionsDir: join(botDir, 'sessions'),
    uploadsDir: join(botDir, 'uploads'),
    pidsDir: join(botDir, 'pids'),
    envFile: join(botDir, '.env'),
    configFile: join(botDir, 'config.json'),
    accessFile: join(botDir, 'access.json'),
    stateFile: join(botDir, 'state.json'),
    tokenCacheFile: join(botDir, 'token.json'),
    pidFile: join(botDir, 'pids', 'dingtalkbot.pid'),
  };
  for (const dir of [botDir, paths.logsDir, paths.sessionsDir, paths.uploadsDir, paths.pidsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(paths.configFile)) writeFileSync(paths.configFile, '{}\n', { mode: 0o600 });
  if (!existsSync(paths.accessFile)) writeFileSync(paths.accessFile, JSON.stringify(DEFAULT_ACCESS, null, 2) + '\n', { mode: 0o600 });
  return paths;
}

export function loadConfig(paths: WorkspacePaths): BotConfig {
  if (!existsSync(paths.configFile)) return {};
  try {
    return JSON.parse(readFileSync(paths.configFile, 'utf8')) as BotConfig;
  } catch (err) {
    console.error(`[config] config.json 解析失败，回退空配置: ${String(err)}`);
    return {};
  }
}
