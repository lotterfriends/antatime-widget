/**
 * Datenstand des Widgets: die synchronisierten Datensätze (wie
 * antatime-app/lib/sync/sync_records.dart) und was das Widget daraus braucht –
 * Start/Pause und die Arbeitszeit von heute.
 *
 *  * `s:<id>`   eine Arbeitszeit
 *  * `a:<id>`   eine Abwesenheit (wird nur durchgereicht)
 *  * `c:<feld>` eine Einstellung
 *
 * Inhalte bleiben als JSON-Text gespeichert, so wie sie vom Server kamen. Das
 * Widget ändert ausschließlich Arbeitszeiten.
 */

/** Kürzere Unterbrechungen gelten nicht als Pause (wie in der App). */
export const MIN_BREAK_MS = 60_000;

export interface Entry {
  /** JSON-Text; `null` = gelöscht. */
  content: string | null;
  /** Zeitstempel der Änderung (Hybrid-Uhr, ms) – neuester gewinnt. */
  modified: number;
  /** Lokale Änderung, die der Server noch nicht bestätigt hat. */
  pending: boolean;
}

export interface Session {
  id: string;
  start: number;
  /** `null` = läuft gerade. */
  end: number | null;
  json: Record<string, unknown>;
}

export interface TodayStats {
  running: boolean;
  /** Beginn der laufenden Arbeitszeit. */
  since: number | null;
  /** Letztes Ende heute (für „Pause: …“). */
  lastEnd: number | null;
  workedMs: number;
  targetMs: number;
}

function parseTime(utc: unknown, local: unknown): number | null {
  // `startUtc`/`endUtc` gehen vor; `start`/`end` sind Ortszeit ohne Zone.
  const s = typeof utc === 'string' ? utc : typeof local === 'string' ? local : null;
  if (s === null) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error('Ungültige Zeit');
  return t;
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

export function dayKey(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Ortszeit ohne Zone, wie Darts `toIso8601String()`. */
function localIso(ms: number): string {
  const d = new Date(ms);
  return (
    `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
}

function newId(now: number): string {
  // Wie in der App: Mikrosekunden und Zufall, jeweils zur Basis 36.
  return (now * 1000).toString(36) + Math.floor(Math.random() * 0x7fffffff).toString(36);
}

/** Felder in der Reihenfolge der App; unbekannte (neuere Version) bleiben. */
function sessionContent(json: Record<string, unknown>, start: number, end: number | null): string {
  const { id, start: _s, startUtc: _su, end: _e, endUtc: _eu, note, ...rest } = json;
  const out: Record<string, unknown> = {
    id,
    start: localIso(start),
    startUtc: new Date(start).toISOString(),
  };
  if (end !== null) {
    out.end = localIso(end);
    out.endUtc = new Date(end).toISOString();
  }
  if (typeof note === 'string' && note !== '') out.note = note;
  return JSON.stringify({ ...out, ...rest });
}

export class Vault {
  /** Höchste Sequenznummer des Servers, die vollständig übernommen ist. */
  seq = 0;
  /** Hybrid-Uhr: nie kleiner als ein bereits gesehener Zeitstempel. */
  clock = 0;
  /** Epoche des Vaults beim letzten Abgleich. */
  epoch: number | null = null;
  readonly records = new Map<string, Entry>();
  #sessions: Session[] | null = null;

  tick(now: number): number {
    this.clock = Math.max(now, this.clock + 1);
    return this.clock;
  }

  /**
   * Übernimmt einen Datensatz vom Server (Last-Writer-Wins nach
   * Zeitstempel). Gibt `true` zurück, wenn sich der Inhalt geändert hat.
   */
  applyRemote(name: string, modified: number, content: string | null): boolean {
    this.clock = Math.max(this.clock, modified);
    const local = this.records.get(name);
    if (local && local.modified > modified) {
      // Unser Stand ist neuer; der Server hat ihn überschrieben → erneut senden.
      local.pending = true;
      return false;
    }
    if (local && local.modified === modified) {
      const remote = content ?? '';
      const mine = local.content ?? '';
      if (remote === mine) {
        local.pending = false;
        return false;
      }
      // Gleicher Zeitstempel, anderer Inhalt: Der Inhalt entscheidet, damit
      // alle Geräte denselben Stand behalten.
      if (remote < mine) {
        local.pending = true;
        return false;
      }
    }
    this.records.set(name, { content, modified, pending: false });
    this.#sessions = null;
    return content !== (local?.content ?? null);
  }

  pending(): string[] {
    const out: string[] = [];
    for (const [name, e] of this.records) if (e.pending) out.push(name);
    return out;
  }

  /** Server hat `sent` (Name, Zeitstempel) gespeichert. */
  acked(sent: readonly (readonly [string, number])[]): void {
    for (const [name, modified] of sent) {
      const e = this.records.get(name);
      if (e && e.modified === modified) e.pending = false;
    }
  }

  /** Inhalt für den Server (wird anschließend verschlüsselt). */
  payload(name: string): string {
    const e = this.records.get(name);
    if (!e) throw new Error(`Unbekannter Datensatz ${name}`);
    const head = `{"k":${JSON.stringify(name)},"m":${e.modified}`;
    return e.content === null ? `${head}}` : `${head},"v":${e.content}}`;
  }

  /** Der Vault wurde auf dem Server neu angelegt: von vorn abgleichen. */
  resetRemote(epoch: number | null): void {
    this.seq = 0;
    this.epoch = epoch;
    // Das Widget hält keine eigenen Daten – nur noch nicht bestätigte
    // Änderungen bleiben und werden erneut hochgeladen.
    for (const [name, e] of this.records) if (!e.pending) this.records.delete(name);
    this.#sessions = null;
  }

  clear(): void {
    this.seq = 0;
    this.clock = 0;
    this.epoch = null;
    this.records.clear();
    this.#sessions = null;
  }

  /** Gültige Arbeitszeiten, nach Beginn sortiert. */
  sessions(): Session[] {
    if (this.#sessions) return this.#sessions;
    const out: Session[] = [];
    for (const [name, e] of this.records) {
      if (!name.startsWith('s:') || e.content === null) continue;
      try {
        const json = JSON.parse(e.content) as Record<string, unknown>;
        const start = parseTime(json.startUtc, json.start);
        if (json.id !== name.slice(2) || start === null) continue;
        out.push({ id: name.slice(2), start, end: parseTime(json.endUtc, json.end), json });
      } catch {
        // Unlesbare Datensätze (z. B. neuere App-Version) überspringen.
      }
    }
    out.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
    this.#sessions = out;
    return out;
  }

  #setSession(s: Session, start: number, end: number | null, now: number): void {
    this.records.set(`s:${s.id}`, {
      content: sessionContent(s.json, start, end),
      modified: this.tick(now),
      pending: true,
    });
    this.#sessions = null;
  }

  /**
   * Start/Pause wie `Repository.toggle` in der App. Mit `to` nur, falls
   * nötig (`true` = starten, `false` = pausieren). Gibt zurück, ob etwas
   * geändert wurde.
   */
  toggle(now: number, to?: boolean): boolean {
    const sessions = this.sessions();
    const running = sessions.filter((s) => s.end === null);
    const isRunning = running.length > 0;
    if (to !== undefined && to === isRunning) return false;
    if (isRunning) {
      // Mehrere laufende gibt es nur kurz nach einem doppelten Start auf
      // zwei Geräten; „Pause“ beendet dann alle.
      for (const s of running) this.#setSession(s, s.start, Math.max(now, s.start), now);
      return true;
    }
    // Pausen unter einer Minute ignorieren: den zuletzt beendeten Abschnitt
    // fortsetzen statt einen neuen zu beginnen.
    let last: Session | null = null;
    for (const s of sessions) if (!last || s.end! > last.end!) last = s;
    if (last) {
      const gap = now - last.end!;
      if (gap >= 0 && gap < MIN_BREAK_MS) {
        this.#setSession(last, last.start, null, now);
        return true;
      }
    }
    const id = newId(now);
    this.#setSession({ id, start: now, end: null, json: { id } }, now, null, now);
    return true;
  }

  #setting(field: string): unknown {
    const c = this.records.get(`c:${field}`)?.content;
    if (c == null) return undefined;
    try {
      return JSON.parse(c);
    } catch {
      return undefined;
    }
  }

  /** Soll-Zeit des Tages wie `BalanceCalculator.targetFor` in der App. */
  targetMs(day: Date): number {
    let values: Record<string, unknown> = {
      dailyHours: this.#setting('dailyHours'),
      workdays: this.#setting('workdays'),
      halfHolidays: this.#setting('halfHolidays'),
    };
    // Frühere Einstellungen gelten für alle Tage bis einschließlich `until`.
    const periods = this.#setting('periods');
    if (Array.isArray(periods)) {
      const key = dayKey(day);
      const p = periods
        .filter((x) => x && typeof x.until === 'string' && x.values && typeof x.values === 'object')
        .sort((a, b) => (a.until < b.until ? -1 : 1))
        .find((x) => key <= x.until);
      if (p) values = { ...values, ...p.values };
    }
    const dailyHours = typeof values.dailyHours === 'number' ? values.dailyHours : 8;
    const workdays = Array.isArray(values.workdays) ? values.workdays : [1, 2, 3, 4, 5];
    const halfHolidays = typeof values.halfHolidays === 'boolean' ? values.halfHolidays : true;
    // 1 = Montag … 7 = Sonntag.
    if (!workdays.includes(((day.getDay() + 6) % 7) + 1)) return 0;
    const minutes = Math.round(dailyHours * 60);
    // Heiligabend und Silvester sind halbe Arbeitstage.
    const half = halfHolidays && day.getMonth() === 11 && (day.getDate() === 24 || day.getDate() === 31);
    return (half ? Math.floor(minutes / 2) : minutes) * 60_000;
  }

  /** Arbeitszeit von heute (nur der Anteil des Tages, bis `now`). */
  today(now: number): TodayStats {
    const d = new Date(now);
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    let since: number | null = null;
    let lastEnd: number | null = null;
    let workedMs = 0;
    // Überschneidungen (doppelter Start auf zwei Geräten) nicht doppelt zählen.
    let covered = from;
    for (const s of this.sessions()) {
      if (s.end === null && since === null) since = s.start;
      if (s.end !== null && s.end >= from && s.end <= now && (lastEnd === null || s.end > lastEnd)) {
        lastEnd = s.end;
      }
      const start = Math.max(s.start, covered);
      const end = Math.min(s.end ?? now, to);
      if (end > start) {
        workedMs += end - start;
        covered = end;
      }
    }
    return { running: since !== null, since, lastEnd, workedMs, targetMs: this.targetMs(d) };
  }

  toJSON(): unknown {
    const records: Record<string, unknown[]> = {};
    for (const [name, e] of this.records) {
      records[name] = e.pending ? [e.content, e.modified, 1] : [e.content, e.modified];
    }
    return { seq: this.seq, clock: this.clock, epoch: this.epoch, records };
  }

  load(j: Record<string, unknown>): void {
    this.clear();
    this.seq = Number(j.seq) || 0;
    this.clock = Number(j.clock) || 0;
    this.epoch = typeof j.epoch === 'number' ? j.epoch : null;
    for (const [name, v] of Object.entries((j.records ?? {}) as Record<string, unknown[]>)) {
      this.records.set(name, {
        content: typeof v[0] === 'string' ? v[0] : null,
        modified: Number(v[1]) || 0,
        pending: v.length > 2,
      });
    }
  }
}
