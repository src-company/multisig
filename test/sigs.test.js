// The signature bundle — what gets packed, what counts, and who it binds to.
//
//   node --test              (from the repo root; discovers every suite)
//
// Same shape as the other suites, and lifted the same way: the dapp is one HTML
// file with its script inline, so this reads that file, pulls declarations out
// by name into a sandbox, and stubs only what each one will not run without. A
// missing name throws rather than returning nothing, so a rename fails the suite
// instead of quietly deleting its coverage.
//
// Two things are being defended here, and neither of them is arithmetic.
//
// The first is that a stored signature is not evidence. add_signature() runs as
// the anon role, checks only that the address it is handed is an owner, and ends
// in ON CONFLICT DO UPDATE — so anyone at all can put a row in `signatures`
// naming any owner, and overwrite a real one with garbage. verifySigs() is the
// only thing between that table and a quorum: every stored signature is
// recovered against the proposal's own EIP-712 digest and matched to a current
// owner before it counts. Without it, a forged row shows an owner as having
// signed (which HIDES the cancel button from the owner it names, because txSt
// suppresses a brake you have already pulled) and a forged quorum draws a SUBMIT
// that reverts on chain.
//
// The second is that a bundle is a bearer instrument. Every signature in a
// forward() bundle is equally valid for Multisig.execute() — the two routes
// verify the same digest and nothing in it says which was meant — so an observer
// who copies a bundle out of the mempool can replay it down the other route.
// For a cancel that is fatal: execute() QUEUES the cancellation for the full
// delay and burns the nonce, so the real forward() reverts, the dangerous
// proposal matures first, and the brake is gone. The sender slot is what stops
// that, and packSigsBound is where it is or is not applied.
//
// Recovery itself is ethers' and is stood in for, the way deploy.test.js stands
// in for getCreate2Address — what is asserted here is this app's filtering and
// packing, not the curve. The stand-in is not a constant, though: a fake
// signature carries the address it was made by AND the digest it was made over,
// and recovery fails when the digest does not match. That is the property the
// real one has and the property everything below depends on, so it is the one
// the stand-in keeps. The EIP-712 digest is computed with the real ethers, so
// the domain and the type binding are not stood in for at all.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dapp', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

// A `const`/`let NAME = ...` one-liner, a `function NAME(...)` closed by a brace
// in column 0, or a multi-line declaration closed by `}`, `]` or `)` in column
// 0. Kept the same as classify.test.js, and the function half the same as the
// three suites before it, for the reason those files give: copies of a short
// reader are cheaper than a shared module in a repo that deliberately has no
// build step, and the day they diverge, they diverge loudly.
function grab(name) {
  const asConst = LINES.findIndex(l =>
    ['const', 'let'].some(kw => l.startsWith(`${kw} ${name} `) || l.startsWith(`${kw} ${name}=`)));
  if (asConst !== -1) {
    const line = LINES[asConst];
    if (/;\s*(\/\/.*)?$/.test(line)) return line;
    let end = asConst + 1;
    while (end < LINES.length && !/^[}\])]/.test(LINES[end])) end++;
    if (end >= LINES.length) throw new Error(`sigs.test.js: no closing line found for 'const ${name}'.`);
    return LINES.slice(asConst, end + 1).join('\n');
  }
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`sigs.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`sigs.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const NEEDED = [
  'MULTISIG_ABI', 'EIP712_DOMAIN', 'EIP712_TYPES',
  'senderSlot', 'sigSlot', 'pickSigs', 'packSigs', 'packSigsBound',
  'senderSig', 'verifySigs', 'collectSigs',
];

const OWNERS = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
  '0x4444444444444444444444444444444444444444',
];
const [A, B, C, D] = OWNERS;
const STRANGER = '0x9999999999999999999999999999999999999999';
const VAULT = '0x5555555555555555555555555555555555555555';

// A stand-in signature: 65 bytes, the length the contract insists on, carrying
// the address that made it and the digest it was made over. Recovery reads both
// back — so a signature lifted onto another proposal recovers to nothing, which
// is the one property of the real thing this suite is built on.
const fakeSig = (addr, digest) =>
  '0x' + addr.slice(2).toLowerCase() + digest.slice(2).toLowerCase() + '00'.repeat(13);

const sandbox = {
  console: { ...console, warn() {}, error() {} },
  S: { chainId: 1 },
  provider: null,
  TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
  crypto: globalThis.crypto,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dapp', 'ethers.slim.min.js'), 'utf8'), sandbox);

// The bundle exports through non-writable accessors, so `ethers.Contract` cannot
// be replaced in place. A flat copy of the same values can be, and packSigsBound
// reads the chain through exactly that one name — which is the only call in this
// suite that would otherwise need a network.
sandbox.ethers = Object.fromEntries(Object.keys(sandbox.ethers).map(k => [k, sandbox.ethers[k]]));

// The one thing stood in for. recoverCached is the app's memo around
// ethers.recoverAddress; here it reads the address and the digest back out of
// the stand-in signature and refuses when the digest is not the one asked about
// — a signature that recovers to a different address than the row claims is
// exactly what verifySigs exists to drop.
vm.runInContext(`
  function recoverCached(digest, sig) {
    if (typeof sig !== 'string' || sig.length !== 132) throw new Error('bad signature length');
    const addr = '0x' + sig.slice(2, 42);
    const over = '0x' + sig.slice(42, 106);
    if (over.toLowerCase() !== String(digest).toLowerCase()) return '0x' + 'de'.repeat(20);
    return ethers.getAddress(addr);
  }
`, sandbox);

const handOut = NEEDED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n');
vm.runInContext(NEEDED.map(grab).join('\n') + '\n' + handOut, sandbox);
for (const n of NEEDED) {
  if (sandbox[n] === undefined) throw new Error(`sigs.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}

const {
  ethers, senderSlot, sigSlot, pickSigs, packSigs, packSigsBound, senderSig,
  verifySigs, collectSigs, EIP712_DOMAIN, EIP712_TYPES,
} = sandbox;

const domain = { ...EIP712_DOMAIN, chainId: 1, verifyingContract: VAULT };
const message = (o) => Object.assign({ target: A, value: 0n, data: '0x', nonce: 3 }, o);
const digestOf = (msg) => ethers.TypedDataEncoder.hash(domain, EIP712_TYPES, msg);

const MSG = message();
const DIGEST = digestOf(MSG);
// Signed rows as they come back from the database: signer, signature, type.
const signed = (addr, d) => ({ signer: addr, sig: fakeSig(addr, d || DIGEST) });

// ── the slot the contract reads ───────────────────────────────────

test('a sender slot is 65 bytes: the owner left-padded, 32 unused, then v=0', () => {
  const slot = senderSlot(A);
  assert.equal(slot.length, 130, 'a slot that is not 65 bytes makes forward() revert on a length check');
  assert.equal(slot.slice(0, 24), '0'.repeat(24));
  assert.equal(slot.slice(24, 64), A.slice(2).toLowerCase());
  assert.equal(slot.slice(64, 128), '0'.repeat(64));
  assert.equal(slot.slice(128), '00', 'v must be 0 or the contract reads the slot as a signature');
});

test('a sender slot accepts any casing of an address, and nothing that is not one', () => {
  // `signer` comes out of an anon-writable column. Rejecting a real owner for
  // their capitalisation would fail the packing rather than the row, taking the
  // whole bundle — and with it the emergency cancel — down with it.
  const mixed = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
  assert.equal(senderSlot(mixed), senderSlot(mixed.toLowerCase()));
  assert.equal(senderSlot(mixed), senderSlot(mixed.toUpperCase().replace('0X', '0x')));
  // Anything that is not an address still throws, which is the check worth keeping.
  for (const junk of ['', 'hello', '0x1234', null, undefined, 42]) {
    assert.throws(() => senderSlot(junk), `senderSlot accepted ${JSON.stringify(junk)}`);
  }
});

test('an approval row is packed from the signer, never from the bytes stored beside it', () => {
  // The stored bytes on an approval/sender row are anon-writable and are not
  // what the contract reads anyway. Packing one verbatim put a blob of unknown
  // length into the middle of a bundle — and 65 bytes is the one thing both
  // forward() and execute() insist on, so a single mangled row made the cancel
  // route revert for every owner until somebody re-approved.
  const mangled = { signer: A, sigType: 'approval', sig: '0xdeadbeef' };
  assert.equal(sigSlot(mangled), senderSlot(A));
  assert.equal(sigSlot({ signer: A, sig_type: 'sender', signature: 'nonsense at all' }), senderSlot(A));
});

test('an ECDSA slot must be exactly 65 bytes, and names the signer when it is not', () => {
  assert.equal(sigSlot(signed(A)), fakeSig(A, DIGEST).slice(2));
  for (const bad of ['0x1234', '0x', '', null, undefined, fakeSig(A, DIGEST) + 'ff']) {
    assert.throws(() => sigSlot({ signer: A, sig: bad }), /Invalid signature length from 0x1111/,
      `sigSlot accepted a ${bad && bad.length}-char signature`);
  }
});

test('a packed bundle is the slots in order, and nothing between them', () => {
  const sigs = [signed(A), signed(B)];
  const packed = packSigs(sigs);
  assert.equal(packed, '0x' + sigSlot(sigs[0]) + sigSlot(sigs[1]));
  assert.equal((packed.length - 2) / 2, 65 * 2);
  assert.equal(packSigs([]), '0x');
});

// ── trimming a bundle to the length the route demands ─────────────

test('a bundle longer than the route asks for is trimmed, and comes back sorted', () => {
  // forward() demands exactly `required * 65` bytes, so an over-long bundle
  // reverts — and the contract walks the slots expecting strictly ascending
  // signers, so a trim that leaves them out of order reverts too.
  const sigs = [signed(D), signed(B), signed(A), signed(C)];
  const kept = pickSigs(sigs, 2, null);
  assert.equal(kept.length, 2);
  const order = kept.map(s => s.signer.toLowerCase());
  assert.deepEqual(order, [...order].sort());
});

test('trimming keeps the submitter, because their slot is what binds the bundle', () => {
  // Sorted order alone would drop D — they sort last — and with them the
  // binding, leaving a bundle anyone in the mempool could replay.
  const sigs = [signed(A), signed(B), signed(C), signed(D)];
  const kept = pickSigs(sigs, 2, D);
  assert.ok(kept.some(s => s.signer === D), 'the submitter was trimmed out of their own bundle');
  assert.equal(kept.length, 2);
  const order = kept.map(s => s.signer.toLowerCase());
  assert.deepEqual(order, [...order].sort(), 'the kept slots came back out of ascending order');
});

test('a bundle at or under the required count is left exactly as it was', () => {
  const sigs = [signed(B), signed(A)];
  assert.equal(pickSigs(sigs, 2, null), sigs);
  assert.equal(pickSigs(sigs, 5, null), sigs);
});

test('the submitter is matched however either address is cased', () => {
  const sigs = [signed(A), signed(B), signed(C)];
  const kept = pickSigs(sigs, 1, C.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(kept.map(s => s.signer), [C]);
});

// ── binding a bundle to whoever sends it ──────────────────────────

test('a bundle is bound by replacing the submitter\'s own slot, and nobody else\'s', async () => {
  const sigs = [signed(A), signed(B), signed(C)];
  const r = await packSigsBound(sigs, B, null, null);
  assert.equal(r.bound, true);
  assert.equal(r.packed, '0x' + sigSlot(sigs[0]) + senderSlot(B) + sigSlot(sigs[2]));
  // Costs nothing: the slot replaces that owner's own signature, and they are
  // the one submitting anyway.
  assert.equal((r.packed.length - 2) / 2, 65 * 3);
});

test('a bundle that cannot be bound says so, and says why, rather than looking bound', async () => {
  const sigs = [signed(A), signed(B)];
  const none = await packSigsBound(sigs, null, null, null);
  assert.equal(none.bound, false);
  assert.equal(none.why, 'NO SUBMITTER');
  assert.equal(none.packed, packSigs(sigs));

  const outsider = await packSigsBound(sigs, STRANGER, null, null);
  assert.equal(outsider.bound, false);
  assert.match(outsider.why, /NOT ONE OF THE SIGNERS/);
  assert.equal(outsider.packed, packSigs(sigs));
});

test('an on-chain approval for this hash is the one case where the slot buys nothing', async () => {
  // A v=0 slot naming an owner who has already approved the hash is usable by
  // anyone, so the binding is not a binding. Read it rather than assume — this
  // is the emergency path.
  const sigs = [signed(A), signed(B)];
  sandbox.provider = {};
  sandbox.ethers.Contract = function () { return { approved: async () => true }; };
  const r = await packSigsBound(sigs, A, VAULT, DIGEST);
  assert.equal(r.bound, false);
  assert.match(r.why, /ON-CHAIN APPROVAL/);
  assert.equal(r.packed, packSigs(sigs));
});

test('a chain that will not answer binds anyway, because the worst case is a revert', async () => {
  const sigs = [signed(A), signed(B)];
  sandbox.provider = {};
  sandbox.ethers.Contract = function () { return { approved: async () => { throw new Error('rpc down'); } }; };
  const r = await packSigsBound(sigs, A, VAULT, DIGEST);
  assert.equal(r.bound, true, 'an unreadable chain dropped the binding instead of keeping it');
  assert.equal(r.packed, '0x' + senderSlot(A) + sigSlot(sigs[1]));
});

// ── which stored signatures count ─────────────────────────────────

test('a signature is counted only when it recovers to the owner the row names', () => {
  const good = signed(A);
  // The row names B; the bytes were made by A. This is what an overwritten row
  // looks like, and what a forged one looks like.
  const lying = { signer: B, sig: fakeSig(A, DIGEST) };
  const out = verifySigs([good, lying], domain, EIP712_TYPES, MSG, OWNERS);
  assert.deepEqual(out.map(s => s.signer), [A]);
});

test('a signature made over another proposal does not count for this one', () => {
  // The whole point of hashing the proposal: a real signature, honestly stored,
  // lifted onto a different target / value / calldata / nonce.
  const other = digestOf(message({ target: STRANGER, nonce: 4 }));
  const lifted = { signer: A, sig: fakeSig(A, other) };
  assert.deepEqual(verifySigs([lifted], domain, EIP712_TYPES, MSG, OWNERS), []);
  // And the same bytes over the message they were actually made for do count.
  assert.equal(verifySigs([lifted], domain, EIP712_TYPES, message({ target: STRANGER, nonce: 4 }), OWNERS).length, 1);
});

test('the digest is bound to the chain and to the vault, not just to the call', () => {
  // Same proposal, different chain or different verifyingContract — a signature
  // from one must not count on the other, or a bundle collected for a vault on
  // one chain would execute against its clone on another.
  const elsewhere = { ...EIP712_DOMAIN, chainId: 8453, verifyingContract: VAULT };
  const otherVault = { ...EIP712_DOMAIN, chainId: 1, verifyingContract: STRANGER };
  assert.notEqual(ethers.TypedDataEncoder.hash(elsewhere, EIP712_TYPES, MSG), DIGEST);
  assert.notEqual(ethers.TypedDataEncoder.hash(otherVault, EIP712_TYPES, MSG), DIGEST);
  assert.deepEqual(verifySigs([signed(A)], elsewhere, EIP712_TYPES, MSG, OWNERS), []);
  assert.deepEqual(verifySigs([signed(A)], otherVault, EIP712_TYPES, MSG, OWNERS), []);
});

test('a signature from somebody who is not an owner does not count', () => {
  assert.deepEqual(verifySigs([signed(STRANGER)], domain, EIP712_TYPES, MSG, OWNERS), []);
});

test('an owner counts once, however many rows name them', () => {
  const out = verifySigs([signed(A), signed(A), signed(A), signed(B)], domain, EIP712_TYPES, MSG, OWNERS);
  assert.equal(out.length, 2, 'one owner was counted more than once towards the threshold');
});

test('an owner set is matched case-blind, in both directions', () => {
  const upperOwners = OWNERS.map(o => o.toUpperCase().replace('0X', '0x'));
  assert.equal(verifySigs([signed(A)], domain, EIP712_TYPES, MSG, upperOwners).length, 1);
  const upperRow = { signer: A.toUpperCase().replace('0X', '0x'), sig: fakeSig(A, DIGEST) };
  assert.equal(verifySigs([upperRow], domain, EIP712_TYPES, MSG, OWNERS).length, 1);
});

test('an approval row is trusted for the owner it names, and for nobody else', () => {
  // These are on-chain facts the contract validates; the bytes stored beside
  // them are not read. But the address still has to be an owner.
  const mine = { signer: A, sigType: 'approval', sig: '0xgarbage' };
  const theirs = { signer: STRANGER, sigType: 'approval', sig: '0xgarbage' };
  const out = verifySigs([mine, theirs], domain, EIP712_TYPES, MSG, OWNERS);
  assert.deepEqual(out.map(s => s.signer), [A]);
});

test('an approval row does not let the same owner be counted twice', () => {
  const out = verifySigs(
    [signed(A), { signer: A, sigType: 'approval', sig: '0x' }], domain, EIP712_TYPES, MSG, OWNERS);
  assert.equal(out.length, 1);
});

test('a row whose signer is not a string costs that row its signature and nothing else', () => {
  // This check sits OUTSIDE the per-signature try on purpose. `signer` comes
  // from a row the anon role writes, and a non-string one used to throw out of
  // verifySigs, out of loadVaultQueue, and out of the queue for every other
  // proposal on the vault along with it.
  const rows = [{ signer: 42, sig: fakeSig(A, DIGEST) }, { signer: null }, null, undefined,
                { signer: { toLowerCase: () => A } }, signed(B)];
  const out = verifySigs(rows, domain, EIP712_TYPES, MSG, OWNERS);
  assert.deepEqual(out.map(s => s.signer), [B]);
});

test('a signature of the wrong shape costs that row and nothing else', () => {
  const rows = [{ signer: A, sig: '0x' }, { signer: B, sig: null }, { signer: C, sig: 12345 }, signed(D)];
  const out = verifySigs(rows, domain, EIP712_TYPES, MSG, OWNERS);
  assert.deepEqual(out.map(s => s.signer), [D]);
});

test('a message that cannot be hashed verifies nothing, and still returns', () => {
  // A proposal no digest can be computed for is a proposal no signature over it
  // can be checked against. The per-signature version of this threw inside the
  // loop and reported every signature invalid — same outcome, said N times.
  const unhashable = { target: 'not-an-address', value: 0n, data: '0x', nonce: 0 };
  assert.deepEqual(verifySigs([signed(A)], domain, EIP712_TYPES, unhashable, OWNERS), []);
  // An on-chain approval needs no digest, so it survives one that cannot be made.
  const approval = { signer: A, sigType: 'approval', sig: '0x' };
  assert.deepEqual(
    verifySigs([approval], domain, EIP712_TYPES, unhashable, OWNERS).map(s => s.signer), [A]);
});

test('an empty owner set verifies nothing, rather than everything', () => {
  assert.deepEqual(verifySigs([signed(A)], domain, EIP712_TYPES, MSG, []), []);
});

// ── what gets collected for a send ────────────────────────────────

test('collecting adds the caller\'s own sender slot when they are an owner who has not signed', () => {
  const tx = { target: A, rawValue: '0', callData: '0x', nonce: 3, signatures: [signed(B)] };
  const v = { address: VAULT, owners: OWNERS.map(a => ({ addr: a })) };
  const { sigs } = collectSigs(tx, v, C);
  assert.deepEqual(sigs.map(s => s.signer.toLowerCase()), [B, C].map(x => x.toLowerCase()).sort());
  const mine = sigs.find(s => s.signer === C);
  assert.equal(mine.sigType, 'sender');
  assert.equal(mine.sig, senderSig(C));
});

test('collecting does not add a slot for a caller who is not an owner', () => {
  const tx = { target: A, rawValue: '0', callData: '0x', nonce: 3, signatures: [signed(B)] };
  const v = { address: VAULT, owners: OWNERS.map(a => ({ addr: a })) };
  const { sigs } = collectSigs(tx, v, STRANGER);
  assert.deepEqual(sigs.map(s => s.signer), [B]);
});

test('collecting does not add a second slot for a caller who already signed', () => {
  const tx = { target: A, rawValue: '0', callData: '0x', nonce: 3, signatures: [signed(B)] };
  const v = { address: VAULT, owners: OWNERS.map(a => ({ addr: a })) };
  const { sigs } = collectSigs(tx, v, B);
  assert.equal(sigs.length, 1);
  assert.notEqual(sigs[0].sigType, 'sender');
});

test('collected slots come back in strictly ascending signer order', () => {
  // The contract walks the slots expecting exactly that, so an unsorted bundle
  // reverts however valid every signature in it is.
  const tx = {
    target: A, rawValue: '0', callData: '0x', nonce: 3,
    signatures: [signed(D), signed(B), signed(A)],
  };
  const v = { address: VAULT, owners: OWNERS.map(a => ({ addr: a })) };
  const { sigs } = collectSigs(tx, v, C);
  const order = sigs.map(s => s.signer.toLowerCase());
  assert.deepEqual(order, [...order].sort());
  assert.equal(order.length, 4);
});

test('collecting reads the owner set the chain reported, in preference to the record', () => {
  // loadedOwners is what getOwners() returned. `owners` is the local record,
  // and a signature counted against a stale one is a signature the vault will
  // reject at execute time.
  const tx = { target: A, rawValue: '0', callData: '0x', nonce: 3, signatures: [signed(B), signed(C)] };
  const v = { address: VAULT, owners: OWNERS.map(a => ({ addr: a })), loadedOwners: [A, B] };
  const { sigs, ownerAddrs } = collectSigs(tx, v, A);
  assert.deepEqual(ownerAddrs, [A, B]);
  assert.deepEqual(sigs.map(s => s.signer.toLowerCase()).sort(), [A.toLowerCase(), B.toLowerCase()]);
});

test('a sender signature is the same 65 bytes a sender slot is', () => {
  assert.equal('0x' + senderSlot(A), senderSig(A));
});
