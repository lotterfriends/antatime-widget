import type { View } from './daemon.ts';

export type Format = 'json' | 'text' | 'swiftbar' | 'waybar' | 'genmon';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Ausgabe für Leisten, die ein Skript abfragen (statt eines eigenen Widgets). */
export function render(v: View, format: Format, port: number): string {
  const base = `http://127.0.0.1:${port}`;
  const symbol = v.running ? '▶' : '⏸';
  const lines = [v.status, v.current, v.today, ...(v.hint ? [v.hint] : [])];
  switch (format) {
    case 'text':
      return `${symbol} ${v.text}\n`;
    case 'swiftbar': {
      // SwiftBar/xbar (macOS): erste Zeile = Menüleiste, danach das Menü.
      const action = (label: string, path: string) =>
        `${label} | bash=/usr/bin/curl param1=-fsS param2=-o param3=/dev/null param4=-X param5=POST ` +
        `param6=${base}${path} terminal=false refresh=true`;
      return [
        `${symbol} ${v.text} | font=Menlo`,
        '---',
        ...lines,
        ...(v.configured ? ['---', v.running ? action('Pause', '/pause') : action('Start', '/start')] : []),
        '',
      ].join('\n');
    }
    case 'waybar':
      return `${JSON.stringify({
        text: `${symbol} ${v.text}`,
        tooltip: lines.join('\n'),
        class: !v.configured ? 'unconfigured' : v.running ? 'running' : 'paused',
      })}\n`;
    case 'genmon':
      // Xfce „Generic Monitor“: Klick schaltet um.
      return [
        `<txt>${xml(`${symbol} ${v.text}`)}</txt>`,
        `<tool>${xml(lines.join('\n'))}</tool>`,
        `<txtclick>curl -fsS -o /dev/null -X POST ${base}/toggle</txtclick>`,
        '',
      ].join('\n');
    default:
      return `${JSON.stringify(v)}\n`;
  }
}
