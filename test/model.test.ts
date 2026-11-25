import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vault } from '../src/model.ts';

const at = (h: number, m = 0, s = 0) => new Date(2026, 10, 25, h, m, s).getTime(); // Mittwoch

function session(v: Vault, id: string, start: number, end: number | null, modified = 1): void {
  const json: Record<string, unknown> = { id, start: 'x', startUtc: new Date(start).toISOString() };
  if (end !== null) json.endUtc = new Date(end).toISOString();
  v.applyRemote(`s:${id}`, modified, JSON.stringify(json));
}

test('Start legt eine laufende Arbeitszeit im Format der App an', () => {
  const v = new Vault();
  assert.equal(v.toggle(at(8)), true);
  const [name] = v.pending();
  const j = JSON.parse(v.records.get(name!)!.content!);
  assert.deepEqual(Object.keys(j), ['id', 'start', 'startUtc']);
  assert.equal(j.start, '2026-11-25T08:00:00.000');
  assert.equal(j.startUtc, new Date(at(8)).toISOString());
  assert.equal(`s:${j.id}`, name);
  assert.equal(v.today(at(9)).running, true);
  assert.equal(v.today(at(9)).workedMs, 3_600_000);
});

test('Pause beendet, Start nach kurzer Unterbrechung setzt fort', () => {
  const v = new Vault();
  v.toggle(at(8));
  v.toggle(at(9));
  assert.equal(v.today(at(9, 0, 30)).running, false);
  v.toggle(at(9, 0, 30)); // unter einer Minute: derselbe Abschnitt läuft weiter
  assert.equal(v.sessions().length, 1);
  assert.equal(v.sessions()[0]!.end, null);
  v.toggle(at(10));
  v.toggle(at(10, 30)); // echte Pause: neuer Abschnitt
  assert.equal(v.sessions().length, 2);
  const s = v.today(at(11));
  assert.equal(s.workedMs, 2.5 * 3_600_000);
  assert.equal(s.since, at(10, 30));
});

test('start/pause ändern nichts, wenn der Zustand schon stimmt', () => {
  const v = new Vault();
  assert.equal(v.toggle(at(8), false), false);
  assert.equal(v.toggle(at(8), true), true);
  assert.equal(v.toggle(at(8, 5), true), false);
  assert.equal(v.sessions().length, 1);
});

test('Notiz und unbekannte Felder bleiben beim Pausieren erhalten', () => {
  const v = new Vault();
  v.applyRemote('s:a', 5, JSON.stringify({ id: 'a', start: '2026-11-25T08:00:00.000', note: 'Büro', neu: 1 }));
  v.toggle(at(9));
  const j = JSON.parse(v.records.get('s:a')!.content!);
  assert.deepEqual(Object.keys(j), ['id', 'start', 'startUtc', 'end', 'endUtc', 'note', 'neu']);
  assert.equal(j.end, '2026-11-25T09:00:00.000');
  assert.equal(v.records.get('s:a')!.modified, at(9));
});

test('Zeiten mit Mikrosekunden (native App) werden gelesen', () => {
  const v = new Vault();
  v.applyRemote('s:a', 1, '{"id":"a","start":"2026-11-25T08:00:00.123456","startUtc":"2026-11-25T07:00:00.123456Z"}');
  assert.equal(v.sessions()[0]!.start, Date.parse('2026-11-25T07:00:00.123Z'));
});

test('Heute zählt nur der Anteil des Tages, Überschneidungen einmal', () => {
  const v = new Vault();
  session(v, 'a', new Date(2026, 10, 24, 22).getTime(), at(1)); // über Mitternacht
  session(v, 'b', at(8), at(10));
  session(v, 'c', at(9), null); // doppelter Start
  const s = v.today(at(11));
  assert.equal(s.workedMs, 4 * 3_600_000);
  assert.equal(s.lastEnd, at(10));
});

test('Soll: Arbeitstage, halbe Feiertage und frühere Zeiträume', () => {
  const v = new Vault();
  assert.equal(v.targetMs(new Date(2026, 10, 25)), 8 * 3_600_000);
  assert.equal(v.targetMs(new Date(2026, 10, 28)), 0); // Samstag
  assert.equal(v.targetMs(new Date(2026, 11, 24)), 4 * 3_600_000);
  v.applyRemote('c:dailyHours', 1, '7.5');
  v.applyRemote('c:workdays', 1, '[1,2,3,4]');
  v.applyRemote('c:periods', 1, '[{"until":"2026-10-31","values":{"dailyHours":8.0,"workdays":[1,2,3,4,5]}}]');
  assert.equal(v.targetMs(new Date(2026, 10, 25)), 7.5 * 3_600_000);
  assert.equal(v.targetMs(new Date(2026, 10, 27)), 0); // Freitag, neu frei
  assert.equal(v.targetMs(new Date(2026, 9, 30)), 8 * 3_600_000); // Freitag im alten Zeitraum
});

test('Last-Writer-Wins: ältere Stände vom Server verlieren', () => {
  const v = new Vault();
  v.toggle(at(8));
  const [name] = v.pending();
  v.acked([[name!, at(8)]]);
  assert.deepEqual(v.pending(), []);
  assert.equal(v.applyRemote(name!, at(8) - 1, null), false);
  assert.deepEqual(v.pending(), [name]); // erneut senden
  assert.equal(v.applyRemote(name!, at(8) + 1, null), true);
  assert.equal(v.sessions().length, 0);
  assert.equal(v.payload(name!), `{"k":"${name}","m":${at(8) + 1}}`);
});

test('Zustand übersteht Speichern und Laden', () => {
  const v = new Vault();
  v.applyRemote('c:dailyHours', 7, '8.0');
  v.toggle(at(8));
  v.seq = 42;
  v.epoch = 9;
  const w = new Vault();
  w.load(JSON.parse(JSON.stringify(v.toJSON())));
  assert.deepEqual(w.toJSON(), v.toJSON());
  assert.equal(w.records.get('c:dailyHours')!.content, '8.0');
  assert.equal(w.pending().length, 1);
});
