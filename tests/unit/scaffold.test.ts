import { test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';

test('scaffold: 包身份与依赖 pin 正确', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(pkg.name).toBe('@jacky402615/dingtalkbot');
  expect(pkg.bin.dingtalkbot).toBe('./dist/cli.js');
  expect(pkg.dependencies['dingtalk-stream']).toBe('2.1.5'); // exact pin，latest 是 beta
  expect(existsSync('tsconfig.json')).toBe(true);
  const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8'));
  expect(tsconfig.include).toContain('tests'); // 测试纳入 typecheck
});
