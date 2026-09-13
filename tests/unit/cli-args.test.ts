// 注意 import 的是纯解析模块 src/cli-args.ts（不是入口 src/cli.ts：
// 入口 import 即执行 main()，会把测试套件杀掉）
import { test, expect } from 'bun:test';
import { parseArgs } from '../../src/cli-args.js';

test('parseArgs: 子命令/-r/setup 旗标/缺省 root 合法', () => {
  expect(parseArgs(['run'])).toEqual({ command: 'run' });
  expect(parseArgs(['status', '-r', '/tmp/w'])).toEqual({ command: 'status', root: '/tmp/w' });
  expect(parseArgs(['setup', '--client-id', 'a', '--client-secret', 'b'])).toEqual({ command: 'setup', clientId: 'a', clientSecret: 'b' });
  expect(parseArgs(['--version'])).toEqual({ command: '__version' });
});

test('parseArgs: 空参/未知旗标/旗标缺值 → null', () => {
  expect(parseArgs([])).toBeNull();
  expect(parseArgs(['run', '--bogus'])).toBeNull();
  expect(parseArgs(['run', '-r'])).toBeNull();
});
