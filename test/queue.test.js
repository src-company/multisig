// The queue card — what the dashboard offers an owner standing in front of a
// proposal.
//
//   node --test              (from the repo root; discovers all three suites)
//
// Same shape as names.test.js and deploy.test.js, and lifted the same way: the
// dapp is one HTML file with its script inline, so this reads that file, pulls
// declarations out by name into a sandbox, and stubs only what each one will not
// run without. A missing name throws rather than returning nothing, so a rename
// fails the suite instead of quietly deleting its coverage.
//
// Why a render function is worth a suite of its own. renderDash builds the page
// from a template literal and renderNow assigns the result to #app in one go, so
// a throw anywhere inside it never reaches that assignment: #app keeps whatever
// it held — an empty div on a first paint — and every later render throws in the
// same place. The page is then blank, permanently, and the only report is an
// uncaught error in an animation-frame callback, which is a console line and
// nothing else.
//
// That is not hypothetical. `cannotSign(ct.connectedAddress, …)` shipped in the
// branch that draws SIGN — `ct` is the deploy overlay's context object and has
// never been in scope here — so the first co-signer to open a vault with a
// proposal waiting for them got a blank page. Every existing suite passed: the
// file parses, and nothing else calls renderDash.
//
// So these tests are deliberately unglamorous. They call renderDash for each
// state a queue card can be in and assert it produced the control that state is
// supposed to offer. What they are really asserting is that it returned at all.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dapp', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

// A `const NAME = ...` one-liner, or a `function NAME(...)` closed by a brace in
// column 0. Kept identical to the other two suites on purpose: three copies of a
// nine-line reader are cheaper than a shared module in a repo that deliberately
// has no build step, and the day they diverge, they diverge loudly.
function grab(name) {
  const asConst = LINES.findIndex(l => l.startsWith(`const ${name} `) || l.startsWith(`const ${name}=`));
  if (asConst !== -1) return LINES[asConst];
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`queue.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`queue.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

// The real thing, wherever the answer under test depends on it. txSt is what
// decides which branch renderDash takes, so stubbing it would leave the suite
// asserting against its own idea of the states rather than the app's.
const NEEDED = [
  'renderDash', 'txSt', 'fmtEta', 'canForwardCancel', 'hasForwarder', 'isCancelTx',
  'vaultDot', 'ownerIdent', 'thresholdNote', 'delayNote',
];

const YOU = '0x1111111111111111111111111111111111111111';
const THEM = '0x2222222222222222222222222222222222222222';
const TARGET = '0x3333333333333333333333333333333333333333';
const EXECUTOR = '0x00000000a72A30AdBf38e14d36BCE2610ec3973F';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Everything renderDash reaches for and does not need to be real to answer the
// question here: markup helpers, icons, links, and the two sibling renderers it
// composes with. Each returns something inert and identifiable, so a test that
// accidentally asserts against a stub says so.
const sandbox = {
  console,
  S: {
    sel: 0, vaults: [], demoMode: false, chainId: 1, showTx: false, priv: false,
    latestBlock: 0,
  },
  // Module-level `let`s renderDash closes over. Absent from the sandbox they are
  // a ReferenceError, which is the very failure mode this suite exists for — so
  // they are declared, not stubbed away.
  _focusNonce: null,
  _focusVaultAddr: null,
  _rejectArmed: null,
  ethers: {
    isAddress: a => /^0x[0-9a-fA-F]{40}$/.test(a || ''),
    ZeroAddress: '0x0000000000000000000000000000000000000000',
  },
  esc,
  jstr: s => esc(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")),
  shortAddr: a => (/^0x[0-9a-fA-F]{40}$/.test(a || '') ? a.slice(0, 6) + '…' + a.slice(-4) : (a || '')),
  NOW: () => Math.floor(Date.now() / 1000),
  fmtD: s => `${s}s`,
  getYou: () => sandbox._you,
  _you: YOU,
  // The one under test by proxy: renderDash asks it whether the connected
  // account can produce a signature this vault could verify. It reads the chain,
  // so it answers null (unknown) until something comes back — which is exactly
  // the state a fresh page is in, and the state the crashed line was reached in.
  cannotSign: () => sandbox._cannotSign,
  _cannotSign: false,
  txKind: () => ({ label: 'ETH TRANSFER', tone: 'value' }),
  tokIcon: () => '',
  pgAttrs: () => '',
  addrLink: a => `<a>${esc(a)}</a>`,
  copyBtn: () => '',
  signerIdentHtml: o => `<span>${esc(o.addr)}</span>`,
  txExplorerLink: () => '',
  renderSlowOutbound: () => '',
  renderTxBuilder: () => '<div id="txb"></div>',
  renderSim: () => '',
  vaultRef: v => v.address,
  appBase: () => 'https://example.test/',
  refHash: (ref, nonce) => '#1/' + ref + (nonce == null ? '' : '/tx/' + nonce),
  nameKindsHint: () => '.eth/.wei',
  chainName: () => 'ETHEREUM',
  isMegaName: () => false,
  isBaseName: () => false,
  selOf: d => (typeof d === 'string' && d.length >= 10 ? d.slice(0, 10) : ''),
  SEL: { cancelQueued: '0xdeadbeef' },
};
vm.createContext(sandbox);
const handOut = NEEDED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n');
vm.runInContext(NEEDED.map(grab).join('\n') + '\n' + handOut, sandbox);
for (const n of NEEDED) {
  if (sandbox[n] === undefined) throw new Error(`queue.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}
const { renderDash } = sandbox;

// A vault with one proposal in it, in whatever state the test needs.
function vault(tx, over) {
  const v = Object.assign({
    name: 'TREASURY', address: '0x8F3A700c444912532413045090F932634456e7D1',
    chain: 'ETHEREUM', threshold: 2, ownerCount: 2, delay: 86400, nonce: 40,
    executor: EXECUTOR, isTimelockExecutor: true, fastPath: false,
    holdings: [], history: [], codeKind: 'clone',
    owners: [{ addr: YOU, label: '', you: true }, { addr: THEM, label: '', you: false }],
    queue: tx ? [tx] : [],
  }, over || {});
  sandbox.S.vaults = [v];
  sandbox.S.sel = 0;
  return v;
}

const proposal = over => Object.assign({
  nonce: 40, target: TARGET, callData: '0x', rawValue: '1000000000000000000',
  value: '1', token: 'ETH', displayValue: '1', displayToken: 'ETH',
  eta: 0, approvals: { [YOU]: false, [THEM]: false }, txHash: '0x' + 'ab'.repeat(32),
}, over || {});

const draw = () => renderDash(sandbox.S.vaults[sandbox.S.sel], false);

// ── the branch that was blank ─────────────────────────────────────

test('a proposal waiting on your signature draws, and offers to sign it', () => {
  // The regression. This is the ordinary state of every proposal a co-signer is
  // sent a link to, and it threw ReferenceError before renderDash returned a
  // single character — so the assertion that matters most here is simply that
  // the call completes.
  vault(proposal());
  const html = draw();
  assert.match(html, /doSign\(0,40\)/, 'the SIGN button is the whole point of this state');
  assert.match(html, /doApprove\(0,40\)/, 'with the on-chain route offered beside it');
});

test('an account that cannot sign is offered approval instead, and never SIGN', () => {
  // The change the crash arrived in, working as intended: a contract account has
  // no key, so offering it SIGN is offering an action that cannot succeed.
  vault(proposal());
  sandbox._cannotSign = true;
  try {
    const html = draw();
    assert.match(html, /doApprove\(0,40\)/);
    assert.doesNotMatch(html, /doSign\(0,40\)/, 'a contract account has nothing to sign with');
    assert.match(html, /CANNOT SIGN/);
  } finally { sandbox._cannotSign = false; }
});

test('the demo never asks a chain whether the demo account has code', () => {
  // getYou() answers DEMO_YOU there, and there is no chain behind it to ask —
  // cannotSign would fire a getCode against whatever network the app happened to
  // be pointed at, for an address that does not exist on it.
  vault(proposal());
  sandbox.S.demoMode = true;
  let asked = false;
  const real = sandbox.cannotSign;
  sandbox.cannotSign = (...a) => { asked = true; return real(...a); };
  try {
    draw();
    assert.equal(asked, false, 'the demo has no chain to answer this');
  } finally { sandbox.cannotSign = real; sandbox.S.demoMode = false; }
});

// ── every other state a card can be in ────────────────────────────

test('a proposal you have already signed offers only to undo that', () => {
  vault(proposal({ approvals: { [YOU]: true, [THEM]: false } }));
  const html = draw();
  assert.match(html, /doUnsign\(0,40\)/);
  assert.doesNotMatch(html, /doSign\(0,40\)/, 'there is nothing left for you to sign');
});

test('a proposal at quorum is submitted, not signed again', () => {
  vault(proposal({ approvals: { [YOU]: true, [THEM]: true } }));
  const html = draw();
  assert.match(html, /doSubmit\(0,40\)/);
});

test('a matured proposal offers execute, and the cancel it can still be stopped with', () => {
  vault(proposal({ eta: Math.floor(Date.now() / 1000) - 60, approvals: { [YOU]: true, [THEM]: true } }));
  const html = draw();
  assert.match(html, /doExecute\(0,40\)/);
  assert.match(html, /doCancel\(0,40\)/, 'the brake is offered right up to the moment it runs');
});

test('a vault with no executor says so rather than offering a cancel that cannot work', () => {
  // canForwardCancel: a cancel routes through TimelockExecutor.forward(), and a
  // call to an address holding no code does not revert — it mines, reports
  // success, and cancels nothing.
  vault(proposal({ eta: Math.floor(Date.now() / 1000) + 3600, approvals: { [YOU]: true, [THEM]: true } }),
    { executor: sandbox.ethers.ZeroAddress, isTimelockExecutor: false });
  const html = draw();
  assert.doesNotMatch(html, /doCancel\(0,40\)/);
  assert.match(html, /CANNOT CANCEL/);
});

test('an empty queue is a resting state, not an error', () => {
  vault(null);
  const html = draw();
  assert.match(html, /NO PENDING TRANSACTIONS/);
});

test('no vault at all still draws the page that offers to make one', () => {
  sandbox.S.vaults = [];
  const html = renderDash(null, false);
  assert.match(html, /CREATE VAULT/);
});

// ── the rows below the queue ──────────────────────────────────────

test('every owner is listed, whether or not they have signed', () => {
  vault(proposal({ approvals: { [YOU]: true, [THEM]: false } }));
  const html = draw();
  assert.ok(html.includes(YOU), 'you are in the roster');
  assert.ok(html.includes(THEM), 'and so is the owner being waited on');
  assert.match(html, /1 AWAITING/, 'the owner holding it up is named as such');
});
