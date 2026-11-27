/**
 * Aktualisierung aus dem Git-Klon, aus dem installiert wurde: neuen Stand
 * holen und dessen install.sh ausführen. install.sh merkt sich dafür in der
 * Datei `source` neben dem installierten Quelltext den Ordner des Klons und
 * den installierten Commit.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
/** Auch ohne Netz soll weder der Befehl noch der Dienst ewig auf git warten. */
const GIT_TIMEOUT_MS = 60_000;

export interface Source {
  /** Ordner des Klons. */
  root: string;
  /** Installierter Commit; leer, wenn unbekannt. */
  commit: string;
  /** PREFIX der Installation; null, wenn direkt aus dem Klon gestartet. */
  prefix: string | null;
}

async function git(root: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      // Der Dienst hat kein Terminal: nie nach Zugangsdaten fragen.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') throw new Error('git wurde nicht gefunden.');
    throw new Error(`„git ${args[0]}“ in ${root} ist fehlgeschlagen:\n${(err.stderr ?? '').trim() || err.message}`);
  }
}

/** `appDir` ist der Ordner über `src/` – die Installation oder der Klon selbst. */
export function findSource(appDir: string): Source {
  if (existsSync(join(appDir, 'install.sh'))) return { root: appDir, commit: '', prefix: null };
  let lines: string[];
  try {
    lines = readFileSync(join(appDir, 'source'), 'utf8').split('\n');
  } catch {
    throw new Error(
      'Unbekannt, aus welchem Ordner installiert wurde – dort einmal „git pull && ./install.sh“ ausführen, danach genügt „antatime-widget update“.',
    );
  }
  const root = lines[0] ?? '';
  if (root === '' || !existsSync(join(root, 'install.sh'))) {
    throw new Error(
      `Der Ordner, aus dem installiert wurde, fehlt (${root}) – das Repository neu klonen und dort ./install.sh ausführen.`,
    );
  }
  // Installiert wird nach PREFIX/share/antatime-widget.
  return { root, commit: lines[1] ?? '', prefix: dirname(dirname(appDir)) };
}

function version(dir: string): string {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '?';
  }
}

function clone(appDir: string): Source {
  const src = findSource(appDir);
  if (!existsSync(join(src.root, '.git'))) {
    throw new Error(`${src.root} ist kein Git-Klon – das Repository neu klonen und dort ./install.sh ausführen.`);
  }
  return src;
}

/** Sieht nach, ob ein neuerer Stand bereitsteht als der installierte. */
export async function updateAvailable(appDir: string): Promise<boolean> {
  const src = clone(appDir);
  await git(src.root, 'fetch', '--quiet');
  const behind = Number(await git(src.root, 'rev-list', '--count', 'HEAD..@{upstream}'));
  return behind > 0 || (await git(src.root, 'rev-parse', 'HEAD')) !== src.commit;
}

/**
 * Holt den neuen Stand und installiert ihn; mit `check` wird nur nachgesehen.
 * Liefert, ob ein Update installiert wurde bzw. (mit `check`) bereitsteht.
 */
export async function update(
  appDir: string,
  check: boolean,
  log: (line: string) => void = console.log,
): Promise<boolean> {
  const current = `AnTaTime-Widget ist aktuell (Version ${version(appDir)}).`;
  if (check) {
    const pending = await updateAvailable(appDir);
    log(pending ? 'Ein Update steht bereit – „antatime-widget update“ installiert es.' : current);
    return pending;
  }
  const src = clone(appDir);
  await git(src.root, 'pull', '--ff-only', '--quiet');
  if ((await git(src.root, 'rev-parse', 'HEAD')) === src.commit) {
    log(current);
    return false;
  }
  log(`Installiere Version ${version(src.root)} aus ${src.root} …`);
  // install.sh ersetzt den Quelltext, aus dem dieser Prozess läuft, und startet
  // den Dienst neu – hiernach also nichts mehr nachladen.
  const res = spawnSync(join(src.root, 'install.sh'), {
    stdio: 'inherit',
    env: { ...process.env, ...(src.prefix ? { PREFIX: src.prefix } : {}) },
  });
  if (res.status !== 0) throw new Error('install.sh ist fehlgeschlagen.');
  return true;
}
