import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../../src/commands/run.js';
import { saveBotEnv } from '../../src/env.js';
import { bootstrapWorkspace } from '../../src/config.js';
import { FakeDwClient } from '../helpers/fake-dw-client.js';
import { DingtalkSdkTransport } from '../../src/transport/dingtalk-sdk-adapter.js';
import { readPidFile } from '../../src/pid.js';

test('runCommand: 假 transport 下全链路启动（env→gateway→state/pid 落盘）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-run-'));
  const paths = bootstrapWorkspace(ws);
  saveBotEnv(paths.botDir, { clientId: 'ck', clientSecret: 'cs' });
  const client = new FakeDwClient();
  const seenOpts: Array<{ clientId: string }> = [];
  await runCommand(ws, {
    transportFactory: (opts) => {
      seenOpts.push(opts);
      return new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client });
    },
  });
  expect(seenOpts[0]?.clientId).toBe('ck');
  expect(client.connectCalls).toBeGreaterThanOrEqual(1);
  expect(existsSync(paths.stateFile)).toBe(true);
  expect(JSON.parse(readFileSync(paths.stateFile, 'utf8')).transport).toBe('connected');
  expect(readPidFile(paths.pidFile)?.pid).toBe(process.pid);
});

test('runCommand: 缺 .env → 抛 EnvError（不写 pidfile）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-run2-'));
  await expect(runCommand(ws)).rejects.toThrow(/setup/);
});
