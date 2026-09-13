import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger.js';

export const UPLOAD_RETENTION_DAYS = 30; // issue 定死（feishubot parity）——非 config
const DAY_MS = 86_400_000;
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface PruneResult { removedFiles: number; removedDirs: number; failures: number }

// 只认 uploads/ 下一级 YYYY-MM-DD 目录；文件按 mtime 判老；lstat 不跟随 symlink（链接按文件 unlink，目标不动）；
// 目录内非预期子目录 → 整目录跳过（防御）；删空且无失败的日期目录一并移除；逐项容错聚合计数（D7）。
export function pruneUploads(uploadsDir: string, logger?: Logger, now: () => number = Date.now): PruneResult {
  const cutoff = now() - UPLOAD_RETENTION_DAYS * DAY_MS;
  const result: PruneResult = { removedFiles: 0, removedDirs: 0, failures: 0 };
  let entries: string[];
  try { entries = readdirSync(uploadsDir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger?.warn('media', `uploads 根目录读取失败（跳过本轮 prune）: ${String(err)}`);
    return result;
  }
  for (const name of entries) {
    const dirPath = join(uploadsDir, name);
    let st;
    try { st = lstatSync(dirPath); } catch { result.failures += 1; continue; }
    if (!st.isDirectory() || !DATE_DIR_RE.test(name)) continue;
    let files: string[];
    try { files = readdirSync(dirPath); } catch { result.failures += 1; continue; }
    let remaining = 0;
    let dirFailures = 0;
    for (const f of files) {
      const fp = join(dirPath, f);
      let fst;
      try { fst = lstatSync(fp); } catch { result.failures += 1; dirFailures += 1; continue; }
      if (fst.isDirectory()) { remaining += 1; continue; } // 非预期子目录不动
      try {
        if (fst.mtimeMs < cutoff) { unlinkSync(fp); result.removedFiles += 1; }
        else remaining += 1;
      } catch { result.failures += 1; dirFailures += 1; remaining += 1; }
    }
    if (remaining === 0 && dirFailures === 0) {
      // rmdirSync 而非 rmSync——Bun 的 rmSync 对目录恒 EFAULT（实测 2026-09-13）
      try { rmdirSync(dirPath); result.removedDirs += 1; } catch { result.failures += 1; }
    }
  }
  if (result.removedFiles > 0 || result.removedDirs > 0) {
    logger?.info('media', `uploads prune：删除 ${result.removedFiles} 个文件、${result.removedDirs} 个日期目录`);
  }
  if (result.failures > 0) logger?.warn('media', `uploads prune：${result.failures} 项失败（已跳过）`);
  return result;
}

// 启动异步执行一次（不阻塞 boot）+ 每 24h 定时；single-flight；stop 清定时器（D7）。
export function startPruneLoop(uploadsDir: string, logger?: Logger, opts: { intervalMs?: number; now?: () => number } = {}): { stop(): void } {
  const intervalMs = opts.intervalMs ?? DAY_MS;
  let running = false;
  let stopped = false;
  const run = (): void => {
    if (stopped || running) return;
    running = true;
    try { pruneUploads(uploadsDir, logger, opts.now); }
    catch (err) { logger?.warn('media', `uploads prune 执行异常（下轮重试）: ${String(err)}`); } // 不静默
    finally { running = false; }
  };
  const kick = setTimeout(run, 0);
  kick.unref?.();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { stop(): void { stopped = true; clearInterval(timer); clearTimeout(kick); } };
}
