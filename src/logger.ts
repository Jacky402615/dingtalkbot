import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(module: string, msg: string, extra?: unknown): void;
  info(module: string, msg: string, extra?: unknown): void;
  warn(module: string, msg: string, extra?: unknown): void;
  error(module: string, msg: string, extra?: unknown): void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function runId(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function lineOf(level: LogLevel, module: string, msg: string, extra?: unknown): string {
  const record: Record<string, unknown> = { ts: new Date().toISOString(), level, module, msg };
  if (extra !== undefined) record.extra = extra;
  return JSON.stringify(record);
}

export function createFileLogger(logsDir: string): { logger: Logger; logFilePath: string; linkLatest(): void } {
  mkdirSync(logsDir, { recursive: true });
  // 同秒重启防碰撞：已存在则追加 -2/-3… 序号（每 run 一个文件的证据隔离）
  let logFilePath = join(logsDir, `${runId()}.log`);
  for (let seq = 2; existsSync(logFilePath); seq++) {
    logFilePath = join(logsDir, `${runId()}-${seq}.log`);
  }
  const minLevel: LogLevel = process.env.DEBUG ? 'debug' : 'info';
  const write = (level: LogLevel, module: string, msg: string, extra?: unknown) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    try {
      appendFileSync(logFilePath, lineOf(level, module, msg, extra) + '\n');
    } catch (err) {
      console.error(`[logger] 日志写入失败（不遮蔽业务错误）: ${String(err)}`);
    }
  };
  const logger: Logger = {
    debug: (m, msg, e) => write('debug', m, msg, e),
    info: (m, msg, e) => write('info', m, msg, e),
    warn: (m, msg, e) => write('warn', m, msg, e),
    error: (m, msg, e) => write('error', m, msg, e),
  };
  function linkLatest(): void {
    const link = join(logsDir, 'latest.log');
    try {
      if (existsSync(link)) rmSync(link);
      symlinkSync(logFilePath, link);
    } catch {
      try { copyFileSync(logFilePath, link); } catch (err) { console.error(`[logger] latest.log 链接/复制失败: ${String(err)}`); }
    }
  }
  return { logger, logFilePath, linkLatest };
}

export const consoleLogger: Logger = {
  debug: (m, msg, e) => console.log(lineOf('debug', m, msg, e)),
  info: (m, msg, e) => console.log(lineOf('info', m, msg, e)),
  warn: (m, msg, e) => console.warn(lineOf('warn', m, msg, e)),
  error: (m, msg, e) => console.error(lineOf('error', m, msg, e)),
};
