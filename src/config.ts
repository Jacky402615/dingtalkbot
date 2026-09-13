import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './logger.js';

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

export interface BotConfig {
  session_idle_ttl_minutes?: number;
  ai_card_template_id?: string;
  card_content_key?: string;
  model?: string;
  agent_permission_mode?: string;
  agent_turn_timeout_ms?: number;
  claude_bin?: string;
  card_stream_min_interval_ms?: number;
  card_stream_min_bytes?: number;
  queue_max_per_chat?: number;
  media_max_bytes?: number;
}

export interface ResolvedConfig {
  sessionIdleTtlMinutes: number;
  aiCardTemplateId: string;
  cardContentKey: string;
  model: string;
  agentPermissionMode: string; // 'bypassPermissions' | 'acceptEdits'
  agentTurnTimeoutMs: number;
  claudeBin: string;
  cardStreamMinIntervalMs: number;
  cardStreamMinBytes: number;
  queueMaxPerChat: number;
  mediaMaxBytes: number;
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  sessionIdleTtlMinutes: 60,
  aiCardTemplateId: '',
  cardContentKey: 'content',
  model: 'glm-5.3-flash',
  agentPermissionMode: 'bypassPermissions',
  agentTurnTimeoutMs: 600_000,
  claudeBin: 'claude',
  cardStreamMinIntervalMs: 1_500,
  cardStreamMinBytes: 64,
  queueMaxPerChat: 10,
  mediaMaxBytes: 20 * 1024 * 1024, // D4：单文件与每消息聚合共用上限（D4/D13）
};

const POSITIVE_KEYS: Array<[keyof BotConfig & string, keyof ResolvedConfig & string]> = [
  ['session_idle_ttl_minutes', 'sessionIdleTtlMinutes'],
  ['agent_turn_timeout_ms', 'agentTurnTimeoutMs'],
  ['card_stream_min_interval_ms', 'cardStreamMinIntervalMs'],
  ['card_stream_min_bytes', 'cardStreamMinBytes'],
  ['queue_max_per_chat', 'queueMaxPerChat'],
  ['media_max_bytes', 'mediaMaxBytes'],
];

export function resolveConfig(raw: BotConfig, logger?: Logger): ResolvedConfig {
  const cfg = { ...DEFAULT_CONFIG };
  for (const [rawKey, key] of POSITIVE_KEYS) {
    const v = raw[rawKey];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      logger?.warn('config', `config.json 键 ${rawKey} 非正数（${String(v)}），用默认 ${cfg[key]}`);
    } else {
      (cfg as Record<string, unknown>)[key] = v;
    }
  }
  if (typeof raw.ai_card_template_id === 'string') cfg.aiCardTemplateId = raw.ai_card_template_id;
  if (typeof raw.card_content_key === 'string' && raw.card_content_key !== '') cfg.cardContentKey = raw.card_content_key;
  if (typeof raw.model === 'string' && raw.model !== '') cfg.model = raw.model;
  if (typeof raw.claude_bin === 'string' && raw.claude_bin !== '') cfg.claudeBin = raw.claude_bin;
  const pm = raw.agent_permission_mode;
  if (pm !== undefined) {
    if (pm === 'bypassPermissions' || pm === 'acceptEdits') cfg.agentPermissionMode = pm;
    else logger?.warn('config', `config.json 键 agent_permission_mode 未知（${String(pm)}），用默认 ${cfg.agentPermissionMode}`);
  }
  return cfg;
}

const DEFAULT_ACCESS = { admin: [], approved: [], groups: [] }; // D3 起生效：admin∪approved=p2p 白名单，groups=openConversationId 白名单；手工编辑、每消息读盘

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
