export interface FakeChild {
  pid: number;
  killed: string[];
  stdout: { on(event: 'data', cb: (b: Buffer) => void): void; on(event: 'close', cb: () => void): void };
  stderr: { on(event: 'data', cb: (b: Buffer) => void): void };
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  write(line: unknown): void;
  writeRaw(line: string): void;
  writeBytes(b: Buffer): void;
  closeStdout(): void;
  failSpawn(err: Error): void;
  exitWith(code: number | null): void;
}

export function makeFakeChild(): FakeChild {
  const errors: Array<(e: Error) => void> = [];
  const exits: Array<(c: number | null) => void> = [];
  const datas: Array<(b: Buffer) => void> = [];
  const closes: Array<() => void> = [];
  return {
    pid: 4321,
    killed: [],
    stdout: {
      on: (event: string, cb: unknown) => {
        if (event === 'data') datas.push(cb as (b: Buffer) => void);
        if (event === 'close') closes.push(cb as () => void);
      },
    },
    stderr: { on: () => {} },
    on: (event: string, cb: unknown) => {
      if (event === 'error') errors.push(cb as (e: Error) => void);
      if (event === 'exit') exits.push(cb as (c: number | null) => void);
    },
    write: (line) => { for (const cb of datas) cb(Buffer.from(JSON.stringify(line) + '\n')); },
    writeRaw: (line) => { for (const cb of datas) cb(Buffer.from(line + '\n')); },
    writeBytes: (b) => { for (const cb of datas) cb(b); },
    closeStdout: () => { for (const cb of closes) cb(); },
    failSpawn: (err) => { for (const cb of errors) cb(err); },
    exitWith: (code: number | null) => { for (const cb of exits) cb(code); },
  };
}
