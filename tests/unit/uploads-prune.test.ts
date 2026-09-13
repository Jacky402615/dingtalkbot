import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, utimesSync, lutimesSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneUploads, startPruneLoop, UPLOAD_RETENTION_DAYS } from '../../src/media/uploads-prune.js';

const DAY = 86_400_000;
const logs: string[] = [];
const logger = { debug() {}, info: (_s: string, m: string) => { logs.push(m); }, warn: (_s: string, m: string) => { logs.push(m); }, error() {} } as never;
// utimes/lutimes 的数字参数按秒解释——一律用 Date 对象（ms 精度）
const touch = (p: string, ageDays: number) => {
  const t = new Date(Date.now() - ageDays * DAY);
  utimesSync(p, t, t);
};

test('prune: AC5——删 >30d 文件、保留新文件；非空/含子目录日期目录与非日期目录不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-prune-'));
  const d2026 = join(dir, '2026-08-01'); const dOld = join(dir, '2025-01-01');
  mkdirSync(d2026); mkdirSync(dOld); mkdirSync(join(dir, 'not-a-date'));
  writeFileSync(join(d2026, 'a.png'), 'x'); touch(join(d2026, 'a.png'), 40);
  writeFileSync(join(d2026, 'b.png'), 'x'); touch(join(d2026, 'b.png'), 10);   // 新——保留
  writeFileSync(join(dOld, 'c.png'), 'x'); touch(join(dOld, 'c.png'), 40);     // 旧——删
  mkdirSync(join(dOld, 'subdir')); writeFileSync(join(dOld, 'subdir', 'd'), 'x'); // 非预期子目录——防御不动
  const r = pruneUploads(dir, logger);
  expect(UPLOAD_RETENTION_DAYS).toBe(30);
  expect(r.removedFiles).toBe(2);                                  // a.png + c.png
  expect(r.removedDirs).toBe(0);                                   // d2026 有新文件、dOld 有子目录——目录均保留
  expect(readdirSync(d2026)).toEqual(['b.png']);
  expect(readdirSync(dOld)).toEqual(['subdir']);                   // 子目录防御不动
  expect(readdirSync(join(dir, 'not-a-date'))).toBeDefined();      // 非日期目录不动
});

test('prune: 全旧日期目录删空后连目录一起删；symlink 不跟随（lutimes 只老化链接自身，目标不动）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-prune2-'));
  const d = join(dir, '2026-07-01');
  mkdirSync(d);
  const target = join(dir, 'target.bin'); writeFileSync(target, 'x');
  const link = join(d, 'link.bin');
  symlinkSync(target, link);
  const old = new Date(Date.now() - 40 * DAY);
  lutimesSync(link, old, old); // 不跟随符号链接（utimesSync 会改目标 mtime）
  writeFileSync(join(d, 'old.png'), 'x'); touch(join(d, 'old.png'), 40);
  const r = pruneUploads(dir, logger);
  expect(r.removedFiles).toBe(2);           // link+old（link 按文件 unlink，目标不动）
  expect(r.removedDirs).toBe(1);            // 删空且无失败 → 目录一并删
  expect(readdirSync(dir)).toEqual(['target.bin']); // 目标文件未被波及（含未被改龄）
});

test('prune loop: 启动异步一次 + 定时触发；stop 后不再删', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-prune3-'));
  const d = join(dir, '2026-08-01');
  mkdirSync(d);
  writeFileSync(join(d, 'a.bin'), 'x'); touch(join(d, 'a.bin'), 40);
  const loop = startPruneLoop(dir, undefined, { intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 20));       // 启动 kick + 至少一轮定时
  expect(existsSync(join(d, 'a.bin'))).toBe(false);  // 已删（AC5 的循环面）
  mkdirSync(d, { recursive: true });                 // 删空后目录被一并移除——重建后再种 b
  writeFileSync(join(d, 'b.bin'), 'x'); touch(join(d, 'b.bin'), 40);
  loop.stop();
  await new Promise((r) => setTimeout(r, 30));
  expect(existsSync(join(d, 'b.bin'))).toBe(true);   // stop 后不再跑
});
