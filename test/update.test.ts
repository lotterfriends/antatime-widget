import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Daemon } from '../src/daemon.ts';
import { findSource, update, updateAvailable } from '../src/update.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function commit(repo: string, version: string): void {
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version }));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', version);
}

/**
 * Ein „veröffentlichtes“ Repository, ein Klon davon und eine Installation aus
 * dem Klon. Das install.sh des Repositorys verhält sich wie das echte, soweit
 * es update betrifft: package.json kopieren, Herkunft und Commit merken.
 */
function setup(t: TestContext): { upstream: string; clone: string; app: string; prefix: string } {
  const dir = mkdtempSync(join(tmpdir(), 'antatime-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const upstream = join(dir, 'upstream');
  const clone = join(dir, 'clone');
  const prefix = join(dir, 'prefix');
  const app = join(prefix, 'share', 'antatime-widget');

  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  writeFileSync(
    join(upstream, 'install.sh'),
    [
      '#!/bin/sh',
      'ROOT="$(cd "$(dirname "$0")" && pwd)"',
      'APP="$PREFIX/share/antatime-widget"',
      'mkdir -p "$APP"',
      'cp "$ROOT/package.json" "$APP/"',
      'printf \'%s\\n%s\\n\' "$ROOT" "$(git -C "$ROOT" rev-parse HEAD)" > "$APP/source"',
      '',
    ].join('\n'),
  );
  chmodSync(join(upstream, 'install.sh'), 0o755);
  commit(upstream, '1.0.0');
  git(dir, 'clone', '-q', upstream, clone);
  execFileSync(join(clone, 'install.sh'), { env: { ...process.env, PREFIX: prefix } });
  return { upstream, clone, app, prefix };
}

const installed = (app: string): string =>
  (JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { version: string }).version;

test('findSource: Installation kennt Klon, Commit und PREFIX', (t) => {
  const { clone, app, prefix } = setup(t);
  assert.deepEqual(findSource(app), { root: clone, commit: git(clone, 'rev-parse', 'HEAD'), prefix });
});

test('findSource: direkt aus dem Klon gestartet', (t) => {
  const { clone } = setup(t);
  assert.deepEqual(findSource(clone), { root: clone, commit: '', prefix: null });
});

test('findSource: Installation ohne Herkunft und verschwundener Klon', (t) => {
  const { clone, app } = setup(t);
  rmSync(clone, { recursive: true });
  assert.throws(() => findSource(app), /fehlt/);
  rmSync(join(app, 'source'));
  assert.throws(() => findSource(app), /Unbekannt/);
});

test('update: ohne neuen Stand passiert nichts', async (t) => {
  const { app } = setup(t);
  const out: string[] = [];
  assert.equal(await update(app, true, (l) => out.push(l)), false);
  assert.equal(await update(app, false, (l) => out.push(l)), false);
  assert.match(out.join('\n'), /aktuell \(Version 1\.0\.0\)/);
});

test('update: --check meldet den neuen Stand, update installiert ihn', async (t) => {
  const { upstream, clone, app } = setup(t);
  commit(upstream, '1.1.0');
  const out: string[] = [];
  const log = (l: string) => out.push(l);

  assert.equal(await update(app, true, log), true);
  assert.equal(installed(app), '1.0.0', '--check installiert nichts');

  assert.equal(await update(app, false, log), true);
  assert.equal(installed(app), '1.1.0');
  assert.equal(findSource(app).commit, git(clone, 'rev-parse', 'HEAD'));
  assert.equal(await update(app, true, log), false);
});

test('update: Klon ist schon neuer als die Installation', async (t) => {
  const { upstream, clone, app } = setup(t);
  commit(upstream, '1.1.0');
  git(clone, 'pull', '-q');
  assert.equal(await update(app, true, () => {}), true);
  assert.equal(await update(app, false, () => {}), true);
  assert.equal(installed(app), '1.1.0');
});

test('update: lokale Commits im Klon brechen ab, statt zu überschreiben', async (t) => {
  const { upstream, clone, app } = setup(t);
  commit(upstream, '1.1.0');
  commit(clone, '1.0.1-lokal');
  await assert.rejects(update(app, false, () => {}), /git pull/);
  assert.equal(installed(app), '1.0.0');
  assert.ok(existsSync(join(app, 'source')));
});

test('updateAvailable: ohne Klon ein Fehler, sonst der Stand', async (t) => {
  const { upstream, clone, app } = setup(t);
  assert.equal(await updateAvailable(app), false);
  commit(upstream, '1.1.0');
  assert.equal(await updateAvailable(app), true);
  rmSync(clone, { recursive: true });
  await assert.rejects(updateAvailable(app), /fehlt/);
});

test('Dienst: Hinweis auf ein Update ändert die Anzeige', () => {
  const daemon = new Daemon(() => 1_800_000_000_000);
  const before = daemon.view();
  assert.equal(before.hint, null);
  daemon.setUpdateAvailable(true);
  const after = daemon.view();
  assert.match(after.hint ?? '', /antatime-widget update/);
  assert.equal(after.rev, before.rev + 1);
  daemon.setUpdateAvailable(false);
  assert.equal(daemon.view().hint, null);
});
