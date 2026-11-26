/**
 * Binäres Sync-Protokoll v1 (Client-Seite) – siehe
 * antatime-server/src/protocol.ts. Erstes Byte = Opcode, Zahlen als
 * LEB128-Varint, Schlüssel 16 Byte.
 */
export const Op = {
  hello: 0x01,
  push: 0x02,
  ping: 0x04,
  auth: 0x05,
  changes: 0x81,
  synced: 0x82,
  ack: 0x83,
  pong: 0x84,
  vaultDeleted: 0x85,
  challenge: 0x86,
  authOk: 0x87,
  error: 0x8f,
} as const;

export const PROTOCOL_VERSION = 1;

/** Fehlercodes des Servers, die das Widget unterscheidet. */
export const ErrorCode = {
  quotaExceeded: 7,
  authRequired: 8,
  authFailed: 9,
  serverFull: 10,
} as const;

export interface WireRecord {
  key: Uint8Array;
  data: Uint8Array;
  seq: number;
}

export type ServerMessage =
  | { type: 'changes'; records: WireRecord[] }
  | { type: 'synced'; headSeq: number; serverTime: number | null; epoch: number | null }
  | { type: 'ack'; reqId: number; firstSeq: number }
  | { type: 'pong' }
  | { type: 'vaultDeleted' }
  | { type: 'challenge'; nonce: Uint8Array }
  | { type: 'authOk'; proof: Uint8Array }
  | { type: 'error'; code: number; message: string };

class Reader {
  pos = 0;
  readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  u8(): number {
    const b = this.buf[this.pos++];
    if (b === undefined) throw new Error('Nachricht zu kurz');
    return b;
  }
  varint(): number {
    let result = 0;
    let factor = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      result += (b & 0x7f) * factor;
      if ((b & 0x80) === 0) return result;
      factor *= 128;
    }
    throw new Error('Zahl zu groß');
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('Nachricht zu kurz');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

export function decodeServerMessage(buf: Uint8Array): ServerMessage {
  const r = new Reader(buf);
  const op = r.u8();
  switch (op) {
    case Op.changes: {
      const n = r.varint();
      const records: WireRecord[] = [];
      for (let i = 0; i < n; i++) {
        const seq = r.varint();
        const key = r.bytes(16);
        records.push({ seq, key, data: r.bytes(r.varint()) });
      }
      return { type: 'changes', records };
    }
    case Op.synced: {
      const headSeq = r.varint();
      const serverTime = r.done ? null : r.varint();
      const epoch = r.done ? null : r.varint();
      return { type: 'synced', headSeq, serverTime, epoch };
    }
    case Op.ack:
      return { type: 'ack', reqId: r.varint(), firstSeq: r.varint() };
    case Op.pong:
      return { type: 'pong' };
    case Op.vaultDeleted:
      return { type: 'vaultDeleted' };
    case Op.challenge:
      return { type: 'challenge', nonce: r.bytes(32) };
    case Op.authOk:
      return { type: 'authOk', proof: r.bytes(32) };
    case Op.error: {
      const code = r.u8();
      return { type: 'error', code, message: Buffer.from(buf.subarray(r.pos)).toString('utf8') };
    }
  }
  throw new Error(`Unbekannter Opcode ${op}`);
}

class Writer {
  readonly #b: number[] = [];
  u8(v: number): this {
    this.#b.push(v & 0xff);
    return this;
  }
  varint(v: number): this {
    while (v >= 0x80) {
      this.#b.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    this.#b.push(v);
    return this;
  }
  bytes(b: Uint8Array): this {
    for (const x of b) this.#b.push(x);
    return this;
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.#b);
  }
}

export function encodeHello(vaultId: Uint8Array, lastSeq: number): Uint8Array {
  return new Writer().u8(Op.hello).u8(PROTOCOL_VERSION).bytes(vaultId).varint(lastSeq).finish();
}

export function encodePush(reqId: number, records: { key: Uint8Array; data: Uint8Array }[]): Uint8Array {
  const w = new Writer().u8(Op.push).varint(reqId).varint(records.length);
  for (const r of records) w.bytes(r.key).varint(r.data.length).bytes(r.data);
  return w.finish();
}

export const pingFrame = Uint8Array.of(Op.ping);

export function encodeAuth(ephPub: Uint8Array, mac: Uint8Array): Uint8Array {
  return new Writer().u8(Op.auth).bytes(ephPub).bytes(mac).finish();
}
