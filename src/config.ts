import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeCode } from './crypto.ts';

export const DEFAULT_PORT = 47821;
const APP_ID = 'com.lotterfriends.antatime';

export function port(): number {
  const p = Number(process.env.ANTATIME_WIDGET_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
}

const home = homedir();
const configDir = join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'antatime-widget');
const stateDir = join(process.env.XDG_STATE_HOME || join(home, '.local', 'state'), 'antatime-widget');

export const configFile = join(configDir, 'config.json');
export const stateFile = join(stateDir, 'state.json');

export interface SyncConfig {
  url: string;
  code: string;
  /** Server-Schlüssel, wenn der Server eine Anmeldung verlangt (sonst `null`). */
  serverKey: string | null;
  /** Woher die Zugangsdaten stammen (für `status`). */
  source: 'config' | 'app';
}

function valid(j: unknown, source: SyncConfig['source']): SyncConfig | null {
  if (!j || typeof j !== 'object') return null;
  const { url, code, serverKey } = j as Record<string, unknown>;
  if (typeof url !== 'string' || url.trim() === '' || typeof code !== 'string') return null;
  const c = normalizeCode(code);
  const key = typeof serverKey === 'string' && serverKey.trim() !== '' ? serverKey.trim() : null;
  // Ein unlesbarer Schlüssel bleibt stehen: Die Anmeldung scheitert dann mit
  // einer Meldung, statt dass das Widget still ohne Schlüssel verbindet.
  return c ? { url: url.trim(), code: c, serverKey: key, source } : null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Sync-Zustand der installierten Desktop-App (Schlüssel `sync`), falls vorhanden. */
function appSyncState(): unknown {
  const parse = (s: unknown) => {
    try {
      return typeof s === 'string' ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  };
  if (process.platform === 'darwin') {
    // NSUserDefaults der App (mit und ohne Sandbox).
    for (const plist of [
      join(home, 'Library/Containers', APP_ID, 'Data/Library/Preferences', `${APP_ID}.plist`),
      join(home, 'Library/Preferences', `${APP_ID}.plist`),
    ]) {
      for (const key of ['sync', 'flutter.sync']) {
        try {
          const out = execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          const j = parse(out.trim());
          if (j) return j;
        } catch {
          // Datei oder Schlüssel fehlt
        }
      }
    }
    return null;
  }
  const dataHome = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
  const prefs = readJson(join(dataHome, APP_ID, 'shared_preferences.json')) as Record<string, unknown> | null;
  return parse(prefs?.sync ?? prefs?.['flutter.sync']);
}

/**
 * Zugangsdaten für den Sync: die eigene Konfiguration (`antatime-widget
 * setup`) oder sonst die der Desktop-App auf diesem Rechner.
 */
export function loadConfig(): SyncConfig | null {
  return valid(readJson(configFile), 'config') ?? valid(appSyncState(), 'app');
}

/** Schreibt atomar und nur für den Nutzer lesbar (enthält den Sync-Code). */
export function writePrivate(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

export function saveConfig(url: string, code: string, serverKey: string | null = null): void {
  writePrivate(configFile, `${JSON.stringify({ url, code, ...(serverKey ? { serverKey } : {}) }, null, 2)}\n`);
}

export function loadState(): Record<string, unknown> | null {
  const j = readJson(stateFile);
  return j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
}
