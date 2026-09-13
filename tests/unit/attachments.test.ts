import { test, expect } from 'bun:test';
import { parseInboundMedia, sanitizeFileName, stripExt, extFromFileName, extForContentType, detectImageFormat, assertPublicHttpsUrl } from '../../src/media/attachments.js';
import type { InboundRobotMessage } from '../../src/transport/types.js';

const msg = (msgtype: string, raw: Record<string, unknown>, over: Partial<InboundRobotMessage> = {}): InboundRobotMessage => ({
  msgId: 'm1', conversationId: 'cid', conversationKind: 'p2p', senderStaffId: 'st1', senderNick: '王',
  robotCode: 'rc', msgtype, textContent: null, sessionWebhook: null, raw, ...over,
});

test('parse: picture/file/audio/video 各自载荷——统一取 downloadCode（不用 pictureDownloadCode）', () => {
  expect(parseInboundMedia(msg('picture', { content: { pictureDownloadCode: 'pdc', downloadCode: 'dc-p' } })))
    .toEqual({ text: null, attachments: [{ kind: 'image', downloadCode: 'dc-p' }], skippedUnknown: 0 });
  expect(parseInboundMedia(msg('file', { content: { downloadCode: 'dc-f', fileName: '报表.zip', spaceId: 's', fileId: 'f' } })))
    .toEqual({ text: null, attachments: [{ kind: 'file', downloadCode: 'dc-f', fileName: '报表.zip' }], skippedUnknown: 0 });
  expect(parseInboundMedia(msg('audio', { content: { downloadCode: 'dc-a', recognition: '识别文本（v1 忽略）' } })))
    .toEqual({ text: null, attachments: [{ kind: 'voice', downloadCode: 'dc-a' }], skippedUnknown: 0 });
  expect(parseInboundMedia(msg('video', { content: { downloadCode: 'dc-v', duration: '5', videoType: 'mp4' } })))
    .toEqual({ text: null, attachments: [{ kind: 'video', downloadCode: 'dc-v', durationSeconds: 5 }], skippedUnknown: 0 });
});

test('parse: richText——文本按序拼接、图片成附件、未知元素计数；text 消息/未知 msgtype/缺 downloadCode → null', () => {
  const rt = msg('richText', { content: { richText: [
    { text: '问题示例图如下：' },
    { type: 'picture', downloadCode: 'dc-r1', pictureDownloadCode: 'pdc' },
    { text: '通过以上示意图可以明白' },
    { type: 'video', downloadCode: 'x' }, // 未知元素类型（richText 内只认 picture）
  ] } });
  expect(parseInboundMedia(rt)).toEqual({
    text: '问题示例图如下： 通过以上示意图可以明白',
    attachments: [{ kind: 'image', downloadCode: 'dc-r1' }], skippedUnknown: 1,
  });
  expect(parseInboundMedia(msg('text', {}, { textContent: 'hi' } as never))).toBeNull();
  expect(parseInboundMedia(msg('unknownMsgType', { content: { unknownMsgType: 'x' } }))).toBeNull();
  expect(parseInboundMedia(msg('picture', { content: {} }))).toBeNull(); // 载荷缺 downloadCode=不可解析
  expect(parseInboundMedia(msg('picture', {}))).toBeNull();
  // 仅未知元素的 richText 不是"不可解析"——有效结果（D9 收紧：显式注记，不静默丢弃）
  expect(parseInboundMedia(msg('richText', { content: { richText: [{ type: 'sticker', id: 'x' }] } })))
    .toEqual({ text: null, attachments: [], skippedUnknown: 1 });
  expect(parseInboundMedia(msg('richText', { content: { richText: [{ text: '  ' }] } }))).toBeNull(); // 全空文本=无可处理内容
});

test('sanitize/ext: 文件名清洗（去分隔/控制字符/反引号/前导点）；stripExt 剥已知扩展；扩展名白名单', () => {
  expect(sanitizeFileName('../../etc/passwd')).toBe('etcpasswd');
  expect(sanitizeFileName('`rm -rf`\n x')).toBe('rm -rf x');
  expect(sanitizeFileName('...a.zip')).toBe('a.zip');
  expect(sanitizeFileName('')).toBe('attachment');
  expect(Buffer.byteLength(sanitizeFileName('汉'.repeat(100)), 'utf8')).toBeLessThanOrEqual(200); // 字节预算（255 NAME_MAX 防御）
  expect(sanitizeFileName('x'.repeat(300))).toBe('x'.repeat(200));
  expect(stripExt('报表 v2.zip')).toBe('报表 v2');   // 显示名与扩展名分离（防 .zip.zip）
  expect(stripExt('noext')).toBe('noext');
  expect(stripExt('a.tar.gz')).toBe('a.tar');        // 只剥末段
  expect(stripExt('.hidden')).toBe('.hidden');       // 前导点不算扩展
  expect(extFromFileName('a.ZIP')).toBe('zip');
  expect(extFromFileName('noext')).toBe('bin');
  expect(extFromFileName('a.超级长扩展名超限')).toBe('bin');
  expect(extForContentType('IMAGE/PNG; charset=binary')).toBe('png');
  expect(extForContentType('audio/amr')).toBe('amr');
  expect(extForContentType('application/octet-stream')).toBe('bin');
  expect(extForContentType(null)).toBe('bin');
});

test('魔数: PNG/JPEG/GIF/WebP/BMP 命中；截断/随机字节 null', () => {
  expect(detectImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]))).toBe('png');
  expect(detectImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
  expect(detectImageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('gif');
  expect(detectImageFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('webp');
  expect(detectImageFormat(new Uint8Array([0x42, 0x4d, 0, 0]))).toBe('bmp');
  expect(detectImageFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
  expect(detectImageFormat(new Uint8Array(16))).toBeNull();
});

test('URL 安全校验: 非 https/凭据/localhost/私网字面 IP 拒绝；公网 https 放行（G5）', () => {
  expect(assertPublicHttpsUrl('https://cdn.dingtalk.com/a?sig=1').hostname).toBe('cdn.dingtalk.com');
  expect(() => assertPublicHttpsUrl('http://cdn.dingtalk.com/a')).toThrow('https');
  expect(() => assertPublicHttpsUrl('https://user:pw@cdn.test/a')).toThrow('凭据');
  expect(() => assertPublicHttpsUrl('https://localhost/a')).toThrow('保留地址');
  expect(() => assertPublicHttpsUrl('https://127.0.0.1/a')).toThrow('保留地址');
  expect(() => assertPublicHttpsUrl('https://192.168.1.1/a')).toThrow('保留地址');
  expect(() => assertPublicHttpsUrl('https://10.0.0.5/a')).toThrow('保留地址');
  expect(() => assertPublicHttpsUrl('https://172.16.0.1/a')).toThrow('保留地址');
  expect(() => assertPublicHttpsUrl('https://169.254.1.1/a')).toThrow('保留地址');
  expect(() => assertPublicHttpsUrl('https://[::1]/a')).toThrow('保留地址');
  expect(() => assertPublicHttpsUrl('https://[fd00::1]/a')).toThrow('保留地址');
  expect(() => assertPublicHttpsUrl('https://[::ffff:10.0.0.1]/a')).toThrow('保留地址'); // v4 映射（SSRF 绕过面）
  expect(() => assertPublicHttpsUrl('https://[::]/a')).toThrow('保留地址');               // unspecified
  expect(() => assertPublicHttpsUrl('https://[64:ff9b::8.8.8.8]/a')).toThrow('保留地址'); // NAT64/嵌入 v4
  expect(() => assertPublicHttpsUrl('https://999.1.1.1/a')).toThrow('非法下载目标'); // WHATWG IPv4 解析失败——统一收口 fail-closed
  expect(assertPublicHttpsUrl('https://8.8.8.8/a').hostname).toBe('8.8.8.8');
  expect(assertPublicHttpsUrl('https://[2606:4700::6810:85e5]/a').hostname).toBe('[2606:4700::6810:85e5]'); // 公网 v6 放行（hostname 保留方括号）
  expect(() => assertPublicHttpsUrl('https://100.64.1.1/a')).toThrow('保留地址');   // CGNAT 100.64/10
  expect(() => assertPublicHttpsUrl('https://224.0.0.1/a')).toThrow('保留地址');    // 多播 224/4
  expect(() => assertPublicHttpsUrl('https://240.0.0.1/a')).toThrow('保留地址');    // 保留 240/4
  expect(() => assertPublicHttpsUrl('https://[ff02::1]/a')).toThrow('保留地址');    // v6 多播 ff00::/8
  expect(() => assertPublicHttpsUrl('https://[2001:db8::1]/a')).toThrow('保留地址'); // v6 文档段
  expect(() => assertPublicHttpsUrl('https://[2001:0::1]/a')).toThrow('保留地址');  // Teredo
  expect(() => assertPublicHttpsUrl('https://[2002:8.8.8.8]/a')).toThrow(); // 6to4——URL 解析即非法（fail-closed 收口）；规范形 2002:808:808:: 由前缀拒
  expect(() => assertPublicHttpsUrl('https://[2002:808:808::1]/a')).toThrow('保留地址');
});

// ---- Task 3：AttachmentService（下载编排）----
import { mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync, utimesSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AttachmentService } from '../../src/media/attachments.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const localDay = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function makeSvc(over: Record<string, unknown> = {}) {
  const uploadsDir = mkdtempSync(join(tmpdir(), 'dtb-media-'));
  const logs: string[] = [];
  const logger = { debug() {}, info: (_s: string, m: string) => { logs.push(m); }, warn: (_s: string, m: string) => { logs.push(m); }, error: (_s: string, m: string) => { logs.push(m); } };
  const exchanges: Array<{ robotCode: string; downloadCode: string }> = [];
  const svc_ = new AttachmentService({
    uploadsDir,
    maxBytes: 20 * 1024 * 1024,
    logger,
    mediaClient: {
      exchangeDownloadUrl: async (robotCode: string, downloadCode: string) => {
        exchanges.push({ robotCode, downloadCode });
        return `https://cdn.test/${downloadCode}`;
      },
    },
    fetchFn: (async () => new Response(PNG as unknown as BodyInit, {
      status: 200, headers: { 'content-type': 'application/octet-stream' },
    })) as unknown as typeof fetch,
    ...over,
  });
  return { svc: svc_, uploadsDir, logs, exchanges };
}

test('service: AC1——p2p picture 交换+下载落盘 YYYY-MM-DD/，注记含绝对路径与大小，汇总日志（G7）', async () => {
  const { svc, uploadsDir, logs, exchanges } = makeSvc();
  const out = await svc.handle(msg('picture', { content: { downloadCode: 'dc-p' } }));
  if (out === null || out.kind !== 'ok') throw new Error('expected ok outcome');
  expect(out.text).toBeNull();
  expect(out.notes.length).toBe(2); // 附件注记 + 不可信声明
  const dirs = readdirSync(uploadsDir);
  expect(dirs.some((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  const day = dirs.find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))!;
  const files = readdirSync(join(uploadsDir, day));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^[0-9a-f-]{36}-picture\.png$/);      // full UUID + 魔数派生扩展
  expect(statSync(join(uploadsDir, day, files[0]!)).mode & 0o777).toBe(0o600);
  expect(statSync(join(uploadsDir, day)).mode & 0o777).toBe(0o700);
  const abs = resolve(join(uploadsDir, day, files[0]!));
  expect(out.notes[0]).toContain(`\`${abs}\``);                   // 绝对路径反引号（G6/AC1）
  expect(out.notes[0]).toContain('image');
  expect(out.notes[0]).toContain('12 字节');
  expect(out.notes[1]).toContain('不可信');                       // D16 声明
  expect(exchanges).toEqual([{ robotCode: 'rc', downloadCode: 'dc-p' }]);
  expect(logs.some((l) => l.includes('ok=1') && l.includes('exchange=1') && l.includes('msgtype=picture'))).toBe(true);
  expect(logs.every((l) => !l.includes('dc-p'))).toBe(true);      // G7：日志不含 downloadCode
});

test('service: AC3——audio/video 归档注记"内容不可解析"；duration 数值进注记（D3：不携带 recognition）', async () => {
  const { svc } = makeSvc();
  const a = await svc.handle(msg('audio', { content: { downloadCode: 'dc-a', recognition: '识别文本不应出现' } }));
  const v = await svc.handle(msg('video', { content: { downloadCode: 'dc-v', duration: '5' } }));
  if (a === null || a.kind !== 'ok' || v === null || v.kind !== 'ok') throw new Error('audio/video 应为 ok 归档结果');
  for (const out of [a, v]) {
    expect(out.notes[0]).toContain('内容不可解析');
    expect(out.notes.join('')).not.toContain('识别文本');         // recognition 不进 prompt（D3）
  }
  expect(a.notes[0]).toContain('voice');
  expect(v.notes[0]).toContain('video');
  expect(v.notes[0]).toContain('时长 5 秒');
  expect(v.notes[0]).toContain('大小：12 字节'); // G6：归档注记含数值大小元数据
});

test('service: AC4——交换 HTTP 失败 → 终态错误（安全原因：只含状态码），不留半成品；failed 计数与脱敏 warn（G7/D17）', async () => {
  const { svc, uploadsDir, logs } = makeSvc({
    mediaClient: { exchangeDownloadUrl: async () => { throw new Error('OpenAPI /v1.0/robot/messageFiles/download 失败: Error: HTTP 400'); } },
  });
  const out = await svc.handle(msg('picture', { content: { downloadCode: 'dc-bad' } }));
  expect(out).toEqual({ kind: 'error', errorText: '附件下载失败：下载服务返回 HTTP 400。请重新发送该附件。' });
  expect(logs.some((l) => l.includes('stage=exchange') && l.includes('status=400'))).toBe(true);
  expect(logs.some((l) => l.includes('failed=1') && l.includes('exchange=1'))).toBe(true);     // 尝试计数（含失败）+ failed 分项
  expect(logs.every((l) => !l.includes('dc-bad'))).toBe(true);                                 // downloadCode 不进日志
  expect(readdirSync(uploadsDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toHaveLength(0);
});

test('service: G5——下载重定向逐跳（≤3）且跳私网/http 拒绝；下载请求零认证头', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = (async (url: any, init: any) => {
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    if (String(url) === 'https://cdn.test/hop0') return new Response(null, { status: 302, headers: { location: 'hop1' } });
    if (String(url) === 'https://cdn.test/hop1') return new Response(null, { status: 302, headers: { location: 'https://192.168.1.1/x' } });
    return new Response(PNG as unknown as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
  const bad = makeSvc({
    fetchFn,
    mediaClient: { exchangeDownloadUrl: async () => 'https://cdn.test/hop0' }, // 从首跳走起
  });
  const out = await bad.svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  if (out === null || out.kind !== 'error') throw new Error('私网重定向应终态错误');
  expect(seen[0]!.headers['x-acs-dingtalk-access-token']).toBeUndefined(); // 下载零认证头
  const tooMany = makeSvc({
    fetchFn: (async (url: any) => new Response(null, { status: 302, headers: { location: `${String(url)}x` } })) as unknown as typeof fetch,
  });
  expect((await tooMany.svc.handle(msg('picture', { content: { downloadCode: 'dc' } })))!.kind).toBe('error');
});

test('service: AC4——下载本身 HTTP 500（非交换）也终态错误；畸形 Location 不泄露 URL（G7）', async () => {
  const dl500 = makeSvc({
    fetchFn: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
  });
  const out = await dl500.svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  expect(out).toEqual({ kind: 'error', errorText: '附件下载失败：下载失败（HTTP 500，cdn.test）。请重新发送该附件。' });
  const badLoc = makeSvc({
    fetchFn: (async () => new Response(null, { status: 302, headers: { location: 'https://192.168.1.1/signed?token=SECRET' } })) as unknown as typeof fetch,
  });
  const out2 = await badLoc.svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  if (out2 === null || out2.kind !== 'error') throw new Error('私网重定向应终态错误');
  expect(out2.errorText).toContain('保留地址');                       // 拒绝原因可读
  expect(out2.errorText).not.toContain('SECRET');                     // 目标 URL 不泄露
  expect(badLoc.logs.every((l) => !l.includes('SECRET'))).toBe(true); // 日志同源脱敏
  const malformed = makeSvc({
    fetchFn: (async () => new Response(null, { status: 302, headers: { location: 'http://[::bad' } })) as unknown as typeof fetch,
  });
  const out3 = await malformed.svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  expect(out3).toEqual({ kind: 'error', errorText: '附件下载失败：非法下载目标 URL。请重新发送该附件。' }); // new URL 解析失败收口
});

test('service: G1——30s deadline 打断挂起下载（deadlineMs 注入），终态超时错误', async () => {
  const hanging = (async (_u: any, init: any) => new Promise<Response>((_res, rej) => {
    (init as RequestInit).signal?.addEventListener('abort', () => rej(new Error('aborted')));
  })) as unknown as typeof fetch;
  const { svc, logs } = makeSvc({ deadlineMs: 20, fetchFn: hanging });
  const out = await svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  expect(out).toEqual({ kind: 'error', errorText: '附件下载失败：操作超时。请重新发送该附件。' });
  expect(logs.some((l) => l.includes('超时'))).toBe(true);
});

test('service: G1——交换挂起被 30s deadline 打断 → 超时终态（stage=deadline，非网络错误）', async () => {
  const { svc, logs } = makeSvc({
    deadlineMs: 20,
    mediaClient: { exchangeDownloadUrl: (_rc: string, _dc: string, signal?: AbortSignal) => new Promise<string>((_res, rej) => {
      signal?.addEventListener('abort', () => rej(new Error('aborted')));
    }) },
  });
  const out = await svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  expect(out).toEqual({ kind: 'error', errorText: '附件下载失败：操作超时。请重新发送该附件。' });
  expect(logs.some((l) => l.includes('stage=deadline'))).toBe(true);
});

test('service: G2/G3——超限中止删半成品+注记；corrupt（魔数失败/空 body）删文件+注记；聚合与数量限额', async () => {
  // 单文件超限（maxBytes=8，PNG 12 字节）+ 聚合耗尽：第二个附件不再交换（D13 计费）
  const os_ = makeSvc({ maxBytes: 8 });
  const over = await os_.svc.handle(msg('richText', { content: { richText: [
    { type: 'picture', downloadCode: 'dc-1' }, { type: 'picture', downloadCode: 'dc-2' },
  ] } }));
  if (over === null || over.kind !== 'ok') throw new Error('超限应降级为 ok 结果');
  expect(over.notes[0]).toContain('附件过大');
  expect(over.notes[1]).toContain('总大小限额');                  // 聚合已耗尽——降级注记
  expect(os_.exchanges).toHaveLength(1);                         // 第二个附件零交换（不烧配额）
  expect(os_.logs.some((l) => l.includes('附件限额降级') && l.includes('limited='))).toBe(true); // G2：限额降级可观测 warn
  const dayOs = readdirSync(os_.uploadsDir).find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  expect(dayOs === undefined || readdirSync(join(os_.uploadsDir, dayOs!)).length === 0).toBe(true); // 半成品已删（空日期目录无害）
  // corrupt：随机字节 + image/png（魔数失败）
  const cr = makeSvc({
    fetchFn: (async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch,
  });
  const corrupt = await cr.svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  if (corrupt === null || corrupt.kind !== 'ok') throw new Error('魔数失败应为 ok 降级结果');
  expect(corrupt.notes[0]).toContain('损坏');
  const dayCr = readdirSync(cr.uploadsDir).find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  expect(dayCr === undefined || readdirSync(join(cr.uploadsDir, dayCr!)).length === 0).toBe(true); // 损坏半成品已删
  // corrupt：空 body
  const eb = makeSvc({ fetchFn: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch });
  const emptyOut = await eb.svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  if (emptyOut === null || emptyOut.kind !== 'ok') throw new Error('空 body 应为 ok 降级结果');
  expect(emptyOut.notes[0]).toContain('损坏');
  // 数量限额：richText 6 图 → 第 6 个降级注记
  const els = Array.from({ length: 6 }, (_, i) => ({ type: 'picture', downloadCode: `dc-${i}` }));
  const os2 = makeSvc();
  const many = await os2.svc.handle(msg('richText', { content: { richText: els } }));
  if (many === null || many.kind !== 'ok') throw new Error('数量限额应为 ok 降级结果');
  expect(many.notes.filter((n) => n.includes('数量限额')).length).toBe(1); // 恰一个超限注记
  expect(os2.logs.some((l) => l.includes('附件限额降级'))).toBe(true);       // G2：数量限额同样 warn
  // 仅未知元素 richText（D9 收紧）：有效结果 + 显式注记（无附件则无不可信 trailer）
  const unk = await makeSvc().svc.handle(msg('richText', { content: { richText: [{ type: 'sticker', id: 'x' }] } }));
  if (unk === null || unk.kind !== 'ok') throw new Error('仅未知元素 richText 应为 ok 结果');
  expect(unk.notes).toEqual(['[富文本] 消息含不支持的元素类型，已跳过。']);
});

test('service: 发布防碰撞——link EEXIST 换 uuid 重试一次成功（uuid 注入；tmp 名恒真随机不消耗注入序号）', async () => {
  const ids = ['collide', 'fresh'];
  const { svc, uploadsDir } = makeSvc({ uuid: () => ids.shift()! });
  // 预置同名目标文件（注入的第一个发布 id = collide）
  const day = join(uploadsDir, localDay());
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'collide-picture.png'), 'x');
  const out = await svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  if (out === null || out.kind !== 'ok') throw new Error('发布防碰撞用例应为 ok 结果');
  expect(readdirSync(day)).toContain('fresh-picture.png');   // 重试发布成功
  expect(readdirSync(day)).toContain('collide-picture.png'); // 原文件未被覆盖（link 独占语义）
});

test('service: 写前清理 >1h 陈旧 .tmp（G5）', async () => {
  const { svc, uploadsDir } = makeSvc();
  const day = join(uploadsDir, localDay());
  mkdirSync(day, { recursive: true });
  const stale = join(day, '.stale.tmp');
  writeFileSync(stale, 'x');
  utimesSync(stale, new Date(Date.now() - 2 * 3_600_000), new Date(Date.now() - 2 * 3_600_000)); // utimes 数字=秒——必须用 Date 对象
  const fresh = join(day, '.fresh.tmp');
  writeFileSync(fresh, 'x');                                    // 新 tmp 不动
  const out = await svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  if (out === null || out.kind !== 'ok') throw new Error('陈旧 tmp 清理用例应为 ok 结果');
  expect(existsSync(stale)).toBe(false);                        // 陈旧已清
  expect(existsSync(fresh)).toBe(true);                         // 新近保留
});

test('service: file 附件（AC2）——显示名剥扩展防 .zip.zip；fileName 清洗进文件名与注记', async () => {
  const { svc, uploadsDir } = makeSvc({
    fetchFn: (async () => new Response(new Uint8Array([1, 2, 3]) as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/octet-stream' } })) as unknown as typeof fetch,
  });
  const out = await svc.handle(msg('file', { content: { downloadCode: 'dc-f', fileName: '../报表 v2.zip' } }));
  if (out === null || out.kind !== 'ok') throw new Error(`预期 ok 结果，得到: ${JSON.stringify(out)}`);
  const day = readdirSync(uploadsDir).find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))!;
  const f = readdirSync(join(uploadsDir, day))[0]!;
  expect(f).toMatch(/^[0-9a-f-]{36}-报表 v2\.zip$/); // 清洗 ../ 且扩展不重复（stripExt）
  expect(out.notes[0]).toContain('file');
  expect(out.notes[0]).toContain('报表 v2.zip');
});

// ---- code-review r1 修复回归 ----
test('service: G1——流不观测 abort 时 deadline 在写盘循环兜底（注入无限流）', async () => {
  // 无限小 chunk 流：不因 deadline 停止产生（真实 Response 流会 reject——此 fake 模拟最坏情况）
  const endless = new ReadableStream<Uint8Array>({
    start(controller) {
      const t = setInterval(() => {
        try { controller.enqueue(new Uint8Array([1, 2, 3])); } catch { clearInterval(t); } // 关闭后自清，不泄漏
      }, 1);
    },
  });
  const { svc, logs } = makeSvc({ deadlineMs: 20, fetchFn: (async () => new Response(endless as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch });
  const out = await svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  expect(out).toEqual({ kind: 'error', errorText: '附件下载失败：操作超时。请重新发送该附件。' });
  expect(logs.some((l) => l.includes('stage=deadline'))).toBe(true);
});

test('service: 非碰撞 fs 失败（EACCES 只读日期目录）→ 终态、零发布、不消耗任何发布 id', async () => {
  const ids: string[] = ['first', 'second'];
  const { svc, uploadsDir } = makeSvc({ uuid: () => ids.shift()! });
  const day = join(uploadsDir, localDay());
  mkdirSync(day, { recursive: true });
  chmodSync(day, 0o500); // 只读目录：tmp 创建（openSync wx）即 EACCES——非 EEXIST 失败类
  try {
    const out = await svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
    expect(out).toEqual({ kind: 'error', errorText: '附件下载失败：文件写入失败。请重新发送该附件。' });
    expect(ids).toEqual(['first', 'second']);            // publish 未达——零发布 id 消耗（无孤儿副本）
    expect(readdirSync(day)).toHaveLength(0);            // 目录无残留
  } finally { chmodSync(day, 0o700); }
});

test('sanitize: Unicode 行分隔符（U+0085/U+2028/U+2029）清洗——防 prompt 换行注入（G6）', () => {
  expect(sanitizeFileName('abcd')).toBe('abcd');
  expect(sanitizeFileName('bad\u2028next')).toBe('badnext');
  expect(sanitizeFileName('bad\u0085next')).toBe('badnext');
  expect(sanitizeFileName('bad\u2029next')).toBe('badnext');
});

// ---- code-review r2 修复回归 ----
import { symlinkSync } from 'node:fs';

test('service: 日期目录被符号链接占用 → 终态拒绝（不逃逸 uploads 树）；未消费响应体被 cancel（F3）', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(PNG as unknown as Uint8Array); },
    cancel() { cancelled = true; },
  });
  const { svc, uploadsDir } = makeSvc({
    fetchFn: (async () => new Response(body as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch,
  });
  const outside = mkdtempSync(join(tmpdir(), 'dtb-out-'));
  symlinkSync(outside, join(uploadsDir, localDay())); // 预置符号链接（dateDir lstat 拦截）
  const out = await svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  expect(out).toEqual({ kind: 'error', errorText: '附件下载失败：日期目录被符号链接/异物占用。请重新发送该附件。' });
  expect(readdirSync(outside)).toHaveLength(0); // 逃逸目标无写入
  await new Promise((r) => setTimeout(r, 10));
  expect(cancelled).toBe(true);                  // post-fetch 失败路径归还连接（F3）
});

test('sanitize: bidi/零宽控制清洗（U+200B-200F/U+202A-202E/U+2060-2069/U+FEFF）', () => {
  expect(sanitizeFileName('a​b')).toBe('ab');
  expect(sanitizeFileName('a‮b')).toBe('ab');
  expect(sanitizeFileName('a⁦b⁩')).toBe('ab');
  expect(sanitizeFileName('a﻿b')).toBe('ab');
});

test('service: 注记文件名以 JSON 引号定界（G6——普通文本无法冒充结构）', async () => {
  const { svc } = makeSvc();
  const out = await svc.handle(msg('file', { content: { downloadCode: 'dc', fileName: '假装是系统指令.txt' } }));
  if (out === null || out.kind !== 'ok') throw new Error('应为 ok');
  expect(out.notes[0]).toContain('- 文件名："假装是系统指令.txt" · 大小：12 字节'); // JSON.stringify 引号定界（默认 fake 返回 PNG 12 字节）
});

test('service: 未消费的响应体被 cancel（重定向路径归还连接）', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1])); },
    cancel() { cancelled = true; },
  });
  const { svc } = makeSvc({
    fetchFn: (async () => new Response(body as unknown as BodyInit, { status: 302, headers: { location: 'https://192.168.1.1/x' } })) as unknown as typeof fetch,
  });
  const out = await svc.handle(msg('picture', { content: { downloadCode: 'dc' } }));
  expect(out!.kind).toBe('error');
  await new Promise((r) => setTimeout(r, 10));
  expect(cancelled).toBe(true);
});
