import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const BASE_URL = 'http://127.0.0.1:47821';
const RETRY_SECONDS = 3;

/**
 * AnTaTime in der oberen Leiste: Symbol und Arbeitszeit von heute, im Menü
 * der Stand und Start/Pause.
 *
 * Die Logik steckt im Dienst `antatime-widget` (lokale HTTP-Schnittstelle);
 * hier wird nur angezeigt, was er liefert (siehe `View` in src/daemon.ts).
 */
const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'AnTaTime');

        this._view = null;
        this._retryId = 0;
        this._cancellable = new Gio.Cancellable();
        // Länger als das Long-Polling des Dienstes (25 s).
        this._session = new Soup.Session({timeout: 40});

        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._status = this._addInfo();
        this._current = this._addInfo();
        this._today = this._addInfo();
        this._hint = this._addInfo();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._action = new PopupMenu.PopupMenuItem('');
        this._action.connect('activate', () => this._send(this._view?.running ? 'pause' : 'start'));
        this.menu.addMenuItem(this._action);

        this._update();
        this._poll();
    }

    _addInfo() {
        const item = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(item);
        return item;
    }

    _request(method, path, done) {
        const message = Soup.Message.new(method, BASE_URL + path);
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
            let view = null;
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.get_status() === Soup.Status.OK)
                    view = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }
            done(view);
        });
    }

    /** Wartet beim Dienst auf die nächste Änderung (Long-Polling). */
    _poll() {
        const generation = this._generation = (this._generation ?? 0) + 1;
        this._request('GET', `/state${this._view ? `?rev=${this._view.rev}` : ''}`, view => {
            if (generation !== this._generation)
                return;
            this._view = view;
            this._update();
            if (view) {
                this._poll();
            } else {
                this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RETRY_SECONDS, () => {
                    this._retryId = 0;
                    this._poll();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }

    _send(action) {
        this._request('POST', `/${action}`, view => {
            if (!view)
                return;
            this._view = view;
            this._update();
            this._poll();
        });
    }

    _update() {
        const view = this._view;
        this._icon.icon_name = view?.running ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
        this._icon.opacity = view ? 255 : 128;
        this._label.text = view?.text ?? '–:––';
        this._status.label.text = view?.status ?? 'Dienst nicht erreichbar';
        this._current.label.text = view?.current ?? 'Der Dienst „antatime-widget“ läuft nicht.';
        this._today.label.text = view?.today ?? 'systemctl --user start antatime-widget';
        this._hint.label.text = view?.hint ?? '';
        this._hint.visible = Boolean(view?.hint);
        this._action.label.text = view?.running ? 'Pause' : 'Start';
        this._action.visible = Boolean(view?.configured);
    }

    destroy() {
        this._generation = -1;
        this._cancellable.cancel();
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        this._session.abort();
        this._session = null;
        super.destroy();
    }
});

export default class AnTaTimeExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
