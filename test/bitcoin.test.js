'use strict';
// Bitcoin vaults, judged by Bitcoin. The unit half needs nothing. The second half
// needs a bitcoind and runs when BITCOIND points at one:
//
//   BITCOIND=/path/to/bitcoind node --test test/bitcoin.test.js
//
// Agreeing with ourselves about a script proves nothing, so the address has to come
// out of Bitcoin Core's own descriptor parser and the spends have to confirm.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { spawn } = require('node:child_process');

const sandbox = { setTimeout, URL, TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for(const f of ['btc.min.js', 'bitcoin.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../dapp', f), 'utf8'), sandbox, { filename: f });
// `var btc` in a classic script lands on the global object in a browser as well.
const BV = sandbox.BitcoinVault;
const { hex, base64, Transaction, HDKey, schnorr } = sandbox.btc;

const seats = network => [1, 2, 3, 4].map(n => {
  const { signer, owner } = BV.keyFromSignature('0x' + String(n).repeat(128) + '1b', network);
  return { signer, owner };
});
const [A, B, C, D] = seats('signet');
const owners = (...list) => list.map(k => k.owner);
const plain = network => { const [a, b, c] = seats(network); return BV.policyOf({ network, paths: [{ threshold: 2, keys: owners(a, b, c) }] }); };
const withDelay = (network, older) => { const [a, b, c, d] = seats(network); return BV.policyOf({ network, paths: [
  { threshold: 2, keys: owners(a, b, c) }, { threshold: 1, keys: owners(d), older },
] }); };
const fakeCoin = (value, height = 100, vout = 0) => ({ txid: '11'.repeat(32), vout, value, height, branch: 0, index: 0 });
const payee = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c';

test('the same owners in any order are the same vault', () => {
  const a = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: owners(A, B, C) }] });
  const b = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: owners(C, A, B) }] });
  assert.equal(BV.descriptor(a), BV.descriptor(b));
  assert.equal(BV.vaultOf(a).address, BV.vaultOf(b).address);
});

test('networks give different addresses for one policy', () => {
  assert.match(BV.vaultOf(plain('signet')).address, /^tb1p/);
  assert.match(BV.vaultOf(plain('mainnet')).address, /^bc1p/);
});

test('receive and change walk different addresses', () => {
  const p = plain('signet');
  const seen = new Set([BV.vaultOf(p, 0, 0), BV.vaultOf(p, 0, 1), BV.vaultOf(p, 1, 0), BV.vaultOf(p, 1, 1)].map(s => s.address));
  assert.equal(seen.size, 4);
});

test('a bad policy is refused', () => {
  const p = (paths, msg) => assert.throws(() => BV.policyOf({ network: 'signet', paths }), msg);
  p([{ threshold: 3, keys: owners(A, B) }], /threshold/);
  p([{ threshold: 0, keys: owners(A) }], /threshold/);
  p([{ threshold: 1, keys: owners(A, A) }], /twice/);
  p([{ threshold: 1, keys: owners(A), older: 10 }], /first path/);
  p([{ threshold: 1, keys: owners(A) }, { threshold: 1, keys: owners(B) }], /needs a delay/);
  p([{ threshold: 1, keys: owners(A) }, { threshold: 1, keys: owners(B), older: 65536 }], /delay must/);
  assert.throws(() => BV.policyOf({ network: 'mainnet', paths: [{ threshold: 1, keys: owners(A) }] }), /not a mainnet/);
  assert.throws(() => BV.policyOf({ network: 'testnet3', paths: [] }), /unknown network/);
});

test('a descriptor round-trips, and a changed one is refused', () => {
  for(const policy of [plain('signet'), withDelay('mainnet', 144)]){
    const d = BV.descriptor(policy);
    assert.equal(BV.descriptor(BV.parseDescriptor(d, policy.network)), d);
  }
  const d = BV.descriptor(plain('signet'));
  assert.throws(() => BV.parseDescriptor(d.replace('multi_a(2', 'multi_a(1'), 'signet'), /checksum/);
  assert.throws(() => BV.parseDescriptor(`wpkh(02aa)#${BV.descriptorChecksum('wpkh(02aa)')}`, 'signet'), /not a multisig/);
  // Valid descriptor syntax that is not what this app writes: reordered keys are a
  // different vault from the one with the same owners, so it is not accepted quietly.
  const body = d.split('#')[0], m = /multi_a\(2,(.*)\)\)$/.exec(body), keys = m[1].split(',');
  const reordered = body.replace(m[1], [...keys].reverse().join(','));
  assert.throws(() => BV.parseDescriptor(`${reordered}#${BV.descriptorChecksum(reordered)}`, 'signet'), /canonical/);
  assert.throws(() => BV.parseDescriptor(body, 'signet'), /no checksum/);
});

test('a key on two paths walks separate chains', () => {
  const policy = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: owners(A, B) }, { threshold: 1, keys: owners(B), older: 144 }] });
  const d = BV.descriptor(policy), xpub = B.owner.xpub;
  assert.ok(d.includes(`${xpub}/<0;1>/*`) && d.includes(`${xpub}/<2;3>/*`));
  const { template, keys } = BV.walletPolicy(policy);
  assert.match(template, /^tr\(@0\/\*\*,\{multi_a\(2,@\d\/\*\*,@\d\/\*\*\),and_v\(v:older\(144\),multi_a\(1,@\d\/<2;3>\/\*\)\)\}\)$/);
  assert.equal(keys.length, 3);
  assert.ok(keys.slice(1).every(k => /^\[[0-9a-f]{8}\/87'\/1'\/0'\]tpub/.test(k)));
  assert.deepEqual(keys.slice(1).map(k => k.split(']')[1]).sort(), [A.owner.xpub, B.owner.xpub].sort());
});

test('an owner handle carries a key and an Ethereum label, per network', () => {
  const [a] = seats('mainnet'), evm = '0x' + 'ab'.repeat(20);
  const h = BV.encodeOwner({ network: 'mainnet', ...a.owner, evm });
  assert.match(h, /^msig1/);
  const back = BV.decodeOwner(h, 'mainnet');
  assert.equal(back.xpub, a.owner.xpub);
  assert.equal(back.fingerprint, a.owner.fingerprint);
  assert.deepEqual([...back.path], [...a.owner.path]);
  assert.equal(back.evm, evm);
  assert.throws(() => BV.decodeOwner(h, 'signet'), /another network/);
  const t = BV.encodeOwner({ network: 'signet', ...A.owner });
  assert.match(t, /^tmsig1/);
  assert.equal(BV.decodeOwner(t, 'signet').evm, null);
  assert.throws(() => BV.decodeOwner(t.slice(0, -1) + (t.endsWith('q') ? 'p' : 'q'), 'signet'), /not an owner/);
});

test('a hardware key is accepted with its origin and refused without one', () => {
  const text = BV.originText(A.owner);
  assert.equal(BV.decodeOwner(text, 'signet').xpub, A.owner.xpub);
  assert.equal(BV.decodeOwner(text.replace(/\/(\d+)h/g, "/$1'"), 'signet').xpub, A.owner.xpub);
  assert.throws(() => BV.decodeOwner(A.owner.xpub, 'signet'), /no origin/);
  assert.throws(() => BV.decodeOwner(text.replace('/87h', '/87h/0'), 'signet'), /does not match/);
  const prv = A.signer.derive("m/87'/1'/0'").privateExtendedKey;
  assert.throws(() => BV.decodeOwner(`[${A.owner.fingerprint}/87h/1h/0h]${prv}`, 'signet'), /private key/);
});

// A real Ethereum account, signing the way personal_sign does.
const account = n => {
  const { secp256k1, keccak_256, sha256 } = sandbox.btc;
  const priv = sha256(new TextEncoder().encode(`evm ${n}`));
  const pub = secp256k1.Point.fromBytes(secp256k1.getPublicKey(priv)).toBytes(false);
  const address = '0x' + hex.encode(keccak_256(pub.subarray(1)).subarray(12));
  const personalSign = text => {
    const sig = secp256k1.sign(BV.evmMessageHash(text), priv, { prehash: false, format: 'recovered' });
    return '0x' + hex.encode(sig.subarray(1)) + (sig[0] + 27).toString(16);
  };
  return { address, personalSign };
};
const handleFor = (seat, acct, signer = acct, network = 'signet') =>
  BV.encodeOwner({ network, ...seat.owner, evm: acct.address, proof: signer.personalSign(BV.bindingMessage(network, seat.owner)) });

test('Ethereum message hashing matches the standard', () => {
  assert.equal(hex.encode(BV.evmMessageHash('Hello World')), 'a1de988600a42c4b4ab089b619297c17d53cffae5d5120d82d8a92d0bb3b78f2');
});

test('a handle is proven only by the address it names', () => {
  const alice = account(1), mallory = account(2);
  const good = BV.decodeOwner(handleFor(A, alice), 'signet');
  assert.equal(good.proven, true);
  assert.equal(good.evm, alice.address);
  assert.equal(good.xpub, A.owner.xpub);
  // The attack this exists for: naming an owner's address beside one's own key.
  assert.throws(() => BV.decodeOwner(handleFor(A, alice, mallory), 'signet'), /not signed by/);
  // A proof over one key does not carry to another.
  const lifted = BV.encodeOwner({ network: 'signet', ...B.owner, evm: alice.address, proof: alice.personalSign(BV.bindingMessage('signet', A.owner)) });
  assert.throws(() => BV.decodeOwner(lifted, 'signet'), /not signed by/);
  // A label with no proof still reads, but is not proven.
  assert.equal(BV.decodeOwner(BV.encodeOwner({ network: 'signet', ...A.owner, evm: alice.address }), 'signet').proven, undefined);
});

const rpcFor = (owners, threshold) => async (url, opts) => {
  const data = JSON.parse(opts.body).params[0].data;
  const word = n => n.toString(16).padStart(64, '0');
  const result = data === BV.selectors.threshold ? '0x' + word(threshold)
    : '0x' + word(32) + word(owners.length) + owners.map(o => o.slice(2).padStart(64, '0')).join('');
  return { json: async () => ({ result }) };
};

test('an Ethereum vault gives one Bitcoin vault, whoever works it out', async () => {
  const [alice, bob, carol] = [1, 2, 3].map(account);
  const owners = [alice, bob, carol].map(a => a.address);
  const vault = await BV.readEvmVault(1, '0x' + '12'.repeat(20), rpcFor(owners, 2));
  assert.deepEqual([...vault.owners], owners);
  assert.equal(vault.threshold, 2);
  const handles = [handleFor(A, alice), handleFor(B, bob), handleFor(C, carol)];
  const one = BV.mirror({ network: 'signet', vault, handles });
  const two = BV.mirror({ network: 'signet', vault, handles: [...handles].reverse() });
  assert.equal(BV.descriptor(one.policy), BV.descriptor(two.policy));
  assert.equal(one.policy.paths[0].threshold, 2);
  assert.equal(BV.descriptor(one.policy), BV.descriptor(plain('signet')));
});

test('a mirror waits for every owner and refuses anyone else', async () => {
  const [alice, bob, mallory] = [1, 2, 3].map(account);
  const vault = await BV.readEvmVault(1, '0x' + '12'.repeat(20), rpcFor([alice.address, bob.address], 2));
  const partial = BV.mirror({ network: 'signet', vault, handles: [handleFor(A, alice)] });
  assert.equal(partial.policy, null);
  assert.deepEqual([...partial.missing], [bob.address]);
  assert.throws(() => BV.mirror({ network: 'signet', vault, handles: [handleFor(C, mallory)] }), /not an owner/);
  const label = BV.encodeOwner({ network: 'signet', ...D.owner, evm: bob.address });
  assert.throws(() => BV.mirror({ network: 'signet', vault, handles: [label] }), /must be signed/);
});

test('reading an address with no vault says so', async () => {
  const empty = async () => ({ json: async () => ({ result: '0x' }) });
  await assert.rejects(BV.readEvmVault(1, '0x' + '12'.repeat(20), empty), /no vault/);
  await assert.rejects(BV.readEvmVault(1, 'nope', empty), /not an Ethereum/);
});

test('a key comes from one signature, and the same one gives the same key', async () => {
  const sig = '0x' + 'cd'.repeat(64) + '1c';
  const one = await BV.deriveOwnerKey(async () => sig, 'signet');
  const two = await BV.deriveOwnerKey(async () => sig.toUpperCase().replace('0X', '0x'), 'signet');
  assert.equal(one.owner.xpub, two.owner.xpub);
  let asked = 0;
  await BV.deriveOwnerKey(async () => { asked++; return sig; }, 'signet');
  assert.equal(asked, 1, 'a repeated identical prompt breaks Rainbow');
  await assert.rejects(BV.deriveOwnerKey(async () => null, 'signet'), /no signature/);
  assert.notEqual(BV.ownerMessage('signet'), BV.ownerMessage('mainnet'));
});

test('coin selection takes change back to the vault and refuses dust', () => {
  const policy = plain('signet');
  const psbt = BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, outputs: [{ address: payee, sats: 30000 }], feeRate: 2 });
  const v = BV.inspect(psbt, policy);
  assert.equal(v.outputs.length, 2);
  assert.equal(v.outputs[1].change, true);
  assert.equal(v.inputs[0].sats - v.outputs[0].sats - v.outputs[1].sats, v.fee);
  assert.ok(v.feeRate >= 2 && v.feeRate < 2.02, `fee rate ${v.feeRate}`);
  assert.throws(() => BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, outputs: [{ address: payee, sats: 100 }], feeRate: 2 }), /at least/);
  assert.throws(() => BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, outputs: [{ address: payee, sats: 99999 }], feeRate: 2 }), /not enough/);
  assert.throws(() => BV.propose({ policy, utxos: [fakeCoin(100000, 0)], tip: 200, outputs: [{ address: payee, sats: 1000 }], feeRate: 2 }), /no confirmed/);
  assert.throws(() => BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, outputs: [{ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', sats: 1000 }], feeRate: 2 }), /not a signet/);
  assert.throws(() => BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, outputs: [{ address: payee, sats: 1000 }], feeRate: 5000 }), /fee rate/);
});

test('leftovers too small for a change output go to the fee', () => {
  const policy = plain('signet');
  const v = BV.inspect(BV.propose({ policy, utxos: [fakeCoin(30500)], tip: 200, outputs: [{ address: payee, sats: 30000 }], feeRate: 1 }), policy);
  assert.equal(v.outputs.length, 1);
  assert.equal(v.fee, 500);
});

test('a delayed path takes only coins that have aged', () => {
  const policy = withDelay('signet', 10);
  const go = tip => BV.propose({ policy, path: 1, utxos: [fakeCoin(100000, 100)], tip, sweep: payee, feeRate: 1 });
  assert.throws(() => go(108), /aged 10/);
  assert.equal(BV.inspect(go(109), policy).older, 10);
});

test('review refuses a proposal that is not this vault\'s', () => {
  const policy = plain('signet');
  const other = BV.policyOf({ network: 'signet', paths: [{ threshold: 1, keys: owners(D) }] });
  const psbt = BV.propose({ policy: other, utxos: [fakeCoin(100000)], tip: 200, sweep: payee, feeRate: 2 });
  assert.throws(() => BV.inspect(psbt, policy), /does not belong/);
  assert.throws(() => BV.sign(psbt, A.signer, policy), /does not belong/);
});

test('review refuses a forged signature, and a stranger cannot sign', () => {
  const policy = plain('signet');
  const psbt = BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, sweep: payee, feeRate: 2 });
  assert.throws(() => BV.sign(psbt, D.signer, policy), /not an owner/);
  const signed = Transaction.fromPSBT(base64.decode(BV.sign(psbt, A.signer, policy)), { allowUnknownInputs: true });
  const [[k, sig]] = signed.getInput(0).tapScriptSig;
  const bad = sig.slice(); bad[0] ^= 1;
  const tx = Transaction.fromPSBT(base64.decode(psbt), { allowUnknownInputs: true });
  tx.updateInput(0, { tapScriptSig: [[k, bad]] }, true);
  assert.throws(() => BV.inspect(base64.encode(tx.toPSBT()), policy), /does not verify/);
});

test('a signature made over a different amount does not verify', () => {
  const policy = plain('signet');
  const psbt = BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, sweep: payee, feeRate: 2 });
  const signed = BV.sign(psbt, A.signer, policy);
  const tx = Transaction.fromPSBT(base64.decode(signed), { allowUnknownInputs: true });
  const inp = tx.getInput(0);
  tx.updateInput(0, { witnessUtxo: { script: inp.witnessUtxo.script, amount: inp.witnessUtxo.amount + 1000n } }, true);
  assert.throws(() => BV.inspect(base64.encode(tx.toPSBT()), policy), /does not verify/);
});

test('signatures merge in any order, and finalize needs the threshold', () => {
  const policy = plain('signet');
  const psbt = BV.propose({ policy, utxos: [fakeCoin(100000), fakeCoin(50000, 100, 1)], tip: 200, outputs: [{ address: payee, sats: 120000 }], feeRate: 2 });
  const a = BV.sign(psbt, A.signer, policy), c = BV.sign(psbt, C.signer, policy);
  assert.equal(BV.inspect(a, policy).ready, false);
  assert.throws(() => BV.finalize(a, policy), /needs 2/);
  const both = BV.combine([c, a], policy);
  const v = BV.inspect(both, policy);
  assert.equal(v.ready, true);
  assert.deepEqual([...v.signedBy].sort(), [A.owner.xpub, C.owner.xpub].sort());
  assert.match(BV.finalize(both, policy), /^[0-9a-f]+$/);
});

test('a stranger\'s address cannot pose as change', () => {
  const policy = plain('signet'), other = BV.policyOf({ network: 'signet', paths: [{ threshold: 1, keys: owners(D) }] });
  const theirs = BV.vaultOf(other, 1, 0);
  const psbt = BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, outputs: [{ address: theirs.address, sats: 30000 }], feeRate: 2, change: 7 });
  const tx = Transaction.fromPSBT(base64.decode(psbt), { allowUnknownInputs: true });
  // The attacker's output claims the same derivation as the real change output.
  tx.updateOutput(0, { tapBip32Derivation: tx.getOutput(1).tapBip32Derivation }, true);
  const v = BV.inspect(base64.encode(tx.toPSBT()), policy);
  assert.equal(v.outputs[0].change, false);
  assert.equal(v.outputs[1].change, true);
  assert.equal(v.outputs[1].address, BV.vaultOf(policy, 1, 7).address);
});

test('a scan finds coins past a gap and stops after an empty run', async () => {
  const policy = plain('signet');
  const hit = new Map([[BV.vaultOf(policy, 0, 3).address, 5000], [BV.vaultOf(policy, 0, 19).address, 7000], [BV.vaultOf(policy, 1, 1).address, 9000]]);
  const asked = new Set();
  const fake = {
    used: async a => { asked.add(a); return hit.has(a); },
    utxos: async a => [{ txid: 'aa'.repeat(32), vout: 0, value: hit.get(a), height: 10 }],
  };
  const r = await BV.scan(policy, fake);
  assert.equal(r.receive, 20);
  assert.equal(r.change, 2);
  assert.deepEqual([...r.coins].map(c => [c.branch, c.index, c.value]), [[0, 3, 5000], [0, 19, 7000], [1, 1, 9000]]);
  assert.equal(asked.size, 40 + 22);
});

// ── FROM THE REVIEW ────────────────────────────────────────
const reopen = psbt => Transaction.fromPSBT(base64.decode(psbt), { allowUnknownInputs: true });
const reseal = tx => base64.encode(tx.toPSBT());
const sweepOf = (policy, opts = {}) => BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, sweep: payee, feeRate: 2, ...opts });

test('an output that only reads as an address is refused', () => {
  const policy = plain('signet'), src = reopen(sweepOf(policy));
  const script = src.getOutput(0).script, amount = src.getOutput(0).amount;
  // OP_1 PUSHDATA1 32 <key>: displays as the payee, spends by anyone. The library will
  // not build this through its checked path, and a hostile proposer does not use that.
  const hostile = new Uint8Array([0x51, 0x4c, 0x20, ...script.subarray(2)]);
  const tx = new Transaction({ version: 2, allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
  tx.addInput(src.getInput(0));
  tx.addOutput({ script: hostile, amount });
  assert.throws(() => BV.inspect(reseal(tx), policy), /not a standard address/);
  assert.throws(() => BV.sign(reseal(tx), A.signer, policy), /not a standard address/);
});

test('a vault address past the scan is not change, and is not signed', () => {
  const policy = plain('signet');
  const far = BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, outputs: [{ address: payee, sats: 30000 }], feeRate: 2, change: 2000000000 });
  const v = BV.inspect(far, policy);
  // Past the ceiling it is still recognised as ours, and no scan's word makes it change.
  assert.equal(v.outputs[1].change, false);
  assert.equal(v.outputs[1].stranded, true);
  assert.throws(() => BV.sign(far, seats('signet')[0].signer, policy), /no scan would ever find/);
  assert.equal(BV.inspect(far, policy, { receive: 0, change: 2000000000 }).outputs[1].change, false);
  // Within it, an address is fine once a scan has reached that far.
  const later = BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, outputs: [{ address: payee, sats: 30000 }], feeRate: 2, change: 300 });
  assert.equal(BV.inspect(later, policy).outputs[1].stranded, true);
  assert.equal(BV.inspect(later, policy, { receive: 0, change: 300 }).outputs[1].change, true);
  const edge = BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, outputs: [{ address: payee, sats: 30000 }], feeRate: 2, change: BV.GAP });
  assert.equal(BV.inspect(edge, policy).outputs[1].stranded, true);
});

test('a key does not depend on how the wallet spells the signature', () => {
  const r = 'ab'.repeat(32), low = '12'.repeat(32), high = 'd2' + '12'.repeat(31);
  const x = v => BV.keyFromSignature(`0x${r}${low}${v}`, 'signet').owner.xpub;
  assert.equal(x('1b'), x('00'));
  assert.equal(x('1c'), x('01'));
  assert.notEqual(x('1b'), x('1c'));
  // EIP-2098: the top bit of s carries v.
  assert.equal(BV.keyFromSignature(`0x${r}${low}`, 'signet').owner.xpub, x('1b'));
  assert.equal(BV.keyFromSignature(`0x${r}${high}`, 'signet').owner.xpub, BV.keyFromSignature(`0x${r}${'52' + '12'.repeat(31)}1c`, 'signet').owner.xpub);
  assert.throws(() => x('05'), /cannot use/);
  assert.throws(() => BV.keyFromSignature('0xabcd', 'signet'), /cannot use/);
});

test('nothing outside the reviewed fields can be set', () => {
  const policy = plain('signet');
  const change = fn => { const tx = reopen(sweepOf(policy)); fn(tx); return reseal(tx); };
  const withTx = opts => {
    const src = reopen(sweepOf(policy));
    const tx = new Transaction({ version: 2, lockTime: 0, allowUnknownInputs: true, allowUnknownVersion: true, ...opts });
    tx.addInput(src.getInput(0));
    tx.addOutput(src.getOutput(0));
    return reseal(tx);
  };
  assert.ok(BV.inspect(withTx({}), policy));
  assert.throws(() => BV.inspect(withTx({ lockTime: 499999999 }), policy), /locktime/);
  assert.throws(() => BV.inspect(withTx({ version: 1 }), policy), /version/);
  assert.throws(() => BV.inspect(withTx({ version: 3 }), policy), /version/);
  assert.throws(() => BV.inspect(change(t => t.updateInput(0, { sequence: 0xffff }, true)), policy), /delay/);
  assert.throws(() => BV.inspect(change(t => t.updateInput(0, { finalScriptSig: new Uint8Array([0x51]) }, true)), policy), /finalized/);
  const twice = withTx({});
  const dup = reopen(twice); dup.addInput(dup.getInput(0));
  assert.throws(() => BV.inspect(reseal(dup), policy), /repeats a coin/);
});

test('signing touches only the reviewed leaf, and a near-miss sequence is refused', () => {
  const [a, b, c] = [A, B, C];
  const policy = BV.policyOf({ network: 'signet', paths: [{ threshold: 3, keys: owners(a, b, c) }, { threshold: 2, keys: owners(a, b, c), older: 144 }] });
  const psbt = sweepOf(policy);
  const tx = reopen(psbt);
  const slot = BV.vaultOf(policy, 0, 0);
  tx.updateInput(0, { tapLeafScript: slot.paths.map(p => p.leaf) }, true);
  const both = reseal(tx);
  const signed = reopen(BV.sign(both, a.signer, policy));
  assert.equal(signed.getInput(0).tapScriptSig.length, 1);
  assert.equal(hex.encode(signed.getInput(0).tapScriptSig[0][0].leafHash), hex.encode(slot.paths[0].hash));
  const off = reopen(both); off.updateInput(0, { sequence: 145 }, true);
  assert.throws(() => BV.inspect(reseal(off), policy), /delay/);
});

test('one key cannot take two seats by changing its xpub metadata', () => {
  const k = HDKey.fromExtendedKey(A.owner.xpub, BV.NETWORKS.signet.versions);
  const twin = new HDKey({ versions: BV.NETWORKS.signet.versions, depth: 2, index: 7, parentFingerprint: 1234, chainCode: k.chainCode, publicKey: k.publicKey });
  const fake = { fingerprint: 'aabbccdd', path: [1, 7], xpub: twin.publicExtendedKey };
  assert.notEqual(fake.xpub, A.owner.xpub);
  assert.throws(() => BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: [A.owner, fake] }] }), /twice/);
});

test('a handle\'s proof covers its origin', () => {
  const alice = account(1), proof = alice.personalSign(BV.bindingMessage('signet', A.owner));
  const moved = BV.encodeOwner({ network: 'signet', ...A.owner, fingerprint: 'deadbeef', evm: alice.address, proof });
  assert.throws(() => BV.decodeOwner(moved, 'signet'), /not signed by/);
});

test('signing covers every input or none, and says who has signed them all', () => {
  const policy = plain('signet');
  const psbt = BV.propose({ policy, utxos: [fakeCoin(60000), fakeCoin(50000, 100, 1)], tip: 200, sweep: payee, feeRate: 2 });
  const v = BV.inspect(BV.sign(psbt, A.signer, policy), policy);
  assert.deepEqual([...v.signedAll], [A.owner.xpub]);
  const partly = reopen(psbt);
  partly.updateInput(0, { tapScriptSig: reopen(BV.sign(psbt, A.signer, policy)).getInput(0).tapScriptSig }, true);
  const seen = BV.inspect(reseal(partly), policy);
  assert.deepEqual([...seen.signedBy], [A.owner.xpub]);
  assert.deepEqual([...seen.signedAll], []);
});

test('a wallet policy writes a depth-0 key without a stray separator', () => {
  const k = HDKey.fromExtendedKey(A.owner.xpub, BV.NETWORKS.signet.versions);
  const root = new HDKey({ versions: BV.NETWORKS.signet.versions, chainCode: k.chainCode, publicKey: k.publicKey });
  const policy = BV.policyOf({ network: 'signet', paths: [{ threshold: 1, keys: [{ fingerprint: 'aabbccdd', path: [], xpub: root.publicExtendedKey }] }] });
  assert.ok(BV.walletPolicy(policy).keys[1].startsWith('[aabbccdd]'));
});

// ── FROM THE SECOND AUDIT ──────────────────────────────────
const rebuilt = (seats, fix) => BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: seats.map(s => fix(s.owner)) }] });

test('altering a seat\'s origin in a descriptor cannot stop its owner signing', () => {
  const policy = rebuilt([A, B, C], o => o === A.owner ? { ...o, path: [86 + 0x80000000, ...o.path.slice(1)] } : o);
  assert.equal(BV.vaultOf(policy).address, BV.vaultOf(plain('signet')).address);
  const psbt = sweepOf(policy);
  assert.deepEqual([...BV.inspect(BV.sign(psbt, A.signer, policy), policy).signedAll], [A.owner.xpub]);
  assert.equal(BV.seatMisdescribed(policy, A.owner), true);
  assert.equal(BV.seatMisdescribed(policy, B.owner), false);
});

test('a co-owner borrowing a fingerprint cannot stop an owner signing', () => {
  const policy = rebuilt([A, B, C], o => o === C.owner ? { ...o, fingerprint: A.owner.fingerprint } : o);
  const psbt = sweepOf(policy);
  assert.deepEqual([...BV.inspect(BV.sign(psbt, A.signer, policy), policy).signedAll], [A.owner.xpub]);
});

test('hostile derivations in a proposal change nothing about what is signed', () => {
  const policy = BV.policyOf({ network: 'signet', paths: [{ threshold: 3, keys: owners(A, B, C) }, { threshold: 2, keys: owners(A, B, C), older: 144 }] });
  const slot = BV.vaultOf(policy, 0, 0), src = reopen(sweepOf(policy));
  const all = slot.paths.flatMap(p => p.keys.map(k => [k.pubkey, { hashes: [p.hash], der: { fingerprint: parseInt(A.owner.fingerprint, 16), path: [...A.owner.path, k.chain, 0] } }]));
  const tx = new Transaction({ version: 2, allowUnknownInputs: true });
  tx.addInput({ ...src.getInput(0), tapLeafScript: slot.paths.map(p => p.leaf), tapBip32Derivation: all });
  tx.addOutput(src.getOutput(0));
  const signed = reopen(BV.sign(reseal(tx), A.signer, policy));
  const rows = signed.getInput(0).tapScriptSig;
  assert.equal(rows.length, 1);
  assert.equal(hex.encode(rows[0][0].leafHash), hex.encode(slot.paths[0].hash));
  // The proposal keeps what a co-signer's wallet needs from it.
  const honest = reopen(BV.sign(sweepOf(policy), A.signer, policy));
  assert.equal(honest.getInput(0).tapBip32Derivation.length, 3);
});

test('one key signing twice does not break a merge', () => {
  const policy = plain('signet'), psbt = sweepOf(policy);
  const one = BV.sign(psbt, A.signer, policy), two = BV.sign(psbt, A.signer, policy);
  const merged = BV.combine([one, two, BV.sign(psbt, B.signer, policy)], policy);
  assert.equal(BV.inspect(merged, policy).ready, true);
});

test('a high-s signature is the same key as its low-s twin', () => {
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const r = 'ab'.repeat(32), low = 0x1234n, high = (n - low).toString(16).padStart(64, '0');
  const x = BV.keyFromSignature(`0x${r}${low.toString(16).padStart(64, '0')}1b`, 'signet').owner.xpub;
  assert.equal(BV.keyFromSignature(`0x${r}${high}1c`, 'signet').owner.xpub, x);
  assert.notEqual(BV.keyFromSignature(`0x${r}${high}1b`, 'signet').owner.xpub, x);
});

test('a path that disagrees with its key, and a key too deep to use, are refused', () => {
  assert.throws(() => BV.decodeOwner(`[aabbccdd/1/2/3]${A.owner.xpub}`, 'signet'), /does not match/);
  const k = HDKey.fromExtendedKey(A.owner.xpub, BV.NETWORKS.signet.versions);
  const deep = new HDKey({ versions: BV.NETWORKS.signet.versions, depth: 254, index: 7, parentFingerprint: 1, chainCode: k.chainCode, publicKey: k.publicKey });
  assert.throws(() => BV.policyOf({ network: 'signet', paths: [{ threshold: 1, keys: [{ fingerprint: 'aabbccdd', path: Array(254).fill(7), xpub: deep.publicExtendedKey }] }] }), /too deep/);
});

test('an explorer cannot walk a scan forever, or past the gap alone', async () => {
  const policy = plain('signet');
  const liar = { used: async () => true, utxos: async () => [] };
  const walked = await BV.scan(policy, liar);
  assert.equal(walked.truncated, true);
  const far = BV.vaultOf(policy, 1, 25).address, near = new Set([...Array(26)].map((_, i) => BV.vaultOf(policy, 1, i).address));
  const steered = { used: async a => near.has(a), utxos: async () => [], usedByAll: async a => { assert.equal(a, far); return false; } };
  await assert.rejects(BV.scan(policy, steered), /disagree/);
  assert.equal((await BV.scan(policy, { ...steered, usedByAll: async () => true })).change, 26);
  // Bad numbers from an explorer never reach the page.
  await assert.rejects(BV.chain('signet', async () => ({ ok: true, json: async () => '<meta http-equiv=refresh>' }), ['https://x']).tip(), /bad block/);
  await assert.rejects(BV.chain('signet', async () => ({ ok: true, json: async () => [{ txid: '<b>', vout: 0, value: 1, status: {} }] }), ['https://y']).utxos('a'), /bad coin/);
  const huge = BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, outputs: [{ address: payee, sats: 30000 }], feeRate: 2, change: BV.MAX_INDEX });
  assert.equal(BV.inspect(huge, policy, { receive: 0, change: BV.MAX_INDEX }).outputs[1].stranded, true);
});

test('a popup rejected too fast to be a person gets one more try', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const c = vm.createContext({ setTimeout, clearTimeout, Date, Promise, location: { pathname: '/' }, addEventListener() {}, dispatchEvent() {}, Event: class {} });
  c.window = c.top = c;
  c.BitcoinVault = { walletMessage: () => 'm', keyFromWalletSignature: () => { throw new Error('signed'); } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dapp/bitcoin-wallets.js'), 'utf8'), c);
  const closed = Object.assign(new Error('User rejected the request.'), { code: 4001 });
  const wallet = sign => ({ name: 'UniSat', account: async () => 'tb1qabc', sign });
  let calls = 0;
  await assert.rejects(c.BitcoinWallets.connectWallet(wallet(async () => { if(!calls++) throw closed; return 'sig'; }), 'signet'), /signed/);
  assert.equal(calls, 2);
  // Twice over is an answer, and so is a person taking their time.
  calls = 0;
  await assert.rejects(c.BitcoinWallets.connectWallet(wallet(async () => { calls++; throw closed; }), 'signet'), /closed that request/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(c.BitcoinWallets.connectWallet(wallet(async () => { calls++; await new Promise(r => setTimeout(r, 750)); throw closed; }), 'signet'), /closed that request/);
  assert.equal(calls, 1);
});

test('a vault describes its own rules in the same words everywhere', () => {
  const [a, b, c] = seats('signet'), [x, y] = owners(a, b), [z] = owners(c);
  const two = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: [x, y] }, { threshold: 1, keys: [x, y], older: 4320 }] });
  assert.deepEqual(BV.describePolicy(two), ['Both owners must sign.', 'Any 1 of 2 owners can also spend any coin unmoved for 4320 blocks, about 30 days.']);
  const dead = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: [x, y] }, { threshold: 1, keys: [z], older: 144 }] });
  assert.equal(BV.describePolicy(dead)[1], 'The recovery key can also spend any coin unmoved for 144 blocks, about 24 hours.');
  assert.ok(BV.HOW_IT_WORKS.length >= 5);
});

test('a vault names its own policy, and only a key can claim a wallet label', () => {
  const [a, b, c] = seats('signet'), [x, y] = owners(a, b), [z] = owners(c), P = paths => BV.policySummary(BV.policyOf({ network: 'signet', paths }));
  assert.equal(P([{ threshold: 2, keys: [x, y] }]).kind, 'standard');
  assert.match(P([{ threshold: 2, keys: [x, y] }]).note, /One lost wallet locks/);
  assert.equal(P([{ threshold: 2, keys: [x, y] }, { threshold: 1, keys: [z], older: 144 }]).kind, 'deadman');
  assert.equal(P([{ threshold: 2, keys: [x, y] }, { threshold: 1, keys: [x], older: 144 }]).kind, 'deadman');
  assert.equal(P([{ threshold: 2, keys: [x, y] }, { threshold: 1, keys: [x, y], older: 144 }]).kind, 'aged');
  assert.equal(P([{ threshold: 1, keys: [x, y] }, { threshold: 1, keys: [x, y], older: 144 }]).kind, 'custom');
  assert.match(P([{ threshold: 2, keys: [x, y] }, { threshold: 1, keys: [x, y], older: 144 }]).note, /one stolen wallet/);
  assert.match(P([{ threshold: 2, keys: [x, y] }, { threshold: 1, keys: [x], older: 144 }]).note, /without the others/);
  assert.match(P([{ threshold: 2, keys: [x, y] }, { threshold: 1, keys: [z], older: 3 }]).note, /very short/);
  assert.equal(BV.aboutBlocks(3), 'about 30 minutes');
  const evm = '0x' + '12'.repeat(20), sign = BV.signPossession(a.signer, 'signet', evm);
  assert.equal(sign.length, 128);
  assert.notEqual(sign, BV.signPossession(b.signer, 'signet', evm));
});

test('a scan never reads an address past the ceiling', async () => {
  const policy = plain('signet'), seen = [];
  const last = new Set([1995, 1996, 1997, 1998, 1999].map(i => BV.vaultOf(policy, 0, i).address));
  await BV.scan(policy, { used: async a => { seen.push(a); return true; }, utxos: async () => [] });
  assert.ok(seen.some(a => last.has(a)));
  assert.equal(seen.length, BV.MAX_INDEX * 2);
});

test('a rate limit moves on to the next explorer, and is said calmly when all are busy', async () => {
  const seen = [], limited = { ok: false, status: 429, headers: { get: () => '1' }, text: async () => '{"message":"limit"}' };
  const c = BV.chain('signet', async url => { seen.push(url); return /first/.test(url) ? limited : { ok: true, json: async () => 77 }; }, ['https://first.rl/api', 'https://second.rl/api']);
  assert.equal(await c.tip(), 77);
  assert.deepEqual(seen.map(u => u.split('/')[2]), ['first.rl', 'second.rl']);
  const all = BV.chain('signet', async () => limited, ['https://a.busy/api', 'https://b.busy/api']);
  await assert.rejects(all.tip(), e => e.message === BV.EXPLORERS_BUSY);
  const stat = n => ({ ok: true, json: async () => ({ chain_stats: { tx_count: n }, mempool_stats: { tx_count: 0 } }) });
  const onlyOne = BV.chain('signet', async url => /lie/.test(url) ? stat(1) : limited, ['https://lie.one/api', 'https://quiet.two/api']);
  await assert.rejects(onlyOne.usedByAll('x'), e => e.message === BV.EXPLORERS_BUSY);
  const mirror = BV.chain('mainnet', async url => /fra/.test(url) || /blockstream/.test(url) ? stat(1) : limited, ['https://mempool.space/api', 'https://mempool.fra.mempool.space/api', 'https://blockstream.info/api']);
  assert.equal(await mirror.usedByAll('x'), true);
});

test('names on the object prototype are not networks', () => {
  for(const n of ['constructor', '__proto__', 'toString'])
    assert.throws(() => BV.policyOf({ network: n, paths: [{ threshold: 1, keys: owners(A) }] }), /unknown network/);
});

test('one Ethereum address cannot bring two keys to a mirror', async () => {
  const alice = account(1);
  const vault = await BV.readEvmVault(1, '0x' + '12'.repeat(20), rpcFor([alice.address], 1));
  assert.throws(() => BV.mirror({ network: 'signet', vault, handles: [handleFor(A, alice), handleFor(B, alice)] }), /two different keys/);
});

test('a txid is worked out from the transaction itself', () => {
  const policy = plain('signet'), psbt = sweepOf(policy);
  const raw = BV.finalize(BV.combine([A, B].map(k => BV.sign(psbt, k.signer, policy)), policy), policy);
  assert.match(BV.txidOf(raw), /^[0-9a-f]{64}$/);
});

test('the registry is a place to look, not something to believe', async () => {
  const alice = account(1), good = handleFor(A, alice);
  const answer = rows => async () => ({ ok: true, json: async () => rows });
  const forged = BV.encodeOwner({ network: 'signet', ...B.owner, evm: alice.address });
  const mismatch = { address: account(2).address, handle: good };
  const got = await BV.fetchHandles('signet', [alice.address.toUpperCase().replace('0X', '0x')], answer([{ address: alice.address, handle: good }, { address: alice.address, handle: forged }, mismatch, { address: alice.address, handle: 'junk' }]));
  assert.deepEqual([...got], [good]);
});

test('a mirror takes checksummed owner addresses from a contract', () => {
  const alice = account(1);
  const r = BV.mirror({ network: 'signet', vault: { owners: [alice.address.toUpperCase().replace('0X', '0x')], threshold: 1 }, handles: [handleFor(A, alice)] });
  assert.ok(r.policy);
});

test('a proposal is one proposal however many copies are signed', () => {
  const policy = plain('signet'), psbt = sweepOf(policy);
  assert.equal(BV.proposalId(BV.sign(psbt, A.signer, policy)), BV.proposalId(psbt));
  assert.notEqual(BV.proposalId(sweepOf(policy, { feeRate: 3 })), BV.proposalId(psbt));
  assert.notEqual(BV.vaultId(policy), BV.vaultId(withDelay('signet', 144)));
});

test('the queue is re-read against the vault, and spent coins close a proposal', async () => {
  const policy = plain('signet'), good = BV.sign(sweepOf(policy), A.signer, policy);
  const other = BV.policyOf({ network: 'signet', paths: [{ threshold: 1, keys: owners(D) }] });
  const foreign = BV.sign(BV.propose({ policy: other, utxos: [fakeCoin(90000)], tip: 200, sweep: payee, feeRate: 2 }), D.signer, other);
  const rows = [
    { id: BV.proposalId(good), psbt: good }, { id: BV.proposalId(foreign), psbt: foreign },
    { id: '00'.repeat(32), psbt: good }, { id: 'ab'.repeat(32), psbt: 'junk' },
  ];
  const f = async () => ({ ok: true, json: async () => rows });
  assert.deepEqual([...await BV.fetchProposals(policy, f)], [good]);
  assert.equal((await BV.openProposals(policy, { spent: async () => false }, f)).length, 1);
  assert.equal((await BV.openProposals(policy, { spent: async () => true }, f)).length, 0);
});

test('dust is never spent, and change never becomes dust', () => {
  const policy = plain('signet');
  const dust = { ...fakeCoin(546, 100, 1), txid: '22'.repeat(32) };
  assert.equal(BV.isProtected(dust), true);
  assert.equal(BV.isProtected({ value: 547 }), false);
  const swept = BV.inspect(BV.propose({ policy, utxos: [fakeCoin(100000), dust], tip: 200, sweep: payee, feeRate: 2 }), policy);
  assert.equal(swept.inputs.length, 1);
  assert.throws(() => BV.propose({ policy, utxos: [dust], tip: 200, sweep: payee, feeRate: 2 }), /no confirmed/);
  // A co-owner can build one by hand. It reads, and it does not get signed.
  const slot = BV.vaultOf(policy, 0, 0), tx = new Transaction({ version: 2, allowUnknownInputs: true });
  tx.addInput({ ...reopen(sweepOf(policy)).getInput(0), witnessUtxo: { script: slot.script, amount: 546n } });
  tx.addOutput({ script: reopen(sweepOf(policy)).getOutput(0).script, amount: 300n });
  assert.throws(() => BV.sign(reseal(tx), A.signer, policy), /dust coin/);
  const size = BV.vsize(policy, 0, 1, [34, 34]), exact = 30000 + Math.ceil(size * 2) + 546;
  const v = BV.inspect(BV.propose({ policy, utxos: [fakeCoin(exact)], tip: 200, outputs: [{ address: payee, sats: 30000 }], feeRate: 2 }), policy);
  assert.equal(v.outputs.length, 1);
});

// A Bitcoin wallet, signing BIP-137 the way UniSat's ecdsa mode does.
const btcWallet = (seed, network = 'signet') => {
  const { secp256k1, sha256, p2wpkh, TEST_NETWORK, NETWORK } = sandbox.btc;
  const priv = sha256(new TextEncoder().encode(seed)), pub = secp256k1.getPublicKey(priv);
  const address = p2wpkh(pub, network === 'signet' ? TEST_NETWORK : NETWORK).address;
  const sign = text => {
    const r = secp256k1.sign(BV.bitcoinMessageHash(text), priv, { prehash: false, format: 'recovered' });
    const out = new Uint8Array(65); out[0] = 39 + r[0]; out.set(r.subarray(1), 1);
    return base64.encode(out);
  };
  return { address, sign };
};

test('one Bitcoin wallet gives one owner on Bitcoin and Ethereum', () => {
  const w = btcWallet('w'), sig = w.sign(BV.walletMessage());
  const signet = BV.keyFromWalletSignature(sig, 'signet'), main = BV.keyFromWalletSignature(sig, 'mainnet');
  assert.equal(signet.evm, main.evm);
  assert.notEqual(signet.owner.xpub, main.owner.xpub);
  assert.match(signet.evm, /^0x[0-9a-f]{40}$/);
  const proof = BV.evmSignMessage(BV.bindingMessage('signet', signet.owner), signet.evmPriv);
  const handle = BV.encodeOwner({ network: 'signet', ...signet.owner, evm: signet.evm, proof, wallet: { address: w.address, signature: w.sign(BV.linkMessage('signet', signet.evm)) } });
  const h = BV.decodeOwner(handle, 'signet');
  assert.equal(h.proven, true);
  assert.equal(h.wallet, w.address);
  assert.equal(h.evm, signet.evm);
});

test('a wallet link is refused unless that wallet signed it', () => {
  const w = btcWallet('w'), other = btcWallet('other'), { owner, evm, evmPriv } = BV.keyFromWalletSignature(w.sign(BV.walletMessage()), 'signet');
  const proof = BV.evmSignMessage(BV.bindingMessage('signet', owner), evmPriv);
  const claim = (address, signature) => BV.encodeOwner({ network: 'signet', ...owner, evm, proof, wallet: { address, signature } });
  assert.throws(() => BV.decodeOwner(claim(w.address, other.sign(BV.linkMessage('signet', evm))), 'signet'), /Bitcoin wallet it names/);
  assert.throws(() => BV.decodeOwner(claim(w.address, w.sign(BV.linkMessage('signet', '0x' + 'ab'.repeat(20)))), 'signet'), /Bitcoin wallet it names/);
  assert.ok(BV.decodeOwner(claim(w.address, w.sign(BV.linkMessage('signet', evm))), 'signet').wallet);
});

test('a bc1 lookup believes only a handle that proves that wallet', async () => {
  const w = btcWallet('w'), { owner, evm, evmPriv } = BV.keyFromWalletSignature(w.sign(BV.walletMessage()), 'signet');
  const handle = BV.encodeOwner({ network: 'signet', ...owner, evm, proof: BV.evmSignMessage(BV.bindingMessage('signet', owner), evmPriv), wallet: { address: w.address, signature: w.sign(BV.linkMessage('signet', evm)) } });
  const reply = rows => async () => ({ ok: true, json: async () => rows });
  assert.equal((await BV.handleForWallet('signet', w.address, reply([{ address: evm, handle }]))).evm, evm);
  assert.equal(await BV.handleForWallet('signet', btcWallet('x').address, reply([{ address: evm, handle }])), null);
  assert.equal(await BV.handleForWallet('signet', w.address, reply([])), null);
});

test('a coin from a Tacit transaction is set aside, and so is one that cannot be checked', async () => {
  const policy = plain('signet'), addr = BV.vaultOf(policy, 0, 0).address;
  const coins = [{ txid: 'aa'.repeat(32), vout: 0, value: 50000, height: 10 }, { txid: 'bb'.repeat(32), vout: 0, value: 60000, height: 10 }, { txid: 'cc'.repeat(32), vout: 0, value: 70000, height: 10 }];
  const envelope = '20' + '11'.repeat(32) + 'ac006305' + '5441434954' + '0101' + '68';
  const txs = { ['aa'.repeat(32)]: { vin: [{ witness: ['00'.repeat(64), envelope] }] }, ['bb'.repeat(32)]: { vin: [{ witness: ['00'.repeat(64)] }] } };
  const c = { used: async a => a === addr, utxos: async () => coins, tx: async id => { if(!txs[id]) throw new Error('down'); return txs[id]; } };
  const found = await BV.scan(policy, c);
  assert.deepEqual([...found.coins].map(u => u.quarantine), ['tacit', undefined, 'unknown']);
  const v = BV.inspect(BV.propose({ policy, utxos: found.coins.map(u => ({ ...u })), tip: 200, sweep: payee, feeRate: 2 }), policy);
  assert.deepEqual([...v.inputs].map(i => i.txid), ['bb'.repeat(32)]);
  // Built by hand, it reads, and it is not signed.
  const hand = BV.propose({ policy, utxos: [{ ...coins[0], branch: 0, index: 0 }], tip: 200, sweep: payee, feeRate: 2 });
  assert.throws(() => BV.sign(hand, A.signer, policy, { receive: 1, change: 0, quarantined: [`${'aa'.repeat(32)}:0`] }), /quarantined/);
  assert.ok(BV.sign(hand, A.signer, policy, { receive: 1, change: 0, quarantined: [] }));
});

test('hostile derivations cannot make a proposal expensive to read', () => {
  const keys = Array.from({ length: 12 }, (_, i) => BV.keyFromSignature('0x' + (i + 10).toString(16).padStart(2, '0').repeat(64) + '1b', 'signet').owner);
  const policy = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys }] }), src = reopen(BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, sweep: payee, feeRate: 2 }));
  const rows = Array.from({ length: 60 }, (_, i) => [schnorr.getPublicKey(sandbox.btc.sha256(new Uint8Array([i + 1]))), { hashes: [], der: { fingerprint: 1, path: [0, 1000 + i] } }]);
  const tx = new Transaction({ version: 2, allowUnknownInputs: true, disableScriptCheck: true });
  const { tapBip32Derivation, ...input } = src.getInput(0);
  tx.addInput({ ...input, tapBip32Derivation: rows });
  tx.addOutput(src.getOutput(0));
  const at = Date.now();
  assert.throws(() => BV.inspect(reseal(tx), policy), /does not belong/);
  assert.ok(Date.now() - at < 1500, `took ${Date.now() - at}ms`);
});

test('a copy claiming another amount does not merge', () => {
  const policy = plain('signet'), psbt = sweepOf(policy), signed = BV.sign(psbt, A.signer, policy);
  const src = reopen(psbt), tx = new Transaction({ version: 2, allowUnknownInputs: true });
  const inp = src.getInput(0);
  tx.addInput({ ...inp, witnessUtxo: { script: inp.witnessUtxo.script, amount: inp.witnessUtxo.amount + 50000n } });
  tx.addOutput(src.getOutput(0));
  assert.equal(BV.proposalId(reseal(tx)), BV.proposalId(psbt));
  assert.throws(() => BV.combine([signed, reseal(tx)], policy), /disagree/);
});

test('a vault id ignores fingerprints, which do not change the addresses', () => {
  const a = plain('signet'), b = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: [A, B, C].map(s => s === A ? { ...s.owner, fingerprint: 'deadbeef' } : s.owner) }] });
  assert.equal(BV.vaultId(a), BV.vaultId(b));
});

test('only a plain verdict releases a coin that tripped the envelope check', async () => {
  const op = n => `${n.repeat(32)}:0`, envelope = { vin: [{ witness: ['ac006305' + '5441434954' + '0101'] }] };
  const coin = n => ({ txid: n.repeat(32), vout: 0, value: 50000, height: 10 });
  const policy = plain('signet'), addr = BV.vaultOf(policy, 0, 0).address, coins = ['aa', 'bb', 'cc', 'dd', 'ee'].map(coin);
  const asked = [];
  const c = {
    used: async a => a === addr, utxos: async () => coins.map(u => ({ ...u })),
    tx: async id => id.startsWith('ee') ? { vin: [{ witness: ['00'] }] } : envelope,
    classify: async list => { asked.push(...list); return { [op('aa')]: { status: 'plain' }, [op('bb')]: { status: 'asset', asset_ids: ['f0'.repeat(32)] }, [op('cc')]: { status: 'unverified', reason: 'x' } }; },
  };
  const { coins: found } = await BV.scan(policy, c);
  assert.deepEqual([...found].map(u => u.quarantine), [undefined, 'tacit', 'unknown', 'unknown', undefined]);
  assert.equal(found[1].asset, 'f0'.repeat(32));
  // A coin with no envelope is never sent to Tacit.
  assert.ok(!asked.includes(op('ee')));
  const down = await BV.scan(policy, { ...c, classify: async () => { throw new Error('down'); } });
  assert.deepEqual([...down.coins].map(u => u.quarantine), ['unknown', 'unknown', 'unknown', 'unknown', undefined]);
  await assert.rejects(BV.assertSpendable([{ txid: 'bb'.repeat(32), vout: 0, sats: 50000 }], c), /not signed/);
  await BV.assertSpendable([{ txid: 'aa'.repeat(32), vout: 0, sats: 50000 }], c);
  await BV.assertSpendable([{ txid: 'ee'.repeat(32), vout: 0, sats: 50000 }], c);
  // An explorer that answers with nothing has not cleared the coin.
  await assert.rejects(BV.assertSpendable([{ txid: 'aa'.repeat(32), vout: 0, sats: 50000 }], { tx: async () => ({}) }), /not signed/);
  await assert.rejects(BV.assertSpendable([{ txid: 'aa'.repeat(32), vout: 0, sats: 50000 }], {}), /cannot check/);
});

test('an owner proves who they are without a wallet prompt, for one action, briefly', () => {
  const at = Math.floor(Date.now() / 1000), { sig } = BV.signOwnerAuth(A.signer, 'signet', 'list', at);
  assert.equal(BV.verifyOwnerAuth(A.owner, 'signet', 'list', at, sig), true);
  assert.equal(BV.verifyOwnerAuth(B.owner, 'signet', 'list', at, sig), false);
  assert.equal(BV.verifyOwnerAuth(A.owner, 'signet', 'save:x', at, sig), false);
  assert.equal(BV.verifyOwnerAuth(A.owner, 'signet', 'list', at, sig, at + 301), false);
  assert.equal(BV.verifyOwnerAuth(A.owner, 'signet', 'list', at, 'zz'), false);
});

test('the vault list keeps only vaults holding this owner\'s key', async () => {
  const alice = account(1), handle = handleFor(A, alice);
  const mine = BV.descriptor(plain('signet')), not = BV.descriptor(BV.policyOf({ network: 'signet', paths: [{ threshold: 1, keys: owners(D) }] }));
  const f = async () => ({ ok: true, json: async () => [{ descriptor: mine, confirmed: true }, { descriptor: not, confirmed: true }, { descriptor: 'junk', confirmed: true }] });
  const got = await BV.listVaults('signet', A.signer, handle, f);
  assert.equal(got.length, 1);
  assert.equal(BV.descriptor(got[0].policy), mine);
  // The server saying confirmed is not enough. It needs this owner's own signature.
  assert.equal(got[0].confirmed, false);
  const policy = plain('signet'), auth = BV.signOwnerAuth(A.signer, 'signet', `save:${BV.vaultId(policy)}`);
  const f2 = async () => ({ ok: true, json: async () => [{ descriptor: mine, confirmed: true, ...auth }] });
  assert.equal((await BV.listVaults('signet', A.signer, handle, f2))[0].confirmed, true);
  const forged = BV.signOwnerAuth(B.signer, 'signet', `save:${BV.vaultId(policy)}`);
  const f3 = async () => ({ ok: true, json: async () => [{ descriptor: mine, confirmed: true, ...forged }] });
  assert.equal((await BV.listVaults('signet', A.signer, handle, f3))[0].confirmed, false);
});

test('one transaction stays relayable however many coins there are', () => {
  const keys = Array.from({ length: 20 }, (_, i) => BV.keyFromSignature('0x' + (i + 16).toString(16).repeat(64) + '1b', 'signet').owner);
  const policy = BV.policyOf({ network: 'signet', paths: [{ threshold: 20, keys }] });
  const coins = Array.from({ length: 300 }, (_, i) => ({ txid: (i + 256).toString(16).padStart(64, '0'), vout: 0, value: 50000 + i, height: 100, branch: 0, index: 0 }));
  const v = BV.inspect(BV.propose({ policy, utxos: coins, tip: 200, sweep: payee, feeRate: 1 }), policy);
  assert.ok(v.vsize <= 95000, `${v.vsize}`);
  assert.ok(v.inputs.length < 300);
  assert.equal(v.inputs[0].sats, 50299);
  assert.throws(() => BV.propose({ policy, utxos: coins, tip: 200, outputs: [{ address: payee, sats: 14000000 }], feeRate: 1 }), /too many small coins/);
  assert.throws(() => BV.propose({ policy: plain('signet'), utxos: [fakeCoin(90000)], tip: 200, sweep: payee, feeRate: 0.5 }), /fee rate/);
});

test('one key in dressed-up xpub text is still its owner', () => {
  const k = HDKey.fromExtendedKey(A.owner.xpub, BV.NETWORKS.signet.versions);
  const other = new HDKey({ versions: BV.NETWORKS.signet.versions, depth: 2, index: 7, parentFingerprint: 1234, chainCode: k.chainCode, publicKey: k.publicKey });
  const dressed = { fingerprint: 'aabbccdd', path: [1, 7], xpub: other.publicExtendedKey };
  const policy = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: [dressed, B.owner, C.owner] }] });
  assert.equal(BV.sameKey(dressed, A.owner, 'signet'), true);
  const signed = BV.sign(sweepOf(policy), A.signer, policy);
  assert.equal(BV.inspect(signed, policy).signedBy.length, 1);
});

test('a backup explains how to make the key again, and the exported key matches', () => {
  const text = BV.recoveryText('signet');
  assert.ok(text.includes(BV.ownerMessage('signet').split('\n')[2]) && text.includes("m/87'/1'/0'"));
  const out = BV.exportAccountKey(A.signer, 'signet'), xprv = out.split(']')[1];
  assert.equal(HDKey.fromExtendedKey(xprv, BV.NETWORKS.signet.versions).publicExtendedKey, A.owner.xpub);
});

test('a name resolves in two steps, and a scan past its limit stays inside it', async () => {
  const calls = [];
  const f = async (url, o) => { const { to, data } = JSON.parse(o.body).params[0]; calls.push([to, data.slice(0, 10)]); return { json: async () => ({ result: calls.length === 1 ? '0x' + '77'.repeat(32) : '0x' + '00'.repeat(12) + 'ab'.repeat(20) }) }; };
  assert.equal(await BV.resolveName('ross.wei', f), '0x' + 'ab'.repeat(20));
  assert.equal(calls[0][0], '0x0000000000696760E15f265e828DB644A0c242EB');
  await assert.rejects(BV.resolveName('ross.gwei', async () => ({ json: async () => ({ result: '0x' + '00'.repeat(32) }) })), /not registered/);
  assert.equal(BV.isName('ross.wei') && !BV.isName('ross.eth'), true);
  const policy = plain('signet'), r = await BV.scan(policy, { used: async () => true, utxos: async () => [] });
  assert.ok(r.truncated && r.receive === BV.MAX_INDEX - BV.GAP && r.change === BV.MAX_INDEX - BV.GAP, `${r.receive} ${r.change}`);
});

test('two different proposals do not merge', () => {
  const policy = plain('signet');
  const one = BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, sweep: payee, feeRate: 2 });
  const two = BV.propose({ policy, utxos: [fakeCoin(100000)], tip: 200, sweep: payee, feeRate: 3 });
  assert.throws(() => BV.combine([one, two], policy), /different proposals/);
});

test('a server that fails is asked last until it has cooled off', async () => {
  const seen = [];
  const f = async url => { seen.push(url); if(url.startsWith('https://dead')) throw new Error('blocked'); return { ok: true, json: async () => 7 }; };
  const c = BV.chain('signet', f, ['https://dead', 'https://live']);
  await c.tip(); await c.tip(); await c.tip();
  assert.deepEqual(seen.map(u => u.split('/')[2]), ['dead', 'live', 'live', 'live']);
  // Moved back, not dropped: with the other down as well, it is still tried.
  const asked = [];
  await BV.chain('signet', async url => { asked.push(url); throw new Error('down'); }, ['https://dead', 'https://other']).tip().catch(() => {});
  assert.equal(asked.length, 2);
});

test('the chain client fails over, and does not retry a refusal', async () => {
  const seen = [];
  const down = async url => { seen.push(url); if(url.startsWith('https://a')) throw new Error('down'); return { ok: true, json: async () => 7 }; };
  assert.equal(await BV.chain('signet', down, ['https://a', 'https://b']).tip(), 7);
  assert.equal(seen.length, 2);
  const asked = [];
  const refuse = async url => { asked.push(url); return { ok: false, status: 400, text: async () => 'bad-txns' }; };
  await assert.rejects(BV.chain('signet', refuse, ['https://a', 'https://b']).broadcast('00'), /bad-txns/);
  assert.equal(asked.length, 1);
});

// ── AGAINST BITCOIN CORE ───────────────────────────────────
const BITCOIND = process.env.BITCOIND;
test('Bitcoin Core agrees', { skip: !BITCOIND && 'set BITCOIND to run' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btcvault-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const node = spawn(BITCOIND, ['-regtest', `-datadir=${dir}`, `-rpcport=${port}`, '-listen=0', '-rpcuser=u', '-rpcpassword=p', '-fallbackfee=0.0001', '-printtoconsole=0'], { stdio: 'ignore' });
  t.after(() => { node.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });

  const rpc = (method, params = [], wallet) => new Promise((ok, no) => {
    const req = http.request({ port, method: 'POST', path: wallet ? `/wallet/${wallet}` : '/', auth: 'u:p', headers: { 'content-type': 'application/json' } }, res => {
      let body = ''; res.on('data', d => body += d);
      res.on('end', () => { try { const j = JSON.parse(body); j.error ? no(new Error(`${method}: ${j.error.message}`)) : ok(j.result); } catch(e) { no(e); } });
    });
    req.on('error', no); req.end(JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }));
  });
  for(let i = 0; ; i++){
    try { await rpc('getblockchaininfo'); break; }
    catch(e) { if(i > 100) throw e; await new Promise(r => setTimeout(r, 200)); }
  }
  await rpc('createwallet', ['w']);
  const mine = await rpc('getnewaddress', [], 'w');
  await rpc('generatetoaddress', [110, mine]);

  // regtest addresses are bcrt1: the policy uses signet params, so take Core's script.
  const fund = async (policy, btc, branch = 0, index = 0) => {
    const v = BV.vaultOf(policy, branch, index);
    const { address: rt } = await rpc('decodescript', [hex.encode(v.script)]);
    const txid = await rpc('sendtoaddress', [rt, btc], 'w');
    await rpc('generatetoaddress', [1, mine]);
    const tx = await rpc('getrawtransaction', [txid, 1, await rpc('getbestblockhash')]);
    const vout = tx.vout.find(o => o.scriptPubKey.hex === hex.encode(v.script));
    return { txid, vout: vout.n, value: Math.round(vout.value * 1e8), height: await rpc('getblockcount'), branch, index };
  };
  const coreAddress = async desc => (await rpc('deriveaddresses', [desc]))[0];
  const accepted = async raw => (await rpc('testmempoolaccept', [[raw]]))[0];
  const spend = async (policy, raw) => {
    const r = await accepted(raw);
    assert.equal(r.allowed, true, r['reject-reason']);
    await rpc('sendrawtransaction', [raw]);
    await rpc('generatetoaddress', [1, mine]);
    return r;
  };

  await t.test('derives the same scripts from the descriptor, on both chains', async () => {
    const shared = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: owners(A, B) }, { threshold: 1, keys: owners(B), older: 144 }] });
    for(const policy of [plain('signet'), withDelay('signet', 144), withDelay('signet', 12), shared]){
      const desc = BV.descriptor(policy);
      assert.equal((await rpc('getdescriptorinfo', [desc.split('#')[0]])).checksum, desc.split('#')[1]);
      const [receive, change] = await rpc('deriveaddresses', [desc, [0, 2]]);
      for(const [branch, list] of [[0, receive], [1, change]]) for(let i = 0; i < 3; i++)
        assert.equal((await rpc('validateaddress', [list[i]])).scriptPubKey, hex.encode(BV.vaultOf(policy, branch, i).script), `${branch}/${i}`);
    }
  });

  // Regtest's bcrt1 address will not parse under signet params, so spends pay another
  // signet-encoded vault and Core sees only scripts.
  const sink = BV.vaultOf(BV.policyOf({ network: 'signet', paths: [{ threshold: 1, keys: owners(D) }] })).address;

  await t.test('confirms a 2-of-3 spend with every signer pair', async () => {
    const policy = plain('signet');
    for(const [x, y] of [[A, B], [A, C], [B, C]]){
      const coin = await fund(policy, 1);
      const psbt = BV.propose({ policy, utxos: [coin], tip: coin.height, outputs: [{ address: sink, sats: 40000000 }], feeRate: 2 });
      const raw = BV.finalize(BV.combine([BV.sign(psbt, y.signer, policy), BV.sign(psbt, x.signer, policy)], policy), policy);
      const r = await spend(policy, raw);
      const view = BV.inspect(BV.combine([BV.sign(psbt, y.signer, policy), BV.sign(psbt, x.signer, policy)], policy), policy);
      assert.ok(view.vsize >= r.vsize, `estimate ${view.vsize} below actual ${r.vsize}`);
      assert.ok(view.vsize - r.vsize <= 1, `estimate ${view.vsize}, actual ${r.vsize}`);
    }
  });

  await t.test('leaves out a surplus signature, which the script would reject', async () => {
    const policy = plain('signet');
    const coin = await fund(policy, 1);
    const psbt = BV.propose({ policy, utxos: [coin], tip: coin.height, sweep: sink, feeRate: 2 });
    const all = BV.combine([A, B, C].map(k => BV.sign(psbt, k.signer, policy)), policy);
    await spend(policy, BV.finalize(all, policy));
  });

  await t.test('confirms a spend of several coins', async () => {
    const policy = plain('signet');
    const coins = [await fund(policy, 0.3), await fund(policy, 0.4), await fund(policy, 0.5)];
    const tip = coins[2].height;
    const psbt = BV.propose({ policy, utxos: coins, tip, outputs: [{ address: sink, sats: 100000000 }], feeRate: 2 });
    assert.equal(BV.inspect(psbt, policy).inputs.length, 3);
    await spend(policy, BV.finalize(BV.combine([A, C].map(k => BV.sign(psbt, k.signer, policy)), policy), policy));
  });

  await t.test('spends coins from several addresses, change included', async () => {
    const policy = plain('signet');
    const coins = [await fund(policy, 0.2, 0, 4), await fund(policy, 0.2, 1, 9)];
    const psbt = BV.propose({ policy, utxos: coins, tip: coins[1].height, outputs: [{ address: sink, sats: 30000000 }], feeRate: 2, change: 10 });
    const raw = BV.finalize(BV.combine([A, B].map(k => BV.sign(psbt, k.signer, policy)), policy), policy);
    await spend(policy, raw);
    // The change output is itself spendable: nothing about it was special.
    const seen = await rpc('decoderawtransaction', [raw]);
    const out = seen.vout.find(o => o.scriptPubKey.hex === hex.encode(BV.vaultOf(policy, 1, 10).script));
    const change = { txid: seen.txid, vout: out.n, value: Math.round(out.value * 1e8), height: await rpc('getblockcount'), branch: 1, index: 10 };
    const next = BV.propose({ policy, utxos: [change], tip: change.height, sweep: sink, feeRate: 2 });
    await spend(policy, BV.finalize(BV.combine([B, C].map(k => BV.sign(next, k.signer, policy)), policy), policy));
  });

  // The stand-in for a hardware wallet. Core is a signer we did not write, holding one
  // owner's key and nothing else, and it can only find that key from what the PSBT
  // says. If the derivations or leaf hashes were wrong it would sign nothing.
  await t.test('an outside signer can sign a proposal from the PSBT alone', async () => {
    const both = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: owners(A, B, C) }, { threshold: 1, keys: owners(C), older: 2 }] });
    for(const [policy, path, partner] of [[plain('signet'), 0, A], [withDelay('signet', 2), 0, A], [both, 0, A]]){
      const coin = await fund(policy, 0.5, 0, 2);
      const psbt = BV.propose({ policy, path, utxos: [coin], tip: coin.height, outputs: [{ address: sink, sats: 10000000 }], feeRate: 2, change: 3 });
      const prv = C.signer.derive("m/87'/1'/0'").privateExtendedKey;
      const wallet = `outside${Math.random().toString(36).slice(2, 8)}`;
      await rpc('createwallet', [wallet, false, true, '', false, true]);
      const desc = BV.descriptor(policy).split('#')[0].split(C.owner.xpub).join(prv);
      const { checksum } = await rpc('getdescriptorinfo', [desc]);
      const [imported] = await rpc('importdescriptors', [[{ desc: `${desc}#${checksum}`, timestamp: 'now', active: false, range: [0, 20] }]], wallet);
      assert.ok(imported.success, JSON.stringify(imported));
      const { psbt: signed } = await rpc('walletprocesspsbt', [psbt, true, 'DEFAULT', true, false], wallet);
      const view = BV.inspect(signed, policy);
      assert.deepEqual([...view.signedBy], [C.owner.xpub], 'Core added no signature');
      const merged = BV.combine([BV.sign(psbt, partner.signer, policy), signed], policy);
      await spend(policy, BV.finalize(merged, policy));
    }
  });

  await t.test('a signer holding a key on the delayed leaf can spend it', async () => {
    const policy = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: owners(A, B, C) }, { threshold: 1, keys: owners(C), older: 2 }] });
    const coin = await fund(policy, 0.5);
    await rpc('generatetoaddress', [2, mine]);
    const psbt = BV.propose({ policy, path: 1, utxos: [coin], tip: await rpc('getblockcount'), sweep: sink, feeRate: 2 });
    await spend(policy, BV.finalize(BV.sign(psbt, C.signer, policy), policy));
  });

  await t.test('Core accepts the id we compute, and a corrected signer still confirms', async () => {
    const policy = BV.policyOf({ network: 'signet', paths: [{ threshold: 2, keys: [{ ...A.owner, path: [86 + 0x80000000, ...A.owner.path.slice(1)] }, B.owner, C.owner] }] });
    const coin = await fund(policy, 0.3);
    const psbt = BV.propose({ policy, utxos: [coin], tip: coin.height, sweep: sink, feeRate: 2 });
    const raw = BV.finalize(BV.combine([A, C].map(k => BV.sign(psbt, k.signer, policy)), policy), policy);
    assert.equal((await rpc('decoderawtransaction', [raw])).txid, BV.txidOf(raw));
    await spend(policy, raw);
  });

  await t.test('refuses one signature short', async () => {
    const policy = plain('signet');
    const coin = await fund(policy, 1);
    const psbt = BV.propose({ policy, utxos: [coin], tip: coin.height, sweep: sink, feeRate: 2 });
    const signed = BV.combine([A, B].map(k => BV.sign(psbt, k.signer, policy)), policy);
    const raw = BV.finalize(signed, policy);
    const tx = Transaction.fromRaw(hex.decode(raw), { allowUnknownInputs: true });
    const wit = tx.getInput(0).finalScriptWitness.map(w => w.slice());
    wit[wit.findIndex(w => w.length === 64)] = new Uint8Array(0);
    tx.updateInput(0, { finalScriptWitness: wit }, true);
    assert.equal((await accepted(tx.hex)).allowed, false);
  });

  await t.test('holds a delayed path to the block, and lets the first path through early', async () => {
    const older = 5, policy = withDelay('signet', older);
    const coin = await fund(policy, 1);
    // The delayed path, one block too soon: Core must refuse it on BIP-68.
    const fake = { ...coin, height: coin.height - older };
    const early = BV.finalize(BV.sign(BV.propose({ policy, path: 1, utxos: [fake], tip: coin.height, sweep: sink, feeRate: 2 }), D.signer, policy), policy);
    const refused = await accepted(early);
    assert.equal(refused.allowed, false);
    assert.match(refused['reject-reason'], /non-BIP68-final/);
    await rpc('generatetoaddress', [older - 2, mine]);
    assert.equal((await accepted(early)).allowed, false, 'one block short');
    await rpc('generatetoaddress', [1, mine]);
    await spend(policy, early);
    // Same policy, fresh coin: the quorum needs no delay at all.
    const fresh = await fund(policy, 1);
    const psbt = BV.propose({ policy, utxos: [fresh], tip: fresh.height, sweep: sink, feeRate: 2 });
    await spend(policy, BV.finalize(BV.combine([B, C].map(k => BV.sign(psbt, k.signer, policy)), policy), policy));
  });

  await t.test('a delayed path needs its delay in the sequence, not just in the review', async () => {
    const policy = withDelay('signet', 5);
    const coin = await fund(policy, 1);
    const psbt = BV.propose({ policy, path: 1, utxos: [{ ...coin, height: coin.height - 5 }], tip: coin.height, sweep: sink, feeRate: 2 });
    const tx = Transaction.fromPSBT(base64.decode(psbt), { allowUnknownInputs: true });
    tx.updateInput(0, { sequence: 1 }, true);
    assert.throws(() => BV.inspect(base64.encode(tx.toPSBT()), policy), /delay/);
  });
});
