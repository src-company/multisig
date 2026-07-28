// The top up dialog's arithmetic — what MAX is allowed to fill, and what the
// field remembers.
//
//   node --test              (from the repo root; discovers every suite)
//
// Same shape as the other suites, and lifted the same way: the dapp is one HTML
// file with its script inline, so this reads that file, pulls declarations out
// by name into a sandbox, and stubs only what each one will not run without. A
// missing name throws rather than returning nothing, so a rename fails the suite
// instead of quietly deleting its coverage.
//
// Why this dialog gets a suite. A top up is the one screen in this app that
// moves money without a signature, a threshold or a timelock behind it: what the
// button sends is what the field says, immediately and finally. Three things
// there are worth pinning:
//
//   the gas reserve   a deposit of every last wei cannot pay for itself. MAX on
//                     the native asset has to leave the fee for its own transfer
//                     behind, and the figure it leaves has to come from the
//                     chain rather than from a constant somebody guessed.
//   the percentages   25% of 1000 units of a 0-decimal token is 250, and a
//                     trailing-zero trim written as /\.?0+$/ makes it 25. There
//                     is no decimal point in "250" for that regex to stop at.
//   the typed amount  the overlay is rebuilt from scratch by every render, and
//                     this dialog renders on its own account when the balance
//                     read lands. An amount typed before that arrived used to be
//                     erased by the answer.
//
// Real ethers, because formatUnits is where the scaling actually happens and a
// stand-in for it would be this suite testing its own opinion of what a wei is.

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
    if (end >= LINES.length) throw new Error(`topup.test.js: no closing line found for 'const ${name}'.`);
    return LINES.slice(asConst, end + 1).join('\n');
  }
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`topup.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`topup.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const NEEDED = [
  'stripCommas', 'toUnits', '_amtTrim', '_amtDisp',
  'TOPUP_GAS', 'topUpSpendable', 'fillTopUpPct', 'onTopUpAmount',
];

// Enough of a DOM for the two handlers that patch one: they write four nodes by
// id and nothing else. Each element remembers what was written so a test can
// read it back — including the class the submit button is toggled by, which is
// the whole of that button's readiness state.
const nodes = new Map();
function elem(id) {
  const classes = new Set();
  return {
    id, value: '', textContent: '',
    classList: {
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: c => classes.has(c),
    },
    focus() { this.focused = true; },
  };
}
function freshDom() {
  nodes.clear();
  for (const id of ['topup-amount', 'topup-units', 'topup-warn', 'topup-send']) nodes.set(id, elem(id));
}

const sandbox = {
  console: { ...console, warn() {}, error() {} },
  S: {},
  document: { getElementById: id => nodes.get(id) || null },
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
  if (sandbox[n] === undefined) throw new Error(`topup.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}

const { TOPUP_GAS, topUpSpendable, fillTopUpPct, onTopUpAmount, ethers } = sandbox;

const GWEI = 1000000000n;
const ETH = 1000000000000000000n;

// ── the gas reserve ───────────────────────────────────────────────

test('an ERC-20 MAX is the whole balance, because its gas is paid in another asset', () => {
  // 1,000 USDC. The fee for moving it does not come out of this number, so
  // nothing may be held back from it — a reserve here would silently refuse to
  // deposit funds the wallet can plainly send.
  assert.equal(topUpSpendable('1000000000', false, String(30n * GWEI)), 1000000000n);
  // And the fee data is irrelevant to that, present or not.
  assert.equal(topUpSpendable('1000000000', false, null), 1000000000n);
});

test('the native MAX leaves the fee for its own transfer behind', () => {
  const price = 2n * GWEI;
  const kept = TOPUP_GAS * price * 2n;                 // 21000 gas, doubled for headroom
  assert.equal(topUpSpendable(String(ETH), true, String(price)), ETH - kept);
  // The reserve is a real amount, not a rounding: at 2 gwei it is 0.000084 ETH.
  assert.equal(ethers.formatUnits(kept, 18), '0.000084');
});

test('the reserve tracks the price, so a busy chain holds back more than a quiet one', () => {
  const quiet = topUpSpendable(String(ETH), true, String(1n * GWEI));
  const busy = topUpSpendable(String(ETH), true, String(100n * GWEI));
  assert.ok(busy < quiet, 'a hundredfold gas price reserved no more than a 1 gwei one');
  assert.equal(quiet - busy, TOPUP_GAS * 99n * GWEI * 2n);
});

test('with no fee data there is no reserve, rather than a guessed one', () => {
  // getFeeData failed or the chain answered with neither field. An invented
  // figure would quietly shrink what somebody is allowed to deposit; the wallet
  // checks the real one either way.
  assert.equal(topUpSpendable(String(ETH), true, null), ETH);
  assert.equal(topUpSpendable(String(ETH), true, undefined), ETH);
});

test('a balance that cannot cover its own gas has nothing spendable, and never goes negative', () => {
  const price = 30n * GWEI;
  const reserve = TOPUP_GAS * price * 2n;
  assert.equal(topUpSpendable(String(reserve - 1n), true, String(price)), 0n);
  assert.equal(topUpSpendable(String(reserve), true, String(price)), 0n);
  assert.equal(topUpSpendable('0', true, String(price)), 0n);
  assert.equal(topUpSpendable(String(reserve + 5n), true, String(price)), 5n);
});

test('a raw balance that is not a whole number is not spendable', () => {
  // balanceOf comes back through a decode and a JSON round trip. BigInt('1.5')
  // throws, and this runs inside render() — where a throw is a blank page.
  for (const bad of ['1.5', 'nope', '-1', null, undefined, {}]) {
    assert.equal(topUpSpendable(bad, false, null), 0n, `${bad} was treated as a balance`);
  }
  // BigInt('') is 0n and BigInt('0x10') is 16n — both are parses, not throws,
  // and both are amounts this can hand on unchanged.
  assert.equal(topUpSpendable('', false, null), 0n);
});

// ── the quick-fill buttons ────────────────────────────────────────

test('MAX fills the exact spendable figure, with no rounding of its own', () => {
  freshDom();
  sandbox.S.topup = { amt: '' };
  fillTopUpPct(1, '0.999999916', 18, 1, 'WEI');
  assert.equal(nodes.get('topup-amount').value, '0.999999916');
  assert.equal(sandbox.S.topup.amt, '0.999999916');
});

test('a quarter of 1000 units of a 0-decimal token is 250, not 25', () => {
  // toFixed(0) of 250 is "250", and a trailing-zero trim written as /\.?0+$/
  // eats that final zero: there is no decimal point in it for the regex to stop
  // at. _amtTrim only strips zeros that are behind a point.
  freshDom();
  sandbox.S.topup = { amt: '' };
  fillTopUpPct(0.25, '1000', 0, 1000, 'UNITS (0 DECIMALS)');
  assert.equal(nodes.get('topup-amount').value, '250');
});

test('a percentage of a fractional balance keeps its digits and drops its padding', () => {
  freshDom();
  sandbox.S.topup = { amt: '' };
  fillTopUpPct(0.5, '0.0001', 18, 0.0001, 'WEI');
  assert.equal(nodes.get('topup-amount').value, '0.00005');
});

test('a percentage of nothing is zero rather than NaN', () => {
  freshDom();
  sandbox.S.topup = { amt: '' };
  fillTopUpPct(0.5, '0', 18, 0, 'WEI');
  assert.equal(nodes.get('topup-amount').value, '0');
});

// ── what the field remembers ──────────────────────────────────────

test('the typed amount is kept in state, so a rebuild cannot erase it', () => {
  // The overlay is rebuilt from scratch by every render, and this dialog renders
  // on its own account — the balance read that opens it lands in one. Before the
  // value lived in state, an amount typed while the wallet was still being
  // counted was wiped by the answer arriving.
  freshDom();
  sandbox.S.topup = { amt: '' };
  onTopUpAmount('0.25', 18, 1, 'WEI');
  assert.equal(sandbox.S.topup.amt, '0.25');
});

test('the units echo says the base-unit figure the transaction will actually carry', () => {
  freshDom();
  sandbox.S.topup = { amt: '' };
  onTopUpAmount('1.5', 18, 10, 'WEI');
  assert.equal(nodes.get('topup-units').textContent, '1500000000000000000 WEI');
  // Emptied, not left saying what the last keystroke meant.
  onTopUpAmount('', 18, 10, 'WEI');
  assert.equal(nodes.get('topup-units').textContent, '');
});

test('an amount past the wallet balance is called out, and is called back off', () => {
  freshDom();
  sandbox.S.topup = { amt: '' };
  onTopUpAmount('2', 18, 1, 'WEI');
  assert.equal(nodes.get('topup-warn').textContent, 'EXCEEDS WALLET BALANCE');
  onTopUpAmount('0.5', 18, 1, 'WEI');
  assert.equal(nodes.get('topup-warn').textContent, '');
});

test('a balance that has not been read yet does not accuse the amount of exceeding it', () => {
  // avail is 0 while the read is in flight, and 0 for a token the multicall
  // could not answer for. Neither is "you do not have that much".
  freshDom();
  sandbox.S.topup = { amt: '' };
  onTopUpAmount('2', 18, 0, 'WEI');
  assert.equal(nodes.get('topup-warn').textContent, '');
});

test('the send button stays dimmed until there is an amount it could actually send', () => {
  freshDom();
  sandbox.S.topup = { amt: '' };
  const btn = nodes.get('topup-send');
  onTopUpAmount('', 18, 1, 'WEI');
  assert.ok(btn.classList.contains('btn-pending'), 'an empty field left the button lit');
  onTopUpAmount('0', 18, 1, 'WEI');
  assert.ok(btn.classList.contains('btn-pending'), 'a zero amount left the button lit');
  onTopUpAmount('0.5', 18, 1, 'WEI');
  assert.ok(!btn.classList.contains('btn-pending'), 'a sendable amount left the button dimmed');
  onTopUpAmount('2', 18, 1, 'WEI');
  assert.ok(btn.classList.contains('btn-pending'), 'an amount past the balance left the button lit');
});

test('a comma-grouped amount is a number, not a zero', () => {
  // Pasted from a spreadsheet or a block explorer. parseFloat('1,000') is 1,
  // which would have dimmed the button against a balance of 500 and lit it
  // against a balance of 2.
  freshDom();
  sandbox.S.topup = { amt: '' };
  onTopUpAmount('1,000', 18, 500, 'WEI');
  assert.equal(nodes.get('topup-warn').textContent, 'EXCEEDS WALLET BALANCE');
});
