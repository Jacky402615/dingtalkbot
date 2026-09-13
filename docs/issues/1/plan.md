# dingtalkbot D1（Gateway skeleton: DingTalk Stream transport + OpenAPI reply + markdown echo）Implementation Plan

**Goal:** 搭起 dingtalkbot 仓库骨架并用纯 markdown echo 打通「Stream 收信 → OpenAPI 回信」端到端链路。

**Architecture:** wechatbot 家族形态——port/adapter 接缝隔离官方 `dingtalk-stream` SDK（adapter 是唯一 SDK import 点，自建指数退避监督循环补上 SDK 缺失的 loud-failure 与 backoff）；回复走自管 token 的 OpenAPI REST client（fetch、single-flight、memory+disk 缓存）；薄 Gateway 装配 + 可插拔 handler；CLI `setup|run|start|stop|status` 守护进程化。

**Tech Stack:** bun（构建/测试工具）+ TypeScript strict + `dingtalk-stream@2.1.5`（exact pin，唯一运行时依赖）+ node 内建 API（fs/readline/fetch）+ `bun test` + GitHub Actions + GitHub Packages。

**Spec:** `docs/issues/1/decisions.md`

## Global Constraints

- **AC1**: 凭据来自 `.env` 能连接并订阅；订阅/认证失败必须响亮（非零退出 / error 日志），不得静默。
- **AC2**: p2p 入站文本经 `oToMessages/batchSend` 回 markdown echo；群 @ 经 `groupMessages/send` 回群 markdown echo。
- **AC3**: 断线自动指数退避重连；网关不 wedge（**运行期重连永不因超时退出监督**，超时仅约束首次注册）。
- **AC4**: access token 有缓存、到期前刷新、并发下只取一次（single-flight）；缓存随凭据轮换失效。
- **AC5**: `dingtalkbot setup` 写 `.env` 且 smoke 真凭据 PASS / 假凭据响亮 FAIL；`dingtalkbot status` 报告连接状态。
- **AC6**: SDK 藏在 adapter 接口后（换 SDK 只动 adapter）；tests + typecheck 绿；SPEC.md 与行为一致；dist 无机器路径（external 打包验证）。
- **feishubot #62 教训**：任何错误/**丢弃**路径必须留 error/warn 日志，禁止静默吞掉（丢弃用 warn，失败用 error）。
- **feishubot #76 教训**：`dingtalk-stream` 声明为 bundler external，`check:dist` 验证 dist 无构建机路径。
- **node-builtin-only**：`src/` 内只允许 node 内建模块 + `dingtalk-stream`（仅 adapter）+ 自有模块；禁止新增运行时依赖。
- **每任务门禁**：每个 commit 前跑全量 `bun run typecheck && bun test`（跑当时已存在的全部测试）。
- **无占位实现**：任何 commit 不包含空函数/TODO 桩。
- **SPEC 只写已验证行为**：live 项显式标注 `live-verified` 或 `CI-verified`。
- 提交信息用 conventional commits（`feat(scope): …` / `test(scope): …` / `docs: …`）。

## Tasks

### Task 1: 仓库脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `tests/unit/scaffold.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: npm 包 `@jacky402615/dingtalkbot`（bin `dingtalkbot` → `dist/cli.js`）；脚本 `build`/`check:dist`/`typecheck`/`test`；依赖 `dingtalk-stream` exact 2.1.5。typecheck 覆盖 `src` + `scripts` + `tests`（测试类型漂移不漏检）。

- [x] **Step 1: 写 package.json / tsconfig / .gitignore**

```json
// package.json
{
  "name": "@jacky402615/dingtalkbot",
  "version": "0.1.0",
  "description": "DingTalk chat gateway: Stream-mode transport + OpenAPI reply",
  "type": "module",
  "license": "MIT",
  "bin": { "dingtalkbot": "./dist/cli.js" },
  "files": ["dist", "SPEC.md", "README.md", "CHANGELOG.md"],
  "scripts": {
    "build": "bun build src/cli.ts --target=node --outdir=dist --external dingtalk-stream && node -e \"const fs=require('fs');fs.writeFileSync('dist/cli.js','#!/usr/bin/env node\\n'+fs.readFileSync('dist/cli.js','utf8'))\" && chmod +x dist/cli.js",
    "check:dist": "node scripts/check-dist.mjs",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "dingtalk-stream": "2.1.5"
  },
  "devDependencies": {
    "bun-types": "1.3.14",
    "typescript": "^5.5.4"
  },
  "publishConfig": { "registry": "https://npm.pkg.github.com" },
  "repository": { "type": "git", "url": "git+https://github.com/Jacky402615/dingtalkbot.git" }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  },
  "include": ["src", "scripts", "tests"],
  "exclude": ["dist", "node_modules"]
}
```

```text
# .gitignore
node_modules/
dist/
.bot/
*.log
```

- [x] **Step 2: 安装依赖** — Run: `bun install && bun add -E dingtalk-stream@2.1.5` Expected: `bun.lock` 生成，`node_modules/dingtalk-stream/package.json` 的 `version` 为 `2.1.5`。

- [x] **Step 3: 写失败测试** `tests/unit/scaffold.test.ts`

```ts
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
```

- [x] **Step 4: 验证 PASS** — Run: `bun test tests/unit/scaffold.test.ts` Expected: PASS（1 test）。

- [x] **Step 5: README 骨架** — 写一句定位 + CLI 表 + 指向 SPEC.md（内容在 Task 12 充实）。

- [x] **Step 6: Commit** — `bun run typecheck && bun test && git add -A && git commit -m "chore(scaffold): package skeleton with pinned dingtalk-stream 2.1.5"`

### Task 2: `.bot/.env` 解析（src/env.ts）

**Files:**
- Create: `src/env.ts`
- Test: `tests/unit/env.test.ts`

**Interfaces:**
- Produces: `EnvError`；`parseEnvFile(text): Record<string,string>`；`loadBotEnv(botDir): DingtalkEnv`（缺文件/缺键抛 `EnvError`，响亮）；`saveBotEnv(botDir, env)`（0600）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/env.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile, loadBotEnv, saveBotEnv, EnvError } from '../../src/env.js';

test('parseEnvFile: 键值/引号/注释/空行/格式异常行', () => {
  const parsed = parseEnvFile('# 注释\nA=1\nB = "two"\nC=x'y\n\nD=\n不是键值行');
  expect(parsed).toEqual({ A: '1', B: 'two', C: "x'y", D: '' });
});

test('loadBotEnv: 缺文件/缺键响亮抛 EnvError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-env-'));
  expect(() => loadBotEnv(dir)).toThrow(EnvError);
  writeFileSync(join(dir, '.env'), 'DINGTALK_CLIENT_ID=abc\n');
  try {
    loadBotEnv(dir);
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvError);
    expect(String(err)).toContain('DINGTALK_CLIENT_SECRET');
  }
});

test('saveBotEnv + loadBotEnv 往返，权限 0600（含覆写 planted 0644 文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-env-'));
  saveBotEnv(dir, { clientId: 'cid', clientSecret: 'sec' });
  const text = readFileSync(join(dir, '.env'), 'utf8');
  expect(text).toContain('DINGTALK_CLIENT_ID=cid');
  expect((statSync(join(dir, '.env')).mode & 0o777) & 0o077).toBe(0o600);
  // 已存在的 0644 文件被覆写后必须被显式收紧
  writeFileSync(join(dir, '.env'), 'x', { mode: 0o644 });
  saveBotEnv(dir, { clientId: 'cid2', clientSecret: 'sec2' });
  expect((statSync(join(dir, '.env')).mode & 0o777) & 0o077).toBe(0o600);
  expect(loadBotEnv(dir)).toEqual({ clientId: 'cid2', clientSecret: 'sec2' });
});
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/env.test.ts` Expected: FAIL — `Cannot find module '../../src/env.js'`。

- [ ] **Step 3: 实现** `src/env.ts`

```ts
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600); // 覆写已有文件时 Node 不改权限位——显式收紧（planted 0644 场景）
}
```

- [ ] **Step 4: 验证 PASS** — Run: `bun test tests/unit/env.test.ts` Expected: PASS（3 tests）。

- [ ] **Step 5: Commit** — `bun run typecheck && bun test && git add src/env.ts tests/unit/env.test.ts && git commit -m "feat(env): explicit .bot/.env parser with loud missing-credential errors"`

### Task 3: 工作区引导（src/config.ts）

**Files:**
- Create: `src/config.ts`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Produces: `WorkspacePaths`（botDir/logsDir/sessionsDir/uploadsDir/pidsDir/envFile/configFile/accessFile/stateFile/tokenCacheFile/pidFile）；`resolveWorkspace(explicit?)`；`bootstrapWorkspace(workspace)`（建目录树 + 幂等写默认 config.json/access.json，0600）；`loadConfig(paths)`（损坏→stderr 警告 + 空配置，不抛）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/config.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapWorkspace, resolveWorkspace, loadConfig } from '../../src/config.js';

test('bootstrapWorkspace: 建全目录树 + 默认 config/access 幂等', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-ws-'));
  const p1 = bootstrapWorkspace(ws);
  expect(p1.botDir).toBe(join(ws, '.bot'));
  for (const dir of [p1.logsDir, p1.sessionsDir, p1.uploadsDir, p1.pidsDir]) {
    expect(existsSync(dir)).toBe(true);
  }
  expect(JSON.parse(readFileSync(p1.accessFile, 'utf8'))).toEqual({ admin: [], approved: [], groups: [] });
  writeFileSync(p1.configFile, '{"x":1}');
  const p2 = bootstrapWorkspace(ws); // 二次引导不覆盖已有文件
  expect(JSON.parse(readFileSync(p2.configFile, 'utf8'))).toEqual({ x: 1 });
});

test('resolveWorkspace: 显式优先，缺省 cwd', () => {
  expect(resolveWorkspace('/tmp/w')).toBe('/tmp/w');
  expect(resolveWorkspace(undefined)).toBe(process.cwd());
});

test('loadConfig: 损坏 JSON 警告并回退空对象（不抛）', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-ws-'));
  const p = bootstrapWorkspace(ws);
  writeFileSync(p.configFile, '{oops');
  expect(loadConfig(p)).toEqual({});
});
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/config.test.ts` Expected: FAIL — `Cannot find module '../../src/config.js'`。

- [ ] **Step 3: 实现** `src/config.ts`

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkspacePaths {
  workspace: string; botDir: string;
  logsDir: string; sessionsDir: string; uploadsDir: string; pidsDir: string;
  envFile: string; configFile: string; accessFile: string;
  stateFile: string; tokenCacheFile: string; pidFile: string;
}

export interface BotConfig { /* D1 无运行时键；D2/D3 保留 */ }

const DEFAULT_ACCESS = { admin: [], approved: [], groups: [] }; // D3 前无语义，占位

export function resolveWorkspace(explicit?: string): string {
  return explicit ?? process.cwd();
}

export function bootstrapWorkspace(workspace: string): WorkspacePaths {
  const botDir = join(workspace, '.bot');
  const paths: WorkspacePaths = {
    workspace, botDir,
    logsDir: join(botDir, 'logs'), sessionsDir: join(botDir, 'sessions'),
    uploadsDir: join(botDir, 'uploads'), pidsDir: join(botDir, 'pids'),
    envFile: join(botDir, '.env'), configFile: join(botDir, 'config.json'),
    accessFile: join(botDir, 'access.json'), stateFile: join(botDir, 'state.json'),
    tokenCacheFile: join(botDir, 'token.json'), pidFile: join(botDir, 'pids', 'dingtalkbot.pid'),
  };
  for (const dir of [botDir, paths.logsDir, paths.sessionsDir, paths.uploadsDir, paths.pidsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(paths.configFile)) writeFileSync(paths.configFile, '{}\n', { mode: 0o600 });
  if (!existsSync(paths.accessFile)) writeFileSync(paths.accessFile, JSON.stringify(DEFAULT_ACCESS, null, 2) + '\n', { mode: 0o600 });
  return paths;
}

export function loadConfig(paths: WorkspacePaths): BotConfig {
  if (!existsSync(paths.configFile)) return {};
  try {
    return JSON.parse(readFileSync(paths.configFile, 'utf8')) as BotConfig;
  } catch (err) {
    console.error(`[config] config.json 解析失败，回退空配置: ${String(err)}`);
    return {};
  }
}
```

- [ ] **Step 4: 验证 PASS** — Run: `bun test tests/unit/config.test.ts` Expected: PASS（3 tests）。

- [ ] **Step 5: Commit** — `bun run typecheck && bun test && git add src/config.ts tests/unit/config.test.ts && git commit -m "feat(config): .bot/ workspace bootstrap with idempotent defaults"`

### Task 4: JSONL 日志器（src/logger.ts）

**Files:**
- Create: `src/logger.ts`
- Test: `tests/unit/logger.test.ts`

**Interfaces:**
- Produces: `LogLevel`、`Logger { debug/info/warn/error(module, msg, extra?) }`；`createFileLogger(logsDir): { logger, logFilePath, linkLatest() }`（文件名 `YYYYMMDD_HHMMSS.log`；`latest.log` 符号链接失败回退复制；写失败可见不遮蔽）；`consoleLogger`（stdout/stderr JSON 行）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/logger.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileLogger } from '../../src/logger.js';

test('createFileLogger: 文件名格式 + JSONL 追加 + latest.log 链接', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-log-'));
  const { logger, logFilePath, linkLatest } = createFileLogger(dir);
  expect(logFilePath).toMatch(/\d{8}_\d{6}\.log$/);
  logger.info('transport', 'hello', { k: 1 });
  logger.debug('transport', '隐藏（默认 info 级）');
  linkLatest();
  const lines = readFileSync(logFilePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ level: 'info', module: 'transport', msg: 'hello', extra: { k: 1 } });
  expect(existsSync(join(dir, 'latest.log'))).toBe(true);
});

test('createFileLogger: DEBUG 环境变量放开 debug 级；同秒两次创建不碰撞', () => {
  const prev = process.env.DEBUG;
  process.env.DEBUG = '1';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dtb-log-'));
    const { logger, logFilePath } = createFileLogger(dir);
    logger.debug('x', '可见');
    const lines = readFileSync(logFilePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const second = createFileLogger(dir); // 同一秒内再次创建（快速重启）
    expect(second.logFilePath).not.toBe(logFilePath);
  } finally { process.env.DEBUG = prev; }
});
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/logger.test.ts` Expected: FAIL — `Cannot find module '../../src/logger.js'`。

- [ ] **Step 3: 实现** `src/logger.ts`

```ts
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
```

- [ ] **Step 4: 验证 PASS** — Run: `bun test tests/unit/logger.test.ts` Expected: PASS（2 tests）。

- [ ] **Step 5: Commit** — `bun run typecheck && bun test && git add src/logger.ts tests/unit/logger.test.ts && git commit -m "feat(logger): dependency-free JSONL logger with latest.log link"`

### Task 5: 原子状态写入 + pidfile（src/state.ts, src/pid.ts）

**Files:**
- Create: `src/state.ts`, `src/pid.ts`
- Test: `tests/unit/state.test.ts`, `tests/unit/pid.test.ts`

**Interfaces:**
- Produces（state.ts）：`TransportState = 'stopped'|'starting'|'connected'|'reconnecting'`（**定义于此，transport/types.ts re-export**，避免环）；`ConnectionStateSnapshot`；`writeStateJson`（tmp+rename 原子写 0600）；`readStateJson`（缺文件/损坏 → null）。
- Produces（pid.ts）：`PidRecord { pid, startedAt }`（startedAt = /proc 第 22 字段 ticks，抗 pid 复用）；`writePidFile/readPidFile/clearPidFile/isProcessAlive/readProcessStartedAt/pidStartMatches`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/state.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStateJson, readStateJson } from '../../src/state.js';

test('writeStateJson: 原子写 + 读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-st-'));
  const f = join(dir, 'state.json');
  writeStateJson(f, { pid: 1, startedAt: 't', transport: 'connected', detail: 'x', updatedAt: 'u' });
  expect(readStateJson(f)).toEqual({ pid: 1, startedAt: 't', transport: 'connected', detail: 'x', updatedAt: 'u' });
  expect(existsSync(f + '.tmp')).toBe(false); // tmp 已 rename
});

test('readStateJson: 缺文件 null；损坏 null（status 层区分打印）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-st-'));
  const f = join(dir, 'state.json');
  expect(readStateJson(f)).toBeNull();
  writeFileSync(f, '{bad');
  expect(readStateJson(f)).toBeNull();
});
```

```ts
// tests/unit/pid.test.ts
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
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/state.test.ts tests/unit/pid.test.ts` Expected: FAIL — 两个模块均 `Cannot find module`。

- [ ] **Step 3: 实现**

```ts
// src/state.ts
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type TransportState = 'stopped' | 'starting' | 'connected' | 'reconnecting';

export interface ConnectionStateSnapshot {
  pid: number;
  startedAt: string;
  transport: TransportState;
  detail: string;
  updatedAt: string;
}

export function writeStateJson(stateFile: string, snapshot: ConnectionStateSnapshot): void {
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, stateFile);
  chmodSync(stateFile, 0o600); // rename 到已存在的路径不继承新权限位——显式收紧
}

export function readStateJson(stateFile: string): ConnectionStateSnapshot | null {
  if (!existsSync(stateFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as ConnectionStateSnapshot;
    return typeof parsed.transport === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
```

```ts
// src/pid.ts
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

export interface PidRecord { pid: number; startedAt: number } // startedAt = /proc/<pid>/stat 第22字段（ticks）

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readProcessStartedAt(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = afterComm.split(' ');
    const ticks = Number(fields[19]); // comm(2) state(3)…：')' 后 fields[0]=state，第22字段 = fields[19]
    return Number.isFinite(ticks) && ticks > 0 ? ticks : null;
  } catch { return null; }
}

export function writePidFile(pidFile: string, pid: number): void {
  writeFileSync(pidFile, JSON.stringify({ pid, startedAt: readProcessStartedAt(pid) ?? 0 }) + '\n', { mode: 0o600 });
}

export function readPidFile(pidFile: string): PidRecord | null {
  if (!existsSync(pidFile)) return null;
  try {
    const rec = JSON.parse(readFileSync(pidFile, 'utf8')) as PidRecord;
    return typeof rec.pid === 'number' ? rec : null;
  } catch { return null; }
}

export function clearPidFile(pidFile: string): void {
  try { if (existsSync(pidFile)) rmSync(pidFile); } catch { /* 清理失败不阻断关停 */ }
}

export function pidStartMatches(pidFile: string, pid: number): boolean {
  const rec = readPidFile(pidFile);
  if (!rec || rec.pid !== pid) return false;
  const current = readProcessStartedAt(pid);
  return current !== null && current === rec.startedAt;
}
```

- [ ] **Step 4: 验证 PASS** — Run: `bun test tests/unit/state.test.ts tests/unit/pid.test.ts` Expected: PASS（3 tests）。

- [ ] **Step 5: Commit** — `bun run typecheck && bun test && git add src/state.ts src/pid.ts tests/unit/state.test.ts tests/unit/pid.test.ts && git commit -m "feat(state): atomic state writer and pid-reuse-safe pidfile"`

**--- 检查点 A：基础设施完成（env/config/log/state/pid 全绿）---**

### Task 6: Transport port（src/transport/types.ts）

**Files:**
- Create: `src/transport/types.ts`
- Test: `tests/unit/transport-types.test.ts`

**Interfaces:**
- Produces: `InboundRobotMessage`（msgId/conversationId/conversationKind/senderStaffId/senderNick/robotCode/msgtype/**textContent 原样不 trim**/sessionWebhook/raw）；`ConversationKind`；`MessageHandler`；`StateListener`；`DingtalkTransport { start/stop/onMessage/onStateChange }`；`TransportOptions`（含测试注入 `sleep?`/`now?`）；`conversationKindOf(rawType)`；`normalizeRobotMessage(payload): InboundRobotMessage | null`（防御归一：仅 text 保留原始 content 字符串；未知字段透传 raw；非对象 → null）。
- Consumes: `Logger`（Task 4）、`TransportState`（Task 5）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/transport-types.test.ts
import { test, expect } from 'bun:test';
import { conversationKindOf, normalizeRobotMessage } from '../../src/transport/types.js';

test('conversationKindOf: 1→p2p 2→group 其他→unknown', () => {
  expect(conversationKindOf('1')).toBe('p2p');
  expect(conversationKindOf('2')).toBe('group');
  expect(conversationKindOf('9')).toBe('unknown');
  expect(conversationKindOf(undefined)).toBe('unknown');
});

test('normalizeRobotMessage: text 全字段且空白原样保留；非 text textContent=null；非对象 null', () => {
  const text = normalizeRobotMessage({
    msgId: 'm1', conversationId: 'cid', conversationType: '1', senderStaffId: 's1',
    senderNick: 'n', robotCode: 'rc', msgtype: 'text', sessionWebhook: 'wh',
    text: { content: ' 你好\n' },
  });
  expect(text).toMatchObject({ msgId: 'm1', conversationKind: 'p2p', senderStaffId: 's1', msgtype: 'text', textContent: ' 你好\n' });
  const pic = normalizeRobotMessage({ msgtype: 'picture', conversationType: '2', downloadCode: 'dc' });
  expect(pic?.textContent).toBeNull();
  expect(pic?.conversationKind).toBe('group');
  expect(pic?.msgId).toBe(''); // 缺省字段安全降级为空串
  expect(normalizeRobotMessage('不是对象')).toBeNull();
  expect(normalizeRobotMessage(null)).toBeNull();
});
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/transport-types.test.ts` Expected: FAIL — `Cannot find module`。

- [ ] **Step 3: 实现** `src/transport/types.ts`

```ts
import type { Logger } from '../logger.js';
import type { TransportState } from '../state.js';

export type { TransportState } from '../state.js';

export type ConversationKind = 'p2p' | 'group' | 'unknown';

export interface InboundRobotMessage {
  msgId: string;
  conversationId: string;
  conversationKind: ConversationKind;
  senderStaffId: string;
  senderNick: string;
  robotCode: string;
  msgtype: string;            // SDK 仅类型化 text；其余防御透传
  textContent: string | null; // text 时为原始 content（不 trim，echo 按字节原样回显）
  sessionWebhook: string | null; // 携带仅供观测；回复不走它（Q4）
  raw: unknown;
}

export type MessageHandler = (msg: InboundRobotMessage) => Promise<void>;
export type StateListener = (state: TransportState, detail: string) => void;

export interface DingtalkTransport {
  start(): Promise<void>;   // 首次 connected+registered 才 resolve；首次超时 reject（AC1）
  stop(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onStateChange(listener: StateListener): void;
}

export interface TransportOptions {
  clientId: string;
  clientSecret: string;
  logger: Logger;
  startTimeoutMs?: number;      // default 30_000（仅约束首次注册）
  registeredWaitMs?: number;    // default 5_000
  backoffBaseMs?: number;       // default 1_000
  backoffCapMs?: number;        // default 60_000
  watchdogPollMs?: number;      // default 500（socket close 信号之外的双保险轮询）
  maxHandlerAttempts?: number;  // default 3（D3 本地有界重试）
  handlerRetryDelayMs?: number; // default 500
  connectAttemptTimeoutMs?: number; // default 30_000：挂起的 connect() 不得 wedge 监督
  sleep?: (ms: number) => Promise<void>; // 测试注入（记录退避时长/即时返回）
  now?: () => number;                      // 测试注入
}

export function conversationKindOf(rawType: unknown): ConversationKind {
  return rawType === '1' ? 'p2p' : rawType === '2' ? 'group' : 'unknown';
}

export function normalizeRobotMessage(payload: unknown): InboundRobotMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const msgtype = str(p.msgtype);
  const content = p.text && typeof p.text === 'object' ? (p.text as Record<string, unknown>).content : undefined;
  return {
    msgId: str(p.msgId),
    conversationId: str(p.conversationId),
    conversationKind: conversationKindOf(p.conversationType),
    senderStaffId: str(p.senderStaffId),
    senderNick: str(p.senderNick),
    robotCode: str(p.robotCode),
    msgtype,
    textContent: msgtype === 'text' && typeof content === 'string' ? content : null,
    sessionWebhook: str(p.sessionWebhook) || null,
    raw: payload,
  };
}
```

- [ ] **Step 4: 验证 PASS** — Run: `bun test tests/unit/transport-types.test.ts` Expected: PASS（2 tests）。

- [ ] **Step 5: Commit** — `bun run typecheck && bun test && git add src/transport/types.ts tests/unit/transport-types.test.ts && git commit -m "feat(transport): SDK-free transport port types with defensive message normalization"`

### Task 7: SDK adapter + fake DWClient（最高风险任务）

**Files:**
- Create: `src/transport/dingtalk-sdk-adapter.ts`, `tests/helpers/fake-dw-client.ts`
- Test: `tests/unit/adapter.test.ts`

**Interfaces:**
- Consumes: `DingtalkTransport`/`TransportOptions`/`normalizeRobotMessage`（Task 6）。
- Produces: `DingtalkSdkTransport implements DingtalkTransport`；`DwClientLike`（结构化窄接口：`config/connected/registered/socket{on}/registerCallbackListener/socketCallBackResponse/connect/disconnect`）；`DwClientFactory`；`TransportStartError`；`TransportStoppedError`。监督契约：构造后 `client.config.autoReconnect=false`；`start()` 首次 registered resolve；**首次**超 `startTimeoutMs` 未注册 → disconnect + `TransportStartError`（此后 `stopped=true`，可重新 start）；**运行期断线永续退避重连（不受 deadline 约束）**；每次 `connect()` 套 per-attempt 超时（首次阶段与 deadline 赛跑；运行期 `connectAttemptTimeoutMs` 默认 30s）——挂起的 connect 不 wedge 监督；socket close/error 事件立即唤醒重连（带代际守卫，旧 socket 迟到事件不误触新连接；watchdog 轮询为双保险）；`stop()` 唤醒所有等待、结算未决 start（reject `TransportStoppedError`）、断开连接；消息处理 = 解析 → handler（≤3 次重试）→ **始终 ack**。

- [ ] **Step 1: 写 fake helper** `tests/helpers/fake-dw-client.ts`

```ts
import { EventEmitter } from 'node:events';
import type { DwClientLike, DWClientDownStreamLike } from '../../src/transport/dingtalk-sdk-adapter.js';

export const ROBOT_TOPIC = '/v1.0/im/bot/messages/get';

export class FakeSocket {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, cb: (...args: unknown[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }
  emitClose(): void {
    for (const cb of this.listeners.get('close') ?? []) cb();
  }
}

export class FakeDwClient extends EventEmitter implements DwClientLike {
  config: { autoReconnect?: boolean } = { autoReconnect: true };
  connected = false;
  registered = false;
  socket: FakeSocket | null = null;
  connectCalls = 0;
  failNextConnects = 0;
  failForever = false;   // 永远连不上（坏凭据场景；避免有限次数被快速耗尽）
  hangConnects = 0;      // connect() 永不 resolve（挂起场景，验证 per-attempt 超时）
  registerDelayMs = 0;
  acks: Array<{ messageId: string; result: unknown }> = [];
  private seq = 0;

  registerCallbackListener(topic: string, cb: (d: DWClientDownStreamLike) => void): this {
    this.on(topic, cb as never);
    return this;
  }

  socketCallBackResponse(messageId: string, result: unknown): void {
    this.acks.push({ messageId, result });
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.hangConnects > 0) {
      this.hangConnects -= 1;
      await new Promise<void>(() => {}); // 永不 resolve
    }
    if (this.failForever || this.failNextConnects > 0) {
      if (!this.failForever) this.failNextConnects -= 1; // 模拟 SDK 吞掉连接失败：connect() 正常返回但没连上
      this.connected = false;
      this.registered = false;
      this.socket = null;
      return;
    }
    this.connected = true;
    this.socket = new FakeSocket();
    setTimeout(() => { if (this.connected) this.registered = true; }, this.registerDelayMs);
  }

  disconnect(): void {
    this.connected = false;
    this.registered = false;
    this.socket?.emitClose();
    this.socket = null;
  }

  emitRobotMessage(data: unknown, messageId?: string): void {
    this.seq += 1;
    const mid = messageId ?? `msg-${this.seq}`;
    this.emit(ROBOT_TOPIC, { headers: { messageId: mid, topic: ROBOT_TOPIC }, data: typeof data === 'string' ? data : JSON.stringify(data) } as never);
  }

  killSocket(): void { // 模拟断线：boolean 翻转 + close 事件（真 SDK close 处理器同样置 false）
    this.connected = false;
    this.registered = false;
    this.socket?.emitClose();
    this.socket = null;
  }
}
```

- [ ] **Step 2: 写失败测试** `tests/unit/adapter.test.ts`

```ts
import { test, expect } from 'bun:test';
import { DingtalkSdkTransport, TransportStartError, TransportStoppedError } from '../../src/transport/dingtalk-sdk-adapter.js';
import { FakeDwClient } from '../helpers/fake-dw-client.js';
import { consoleLogger } from '../../src/logger.js';
import type { InboundRobotMessage } from '../../src/transport/types.js';

const TEXT_PAYLOAD = { msgId: 'm1', conversationId: 'cid', conversationType: '1', senderStaffId: 's1', senderNick: 'n', robotCode: 'rc', msgtype: 'text', text: { content: 'hi' } };

function makeTransport(client: FakeDwClient, sleeps: number[] = [], opts: Record<string, unknown> = {}) {
  return new DingtalkSdkTransport({
    clientId: 'id', clientSecret: 'sec', logger: consoleLogger,
    backoffBaseMs: 10, backoffCapMs: 40, registeredWaitMs: 300, watchdogPollMs: 20,
    sleep: async (ms: number) => { sleeps.push(ms); },
    clientFactory: () => client,
    ...opts,
  });
}

test('adapter: start 成功（registered）且关闭 SDK autoReconnect', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client);
  await t.start();
  expect(client.config.autoReconnect).toBe(false);
  expect(client.connectCalls).toBeGreaterThanOrEqual(1);
  await t.stop();
});

test('adapter: 一直连不上 → 首次 startTimeoutMs 后 TransportStartError（AC1 响亮）且已断开', async () => {
  const client = new FakeDwClient();
  client.failForever = true;
  const t = makeTransport(client, [], { startTimeoutMs: 80 });
  await expect(t.start()).rejects.toBeInstanceOf(TransportStartError);
  expect(client.connected).toBe(false);
  await t.stop();
});

test('adapter: connect() 挂起不 resolve → per-attempt 超时兜底，首次 deadline 内响亮失败（不 wedge）', async () => {
  const client = new FakeDwClient();
  client.hangConnects = 100; // 每次 connect 都挂起
  const t = makeTransport(client, [], { startTimeoutMs: 120, connectAttemptTimeoutMs: 40 });
  await expect(t.start()).rejects.toBeInstanceOf(TransportStartError);
  await t.stop();
});

test('adapter: 启动等待期间 stop() → start() 以 TransportStoppedError 结算（不悬挂）', async () => {
  const client = new FakeDwClient();
  client.failForever = true;
  const t = makeTransport(client, [], { startTimeoutMs: 60_000 });
  const started = t.start();
  await new Promise((r) => setTimeout(r, 30));
  await t.stop();
  await expect(started).rejects.toBeInstanceOf(TransportStoppedError);
});

test('adapter: 消息→归一→handler→ack SUCCESS（EventAck 形状）', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client);
  const got: InboundRobotMessage[] = [];
  t.onMessage(async (m) => { got.push(m); });
  await t.start();
  client.emitRobotMessage(TEXT_PAYLOAD);
  await new Promise((r) => setTimeout(r, 50));
  expect(got).toHaveLength(1);
  expect(got[0].textContent).toBe('hi');
  expect(client.acks).toEqual([{ messageId: 'msg-1', result: { status: 'SUCCESS', message: 'OK' } }]);
  await t.stop();
});

test('adapter: data 非 JSON → 不进 handler，仍 ack + error 日志', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client);
  let called = 0;
  t.onMessage(async () => { called += 1; });
  await t.start();
  client.emitRobotMessage('不是json', 'bad-1');
  await new Promise((r) => setTimeout(r, 30));
  expect(called).toBe(0);
  expect(client.acks[0]).toMatchObject({ messageId: 'bad-1', result: { status: 'SUCCESS', message: 'parse-error' } });
  await t.stop();
});

test('adapter: handler 失败重试 3 次后尽弃 ack（防 60s 重推毒消息）', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client, [], { handlerRetryDelayMs: 1 });
  let calls = 0;
  t.onMessage(async () => { calls += 1; throw new Error('boom'); });
  await t.start();
  client.emitRobotMessage(TEXT_PAYLOAD, 'm-x');
  await new Promise((r) => setTimeout(r, 30));
  expect(calls).toBe(3);
  expect(client.acks[0]).toMatchObject({ messageId: 'm-x', result: { message: 'handler-failed' } });
  await t.stop();
});

test('adapter: handler 第 2 次成功 → 重试生效 ack OK', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client, [], { handlerRetryDelayMs: 1 });
  let calls = 0;
  t.onMessage(async () => { calls += 1; if (calls === 1) throw new Error('transient'); });
  await t.start();
  client.emitRobotMessage(TEXT_PAYLOAD, 'm-y');
  await new Promise((r) => setTimeout(r, 30));
  expect(calls).toBe(2);
  expect(client.acks[0]).toMatchObject({ messageId: 'm-y', result: { message: 'OK' } });
  await t.stop();
});

test('adapter: socket close 立即触发重连（不等 watchdog 轮询）', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client, [], { watchdogPollMs: 60_000 }); // 轮询故意拉长：只有 close 信号能唤醒
  await t.start();
  const before = client.connectCalls;
  client.killSocket();
  await new Promise((r) => setTimeout(r, 100));
  expect(client.connectCalls).toBe(before + 1);
  expect(client.registered).toBe(true);
  await t.stop();
});

test('adapter: 运行期连续失败不退出监督（AC3 无 wedge），恢复后退避重置', async () => {
  const client = new FakeDwClient();
  const sleeps: number[] = [];
  const t = makeTransport(client, sleeps); // 注入 sleep 只接收退避时长（poll 走内部 setTimeout）
  await t.start();
  client.killSocket();
  client.failNextConnects = 3; // 连续失败 3 轮
  await new Promise((r) => setTimeout(r, 300));
  expect(client.connectCalls).toBeGreaterThanOrEqual(5); // 1 首连 + 3 失败 + ≥1 成功
  expect(client.registered).toBe(true); // 恢复且监督未退出
  expect(sleeps.slice(0, 4)).toEqual([10, 20, 40, 40]); // 指数退避 → 封顶
  client.killSocket(); // 恢复后再次断线：attempt 已重置 → 又从 base 起步
  await new Promise((r) => setTimeout(r, 100));
  expect(sleeps[sleeps.length - 1]).toBe(10);
  await t.stop();
});

test('adapter: stop 后不再重连', async () => {
  const client = new FakeDwClient();
  const t = makeTransport(client);
  await t.start();
  await t.stop();
  const calls = client.connectCalls;
  client.killSocket();
  await new Promise((r) => setTimeout(r, 120));
  expect(client.connectCalls).toBe(calls);
});
```

- [ ] **Step 3: 验证 FAIL** — Run: `bun test tests/unit/adapter.test.ts` Expected: FAIL — `Cannot find module`。

- [ ] **Step 4: 实现** `src/transport/dingtalk-sdk-adapter.ts`

```ts
import { DWClient, EventAck, TOPIC_ROBOT } from 'dingtalk-stream';
import type { DingtalkTransport, MessageHandler, StateListener, TransportOptions, TransportState } from './types.js';
import { normalizeRobotMessage } from './types.js';

export class TransportStartError extends Error {}
export class TransportStoppedError extends Error {}

export interface DWClientDownStreamLike { headers: { messageId: string; topic: string }; data: string }

export interface DwClientLike {
  config: { autoReconnect?: boolean };
  connected: boolean;
  registered: boolean;
  socket: { on(event: string, cb: (...args: unknown[]) => void): void } | null;
  registerCallbackListener(topic: string, cb: (downstream: DWClientDownStreamLike) => void): unknown;
  socketCallBackResponse(messageId: string, result: unknown): void;
  connect(): Promise<void>;
  disconnect(): void;
}

export type DwClientFactory = (opts: { clientId: string; clientSecret: string }) => DwClientLike;

export const defaultDwClientFactory: DwClientFactory = (opts) =>
  new DWClient({ clientId: opts.clientId, clientSecret: opts.clientSecret, keepAlive: true });

export interface AdapterOptions extends TransportOptions { clientFactory?: DwClientFactory }

export class DingtalkSdkTransport implements DingtalkTransport {
  private handler: MessageHandler | null = null;
  private stateListener: StateListener | null = null;
  private state: TransportState = 'stopped';
  private stopped = true;
  private client: DwClientLike | null = null;
  private firstResolve: (() => void) | null = null;
  private firstReject: ((err: Error) => void) | null = null;
  private dropSignal: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0; // supervisor 代际：stop()/restart() 使旧代循环就地退出，不复活

  constructor(private readonly opts: AdapterOptions) {}

  getState(): TransportState { return this.state; }

  onMessage(handler: MessageHandler): void { this.handler = handler; }
  onStateChange(listener: StateListener): void { this.stateListener = listener; }

  private setState(state: TransportState, detail: string): void {
    this.state = state;
    this.opts.logger.info('transport', `state=${state} ${detail}`);
    this.stateListener?.(state, detail);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    const factory = this.opts.clientFactory ?? defaultDwClientFactory;
    const client = factory({ clientId: this.opts.clientId, clientSecret: this.opts.clientSecret });
    client.config.autoReconnect = false; // 监督循环自持 backoff 重连（decisions D2）
    this.client = client;
    client.registerCallbackListener(TOPIC_ROBOT, (downstream) => { void this.handleDownstream(downstream); });
    this.stopped = false;
    this.generation += 1;
    const first = new Promise<void>((resolve, reject) => { this.firstResolve = resolve; this.firstReject = reject; });
    void this.supervise(client, this.generation);
    return first;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1; // 旧代 supervisor（可能挂在 withTimeout/退避上）随后自行退出
    if (this.timer !== null) clearTimeout(this.timer);
    this.dropSignal?.(); // 唤醒 watchdog 等待
    try { this.client?.disconnect(); } catch (err) { this.opts.logger.error('transport', `disconnect 出错（继续）: ${String(err)}`); }
    const err = new TransportStoppedError('transport 已被 stop()');
    this.firstReject?.(err); // 结算未决的 start()，防悬挂
    this.firstResolve = null; this.firstReject = null;
    this.setState('stopped', 'stop() 调用');
    this.client = null;
  }

  private defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => { this.timer = setTimeout(() => { this.timer = null; resolve(); }, ms); });
  }

  private watchSocket(client: DwClientLike): void {
    try {
      const socket = client.socket; // 代际守卫：旧 socket 的迟到事件不唤醒新连接
      if (socket === null) return;
      socket.on('close', () => { if (client.socket === socket) this.dropSignal?.(); }); // 立即唤醒重连
      socket.on('error', (err) => {
        this.opts.logger.error('transport', `socket error: ${String(err)}`);
        if (client.socket === socket) this.dropSignal?.(); // SDK terminate→close 兜底外再显式唤醒
      });
    } catch (err) {
      this.opts.logger.warn('transport', `socket 监听挂载失败（仅靠 watchdog 轮询）: ${String(err)}`);
    }
  }

  private withTimeout(promise: Promise<void>, ms: number, label: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
      promise.then(() => { clearTimeout(timer); resolve(); }, (err) => { clearTimeout(timer); reject(err); });
    });
  }

  private async supervise(client: DwClientLike, gen: number): Promise<void> {
    const startTimeoutMs = this.opts.startTimeoutMs ?? 30_000;
    const registeredWaitMs = this.opts.registeredWaitMs ?? 5_000;
    const baseMs = this.opts.backoffBaseMs ?? 1_000;
    const capMs = this.opts.backoffCapMs ?? 60_000;
    const pollMs = this.opts.watchdogPollMs ?? 500;
    const attemptTimeoutMs = this.opts.connectAttemptTimeoutMs ?? 30_000; // 挂起的 connect 不得 wedge 监督
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ? (ms: number) => this.opts.sleep!(ms) : (ms: number) => this.defaultSleep(ms);
    const alive = (): boolean => !this.stopped && this.generation === gen; // 代际守卫：旧 supervisor 不得复活
    const deadline = now() + startTimeoutMs; // 仅约束首次注册（AC3：运行期永续）
    let firstRegisteredDone = false;
    let attempt = 0;
    this.setState('starting', `首次连接 deadline=${startTimeoutMs}ms`);
    while (alive()) {
      try {
        // SDK 的 connect() 永不 reject 且内部 axios 无超时——必须外部设限。
        // 首次阶段与 start deadline 赛跑；运行期（已注册过）用固定 per-attempt 上限。
        const timeoutMs = firstRegisteredDone
          ? attemptTimeoutMs
          : Math.min(attemptTimeoutMs, Math.max(1, deadline - now()));
        await this.withTimeout(client.connect(), timeoutMs, 'connect()');
      } catch (err) {
        this.opts.logger.error('transport', `connect() 失败/超时（监督循环继续）: ${String(err)}`);
      }
      if (!alive()) return; // stop/重启：本代 supervisor 就地退出
      this.watchSocket(client);
      const ok = await this.waitForRegistered(client, registeredWaitMs, now);
      // 首次注册也受 deadline 约束：迟到（在 registeredWaitMs 内完成但已过线）同样响亮失败
      if (ok && (firstRegisteredDone || now() < deadline)) {
        firstRegisteredDone = true;
        attempt = 0;
        this.setState('connected', '已连接并订阅');
        this.firstResolve?.();
        this.firstResolve = null; this.firstReject = null;
        await this.awaitDrop(client, pollMs); // socket close 信号优先；轮询双保险
        if (!alive()) return;
        this.setState('reconnecting', '检测到断线');
      } else if (!firstRegisteredDone && now() >= deadline) {
        const detail = `启动超时 ${startTimeoutMs}ms：connected=${client.connected} registered=${client.registered}`;
        this.opts.logger.error('transport', `启动失败（响亮失败）: ${detail}`);
        this.setState('stopped', detail);
        this.stopped = true;
        try { client.disconnect(); } catch { /* 已断 */ }
        this.firstReject?.(new TransportStartError(`dingtalk-stream 连接超时: ${detail}`));
        this.firstResolve = null; this.firstReject = null;
        return;
      }
      attempt += 1;
      const delay = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      this.setState('reconnecting', `attempt=${attempt}，${delay}ms 后重连`);
      await sleep(delay);
    }
  }

  private async awaitDrop(client: DwClientLike, pollMs: number): Promise<void> {
    let signal: () => void = () => {};
    const dropped = new Promise<void>((r) => { signal = r; });
    this.dropSignal = signal;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      while (!this.stopped && client.connected && client.registered) {
        await Promise.race([
          dropped,
          new Promise<void>((r) => { pollTimer = setTimeout(() => r(), pollMs); }),
        ]);
        if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; } // 输了的轮询定时器必须清（防悬挂）
      }
    } finally {
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (this.dropSignal === signal) this.dropSignal = null;
    }
  }

  private async waitForRegistered(client: DwClientLike, waitMs: number, now: () => number): Promise<boolean> {
    const end = now() + waitMs;
    for (;;) {
      if (this.stopped) return false;
      if (client.registered && client.connected) return true;
      if (!client.connected || now() >= end) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private async handleDownstream(downstream: DWClientDownStreamLike): Promise<void> {
    const messageId = downstream?.headers?.messageId ?? '';
    const ack = (message: string) => {
      try {
        this.client?.socketCallBackResponse(messageId, { status: EventAck.SUCCESS, message });
      } catch (err) {
        this.opts.logger.error('transport', `ack 发送失败: ${String(err)}`);
      }
    };
    let payload: unknown;
    try {
      payload = JSON.parse(downstream?.data ?? '');
    } catch (err) {
      this.opts.logger.error('transport', `消息 data JSON 解析失败（丢弃并 ack）: ${String(err)}`);
      ack('parse-error');
      return;
    }
    const msg = normalizeRobotMessage(payload);
    if (msg === null) {
      this.opts.logger.warn('transport', '消息载荷非对象（丢弃并 ack）');
      ack('bad-payload');
      return;
    }
    this.opts.logger.info('transport', `收到消息 msgId=${msg.msgId || '?'} kind=${msg.conversationKind} msgtype=${msg.msgtype} sender=${msg.senderStaffId || '?'}`);
    const maxAttempts = this.opts.maxHandlerAttempts ?? 3;
    const retryDelay = this.opts.handlerRetryDelayMs ?? 500;
    for (let a = 1; a <= maxAttempts; a++) {
      try {
        await this.handler?.(msg);
        ack('OK');
        return;
      } catch (err) {
        this.opts.logger.error('transport', `handler 第 ${a}/${maxAttempts} 次失败: ${String(err)}`);
        if (a < maxAttempts) await new Promise((r) => setTimeout(r, retryDelay * a));
      }
    }
    this.opts.logger.error('transport', `handler 全部 ${maxAttempts} 次失败，丢弃并 ack（避免服务端 60s 重推）`);
    ack('handler-failed');
  }
}
```

- [ ] **Step 5: 验证 PASS** — Run: `bun test tests/unit/adapter.test.ts` Expected: PASS（11 tests）。`bun run typecheck` 绿。

- [ ] **Step 6: Commit** — `bun run typecheck && bun test && git add src/transport/dingtalk-sdk-adapter.ts tests/helpers/fake-dw-client.ts tests/unit/adapter.test.ts && git commit -m "feat(transport): dingtalk-stream adapter with supervised backoff reconnect and explicit ack"`

### Task 8: Token manager（src/openapi/token.ts）

**Files:**
- Create: `src/openapi/token.ts`
- Test: `tests/unit/token.test.ts`

**Interfaces:**
- Produces: `TokenManager`：`getAccessToken(): Promise<string>`（内存→磁盘→远端，single-flight）；`invalidate()`；`fetchCallCount`。`TokenCache { key, accessToken, expiresAt }`——**key=clientId 指纹，凭据轮换时旧缓存失效**。`normalizeExpiry(expireIn)`（ms/s 歧义归一：`>200_000` 视为 ms）。端点 `POST https://api.dingtalk.com/v1.0/oauth2/accessToken`，body `{appKey, appSecret}`；到期前 `refreshMarginMs`（默认 5min）刷新；磁盘缓存 `.bot/token.json` 0600 原子写，写失败降级仅内存（warn）。
- Consumes: `Logger`（Task 4）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/token.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenManager, normalizeExpiry, TOKEN_URL } from '../../src/openapi/token.js';

function fakeFetch(tokens: Array<{ token: string; expireIn: number }>, log: Array<unknown>) {
  let call = 0;
  return (async (url: string, init?: RequestInit) => {
    log.push({ url, body: JSON.parse(String(init?.body)) });
    await new Promise((r) => setTimeout(r, 10)); // 制造并发窗口
    const t = tokens[Math.min(call, tokens.length - 1)];
    call += 1;
    return new Response(JSON.stringify({ accessToken: t.token, expireIn: t.expireIn }), { status: 200 });
  }) as unknown as typeof fetch;
}

test('normalizeExpiry: ms/s 归一', () => {
  expect(normalizeExpiry(7_200_000)).toBe(7_200_000);
  expect(normalizeExpiry(7_200)).toBe(7_200_000);
});

test('single-flight: 并发 5 个请求只打一次远端（AC4）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const calls: Array<{ url: string; body: { appKey: string } }> = [];
  const tm = new TokenManager({
    clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'),
    fetchFn: fakeFetch([{ token: 'T1', expireIn: 7_200 }], calls),
  });
  const got = await Promise.all([1, 2, 3, 4, 5].map(() => tm.getAccessToken()));
  expect(got).toEqual(['T1', 'T1', 'T1', 'T1', 'T1']);
  expect(tm.fetchCallCount).toBe(1);
  expect(calls[0].url).toBe(TOKEN_URL);
  expect(calls[0].body.appKey).toBe('ck');
});

test('内存缓存命中：余量内不重新 fetch；margin 之外刷新（AC4）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const calls: Array<unknown> = [];
  let clock = 1_000_000;
  const tm = new TokenManager({
    clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'),
    fetchFn: fakeFetch([{ token: 'T1', expireIn: 7_200 }, { token: 'T2', expireIn: 7_200 }], calls),
    now: () => clock,
  });
  expect(await tm.getAccessToken()).toBe('T1');
  clock += 1_000;
  expect(await tm.getAccessToken()).toBe('T1');
  expect(tm.fetchCallCount).toBe(1);
  clock += 7_200_000;
  expect(await tm.getAccessToken()).toBe('T2');
  expect(tm.fetchCallCount).toBe(2);
});

test('磁盘缓存：新实例命中旧缓存不 fetch；损坏 JSON 降级远端', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const cacheFile = join(dir, 'token.json');
  const calls: Array<unknown> = [];
  const t1 = new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile, fetchFn: fakeFetch([{ token: 'T1', expireIn: 7_200 }], calls) });
  await t1.getAccessToken();
  const t2 = new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile, fetchFn: fakeFetch([{ token: 'T2', expireIn: 7_200 }], calls) });
  expect(await t2.getAccessToken()).toBe('T1'); // 磁盘命中
  writeFileSync(cacheFile, '{bad');
  const t3 = new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile, fetchFn: fakeFetch([{ token: 'T3', expireIn: 7_200 }], calls) });
  expect(await t3.getAccessToken()).toBe('T3');
});

test('凭据轮换：换 clientId 后不复用旧 token（磁盘 key 不匹配即失效）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const cacheFile = join(dir, 'token.json');
  const calls: Array<unknown> = [];
  const t1 = new TokenManager({ clientId: 'ck-A', clientSecret: 'cs', cacheFile, fetchFn: fakeFetch([{ token: 'TA', expireIn: 7_200 }], calls) });
  await t1.getAccessToken();
  const t2 = new TokenManager({ clientId: 'ck-B', clientSecret: 'cs', cacheFile, fetchFn: fakeFetch([{ token: 'TB', expireIn: 7_200 }], calls) });
  expect(await t2.getAccessToken()).toBe('TB'); // 不复用 A 的 token
  expect(t2.fetchCallCount).toBe(1);
});

test('invalidate：内存+磁盘双清，下次必重取（旧 token 不从磁盘复活）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const cacheFile = join(dir, 'token.json');
  const calls: Array<unknown> = [];
  const tm = new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile, fetchFn: fakeFetch([{ token: 'T1', expireIn: 7_200 }, { token: 'T2', expireIn: 7_200 }], calls) });
  await tm.getAccessToken();
  tm.invalidate();
  expect(await tm.getAccessToken()).toBe('T2'); // 不是磁盘里的 T1
  expect(tm.fetchCallCount).toBe(2);
});

test('非 2xx：带响应体的响亮错误', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-tok-'));
  const tm = new TokenManager({
    clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'),
    fetchFn: (async () => new Response('{"code":"InvalidAuthentication","message":"bad"}', { status: 401 })) as unknown as typeof fetch,
  });
  await expect(tm.getAccessToken()).rejects.toThrow('InvalidAuthentication');
});
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/token.test.ts` Expected: FAIL — `Cannot find module`。

- [ ] **Step 3: 实现** `src/openapi/token.ts`

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger.js';

export const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface TokenCache { key: string; accessToken: string; expiresAt: number } // key = clientId；expiresAt = epoch ms

export interface TokenManagerOptions {
  clientId: string;
  clientSecret: string;
  cacheFile: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  refreshMarginMs?: number;
  logger?: Logger;
}

export function normalizeExpiry(expireIn: number): number {
  // 文档歧义：v1.0 端点示意为毫秒（7200000），旧语义为秒（7200）——smoke 实测后固化
  return expireIn > 200_000 ? expireIn : expireIn * 1_000;
}

export class TokenManager {
  private cache: TokenCache | null = null;
  private inflight: Promise<string> | null = null;
  private fetchCount = 0;
  private readonly cacheKey: string;

  constructor(private readonly opts: TokenManagerOptions) {
    this.cacheKey = opts.clientId; // 凭据指纹：换 app 不复用旧 token
  }

  get fetchCallCount(): number { return this.fetchCount; }

  async getAccessToken(): Promise<string> {
    const now = this.opts.now ?? Date.now;
    const margin = this.opts.refreshMarginMs ?? REFRESH_MARGIN_MS;
    if (this.cache && this.cache.key === this.cacheKey && this.cache.expiresAt - now() > margin) return this.cache.accessToken;
    this.inflight ??= this.resolveToken().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  invalidate(): void {
    this.cache = null;
    // 磁盘也必须清：否则下次 resolveToken 会把已失效 token 从磁盘"复活"
    try {
      rmSync(this.opts.cacheFile);
    } catch (err) {
      this.opts.logger?.warn('token', `invalidate 清理磁盘缓存失败: ${String(err)}`);
    }
  }

  private async resolveToken(): Promise<string> {
    const now = this.opts.now ?? Date.now;
    const margin = this.opts.refreshMarginMs ?? REFRESH_MARGIN_MS;
    const cached = this.readDisk();
    if (cached && cached.key === this.cacheKey && cached.expiresAt - now() > margin) {
      this.cache = cached;
      this.opts.logger?.debug('token', '命中磁盘缓存');
      return cached.accessToken;
    }
    const doFetch = this.opts.fetchFn ?? fetch;
    let resp: Response;
    try {
      resp = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appKey: this.opts.clientId, appSecret: this.opts.clientSecret }),
      });
    } catch (err) {
      throw new Error(`获取 access token 网络失败: ${String(err)}`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`获取 access token 失败: HTTP ${resp.status} ${body}`);
    }
    const data = (await resp.json().catch(() => null)) as { accessToken?: string; expireIn?: number } | null;
    if (!data || !data.accessToken || typeof data.expireIn !== 'number') {
      throw new Error(`获取 access token 失败: 响应缺字段 ${JSON.stringify(data)}`);
    }
    this.fetchCount += 1;
    const ttlMs = normalizeExpiry(data.expireIn);
    this.cache = { key: this.cacheKey, accessToken: data.accessToken, expiresAt: now() + ttlMs };
    this.writeDisk(this.cache);
    // TTL/expiry 落日志：live smoke 的 expireIn 单位验证位直接引用本行（不含凭据）
    this.opts.logger?.info('token', `token 已刷新 expireIn=${data.expireIn} → TTL=${ttlMs}ms expiresAt=${this.cache.expiresAt}`);
    return data.accessToken;
  }

  private readDisk(): TokenCache | null {
    try {
      if (!existsSync(this.opts.cacheFile)) return null;
      const c = JSON.parse(readFileSync(this.opts.cacheFile, 'utf8')) as TokenCache;
      return typeof c.accessToken === 'string' && typeof c.expiresAt === 'number' && typeof c.key === 'string' ? c : null;
    } catch {
      return null;
    }
  }

  private writeDisk(cache: TokenCache): void {
    try {
      mkdirSync(dirname(this.opts.cacheFile), { recursive: true });
      const tmp = `${this.opts.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
      renameSync(tmp, this.opts.cacheFile);
      chmodSync(this.opts.cacheFile, 0o600); // rename 到已存在路径不继承权限位——显式收紧
    } catch (err) {
      this.opts.logger?.warn('token', `token 磁盘缓存写入失败（降级仅内存）: ${String(err)}`);
    }
  }
}
```

- [ ] **Step 4: 验证 PASS** — Run: `bun test tests/unit/token.test.ts` Expected: PASS（6 tests）。

- [ ] **Step 5: Commit** — `bun run typecheck && bun test && git add src/openapi/token.ts tests/unit/token.test.ts && git commit -m "feat(openapi): single-flight token manager with credential-scoped disk cache"`

### Task 9: Robot 回复 client（src/openapi/robot.ts）

**Files:**
- Create: `src/openapi/robot.ts`
- Test: `tests/unit/robot-replyer.test.ts`

**Interfaces:**
- Consumes: `TokenManager`（Task 8）、`Logger`（Task 4）。
- Produces: `RobotReplyer.sendOtoMarkdown(robotCode, userIds, title, text)` → `POST /v1.0/robot/oToMessages/batchSend`；`sendGroupMarkdown(robotCode, openConversationId, title, text)` → `POST /v1.0/robot/groupMessages/send`；msgKey `sampleMarkdown`，msgParam=`JSON.stringify({title,text})`，头 `x-acs-dingtalk-access-token`；非 2xx / 网络错误 → error 日志 + 抛错（不吞）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/robot-replyer.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RobotReplyer } from '../../src/openapi/robot.js';
import { TokenManager } from '../../src/openapi/token.js';

function tokenFetch() {
  return (async () => new Response(JSON.stringify({ accessToken: 'TKN', expireIn: 7_200 }), { status: 200 })) as unknown as typeof fetch;
}

test('sendOtoMarkdown: 端点/头/载荷形状', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-rep-'));
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const replyer = new RobotReplyer({
    tokenManager: new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'), fetchFn: tokenFetch() }),
    fetchFn,
  });
  await replyer.sendOtoMarkdown('RC1', ['staff1'], '标题', '正文');
  expect(calls[0].url).toBe('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend');
  expect(calls[0].headers['x-acs-dingtalk-access-token']).toBe('TKN');
  expect(calls[0].body).toEqual({ robotCode: 'RC1', userIds: ['staff1'], msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: '标题', text: '正文' }) });
});

test('sendGroupMarkdown: 端点/载荷形状', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-rep-'));
  const calls: Array<{ url: string; body: any }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const replyer = new RobotReplyer({
    tokenManager: new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'), fetchFn: tokenFetch() }),
    fetchFn,
  });
  await replyer.sendGroupMarkdown('RC2', 'cid-9', 't', 'x');
  expect(calls[0].url).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send');
  expect(calls[0].body).toEqual({ robotCode: 'RC2', openConversationId: 'cid-9', msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 't', text: 'x' }) });
});

test('非 2xx：抛带响应体的错误（不吞）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-rep-'));
  const replyer = new RobotReplyer({
    tokenManager: new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile: join(dir, 'token.json'), fetchFn: tokenFetch() }),
    fetchFn: (async () => new Response('{"code":"forbidden"}', { status: 403 })) as unknown as typeof fetch,
  });
  await expect(replyer.sendOtoMarkdown('RC', ['u'], 't', 'x')).rejects.toThrow('403');
});
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/robot-replyer.test.ts` Expected: FAIL — `Cannot find module`。

- [ ] **Step 3: 实现** `src/openapi/robot.ts`

```ts
import type { Logger } from '../logger.js';
import type { TokenManager } from './token.js';

export const API_BASE = 'https://api.dingtalk.com';

export interface RobotReplyerOptions {
  tokenManager: TokenManager;
  logger?: Logger;
  fetchFn?: typeof fetch;
  apiBase?: string;
}

export class RobotReplyer {
  constructor(private readonly opts: RobotReplyerOptions) {}

  private async post(path: string, body: unknown): Promise<void> {
    const doFetch = this.opts.fetchFn ?? fetch;
    const base = this.opts.apiBase ?? API_BASE;
    const token = await this.opts.tokenManager.getAccessToken();
    let resp: Response;
    try {
      resp = await doFetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const e = new Error(`OpenAPI ${path} 网络失败: ${String(err)}`);
      this.opts.logger?.error('reply', e.message);
      throw e;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const e = new Error(`OpenAPI ${path} 失败: HTTP ${resp.status} ${text}`);
      this.opts.logger?.error('reply', e.message);
      throw e;
    }
  }

  async sendOtoMarkdown(robotCode: string, userIds: string[], title: string, text: string): Promise<void> {
    await this.post('/v1.0/robot/oToMessages/batchSend', {
      robotCode, userIds, msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title, text }),
    });
  }

  async sendGroupMarkdown(robotCode: string, openConversationId: string, title: string, text: string): Promise<void> {
    await this.post('/v1.0/robot/groupMessages/send', {
      robotCode, openConversationId, msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title, text }),
    });
  }
}
```

- [ ] **Step 4: 验证 PASS** — Run: `bun test tests/unit/robot-replyer.test.ts` Expected: PASS（3 tests）。

- [ ] **Step 5: Commit** — `bun run typecheck && bun test && git add src/openapi/robot.ts tests/unit/robot-replyer.test.ts && git commit -m "feat(openapi): markdown reply client for oToMessages/groupMessages endpoints"`

### Task 10: Echo handler + Gateway 装配 + 全链路集成测试

**Files:**
- Create: `src/handlers/echo.ts`, `src/gateway.ts`
- Test: `tests/unit/echo.test.ts`, `tests/unit/gateway.test.ts`, `tests/integration/round-trip.test.ts`

**Interfaces:**
- Consumes: `RobotReplyer`（Task 9）、`InboundRobotMessage`/`MessageHandler`/`DingtalkTransport`（Task 6）、`DingtalkSdkTransport`（Task 7）、`writeStateJson`（Task 5）、`Logger`。
- Produces: `createEchoHandler({replyer, logger}): MessageHandler`（非 text/空文本 → **warn** 日志丢弃；p2p→`sendOtoMarkdown(robotCode,[senderStaffId])`；group→`sendGroupMarkdown(robotCode, conversationId)`——openConversationId==conversationId 为 live-smoke 待验证假设；unknown→warn 丢弃）；`Gateway { start/stop }`（onStateChange→state.json 快照；handler 可插拔；**启动失败在 stop 清理后向外抛**）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/echo.test.ts
import { test, expect } from 'bun:test';
import { createEchoHandler } from '../../src/handlers/echo.js';
import type { Logger } from '../../src/logger.js';
import type { InboundRobotMessage } from '../../src/transport/types.js';

function msg(over: Partial<InboundRobotMessage>): InboundRobotMessage {
  return { msgId: 'm', conversationId: 'cid', conversationKind: 'p2p', senderStaffId: 's1', senderNick: 'n', robotCode: 'rc', msgtype: 'text', textContent: 'hi', sessionWebhook: null, raw: {}, ...over };
}

function fakeReplyer() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    replyer: {
      sendOtoMarkdown: async (...args: unknown[]) => { calls.push({ method: 'oto', args }); },
      sendGroupMarkdown: async (...args: unknown[]) => { calls.push({ method: 'group', args }); },
    } as never,
  };
}

function recordingLogger() {
  const lines: Array<{ level: string; msg: string }> = [];
  const rec: Logger = {
    debug: () => {}, info: () => {},
    warn: (m, msg) => { lines.push({ level: 'warn', msg }); },
    error: (m, msg) => { lines.push({ level: 'error', msg }); },
  };
  return { lines, logger: rec };
}

test('echo: p2p 文本 → oToMessages batchSend（markdown，空白原样）', async () => {
  const { calls, replyer } = fakeReplyer();
  await createEchoHandler({ replyer, logger: recordingLogger().logger })(msg({ textContent: ' 你好 \n' }));
  expect(calls).toEqual([{ method: 'oto', args: ['rc', ['s1'], 'dingtalkbot', ' 你好 \n'] }]);
});

test('echo: 群文本 → groupMessages/send，用 conversationId 当 openConversationId', async () => {
  const { calls, replyer } = fakeReplyer();
  await createEchoHandler({ replyer, logger: recordingLogger().logger })(msg({ conversationKind: 'group', conversationId: 'cidG' }));
  expect(calls).toEqual([{ method: 'group', args: ['rc', 'cidG', 'dingtalkbot', 'hi'] }]);
});

test('echo: 非文本/空文本/未知会话类型 → 不回复且留 warn（#62 不静默）', async () => {
  const { calls, replyer } = fakeReplyer();
  const { lines, logger } = recordingLogger();
  const h = createEchoHandler({ replyer, logger });
  await h(msg({ msgtype: 'picture', textContent: null }));
  await h(msg({ textContent: '   ' }));
  await h(msg({ conversationKind: 'unknown' }));
  expect(calls).toHaveLength(0);
  expect(lines.filter((l) => l.level === 'warn')).toHaveLength(3);
});

test('echo: 回复抛错向上传播（adapter 层重试/ack 兜底）', async () => {
  const replyer = { sendOtoMarkdown: async () => { throw new Error('send fail'); }, sendGroupMarkdown: async () => {} } as never;
  await expect(createEchoHandler({ replyer, logger: recordingLogger().logger })(msg({}))).rejects.toThrow('send fail');
});
```

```ts
// tests/unit/gateway.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../../src/gateway.js';
import { consoleLogger } from '../../src/logger.js';
import type { DingtalkTransport, MessageHandler, TransportState } from '../../src/transport/types.js';

function fakeTransport(events: string[]) {
  let stateListener: ((s: TransportState, d: string) => void) | null = null;
  return {
    onStateChange: (l: (s: TransportState, d: string) => void) => { stateListener = l; },
    onMessage: (h: MessageHandler) => { events.push(`handler-wired:${typeof h === 'function'}`); },
    start: async () => { events.push('start'); stateListener?.('connected', 'fake'); },
    stop: async () => { events.push('stop'); },
  } as unknown as DingtalkTransport;
}

test('gateway: start 装配 handler + 状态快照落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-gw-'));
  const stateFile = join(dir, 'state.json');
  const events: string[] = [];
  const transport = fakeTransport(events);
  const gw = new Gateway({ transport, logger: consoleLogger, stateFile, pid: 42, startedAt: 'T0', handler: async () => {} });
  await gw.start();
  expect(events).toContain('start');
  expect(events.some((e) => e.startsWith('handler-wired:true')));
  const snap = JSON.parse(readFileSync(stateFile, 'utf8'));
  expect(snap).toMatchObject({ pid: 42, transport: 'connected' });
  await gw.stop();
  expect(events).toContain('stop');
});

test('gateway: 启动失败 → 先 stop 清理再向外抛（不残留活动资源）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtb-gw2-'));
  const events: string[] = [];
  const failing = { ...fakeTransport(events), start: async () => { events.push('start-fail'); throw new Error('connect refused'); } } as unknown as DingtalkTransport;
  const gw = new Gateway({ transport: failing, logger: consoleLogger, stateFile: join(dir, 'state.json'), pid: 1, startedAt: 'T' });
  await expect(gw.start()).rejects.toThrow('connect refused');
  expect(events).toContain('stop'); // 失败路径也走了清理
});
```

```ts
// tests/integration/round-trip.test.ts —— AC2 的 CI 面：真实 adapter+gateway+echo 装配，仅网络层为 fake
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapWorkspace } from '../../src/config.js';
import { DingtalkSdkTransport } from '../../src/transport/dingtalk-sdk-adapter.js';
import { FakeDwClient } from '../helpers/fake-dw-client.js';
import { TokenManager } from '../../src/openapi/token.js';
import { RobotReplyer } from '../../src/openapi/robot.js';
import { createEchoHandler } from '../../src/handlers/echo.js';
import { Gateway } from '../../src/gateway.js';
import { consoleLogger } from '../../src/logger.js';

function wire(sendStatus: number[] = []) {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-rt-'));
  const paths = bootstrapWorkspace(ws);
  const client = new FakeDwClient();
  const http: Array<{ url: string; body: any }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    http.push({ url, body });
    if (String(url).includes('accessToken')) return new Response(JSON.stringify({ accessToken: 'TKN', expireIn: 7_200 }), { status: 200 });
    const idx = http.filter((c) => !String(c.url).includes('accessToken')).length - 1;
    const status = sendStatus[idx] ?? 200;
    return new Response(status === 200 ? '{}' : '{"code":"err"}', { status });
  }) as unknown as typeof fetch;
  const tokenManager = new TokenManager({ clientId: 'ck', clientSecret: 'cs', cacheFile: paths.tokenCacheFile, fetchFn });
  const replyer = new RobotReplyer({ tokenManager, fetchFn });
  const transport = new DingtalkSdkTransport({
    clientId: 'ck', clientSecret: 'cs', logger: consoleLogger,
    handlerRetryDelayMs: 1, backoffBaseMs: 5, clientFactory: () => client,
  });
  const gateway = new Gateway({
    transport, logger: consoleLogger, stateFile: paths.stateFile,
    pid: process.pid, startedAt: 'T', handler: createEchoHandler({ replyer, logger: consoleLogger }),
  });
  return { client, http, gateway };
}

test('round-trip: p2p 文本 → OpenAPI 体正确 + ack SUCCESS（AC2 CI 面）', async () => {
  const { client, http, gateway } = wire();
  await gateway.start();
  client.emitRobotMessage({ msgId: 'm1', conversationId: 'c1', conversationType: '1', senderStaffId: 'st1', senderNick: 'n', robotCode: 'rc1', msgtype: 'text', text: { content: ' 你好 ' } });
  await new Promise((r) => setTimeout(r, 80));
  const send = http.find((c) => String(c.url).endsWith('/v1.0/robot/oToMessages/batchSend'));
  expect(send?.body).toEqual({ robotCode: 'rc1', userIds: ['st1'], msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 'dingtalkbot', text: ' 你好 ' }) });
  expect(client.acks).toEqual([{ messageId: 'msg-1', result: { status: 'SUCCESS', message: 'OK' } }]);
  await gateway.stop();
});

test('round-trip: 群 @ 文本走 groupMessages/send', async () => {
  const { client, http, gateway } = wire();
  await gateway.start();
  client.emitRobotMessage({ msgId: 'm2', conversationId: 'cidG', conversationType: '2', senderStaffId: 'st2', senderNick: 'n', robotCode: 'rc1', msgtype: 'text', text: { content: '@bot hello' } });
  await new Promise((r) => setTimeout(r, 80));
  const send = http.find((c) => String(c.url).endsWith('/v1.0/robot/groupMessages/send'));
  expect(send?.body).toEqual({ robotCode: 'rc1', openConversationId: 'cidG', msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 'dingtalkbot', text: '@bot hello' }) });
  expect(client.acks).toHaveLength(1);
  await gateway.stop();
});

test('round-trip: 回复持续 500 → 3 次重试后 ack handler-failed（不静默）', async () => {
  const { client, gateway } = wire([500, 500, 500]);
  await gateway.start();
  client.emitRobotMessage({ msgId: 'm3', conversationId: 'c1', conversationType: '1', senderStaffId: 'st1', senderNick: 'n', robotCode: 'rc1', msgtype: 'text', text: { content: 'x' } });
  await new Promise((r) => setTimeout(r, 100));
  expect(client.acks[0]).toMatchObject({ messageId: 'msg-1', result: { message: 'handler-failed' } });
  await gateway.stop();
});
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/echo.test.ts tests/unit/gateway.test.ts tests/integration/round-trip.test.ts` Expected: FAIL — `Cannot find module`。

- [ ] **Step 3: 实现**

```ts
// src/handlers/echo.ts
import type { InboundRobotMessage, MessageHandler } from '../transport/types.js';
import type { RobotReplyer } from '../openapi/robot.js';
import type { Logger } from '../logger.js';

export const ECHO_TITLE = 'dingtalkbot';

export function createEchoHandler(deps: { replyer: RobotReplyer; logger: Logger }): MessageHandler {
  return async (msg: InboundRobotMessage) => {
    if (msg.msgtype !== 'text' || msg.textContent === null || msg.textContent.trim() === '') {
      deps.logger.warn('echo', `丢弃非文本/空消息 msgId=${msg.msgId} msgtype=${msg.msgtype} kind=${msg.conversationKind}`);
      return;
    }
    if (msg.conversationKind === 'p2p') {
      await deps.replyer.sendOtoMarkdown(msg.robotCode, [msg.senderStaffId], ECHO_TITLE, msg.textContent);
      deps.logger.info('echo', `p2p 回显完成 msgId=${msg.msgId} -> staffId=${msg.senderStaffId}`);
    } else if (msg.conversationKind === 'group') {
      // 假设（live-smoke 验证）：入站 conversationId 即群发 openConversationId
      await deps.replyer.sendGroupMarkdown(msg.robotCode, msg.conversationId, ECHO_TITLE, msg.textContent);
      deps.logger.info('echo', `群回显完成 msgId=${msg.msgId} -> conversationId=${msg.conversationId}`);
    } else {
      deps.logger.warn('echo', `未知 conversationType，丢弃 msgId=${msg.msgId}`);
    }
  };
}
```

```ts
// src/gateway.ts
import type { DingtalkTransport, MessageHandler, TransportState } from './transport/types.js';
import type { Logger } from './logger.js';
import { writeStateJson, type ConnectionStateSnapshot } from './state.js';

export interface GatewayDeps {
  transport: DingtalkTransport;
  logger: Logger;
  stateFile: string;
  pid: number;
  startedAt: string;
  handler?: MessageHandler;
}

export class Gateway {
  constructor(private readonly deps: GatewayDeps) {}

  async start(): Promise<void> {
    if (this.deps.handler) this.deps.transport.onMessage(this.deps.handler);
    this.deps.transport.onStateChange((state, detail) => this.snapshot(state, detail));
    this.snapshot('starting', 'gateway 启动');
    try {
      await this.deps.transport.start(); // 响亮失败（AC1）
    } catch (err) {
      await this.stop(); // 失败也走完整清理（不留活动 socket/定时器）
      throw err;
    }
  }

  private snapshot(state: TransportState, detail: string): void {
    const snap: ConnectionStateSnapshot = {
      pid: this.deps.pid, startedAt: this.deps.startedAt, transport: state, detail,
      updatedAt: new Date().toISOString(),
    };
    try {
      writeStateJson(this.deps.stateFile, snap);
    } catch (err) {
      this.deps.logger.error('gateway', `state.json 写入失败（继续运行）: ${String(err)}`);
    }
    this.deps.logger.info('gateway', `transport=${state} ${detail}`);
  }

  async stop(): Promise<void> {
    try {
      await this.deps.transport.stop();
    } catch (err) {
      this.deps.logger.error('gateway', `transport 停止出错（继续）: ${String(err)}`);
    }
    this.snapshot('stopped', 'gateway 停止');
  }
}
```

- [ ] **Step 4: 验证 PASS** — Run: `bun test tests/unit/echo.test.ts tests/unit/gateway.test.ts tests/integration/round-trip.test.ts` Expected: PASS（9 tests）。

- [ ] **Step 5: Commit** — `bun run typecheck && bun test && git add src/handlers/echo.ts src/gateway.ts tests/ && git commit -m "feat(gateway): thin gateway assembly with pluggable markdown echo handler"`

**--- 检查点 B：端到端核心环完成（adapter/token/replyer/echo/gateway + 全链路集成测试全绿）---**

### Task 11: CLI 入口 + 全部命令（run/start/stop/status/setup，无占位实现）

**Files:**
- Create: `src/cli-args.ts`（纯解析，可被测试安全 import）, `src/cli.ts`（入口，import 即执行 main）, `src/commands/run.ts`, `src/commands/start.ts`, `src/commands/stop.ts`, `src/commands/status.ts`, `src/commands/setup.ts`
- Test: `tests/unit/cli-args.test.ts`, `tests/unit/commands.test.ts`, `tests/unit/setup.test.ts`, `tests/integration/run.test.ts`

**Interfaces:**
- Consumes: 全部前置模块。
- Produces: `parseArgs(argv): CliArgs | null`（**位于 src/cli-args.ts**；缺省 `-r` 合法 = `process.cwd()`；仅旗标缺值/未知旗标返回 null）；`runCommand(workspace, overrides?)`（依赖全部构造完成后、`gateway.start()` 前才写 pidfile；启动失败 → gateway.stop + 清 pidfile + 抛错；信号处理器收 `exit` 注入，默认 `process.exit`）；`startCommand(workspace)`（缺 .env→`MissingEnvError`；存活且 startedAt 匹配→`AlreadyRunningError`；陈旧 pidfile 清理）；`stopCommand(workspace)`（信号前先 pidStartMatches 校验，pid 复用不杀；SIGTERM→15s 宽限→SIGKILL→短等待→清 pidfile；无 pidfile→`NotRunningError`）；`statusCommand`（纯打印，stdout 断言覆盖）；`setupCommand(args)`（旗标空串→抛错不进 readline；缺省旗标→readline 只问缺失项；写 .env 后 smoke=token+Stream connect，失败抛 `SetupSmokeError`）。**命令层错误路径不 process.exit**——退出码集中在 `cli.ts main`（run 的信号收尾 exit 是守护语义，经注入可测）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/cli-args.test.ts —— 注意 import 的是纯解析模块 src/cli-args.ts（不是入口 src/cli.ts：
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
```

```ts
// tests/unit/commands.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapWorkspace } from '../../src/config.js';
import { stopCommand, NotRunningError } from '../../src/commands/stop.js';
import { startCommand, MissingEnvError, AlreadyRunningError } from '../../src/commands/start.js';
import { statusCommand } from '../../src/commands/status.js';
import { writePidFile, isProcessAlive } from '../../src/pid.js';

function captureConsole(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(String(args[0])); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test('stopCommand: 无 pidfile → NotRunningError', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-cmd-'));
  await expect(stopCommand(ws)).rejects.toBeInstanceOf(NotRunningError);
});

test('stopCommand: 死 pid 或 pid 复用（startedAt 不匹配）→ 清 pidfile 不发信号', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-cmd2-'));
  const paths = bootstrapWorkspace(ws);
  writePidFile(paths.pidFile, 999_999_999); // 死 pid：readProcessStartedAt → null → 不匹配
  await stopCommand(ws); // 不抛、不杀
  expect(existsSync(paths.pidFile)).toBe(false);
});

test('stopCommand: 真实子进程 SIGTERM 退出 + pidfile 清理（daemon 生命周期）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-cmd6-'));
  const paths = bootstrapWorkspace(ws);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150)); // 等 /proc 就绪
  writePidFile(paths.pidFile, child.pid!);
  await stopCommand(ws);
  expect(isProcessAlive(child.pid!)).toBe(false);
  expect(existsSync(paths.pidFile)).toBe(false);
});

test('startCommand: 缺 .env → MissingEnvError', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-cmd3-'));
  bootstrapWorkspace(ws);
  expect(() => startCommand(ws)).toThrow(MissingEnvError);
});

test('startCommand: pidfile 指向存活且匹配的进程 → AlreadyRunningError（不重复拉起）', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-cmd4-'));
  const paths = bootstrapWorkspace(ws);
  writeFileSync(paths.envFile, 'DINGTALK_CLIENT_ID=a\nDINGTALK_CLIENT_SECRET=b\n');
  writePidFile(paths.pidFile, process.pid); // 当前测试进程：存活 + startedAt 匹配
  expect(() => startCommand(ws)).toThrow(AlreadyRunningError);
});

test('statusCommand: 未运行 / 运行中+connected / 陈旧 三态输出正确', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-cmd5-'));
  const paths = bootstrapWorkspace(ws);
  expect(captureConsole(() => statusCommand(ws))).toContain('状态: 未运行（无 pidfile）');
  writePidFile(paths.pidFile, process.pid);
  writeFileSync(paths.stateFile, JSON.stringify({ pid: process.pid, startedAt: 't', transport: 'connected', detail: 'ok', updatedAt: 'u' }));
  const running = captureConsole(() => statusCommand(ws));
  expect(running.join('\n')).toContain('（运行中）');
  expect(running.join('\n')).toContain('连接状态: connected');
  writePidFile(paths.pidFile, 999_999_999); // 死 pid → 陈旧
  const stale = captureConsole(() => statusCommand(ws));
  expect(stale.join('\n')).toContain('（已退出/陈旧 pidfile）');
});
```

```ts
// tests/unit/setup.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupCommand } from '../../src/commands/setup.js';
import { FakeDwClient } from '../helpers/fake-dw-client.js';

function okFetch() {
  return (async () => new Response(JSON.stringify({ accessToken: 'TKN', expireIn: 7_200 }), { status: 200 })) as unknown as typeof fetch;
}

test('setup: 非交互凭据 → 写 .env 内容 + smoke PASS（token + stream 连接）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-su-'));
  const client = new FakeDwClient();
  await setupCommand({ root: ws, clientId: 'ck', clientSecret: 'cs', transportClient: client, fetchFn: okFetch(), startTimeoutMs: 500 });
  const text = readFileSync(join(ws, '.bot', '.env'), 'utf8');
  expect(text).toContain('DINGTALK_CLIENT_ID=ck');
  expect(text).toContain('DINGTALK_CLIENT_SECRET=cs');
  expect(client.connectCalls).toBeGreaterThanOrEqual(1);
});

test('setup: 空字符串凭据 → 抛错且不进 readline、不写 .env', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-su2-'));
  await expect(setupCommand({ root: ws, clientId: '', clientSecret: '' })).rejects.toThrow(/凭据/);
  expect(existsSync(join(ws, '.bot', '.env'))).toBe(false);
});

test('setup: smoke 失败响亮（SetupSmokeError）—— token 401 场景', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-su3-'));
  const bad = (async () => new Response('{"code":"InvalidAuthentication"}', { status: 401 })) as unknown as typeof fetch;
  await expect(setupCommand({ root: ws, clientId: 'bad', clientSecret: 'bad', fetchFn: bad, startTimeoutMs: 300 })).rejects.toThrow(/access token/);
});
```

```ts
// tests/integration/run.test.ts
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
  let optsSeen: { clientId: string } | null = null;
  await runCommand(ws, {
    transportFactory: (opts) => {
      optsSeen = opts;
      return new DingtalkSdkTransport({ ...opts, backoffBaseMs: 5, clientFactory: () => client });
    },
  });
  expect(optsSeen?.clientId).toBe('ck');
  expect(client.connectCalls).toBeGreaterThanOrEqual(1);
  expect(existsSync(paths.stateFile)).toBe(true);
  expect(JSON.parse(readFileSync(paths.stateFile, 'utf8')).transport).toBe('connected');
  expect(readPidFile(paths.pidFile)?.pid).toBe(process.pid);
});

test('runCommand: 缺 .env → 抛 EnvError（不写 pidfile）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dtb-run2-'));
  await expect(runCommand(ws)).rejects.toThrow(/setup/);
});
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/cli-args.test.ts tests/unit/commands.test.ts tests/unit/setup.test.ts tests/integration/run.test.ts` Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// src/commands/run.ts
import { bootstrapWorkspace } from '../config.js';
import { loadBotEnv } from '../env.js';
import { createFileLogger } from '../logger.js';
import { writePidFile, clearPidFile } from '../pid.js';
import { TokenManager } from '../openapi/token.js';
import { RobotReplyer } from '../openapi/robot.js';
import { createEchoHandler } from '../handlers/echo.js';
import { Gateway } from '../gateway.js';
import { DingtalkSdkTransport } from '../transport/dingtalk-sdk-adapter.js';
import type { DingtalkTransport, TransportOptions } from '../transport/types.js';

export interface RunOverrides { transportFactory?: (opts: TransportOptions) => DingtalkTransport }

export async function runCommand(
  workspace: string,
  overrides: RunOverrides = {},
  exit: (code: number) => never = (c) => process.exit(c),
): Promise<void> {
  const paths = bootstrapWorkspace(workspace);
  const { logger, logFilePath, linkLatest } = createFileLogger(paths.logsDir);
  linkLatest();
  logger.info('run', `工作区 ${workspace}；日志 ${logFilePath}`);
  const env = loadBotEnv(paths.botDir); // 缺失/缺键 → EnvError 抛给 cli（exit 1，AC1）；此时尚未写 pidfile
  const pid = process.pid;
  const startedAt = new Date().toISOString();
  const tokenManager = new TokenManager({ clientId: env.clientId, clientSecret: env.clientSecret, cacheFile: paths.tokenCacheFile, logger });
  const replyer = new RobotReplyer({ tokenManager, logger });
  const handler = createEchoHandler({ replyer, logger });
  const baseOpts: TransportOptions = { clientId: env.clientId, clientSecret: env.clientSecret, logger };
  const transport = overrides.transportFactory
    ? overrides.transportFactory(baseOpts)
    : new DingtalkSdkTransport(baseOpts);
  const gateway = new Gateway({ transport, logger, stateFile: paths.stateFile, pid, startedAt, handler });
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('run', `收到 ${signal}，关停中`);
    await gateway.stop();
    clearPidFile(paths.pidFile);
    logger.info('run', '已退出');
    exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  // 全部依赖构造成功后才登记 pidfile：构造期抛错不残留 pidfile
  writePidFile(paths.pidFile, pid);
  try {
    await gateway.start(); // Gateway 内部失败已 stop 清理（Task 10）
  } catch (err) {
    logger.error('run', `启动失败: ${String(err)}`);
    clearPidFile(paths.pidFile);
    throw err; // cli 层转非零退出（AC1）
  }
}
```

```ts
// src/commands/start.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { bootstrapWorkspace } from '../config.js';
import { readPidFile, writePidFile, clearPidFile, isProcessAlive, pidStartMatches } from '../pid.js';

export class MissingEnvError extends Error {}
export class AlreadyRunningError extends Error {}

export function resolveBotBin(): string {
  const here = fileURLToPath(new URL('.', import.meta.url)); // src/commands/ 或 dist/（打包后平铺）
  const candidates = [join(here, '../../dist/cli.js'), join(here, 'cli.js'), join(here, '../cli.js')];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`找不到 cli.js（尝试过: ${candidates.join(', ')}）`);
}

export function startCommand(workspace: string): void {
  const paths = bootstrapWorkspace(workspace);
  if (!existsSync(paths.envFile)) throw new MissingEnvError(`缺少 ${paths.envFile} —— 先运行 dingtalkbot setup`);
  const existing = readPidFile(paths.pidFile);
  if (existing && isProcessAlive(existing.pid) && pidStartMatches(paths.pidFile, existing.pid)) {
    throw new AlreadyRunningError(`已在运行 (pid ${existing.pid})`);
  }
  if (existing) clearPidFile(paths.pidFile); // 死 pid / pid 复用：清理陈旧记录
  const binPath = resolveBotBin();
  const child = spawn(process.execPath, [binPath, 'run', '-r', workspace], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  if (child.pid === undefined) throw new Error('子进程启动失败（无 pid）');
  writePidFile(paths.pidFile, child.pid);
  console.log(`已启动 pid=${child.pid}；日志 ${join(paths.logsDir, 'latest.log')}`);
}
```

```ts
// src/commands/stop.ts
import { bootstrapWorkspace } from '../config.js';
import { readPidFile, clearPidFile, isProcessAlive, pidStartMatches } from '../pid.js';

export class NotRunningError extends Error {}
const STOP_GRACE_MS = 15_000;

export async function stopCommand(workspace: string): Promise<void> {
  const paths = bootstrapWorkspace(workspace);
  const rec = readPidFile(paths.pidFile);
  if (rec === null) throw new NotRunningError('没有 pidfile —— 未在运行');
  // pid 复用防护：存活但 startedAt 不匹配 → 视为陈旧记录，绝不向陌生进程发信号
  if (!isProcessAlive(rec.pid) || !pidStartMatches(paths.pidFile, rec.pid)) {
    clearPidFile(paths.pidFile);
    console.warn(`pid ${rec.pid} 已不存在或 pid 复用（startedAt 不匹配），仅清理 pidfile，不发送信号`);
    return;
  }
  process.kill(rec.pid, 'SIGTERM');
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && isProcessAlive(rec.pid)) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (isProcessAlive(rec.pid)) {
    console.warn(`宽限 ${STOP_GRACE_MS}ms 超时，SIGKILL pid=${rec.pid}`);
    process.kill(rec.pid, 'SIGKILL');
    for (let i = 0; i < 8 && isProcessAlive(rec.pid); i++) {
      await new Promise((r) => setTimeout(r, 250)); // SIGKILL 后短暂等待回收
    }
  }
  clearPidFile(paths.pidFile);
  console.log(`已停止 pid=${rec.pid}`);
}
```

```ts
// src/commands/status.ts
import { existsSync } from 'node:fs';
import { bootstrapWorkspace } from '../config.js';
import { readPidFile, isProcessAlive, pidStartMatches } from '../pid.js';
import { readStateJson } from '../state.js';

export function statusCommand(workspace: string): void {
  const paths = bootstrapWorkspace(workspace);
  const rec = readPidFile(paths.pidFile);
  if (rec === null) {
    console.log('状态: 未运行（无 pidfile）');
    return;
  }
  const alive = isProcessAlive(rec.pid) && pidStartMatches(paths.pidFile, rec.pid);
  console.log(`pid: ${rec.pid} ${alive ? '（运行中）' : '（已退出/陈旧 pidfile）'}`);
  const snap = readStateJson(paths.stateFile);
  if (snap === null) {
    console.log(`连接状态: 未知${existsSync(paths.stateFile) ? '（state.json 损坏）' : '（无 state.json，可能尚未完成首次连接）'}`);
    return;
  }
  console.log(`连接状态: ${snap.transport}`);
  console.log(`明细: ${snap.detail}`);
  console.log(`更新时间: ${snap.updatedAt}`);
}
```

```ts
// src/commands/setup.ts
import * as readline from 'node:readline/promises';
import { bootstrapWorkspace } from '../config.js';
import { saveBotEnv } from '../env.js';
import { TokenManager } from '../openapi/token.js';
import { DingtalkSdkTransport, type DwClientLike } from '../transport/dingtalk-sdk-adapter.js';
import { consoleLogger } from '../logger.js';

export class SetupSmokeError extends Error {}

export interface SetupArgs {
  root?: string;
  clientId?: string;
  clientSecret?: string;
  transportClient?: DwClientLike; // 测试注入
  fetchFn?: typeof fetch;         // 测试注入
  startTimeoutMs?: number;        // 测试注入
}

export async function setupCommand(args: SetupArgs): Promise<void> {
  const paths = bootstrapWorkspace(args.root ?? process.cwd());
  // 旗标语义：undefined=未提供（可交互询问）；空串=显式给空 → 立即响亮失败（不进 readline）
  let clientId = args.clientId === undefined ? undefined : args.clientId.trim();
  let clientSecret = args.clientSecret === undefined ? undefined : args.clientSecret.trim();
  if (clientId === '' || clientSecret === '') throw new SetupSmokeError('凭据为空 —— 放弃 setup');
  if (clientId === undefined || clientSecret === undefined) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (clientId === undefined) clientId = (await rl.question('DINGTALK_CLIENT_ID (clientId): ')).trim();
      if (clientSecret === undefined) clientSecret = (await rl.question('DINGTALK_CLIENT_SECRET (clientSecret): ')).trim();
    } finally {
      rl.close();
    }
  }
  if (!clientId || !clientSecret) throw new SetupSmokeError('凭据为空 —— 放弃 setup');
  saveBotEnv(paths.botDir, { clientId, clientSecret });
  console.log(`已写入 ${paths.envFile}（0600）`);
  // 冒烟：token 获取 + Stream 连接订阅（响亮成败，AC5）
  const fetchFn = args.fetchFn ?? fetch;
  try {
    const tm = new TokenManager({ clientId, clientSecret, cacheFile: paths.tokenCacheFile, logger: consoleLogger, fetchFn });
    const token = await tm.getAccessToken();
    consoleLogger.info('setup', `token 获取成功（${token.slice(0, 6)}…）`);
    const transport = new DingtalkSdkTransport({
      clientId, clientSecret, logger: consoleLogger,
      startTimeoutMs: args.startTimeoutMs ?? 20_000,
      clientFactory: args.transportClient ? () => args.transportClient! : undefined,
    });
    await transport.start();
    consoleLogger.info('setup', 'Stream 连接+订阅成功');
    await transport.stop();
    console.log('smoke: PASS');
  } catch (err) {
    console.error(`smoke: FAIL —— ${String(err instanceof Error ? err.message : err)}`);
    throw new SetupSmokeError(`凭据冒烟失败: ${String(err)}`);
  }
}
```

```ts
// src/cli-args.ts —— 纯解析模块（无副作用；测试 import 本文件）
export interface CliArgs { command: string; root?: string; clientId?: string; clientSecret?: string }

export function parseArgs(argv: string[]): CliArgs | null {
  const [command, ...rest] = argv;
  if (!command) return null;
  const out: CliArgs = { command };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-r' || a === '--root' || a === '--client-id' || a === '--client-secret') {
      const v = rest[++i];
      if (v === undefined || v === '') return null; // 旗标缺值
      if (a === '--client-id') out.clientId = v;
      else if (a === '--client-secret') out.clientSecret = v;
      else out.root = v;
    } else if (a === '-v' || a === '--version') {
      out.command = '__version';
    } else {
      return null; // 未知旗标
    }
  }
  return out; // root 未提供 = 合法（缺省 process.cwd()，由各命令决定）
}
```

```ts
// src/cli.ts —— 入口（import 即执行 main；bun build 的打包根）
import { readFileSync } from 'node:fs';
import { parseArgs } from './cli-args.js';
import { runCommand } from './commands/run.js';
import { startCommand, MissingEnvError, AlreadyRunningError } from './commands/start.js';
import { stopCommand, NotRunningError } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { setupCommand, SetupSmokeError } from './commands/setup.js';

const USAGE = `dingtalkbot — DingTalk Stream 网关
用法: dingtalkbot <setup|run|start|stop|status> [-r <workspace>] [--client-id <id> --client-secret <secret>]
  setup   交互/旗标录入凭据 + 冒烟（token + Stream 连接）
  run     前台运行
  start   后台守护启动
  stop    停止守护
  status  连接状态
  -v/--version`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.error(USAGE);
    process.exit(1);
  }
  const workspace = args.root ?? process.cwd();
  try {
    switch (args.command) {
      case '__version': {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        console.log(pkg.version);
        break;
      }
      case 'setup': await setupCommand({ root: workspace, clientId: args.clientId, clientSecret: args.clientSecret }); break;
      case 'run': await runCommand(workspace); break;
      case 'start': startCommand(workspace); break;
      case 'stop': await stopCommand(workspace); break;
      case 'status': statusCommand(workspace); break;
      default:
        console.error(USAGE);
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof MissingEnvError || err instanceof AlreadyRunningError || err instanceof NotRunningError || err instanceof SetupSmokeError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(`[dingtalkbot] 致命错误: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  }
}

void main();
```

- [ ] **Step 4: 验证 PASS** — Run: `bun test tests/unit/cli-args.test.ts tests/unit/commands.test.ts tests/unit/setup.test.ts tests/integration/run.test.ts` Expected: PASS（13 tests）。`bun run typecheck` 绿。

- [ ] **Step 5: Commit** — `bun run typecheck && bun test && git add src/cli.ts src/commands tests/ && git commit -m "feat(cli): setup/run/start/stop/status commands with pid-reuse-safe daemon control"`

### Task 12: SPEC.md + CHANGELOG.md + README

**Files:**
- Create: `SPEC.md`, `CHANGELOG.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: 已实现行为（Task 2–11）。
- Produces: 行为契约文档（后续 D2–D4 逐节追加）。

- [ ] **Step 1: 写 SPEC.md**（章节骨架 + D1 契约；`live-verified` 标注留给 Task 14 回填）

```md
# dingtalkbot SPEC

行为契约（v1 按波次追加：D1 传输+回复；D2 会话；D3 命令/访问；D4 附件）。
标注规则：`CI-verified` = 测试覆盖；`live-verified` = 真实钉钉环境验证（见 docs/issues/1/live-smoke.md）。

## Transport（D1 契约）

- 接收：官方 `dingtalk-stream@2.1.5`（exact pin）Stream 模式；订阅 `/v1.0/im/bot/messages/get`（TOPIC_ROBOT）；凭据 `.bot/.env` 的 `DINGTALK_CLIENT_ID/SECRET`。
- SDK 隔离：SDK 仅在 `src/transport/dingtalk-sdk-adapter.ts` 出现；port 定义于 `src/transport/types.ts`。替换 SDK 只改 adapter（CI-verified）。
- 连接监督：SDK autoReconnect 关闭，自有监督循环——**首次**连接 30s 内未 `connected+registered` 则启动失败（disconnect + 非零退出 + error 日志）；运行中断线按指数退避（1s 起 ×2 封顶 60s，成功重置）**永续**重连；socket close 事件立即触发重连，watchdog 轮询为双保险（CI-verified：fake-DWClient 契约测试）。
- 消息处理：回调 data 防御 JSON.parse；归一为 `InboundRobotMessage`（仅 text 提取原始 content，不 trim；其余 msgtype 透传 handler 决策）；处理完**显式 ack**——`socketCallBackResponse(messageId, {status:'SUCCESS', message})`（SDK 内部再包为 `{response:…}` 下发；回调返回值 SDK 不消费）；handler 失败本地重试 3 次后尽弃仍 ack（防服务端 60s 重推）；解析失败/尽弃/丢弃全部留 error/warn 日志（CI-verified）。

## Reply（D1 契约）

- 通道：OpenAPI REST + 自管 token；`sessionWebhook` 不使用（spec Q4）。
- token：`POST /v1.0/oauth2/accessToken`；内存+`.bot/token.json`（0600 原子写，按 clientId 指纹隔离——凭据轮换旧缓存失效）双缓存；到期前 5 分钟刷新；并发 single-flight（CI-verified）。expireIn 单位歧义由归一化处理并在 smoke 实测（live-verified 待回填）。
- p2p 回复：`POST /v1.0/robot/oToMessages/batchSend`，`userIds=[senderStaffId]`；群回复：`POST /v1.0/robot/groupMessages/send`，`openConversationId=入站 conversationId`（live-verified 待回填）；msgKey `sampleMarkdown`，msgParam `{title,text}`（CI-verified：载荷形状）。
- echo 行为：文本按字节原样回显（title `dingtalkbot`）；群消息不剥 @ 前缀（群策略是 D3）；非文本/空文本丢弃并留 warn 日志。

## CLI（D1 契约）

- `dingtalkbot setup [-r <ws>] [--client-id --client-secret]`：旗标空串/交互空输入 → 响亮失败；写 `.env`(0600) → 冒烟（token + Stream 连接）→ PASS / FAIL（FAIL 非零退出）。
- `run`：前台；启动失败非零退出；SIGINT/SIGTERM 优雅关停（断开、清 pidfile）。
- `start`：detached 后台 + `.bot/pids/dingtalkbot.pid`（{pid, startedAt} 抗 pid 复用）；重复启动/缺 .env 拒绝退出 1；陈旧 pidfile 自动清理。
- `stop`：先 pid+startedAt 双因子校验（pid 复用绝不发信号）→ SIGTERM → 15s 宽限 → SIGKILL → 清 pidfile。
- `status`：pid 存活性 + `.bot/state.json` 连接快照（transport 状态 + 更新时间）。

## `.bot/` 布局

`.env`（0600）· `config.json`（D1 空默认，键留 D2/D3）· `access.json`（{admin,approved,groups} 占位，D3 前无语义）· `token.json`（0600 token 缓存，含 clientId 指纹）· `state.json`（连接快照）· `sessions/ uploads/`（D2/D4 占位）· `logs/`（JSONL 每 run 一文件 `YYYYMMDD_HHMMSS.log` + latest.log 链接）· `pids/dingtalkbot.pid`。

## 已知平台假设（live 验证清单）

1. 群发 openConversationId == 入站 conversationId。
2. `/v1.0/oauth2/accessToken` 的 `expireIn` 单位（ms/s）。
3. 显式 ack（`{status:'SUCCESS'}` 结果体，SDK 包装为 `{response:…}`）足以抑制 60s 重推——观察 smoke 后日志无同 messageId 重复 `收到消息`。
```

- [ ] **Step 2: 写 CHANGELOG.md**

```md
# Changelog（Keep a Changelog zh-CN / SemVer）

## [Unreleased]
### Added
- DingTalk Stream 传输骨架：官方 SDK 2.1.5（exact pin）+ 自有指数退避监督（首次超时响亮失败、运行期永续重连）、显式 ack、防御性消息归一（issue #1）。
- OpenAPI 回复通道：single-flight token 管理（凭据指纹隔离的内存+磁盘缓存、到期前刷新）+ p2p/群 markdown 回复 client（issue #1）。
- CLI：setup（凭据+冒烟）/ run / start / stop / status（pid 复用防护）；`.bot/` 工作区布局（issue #1）。
- SPEC.md 行为契约（D1 波次）与 CI 门禁（typecheck/test/build/check:dist）（issue #1）。
```

- [ ] **Step 3: README 充实**（定位、安装（GitHub Packages）、三条快速命令、指向 SPEC.md）。

- [ ] **Step 4: 验证 + Commit** — Run: `bun run typecheck && bun test` Expected: 全绿。`git add SPEC.md CHANGELOG.md README.md && git commit -m "docs: D1 behavior contract (SPEC) + changelog + readme"`

### Task 13: 构建管线 + dist 洁净检查 + CI + 发布管道

**Files:**
- Create: `scripts/check-dist.mjs`, `.github/workflows/ci.yml`, `.github/workflows/publish.yml`

**Interfaces:**
- Consumes: `package.json` 的 build/check:dist 脚本（Task 1）。
- Produces: `bun run build` 产出 `dist/cli.js`（node shebang、SDK external）；`check:dist` 门禁（机器路径 grep + external 验证）；CI（push/PR：install→typecheck→test→build→check:dist）；publish（手动 dispatch→同一套门禁→`npm publish` 到 npm.pkg.github.com）。

- [ ] **Step 1: 写 check-dist 脚本** `scripts/check-dist.mjs`

```js
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
```

- [ ] **Step 2: 本地验证** — Run: `bun run build && bun run check:dist && head -c 60 dist/cli.js` Expected: build 成功；check:dist PASS；dist 头部为 `#!/usr/bin/env node`。

- [ ] **Step 3: 写 CI** `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run test
      - run: bun run build
      - run: bun run check:dist
```

- [ ] **Step 4: 写发布管道** `.github/workflows/publish.yml`

```yaml
name: Publish (GitHub Packages)
on: workflow_dispatch
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck && bun run test && bun run build && bun run check:dist
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://npm.pkg.github.com
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 5: 验证 + Commit** — Run: `bun run typecheck && bun test && bun run build && bun run check:dist` Expected: 全绿。`git add scripts/check-dist.mjs .github/workflows && git commit -m "build: dist cleanliness gate, CI, and manual GitHub Packages publish pipeline"`

**--- 检查点 C：出货门禁完成。`bun run typecheck && bun test && bun run build && bun run check:dist` 全绿 ---**

### Task 14: live smoke runbook（FLAGGED-FOR-HUMAN）

**Files:**
- Create: `docs/issues/1/live-smoke.md`

**Interfaces:**
- Consumes: 全部实现 + Jacky 的钉钉企业内部应用凭据（人供）。
- Produces: AC2/AC5 的活体验证步骤清单与证据回填位；SPEC.md `live-verified` 标注回填。

- [ ] **Step 1: 写 runbook** `docs/issues/1/live-smoke.md`（中文正文，内容如下）

```md
# D1 live smoke runbook（需 Jacky 参与执行）

前置：钉钉开发者后台已建企业内部应用 + 机器人能力（Stream 模式）并发布；拿到 ClientId/ClientSecret。

1. 凭据冒烟（AC5 真凭据 PASS 分支）：
   `node dist/cli.js setup -r <workspace> --client-id <id> --client-secret <secret>`
   预期：写 .env；输出 `token 获取成功`、`Stream 连接+订阅成功`、`smoke: PASS`。
2. 假凭据响亮失败（AC5 FAIL 分支）：
   `node dist/cli.js setup -r <tmp-ws> --client-id x --client-secret y`
   预期：`smoke: FAIL`，退出码非 0（`echo $?` ≠ 0）。
3. 网关起停与状态（AC1/AC5）：
   `node dist/cli.js start -r <workspace>` → `status` 显示运行中 + connected → `stop`。
4. p2p 回显（AC2）：在钉钉私聊机器人发文本 `hello`；预期数秒内收到 markdown 回显 `hello`；`.bot/logs/latest.log` 含 `p2p 回显完成`。
5. 群 @ 回显（AC2）：把机器人拉入测试群，@机器人 发文本；预期群内 markdown 回显；日志含 `群回显完成`。
6. 断线重连（AC3）：断网 30s 再恢复；预期日志出现 `reconnecting` 后恢复 `connected`，期间进程不退出。
7. 证据回填：本文件末尾追加执行记录（日期/步骤/结果日志摘录）；SPEC.md 的三个 `live-verified` 待回填项据此勾选。

## 已知假设验证位
- [ ] 群发 openConversationId == 入站 conversationId（若群回显失败：核对 groupMessages/send 响应 `InvalidConversationId`，修正 openConversationId 来源）
- [ ] expireIn 单位：看步骤 1 日志中 `[token] token 已刷新 expireIn=<原始值> → TTL=<归一化值>ms expiresAt=<epoch ms>`——TTL≈7,200,000ms 即毫秒语义/归一化正确；TTL≈7,200ms 或 expiresAt 异常则修正 normalizeExpiry
- [ ] 显式 ack 抑制 60s 重推（连发 3 条消息，日志无同 messageId 重复 `收到消息`）
```

- [ ] **Step 2: 执行轮行为**：若执行环境提供真凭据（env `DINGTALK_CLIENT_ID/SECRET` 或既有 `.bot/.env`），跑 runbook 步骤 1–3 并回填；**若没有**（预期情形）：代码/CI/文档完成后本任务标 `待人工执行`，随 Human-Review 移交 runbook——AC2/AC5 活体勾选权在 human gate。

- [ ] **Step 3: 终检 + Commit** — Run: `bun run typecheck && bun test && bun run build && bun run check:dist` Expected: 全绿。`git add docs/issues/1/live-smoke.md && git commit -m "docs: D1 live-smoke runbook for human verification"`

## 风险与缓解（显式）

1. **平台载荷假设**（openConversationId、expireIn、ack 效果）：runbook 验证位 + 修正路径已写明（决策 D9/D5）；失败可见（群回显错误以非 2xx 抛出并留日志）。
2. **SDK 公共字段的轻度依赖**（`client.config.autoReconnect` 置 false、`connected/registered` 布尔、`socket.on`）：exact pin 2.1.5 + adapter 契约测试钉住行为；SDK 升级时契约测试先红，替换面限 adapter（AC6）。
3. **活体验证依赖人供凭据**：D11 已定不阻塞管道——CI 证据 + runbook 双轨，human gate 持勾选权。
4. **`bun install --frozen-lockfile` 需提交 `bun.lock`**：Task 1 Step 2 生成后随首个 commit 入库；唯一依赖 `dingtalk-stream` 来自公共 npm registry，无私有依赖拉取风险。
5. **`bun build --target=node` 的 shebang 追加依赖 POSIX shell**：CI/本机均为 Linux；Windows 构建需求出现时另立 issue。
6. **readline 交互路径无自动化测试**：setup 测试全部走非交互旗标路径；交互路径由 runbook 步骤 1 人工覆盖（TTY 环境差异大，自动化性价比为负）。

