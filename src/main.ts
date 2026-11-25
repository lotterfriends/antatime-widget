#!/usr/bin/env node
import { request } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { configFile, loadConfig, port, saveConfig } from './config.ts';
import { normalizeCode } from './crypto.ts';
import { Daemon, type View } from './daemon.ts';
import { wsUrl } from './sync.ts';

const HELP = `AnTaTime-Widget – Zeiterfassung in der Kontrollleiste

  antatime-widget daemon     Dienst starten (macht sonst systemd/launchd)
  antatime-widget status     aktuellen Stand anzeigen
  antatime-widget start      Zeiterfassung starten
  antatime-widget pause      Zeiterfassung pausieren
  antatime-widget toggle     Start/Pause umschalten
  antatime-widget setup      Server und Sync-Code von Hand eintragen
                             (nur nötig ohne AnTaTime-Desktop-App mit Sync)
`;

function call(method: 'GET' | 'POST', path: string): Promise<View> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: port(), path, method, timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
          resolve(JSON.parse(body) as View);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
    req.end();
  });
}

function print(v: View): void {
  console.log([`${v.status} – ${v.text}`, v.current, v.today, ...(v.hint ? [v.hint] : [])].join('\n'));
}

async function setup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const url = (await rl.question('Sync-Server (z. B. https://antatime.de): ')).trim();
    wsUrl(url); // wirft bei ungültiger Adresse
    if (url === '') throw new Error('Kein Server angegeben.');
    // Der Code steht in der App unter Einstellungen → Synchronisation.
    const code = normalizeCode(await rl.question('Sync-Code: '));
    if (!code) throw new Error('Das ist kein gültiger Sync-Code (25 Zeichen).');
    saveConfig(url, code);
    console.log(`Gespeichert in ${configFile}`);
  } finally {
    rl.close();
  }
  await call('POST', '/reload').then(
    () => console.log('Der Dienst verwendet die neuen Zugangsdaten.'),
    () => console.log('Der Dienst läuft nicht – er übernimmt die Zugangsdaten beim nächsten Start.'),
  );
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';
  switch (cmd) {
    case 'daemon': {
      const daemon = new Daemon();
      await daemon.listen();
      daemon.start();
      const cfg = loadConfig();
      console.log(
        `AnTaTime-Widget läuft auf http://127.0.0.1:${port()} – ` +
          (cfg ? `Sync mit ${cfg.url} (${cfg.source === 'app' ? 'aus der Desktop-App' : configFile})` : 'Sync nicht eingerichtet'),
      );
      const quit = () => {
        daemon.stop();
        process.exit(0);
      };
      process.on('SIGINT', quit);
      process.on('SIGTERM', quit);
      return;
    }
    case 'status':
      return print(await call('GET', '/state'));
    case 'start':
    case 'pause':
    case 'toggle':
      return print(await call('POST', `/${cmd}`));
    case 'setup':
      return setup();
    default:
      console.log(HELP);
  }
}

main().catch((e: NodeJS.ErrnoException) => {
  if (e.code === 'ECONNREFUSED') {
    console.error('Der AnTaTime-Widget-Dienst läuft nicht (antatime-widget daemon).');
  } else if (e.code === 'EADDRINUSE') {
    console.error(`Port ${port()} ist belegt – läuft der Dienst schon? (ANTATIME_WIDGET_PORT ändert den Port)`);
  } else {
    console.error(e.message || e);
  }
  process.exit(1);
});
