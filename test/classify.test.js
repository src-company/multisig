// txKind() — the sentence a co-signer reads before they sign.
//
//   node --test              (from the repo root; discovers every suite)
//
// Same shape as the other suites, and lifted the same way: the dapp is one HTML
// file with its script inline, so this reads that file, pulls declarations out
// by name into a sandbox, and stubs only what each one will not run without. A
// missing name throws rather than returning nothing, so a rename fails the suite
// instead of quietly deleting its coverage.
//
// Why this function, ahead of everything else that had no suite. Every other
// screen in this app describes a decision the operator is making themselves and
// can therefore check against what they just typed. The queue card describes a
// decision somebody ELSE made: a proposal raised on another machine, by another
// tool, and brought here for a second signature. txKind() reads target, value
// and calldata and produces the badge and the one plain sentence that co-signer
// is going to act on. It is the only thing standing between a proposal that
// drains the vault and a proposal that looks like it does not.
//
// And the rows it reads are anon-writable. propose_tx() runs as the anon role
// and authenticates its caller by a string the caller supplies, so the target,
// the value and the calldata reaching this function are attacker-chosen in the
// worst case. A classifier that says "ERC20 TRANSFER" over calldata that is
// actually an unlimited approve, or "CLAIM NAME · ALICE" over a mint under a
// parent node nobody recognises, is the whole attack — everything after it is
// the co-signer doing what they were told.
//
// So: real ethers, real ABIs, real selectors. The interfaces are lifted from the
// file rather than rebuilt here, because a classifier tested against a decoder
// this suite wrote would only ever be asserting that two of my own opinions
// agree. The one thing stubbed is the chain, which txKind never asks.
//
// The ethers bundle in dapp/ is the same one the page loads, and it ends in
// `globalThis.ethers = …`, so running it inside the sandbox gives the lifted
// code the exact library the browser gives it. It is not a Node build of ethers
// and deliberately is not: what ships is what is tested.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dapp', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

// A `const NAME = ...` one-liner, a `function NAME(...)` closed by a brace in
// column 0, or a multi-line `const NAME = {` / `[` / `new ethers.Interface([`
// closed by a `}`, `]` or `)` in column 0 — the shapes this file uses. `let` is
// read the same way as `const`: one of the caches the classifier memoises into
// is declared with it, and lifting the function without its cache is lifting a
// ReferenceError.
//
// The function half is character-for-character the reader in names.test.js,
// deploy.test.js and queue.test.js, for the reason those files give: copies of a
// short reader are cheaper than a shared module in a repo that deliberately has
// no build step, and the day they diverge, they diverge loudly. The multi-line
// half is new here, because this suite is the first that needs the ABIs and the
// selector table, and those are literals the original could not lift.
function grab(name) {
  const asConst = LINES.findIndex(l =>
    ['const', 'let'].some(kw => l.startsWith(`${kw} ${name} `) || l.startsWith(`${kw} ${name}=`)));
  if (asConst !== -1) {
    const line = LINES[asConst];
    // Balanced on its own line — a plain one-liner.
    if (/;\s*(\/\/.*)?$/.test(line)) return line;
    let end = asConst + 1;
    while (end < LINES.length && !/^[}\])]/.test(LINES[end])) end++;
    if (end >= LINES.length) throw new Error(`classify.test.js: no closing line found for 'const ${name}'.`);
    return LINES.slice(asConst, end + 1).join('\n');
  }
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`classify.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`classify.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

// Declaration order matters — SEL is built from the interfaces at load, and the
// interfaces from the ABIs — so this list is in dependency order rather than
// alphabetical, and is evaluated as one script.
const NEEDED = [
  // addresses and constants the classifier compares against
  'FACTORY', 'IMPLEMENTATION', 'TIMELOCK_EXECUTOR', 'WSTETH_ADDRESS',
  'WEINS', 'WNS_ID_REGISTRAR', 'WNS_ID_PARENT', 'WNS_ID_SUFFIX',
  'MAX_SAFE_THRESHOLD', 'DELAY_SANE_MAX',
  // ABIs, interfaces, selectors — the real decoders, not stand-ins
  'MULTISIG_ABI', 'msIface', 'TIMELOCK_EXECUTOR_ABI', 'tlIface',
  'ERC20_ABI', 'erc20Iface', 'SLOW_ABI', 'slowIface',
  'WEINS_ABI', 'weinsIface', 'wnsRegIface',
  'SEL', 'SEL_RE', 'selOf',
  // helpers the classifier composes with
  '_ESC', '_escOne', 'esc', 'weiStr', 'bigOr0', 'shortAddr', 'fmtD', 'fmtDelay',
  'asciiLower', 'wnsSubId', 'wnsFullName', 'WNS_LABEL_RE', 'WNS_LABEL_MAX',
  'wnsLabelValid', 'wnsIdentityBatch',
  'isStakeCall', 'isGuardHookAddr', 'executorRisk', 'fastPathVoidsTimelock',
  'NO_WITHDRAWAL', 'lockedDest', '_msSelectors', 'isKnownMultisigSelector',
  // the verified-ABI index: what the classifier consults before it gives up
  '_selIndex', 'abiTypeSig', 'indexAbiSelectors', 'verifiedFn', 'fnLabel',
  'fmtAbiArg', 'verifiedCallNote',
  'SELECTOR_LABELS', 'selectorToLabel',
  // the subjects
  'txKind', 'isCancelTx', 'nextNonce', 'POLICY_SELECTORS', 'pendingPolicyChanges',
];

const sandbox = {
  console: { ...console, warn() {}, error() {} },
  S: { demoMode: false, chainId: 1 },
  // txKind reads nothing off the chain. Anything that tried to would fail loudly
  // here rather than quietly resolving to a stub's opinion.
  provider: null,
  TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
  crypto: globalThis.crypto,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dapp', 'ethers.slim.min.js'), 'utf8'), sandbox);

const handOut = NEEDED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n');
vm.runInContext(NEEDED.map(grab).join('\n') + '\n' + handOut, sandbox);
for (const n of NEEDED) {
  if (sandbox[n] === undefined) throw new Error(`classify.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}

const {
  ethers, txKind, selectorToLabel, isCancelTx, nextNonce, pendingPolicyChanges,
  lockedDest, executorRisk, isGuardHookAddr, fastPathVoidsTimelock,
  isKnownMultisigSelector, selOf, msIface, erc20Iface, slowIface, tlIface,
  wnsRegIface, weinsIface, SEL, FACTORY, IMPLEMENTATION, TIMELOCK_EXECUTOR,
  WSTETH_ADDRESS, WEINS, WNS_ID_REGISTRAR, WNS_ID_PARENT, wnsSubId,
  MAX_SAFE_THRESHOLD, DELAY_SANE_MAX,
  indexAbiSelectors, verifiedFn, abiTypeSig, fmtAbiArg,
} = sandbox;

// Deliberately none of these carry 0x1111 in their top or bottom 16 bits — that
// is the guard-hook marker, and a vault address that happened to carry it would
// turn every plain setExecutor assertion below into an assertion about the lock
// branch instead. The marked addresses are built explicitly where they are used.
const VAULT = '0x9999999999999999999999999999999999999999';
const ALICE = '0x2222222222222222222222222222222222222222';
const BOB = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';

// A vault as txKind reads one: policy figures, the address it calls itself by,
// and the queue it looks a cancel's hash up in.
const vault = o => Object.assign({
  address: VAULT, ownerCount: 3, threshold: 2, delay: 86400,
  executor: TIMELOCK_EXECUTOR, fastPath: false, queue: [],
}, o);
// A proposal as it arrives out of the database: target, value, calldata, nonce.
const prop = o => Object.assign({ target: ALICE, rawValue: '0', callData: '0x', nonce: 7 }, o);

const ms = (fn, args) => msIface.encodeFunctionData(fn, args);

// ── plain value movement ──────────────────────────────────────────

test('a bare send of ETH is a transfer and says nothing else', () => {
  const k = txKind(prop({ rawValue: '1000000000000000000' }), vault());
  assert.equal(k.label, 'ETH TRANSFER');
  assert.equal(k.tone, 'value');
  // The amount and the recipient are already on the card. A note here would be
  // one more sentence to read on the proposals that need reading least.
  assert.ok(!k.note);
  assert.ok(!k.warn);
});

test('a self-call with no value and no calldata is named for what it does: burn a nonce', () => {
  const k = txKind(prop({ target: VAULT }), vault());
  assert.equal(k.label, 'REJECT · NO-OP');
  assert.equal(k.tone, 'danger');
  assert.match(k.note, /CONSUME THIS NONCE/);
});

test('ETH to wstETH with empty calldata is a stake, read off the call and not off a flag', () => {
  // isStake is the flag this app sets on proposals it built itself. A proposal
  // raised elsewhere carries no flag, and has to classify identically.
  const k = txKind(prop({ target: WSTETH_ADDRESS, rawValue: '5' }), vault());
  assert.match(k.label, /^STAKE/);
  assert.equal(k.tone, 'stake');
});

// ── the burn destinations ─────────────────────────────────────────
//
// Audit L-2. The factory, the implementation and the TimelockExecutor are all
// printed in this interface and on every deploy receipt, which makes them
// plausible paste targets, and none of the three has a withdrawal path of any
// kind. Value that reaches one is gone from everybody, permanently.

test('every address with no withdrawal path is named, and ETH sent to one is called a burn', () => {
  for (const dest of [FACTORY, IMPLEMENTATION, TIMELOCK_EXECUTOR, ethers.ZeroAddress,
                      '0x0000000000000000000000000000000000000001']) {
    assert.ok(lockedDest(dest), `${dest} is a locked destination and lockedDest does not say so`);
    const k = txKind(prop({ target: dest, rawValue: '1' }), vault());
    assert.equal(k.label, 'ETH TRANSFER · UNRECOVERABLE', `${dest} did not classify as a burn`);
    assert.equal(k.warn, true);
    assert.match(k.note, /NOBODY .* CAN EVER GET IT BACK/);
  }
});

test('a locked destination is matched however the address is cased', () => {
  assert.ok(lockedDest(FACTORY.toUpperCase().replace('0X', '0x')));
  assert.ok(lockedDest(FACTORY.toLowerCase()));
  assert.equal(lockedDest(ALICE), null);
  // Not an address at all is not a destination — and must not throw out of a
  // render, which is where this runs.
  assert.equal(lockedDest('not-an-address'), null);
  assert.equal(lockedDest(undefined), null);
});

test('a zero-value send to a locked destination is not called a burn, because nothing burns', () => {
  const k = txKind(prop({ target: FACTORY, rawValue: '0' }), vault());
  assert.equal(k.label, 'ETH TRANSFER');
});

test('a token transfer INTO a locked destination is read out of the calldata, not the target', () => {
  // The target here is the token contract — perfectly ordinary. The address
  // that never gives the balance back is an argument, which is exactly why
  // reading only `tx.target` would miss it.
  const k = txKind(prop({ target: TOKEN, callData: erc20Iface.encodeFunctionData('transfer', [FACTORY, 1n]) }), vault());
  assert.equal(k.label, 'ERC20 TRANSFER · UNRECOVERABLE');
  assert.equal(k.warn, true);
  const ok = txKind(prop({ target: TOKEN, callData: erc20Iface.encodeFunctionData('transfer', [ALICE, 1n]) }), vault());
  assert.equal(ok.label, 'ERC20 TRANSFER');
  assert.ok(!ok.warn);
});

// ── the standing grant ────────────────────────────────────────────

test('an approve is marked as outliving the proposal, and an infinite one is called infinite', () => {
  const inf = txKind(prop({ target: TOKEN, callData: erc20Iface.encodeFunctionData('approve', [BOB, 2n ** 256n - 1n]) }), vault());
  assert.equal(inf.warn, true);
  assert.match(inf.note, /UNLIMITED AMOUNT/);
  assert.match(inf.note, /UNTIL THE ALLOWANCE IS REVOKED/);
  const some = txKind(prop({ target: TOKEN, callData: erc20Iface.encodeFunctionData('approve', [BOB, 1000n]) }), vault());
  assert.equal(some.warn, true);
  assert.match(some.note, /UP TO THE APPROVED AMOUNT/);
  // The threshold the note switches on is 2^255, so an allowance one below it
  // is still "up to the approved amount" and one at it is unlimited.
  const edge = txKind(prop({ target: TOKEN, callData: erc20Iface.encodeFunctionData('approve', [BOB, 2n ** 255n]) }), vault());
  assert.match(edge.note, /UNLIMITED AMOUNT/);
});

// ── policy, which outlives the proposal ───────────────────────────

test('adding an owner says what the owner set becomes and that the threshold does not follow it', () => {
  const k = txKind(prop({ target: VAULT, callData: ms('addOwner', [BOB]) }), vault({ ownerCount: 3, threshold: 2 }));
  assert.equal(k.label, 'ADD OWNER');
  assert.match(k.note, /3 &rarr; 4 OWNERS/);
  assert.match(k.note, /THRESHOLD STAYS AT 2/);
});

test('removing an owner names the owner removed, not the linked-list predecessor', () => {
  // removeOwner(prevOwner, owner) — the FIRST argument is a pointer into the
  // owner linked list and has nothing to do with who leaves. Naming it would
  // put the wrong address in front of the person signing.
  const k = txKind(prop({ target: VAULT, callData: ms('removeOwner', [ALICE, BOB]) }), vault());
  assert.equal(k.label, 'REMOVE OWNER');
  assert.match(k.note, new RegExp(BOB.slice(0, 6)));
  assert.ok(!k.note.includes(ALICE.slice(0, 6)), 'the note named the predecessor as the owner being removed');
});

test('a removal that would leave fewer owners than signatures says it will revert', () => {
  const k = txKind(prop({ target: VAULT, callData: ms('removeOwner', [ALICE, BOB]) }), vault({ ownerCount: 2, threshold: 2 }));
  assert.equal(k.warn, true);
  assert.match(k.note, /WILL REVERT/);
});

test('lowering the threshold is a warning; raising it is not', () => {
  const down = txKind(prop({ target: VAULT, callData: ms('setThreshold', [1]) }), vault({ threshold: 2 }));
  assert.equal(down.warn, true);
  assert.match(down.note, /ANY SINGLE OWNER COULD MOVE EVERYTHING/);
  const two = txKind(prop({ target: VAULT, callData: ms('setThreshold', [2]) }), vault({ threshold: 3 }));
  assert.equal(two.warn, true);
  assert.match(two.note, /LOWERS THE BAR FOR EVERY FUTURE PROPOSAL/);
  const up = txKind(prop({ target: VAULT, callData: ms('setThreshold', [3]) }), vault({ threshold: 2 }));
  assert.ok(!up.warn);
});

test('a timelock going to zero, or getting shorter, says what is lost', () => {
  const zero = txKind(prop({ target: VAULT, callData: ms('setDelay', [0]) }), vault({ delay: 86400 }));
  assert.equal(zero.warn, true);
  assert.match(zero.note, /NO WINDOW TO CANCEL/);
  const shorter = txKind(prop({ target: VAULT, callData: ms('setDelay', [3600]) }), vault({ delay: 86400 }));
  assert.equal(shorter.warn, true);
  const longer = txKind(prop({ target: VAULT, callData: ms('setDelay', [172800]) }), vault({ delay: 86400 }));
  assert.ok(!longer.warn);
});

test('a timelock past a month is called extreme, and says whether anything could walk it back', () => {
  // Audit M-2. Past this, every proposal that would shorten the delay again is
  // itself queued behind it.
  const long = DELAY_SANE_MAX + 1;
  const withExec = txKind(prop({ target: VAULT, callData: ms('setDelay', [long]) }), vault());
  assert.equal(withExec.label, 'SET TIMELOCK · EXTREME');
  assert.equal(withExec.warn, true);
  assert.match(withExec.note, /UNANIMOUS FAST-PATH FORWARD/);
  const noExec = txKind(prop({ target: VAULT, callData: ms('setDelay', [long]) }), vault({ executor: ethers.ZeroAddress }));
  assert.match(noExec.note, /THIS IS PERMANENT/);
  // Exactly at the ceiling is not past it.
  const at = txKind(prop({ target: VAULT, callData: ms('setDelay', [DELAY_SANE_MAX]) }), vault());
  assert.equal(at.label, 'SET TIMELOCK');
});

// ── the executor, which is the whole of the fast path ─────────────

test('the guard-hook marker is recognised in the top bits and the bottom bits, and nowhere else', () => {
  // Audit L-1. execute() fires the guard hook when the executor address carries
  // 0x1111 in either its top or its bottom 16 bits.
  assert.equal(isGuardHookAddr('0x1111' + '00'.repeat(18)), true);
  assert.equal(isGuardHookAddr('0x' + '00'.repeat(18) + '1111'), true);
  assert.equal(isGuardHookAddr('0x' + '00'.repeat(9) + '1111' + '00'.repeat(9)), false);
  assert.equal(isGuardHookAddr('not an address'), false);
});

test('a vault pointed at itself is refused, and refused harder when its address carries the marker', () => {
  const plain = '0x2222222222222222222222222222222222222222';
  const marked = '0x1111' + '22'.repeat(18);
  assert.equal(executorRisk(plain, plain), 'self');
  assert.equal(executorRisk(marked, marked), 'lock');
  assert.equal(executorRisk(marked, plain), 'hook');
  assert.equal(executorRisk(plain, BOB), null);
  // Cased differently is the same vault. A checksum address in the calldata and
  // a lowercased one on the vault record must not read as two addresses.
  assert.equal(executorRisk(plain.toUpperCase().replace('0X', '0x'), plain.toLowerCase()), 'self');
});

test('each executor risk gets its own badge, and the locking one says DO NOT SIGN', () => {
  const marked = '0x1111' + '22'.repeat(18);
  const lock = txKind(prop({ target: marked, callData: ms('setExecutor', [marked]) }), vault({ address: marked }));
  assert.equal(lock.label, 'SET EXECUTOR · LOCKS VAULT');
  assert.match(lock.note, /DO NOT SIGN/);
  assert.match(lock.note, /FROZEN PERMANENTLY/);

  const self = txKind(prop({ target: VAULT, callData: ms('setExecutor', [VAULT]) }), vault());
  assert.equal(self.label, 'SET EXECUTOR · SELF');
  assert.equal(self.warn, true);

  const hook = txKind(prop({ target: VAULT, callData: ms('setExecutor', ['0x1111' + '33'.repeat(18)]) }), vault());
  assert.equal(hook.label, 'SET EXECUTOR · GUARD HOOK');
  assert.equal(hook.warn, true);

  const ok = txKind(prop({ target: VAULT, callData: ms('setExecutor', [BOB]) }), vault());
  assert.equal(ok.label, 'SET EXECUTOR');
  // Still a warn: any executor can forward on the vault's behalf.
  assert.equal(ok.warn, true);
});

test('clearing the executor under a live timelock is called what it is: stranding the queue', () => {
  // Audit M-3. cancelQueued is onlySelf, so with no executor a cancel is itself
  // queued for the full delay and matures no earlier than what it means to stop.
  const live = txKind(prop({ target: VAULT, callData: ms('setExecutor', [ethers.ZeroAddress]) }), vault({ delay: 86400 }));
  assert.equal(live.label, 'SET EXECUTOR · STRANDS THE QUEUE');
  assert.equal(live.warn, true);
  assert.match(live.note, /NOTHING CAN STOP IT/);
  // With no timelock there is no window to strand, so it is an ordinary change.
  const none = txKind(prop({ target: VAULT, callData: ms('setExecutor', [ethers.ZeroAddress]) }), vault({ delay: 0 }));
  assert.equal(none.label, 'SET EXECUTOR');
  assert.match(none.note, /REMOVES THE VAULT'S EXECUTOR/);
});

test('where quorum is already unanimous, enabling the fast path is enabling no timelock', () => {
  // Audit H-1. forward() tells "execute now" from "queue for review" by
  // signature count alone — ownerCount vs threshold — over one shared digest.
  // Where those numbers coincide the distinction does not exist.
  assert.equal(fastPathVoidsTimelock({ delay: 86400, ownerCount: 3, threshold: 3 }), true);
  assert.equal(fastPathVoidsTimelock({ delay: 86400, ownerCount: 3, threshold: 2 }), false);
  assert.equal(fastPathVoidsTimelock({ delay: 0, ownerCount: 3, threshold: 3 }), false);

  const on = tlIface.encodeFunctionData('enableForward', [true]);
  const unanimous = txKind(prop({ target: TIMELOCK_EXECUTOR, callData: on }), vault({ ownerCount: 3, threshold: 3 }));
  assert.equal(unanimous.label, 'FAST PATH · TIMELOCK BECOMES ADVISORY');
  assert.equal(unanimous.tone, 'danger');
  assert.match(unanimous.note, /ANYONE WHO SEES THEM IN THE MEMPOOL/);

  const quorum = txKind(prop({ target: TIMELOCK_EXECUTOR, callData: on }), vault({ ownerCount: 3, threshold: 2 }));
  assert.equal(quorum.label, 'EXECUTOR FAST PATH');
  assert.equal(quorum.warn, true);

  const off = txKind(prop({ target: TIMELOCK_EXECUTOR, callData: tlIface.encodeFunctionData('enableForward', [false]) }), vault({ ownerCount: 3, threshold: 3 }));
  assert.equal(off.label, 'EXECUTOR FAST PATH');
  assert.ok(!off.warn);
});

// ── on-chain identity, where a name is the thing being checked ────

test('a name claim is named off the registrar as well as the selector', () => {
  const data = wnsRegIface.encodeFunctionData('register', [BigInt(WNS_ID_PARENT), 'alice']);
  const good = txKind(prop({ target: WNS_ID_REGISTRAR, callData: data }), vault());
  assert.equal(good.label, 'CLAIM NAME · ALICE.ID.WEI');
  assert.ok(!good.warn);
  // The same four bytes aimed at a stranger's contract. A selector match proves
  // nothing about which contract is being called, and "CLAIM NAME" beside an
  // unknown address would be this interface vouching for something it never
  // checked.
  const elsewhere = txKind(prop({ target: BOB, callData: data }), vault());
  assert.ok(!elsewhere.label.startsWith('CLAIM NAME'), `a register() at a stranger's address read as ${elsewhere.label}`);
});

test('a claim under an unrecognised parent node is refused by name', () => {
  const data = wnsRegIface.encodeFunctionData('register', [1234n, 'alice']);
  const k = txKind(prop({ target: WNS_ID_REGISTRAR, callData: data }), vault());
  assert.equal(k.label, 'CLAIM NAME · UNKNOWN NAMESPACE');
  assert.equal(k.warn, true);
  assert.match(k.note, /NOT THE NAME THE LABEL READS AS/);
});

test('a label this interface would not claim is flagged where somebody else claims it', () => {
  // The registrar accepts zero-width joiners and mixed scripts. This is the one
  // screen where a name drawn to look like another name gets signed for.
  const sneaky = wnsRegIface.encodeFunctionData('register', [BigInt(WNS_ID_PARENT), 'ali​ce']);
  const k = txKind(prop({ target: WNS_ID_REGISTRAR, callData: sneaky }), vault());
  assert.equal(k.warn, true);
  assert.match(k.note, /INVISIBLE OR MIXED-SCRIPT/);
});

test('a name out of a proposal row cannot close the note it is written into', () => {
  // `label` is a free-form string from an anon-writable row, and `note` is
  // emitted as trusted HTML. It is escaped where it enters rather than left to
  // a sink that does not escape.
  const nasty = wnsRegIface.encodeFunctionData('register', [BigInt(WNS_ID_PARENT), '<img src=x onerror=alert(1)>']);
  const k = txKind(prop({ target: WNS_ID_REGISTRAR, callData: nasty }), vault());
  assert.ok(!k.note.includes('<img'), 'a raw tag from a proposal row reached the note');
  assert.ok(k.note.includes('&lt;IMG'), 'the label was dropped from the note rather than escaped into it');
});

test('a mint and its reverse record read as one identity change, not as BATCH · 2 CALLS', () => {
  const label = 'treasury';
  const data = msIface.encodeFunctionData('batch', [
    [WNS_ID_REGISTRAR, WEINS],
    [0n, 0n],
    [wnsRegIface.encodeFunctionData('register', [BigInt(WNS_ID_PARENT), label]),
     weinsIface.encodeFunctionData('setPrimaryName', [wnsSubId(label)])],
  ]);
  const k = txKind(prop({ target: VAULT, callData: data }), vault());
  assert.equal(k.label, 'ON-CHAIN IDENTITY · TREASURY.ID.WEI');
  assert.match(k.note, /GRANTS NOBODY ANY POWER OVER THE VAULT/);
});

test('a batch that only looks like an identity claim falls back to being a batch', () => {
  // Same two selectors, but the setPrimaryName names a DIFFERENT name than the
  // one being minted — so the pair is not the atomic claim it resembles.
  const data = msIface.encodeFunctionData('batch', [
    [WNS_ID_REGISTRAR, WEINS],
    [0n, 0n],
    [wnsRegIface.encodeFunctionData('register', [BigInt(WNS_ID_PARENT), 'treasury']),
     weinsIface.encodeFunctionData('setPrimaryName', [wnsSubId('somethingelse')])],
  ]);
  const k = txKind(prop({ target: VAULT, callData: data }), vault());
  assert.match(k.label, /^BATCH · 2 CALLS/);
});

test('setting the primary name does not guess which name, because the calldata cannot say', () => {
  const data = weinsIface.encodeFunctionData('setPrimaryName', [wnsSubId('treasury')]);
  const k = txKind(prop({ target: WEINS, callData: data }), vault());
  assert.equal(k.label, 'SET PRIMARY NAME');
  assert.match(k.note, /CANNOT BE READ BACK FROM THIS PROPOSAL/);
});

// ── queue control ─────────────────────────────────────────────────

test('a cancel names the proposal it stops when the queue can identify it', () => {
  const victim = { nonce: 4, txHash: '0x' + 'ab'.repeat(32) };
  const data = ms('cancelQueued', [victim.txHash]);
  const named = txKind(prop({ target: VAULT, callData: data }), vault({ queue: [victim] }));
  assert.equal(named.label, 'CANCEL QUEUED · #4');
  assert.match(named.note, /DROPS QUEUED PROPOSAL #4/);
});

test('a cancel whose hash matches nothing says so rather than naming the wrong proposal', () => {
  const data = ms('cancelQueued', ['0x' + 'cd'.repeat(32)]);
  const k = txKind(prop({ target: VAULT, callData: data }), vault({ queue: [{ nonce: 4, txHash: '0x' + 'ab'.repeat(32) }] }));
  assert.equal(k.label, 'CANCEL QUEUED');
  assert.match(k.note, /NO PROPOSAL IN THIS QUEUE HAS THAT HASH/);
});

test('a hash is matched however it is cased, since the row is written by anyone', () => {
  const h = '0x' + 'ab'.repeat(32);
  const k = txKind(prop({ target: VAULT, callData: ms('cancelQueued', [h]) }),
                   vault({ queue: [{ nonce: 4, txHash: h.toUpperCase().replace('0X', '0x') }] }));
  assert.equal(k.label, 'CANCEL QUEUED · #4');
});

test('an accelerate names the nonce it skips the timelock on', () => {
  const data = ms('executeQueued', [ALICE, 0n, '0x', 9]);
  const k = txKind(prop({ target: VAULT, callData: data }), vault());
  assert.equal(k.label, 'ACCELERATE · #9');
  assert.equal(k.tone, 'danger');
  assert.match(k.note, /THIS IS THE STEP THE DELAY EXISTS TO PREVENT/);
});

test('a cancel is recognised as one only when it is aimed at the vault itself', () => {
  const v = vault();
  const h = '0x' + 'ab'.repeat(32);
  assert.equal(isCancelTx(prop({ target: VAULT, callData: ms('cancelQueued', [h]) }), v), true);
  // The same selector aimed elsewhere is somebody else's contract, not this
  // vault's brake.
  assert.equal(isCancelTx(prop({ target: BOB, callData: ms('cancelQueued', [h]) }), v), false);
  assert.equal(isCancelTx(prop({ target: VAULT, callData: '0x' }), v), false);
  // The flag this app sets on its own cancels still counts.
  assert.equal(isCancelTx(prop({ target: BOB, cancelTarget: 4 }), v), true);
});

// ── delegatecall and the unknown ──────────────────────────────────

test('a delegatecall is described as what it is — foreign code in the vault\'s own storage', () => {
  const k = txKind(prop({ target: VAULT, callData: ms('delegateCall', [BOB, '0x1234']) }), vault());
  assert.equal(k.label, 'DELEGATE CALL');
  assert.equal(k.tone, 'danger');
  assert.equal(k.warn, true);
  assert.match(k.note, /REWRITE EVERY SETTING/);
});

test('a self-call the wallet has no function for is a nonce burn that reports success', () => {
  // Audit L-2. The fallback answers the receiver selectors and returns empty
  // success for everything else, so a mistyped governance call emits
  // ExecutionSuccess and changes nothing — the loudest class of mistake made
  // into the quietest one.
  const k = txKind(prop({ target: VAULT, callData: '0xdeadbeef', nonce: 12 }), vault());
  assert.equal(k.label, 'SELF-CALL · SILENT NO-OP');
  assert.equal(k.warn, true);
  assert.match(k.note, /NONCE 12/);
  assert.match(k.note, /0xdeadbeef/);
});

test('every selector the wallet really answers is known, including the three the fallback handles', () => {
  msIface.forEachFunction(f => assert.equal(isKnownMultisigSelector(f.selector), true, `${f.name} is not recognised`));
  // ERC-721/1155 receivers — answered for real, not swallowed.
  ['0x150b7a02', '0xf23a6e61', '0xbc197c81'].forEach(s => assert.equal(isKnownMultisigSelector(s), true));
  assert.equal(isKnownMultisigSelector('0xdeadbeef'), false);
});

test('an unknown selector aimed at somebody else says nothing here can tell you what it does', () => {
  const k = txKind(prop({ target: BOB, callData: '0xdeadbeef' }), vault());
  assert.equal(k.label, 'CALL 0xdeadbeef');
  assert.equal(k.warn, true);
  assert.match(k.note, /UNRECOGNISED FUNCTION/);
});

// ── the verified ABI ──────────────────────────────────────────────
//
// The dead end above has one way out: a target that published its source. The
// classifier reads the selector out of an index built from that ABI, which is
// filled in the background by prefetchQueueAbis() and read synchronously here.
// What is asserted below is where the naming stops — a name is what the
// contract calls the function, and nothing in this app has read what it does.

const LISTING_ABI = [
  { type: 'function', name: 'delist', stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [] },
  { type: 'function', name: 'freeze', stateMutability: 'nonpayable',
    inputs: [{ name: 'on', type: 'bool' }], outputs: [] },
  // Same four bytes as ERC-20 approve, under a name of its own. Verified source
  // is not a licence to relabel a call this interface already warns about.
  { type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
];
const listingIface = new ethers.Interface(LISTING_ABI);
const indexAt = (addr, abi) => indexAbiSelectors(`1:${addr.toLowerCase()}`, abi || LISTING_ABI);

test('a verified target names its own function and decodes what it was given', () => {
  indexAt(BOB);
  const data = listingIface.encodeFunctionData('delist', [42n, ALICE]);
  const k = txKind(prop({ target: BOB, callData: data }), vault());
  assert.equal(k.label, 'CALL delist');
  assert.match(k.note, /delist\(uint256,address\)/);
  assert.match(k.note, /ID 42/);
  assert.match(k.note, /TO 0x2222…2222/);
  // Named, not explained. The warning is the point of the sentence.
  assert.equal(k.warn, true);
  assert.match(k.note, /NOT AN ACCOUNT OF WHAT IT DOES/);
});

test('a name read off one contract is not lent to the same selector on another', () => {
  // Selectors collide across unrelated contracts, and this index is the only
  // thing standing between "the four bytes matched" and "the interface told a
  // co-signer what they were signing".
  indexAt(BOB);
  const data = listingIface.encodeFunctionData('freeze', [true]);
  assert.equal(txKind(prop({ target: BOB, callData: data }), vault()).label, 'CALL freeze');
  assert.equal(txKind(prop({ target: ALICE, callData: data }), vault()).label, `CALL ${selOf(data)}`);
  // And not on another chain either: the index is keyed by both, because the
  // same address is a different contract on a different chain.
  assert.ok(verifiedFn(BOB, selOf(data)));
  sandbox.S.chainId = 8453;
  assert.equal(verifiedFn(BOB, selOf(data)), null);
  assert.equal(txKind(prop({ target: BOB, callData: data }), vault()).label, `CALL ${selOf(data)}`);
  sandbox.S.chainId = 1;
});

test('a verified name never displaces a branch this interface already knows', () => {
  indexAt(TOKEN);
  const data = erc20Iface.encodeFunctionData('approve', [BOB, 2n ** 256n - 1n]);
  const k = txKind(prop({ target: TOKEN, callData: data }), vault());
  assert.equal(k.label, 'ERC20 APPROVE');
  assert.match(k.note, /UNLIMITED AMOUNT/);
});

test('a self-call the wallet has no function for stays a silent no-op, whatever an ABI says', () => {
  indexAt(VAULT);
  const data = listingIface.encodeFunctionData('freeze', [true]);
  const k = txKind(prop({ target: VAULT, callData: data, nonce: 3 }), vault());
  assert.equal(k.label, 'SELF-CALL · SILENT NO-OP');
});

test('calldata that does not fit the signature it matched is reported, not decoded anyway', () => {
  indexAt(BOB);
  const data = listingIface.encodeFunctionData('delist', [1n, ALICE]).slice(0, 42);
  const k = txKind(prop({ target: BOB, callData: data }), vault());
  assert.equal(k.label, 'CALL delist');
  assert.match(k.note, /DO NOT DECODE AGAINST THAT SIGNATURE/);
});

test('a function name out of a third-party ABI cannot reach a label as markup', () => {
  // Sourcify serves compiler metadata, so a name here should always be a
  // Solidity identifier. Should is not a guarantee worth a stored XSS.
  const evil = [{ type: 'function', name: '<img src=x onerror=alert(1)>', inputs: [], outputs: [] }];
  indexAt(BOB, evil);
  const sel = ethers.id('<img src=x onerror=alert(1)>()').slice(0, 10);
  const k = txKind(prop({ target: BOB, callData: sel }), vault());
  assert.ok(!/[<>]/.test(k.label), `raw markup reached the label: ${k.label}`);
  assert.ok(!k.note.includes('<img'), 'raw markup reached the note');
  indexAt(BOB);
});

test('a batch names each member off the contract that member calls', () => {
  indexAt(BOB);
  const inner = listingIface.encodeFunctionData('freeze', [false]);
  const data = msIface.encodeFunctionData('batch', [[BOB, ALICE], [0n, 0n], [inner, inner]]);
  const k = txKind(prop({ target: VAULT, callData: data }), vault());
  // Same bytes, two targets: named at the one that published an ABI for it.
  assert.match(k.note, new RegExp(`CALL freeze \\+ CALL ${selOf(inner)}`));
});

test('a selector is hashed from the canonical signature, tuples expanded', () => {
  assert.equal(abiTypeSig({ type: 'uint256' }), 'uint256');
  assert.equal(abiTypeSig({ type: 'tuple', components: [{ type: 'address' }, { type: 'uint256' }] }), '(address,uint256)');
  assert.equal(abiTypeSig({ type: 'tuple[]', components: [{ type: 'bool' }] }), '(bool)[]');
  // Round-trip against ethers' own hashing, which is what a chain would use.
  const abi = [{ type: 'function', name: 'list', inputs: [
    { name: 'o', type: 'tuple', components: [{ name: 'a', type: 'address' }, { name: 'p', type: 'uint256' }] }], outputs: [] }];
  indexAt(BOB, abi);
  const data = new ethers.Interface(abi).encodeFunctionData('list', [[ALICE, 5n]]);
  assert.equal(txKind(prop({ target: BOB, callData: data }), vault()).label, 'CALL list');
  indexAt(BOB);
});

test('an argument is shown in a form a signer can check, and never as an invention', () => {
  assert.equal(fmtAbiArg(ALICE, 'address'), '0x2222…2222');
  assert.equal(fmtAbiArg(true, 'bool'), 'TRUE');
  assert.equal(fmtAbiArg(10n ** 30n, 'uint256'), '1000000000000000000000000000000');
  assert.equal(fmtAbiArg('hi', 'string'), '"hi"');
  assert.match(fmtAbiArg('x'.repeat(60), 'string'), /…"$/);
  assert.equal(fmtAbiArg([1n, 2n, 3n], 'uint256[]'), '[3 ITEMS]');
});

// ── the untrusted row ─────────────────────────────────────────────
//
// Everything above assumes calldata that decodes. These are the rows that do
// not, because `call_data` and `value` are columns the anon role writes and a
// render that throws is a blank page for everyone looking at that vault.

test('calldata that is not hex produces a classification instead of an exception', () => {
  for (const junk of ['0x', '0xzz', '0x1', 'hello', '', null, undefined]) {
    const k = txKind(prop({ callData: junk }), vault());
    assert.ok(k && k.label, `calldata ${JSON.stringify(junk)} produced no classification`);
  }
});

test('a selector is only a selector when it is four bytes of hex', () => {
  assert.equal(selOf('0xa9059cbb' + '00'.repeat(32)), '0xa9059cbb');
  assert.equal(selOf('0xA9059CBB' + '00'.repeat(32)), '0xa9059cbb');
  assert.equal(selOf('0x'), '');
  assert.equal(selOf('0xzzzzzzzz00'), '');
  assert.equal(selOf(null), '');
  assert.equal(selOf(12345), '');
});

test('a selector out of a row cannot inject markup into the label it is printed in', () => {
  // Both the label and the note interpolate the selector, and the label is
  // emitted as HTML. Anything that is not four clean bytes reads as "no
  // selector", which is why nothing needs escaping downstream.
  const k = txKind(prop({ target: BOB, callData: '0x"><script>alert(1)</script>' }), vault());
  assert.ok(!k.label.includes('<script'), `raw markup reached the label: ${k.label}`);
  assert.ok(!k.note.includes('<script'), 'raw markup reached the note');
});

test('a proposal whose value is not a whole number classifies as if it were zero', () => {
  // `value` is a `numeric` column on an anon-writable table, so it accepts 1.5,
  // -1 and 1e40. Every render path hands it to BigInt(), which throws on all
  // three — and one such row used to empty the whole queue on load.
  for (const bad of ['1.5', '-1', '1e40', 'abc', '', null]) {
    const k = txKind(prop({ rawValue: bad }), vault());
    assert.equal(k.label, 'ETH TRANSFER', `value ${JSON.stringify(bad)} did not fall back to zero`);
  }
  // And a value that IS a whole number still reads as one.
  assert.equal(txKind(prop({ target: VAULT, rawValue: '0' }), vault()).label, 'REJECT · NO-OP');
  assert.equal(txKind(prop({ target: VAULT, rawValue: '1' }), vault()).label, 'ETH TRANSFER');
});

test('a batch carrying an undecodable member still reports the batch', () => {
  const data = msIface.encodeFunctionData('batch', [[ALICE, BOB], [1n, 0n], ['0x', '0xdeadbeef']]);
  const k = txKind(prop({ target: VAULT, callData: data }), vault());
  assert.equal(k.label, 'BATCH · 2 CALLS');
  // A member with value and no calldata is a transfer; one with an unknown
  // selector is named by that selector rather than guessed at.
  assert.match(k.note, /ETH TRANSFER \+ CALL 0xdeadbeef/);
});

test('a truncated batch cannot be decoded, and says BATCH rather than inventing members', () => {
  const data = msIface.encodeFunctionData('batch', [[ALICE], [0n], ['0x']]).slice(0, 42);
  const k = txKind(prop({ target: VAULT, callData: data }), vault());
  assert.equal(k.label, 'BATCH');
  assert.match(k.note, /ALL SUCCEED, OR THE WHOLE PROPOSAL REVERTS/);
});

// ── the label table ───────────────────────────────────────────────

test('every selector the app compares against has a label, and an unknown one is shown as itself', () => {
  for (const [name, sel] of Object.entries(SEL)) {
    const label = selectorToLabel(sel + '00'.repeat(32));
    assert.ok(!label.startsWith('CALL 0x'), `${name} (${sel}) has no label and would render as raw bytes`);
  }
  assert.equal(selectorToLabel('0x'), 'TRANSFER');
  assert.equal(selectorToLabel(''), 'TRANSFER');
  assert.equal(selectorToLabel('0xdeadbeef'), 'CALL 0xdeadbeef');
  // Not four bytes of hex — no selector, so no claim about what it calls.
  assert.equal(selectorToLabel('0xzz'), 'CALL');
});

// ── nonce and ordering ────────────────────────────────────────────

test('the next nonce clears everything already in the queue, not just the chain', () => {
  assert.equal(nextNonce({ nonce: 3, queue: [] }), 3);
  assert.equal(nextNonce({ nonce: 3, queue: [{ nonce: 3 }, { nonce: 5 }] }), 6);
  // A queue holding only nonces behind the chain's cannot pull the next one
  // backwards — that would build a proposal the vault has already consumed.
  assert.equal(nextNonce({ nonce: 9, queue: [{ nonce: 2 }] }), 9);
});

test('pending policy changes are the self-calls that move the owner set, and only those', () => {
  const v = vault({
    queue: [
      { nonce: 1, target: VAULT, callData: ms('addOwner', [BOB]) },
      { nonce: 2, target: VAULT, callData: ms('setThreshold', [3]) },
      { nonce: 3, target: VAULT, callData: ms('setDelay', [0]) },          // policy, but not the owner set
      { nonce: 4, target: TOKEN, callData: erc20Iface.encodeFunctionData('transfer', [BOB, 1n]) },
      // The same selector aimed at another contract is not this vault's policy.
      { nonce: 5, target: BOB, callData: ms('addOwner', [ALICE]) },
    ],
  });
  assert.deepEqual(pendingPolicyChanges(v), [
    { nonce: 1, label: 'ADD OWNER' },
    { nonce: 2, label: 'SET THRESHOLD' },
  ]);
  assert.deepEqual(pendingPolicyChanges(null), []);
  assert.deepEqual(pendingPolicyChanges({ address: VAULT }), []);
});

// ── the ceiling the contract's own arithmetic imposes ─────────────

test('the safe threshold ceiling is the one below where uint16 arithmetic wraps', () => {
  // Audit H-2. execute() computes `_threshold * 65` in uint16 inside an
  // unchecked block, so it wraps at 65536: at threshold 1009 the length check
  // demands 49 bytes while the verification loop reads to 65,584, and no sigs
  // value satisfies both. The owners' signature path is dead permanently.
  assert.equal(MAX_SAFE_THRESHOLD, 1008);
  assert.ok(MAX_SAFE_THRESHOLD * 65 < 65536);
  assert.ok((MAX_SAFE_THRESHOLD + 1) * 65 > 65535);
});
