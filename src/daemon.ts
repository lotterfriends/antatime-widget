import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { loadConfig, loadState, port, stateFile, writePrivate, type SyncConfig } from './config.ts';
import { SyncCrypto, decodeServerKey } from './crypto.ts';
import { Vault } from './model.ts';
import { render, type Format } from './render.ts';
import { SyncClient } from './sync.ts';
import { updateAvailable } from './update.ts';

/** So lange wartet `GET /state?rev=…` höchstens auf eine Änderung. */
const LONG_POLL_MS = 25_000;
const CONFIG_POLL_MS = 60_000;
/** Nach Updates sieht der Dienst kurz nach dem Start und danach zweimal am Tag. */
const UPDATE_FIRST_MS = 60_000;
const UPDATE_POLL_MS = 12 * 3_600_000;
const UPDATE_HINT = 'Update verfügbar – „antatime-widget update“ ausführen';

export interface View {
  /** Ändert sich mit jeder Änderung der Anzeige. */
  rev: number;
  configured: boolean;
  connected: boolean;
  running: boolean;
  /** Arbeitszeit heute, z. B. `6:12`. */
  text: string;
  /** `Arbeitszeit läuft`, `Pausiert`, … */
  status: string;
  /** `Derzeit: 1:02 (seit 13:05)`, `Pause: 0:20` oder `Bereit`. */
  current: string;
  /** `Heute: 6:12 von 8:00`. */
  today: string;
  /** Hinweis, z. B. wenn offline. */
  hint: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** „H:MM“ wie in der App (Minuten abgeschnitten). */
export function formatDuration(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class Daemon {
  readonly vault = new Vault();
  #config: SyncConfig | null = null;
  #client: SyncClient | null = null;
  #view: View;
  #waiters = new Set<() => void>();
  #saveTimer: NodeJS.Timeout | null = null;
  #dirty = false;
  #update = false;
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#view = { ...this.#compute(), rev: now() };
  }

  /** Zugangsdaten (neu) laden und die Verbindung bei Bedarf neu aufbauen. */
  reload(config: SyncConfig | null = loadConfig()): void {
    const old = this.#config;
    const same = old?.url === config?.url && old?.code === config?.code && old?.serverKey === config?.serverKey;
    if (same && !this.#client?.deleted) return;
    // Wurde der Sync beendet, bleibt das Widget aus, bis ein anderer Code
    // eingerichtet ist.
    if (this.#client?.deleted && old?.code === config?.code) return;
    this.#client?.stop();
    this.#client = null;
    this.#config = config;
    this.vault.clear();
    if (config) {
      const crypto = new SyncCrypto(config.code);
      const vaultId = crypto.vaultId.toString('hex');
      const state = loadState();
      if (state?.vault === vaultId) this.vault.load(state);
      // Unlesbarer Schlüssel: mit einem sicher falschen anmelden, damit die
      // Anzeige „Server-Schlüssel ist falsch“ meldet.
      const serverKey = config.serverKey === null ? null : (decodeServerKey(config.serverKey) ?? Buffer.alloc(32, 1));
      this.#client = new SyncClient(config.url, crypto, this.vault, () => this.#changed(), serverKey);
      this.#client.start();
    }
    this.#changed();
  }

  start(): void {
    this.reload();
    // Die Anzeige ändert sich auch ohne Ereignis (Minutenwechsel, Mitternacht).
    setInterval(() => this.#refresh(), 1000);
    // Sync später in der App eingerichtet oder geändert: übernehmen.
    setInterval(() => this.reload(), CONFIG_POLL_MS);
    if (process.env.ANTATIME_WIDGET_UPDATE_CHECK !== '0') {
      setTimeout(() => this.#checkUpdate(), UPDATE_FIRST_MS).unref();
      setInterval(() => this.#checkUpdate(), UPDATE_POLL_MS).unref();
    }
  }

  /** Hinweis auf ein bereitstehendes Update ein- oder ausblenden. */
  setUpdateAvailable(available: boolean): void {
    this.#update = available;
    this.#refresh();
  }

  #checkUpdate(): void {
    // Ohne Netz oder ohne Klon gibt es schlicht keinen Hinweis.
    updateAvailable(join(import.meta.dirname, '..')).then(
      (available) => this.setUpdateAvailable(available),
      () => {},
    );
  }

  stop(): void {
    this.#client?.stop();
    this.#save();
  }

  toggle(to?: boolean): void {
    if (!this.#client || this.#client.deleted) return;
    if (this.vault.toggle(this.#now(), to)) {
      this.#changed();
      this.#client.push();
    }
  }

  view(): View {
    this.#refresh();
    return this.#view;
  }

  /** Wartet, bis sich die Anzeige gegenüber `rev` ändert (höchstens `ms`). */
  async changedSince(rev: number, ms = LONG_POLL_MS): Promise<View> {
    if (this.view().rev === rev) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        this.#waiters.add(done);
      });
    }
    return this.#view;
  }

  #compute(): Omit<View, 'rev'> {
    const now = this.#now();
    const client = this.#client;
    if (!client || client.deleted) {
      return {
        configured: false,
        connected: false,
        running: false,
        text: '–:––',
        status: client?.deleted ? 'Synchronisation beendet' : 'Nicht eingerichtet',
        current: client?.deleted
          ? 'Die Synchronisation wurde auf einem anderen Gerät beendet.'
          : 'Synchronisation in der AnTaTime-App einrichten',
        today: 'oder „antatime-widget setup“ ausführen.',
        hint: this.#update ? UPDATE_HINT : null,
      };
    }
    const s = this.vault.today(now);
    let current = 'Bereit';
    if (s.since !== null) {
      current = `Derzeit: ${formatDuration(now - s.since)} (seit ${formatTime(s.since)})`;
    } else if (s.lastEnd !== null) {
      current = `Pause: ${formatDuration(now - s.lastEnd)}`;
    }
    const worked = formatDuration(s.workedMs);
    return {
      configured: true,
      connected: client.connected,
      running: s.running,
      text: worked,
      status: s.running ? 'Arbeitszeit läuft' : 'Pausiert',
      current,
      today: `Heute: ${worked} von ${formatDuration(s.targetMs)}`,
      // Probleme mit dem Sync gehen dem Hinweis auf ein Update vor.
      hint: client.connected
        ? this.#update
          ? UPDATE_HINT
          : null
        : client.problem
          ? client.problem
          : this.vault.pending().length > 0
          ? 'Offline – Änderungen werden später übertragen'
          : 'Offline – Stand evtl. nicht aktuell',
    };
  }

  #refresh(): void {
    const next = this.#compute();
    const prev = this.#view;
    if ((Object.keys(next) as (keyof typeof next)[]).every((k) => next[k] === prev[k])) return;
    this.#view = { ...next, rev: prev.rev + 1 };
    for (const w of [...this.#waiters]) w();
  }

  #changed(): void {
    this.#refresh();
    this.#dirty = true;
    this.#saveTimer ??= setTimeout(() => this.#save(), 300);
  }

  #save(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    if (!this.#dirty || !this.#config) return;
    this.#dirty = false;
    const vault = new SyncCrypto(this.#config.code).vaultId.toString('hex');
    try {
      writePrivate(stateFile, JSON.stringify({ vault, ...(this.vault.toJSON() as object) }));
    } catch (e) {
      console.error('Zustand nicht gespeichert:', e);
    }
  }

  /**
   * Lokale HTTP-Schnittstelle für die Widgets (nur 127.0.0.1):
   *
   *   GET  /state[?rev=N][&format=json|text|swiftbar|waybar|genmon]
   *   POST /start | /pause | /toggle | /reload
   */
  listen(p = port()): Promise<void> {
    const allowedHosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
    const server = createServer((req, res) => {
      this.#handle(req, res, p, allowedHosts).catch((e) => {
        console.error(e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => resolve());
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse, p: number, hosts: Set<string>): Promise<void> {
    // Webseiten im Browser dürfen die Zeiterfassung nicht steuern: Fremde
    // Seiten senden bei POST ein Origin, bei DNS-Rebinding einen fremden Host.
    const site = req.headers['sec-fetch-site'];
    if (
      !hosts.has(req.headers.host ?? '') ||
      req.headers.origin !== undefined ||
      (site !== undefined && site !== 'none' && site !== 'same-origin')
    ) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${p}`);
    const format = (url.searchParams.get('format') ?? 'json') as Format;
    let view: View;
    if (req.method === 'GET' && url.pathname === '/state') {
      const rev = url.searchParams.get('rev');
      view = rev === null ? this.view() : await this.changedSince(Number(rev));
    } else if (req.method === 'POST' && ['/start', '/pause', '/toggle'].includes(url.pathname)) {
      this.toggle(url.pathname === '/toggle' ? undefined : url.pathname === '/start');
      view = this.view();
    } else if (req.method === 'POST' && url.pathname === '/reload') {
      this.reload();
      view = this.view();
    } else {
      res.writeHead(404).end();
      return;
    }
    const body = render(view, format, p);
    res.writeHead(200, {
      'content-type': format === 'json' || format === 'waybar' ? 'application/json' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }
}
