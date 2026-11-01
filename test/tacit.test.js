'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const sandbox = { TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for(const f of ['btc.min.js', 'bitcoin.js', 'bitcoin-tacit.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../dapp', f), 'utf8'), sandbox, { filename: f });
const BV = sandbox.BitcoinVault, BT = sandbox.BitcoinTacit;
const { hex, sha256, bech32m, secp256k1 } = sandbox.btc;

const seat = n => BV.keyFromSignature(`0x${n.repeat(32)}${'11'.repeat(31)}01${'1b'}`, 'signet');
const [a, b, c, x] = ['aa', 'bb', 'cc', 'dd'].map(seat);
const policy = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: [a.owner, b.owner] }, { threshold: 1, keys: [c.owner], older: 144 }] });

test('the address is a Bitcoin-lane tacit address, and carries no other lane', () => {
  const v = BT.makeNoteKey(a.signer, policy), addr = BT.noteAddress(v, 'signet');
  const { prefix, words } = bech32m.decode(addr, 1023), bytes = bech32m.fromWords(words);
  assert.equal(prefix, 'tactt');
  assert.deepEqual([bytes[0], bytes[1], bytes.length], [0, 1, 68]);
  assert.equal(hex.encode(bytes.slice(2, 35)), hex.encode(secp256k1.getPublicKey(v, true)));
  assert.match(BT.noteAddress(v, 'mainnet'), /^tacit1/);
});

test('every owner opens the same note key, and nobody else can', async () => {
  const r = await BT.makeRecord(a.signer, a.owner, policy), v = BT.makeNoteKey(a.signer, policy);
  assert.equal(BT.verifyRecord(policy, r), true);
  assert.equal(Object.keys(r.seals).length, 3);
  for(const s of [a, b, c]) assert.equal(hex.encode(await BT.openRecord(r, s.signer, s.owner, policy)), hex.encode(v));
  await assert.rejects(BT.openRecord(r, x.signer, x.owner, policy), /not an owner/);
  await assert.rejects(BT.makeRecord(x.signer, x.owner, policy), /only an owner/);
});

test('a swapped or stripped record is refused', async () => {
  const r = await BT.makeRecord(a.signer, a.owner, policy);
  const other = BV.policyOf({ network: 'signet', paths: [{ threshold: 1, keys: [a.owner, b.owner] }] });
  assert.equal(BT.verifyRecord(other, r), false, 'another vault');
  assert.equal(BT.verifyRecord(policy, { ...r, pub: hex.encode(secp256k1.getPublicKey(sha256(Uint8Array.of(1)), true)) }), false, 'swapped key');
  const { [Object.keys(r.seals)[0]]: _, ...fewer } = r.seals;
  assert.equal(BT.verifyRecord(policy, { ...r, seals: fewer }), false, 'missing seal');
  assert.equal(BT.verifyRecord(policy, { ...r, by: 'ff'.repeat(65) }), false, 'unknown maker');
  const fresh = await BT.makeRecord(a.signer, a.owner, policy);
  assert.equal(BT.verifyRecord(policy, { ...fresh, sig: r.sig }), false, 'signature from another record');
  // A maker cannot pass a different key off in a seal: it fails at the seal's owner.
  const k = BV.keyId(b.owner, 'signet'), wrong = { ...r, seals: { ...r.seals, [k]: r.seals[BV.keyId(a.owner, 'signet')] } };
  assert.equal(BT.verifyRecord(policy, wrong), false, 'swapped seal');
});

test('a real signet deposit opens to its amount with the note key', () => {
  const tx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/tacit-deposit.json'), 'utf8'));
  const v = sha256(new TextEncoder().encode('tacit-vault-spike-signet-v1/note-key'));
  const n = BT.openNote(tx, 0, v);
  assert.equal(n.amount, 700n);
  assert.equal(n.path, 'sent');
  assert.equal(BT.openNote(tx, 0, sha256(Uint8Array.of(9))), null, 'wrong key opens nothing');
  assert.equal(BT.openNote(tx, 7, v), null, 'no such output');
});
