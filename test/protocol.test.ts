import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCode, SyncCrypto } from '../src/crypto.ts';
import { decodeServerMessage, encodeHello, encodePush } from '../src/protocol.ts';
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
