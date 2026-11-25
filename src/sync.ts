import type { SyncCrypto } from './crypto.ts';
import type { Vault } from './model.ts';
import { decodeServerMessage, encodeHello, encodePush, pingFrame, type WireRecord } from './protocol.ts';

/** Wie in der App: zu große Datensätze würden den ganzen PUSH scheitern lassen. */
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_PER_PUSH = 500;
const RETRY_S = [1, 2, 5, 10, 30, 60];
const CHECK_MS = 10_000;
const PING_AFTER_MS = 20_000;
const DEAD_AFTER_MS = 45_000;

/** `https://host[/pfad]` → `wss://host[/pfad]/sync` (wie `SyncService.wsUri`). */
export function wsUrl(url: string): string {
  let s = url.trim();
  if (!s.includes('://')) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (!u.pathname.endsWith('/sync')) u.pathname = `${u.pathname.replace(/\/+$/, '')}/sync`;
  return u.toString();
}

/**
 * Hält die Verbindung zum Sync-Server: holt Änderungen nach, übernimmt
 * Live-Änderungen und lädt eigene (Start/Pause) hoch. Verbindet sich nach
 * Abbrüchen von selbst neu.
 */
export class SyncClient {
  /** Abgleich abgeschlossen, Verbindung steht. */
  connected = false;
  /** Die Synchronisation wurde auf einem anderen Gerät beendet. */
  deleted = false;
  /** Letzte Fehlermeldung des Servers. */
  error: string | null = null;

  readonly #url: string;
  readonly #crypto: SyncCrypto;
  readonly #vault: Vault;
  readonly #onChange: () => void;
  #ws: WebSocket | null = null;
  #gen = 0;
  #attempt = 0;
  #retry: NodeJS.Timeout | null = null;
  #check: NodeJS.Timeout | null = null;
  #lastRx = 0;
  #reqId = 0;
  #inflight: { reqId: number; sent: [string, number][] } | null = null;
  #stopped = true;

  constructor(url: string, crypto: SyncCrypto, vault: Vault, onChange: () => void) {
    this.#url = wsUrl(url);
    this.#crypto = crypto;
    this.#vault = vault;
    this.#onChange = onChange;
  }

  start(): void {
    this.#stopped = false;
    this.#check = setInterval(() => this.#alive(), CHECK_MS);
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#check) clearInterval(this.#check);
    if (this.#retry) clearTimeout(this.#retry);
    this.#close();
  }

  /** Nach einer lokalen Änderung aufrufen. */
  push(): void {
    const ws = this.#ws;
    if (!ws || !this.connected || this.#inflight) return;
    const records: { key: Uint8Array; data: Uint8Array }[] = [];
    const sent: [string, number][] = [];
    for (const name of this.#vault.pending()) {
      if (records.length >= MAX_PER_PUSH) break;
      const plain = Buffer.from(this.#vault.payload(name), 'utf8');
      if (plain.length + 28 > MAX_RECORD_BYTES) continue;
      const key = this.#crypto.recordKey(name);
      records.push({ key, data: this.#crypto.encrypt(plain, key) });
      sent.push([name, this.#vault.records.get(name)!.modified]);
    }
    if (records.length === 0) return;
    const reqId = ++this.#reqId;
    this.#inflight = { reqId, sent };
    ws.send(encodePush(reqId, records));
  }

  #connect(): void {
    if (this.#stopped || this.deleted) return;
    const gen = ++this.#gen;
    this.#close();
    this.#lastRx = Date.now();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.#url);
    } catch (e) {
      this.error = String(e);
      this.#scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    ws.onopen = () => {
      if (gen === this.#gen) ws.send(encodeHello(this.#crypto.vaultId, this.#vault.seq));
    };
    ws.onmessage = (ev) => {
      if (gen !== this.#gen || !(ev.data instanceof ArrayBuffer)) return;
      this.#lastRx = Date.now();
      try {
        this.#onFrame(new Uint8Array(ev.data));
      } catch (e) {
        console.error('Sync: Nachricht nicht verarbeitet:', e);
      }
    };
    ws.onerror = (ev) => {
      // Nur den ersten Fehlschlag melden, nicht jeden weiteren Versuch.
      if (gen === this.#gen && this.#attempt === 0) {
        console.error(`Sync: keine Verbindung zu ${this.#url}: ${(ev as ErrorEvent).message || 'Fehler'}`);
      }
    };
    ws.onclose = () => {
      if (gen !== this.#gen) return;
      this.#close();
      this.#onChange();
      this.#scheduleRetry();
    };
  }

  #close(): void {
    const ws = this.#ws;
    this.#ws = null;
    this.#inflight = null;
    this.connected = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // schon geschlossen
      }
    }
  }

  #scheduleRetry(): void {
    if (this.#stopped || this.deleted) return;
    const s = RETRY_S[Math.min(this.#attempt++, RETRY_S.length - 1)]!;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = setTimeout(() => this.#connect(), s * 1000 * (0.75 + Math.random() / 2));
  }

  /** Stille Verbindung erst anfragen (PING), dann neu aufbauen. */
  #alive(): void {
    const ws = this.#ws;
    if (!ws) return;
    const idle = Date.now() - this.#lastRx;
    if (idle > DEAD_AFTER_MS) {
      this.#close();
      this.#onChange();
      this.#connect();
    } else if (idle > PING_AFTER_MS && ws.readyState === WebSocket.OPEN) {
      ws.send(pingFrame);
    }
  }

  #onFrame(buf: Uint8Array): void {
    const msg = decodeServerMessage(buf);
    switch (msg.type) {
      case 'changes':
        if (this.#apply(msg.records)) this.#onChange();
        this.push();
        break;
      case 'synced':
        if (msg.epoch !== null && this.#vault.epoch !== null && msg.epoch !== this.#vault.epoch) {
          // Der Vault wurde neu angelegt, die Sequenznummern beginnen von
          // vorn: alles neu holen.
          this.#vault.resetRemote(msg.epoch);
          this.#onChange();
          this.#connect();
          return;
        }
        if (msg.epoch !== null) this.#vault.epoch = msg.epoch;
        this.#attempt = 0;
        this.error = null;
        this.connected = true;
        this.#onChange();
        this.push();
        break;
      case 'ack': {
        const inflight = this.#inflight;
        if (!inflight || inflight.reqId !== msg.reqId) return;
        this.#inflight = null;
        this.#vault.acked(inflight.sent);
        // Alle kleineren Sequenznummern hat der Server vor dem ACK zugestellt.
        this.#vault.seq = Math.max(this.#vault.seq, msg.firstSeq + inflight.sent.length - 1);
        this.#onChange();
        this.push();
        break;
      }
      case 'vaultDeleted':
        this.deleted = true;
        this.#gen++;
        this.#close();
        this.#vault.clear();
        this.#onChange();
        break;
      case 'error':
        this.error = msg.message;
        console.error(`Sync: Server meldet Fehler ${msg.code}: ${msg.message}`);
        break;
      case 'pong':
        break;
    }
  }

  #apply(records: WireRecord[]): boolean {
    let changed = false;
    for (const r of records) {
      try {
        const plain = this.#crypto.decrypt(r.data, r.key).toString('utf8');
        const j = JSON.parse(plain) as { k: unknown; m: unknown; v?: unknown };
        if (typeof j.k !== 'string' || typeof j.m !== 'number') throw new Error('Format');
        if (!this.#crypto.recordKey(j.k).equals(r.key)) throw new Error('Schlüssel');
        let content: string | null = null;
        if ('v' in j) {
          // Den Inhalt möglichst als Originaltext übernehmen (Zahlen wie 8.0
          // sähen neu kodiert anders aus).
          const head = `{"k":${JSON.stringify(j.k)},"m":${j.m},"v":`;
          content =
            plain.startsWith(head) && plain.endsWith('}')
              ? plain.slice(head.length, -1)
              : JSON.stringify(j.v);
        }
        if (this.#vault.applyRemote(j.k, j.m, content)) changed = true;
      } catch (e) {
        console.error(`Sync: Datensatz ${r.seq} übersprungen: ${e}`);
      }
      if (r.seq > this.#vault.seq) {
        this.#vault.seq = r.seq;
        changed = true;
      }
    }
    return changed;
  }
}
