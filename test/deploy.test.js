// The multichain deploy — the parts of it that are decidable without a wallet.
//
//   node --test              (from the repo root; discovers both suites)
//
// Same shape as names.test.js, and for the same reason: the dapp is one HTML
// file with its script inline, so this reads that file, lifts declarations out
// by name into a sandbox, and stubs only what each one will not run without. A
// missing name throws rather than returning nothing, so a rename fails the suite
// instead of quietly deleting its coverage.
//
// What is NOT here: anything that needs a wallet. The chain walk is a sequence
// of prompts and switches, and mocking a wallet well enough to prove something
// about it proves something about the mock. What IS here is everything the walk
// decides before it asks for a signature — which chain the form aims at, which
// address gets mined, whether a saved record may be resumed from, and whether
// the code that comes back is the audited build — because that is the half where
// a mistake is permanent: the owner set cannot be revised, and the address is
// where somebody's funds get sent.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dapp', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

// A `const NAME = ...` one-liner, or a `function NAME(...)` closed by a brace in
// column 0 — the two shapes that file uses. Kept identical to names.test.js on
// purpose: two copies of a nine-line reader are cheaper than a shared module in
// a repo that deliberately has no build step, and the day they diverge, they
// diverge loudly.
function grab(name) {
  const asConst = LINES.findIndex(l => l.startsWith(`const ${name} `) || l.startsWith(`const ${name}=`));
  if (asConst !== -1) return LINES[asConst];
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`deploy.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`deploy.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const NEEDED = [
  'NETS', 'IMPLEMENTATION', 'WNS_CHAIN_ID', 'RESUME_MAX_AGE', 'FACTORY',
  'syncCreateNet', 'toggleClone', 'deployGasEstimate',
  'buildInitcode', 'expectedCloneCode', 'classifyVaultCode', 'mineVanitySalt',
  '_sameAddr', '_findResume', '_resumeValid', '_resumeLeft',
  'renderDeployOverlay',
];

// Deliberately hand-written, all of them. CHAINS and MULTISIG_ABI are multi-line
// literals that grab() cannot lift, and the two ethers helpers below are stood in
// for so that what is being asserted is the dapp's arithmetic and not ethers'.
const sandbox = {
  console,
  S: { chainId: 1, cf: null, deploy: null },
  CHAINS: { 1: {}, 8453: {}, 4326: {}, 42161: {}, 10: {}, 11155111: {}, 84532: {} },
  MULTISIG_ABI: [],
  provider: null,
  render: () => {},
  esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  shortAddr: a => (/^0x[0-9a-fA-F]{40}$/.test(a || '') ? a.slice(0, 6) + '…' + a.slice(-4) : (a || '')),
  chainIcon: () => '',
  fmtD: s => `${s}s`,
  fmtGasShort: w => `${w} wei`,
  ethers: {
    keccak256: () => '0x' + 'cd'.repeat(32),
    // Enough of a CREATE2 to be observable: every fourth candidate wins the 00
    // prefix the miner is looking for, so which one it settles on is a fact the
    // test can assert rather than a hash it has to precompute.
    getCreate2Address: (f, salt) => {
      const n = Number(BigInt(salt) & 0xffn);
      return '0x' + (n % 4 === 0 ? '00' : '11') + String(n).padStart(38, '0');
    },
    Contract: function (addr, abi, rp) { return rp.contract; },
  },
};
vm.createContext(sandbox);
const handOut = NEEDED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n');
vm.runInContext(NEEDED.map(grab).join('\n') + '\n' + handOut, sandbox);
for (const n of NEEDED) {
  if (sandbox[n] === undefined) throw new Error(`deploy.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}
const {
  NETS, IMPLEMENTATION, WNS_CHAIN_ID, syncCreateNet, toggleClone, deployGasEstimate,
  buildInitcode, expectedCloneCode, classifyVaultCode, mineVanitySalt,
  _sameAddr, _findResume, _resumeValid, _resumeLeft, renderDeployOverlay,
} = sandbox;

const idx = id => NETS.findIndex(n => n.id === id);
const ETH = idx(1), BASE = idx(8453), ARB = idx(42161);
const form = o => (sandbox.S.cf = Object.assign({ net: ETH, clone: [], netPicked: false }, o));

// ── the form's deploy target ──────────────────────────────────────

test('an untouched form aims at the chain the app is on', () => {
  form({ net: ETH });
  sandbox.S.chainId = 8453;
  syncCreateNet();
  assert.equal(sandbox.S.cf.net, BASE, 'the default is the network already in play, not the first in the list');
});

test('a network the operator picked is never overwritten', () => {
  form({ net: ETH, netPicked: true });
  sandbox.S.chainId = 8453;
  syncCreateNet();
  assert.equal(sandbox.S.cf.net, ETH);
});

test('ticking a clone target freezes the primary too', () => {
  // Otherwise a wallet that wanders onto Base promotes Base to primary and drops
  // it from the row it was just ticked in — "Ethereum and Base" silently becomes
  // "Base", and the vault the operator gets is not the one they asked for.
  form({ net: ETH });
  toggleClone(BASE);
  sandbox.S.chainId = 8453;
  syncCreateNet();
  assert.equal(sandbox.S.cf.net, ETH, 'primary stays where it was');
  assert.deepEqual([...sandbox.S.cf.clone], [BASE], 'and the clone pick survives');
});

test('a deploy in flight never moves the form under it', () => {
  // The CREATE view renders underneath the deploy overlay, and the chain walk
  // moves S.chainId once per chain. Following it there would rewrite the primary
  // to whichever chain is being signed for and delete each one from the clone row
  // as the walk reached it — a three-chain deploy ending in a form that deploys
  // to one.
  form({ net: ETH, clone: [BASE, ARB] });
  sandbox.S.deploy = { run: 1 };
  for (const id of [1, 8453, 42161, 1]) { sandbox.S.chainId = id; syncCreateNet(); }
  sandbox.S.deploy = null;
  assert.equal(sandbox.S.cf.net, ETH);
  assert.deepEqual([...sandbox.S.cf.clone], [BASE, ARB]);
});

test('a chain the app does not carry leaves the form alone', () => {
  form({ net: BASE });
  sandbox.S.chainId = 999999;
  syncCreateNet();
  assert.equal(sandbox.S.cf.net, BASE);
});

test('the primary is never also a clone of itself', () => {
  form({ net: ETH, clone: [BASE] });
  sandbox.S.chainId = 8453;
  syncCreateNet();
  assert.equal(sandbox.S.cf.net, BASE);
  assert.deepEqual([...sandbox.S.cf.clone], [], 'the duplicate goes, not the deploy');
});

// ── what the deploy is expected to cost ───────────────────────────

test('gas is priced per chain, because the transaction differs per chain', () => {
  const ctx = { resolvedOwners: ['a', 'b', 'c'], wantForward: true, wns: { label: 'x' } };
  const onMainnet = deployGasEstimate(ctx, WNS_CHAIN_ID);
  const onClone = deployGasEstimate(ctx, 8453);
  // The name claim is two init calls that only ride on the mainnet step — WNS is
  // deployed there and nowhere else. Charging every clone for them made the
  // check stricter than the truth on exactly the chains an operator is least
  // likely to hold a float on.
  assert.ok(onMainnet > onClone, 'the mainnet step carries the name claim');
  assert.equal(onMainnet - onClone, 140000n);
  assert.equal(deployGasEstimate(ctx), onMainnet, 'no chain named prices the heaviest version');
  // More owners is more cold storage, and the floor is never zero.
  assert.ok(deployGasEstimate({ resolvedOwners: ['a', 'b'] }, 1) > deployGasEstimate({ resolvedOwners: ['a'] }, 1));
  assert.ok(deployGasEstimate(null, 1) >= 150000n);
});

// ── the address, and the code that ends up at it ──────────────────

test('the initcode deploys exactly the runtime the app checks for', () => {
  // These two are written out by hand in different places: one is what create2
  // hashes, the other is what a deployed vault is compared against. If they ever
  // disagree, every deploy on every chain succeeds and is then condemned by its
  // own read-back as CODE AT ADDRESS IS NOT THE AUDITED BUILD.
  const init = buildInitcode(IMPLEMENTATION);
  const runtime = expectedCloneCode(IMPLEMENTATION);
  assert.equal('0x' + init.slice(2 + 18), runtime, 'the initcode is a 9-byte copier followed by the runtime');
  assert.equal((runtime.length - 2) / 2, 45, 'the audited clone is 45 bytes');
  assert.ok(init.slice(2).startsWith('602d'), 'and the copier returns 0x2d = 45 of them');
  assert.ok(runtime.includes(IMPLEMENTATION.slice(2).toLowerCase()), 'delegating to the audited implementation');
});

test('code at the address is classified, not assumed', () => {
  const rp = code => ({ getCode: async () => code });
  return Promise.all([
    classifyVaultCode('0x0', rp(expectedCloneCode(IMPLEMENTATION))).then(k => assert.equal(k, 'clone')),
    classifyVaultCode('0x0', rp(expectedCloneCode(IMPLEMENTATION).toUpperCase())).then(k => assert.equal(k, 'clone', 'case is not a difference')),
    classifyVaultCode('0x0', rp('0xef0100' + IMPLEMENTATION.slice(2).toLowerCase())).then(k => assert.equal(k, '7702', 'an EOA delegating to it still signs')),
    classifyVaultCode('0x0', rp('0xef0100' + 'ab'.repeat(20))).then(k => assert.equal(k, 'foreign', 'delegating somewhere else is not this protocol')),
    classifyVaultCode('0x0', rp('0x')).then(k => assert.equal(k, 'empty')),
    classifyVaultCode('0x0', rp('0x60806040')).then(k => assert.equal(k, 'foreign')),
    // A chain that will not answer is not a chain with nothing on it. Reporting
    // silence as 'empty' is what would let a deploy be called a failure and
    // retried onto an address that already holds the vault.
    classifyVaultCode('0x0', { getCode: async () => { throw new Error('down'); } }).then(k => assert.equal(k, null)),
  ]);
});

const CALLER = '0x' + '33'.repeat(20);
const IMPL = '0x' + '44'.repeat(20);
const chains = codes => [{ getCode: async a => (codes && codes[a.toLowerCase()]) || '0x' }];
const nth = n => '0x' + (n % 4 === 0 ? '00' : '11') + String(n).padStart(38, '0');

test('mining settles on the first address free on every chain in the deploy', async () => {
  let m = await mineVanitySalt('0xf', IMPL, CALLER, chains());
  assert.equal(m.address, nth(0));
  assert.equal(m.salt >> 96n, BigInt(CALLER), 'the salt still names the deployer, which is what the factory checks');

  m = await mineVanitySalt('0xf', IMPL, CALLER, chains({ [nth(0)]: '0x60' }));
  assert.equal(m.address, nth(4), 'an address taken on any target chain is stepped over');
});

test('mining steps over an address an unfinished deploy is holding', async () => {
  // The search is deterministic — same deployer, same first candidate, every
  // time — and it moves on only when it finds code. An interrupted deploy has by
  // definition put no code on the chains it never reached, so a second vault
  // would be minted at the exact address the first is holding open for its
  // clone, and that clone could then never be made.
  let m = await mineVanitySalt('0xf', IMPL, CALLER, chains(), [nth(0)]);
  assert.equal(m.address, nth(4));

  m = await mineVanitySalt('0xf', IMPL, CALLER, chains(), [nth(0).toUpperCase(), null, undefined]);
  assert.equal(m.address, nth(4), 'case-insensitive, and tolerant of holes in the list');

  m = await mineVanitySalt('0xf', IMPL, CALLER, chains(), []);
  assert.equal(m.address, nth(0), 'an empty hold list changes nothing');
});

// ── resuming an interrupted chain walk ────────────────────────────

const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20);
const rec = o => Object.assign({
  v: 1, ts: Date.now(), deployer: A, salt: '0x' + 'ab'.repeat(32), minedAddr: B,
  owners: [A], thresh: 1, del: 0, executor: A,
  chains: [{ id: 1, name: 'ETHEREUM' }], doneIds: [],
}, o);

test('a resume record is checked by shape, not by presence', () => {
  assert.equal(_resumeValid(rec()), true);
  assert.equal(_resumeValid(rec({ salt: 'ab' })), false, 'the salt is fed to BigInt()');
  assert.equal(_resumeValid(rec({ minedAddr: '0x1234' })), false, 'the address is sent to an RPC');
  assert.equal(_resumeValid(rec({ ts: Date.now() - 31 * 24 * 3600 * 1000 })), false);
  assert.equal(_resumeValid(rec({ chains: [] })), false);
  assert.equal(_resumeValid(rec({ v: 2 })), false);
  assert.equal(_resumeValid(null), false);
});

test('a record that cannot say who owns the vault is not resumed from', () => {
  // The CREATE2 address is a function of the salt alone — the owners are not in
  // it. So a mangled owner list resumes perfectly happily and puts a *different
  // vault* at the same address on every chain the run never reached: two chains,
  // one address, two owner sets, and nothing on screen to say so.
  assert.equal(_resumeValid(rec({ owners: ['0xnope'] })), false);
  assert.equal(_resumeValid(rec({ owners: [A, null] })), false);
  assert.equal(_resumeValid(rec({ owners: [{ addr: A }] })), false);
  assert.equal(_resumeValid(rec({ owners: [] })), false);
  assert.equal(_resumeValid(rec({ owners: [A, B] })), true);
});

test('what a record still owes is the chains it has not reached', () => {
  const r = rec({ chains: [{ id: 1 }, { id: 8453 }, { id: 7777 }], doneIds: [1] });
  assert.deepEqual(_resumeLeft(r).map(c => c.id), [8453], 'done chains drop out, and so do ones this build no longer carries');
  assert.deepEqual(_resumeLeft(rec({ doneIds: [1] })).map(c => c.id), [], 'a finished record owes nothing');
  assert.deepEqual(_resumeLeft(null), []);
});

test('records are found by address, however it is cased', () => {
  const list = [rec({ minedAddr: A }), rec({ minedAddr: B })];
  assert.equal(_findResume(list, B.toUpperCase()).minedAddr, B);
  assert.equal(_findResume(list, '0x' + '99'.repeat(20)), undefined);
  assert.ok(_sameAddr(A, A.toUpperCase()) && !_sameAddr(A, B));
});

// ── what the dialog offers when the walk stops ────────────────────
//
// Rendered rather than described: these are the two screens standing between an
// operator and an irreversible owner set, and every one of the states below is
// one somebody actually ends up in.

const OK_PF = { gasOk: true, gasShort: null, executorOk: null, factoryOk: true, implOk: true, needExec: false };
const step = (id, name, o) => Object.assign({ id, name, status: 'pending' }, o);
const dep = o => Object.assign({
  run: 1,
  chains: [{ id: 1, name: 'ETHEREUM' }, { id: 8453, name: 'BASE' }],
  steps: [step(1, 'ETHEREUM'), step(8453, 'BASE')],
  ctx: {
    resolvedOwners: [A], ownerLabels: [''], connectedAddress: A,
    thresh: 1, del: 0, executor: A, minedAddr: B, wantForward: false, wns: null,
    deployerIsOwner: true, fastPathVoid: false,
  },
  phase: 'deploying', address: B, done: true, halted: null, lastVaultAddr: B, wnsAvail: null,
}, o);
const draw = d => { sandbox.S.deploy = d; return renderDeployOverlay.call(null, d) ; };
// renderDeployOverlay reads S.deploy through its own local, so it is passed the
// same object the app would have put there.
sandbox.renderDeployOverlay = renderDeployOverlay;
const render1 = d => vm.runInContext('renderDeployOverlay()', Object.assign(sandbox, { S: Object.assign(sandbox.S, { deploy: d }) }));

test('a run that finished short offers to finish, halt or no halt', () => {
  // A halt is not the only way to end up owing a chain. A RETRY that succeeds
  // clears the halt, and the chains the run never reached were then left at NOT
  // ATTEMPTED under a DONE title whose only button said VIEW VAULT.
  const retried = render1(dep({
    steps: [step(1, 'ETHEREUM', { status: 'done' }), step(8453, 'BASE')],
  }));
  assert.match(retried, /RESUME/, 'the chain that was never tried is still offered');
  assert.match(retried, /NOT ATTEMPTED/);
  assert.match(retried, /1 of 2 chains has the vault/);

  const halted = render1(dep({
    steps: [step(1, 'ETHEREUM', { status: 'done' }), step(8453, 'BASE', { status: 'failed', blocked: true, err: 'SWITCH TO BASE REJECTED IN WALLET' })],
    halted: { at: 1, name: 'BASE', reason: 'SWITCH TO BASE REJECTED IN WALLET' },
  }));
  assert.match(halted, /RESUME/);
  assert.match(halted, /Stopped at BASE/);
});

test('a run with nothing left to do offers only the vault', () => {
  const all = render1(dep({
    steps: [step(1, 'ETHEREUM', { status: 'done' }), step(8453, 'BASE', { status: 'skipped' })],
  }));
  assert.match(all, /VIEW VAULT/);
  assert.ok(!/RESUME/.test(all), 'nothing is owed, so nothing is offered');
});

test('with no address mined there is nothing to resume towards', () => {
  const noAddr = render1(dep({
    address: null, lastVaultAddr: null,
    ctx: Object.assign({}, dep().ctx, { minedAddr: null }),
    steps: [step(1, 'ETHEREUM', { status: 'failed', err: 'X' }), step(8453, 'BASE', { status: 'failed', err: 'X' })],
  }));
  assert.ok(!/RESUME/.test(noAddr), 'resuming would just mine a different address');
  assert.match(noAddr, /CLOSE/);
});

test('a preflight that never answered is never shown as READY', () => {
  // The preflight's own catch drops straight to this screen. Every check was
  // written as "pf says false", and a preflight that never ran says nothing at
  // all — so every row came up green on a screen that has one job.
  const silent = render1(dep({ phase: 'review', done: false }));
  assert.match(silent, /UNCHECKED &middot; NO REPLY|UNCHECKED · NO REPLY/);
  assert.ok(!/>READY</.test(silent), 'absence of an answer is not an answer');

  const answered = render1(dep({
    phase: 'review', done: false,
    steps: [step(1, 'ETHEREUM', { pf: OK_PF }), step(8453, 'BASE', { pf: OK_PF })],
  }));
  assert.match(answered, /READY/, 'a chain that did answer, and answered well, says so');
});

test('the review says when the address it exists to show is missing', () => {
  const mined = render1(dep({
    phase: 'review', done: false, address: B,
    steps: [step(1, 'ETHEREUM', { pf: OK_PF }), step(8453, 'BASE', { pf: OK_PF })],
  }));
  assert.match(mined, /SAME ON ALL 2 CHAINS/);
  assert.ok(!/could not be mined/.test(mined));

  const unmined = render1(dep({
    phase: 'review', done: false, address: null,
    steps: [step(1, 'ETHEREUM', { pf: OK_PF }), step(8453, 'BASE', { pf: OK_PF })],
  }));
  assert.match(unmined, /could not be mined/, 'the one thing this screen is for is missing, and it says so');
  assert.match(unmined, /DEPLOY/, 'and it is still a deploy the operator may choose to make');
});
