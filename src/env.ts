import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class EnvError extends Error {}

export const ENV_KEYS = {
  clientId: 'DINGTALK_CLIENT_ID',
  clientSecret: 'DINGTALK_CLIENT_SECRET',
} as const;

export interface DingtalkEnv { clientId: string; clientSecret: string }

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadBotEnv(botDir: string): DingtalkEnv {
  const envFile = join(botDir, '.env');
  if (!existsSync(envFile)) throw new EnvError(`缺少 ${envFile} —— 先运行 dingtalkbot setup`);
  // 权限漂移（如 0644）→ 读取前先收紧；收紧失败则响亮拒绝（不带着泄露继续跑）
  const mode = statSync(envFile).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    try {
      chmodSync(envFile, 0o600);
    } catch (err) {
      throw new EnvError(`${envFile} 权限为 ${mode.toString(8)}（非 0600）且收紧失败，拒绝读取: ${String(err)}`);
    }
  }
  const parsed = parseEnvFile(readFileSync(envFile, 'utf8'));
  const clientId = parsed[ENV_KEYS.clientId];
  const clientSecret = parsed[ENV_KEYS.clientSecret];
  const missing = [!clientId && ENV_KEYS.clientId, !clientSecret && ENV_KEYS.clientSecret].filter(Boolean);
  if (missing.length > 0) throw new EnvError(`.env 缺少必填键: ${missing.join(', ')}`);
  return { clientId, clientSecret };
}

export function saveBotEnv(botDir: string, env: DingtalkEnv): void {
  const file = join(botDir, '.env');
  const content = `# dingtalkbot credentials\n${ENV_KEYS.clientId}=${env.clientId}\n${ENV_KEYS.clientSecret}=${env.clientSecret}\n`;
  // 已存在的 0644 文件：先收紧再写，消除"写入后到 chmod 前"的可读窗口；收紧失败则拒绝写入
  if (existsSync(file)) {
    try { chmodSync(file, 0o600); } catch (err) { throw new EnvError(`无法收紧 ${file} 权限，拒绝写入凭据: ${String(err)}`); }
  }
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600); // 覆写已有文件时 Node 不改权限位——显式收紧（planted 0644 场景）
}
