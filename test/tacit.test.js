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

test('the service keeps a note key record only from an owner, and only on signet', async () => {
  const { saveNoteKey } = require('../api/proposals.cjs');
  const record = await BT.makeRecord(a.signer, a.owner, policy), descriptor = BV.descriptor(policy);
  await assert.rejects(saveNoteKey({ network: 'mainnet', descriptor, handle: 'x', record }), /Invalid network/);
  await assert.rejects(saveNoteKey({ network: 'signet', descriptor, handle: 'x', record: null }), /Invalid record/);
  await assert.rejects(saveNoteKey({ network: 'signet', descriptor, handle: 'nonsense', record, at: 1, sig: 'a' }));
});

test('an inbox shows an amount only for a coin Tacit calls an asset', async () => {
  const tx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/tacit-deposit.json'), 'utf8'));
  const v = sha256(new TextEncoder().encode('tacit-vault-spike-signet-v1/note-key')), id = tx.txid;
  const chain = verdict => ({ utxos: async () => [{ txid: id, vout: 0, value: 546 }], tx: async () => tx, classify: async () => verdict });
  assert.equal(BT.inboxAddress(v, 'signet').slice(0, 4), 'tb1q');
  const [ok] = await BT.readInbox(v, 'signet', chain({ [`${id}:0`]: { status: 'asset', asset_ids: ['ab'] } }));
  assert.equal(ok.status, 'unreadable', 'a classifier naming another asset is not believed');
  const asset = BT.outputsOf(BT.envelopeOf(hex.decode(tx.vin[0].witness[1]))).asset;
  const [good] = await BT.readInbox(v, 'signet', chain({ [`${id}:0`]: { status: 'asset', asset_ids: [asset] } }));
  assert.deepEqual([good.status, good.amount, good.asset], ['asset', 700n, asset]);
  const [unsure] = await BT.readInbox(v, 'signet', chain({ [`${id}:0`]: { status: 'unverified' } }));
  assert.deepEqual([unsure.status, unsure.amount], ['unverified', undefined]);
  const [gone] = await BT.readInbox(v, 'signet', { ...chain({}), classify: async () => { throw new Error('down'); } });
  assert.deepEqual([gone.status, gone.amount], ['unverified', undefined]);
});

// A real sweep from signet, then a send built on it. Every edit a co-owner could make to
// the proposal must be refused before anyone signs, because a bad op burns the notes.
const sendFixture = async () => {
  const bp = await import('../dapp/tacit/bulletproofs.js'), deps = await import('../dapp/tacit/vendor/tacit-deps.min.js');
  const prover = { prove: (v, r) => bp.bpRangeAggProve(v, r).proof, verify: (cs, proof) => bp.bpRangeAggVerify(cs.map(c => deps.secp.ProjectivePoint.fromHex(hex.encode(c))), proof) };
  const te = new TextEncoder(), owner = n => BV.deriveOwnerKey(async m => BV.evmSignMessage(m, sha256(te.encode(n))), 'signet');
  const [oa, ob] = await Promise.all(['tac-owner-a', 'tac-owner-b'].map(owner));
  const vault = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: [oa.owner, ob.owner] }] }), V = BT.makeNoteKey(oa.signer, vault);
  const tx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/tacit-sweep.json'), 'utf8')), id = tx.txid;
  const vn = BT.openNote(tx, 0, V), kn = BT.openNote(tx, 1, V), recipient = secp256k1.getPublicKey(sha256(te.encode('stranger')), true);
  const proposal = BT.buildSend({ priv: V, keyNote: { txid: id, vout: 1, value: 546, asset: kn.asset, blinding: kn.blinding },
    notes: [{ txid: id, vout: 0, value: 546, amount: vn.amount, blinding: vn.blinding, asset: vn.asset, branch: 0, index: 0 }],
    recipient, to: BT.tacitAddress(recipient, recipient, 'signet'), amount: 75n, fee: { txid: 'aa'.repeat(32), vout: 0, value: 40000 }, rate: 2, slot: { policy: vault, index: 1 }, prover });
  const chain = { tx: async () => tx, classify: async ops => Object.fromEntries(ops.map(o => [o, { status: 'asset', asset_ids: [vn.asset] }])) };
  return { vault, V, proposal, chain, prover, oa, ob, recipient };
};

test('a clean send passes review, and needs the quorum to finish', async () => {
  const { vault, V, proposal, chain, prover, oa, ob } = await sendFixture();
  const r = await BT.reviewSend(proposal, vault, V, chain, prover, { receive: 1 });
  assert.deepEqual([r.amount, r.change], [75n, 125n]);
  const one = BT.signSend(proposal, oa.signer, oa.owner, vault);
  assert.deepEqual([BT.signersOf(one, vault).signed.length, BT.signersOf(one, vault).ready], [1, false]);
  assert.throws(() => BT.finishSend(one, vault), /needs 2/);
  const two = BT.signSend(one, ob.signer, ob.owner, vault);
  assert.equal(BT.signersOf(two, vault).ready, true);
  assert.match(BT.finishSend(two, vault).reveal, /^[0-9a-f]+$/);
  // Two owners saving at once keep both signatures.
  const other = BT.signSend(proposal, ob.signer, ob.owner, vault);
  assert.equal(BT.signersOf(BT.mergeSigs(one, other, vault), vault).ready, true);
  // A forged or moved signature is simply not counted.
  const key = BV.keyId(ob.owner, 'signet'), bad = { ...two, sigs: { ...two.sigs, [key]: { 0: '00'.repeat(64) } } };
  assert.equal(BT.signersOf(bad, vault).ready, false);
});

test('every edit to a send is refused before anyone signs', async () => {
  const { vault, V, proposal, chain, prover, recipient } = await sendFixture();
  const flip = (h, at) => h.slice(0, at) + (h[at] === '0' ? '1' : '0') + h.slice(at + 1);
  const edit = f => { const p = JSON.parse(JSON.stringify(proposal)); f(p); return p; };
  const other = hex.encode(secp256k1.getPublicKey(sha256(Uint8Array.of(7)), true));
  const scriptLen = proposal.script.length;
  const cases = {
    'a bigger amount': p => { p.amount = '76'; },
    'another recipient': p => { p.recipient = other; },
    'a redirected payment': p => { p.reveal.outs[0].spk = p.reveal.outs[1].spk; },
    'redirected change': p => { p.reveal.outs[1].spk = p.reveal.outs[0].spk; },
    'a moved change slot': p => { p.changeIndex = 2; },
    'an extra payment': p => { p.reveal.outs.push({ value: 546, spk: p.reveal.outs[0].spk }); },
    'a foreign input': p => { p.reveal.ins.push({ ...p.reveal.ins[2], vout: 5 }); },
    'a repeated coin': p => { p.reveal.ins.push({ ...p.reveal.ins[2] }); },
    'a swapped lead': p => { p.reveal.ins[1].kind = 'vault'; },
    'a broken proof': p => { p.script = flip(p.script, scriptLen - 40); },
    'a broken kernel': p => { p.script = flip(p.script, 240); },
    'a commit for something else': p => { p.commit = flip(p.commit, 120); },
    'no script': p => { p.script = 'zz'; },
    'bytes after the envelope': p => { p.script += '61'; },
    'a change slot past the scan': p => { p.changeIndex = 1999; },
    'the inbox as recipient': p => { p.recipient = hex.encode(secp256k1.getPublicKey(V, true)); },
    'a mislabelled address': p => { p.to = BT.tacitAddress(hex.decode(other), hex.decode(other), 'signet'); },
    'a commit paying less': p => { p.reveal.ins[0].value += 1; },
    'a forged envelope signature': p => { p.envSig = '00'.repeat(64); },
    'a forged key signature': p => { p.keySig = '00'; },
    'a poison input': p => { p.reveal.ins[1] = null; },
    'an address with padding': p => { p.to = p.to + '\n'; },
    'junk after the commit': p => { p.commit += '00'; },
    'sats leaking to the note key': p => { p.reveal.outs.push({ value: 300000, spk: p.reveal.outs[2].spk }); },
    'a poison output': p => { p.reveal.outs[3] = { value: '0', spk: 'ab' }; },
  };
  for(const [name, f] of Object.entries(cases)) await assert.rejects(BT.reviewSend(edit(f), vault, V, chain, prover, { receive: 1 }), /refusing this send|Cannot|invalid|Invalid|bad|out of|length|expected/, name);
  await assert.rejects(BT.reviewSend(proposal, vault, V, { ...chain, classify: async ops => Object.fromEntries(ops.map(o => [o, { status: 'asset', asset_ids: ['00'] }])) }, prover, { receive: 1 }), /does not vouch/);
  await assert.rejects(BT.reviewSend(proposal, vault, V, chain, prover), /not been read/);
  assert.equal(BT.envelopeOf(hex.decode(proposal.script + '61')), null);
  assert.equal(BT.envelopeOf(hex.decode(proposal.script.slice(0, -2))), null);
  await assert.rejects(BT.reviewSend(proposal, vault, V, { ...chain, classify: async () => ({}) }, prover, { receive: 1 }), /does not vouch/);
  assert.equal(hex.encode(BT.parseRecipient(BT.tacitAddress(recipient, recipient, 'signet'), 'signet')), hex.encode(recipient));
  assert.throws(() => BT.parseRecipient(BT.tacitAddress(recipient, recipient, 'mainnet'), 'signet'), /another network/);
});

test('the quorum can recreate the lead note, and that is checked like a send', async () => {
  const { vault, V, proposal, chain, prover, oa, ob } = await sendFixture();
  const tx = await chain.tx(), vn = BT.openNote(tx, 0, V);
  const p = BT.buildReseed({ priv: V, notes: [{ txid: tx.txid, vout: 0, value: 546, amount: vn.amount, blinding: vn.blinding, asset: vn.asset, branch: 0, index: 0 }], fee: { txid: 'aa'.repeat(32), vout: 0, value: 40000 }, rate: 2, slot: { policy: vault, index: 1 }, prover });
  const r = await BT.reviewSend(p, vault, V, chain, prover, { receive: 1 });
  assert.deepEqual([r.reseed, r.total, r.recipient], [true, 200n, null]);
  const signed = BT.signSend(BT.signSend(p, oa.signer, oa.owner, vault), ob.signer, ob.owner, vault);
  assert.equal(BT.signersOf(signed, vault).ready, true);
  assert.match(BT.finishSend(signed, vault).reveal, /^[0-9a-f]+$/);
  const edit = f => { const c = JSON.parse(JSON.stringify(p)); f(c); return c; };
  for(const [name, f] of Object.entries({
    'a payment hidden in change': c => { c.reveal.outs[0].spk = proposal.reveal.outs[0].spk; },
    'an amount claim': c => { c.amount = '1'; },
    'an unknown kind': c => { c.kind = 'other'; },
    'bytes after the envelope': c => { c.script += '61'; },
  })) await assert.rejects(BT.reviewSend(edit(f), vault, V, chain, prover, { receive: 1 }), /refusing this send/, name);
  // A send dressed as a refresh is refused for having the wrong shape.
  await assert.rejects(BT.reviewSend({ ...proposal, kind: 'reseed' }, vault, V, chain, prover, { receive: 1 }), /refusing this send/);
});
