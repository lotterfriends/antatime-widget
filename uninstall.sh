#!/usr/bin/env bash
# Entfernt das AnTaTime-Widget wieder (Dienst, Befehl, Leisten-Widgets).
# Die Daten der Zeiterfassung liegen in der App bzw. auf dem Sync-Server und
# bleiben unberührt.
set -uo pipefail

PREFIX="${PREFIX:-$HOME/.local}"
LABEL=de.antatime.widget
GNOME_UUID=antatime-widget@lotterfriends.github.io

if [[ "$(uname)" == Darwin ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
  PLUGINS="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null)"
  [[ -n "$PLUGINS" ]] && rm -f "$PLUGINS/antatime.5s.sh"
else
  systemctl --user disable --now --quiet antatime-widget.service 2>/dev/null
  rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/antatime-widget.service"
  systemctl --user daemon-reload 2>/dev/null
  command -v kpackagetool6 >/dev/null 2>&1 && kpackagetool6 -t Plasma/Applet -r de.antatime.widget >/dev/null 2>&1
  rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$GNOME_UUID"
fi
rm -rf "$PREFIX/share/antatime-widget" "$PREFIX/bin/antatime-widget"
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/antatime-widget" "${XDG_CONFIG_HOME:-$HOME/.config}/antatime-widget"
echo "AnTaTime-Widget entfernt."
