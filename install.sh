#!/usr/bin/env bash
# Installiert das AnTaTime-Widget für den aktuellen Nutzer:
#   - den Dienst nach ~/.local/share/antatime-widget (Start bei der Anmeldung
#     über systemd bzw. launchd) und den Befehl ~/.local/bin/antatime-widget
#   - das Leisten-Widget der vorhandenen Oberfläche (KDE Plasma, GNOME,
#     SwiftBar unter macOS)
# Erneut ausführen aktualisiert. Entfernen: ./uninstall.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local}"
APP_DIR="$PREFIX/share/antatime-widget"
BIN="$PREFIX/bin/antatime-widget"
LABEL=de.antatime.widget
GNOME_UUID=antatime-widget@lotterfriends.github.io

# Node ≥ 22.18 führt TypeScript direkt aus. Eigenes Binary: NODE=/pfad/zu/node
node_ok() {
  [[ -x "$1" ]] && "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null
}
find_node() {
  local n
  for n in "${NODE:-}" "$(command -v node || true)" \
    $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV) \
    /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [[ -n "$n" ]] && node_ok "$n"; then
      echo "$n"
      return
    fi
  done
  return 1
}
NODE_BIN="$(find_node)" || {
  echo "Node.js ab Version 22.18 nicht gefunden (https://nodejs.org) – oder NODE=/pfad/zu/node setzen." >&2
  exit 1
}
echo "Node: $NODE_BIN ($("$NODE_BIN" --version))"

# --- Dienst -------------------------------------------------------------------
rm -rf "$APP_DIR/src"
mkdir -p "$APP_DIR" "$(dirname "$BIN")"
cp -r "$ROOT/src" "$ROOT/package.json" "$APP_DIR/"
cat > "$BIN" <<EOF
#!/bin/sh
exec "$NODE_BIN" --disable-warning=ExperimentalWarning "$APP_DIR/src/main.ts" "\$@"
EOF
chmod +x "$BIN"
echo "Befehl: $BIN"

if [[ "$(uname)" == Darwin ]]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$(dirname "$PLIST")" "$HOME/Library/Logs"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BIN</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/antatime-widget.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/antatime-widget.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Dienst: launchd ($LABEL), Protokoll in ~/Library/Logs/antatime-widget.log"

  PLUGINS="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)"
  if [[ -n "$PLUGINS" && -d "$PLUGINS" ]]; then
    cp "$ROOT/macos/antatime.5s.sh" "$PLUGINS/"
    chmod +x "$PLUGINS/antatime.5s.sh"
    echo "Menüleiste: SwiftBar-Plugin nach $PLUGINS kopiert"
  else
    echo "Menüleiste: SwiftBar installieren (brew install swiftbar), einen Plugin-Ordner wählen"
    echo "            und $ROOT/macos/antatime.5s.sh hineinkopieren (oder ./install.sh erneut ausführen)."
  fi
else
  UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/antatime-widget.service"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=AnTaTime-Widget (Zeiterfassung in der Kontrollleiste)

[Service]
ExecStart="$BIN" daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --quiet antatime-widget.service
  systemctl --user restart antatime-widget.service
  echo "Dienst: systemd (systemctl --user status antatime-widget)"

  if command -v kpackagetool6 >/dev/null 2>&1; then
    kpackagetool6 -t Plasma/Applet -u "$ROOT/plasma/package" >/dev/null 2>&1 ||
      kpackagetool6 -t Plasma/Applet -i "$ROOT/plasma/package" >/dev/null 2>&1
    echo "KDE Plasma: Widget „AnTaTime“ installiert – Rechtsklick auf die Kontrollleiste →"
    echo "            „Miniprogramme hinzufügen …“ → AnTaTime in die Leiste ziehen."
  fi
  if command -v gnome-shell >/dev/null 2>&1; then
    EXT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$GNOME_UUID"
    rm -rf "$EXT"
    mkdir -p "$EXT"
    cp "$ROOT/gnome/$GNOME_UUID/"* "$EXT/"
    echo "GNOME: Erweiterung installiert – ab- und wieder anmelden, dann:"
    echo "       gnome-extensions enable $GNOME_UUID"
  fi
fi

sleep 1
"$BIN" status || true
