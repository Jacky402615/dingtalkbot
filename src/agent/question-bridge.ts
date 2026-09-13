import type { AskUserQuestionPayload, AskQuestion } from './claude-runner.js';

// 窄规则（decisions D12）：只剥一个前导 bot 提及——群内所有消息都以 "@机器人 …" 开头，
// 不剥则数字应答在群里恒不命中（"@bot 1"）。任意非首位 @token 不动（群策略主体在 D3）。
export function stripLeadingMention(text: string): string {
  return text.replace(/^@[^\s@]+\s+/, '');
}

export function isNumericReply(text: string): boolean {
  return /^\d+(\s*,\s*\d+)*$/.test(text);
}

export function renderQuestionList(p: AskUserQuestionPayload): string {
  const anyMulti = p.questions.some((q) => q.multiSelect);
  if (p.questions.length === 1) {
    const q = p.questions[0]!;
    const lines = [`**${q.question}**${q.multiSelect ? '（可多选）' : ''}`, ''];
    q.options.forEach((opt, i) => {
      lines.push(`${i + 1}. ${opt.label}${opt.description !== '' ? ` — ${opt.description}` : ''}`);
    });
    lines.push('', q.multiSelect ? '请回复编号（多选用逗号分隔，如 1,3）' : '请回复编号');
    return lines.join('\n');
  }
  const lines: string[] = [];
  if (anyMulti) lines.push('（多题+多选组合暂不支持编号作答，请直接用文字回复）', '');
  p.questions.forEach((q, qi) => {
    lines.push(`**问题 ${qi + 1}：${q.question}**${q.multiSelect ? '（可多选）' : ''}`, '');
    q.options.forEach((opt, i) => {
      lines.push(`${i + 1}. ${opt.label}${opt.description !== '' ? ` — ${opt.description}` : ''}`);
    });
    lines.push('');
  });
  lines.push('多题时按顺序逗号回复（第 i 个数字答第 i 题），如 1,2 依次作答');
  return lines.join('\n');
}

function labelsOf(q: AskQuestion, indices: number[]): string {
  return indices.map((i) => q.options[i - 1]!.label).map((l) => `"${l}"`).join('、');
}

function answerTextOf(pairs: Array<{ q: AskQuestion; indices: number[] }>): string {
  const lines = ['[AskUserQuestion 应答]'];
  for (const { q, indices } of pairs) lines.push(`${q.question}: 已选 ${labelsOf(q, indices)}`);
  return lines.join('\n');
}

export function parseNumericReply(text: string, p: AskUserQuestionPayload): { kind: 'answer'; answerText: string } | { kind: 'help'; message: string } {
  const nums = text.split(',').map((s) => Number(s.trim()));
  if (nums.some((n) => !Number.isInteger(n) || n < 1)) {
    return { kind: 'help', message: '编号无效：请回复选项编号（从 1 开始）' };
  }
  if (p.questions.length === 1) {
    const q = p.questions[0]!;
    if (nums.some((n) => n > q.options.length)) {
      return { kind: 'help', message: `编号超出范围：请回复 1-${q.options.length}` };
    }
    if (!q.multiSelect && nums.length > 1) {
      return { kind: 'help', message: '该问题单选：请只回复一个编号' };
    }
    const indices = q.multiSelect ? nums : [nums[0]!];
    return { kind: 'answer', answerText: answerTextOf([{ q, indices }]) };
  }
  // 多题：任一 multiSelect → 逗号列表不可表示（按位映射与多选语义冲突），显式降级
  if (p.questions.some((q) => q.multiSelect)) {
    return { kind: 'help', message: '多题+多选组合暂不支持编号作答，请直接用文字描述你的选择' };
  }
  if (nums.length !== p.questions.length) {
    return { kind: 'help', message: `共 ${p.questions.length} 个问题：请按顺序逗号回复 ${p.questions.length} 个编号（如 1,2 依次作答）` };
  }
  for (let i = 0; i < p.questions.length; i++) {
    if (nums[i]! > p.questions[i]!.options.length) {
      return { kind: 'help', message: `问题 ${i + 1} 编号超出范围（1-${p.questions[i]!.options.length}）` };
    }
  }
  return {
    kind: 'answer',
    answerText: answerTextOf(p.questions.map((q, i) => ({ q, indices: [nums[i]!] }))),
  };
}
