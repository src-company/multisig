// The quick-fill buttons — 25%, 50%, MAX — and the figure they put in the field.
//
//   node --test              (from the repo root; discovers every suite)
//
// Same shape as the other suites, and lifted the same way: the dapp is one HTML
// file with its script inline, so this reads that file, pulls declarations out
// by name into a sandbox, and stubs only what each one will not run without. A
// missing name throws rather than returning nothing, so a rename fails the suite
// instead of quietly deleting its coverage.
//
// Why these three functions get a suite of their own. They are the only place in
// this app where a number nobody typed ends up in an amount field, and what
// lands there is what the proposal carries: the send builder's figure is signed
// by every co-signer and executed by the vault, and there is no step between the
// button and the review card that would notice a wrong one. A quick fill that is
// off by a factor of ten is not a display bug.
//
// The bug this pins. `toFixed(0)` of 250 is "250", and a trailing-zero trim
// written as /\.?0+$/ eats that final zero — there is no decimal point in it for
// the regex to stop at — so 25% of 1000 units of a 0-decimal token filled in 25.
// The stake fill next to it is not affected, because toFixed(8) always leaves a
// point behind; the send fill takes its precision from the token, so 0-decimal
// tokens reach it with none. Both are asserted below, including the reason the
// safe one is safe, because that reason is a property of an argument and could
// be changed by somebody tidying it.
//
// 0-decimal ERC-20s are rare and entirely real: the standard makes decimals()
// optional and returns whatever the contract chose, and this app reads it per
// token rather than assuming 18 — which is the whole point of it doing so.

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
    if (end >= LINES.length) throw new Error(`fills.test.js: no closing line found for 'const ${name}'.`);
    return LINES.slice(asConst, end + 1).join('\n');
  }
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`fills.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`fills.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const NEEDED = [
  'stripCommas', 'toUnits', '_amtTrim',
  'onTxAmount', 'fillTxPct', 'onStakeAmount', 'fillStakePct',
];

// Enough of a DOM for handlers that patch one: they write a handful of nodes by
// id and nothing else. Each element remembers what was written so a test can
// read it back.
const nodes = new Map();
function elem(id) {
  return { id, value: '', textContent: '', dataset: {}, focus() {} };
}
function freshDom(ids) {
  nodes.clear();
  for (const id of ids) nodes.set(id, elem(id));
}

const sandbox = {
  console: { ...console, warn() {}, error() {} },
  S: {},
  document: { getElementById: id => nodes.get(id) || null },
  // The review card repaints itself off S on every keystroke. What it draws is
  // its own suite's business; what matters here is that the fill reached it.
  updateTxReview: () => { sandbox._reviewed = (sandbox._reviewed || 0) + 1; },
  fmtUsd: n => `$${n}`,
  TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
  crypto: globalThis.crypto,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

const handOut = NEEDED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n');
vm.runInContext(NEEDED.map(grab).join('\n') + '\n' + handOut, sandbox);
for (const n of NEEDED) {
  if (sandbox[n] === undefined) throw new Error(`fills.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}

const { fillTxPct, fillStakePct } = sandbox;

const TX_IDS = ['tx-amount', 'tx-units', 'tx-amount-warn', 'tx-amount-usd'];
const STAKE_IDS = ['stake-amount', 'stake-units', 'stake-amount-warn', 'stake-amount-usd'];

function fillTx(frac, amountStr, dec, avail) {
  freshDom(TX_IDS);
  sandbox.S.txAmount = '';
  fillTxPct(frac, amountStr, dec, avail, dec === 18 ? 'WEI' : `UNITS (${dec} DECIMALS)`);
  return nodes.get('tx-amount').value;
}
function fillStake(frac, amountStr, avail) {
  freshDom(STAKE_IDS);
  sandbox.S.stakeAmount = '';
  fillStakePct(frac, amountStr, avail);
  return nodes.get('stake-amount').value;
}

// ── the send builder's fill ───────────────────────────────────────

test('a quarter of 1000 units of a 0-decimal token is 250, not 25', () => {
  // The whole reason this suite exists. toFixed(0) leaves "250" with no decimal
  // point, and the trim that used to run here took the last zero with it.
  assert.equal(fillTx(0.25, '1000', 0, 1000), '250');
  assert.equal(fillTx(0.5, '1000', 0, 1000), '500');
  // And the round numbers either side of it, which fail the same way.
  assert.equal(fillTx(0.5, '20', 0, 20), '10');
  assert.equal(fillTx(0.25, '400', 0, 400), '100');
});

test('a 0-decimal fill is a whole number, because the token has no smaller part', () => {
  // 25% of 10 is 2.5 units of something that cannot be divided. toFixed(0)
  // rounds it, and the rounded figure is the one the vault can actually send.
  assert.equal(fillTx(0.25, '10', 0, 10), '3');
  assert.equal(fillTx(0.25, '9', 0, 9), '2');
});

test('a fill keeps every digit the token can carry and drops only the padding', () => {
  assert.equal(fillTx(0.5, '1', 18, 1), '0.5');
  assert.equal(fillTx(0.5, '0.0001', 18, 0.0001), '0.00005');
  assert.equal(fillTx(0.25, '100', 6, 100), '25');
  assert.equal(fillTx(0.5, '1.5', 6, 1.5), '0.75');
});

test('a whole-number fill of an 18-decimal token does not lose its zeros either', () => {
  // The same regex ate these too — it is only the decimal point that ever saved
  // them, and toFixed(8) of 500 is "500.00000000", which has one.
  assert.equal(fillTx(0.5, '1000', 18, 1000), '500');
  assert.equal(fillTx(0.25, '4000', 18, 4000), '1000');
});

test('MAX fills the exact figure it was handed, with no rounding of its own', () => {
  // A balance is not a number this may re-derive: it arrives as the string the
  // holding formatted to, and rounding it at 8 places would send less than the
  // vault holds — or, on the way up, more than it does.
  assert.equal(fillTx(1, '123.456789012345678901', 18, 123.45), '123.456789012345678901');
  assert.equal(fillTx(1, '1000', 0, 1000), '1000');
});

test('a fill of nothing is zero rather than NaN', () => {
  assert.equal(fillTx(0.5, '0', 18, 0), '0');
  assert.equal(fillTx(0.5, '', 18, 0), '0');
});

test('the fill lands in state and in the review, not only in the field', () => {
  // The field is rebuilt by the next render, which reads S.txAmount. A fill that
  // wrote only the DOM would be erased by a poll tick.
  freshDom(TX_IDS);
  sandbox.S.txAmount = '';
  sandbox._reviewed = 0;
  fillTxPct(0.5, '2', 18, 2, 'WEI');
  assert.equal(sandbox.S.txAmount, '1');
  assert.equal(nodes.get('tx-units').textContent, '1000000000000000000 WEI');
  assert.ok(sandbox._reviewed > 0, 'the review card was not repainted for the fill');
});

// ── the stake fill, which is safe for a reason worth pinning ──────

test('the stake fill is safe because its precision is fixed, not because it is lucky', () => {
  // fillStakePct calls toFixed(8) with no argument taken from a token, so there
  // is always a decimal point in what it trims. Staking is ETH-only, so 18
  // decimals is not a variable here — but if that ever became one, this is the
  // assertion that would fail rather than a co-signer noticing.
  assert.equal(fillStake(0.5, '1000', 1000), '500');
  assert.equal(fillStake(0.25, '20', 20), '5');
  assert.equal(fillStake(0.5, '0.0001', 0.0001), '0.00005');
  assert.equal(fillStake(1, '1.234567890123456789', 1.23), '1.234567890123456789');
});
