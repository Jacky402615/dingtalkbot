import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessLoader, parseAccessList, tierOf, isGroupAllowed, emptyAccessList } from '../../src/access.js';

const log = (warns: string[]) => ({ debug() {}, info() {}, warn: (_s: string, m: string) => warns.push(m), error() {} });

test('access: 合法文件——admin/approved 分层判定与群白名单', () => {
  const list = parseAccessList({ admin: ['st0'], approved: ['st1'], groups: ['cidG'] })!;
  expect(tierOf(list, 'st0')).toBe('admin');
  expect(tierOf(list, 'st1')).toBe('approved');
  expect(tierOf(list, 'stX')).toBe('unknown');
  expect(isGroupAllowed(list, 'cidG')).toBe(true);
  expect(isGroupAllowed(list, 'cidOther')).toBe(false);
});

test('access: 形状非法 → null（fail-closed 前置）', () => {
  expect(parseAccessList(null)).toBeNull();
  expect(parseAccessList({ admin: 'st0', approved: [], groups: [] })).toBeNull();   // 非数组
  expect(parseAccessList({ admin: [1], approved: [], groups: [] })).toBeNull();     // 元素非 string
  expect(parseAccessList({ approved: [], groups: [] })).toBeNull();                 // 缺键
});

test('access: 每消息读盘即时生效；解析失败 fail-closed（admin 也拒）且按签名限频（G2）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-acc-'));
  const file = join(dir, 'access.json');
  writeFileSync(file, JSON.stringify({ admin: ['st0'], approved: [], groups: [] }));
  const warns: string[] = [];
  const load = createAccessLoader(file, log(warns));
  expect(tierOf(load(), 'st0')).toBe('admin');
  writeFileSync(file, '{broken');                       // 手改坏
  const denied = load();
  expect(denied).toEqual(emptyAccessList());             // 全拒
  expect(tierOf(denied, 'st0')).toBe('unknown');         // admin 也被锁出（fail-closed 实证）
  expect(load()).toEqual(emptyAccessList());             // 再读仍全拒
  expect(load()).toEqual(emptyAccessList());             // 同签名只 warn 一次
  expect(warns.filter((w) => w.includes('解析失败'))).toHaveLength(1);
  writeFileSync(file, JSON.stringify({ admin: [], approved: ['st0'], groups: [] }));
  expect(tierOf(load(), 'st0')).toBe('approved');        // 修好即恢复，签名重置
});

test('access: readFile 注入——首次 ENOENT 重试命中；两次失败 fail-closed（重试分支确定性覆盖）', () => {
  const warns: string[] = [];
  const good = JSON.stringify({ admin: ['st0'], approved: [], groups: [] });
  let calls = 0;
  const rfRetryOk = (_f: string): string => {
    calls += 1;
    if (calls === 1) { const e = new Error('swap 中间态') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; }
    return good;
  };
  const load1 = createAccessLoader('/x/access.json', log(warns), rfRetryOk);
  expect(load1()).toEqual({ admin: ['st0'], approved: [], groups: [] }); // 单次重试命中新文件
  expect(warns).toHaveLength(0);
  const rfAlwaysGone = (): string => { const e = new Error('gone') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; };
  const load2 = createAccessLoader('/x/access.json', log(warns), rfAlwaysGone);
  expect(load2()).toEqual(emptyAccessList());            // 两次 ENOENT → fail-closed
  expect(warns.some((w) => w.includes('fail-closed'))).toBe(true);
});
