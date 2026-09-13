import { test, expect } from 'bun:test';
import { stripLeadingMention, isNumericReply, renderQuestionList, parseNumericReply } from '../../src/agent/question-bridge.js';
import type { AskUserQuestionPayload } from '../../src/agent/claude-runner.js';

const SINGLE: AskUserQuestionPayload = { toolUseId: 'c1', questions: [
  { question: '红还是蓝？', header: 'Color', multiSelect: false,
    options: [{ label: '红', description: '暖色' }, { label: '蓝', description: '冷色' }] } ] };
const MULTI_PICK: AskUserQuestionPayload = { toolUseId: 'c2', questions: [
  { question: '要哪些？', header: 'Pick', multiSelect: true,
    options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'C', description: '' }] } ] };
const TWO_Q: AskUserQuestionPayload = { toolUseId: 'c3', questions: [
  { question: '语言？', header: 'Lang', multiSelect: false, options: [{ label: 'TS', description: '' }, { label: 'Py', description: '' }] },
  { question: '深度？', header: 'Depth', multiSelect: false, options: [{ label: '浅', description: '' }, { label: '深', description: '' }] } ] };
const TWO_Q_MULTI: AskUserQuestionPayload = { toolUseId: 'c4', questions: [
  { question: '语言？', header: 'Lang', multiSelect: false, options: [{ label: 'TS', description: '' }, { label: 'Py', description: '' }] },
  { question: '附些啥？', header: 'Extra', multiSelect: true, options: [{ label: 'X', description: '' }, { label: 'Y', description: '' }] } ] };

test('stripLeadingMention: 剥一个前导 @token；其余不动', () => {
  expect(stripLeadingMention('@机器人 你好')).toBe('你好');
  expect(stripLeadingMention('你好 @某人')).toBe('你好 @某人');
  expect(stripLeadingMention('1')).toBe('1');
  expect(stripLeadingMention('@a@b hi')).toBe('@a@b hi');
});

test('isNumericReply: 单数字/逗号多数字', () => {
  expect(isNumericReply('1')).toBe(true);
  expect(isNumericReply('1,3')).toBe(true);
  expect(isNumericReply(' 1 , 3 ')).toBe(true);
  expect(isNumericReply('1、3')).toBe(false);
  expect(isNumericReply('选1')).toBe(false);
});

test('renderQuestionList: 单题编号 + 回复格式提示；多题分组；多题+多选降级提示', () => {
  const single = renderQuestionList(SINGLE);
  expect(single).toContain('红还是蓝？'); expect(single).toContain('1. 红'); expect(single).toContain('2. 蓝');
  expect(single).toContain('回复编号');
  const two = renderQuestionList(TWO_Q);
  expect(two).toContain('语言？'); expect(two).toContain('深度？');
  expect(two).toContain('按顺序');
  const mixed = renderQuestionList(TWO_Q_MULTI);
  expect(mixed).toContain('暂不支持'); // 不可表示组合的显式降级
});

test('parseNumericReply: 单题单选/多选/越界/单选多数字', () => {
  expect(parseNumericReply('1', SINGLE)).toEqual({ kind: 'answer', answerText: '[AskUserQuestion 应答]\n红还是蓝？: 已选 "红"' });
  expect(parseNumericReply('2', SINGLE)).toMatchObject({ kind: 'answer' });
  const multi = parseNumericReply('1,3', MULTI_PICK);
  expect(multi).toMatchObject({ kind: 'answer' });
  expect((multi as { answerText: string }).answerText).toContain('已选 "A"、"C"');
  expect(parseNumericReply('3', SINGLE).kind).toBe('help');
  expect(parseNumericReply('0', SINGLE).kind).toBe('help');
  expect(parseNumericReply('1,2', SINGLE).kind).toBe('help');
});

test('parseNumericReply: 多题按位映射；个数不匹配 help；任一 multiSelect → help', () => {
  const r = parseNumericReply('2,1', TWO_Q);
  expect(r).toMatchObject({ kind: 'answer' });
  expect((r as { answerText: string }).answerText).toContain('语言？: 已选 "Py"');
  expect((r as { answerText: string }).answerText).toContain('深度？: 已选 "浅"');
  expect(parseNumericReply('1', TWO_Q).kind).toBe('help');
  expect(parseNumericReply('9,1', TWO_Q).kind).toBe('help');
  expect(parseNumericReply('1,2', TWO_Q_MULTI).kind).toBe('help');
});
