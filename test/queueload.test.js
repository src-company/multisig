// What the queue believes, and what it makes the vault prove first.
//
//   node --test              (from the repo root; discovers every suite)
//
// Same shape as the other suites, and lifted the same way: the dapp is one HTML
// file with its script inline, so this reads that file, pulls declarations out
// by name into a sandbox, and stubs only what each one will not run without. A
// missing name throws rather than returning nothing, so a rename fails the suite
// instead of quietly deleting its coverage.
//
// Every other suite here asks whether a function computes the right answer from
// its arguments. This one asks something else: which of two disagreeing sources
// the queue believes. Because they do disagree, and one of them is writable by
// anybody with curl.
//
// The coordination database authenticates by assertion. propose_tx, cancel_tx,
// prune_tx, mark_executed, mark_queued and add_signature all run as the anon
// role and check `is_wallet_owner(wallet, p_caller)` against a string the caller
// supplies — and an owner's address is public, on chain and in an anon-readable
// table. PostgREST has no session and Postgres cannot recover a secp256k1
// signature, so `p_caller` can never be more than a claim. That is not a bug to
// be fixed in the schema; it is the shape of a coordination layer with no
// accounts. It leaves three attacks, and this file is about all three:
//
//   plant     One HTTP request puts a row in the queue naming any owner as its
//             author. It cannot be signed into existence — every signature is
//             recovered against the row's own digest — but it renders, and a
//             plausible proposal sitting beside the real ones only has to hold
//             up for as long as it takes somebody to press SIGN.
//
//   bury      One HTTP request flips a live proposal to cancelled or executed.
//             dbGetPending filters on status, so it leaves every owner's queue
//             while it sits on chain, maturing, executable by anyone once it
//             matures. This is the dangerous direction: the brake disappears
//             from the interface that was going to pull it.
//
//   forge     One HTTP request marks any owner as having approved anything —
//             add_signature takes an `approval` row on trust because "the
//             contract validates those". It does, at execute time. Nothing
//             validates it here. A forged quorum shows a SUBMIT that reverts;
//             a forged "signed by you" HIDES the cancel button from the owner
//             it names, because txSt suppresses a brake you have already pulled.
//
// The answer to all three is the same and it is the reason this file exists: ask
// the vault. So the fixture below is not a mock of the database — the rows are
// whatever a test says they are, exactly as an attacker would have them — it is
// a mock of the CHAIN, and each test reads as "the vault is holding these, and
// confirms these approvals; now what does the queue show?"
//
// Which makes the asymmetry the thing to watch. Under-believing the chain is
// cheap: an owner shown as un-signed re-signs, and the row repairs itself. Over-
// believing it is not, and neither is treating an unreachable RPC as evidence.
// Several tests below exist only to pin the direction of a failure.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dapp', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

// A `const`/`let NAME = ...` one-liner, a `function NAME(...)` closed by a brace
// in column 0, or a multi-line declaration closed by `}`, `]` or `)` in column
// 0. Kept the same as the suites beside it, for the reason they give: copies of
// a short reader are cheaper than a shared module in a repo that deliberately
// has no build step, and the day they diverge, they diverge loudly.
function grab(name) {
  const asConst = LINES.findIndex(l =>
    ['const', 'let'].some(kw => l.startsWith(`${kw} ${name} `) || l.startsWith(`${kw} ${name}=`)));
  if (asConst !== -1) {
    const line = LINES[asConst];
    if (/;\s*(\/\/.*)?$/.test(line)) return line;
    let end = asConst + 1;
    while (end < LINES.length && !/^[}\])]/.test(LINES[end])) end++;
    if (end >= LINES.length) throw new Error(`queueload.test.js: no closing line found for 'const ${name}'.`);
    return LINES.slice(asConst, end + 1).join('\n');
  }
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`queueload.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`queueload.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const NEEDED = [
  'MULTISIG_ABI', 'msIface', 'ERC20_ABI', 'erc20Iface', 'SLOW_ABI', 'slowIface',
  'TIMELOCK_EXECUTOR_ABI', 'tlIface', 'WEINS_ABI', 'weinsIface', 'wnsRegIface',
  'SEL', 'SEL_RE', 'selOf', 'SELECTOR_LABELS', 'selectorToLabel',
  'EIP712_DOMAIN', 'EIP712_TYPES',
  '_ESC', '_escOne', 'esc', 'weiStr', 'bigOr0', 'groupInt', '_amtTrim', '_amtDisp',
  'fmtAmount', 'DECIMALS', 'stripCommas',
  'WSTETH_ADDRESS', 'isStakeCall', 'STAKE_CHAIN_ID',
  // The token tables carry their icons inline, so the icons come too. They are
  // markup this suite never looks at — lifted because PROD_TOKENS does not
  // evaluate without them, and a stubbed table would mean the display figures
  // below were checked against this file's idea of USDC's decimals.
  'MEGA_M', 'MEGA_DOT_R', 'MEGA_DOT_L', 'MEGA_RING',
  'ETH_ICON', 'USDC_ICON', 'USDT_ICON', 'USDM_ICON', 'DAI_ICON',
  'WBTC_ICON', 'CBBTC_ICON', 'WSTETH_ICON', 'MEGA_ICON',
  'ETH_ONLY', 'PROD_TOKENS',
  'TERMINAL_RECHECK', 'verifySigs',
  // the subjects
  'proposalDigest', 'approvalPairsFor', 'chainCheckQueue', 'sigsFor', 'loadVaultQueue',
];

const VAULT = '0x5555555555555555555555555555555555555555';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const OWNERS = [A, B, C];
const STRANGER = '0x9999999999999999999999999999999999999999';

// A stand-in signature, as in sigs.test.js: 65 bytes carrying the address that
// made it and the digest it was made over. Recovery reads both back, so a
// signature lifted onto another proposal recovers to nobody — which is the one
// property of the real thing every assertion below rests on.
const fakeSig = (addr, digest) =>
  '0x' + addr.slice(2).toLowerCase() + digest.slice(2).toLowerCase() + '00'.repeat(13);

// ── the chain ─────────────────────────────────────────────────────
// What the vault would answer, per test. `queued` maps a digest to its eta —
// absent means the read is fine and the vault says zero, which is the vault
// positively disclaiming a proposal. `down` is the other thing entirely: the
// read did not happen, which must never be read as a disclaimer.
// `fail` is the third state, and the one that is easy to forget: aggregate3 is
// sent with allowFailure:true, so a single sub-call can come back unsuccessful
// while the batch as a whole succeeds. A hash in here answers {success:false}.
const chain = { queued: new Map(), approved: new Set(), fail: new Set(), down: false, calls: 0 };
const resetChain = () => { chain.queued = new Map(); chain.approved = new Set(); chain.fail = new Set(); chain.down = false; chain.calls = 0; };

const sandbox = {
  console: { ...console, warn() {}, error() {} },
  S: { chainId: 1, vaults: [], demoMode: false },
  provider: {},
  render: () => {},
  lsGet: () => null,
  _ctokMemo: {},
  customTokensFor: () => [],
  TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
  crypto: globalThis.crypto,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dapp', 'ethers.slim.min.js'), 'utf8'), sandbox);

// Recovery is ethers' and is stood in for, exactly as in sigs.test.js — what is
// asserted here is which rows this app counts, not the curve.
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
  if (sandbox[n] === undefined) throw new Error(`queueload.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}

const { ethers, msIface, proposalDigest, approvalPairsFor, chainCheckQueue, loadVaultQueue,
        EIP712_DOMAIN, EIP712_TYPES } = sandbox;

// The vault, answering the two questions chainCheckQueue puts to it. Deliberately
// the real aggregate3 shape — {success, returnData} — decoded by the real
// msIface, so a change to either call's ABI fails here rather than silently
// returning nothing.
sandbox.getMC3 = () => ({
  aggregate3: async (calls) => {
    chain.calls++;
    if (chain.down) throw new Error('rpc unreachable');
    return calls.map(c => {
      const sel = c.callData.slice(0, 10);
      try {
        if (sel === msIface.getFunction('queued').selector) {
          const [h] = msIface.decodeFunctionData('queued', c.callData);
          // A failed sub-call still carries bytes — aggregate3 hands back the
          // revert data — and those bytes can decode. Answering '0x' here would
          // make the decode throw and the `success` check redundant, so the
          // stand-in returns exactly what a caller ignoring `success` would most
          // like to believe: zero, which reads as the vault disclaiming it.
          if (chain.fail.has(h.toLowerCase()))
            return { success: false, returnData: msIface.encodeFunctionResult('queued', [0]) };
          return { success: true, returnData: msIface.encodeFunctionResult('queued', [chain.queued.get(h.toLowerCase()) || 0]) };
        }
        const [signer, h] = msIface.decodeFunctionData('approved', c.callData);
        // Same again, in the direction that costs something: bytes that decode
        // to `true`, so a caller that skips the `success` check confirms an
        // approval the vault never gave.
        if (chain.fail.has(signer.toLowerCase() + '|' + h.toLowerCase()))
          return { success: false, returnData: msIface.encodeFunctionResult('approved', [true]) };
        const ok = chain.approved.has(signer.toLowerCase() + '|' + h.toLowerCase());
        return { success: true, returnData: msIface.encodeFunctionResult('approved', [ok]) };
      } catch (_) { return { success: false, returnData: '0x' }; }
    });
  },
});

// ── the database, answering whatever a test wants it to ───────────
const db = { pending: [], terminal: [], pruned: [] };
sandbox.dbGetPending = async () => ({ rows: db.pending, sigs: true });
sandbox.dbGetRecentTerminal = async () => ({ rows: db.terminal, sigs: true });
sandbox.dbGetSigsByTxIds = async () => new Map();
sandbox.dbPruneTx = async (id) => { db.pruned.push(id); };

const vault = (o) => Object.assign({
  dbId: 'w1', address: VAULT, chain: 'ETHEREUM', threshold: 2, ownerCount: 3,
  nonce: 5, delay: 86400, executor: '0x00000000a72A30AdBf38e14d36BCE2610ec3973F',
  owners: OWNERS.map(a => ({ addr: a })), loadedOwners: [...OWNERS],
  queue: [], history: [], holdings: [],
}, o);

// A row as PostgREST hands it back — snake_case, `value` a numeric-as-string.
let _id = 0;
const row = (o) => Object.assign({
  id: 'tx' + (++_id), nonce: 4, target: A, value: '0', call_data: '0x',
  status: 'proposed', description: null, eta: 0, signatures: [],
}, o);

const digestFor = (v, t) => ethers.TypedDataEncoder.hash(
  { ...EIP712_DOMAIN, chainId: 1, verifyingContract: v.address }, EIP712_TYPES,
  { target: t.target, value: BigInt(t.value), data: t.call_data || '0x', nonce: t.nonce });

// Sign `t` as `who`, the way an honest client would.
const sign = (v, t, who) => ({ signer: who, signature: fakeSig(who, digestFor(v, t)), sig_type: 'ecdsa' });

// Run one load and hand back the queue it produced.
async function load(v, { pending = [], terminal = [], you = A } = {}) {
  db.pending = pending; db.terminal = terminal; db.pruned = [];
  sandbox.S.vaults = [v];
  sandbox.window._connectedAddress = you;
  await loadVaultQueue(0);
  return v.queue;
}

// ── the digest a proposal is judged by ────────────────────────────

test('a proposal is hashed from its own fields, never from the hash stored beside them', () => {
  // tx_hash is written by the same anon-callable propose_tx as the rest of the
  // row and is never checked against it — and it is what a cancel is built
  // around. Deriving the digest is the whole reason a planted row cannot name
  // itself as something the vault is holding.
  const v = vault();
  const t = row({ target: B, value: '1000', call_data: '0x', nonce: 4, tx_hash: '0x' + 'ff'.repeat(32) });
  const d = proposalDigest(v, t);
  assert.equal(d, digestFor(v, t));
  assert.notEqual(d, t.tx_hash);
});

test('a row that cannot produce a digest produces null, not a guess', () => {
  const v = vault();
  // A value the vault could never execute, and a target that is not an address.
  assert.equal(proposalDigest(v, row({ value: '1.5' })), null);
  assert.equal(proposalDigest(v, row({ value: '-1' })), null);
  assert.equal(proposalDigest(v, row({ target: 'not-an-address' })), null);
  assert.equal(proposalDigest(v, row({ call_data: 'not-hex' })), null);
  // And a vault with no usable address cannot judge anything.
  assert.equal(proposalDigest({ address: 'nope' }, row()), null);
  assert.equal(proposalDigest(null, row()), null);
});

test('the digest carries the chain, so a row cannot be judged against another chain\'s vault', () => {
  const v = vault();
  const t = row();
  const here = proposalDigest(v, t);
  sandbox.S.chainId = 8453;
  const there = proposalDigest(v, t);
  sandbox.S.chainId = 1;
  assert.notEqual(here, there);
});

// ── which approval claims are worth asking about ──────────────────

test('only approval and sender rows are put to the vault, and only for a hashable proposal', () => {
  const v = vault();
  const t1 = row({ id: 'a' }), t2 = row({ id: 'b', value: '1.5' });
  const sigMap = new Map([
    ['a', [{ signer: A, sig_type: 'approval' }, { signer: B, sig_type: 'ecdsa' },
           { signer: C, sig_type: 'sender' }, { signer: 'not-an-address', sig_type: 'approval' },
           { signer: null, sig_type: 'approval' }]],
    ['b', [{ signer: A, sig_type: 'approval' }]],
  ]);
  const digests = new Map([['a', proposalDigest(v, t1)], ['b', proposalDigest(v, t2)]]);
  const pairs = approvalPairsFor([t1, t2], sigMap, digests);
  // An ECDSA row is checked by recovery, not by the chain. A row whose signer is
  // not an address cannot be asked about. A row with no digest has nothing to
  // ask about. That leaves exactly two.
  assert.deepEqual(pairs.map(p => p.signer), [A, C]);
  assert.ok(pairs.every(p => p.id === 'a' && p.hash === digests.get('a')));
});

// ── what the vault is asked, and what a silent chain means ────────

test('the vault answers both questions in one round trip', async () => {
  resetChain();
  const v = vault();
  const t = row();
  const h = proposalDigest(v, t);
  chain.queued.set(h.toLowerCase(), 1234);
  chain.approved.add(A.toLowerCase() + '|' + h.toLowerCase());
  const out = await chainCheckQueue(v, [{ id: t.id, hash: h }], [{ id: t.id, hash: h, signer: A }]);
  assert.equal(chain.calls, 1, 'the queue asked the chain more than once for one load');
  assert.equal(out.queued[t.id], 1234);
  assert.ok(out.approved.has(t.id + '|' + A.toLowerCase()));
});

test('an approval the vault does not confirm is not an approval', async () => {
  resetChain();
  const v = vault();
  const t = row();
  const h = proposalDigest(v, t);
  const out = await chainCheckQueue(v, [], [{ id: t.id, hash: h, signer: A }]);
  assert.equal(out.approved.size, 0);
});

test('a chain that cannot be reached confirms nothing and disclaims nothing', async () => {
  // Both halves matter, and the second more. An empty `queued` means nothing is
  // pruned — an unreachable RPC is not evidence that a proposal has gone.
  resetChain();
  chain.down = true;
  const v = vault();
  const t = row();
  const h = proposalDigest(v, t);
  const out = await chainCheckQueue(v, [{ id: t.id, hash: h }], [{ id: t.id, hash: h, signer: A }]);
  assert.deepEqual(out.queued, {});
  assert.equal(out.approved.size, 0);
  assert.ok(!(t.id in out.queued), 'a failed read left an entry that would read as a disclaimer');
});

test('a vault with nothing to ask about does not ask', async () => {
  resetChain();
  const out = await chainCheckQueue(vault(), [], []);
  assert.equal(chain.calls, 0);
  assert.deepEqual(out.queued, {});
});

test('a vault with no usable address asks nothing rather than asking about nothing', async () => {
  resetChain();
  const out = await chainCheckQueue({ address: 'nope' }, [{ id: 'x', hash: '0x' + '11'.repeat(32) }], []);
  assert.equal(chain.calls, 0);
  assert.deepEqual(out.queued, {});
});

// ── plant: a row nobody can be shown to have raised ───────────────

test('a planted proposal with no valid signature, that the vault disclaims, is not shown', async () => {
  resetChain();
  const v = vault();
  const planted = row({ nonce: 6, target: STRANGER, value: '1000000000000000000' });
  const q = await load(v, { pending: [planted] });
  assert.deepEqual(q.map(t => t.nonce), [], 'a forged row rendered in the queue');
});

test('one owner signature is enough to show it, because then it is not forged', async () => {
  resetChain();
  const v = vault();
  const real = row({ nonce: 6 });
  real.signatures = [sign(v, real, A)];
  const q = await load(v, { pending: [real] });
  assert.deepEqual(q.map(t => t.nonce), [6]);
  assert.equal(q[0].approvals[A], true);
});

test('a signature from a stranger does not make a planted row real', async () => {
  resetChain();
  const v = vault();
  const planted = row({ nonce: 6 });
  planted.signatures = [sign(v, planted, STRANGER)];
  const q = await load(v, { pending: [planted] });
  assert.deepEqual(q.map(t => t.nonce), []);
});

test('a signature lifted off another proposal does not make a planted row real', async () => {
  resetChain();
  const v = vault();
  const other = row({ nonce: 9, target: C });
  const planted = row({ nonce: 6 });
  // A genuine signature by a genuine owner — over a different proposal.
  planted.signatures = [{ signer: A, signature: fakeSig(A, digestFor(v, other)), sig_type: 'ecdsa' }];
  const q = await load(v, { pending: [planted] });
  assert.deepEqual(q.map(t => t.nonce), []);
});

test('an unsigned proposal the vault IS holding is shown, because it is real', async () => {
  // The only thing that hides a row is the chain positively disclaiming it AND
  // nobody having signed. A queued proposal is executable by anyone the moment
  // it matures, and its signatures can be deleted by the same anonymous request
  // that wrote the row — so a queued one is shown whatever the signatures say.
  resetChain();
  const v = vault();
  const t = row({ nonce: 4, status: 'queued' });
  chain.queued.set(proposalDigest(v, t).toLowerCase(), 99999);
  const q = await load(v, { pending: [t] });
  assert.deepEqual(q.map(t => t.nonce), [4]);
});

test('an unsigned proposal is shown when the chain could not be asked at all', async () => {
  // The one direction that must never be taken is hiding a live proposal on the
  // strength of a failed read.
  resetChain();
  chain.down = true;
  const v = vault();
  const t = row({ nonce: 6 });
  const q = await load(v, { pending: [t] });
  assert.deepEqual(q.map(t => t.nonce), [6], 'an unreachable chain hid a proposal');
});

// ── bury: a live proposal flipped to retired ──────────────────────

test('a retired row the vault still holds queued comes back, flagged', async () => {
  // One anonymous request flips a live proposal to cancelled and it leaves every
  // owner's queue while it sits on chain, maturing. The vault is asked about the
  // retired rows in the same call as the live ones, and anything it still holds
  // goes back.
  resetChain();
  const v = vault();
  const buried = row({ nonce: 3, status: 'cancelled' });
  chain.queued.set(proposalDigest(v, buried).toLowerCase(), 88888);
  const q = await load(v, { terminal: [buried] });
  assert.deepEqual(q.map(t => t.nonce), [3]);
  assert.equal(q[0].eta, 88888, 'the eta came from the record rather than from the vault');
  // orphanedFrom is the whole signal on the card, and it is the only field that
  // distinguishes this from an ordinary queued proposal — the entry carries no
  // `status` of its own, deliberately: nothing else about the proposal is
  // treated differently, because nothing else about it is different.
  assert.equal(q[0].orphanedFrom, 'cancelled', 'the row came back without saying what it had been flipped to');
});

test('a genuinely retired row stays retired', async () => {
  resetChain();
  const v = vault();
  const done = row({ nonce: 3, status: 'executed' });
  const q = await load(v, { terminal: [done] });
  assert.deepEqual(q.map(t => t.nonce), []);
});

test('a retired row at or above the live nonce is not even asked about', async () => {
  // Queueing runs through execute(), which consumes the nonce before it writes
  // the entry, so anything still held has a nonce strictly below the live one.
  // A retired row at or above it was never queued and cannot be.
  resetChain();
  const v = vault({ nonce: 5 });
  const above = row({ nonce: 5, status: 'executed' });
  chain.queued.set(proposalDigest(v, above).toLowerCase(), 77777);
  const q = await load(v, { terminal: [above] });
  assert.deepEqual(q.map(t => t.nonce), [], 'a row the vault cannot be holding was resurrected anyway');
});

test('a proposal behind the live nonce is pruned only when the vault disclaims it', async () => {
  resetChain();
  const v = vault({ nonce: 5 });
  const stale = row({ nonce: 2, status: 'proposed' });
  stale.signatures = [sign(v, stale, A)];
  const q = await load(v, { pending: [stale] });
  assert.deepEqual(q.map(t => t.nonce), []);
  assert.deepEqual(db.pruned, [stale.id], 'a consumed nonce was left in the queue');
});

test('a proposal behind the live nonce that the vault still holds is kept, and re-flagged', async () => {
  // `status` is written on the word of a caller-supplied address like everything
  // else here. Flipping one live proposal back to 'proposed' used to take it out
  // of every owner's queue while it sat on chain, maturing, executable by anyone.
  resetChain();
  const v = vault({ nonce: 5 });
  const t = row({ nonce: 2, status: 'proposed' });
  chain.queued.set(proposalDigest(v, t).toLowerCase(), 55555);
  const q = await load(v, { pending: [t] });
  assert.deepEqual(q.map(x => x.nonce), [2]);
  assert.equal(q[0].orphanedFrom, 'proposed', 'the row came back without saying it had been flipped');
  assert.equal(q[0].eta, 55555);
  assert.deepEqual(db.pruned, []);
});

test('a queued row the vault no longer holds is pruned', async () => {
  resetChain();
  const v = vault();
  const t = row({ nonce: 4, status: 'queued', eta: 12345 });
  t.signatures = [sign(v, t, A), sign(v, t, B)];
  const q = await load(v, { pending: [t] });     // chain.queued empty -> queued() == 0
  assert.deepEqual(q.map(x => x.nonce), []);
  assert.deepEqual(db.pruned, [t.id]);
});

test('the eta on the card is the vault\'s, not the record\'s', async () => {
  resetChain();
  const v = vault();
  const t = row({ nonce: 4, status: 'queued', eta: 111 });
  t.signatures = [sign(v, t, A)];
  chain.queued.set(proposalDigest(v, t).toLowerCase(), 222);
  const q = await load(v, { pending: [t] });
  assert.equal(q[0].eta, 222);
});

// ── forge: an approval nobody made ────────────────────────────────

test('an approval row the vault does not confirm is dropped before it can count', async () => {
  resetChain();
  const v = vault();
  const t = row({ nonce: 6 });
  t.signatures = [{ signer: A, signature: '0x', sig_type: 'approval' },
                  { signer: B, signature: '0x', sig_type: 'approval' }];
  const q = await load(v, { pending: [t] });
  // Nothing confirmed and nothing signed, and the vault disclaims it — so it is
  // a plant, and it does not render at all.
  assert.deepEqual(q.map(x => x.nonce), []);
});

test('an approval the vault does confirm counts, and shows as that owner\'s', async () => {
  resetChain();
  const v = vault();
  const t = row({ nonce: 6 });
  const h = proposalDigest(v, t);
  t.signatures = [{ signer: A, signature: '0x', sig_type: 'approval' }];
  chain.approved.add(A.toLowerCase() + '|' + h.toLowerCase());
  const q = await load(v, { pending: [t] });
  assert.deepEqual(q.map(x => x.nonce), [6]);
  assert.equal(q[0].approvals[A], true);
});

test('a forged approval cannot lift a proposal to a quorum it does not have', async () => {
  resetChain();
  const v = vault({ threshold: 2 });
  const t = row({ nonce: 6 });
  const h = proposalDigest(v, t);
  // One real signature, two forged approval rows claiming the other owners.
  t.signatures = [sign(v, t, A),
                  { signer: B, signature: '0x', sig_type: 'approval' },
                  { signer: C, signature: '0x', sig_type: 'sender' }];
  chain.approved.add(A.toLowerCase() + '|' + h.toLowerCase());   // irrelevant: A signed properly
  const q = await load(v, { pending: [t] });
  assert.equal(Object.values(q[0].approvals).filter(Boolean).length, 1,
    'a forged approval row was counted towards the threshold');
  assert.equal(q[0].approvals[B], false);
  assert.equal(q[0].approvals[C], false);
});

// ── the rows that cannot be read at all ───────────────────────────

test('a row with an unusable value is skipped without taking the queue with it', async () => {
  // `value` is numeric on an anon-writable table: 1.5, -1 and 1e40 all fit, and
  // every render path hands it to BigInt(). One such row used to empty the whole
  // queue on load.
  resetChain();
  const v = vault();
  const good1 = row({ nonce: 6 }); good1.signatures = [sign(v, good1, A)];
  const bad = row({ nonce: 7, value: '1.5' });
  const good2 = row({ nonce: 8 }); good2.signatures = [sign(v, good2, A)];
  const q = await load(v, { pending: [good1, bad, good2] });
  assert.deepEqual(q.map(t => t.nonce), [6, 8]);
});

test('a row that cannot be hashed is skipped, and never falls back to its stored hash', async () => {
  resetChain();
  const v = vault();
  const good = row({ nonce: 6 }); good.signatures = [sign(v, good, A)];
  const unhashable = row({ nonce: 7, target: 'not-an-address', tx_hash: '0x' + 'ab'.repeat(32) });
  const q = await load(v, { pending: [good, unhashable] });
  assert.deepEqual(q.map(t => t.nonce), [6]);
});

test('a signature row that cannot name a signer costs that row and nothing else', async () => {
  resetChain();
  const v = vault();
  const t = row({ nonce: 6 });
  t.signatures = [{ signer: 42, signature: 'x', sig_type: 'ecdsa' }, sign(v, t, A)];
  const q = await load(v, { pending: [t] });
  assert.deepEqual(q.map(x => x.nonce), [6]);
  assert.equal(q[0].approvals[A], true);
});

test('a vault with no database record loads nothing rather than throwing', async () => {
  resetChain();
  const v = vault({ dbId: null });
  sandbox.S.vaults = [v];
  await loadVaultQueue(0);
  assert.deepEqual(v.queue, []);
  // And an index pointing at no vault at all, which happens for a paint between
  // vaults.
  await loadVaultQueue(9);
});

// ── companions: the brake, and the forged brake ───────────────────

test('a cancel companion counts only the signatures made over its own digest', async () => {
  resetChain();
  const v = vault({ nonce: 5, threshold: 2 });
  const t = row({ nonce: 4, status: 'queued' });
  t.signatures = [sign(v, t, A)];
  chain.queued.set(proposalDigest(v, t).toLowerCase(), 66666);
  // The companion: a self-call carrying cancelQueued, at the LIVE nonce.
  const companion = row({
    nonce: 5, target: VAULT, value: '0',
    call_data: msIface.encodeFunctionData('cancelQueued', ['0x' + 'ab'.repeat(32)]),
    description: 'Cancel #4',
  });
  companion.signatures = [sign(v, companion, A), sign(v, companion, B)];
  const q = await load(v, { pending: [t, companion] });
  assert.deepEqual(q.map(x => x.nonce), [4], 'the companion rendered as a proposal of its own');
  assert.equal(q[0].cancelSigners.size, 2);
});

test('a forged cancel companion signs for nobody', async () => {
  // Anyone can create the companion row; nobody can put a signature in it that
  // this does not check. A forged "signed by you" would HIDE the cancel button
  // from the owner it names.
  resetChain();
  const v = vault({ nonce: 5, threshold: 2 });
  const t = row({ nonce: 4, status: 'queued' });
  t.signatures = [sign(v, t, A)];
  chain.queued.set(proposalDigest(v, t).toLowerCase(), 66666);
  const companion = row({
    nonce: 5, target: VAULT, value: '0',
    call_data: msIface.encodeFunctionData('cancelQueued', ['0x' + 'ab'.repeat(32)]),
    description: 'Cancel #4',
  });
  // Rows naming every owner, with bytes nobody made.
  companion.signatures = OWNERS.map(o => ({ signer: o, signature: '0x' + 'ee'.repeat(65), sig_type: 'ecdsa' }));
  const q = await load(v, { pending: [t, companion] });
  assert.equal(q[0].cancelSigners?.size || 0, 0, 'a forged companion advertised a quorum that does not exist');
});

test('a companion at the wrong nonce is unusable, however well signed', async () => {
  // All three companion flows run through executor.forward(), which hashes
  // against the LIVE nonce — so a companion anywhere else could never be
  // packed, and advertising it would promise a brake that cannot be pulled.
  resetChain();
  const v = vault({ nonce: 5, threshold: 2 });
  const t = row({ nonce: 4, status: 'queued' });
  t.signatures = [sign(v, t, A)];
  chain.queued.set(proposalDigest(v, t).toLowerCase(), 66666);
  const companion = row({
    nonce: 6, target: VAULT, value: '0',
    call_data: msIface.encodeFunctionData('cancelQueued', ['0x' + 'ab'.repeat(32)]),
    description: 'Cancel #4',
  });
  companion.signatures = [sign(v, companion, A), sign(v, companion, B)];
  const q = await load(v, { pending: [t, companion] });
  assert.equal(q[0].cancelSigners?.size || 0, 0);
});

test('a companion whose shape does not match its kind is unusable', async () => {
  // A "Cancel #4" that is not a self-call carrying cancelQueued is not a cancel,
  // whatever its description says.
  resetChain();
  const v = vault({ nonce: 5, threshold: 2 });
  const t = row({ nonce: 4, status: 'queued' });
  t.signatures = [sign(v, t, A)];
  chain.queued.set(proposalDigest(v, t).toLowerCase(), 66666);
  const wrong = [
    // right selector, aimed somewhere else
    row({ nonce: 5, target: STRANGER, value: '0', description: 'Cancel #4',
          call_data: msIface.encodeFunctionData('cancelQueued', ['0x' + 'ab'.repeat(32)]) }),
    // self-call, wrong selector
    row({ nonce: 5, target: VAULT, value: '0', description: 'Cancel #4',
          call_data: msIface.encodeFunctionData('addOwner', [STRANGER]) }),
    // right shape, carrying value
    row({ nonce: 5, target: VAULT, value: '1', description: 'Cancel #4',
          call_data: msIface.encodeFunctionData('cancelQueued', ['0x' + 'ab'.repeat(32)]) }),
  ];
  for (const w of wrong) {
    w.signatures = [sign(v, w, A), sign(v, w, B)];
    const q = await load(v, { pending: [t, w] });
    assert.equal(q[0].cancelSigners?.size || 0, 0, `a companion of the wrong shape counted: ${w.call_data.slice(0, 10)} -> ${w.target}`);
  }
});

test('a reject companion is a bare no-op self-call, and a rejected one carrying calldata is not', async () => {
  resetChain();
  const v = vault({ nonce: 5, threshold: 2 });
  const t = row({ nonce: 4, status: 'queued' });
  t.signatures = [sign(v, t, A)];
  chain.queued.set(proposalDigest(v, t).toLowerCase(), 66666);
  const good = row({ nonce: 5, target: VAULT, value: '0', call_data: '0x', description: 'Reject #4' });
  good.signatures = [sign(v, good, A)];
  assert.equal((await load(v, { pending: [t, good] }))[0].rejectSigners.size, 1);

  const bad = row({ nonce: 5, target: VAULT, value: '0', description: 'Reject #4',
                    call_data: msIface.encodeFunctionData('addOwner', [STRANGER]) });
  bad.signatures = [sign(v, bad, A)];
  assert.equal((await load(v, { pending: [t, bad] }))[0].rejectSigners?.size || 0, 0);
});

test('a planted empty companion cannot mask the real one behind it', async () => {
  // Several rows can claim the same kind and nonce — the unique constraint that
  // made a nonce exclusive is gone. The strongest VERIFIED set wins, rather than
  // whichever row was read last.
  resetChain();
  const v = vault({ nonce: 5, threshold: 2 });
  const t = row({ nonce: 4, status: 'queued' });
  t.signatures = [sign(v, t, A)];
  chain.queued.set(proposalDigest(v, t).toLowerCase(), 66666);
  const cd = msIface.encodeFunctionData('cancelQueued', ['0x' + 'ab'.repeat(32)]);
  const real = row({ nonce: 5, target: VAULT, value: '0', call_data: cd, description: 'Cancel #4' });
  real.signatures = [sign(v, real, A), sign(v, real, B)];
  const decoy = row({ nonce: 5, target: VAULT, value: '0', call_data: cd, description: 'Cancel #4' });
  decoy.signatures = [];
  // Either order — the decoy must not win by arriving second.
  assert.equal((await load(v, { pending: [t, real, decoy] }))[0].cancelSigners.size, 2);
  assert.equal((await load(v, { pending: [t, decoy, real] }))[0].cancelSigners.size, 2);
});

test('an accelerate companion is counted separately from a cancel on the same proposal', async () => {
  resetChain();
  const v = vault({ nonce: 5, threshold: 2 });
  const t = row({ nonce: 4, status: 'queued' });
  t.signatures = [sign(v, t, A)];
  chain.queued.set(proposalDigest(v, t).toLowerCase(), 66666);
  const accel = row({ nonce: 5, target: VAULT, value: '0', description: 'Accelerate #4',
                      call_data: msIface.encodeFunctionData('executeQueued', [A, 0n, '0x', 4]) });
  accel.signatures = [sign(v, accel, A), sign(v, accel, B), sign(v, accel, C)];
  const cancel = row({ nonce: 5, target: VAULT, value: '0', description: 'Cancel #4',
                       call_data: msIface.encodeFunctionData('cancelQueued', ['0x' + 'ab'.repeat(32)]) });
  cancel.signatures = [sign(v, cancel, A)];
  const q = await load(v, { pending: [t, accel, cancel] });
  assert.equal(q[0].accelSigners.size, 3);
  assert.equal(q[0].cancelSigners.size, 1);
});


// ── one call in the batch, not the whole batch ────────────────────
//
// aggregate3 is sent with allowFailure:true, so a sub-call that reverts or
// returns something undecodable comes back {success:false} inside a batch that
// otherwise worked. `chain.down` covers the whole read failing; this is the case
// where everything else answered and one thing did not, which is the one a mock
// that only models "up" or "down" never reaches.

test('an approval whose own call did not succeed is not an approval', async () => {
  resetChain();
  const v = vault();
  const t = row();
  const h = proposalDigest(v, t);
  // The vault really is holding this approval — and the call asking about it is
  // the one that failed. An unreadable answer is not a yes.
  chain.approved.add(A.toLowerCase() + '|' + h.toLowerCase());
  chain.fail.add(A.toLowerCase() + '|' + h.toLowerCase());
  const out = await chainCheckQueue(v, [], [{ id: t.id, hash: h, signer: A }]);
  assert.equal(out.approved.size, 0, 'a failed call was counted as a confirmed approval');
});

test('a failed approval call costs only that approval', async () => {
  resetChain();
  const v = vault();
  const t = row();
  const h = proposalDigest(v, t);
  for (const who of [A, B]) chain.approved.add(who.toLowerCase() + '|' + h.toLowerCase());
  chain.fail.add(A.toLowerCase() + '|' + h.toLowerCase());
  const out = await chainCheckQueue(v, [], [
    { id: t.id, hash: h, signer: A }, { id: t.id, hash: h, signer: B },
  ]);
  assert.deepEqual([...out.approved], [t.id + '|' + B.toLowerCase()]);
});

test('a queued call that did not succeed is not the vault disclaiming the proposal', async () => {
  // The dangerous direction. `queued()` returning zero means the vault says it
  // is not holding this; a call that failed says nothing at all, and the two
  // must not arrive as the same value — undefined is what stops the row being
  // pruned and stops an unsigned one being hidden.
  resetChain();
  const v = vault();
  const t = row();
  const h = proposalDigest(v, t);
  chain.fail.add(h.toLowerCase());
  const out = await chainCheckQueue(v, [{ id: t.id, hash: h }], []);
  assert.ok(!(t.id in out.queued), 'a failed queued() read arrived as an eta of zero');
});

test('a proposal whose queued call failed is neither pruned nor hidden', async () => {
  resetChain();
  const v = vault({ nonce: 5 });
  const behind = row({ nonce: 2, status: 'proposed' });
  const unsigned = row({ nonce: 6 });
  chain.fail.add(proposalDigest(v, behind).toLowerCase());
  chain.fail.add(proposalDigest(v, unsigned).toLowerCase());
  const q = await load(v, { pending: [behind, unsigned] });
  assert.deepEqual(q.map(t => t.nonce).sort((a, b) => a - b), [2, 6],
    'an unreadable answer was treated as the vault disclaiming the proposal');
  assert.deepEqual(db.pruned, [], 'a proposal was pruned on the strength of a call that failed');
});
