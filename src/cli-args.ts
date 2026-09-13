// 纯解析模块（无副作用；测试 import 本文件）
export interface CliArgs { command: string; root?: string; clientId?: string; clientSecret?: string }

export function parseArgs(argv: string[]): CliArgs | null {
  const [rawCommand, ...rest] = argv;
  if (!rawCommand) return null;
  const command = rawCommand === '-v' || rawCommand === '--version' ? '__version' : rawCommand;
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
