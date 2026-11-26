import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { answerChallenge, decodeServerKey, normalizeCode, sameBytes, SyncCrypto } from '../src/crypto.ts';
import { decodeServerMessage, encodeAuth, encodeHello, encodePush } from '../src/protocol.ts';
import { wsUrl } from '../src/sync.ts';

test('HELLO und PUSH', () => {
  const vault = new Uint8Array(16).fill(7);
  assert.deepEqual([...encodeHello(vault, 300)], [1, 1, ...vault, 0xac, 0x02]);
  const key = new Uint8Array(16).fill(1);
  assert.deepEqual([...encodePush(5, [{ key, data: Uint8Array.of(9, 8) }])], [2, 5, 1, ...key, 2, 9, 8]);
});

test('Server-Nachrichten', () => {
  const key = new Uint8Array(16).fill(3);
  assert.deepEqual(decodeServerMessage(Uint8Array.of(0x81, 1, 0x80, 0x01, ...key, 2, 5, 6)), {
    type: 'changes',
    records: [{ seq: 128, key, data: Uint8Array.of(5, 6) }],
  });
  assert.deepEqual(decodeServerMessage(Uint8Array.of(0x82, 4)), { type: 'synced', headSeq: 4, serverTime: null, epoch: null });
  assert.deepEqual(decodeServerMessage(Uint8Array.of(0x82, 4, 9, 0)), { type: 'synced', headSeq: 4, serverTime: 9, epoch: 0 });
  assert.deepEqual(decodeServerMessage(Uint8Array.of(0x83, 2, 10)), { type: 'ack', reqId: 2, firstSeq: 10 });
  assert.deepEqual(decodeServerMessage(Uint8Array.of(0x8f, 4, 0x7a, 0x75)), { type: 'error', code: 4, message: 'zu' });
  assert.throws(() => decodeServerMessage(Uint8Array.of(0x81, 1, 1)));
});

test('Verschlüsselung: an den Datensatz gebunden, Manipulation fällt auf', () => {
  const c = new SyncCrypto('0123456789ABCDEFGHJKMNPQR');
  assert.equal(c.vaultId.length, 16);
  const key = c.recordKey('s:abc');
  assert.equal(key.length, 16);
  const box = c.encrypt(Buffer.from('hallo'), key);
  assert.equal(box.length, 5 + 28);
  assert.equal(c.decrypt(box, key).toString(), 'hallo');
  assert.throws(() => c.decrypt(box, c.recordKey('s:xyz')));
  box[14]! ^= 1;
  assert.throws(() => c.decrypt(box, key));
  assert.throws(() => new SyncCrypto('0123456789ABCDEFGHJKMNPQS').decrypt(c.encrypt(Buffer.from('x'), key), key));
});

test('Sync-Code und Adresse normalisieren', () => {
  assert.equal(normalizeCode('abcde-fghjk-mnpqr-stvwx-yz0o1'), 'ABCDEFGHJKMNPQRSTVWXYZ001');
  assert.equal(normalizeCode('zu kurz'), null);
  assert.equal(wsUrl('antatime.de'), 'wss://antatime.de/sync');
  assert.equal(wsUrl('http://localhost:8080/'), 'ws://localhost:8080/sync');
  assert.equal(wsUrl('https://example.org/zeit/'), 'wss://example.org/zeit/sync');
});

test('Server-Schlüssel lesen', () => {
  // Beispiel aus `antatime-server keygen`.
  const key = decodeServerKey('4yyx-7twy-w339-s6ch-bmjn-kb2n-csbx-k7wc-3zgq-639q-cz43-k2y2-wgs0');
  assert.equal(key?.length, 32);
  assert.equal(key?.toString('hex').slice(0, 8), '27bdd3eb');
  assert.deepEqual(decodeServerKey('O'.repeat(52)), Buffer.alloc(32));
  assert.equal(decodeServerKey('0'.repeat(51) + '1'), null);
  assert.equal(decodeServerKey('zu kurz'), null);
});

test('Anmeldung: CHALLENGE, AUTH und Nachweis des Servers', () => {
  const nonce = new Uint8Array(32).fill(5);
  assert.deepEqual(decodeServerMessage(Uint8Array.of(0x86, ...nonce)), { type: 'challenge', nonce });
  assert.deepEqual(decodeServerMessage(Uint8Array.of(0x87, ...nonce)), { type: 'authOk', proof: nonce });
  assert.throws(() => decodeServerMessage(Uint8Array.of(0x86, 1, 2)));

  // Server-Seite nachgerechnet (wie antatime-server/src/auth.ts).
  const server = generateKeyPairSync('x25519');
  const serverPub = server.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const a = answerChallenge(serverPub, nonce);
  assert.deepEqual([...encodeAuth(a.ephPub, a.mac)], [5, ...a.ephPub, ...a.mac]);
  const shared = diffieHellman({
    privateKey: server.privateKey,
    publicKey: createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), a.ephPub]),
      format: 'der',
      type: 'spki',
    }),
  });
  const k = Buffer.from(
    hkdfSync('sha256', shared, Buffer.from('antatime-auth-v1'), Buffer.concat([nonce, a.ephPub, serverPub]), 32),
  );
  const mac = (role: string) => createHmac('sha256', k).update(role).update(nonce).digest();
  assert.ok(sameBytes(a.mac, mac('client')));
  assert.ok(sameBytes(a.proof, mac('server')));
  assert.ok(!sameBytes(a.proof, a.mac));
  // Jede Antwort verwendet einen neuen Schlüssel.
  assert.notDeepEqual(answerChallenge(serverPub, nonce).ephPub, a.ephPub);
});
