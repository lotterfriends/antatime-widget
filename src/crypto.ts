import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Ende-zu-Ende-Verschlüsselung des Syncs – Gegenstück zu
 * antatime-app/lib/sync/sync_crypto.dart.
 *
 * Aus dem Sync-Code werden per HKDF-SHA256 die Vault-ID (16 Byte), der
 * AES-256-GCM-Schlüssel und der HMAC-Schlüssel für die Datensatz-Namen
 * abgeleitet.
 */
const SALT = Buffer.from('antatime-sync-v1');
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 25;

/** Normalisiert eine Eingabe wie die App; `null`, wenn kein gültiger Code. */
export function normalizeCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== CODE_LENGTH) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return s;
}

export class SyncCrypto {
  readonly vaultId: Buffer;
  readonly #enc: Buffer;
  readonly #mac: Buffer;
  readonly #keys = new Map<string, Buffer>();

  constructor(code: string) {
    const derive = (info: string) =>
      Buffer.from(hkdfSync('sha256', Buffer.from(code, 'utf8'), SALT, Buffer.from(info), 32));
    this.vaultId = derive('vault').subarray(0, 16);
    this.#enc = derive('enc');
    this.#mac = derive('mac');
  }

  /** Schlüssel eines Datensatzes auf dem Server (16 Byte). */
  recordKey(name: string): Buffer {
    let key = this.#keys.get(name);
    if (!key) {
      key = createHmac('sha256', this.#mac).update(name, 'utf8').digest().subarray(0, 16);
      this.#keys.set(name, key);
    }
    return key;
  }

  /** Ergebnis: Nonce (12) ‖ Chiffretext ‖ Tag (16). */
  encrypt(plain: Uint8Array, aad: Uint8Array): Buffer {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#enc, nonce);
    c.setAAD(aad);
    return Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]);
  }

  /** Wirft bei manipulierten Daten. */
  decrypt(data: Uint8Array, aad: Uint8Array): Buffer {
    if (data.length < 28) throw new Error('Datensatz zu kurz');
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const d = createDecipheriv('aes-256-gcm', this.#enc, buf.subarray(0, 12));
    d.setAAD(aad);
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
  }
}
