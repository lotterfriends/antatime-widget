import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.extras as PlasmaExtras
import org.kde.plasma.plasmoid

/**
 * AnTaTime in der Kontrollleiste: Symbol und Arbeitszeit von heute.
 * Klick öffnet die Übersicht mit Start/Pause, Mittelklick schaltet direkt um.
 *
 * Die Logik steckt im Dienst `antatime-widget` (lokale HTTP-Schnittstelle);
 * hier wird nur angezeigt, was er liefert.
 */
PlasmoidItem {
    id: root

    readonly property string baseUrl: "http://127.0.0.1:47821"

    /** Letzter Stand des Dienstes (siehe `View` in src/daemon.ts). */
    property var view: null
    readonly property bool running: view !== null && view.running
    readonly property bool configured: view !== null && view.configured
    readonly property string label: view !== null ? view.text : "–:––"

    /** Verwirft Antworten überholter Abfragen. */
    property int generation: 0

    function request(method, path, done) {
        const xhr = new XMLHttpRequest();
        xhr.onreadystatechange = () => {
            if (xhr.readyState !== XMLHttpRequest.DONE)
                return;
            let result = null;
            if (xhr.status === 200) {
                try {
                    result = JSON.parse(xhr.responseText);
                } catch (e) {}
            }
            done(result);
        };
        xhr.open(method, baseUrl + path);
        xhr.send();
    }

    /** Wartet beim Dienst auf die nächste Änderung (Long-Polling). */
    function poll() {
        const gen = ++generation;
        request("GET", "/state" + (view !== null ? "?rev=" + view.rev : ""), result => {
            if (gen !== generation)
                return;
            view = result;
            if (result !== null)
                poll();
            else
                retry.restart();
        });
    }

    function send(action) {
        request("POST", "/" + action, result => {
            if (result !== null) {
                view = result;
                poll();
            }
        });
    }

    function toggle() {
        send(running ? "pause" : "start");
    }

    Timer {
        id: retry
        interval: 3000
        onTriggered: root.poll()
    }

    Component.onCompleted: poll()

    Plasmoid.icon: running ? "media-playback-start" : "media-playback-pause"
    Plasmoid.status: PlasmaCore.Types.ActiveStatus
    toolTipMainText: view !== null ? "AnTaTime – " + view.status : "AnTaTime"
    toolTipSubText: view !== null ? view.current + "\n" + view.today + (view.hint ? "\n" + view.hint : "") : "Der Dienst „antatime-widget“ läuft nicht."

    preferredRepresentation: compactRepresentation

    compactRepresentation: MouseArea {
        id: compact

        readonly property bool vertical: Plasmoid.formFactor === PlasmaCore.Types.Vertical

        Layout.minimumWidth: vertical ? 0 : row.implicitWidth + Kirigami.Units.smallSpacing * 2
        Layout.preferredWidth: Layout.minimumWidth
        Layout.minimumHeight: vertical ? row.implicitHeight + Kirigami.Units.smallSpacing * 2 : 0

        hoverEnabled: true
        acceptedButtons: Qt.LeftButton | Qt.MiddleButton
        onClicked: mouse => {
            if (mouse.button === Qt.MiddleButton)
                root.toggle();
            else
                root.expanded = !root.expanded;
        }

        GridLayout {
            id: row
            anchors.centerIn: parent
            flow: compact.vertical ? GridLayout.TopToBottom : GridLayout.LeftToRight
            columnSpacing: Kirigami.Units.smallSpacing
            rowSpacing: 0

            Kirigami.Icon {
                source: Plasmoid.icon
                // Laufend farbig hervorgehoben, pausiert in der Farbe der Leiste.
                isMask: true
                color: root.running ? Kirigami.Theme.positiveTextColor : Kirigami.Theme.textColor
                opacity: root.view !== null ? 1 : 0.5
                Layout.alignment: Qt.AlignCenter
                Layout.preferredWidth: Kirigami.Units.iconSizes.small
                Layout.preferredHeight: Kirigami.Units.iconSizes.small
            }

            PlasmaComponents.Label {
                text: root.label
                opacity: root.view !== null ? 1 : 0.5
                font.features: { "tnum": 1 }
                Layout.alignment: Qt.AlignCenter
            }
        }
    }

    fullRepresentation: PlasmaExtras.Representation {
        Layout.minimumWidth: Kirigami.Units.gridUnit * 14
        Layout.preferredWidth: Kirigami.Units.gridUnit * 16
        Layout.minimumHeight: column.implicitHeight + Kirigami.Units.largeSpacing * 2
        Layout.preferredHeight: Layout.minimumHeight
        Layout.maximumHeight: Layout.minimumHeight

        ColumnLayout {
            id: column
            anchors.fill: parent
            anchors.margins: Kirigami.Units.largeSpacing
            spacing: Kirigami.Units.smallSpacing

            RowLayout {
                spacing: Kirigami.Units.largeSpacing

                Kirigami.Icon {
                    source: Plasmoid.icon
                    isMask: true
                    color: root.running ? Kirigami.Theme.positiveTextColor : Kirigami.Theme.textColor
                    Layout.preferredWidth: Kirigami.Units.iconSizes.medium
                    Layout.preferredHeight: Kirigami.Units.iconSizes.medium
                }

                ColumnLayout {
                    spacing: 0

                    Kirigami.Heading {
                        level: 2
                        text: root.label
                        font.features: { "tnum": 1 }
                    }

                    PlasmaComponents.Label {
                        text: root.view !== null ? root.view.status : "Dienst nicht erreichbar"
                        opacity: 0.7
                    }
                }
            }

            PlasmaComponents.Label {
                Layout.fillWidth: true
                Layout.topMargin: Kirigami.Units.smallSpacing
                wrapMode: Text.WordWrap
                text: root.view !== null ? root.view.current + "\n" + root.view.today : "Der Dienst „antatime-widget“ läuft nicht. Starten mit:\nsystemctl --user start antatime-widget"
            }

            PlasmaComponents.Label {
                Layout.fillWidth: true
                visible: root.view !== null && root.view.hint !== null
                wrapMode: Text.WordWrap
                text: visible ? root.view.hint : ""
                color: Kirigami.Theme.neutralTextColor
            }

            PlasmaComponents.Button {
                Layout.fillWidth: true
                Layout.topMargin: Kirigami.Units.smallSpacing
                visible: root.configured
                icon.name: root.running ? "media-playback-pause" : "media-playback-start"
                text: root.running ? "Pause" : "Start"
                onClicked: root.toggle()
            }
        }
    }
}
