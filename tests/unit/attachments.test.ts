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
});
