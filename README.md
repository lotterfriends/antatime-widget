# AnTaTime-Widget

[AnTaTime](https://github.com/lotterfriends/antatime) in der Kontrollleiste: Die Arbeitszeit von heute steht direkt in der Leiste, ein Klick startet oder pausiert die Zeiterfassung.

| Oberfläche | Widget |
| --- | --- |
| KDE Plasma 6 | Miniprogramm (`plasma/`) |
| GNOME 45+ | Shell-Erweiterung (`gnome/`) |
| macOS | Menüleiste über [SwiftBar](https://swiftbar.app) oder xbar (`macos/`) |
| Waybar, Xfce u. a. | Abfrage per `curl`, siehe [Andere Leisten](#andere-leisten) |

Alle Widgets zeigen nur an, was ein gemeinsamer kleiner **Dienst** liefert. Er verbindet sich wie ein weiteres Gerät mit dem [Sync-Server](https://github.com/lotterfriends/antatime-server) – Ende-zu-Ende-verschlüsselt, mit demselben Sync-Code wie die App. Start/Pause aus der Leiste erscheinen damit sofort in der App und auf dem Handy, und umgekehrt. Die App selbst muss nicht laufen.

## Voraussetzungen

- AnTaTime mit eingerichteter **Synchronisation** (*Einstellungen → Synchronisation*)
- Node.js ab 22.18 (führt den TypeScript-Quelltext direkt aus, keine weiteren Abhängigkeiten)

## Installation

```bash
git clone https://github.com/lotterfriends/antatime-widget.git
cd antatime-widget
./install.sh
```

Das Skript installiert für den aktuellen Nutzer den Dienst (Start bei der Anmeldung über systemd bzw. launchd), den Befehl `~/.local/bin/antatime-widget` und das Widget der vorhandenen Oberfläche. Später holt `antatime-widget update` neue Versionen, `./uninstall.sh` entfernt alles wieder.

Danach das Widget in die Leiste legen:

- **KDE Plasma:** Rechtsklick auf die Kontrollleiste → *Miniprogramme hinzufügen …* → „AnTaTime“ in die Leiste ziehen. Klick öffnet die Übersicht mit Start/Pause, **Mittelklick** schaltet direkt um.
- **GNOME:** ab- und wieder anmelden, dann `gnome-extensions enable antatime-widget@lotterfriends.github.io`.
- **macOS:** SwiftBar installieren (`brew install swiftbar`) und einen Plugin-Ordner wählen; `./install.sh` kopiert das Plugin dorthin.

### Zugangsdaten

Ist auf dem Rechner die AnTaTime-Desktop-App mit Synchronisation eingerichtet, übernimmt der Dienst Server und Sync-Code von dort – es ist nichts weiter zu tun. Sonst:

```bash
antatime-widget setup     # fragt nach Server, Sync-Code und Server-Schlüssel
```

Die Angaben liegen dann in `~/.config/antatime-widget/config.json` (nur für den Nutzer lesbar) und gehen denen der App vor.

Verlangt der Server eine Anmeldung, braucht auch der Dienst den **Server-Schlüssel** (vom Betreiber des Servers). Ist er in der Desktop-App eingetragen, wird er von dort übernommen; sonst fragt `setup` danach (leer lassen, wenn der Server keinen verlangt). Lässt der Server den Dienst nicht herein – Schlüssel fehlt oder ist falsch, oder der Server hat seine Höchstzahl an Nutzern erreicht –, steht der Grund im Hinweis des Widgets (`hint`), und der Dienst versucht es alle fünf Minuten erneut.

## Befehle

```bash
antatime-widget status    # Stand anzeigen
antatime-widget start     # starten (ändert nichts, wenn schon gestartet)
antatime-widget pause
antatime-widget toggle
```

Damit lässt sich die Zeiterfassung auch auf ein Tastenkürzel legen.

## Aktualisieren

```bash
antatime-widget update            # neuen Stand holen und installieren
antatime-widget update --check    # nur nachsehen, ob es einen gibt
```

`update` holt den neuen Stand in den Ordner, aus dem installiert wurde (`git pull`), und führt dort `./install.sh` aus; der Dienst startet dabei neu. Der geklonte Ordner muss dafür erhalten bleiben. Installationen bis Version 1.1.0 kennen ihn noch nicht – dort einmal von Hand `git pull && ./install.sh` ausführen.

Der Dienst sieht kurz nach dem Start und danach zweimal am Tag selbst nach (`git fetch` im Klon) und meldet ein bereitstehendes Update im Hinweis des Widgets (`hint`); installiert wird erst mit `antatime-widget update`. `ANTATIME_WIDGET_UPDATE_CHECK=0` in der Umgebung des Dienstes schaltet das ab.

## Andere Leisten

Der Dienst liefert den Stand fertig formatiert:

```bash
curl -s 'http://127.0.0.1:47821/state?format=text'      # ▶ 6:12
curl -s 'http://127.0.0.1:47821/state?format=waybar'    # JSON für Waybar
curl -s 'http://127.0.0.1:47821/state?format=genmon'    # Xfce „Generic Monitor“
```

Waybar:

```jsonc
"custom/antatime": {
  "exec": "curl -s 'http://127.0.0.1:47821/state?format=waybar'",
  "return-type": "json",
  "interval": 5,
  "on-click": "curl -s -o /dev/null -X POST http://127.0.0.1:47821/toggle"
}
```

## Aufbau

```
src/         Dienst und Befehlszeile (gemeinsame Logik aller Widgets)
  crypto.ts    Schlüssel aus dem Sync-Code, AES-256-GCM
  protocol.ts  binäres Sync-Protokoll
  sync.ts      Verbindung zum Server, Abgleich, Neuverbinden
  model.ts     Datensätze, Start/Pause, Arbeitszeit und Soll von heute
  daemon.ts    Anzeige-Texte und lokale HTTP-Schnittstelle
  update.ts    Aktualisierung aus dem Klon
plasma/      KDE-Plasma-Miniprogramm (QML)
gnome/       GNOME-Shell-Erweiterung
macos/       SwiftBar-/xbar-Plugin
```

### Lokale Schnittstelle

Nur auf `127.0.0.1`, Port `47821` (`ANTATIME_WIDGET_PORT` ändert ihn – die Widgets erwarten den Standard):

| | |
| --- | --- |
| `GET /state` | Stand als JSON: `text` (Arbeitszeit heute), `status`, `current`, `today`, `hint`, `running`, `connected`, `configured`, `rev` |
| `GET /state?rev=N` | antwortet erst, wenn sich die Anzeige gegenüber `rev` ändert (spätestens nach 25 s) – so reagieren die Widgets sofort, ohne ständig abzufragen |
| `POST /start`, `/pause`, `/toggle` | Zeiterfassung steuern |
| `POST /reload` | Zugangsdaten neu einlesen |

Anfragen von Webseiten im Browser werden abgewiesen. Andere Benutzerkonten desselben Rechners können die Schnittstelle erreichen.

Start/Pause verhalten sich wie in der App: Eine Unterbrechung unter einer Minute setzt die letzte Arbeitszeit fort; ohne Verbindung werden Änderungen vorgemerkt und später übertragen. Arbeitszeiten bearbeiten, Abwesenheiten und das Stundenkonto bleiben Sache der App.

## Entwicklung

```bash
npm install          # nur TypeScript für die Typprüfung
npm start            # Dienst im Vordergrund
npm test
npm run typecheck
```

Getestet unter KDE Plasma 6 (Linux). Die GNOME-Erweiterung und das macOS-Plugin sind bislang ungetestet.
