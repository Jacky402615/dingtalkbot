import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePidFile, readPidFile, clearPidFile, isProcessAlive, pidStartMatches } from '../../src/pid.js';

test('pidfile: 写/读/清 + 自身进程存活与起始时刻匹配', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-pid-'));
  const f = join(dir, 'x.pid');
  writePidFile(f, process.pid);
  const rec = readPidFile(f);
  expect(rec?.pid).toBe(process.pid);
  expect(typeof rec?.startedAt).toBe('number');
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(pidStartMatches(f, process.pid)).toBe(true);
  expect(isProcessAlive(999_999_999)).toBe(false);
  clearPidFile(f);
  expect(readPidFile(f)).toBeNull();
});
