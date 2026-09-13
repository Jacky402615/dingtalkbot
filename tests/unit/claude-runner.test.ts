import { test, expect } from 'bun:test';
import type { spawn } from 'node:child_process';
import { ClaudeRunner } from '../../src/agent/claude-runner.js';
import { makeFakeChild, type FakeChild } from '../helpers/fake-child-process.js';
import type { Logger } from '../../src/logger.js';

const silentLogger = (extra: { error?: (m: string) => void; warn?: (m: string) => void } = {}): Logger => ({
  debug() {}, info() {}, warn: (_m, msg) => extra.warn?.(msg), error: (_m, msg) => extra.error?.(msg),
});

function makeRunner(child: FakeChild, opts: Record<string, unknown> = {}, spawnCalls: unknown[][] = []) {
  return new ClaudeRunner({
    bin: 'claude', model: 'glm-5.3-flash', permissionMode: 'bypassPermissions', timeoutMs: 60_000,
    logger: silentLogger(), killDelayMs: 10,
    spawnFn: ((...args: unknown[]) => { spawnCalls.push(args); return child as never; }) as unknown as typeof spawn,
    killFn: (pid, sig) => { child.killed.push(`${sig}${pid < 0 ? '-' + String(-pid) : ''}`); },
    ...opts,
  });
}

function assistantMsg(id: string, content: unknown[]) {
  return { type: 'assistant', message: { id, role: 'assistant', content } };
}

test('runner: 旗标/cwd/detached；首回合 --session-id、续回合 --resume', async () => {
  const child = makeFakeChild();
  const calls: unknown[][] = [];
  const r = makeRunner(child, {}, calls);
  const p = r.run({ prompt: 'hi', sessionId: 'uuid-1', resume: false, cwd: '/ws' }, {});
  child.write({ type: 'system', subtype: 'init', session_id: 'uuid-1' });
  child.write(assistantMsg('m1', [{ type: 'text', text: '答案' }]));
  child.write({ type: 'result', subtype: 'success', session_id: 'uuid-1', result: '答案' });
  child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(res.ok).toBe(true);
  const args = calls[0]![1] as string[];
  expect(args).toContain('--session-id'); expect(args).toContain('uuid-1');
  expect(args).toContain('--output-format'); expect(args).toContain('stream-json');
  expect(args).toContain('--verbose'); expect(args).toContain('--include-partial-messages');
  expect(args).toContain('--model'); expect(args).toContain('glm-5.3-flash');
  expect(args).toContain('--permission-mode'); expect(args).toContain('bypassPermissions');
  expect(calls[0]![2]).toMatchObject({ cwd: '/ws', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const p2 = r.run({ prompt: 'again', sessionId: 'uuid-1', resume: true, cwd: '/ws' }, {});
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  await p2;
  expect((calls[1]![1] as string[])).toContain('--resume');
});

test('runner: 多消息文本域隔离——两条 assistant 消息全文拼接不覆盖', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const seen: string[] = [];
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, { onText: (t) => { seen.push(t); } });
  child.write(assistantMsg('m1', [{ type: 'text', text: '第一段' }]));
  child.write(assistantMsg('m2', [{ type: 'text', text: '第二段' }])); // 新消息域：committed=['第一段']
  expect(seen.at(-1)).toBe('第一段第二段');
  child.write(assistantMsg('m2b', [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '第三段（index 0 覆写当前域）' }]));
  child.write({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '+增量' } } });
  expect(seen.at(-1)).toBe('第一段第二段第三段（index 0 覆写当前域）+增量');
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(res.outputText).toBe('第一段第二段第三段（index 0 覆写当前域）+增量');
});

test('runner: delta 级增量先于 message 级到达（同域内先加后覆写）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const seen: string[] = [];
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, { onText: (t) => { seen.push(t); } });
  child.write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } } });
  child.write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } } });
  expect(seen.at(-1)).toBe('你好');
  child.write(assistantMsg('m1', [{ type: 'text', text: '你好（权威）' }]));
  expect(seen.at(-1)).toBe('你好（权威）');
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(res.outputText).toBe('你好（权威）');
});

test('runner: AskUserQuestion 拦截 + 其后文本抑制（decisions D2）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const questions: unknown[] = [];
  const texts: string[] = [];
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' },
    { onQuestion: (q) => { questions.push(q); }, onText: (t) => { texts.push(t); } });
  child.write(assistantMsg('m1', [{ type: 'text', text: '我想问：' }]));
  child.write(assistantMsg('m2', [{ type: 'tool_use', id: 'call_1', name: 'AskUserQuestion',
    input: { questions: [{ question: '红还是蓝？', header: 'Color', multiSelect: false,
      options: [{ label: '红', description: 'red' }, { label: '蓝', description: 'blue' }] }] } }]));
  child.write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'Answer questions?' }] } });
  child.write(assistantMsg('m3', [{ type: 'text', text: '问题被拒了（应被抑制）' }]));
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  await p;
  expect(questions).toHaveLength(1);
  expect((questions[0] as { toolUseId: string }).toolUseId).toBe('call_1');
  expect(texts.at(-1)).toBe('我想问：');
});

test('runner: 同消息内 text→AskUserQuestion——问题前文本先流出再抑制（r2 修订回归）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const order: string[] = [];
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {
    onText: (t) => { order.push(`text:${t}`); },
    onQuestion: (q) => { order.push(`question:${q.questions[0]!.question}`); },
  });
  child.write(assistantMsg('m1', [
    { type: 'text', text: '先说一句' },
    { type: 'tool_use', id: 'call_9', name: 'AskUserQuestion',
      input: { questions: [{ question: '选哪个？', header: 'H', multiSelect: false, options: [{ label: 'A', description: '' }] }] } },
  ]));
  child.write(assistantMsg('m2', [{ type: 'text', text: '被抑制的后续' }]));
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  await p;
  expect(order).toEqual(['text:先说一句', 'question:选哪个？']); // 前文本先出、后文本抑制
});

test('runner: 异步 onText 串行化——settle 前所有回调完成、顺序不乱', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const order: string[] = [];
  let gate = Promise.resolve();
  const slowOnText = (t: string) => {
    const run = gate.then(() => { order.push(`text:${t}`); });
    gate = run; // 人为让每次回调排队且慢
    return run;
  };
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, { onText: slowOnText });
  child.write(assistantMsg('m1', [{ type: 'text', text: '一' }]));
  child.write(assistantMsg('m2', [{ type: 'text', text: '二' }]));
  child.write({ type: 'result', subtype: 'success' });
  child.closeStdout(); child.exitWith(0);
  await p; // settle 等待 emitChain 排空
  expect(order).toEqual(['text:一', 'text:一二']); // 无乱序、无丢失
});

test('runner: 回调抛错 → error 日志（响亮），回合仍 ok', async () => {
  const child = makeFakeChild();
  const errs: string[] = [];
  const r = makeRunner(child, { logger: silentLogger({ error: (m) => errs.push(m) }) });
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' },
    { onText: () => { throw new Error('callback boom'); } });
  child.write(assistantMsg('m1', [{ type: 'text', text: '内容' }]));
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(res.ok).toBe(true);
  expect(errs.some((e) => e.includes('callback boom'))).toBe(true);
});

test('runner: init session_id 与请求不符 → warn', async () => {
  const child = makeFakeChild();
  const warns: string[] = [];
  const r = makeRunner(child, { logger: silentLogger({ warn: (m) => warns.push(m) }) });
  const p = r.run({ prompt: 'x', sessionId: 'uuid-A', resume: false, cwd: '/ws' }, {});
  child.write({ type: 'system', subtype: 'init', session_id: 'uuid-B' });
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  await p;
  expect(warns.some((w) => w.includes('session'))).toBe(true);
});

test('runner: 非零退出 → ok:false；exit 后晚到 stdout 行不丢', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const texts: string[] = [];
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, { onText: (t) => { texts.push(t); } });
  child.write(assistantMsg('m1', [{ type: 'text', text: '部分输出' }]));
  child.exitWith(2);          // exit 先到
  child.write(assistantMsg('m1z', [{ type: 'text', text: '迟到行' }])); // close 前仍可达（readline 已缓冲）
  child.closeStdout();
  const res = await p;
  expect(res.ok).toBe(false);
  expect(res.outputText).toContain('部分输出'); // !ok 时部分文本在 outputText
  expect(res.errorText).toContain('2');         // 错误原因在 errorText
});

test('runner: 超时但已有部分文本 → outputText 与 errorText 分列；TERM→KILL 后 settle', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child, { timeoutMs: 30 });
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.write(assistantMsg('m1', [{ type: 'text', text: '写了一半' }]));
  const res = await p;
  expect(res.ok).toBe(false);
  expect(res.outputText).toBe('写了一半');
  expect(res.errorText).toContain('超时');
  expect(child.killed[0]).toBe('SIGTERM-4321');
  expect(child.killed.at(-1)).toBe('SIGKILL-4321');
});

test('runner: exit 后 stdout close 丢失 → 2s 兜底定时器仍 settle', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.write(assistantMsg('m1', [{ type: 'text', text: 'ok' }]));
  child.exitWith(0); // 不 closeStdout
  const res = await p;
  expect(res.ok).toBe(true);
  expect(res.outputText).toBe('ok');
});

test('runner: ENOENT → 响亮 ok:false', async () => {
  const child = makeFakeChild();
  const errs: string[] = [];
  const r = new ClaudeRunner({ bin: 'nope', model: 'm', permissionMode: 'bypassPermissions', timeoutMs: 1_000,
    logger: silentLogger({ error: (m) => errs.push(m) }), killDelayMs: 5,
    spawnFn: (() => child) as unknown as typeof spawn,
    killFn: () => {} });
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.failSpawn(new Error('spawn nope ENOENT'));
  const res = await p;
  expect(res.ok).toBe(false);
  expect(res.errorText).toContain('claude');
  expect(errs.some((e) => e.includes('ENOENT') || e.includes('spawn'))).toBe(true);
});

test('runner: 非 JSON 行防御跳过（不崩）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.writeRaw('not-json');
  child.writeRaw('');
  child.write({ type: 'result', subtype: 'success' });
  child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(res.ok).toBe(true);
});

// ---- code-review r1 修复回归 ----
test('runner: text→纯 tool 消息→text 不重复前文（完整事件无 text 亦重置域）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.write(assistantMsg('m1', [{ type: 'text', text: '先说明' }]));
  child.write(assistantMsg('m2', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }])); // 无 text 块
  child.write(assistantMsg('m3', [{ type: 'text', text: '后结论' }]));
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(res.outputText).toBe('先说明后结论'); // 不出现两次"先说明"
});

test('runner: 非 JSON 行 → warn 留痕（不静默）', async () => {
  const child = makeFakeChild();
  const warns: string[] = [];
  const r = makeRunner(child, { logger: silentLogger({ warn: (m) => warns.push(m) }) });
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.writeRaw('not-json');
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  await p;
  expect(warns.some((w) => w.includes('非 JSON'))).toBe(true);
});

test('runner: exit code=null（信号终止）→ ok:false，不再误判成功', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.write(assistantMsg('m1', [{ type: 'text', text: '部分' }]));
  child.closeStdout(); child.exitWith(null); // 信号死
  const res = await p;
  expect(res.ok).toBe(false);
  expect(res.errorText).toContain('信号');
  expect(res.outputText).toBe('部分');
});

test('runner: killAll 中止在飞回合（TERM→KILL + 按关停定性）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.write(assistantMsg('m1', [{ type: 'text', text: '跑到一半' }]));
  r.killAll();
  const res = await p;
  expect(res.ok).toBe(false);
  expect(res.errorText).toContain('killAll');
  expect(child.killed[0]).toBe('SIGTERM-4321');
  expect(child.killed.at(-1)).toBe('SIGKILL-4321');
  expect(r['closed']).toBe(true);
  const after = await r.run({ prompt: 'y', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  expect(after.ok).toBe(false); // 关停后拒新
});

// ---- code-review r2 修复回归 ----
test('runner: complete→delta→complete（真实 delta 时序）不重复上一消息', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.write(assistantMsg('m1', [{ type: 'text', text: 'A' }]));            // 消息 1 完成
  child.write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'δ' } } }); // 消息 2 的 delta
  child.write(assistantMsg('m2', [{ type: 'text', text: 'B' }]));            // 消息 2 完成
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(res.outputText).toBe('AB'); // 不出现 'Aδ' 提交或 A 重复
});

test('runner: killAll 等待升级收尾——await 返回时回合已 settle 且 KILL 已发（TERM 被忽略场景）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child); // killFn 只记录不真杀（模拟子进程忽略 TERM）
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.write(assistantMsg('m1', [{ type: 'text', text: '跑到一半' }]));
  await r.killAll();
  const res = await p;
  expect(res.ok).toBe(false);
  expect(res.errorText).toContain('killAll');
  expect(child.killed).toContain('SIGKILL-4321');
});

// ---- pr-review r1 修复回归 ----
test('runner: 同消息 [text, AskUserQuestion, text]——问题后文本不泄漏进快照；outputText 仍全量', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const order: string[] = [];
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {
    onText: (t) => { order.push(`text:${t}`); },
    onQuestion: (q) => { order.push('question'); },
  });
  child.write(assistantMsg('m1', [
    { type: 'text', text: '先说明' },
    { type: 'tool_use', id: 'c1', name: 'AskUserQuestion',
      input: { questions: [{ question: '选？', header: 'H', multiSelect: false, options: [{ label: 'A', description: '' }] }] } },
    { type: 'text', text: '问题后的说明（不得泄漏）' },
  ]));
  child.write({ type: 'result', subtype: 'success' }); child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(order).toEqual(['text:先说明', 'question']);            // 快照只含问题前文本
  expect(res.outputText).toBe('先说明问题后的说明（不得泄漏）');  // 全量累计供 outputText
});

test('runner: 多字节 UTF-8 跨 chunk 分裂不破坏（StringDecoder）', async () => {
  const child = makeFakeChild();
  const r = makeRunner(child);
  const seen: string[] = [];
  const payload = JSON.stringify(assistantMsg('m1', [{ type: 'text', text: '你好' }])) + '\n';
  const bytes = Buffer.from(payload, 'utf8');
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, { onText: (t) => { seen.push(t); } });
  // 在"你"的三字节中间切一刀、在换行前切一刀
  const youIdx = bytes.indexOf(Buffer.from('你', 'utf8'));
  child.writeBytes(bytes.subarray(0, youIdx + 1));
  child.writeBytes(bytes.subarray(youIdx + 1, bytes.length - 1));
  child.writeBytes(bytes.subarray(bytes.length - 1));
  child.write(JSON.stringify({ type: 'result', subtype: 'success' }));
  child.closeStdout(); child.exitWith(0);
  const res = await p;
  expect(seen.at(-1)).toBe('你好');          // 无 U+FFFD
  expect(res.outputText).toBe('你好');
});

test('runner: 看门狗 TERM 后主进程先退 → finish 仍补发进程组 SIGKILL（升级不被取消）', async () => {
  const child = makeFakeChild();
  const r = new ClaudeRunner({
    bin: 'claude', model: 'm', permissionMode: 'bypassPermissions', timeoutMs: 30,
    logger: silentLogger(), killDelayMs: 5_000, // KILL 定时器看似很晚——靠 finish 内补发
    spawnFn: (() => child) as unknown as typeof spawn,
    killFn: (pid, sig) => {
      child.killed.push(`${sig}${pid < 0 ? '-' + String(-pid) : ''}`);
      if (sig === 'SIGTERM') child.exitWith(null); // 主进程响应 TERM 提前退出
    },
  });
  const p = r.run({ prompt: 'x', sessionId: 'u', resume: false, cwd: '/ws' }, {});
  child.write(assistantMsg('m1', [{ type: 'text', text: '部分' }]));
  const res = await p;
  expect(res.ok).toBe(false);
  expect(res.errorText).toContain('超时');
  expect(child.killed).toContain('SIGKILL-4321'); // 主进程早退也拿到组 KILL
});
