#!/bin/bash
# <xbar.title>AnTaTime</xbar.title>
# <xbar.version>v1.1.0</xbar.version>
# <xbar.author>Andre Tarnowsky</xbar.author>
# <xbar.desc>Zeiterfassung starten und pausieren, mit der Arbeitszeit von heute.</xbar.desc>
# <xbar.abouturl>https://github.com/lotterfriends/antatime-widget</xbar.abouturl>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
#
# Menüleisten-Widget für SwiftBar (https://swiftbar.app) bzw. xbar. Zeigt,
# was der Dienst antatime-widget liefert; „5s“ im Dateinamen ist das
# Abfrage-Intervall.
PORT="${ANTATIME_WIDGET_PORT:-47821}"

if ! /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/state?format=swiftbar"; then
  echo "⏸ –:––"
  echo "---"
  echo "Der Dienst antatime-widget läuft nicht."
  echo "Starten | bash=/bin/launchctl param1=kickstart param2=gui/$(id -u)/de.antatime.widget terminal=false refresh=true"
fi
