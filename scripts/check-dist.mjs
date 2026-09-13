import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];
if (!existsSync('dist/cli.js')) {
  console.error('check:dist FAIL — 缺少 dist/cli.js（先 bun run build）');
  process.exit(1);
}
// 1) bin 可执行性：shebang 必须是 node
const cliText = readFileSync('dist/cli.js', 'utf8');
if (!cliText.startsWith('#!/usr/bin/env node\n')) {
  problems.push(`dist/cli.js 首行不是 node shebang，实际: ${JSON.stringify(cliText.slice(0, 40))}`);
}
// 2) 递归扫描 dist 全部产物（含未来新增 chunk），杜绝机器路径逃逸
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    const text = readFileSync(p, 'utf8');
    for (const pattern of [/\/home\/[^"'\s]+/, /\/Users\/[^"'\s]+/, /\/tmp\//, /wiki-symphony-ws/, /VM-\d+-ubuntu/]) {
      const m = text.match(pattern);
      if (m) problems.push(`${p} 含机器路径: ${m[0]}`);
    }
  }
}
walk('dist');
// 3) external 验证：SDK 以裸说明符引用（被内联打包则说明 external 失效）
if (!/["']dingtalk-stream["']/.test(cliText)) {
  problems.push('dist/cli.js 未以裸说明符引用 dingtalk-stream（external 失效，SDK 被打包内联）');
}
if (problems.length > 0) {
  for (const p of problems) console.error(`check:dist FAIL — ${p}`);
  process.exit(1);
}
console.log('check:dist PASS（shebang 正确；全 dist 无机器路径；dingtalk-stream 保持 external）');
