// Amounts, time, and the two escapers — the primitives everything else is built
// out of.
//
//   node --test              (from the repo root; discovers every suite)
//
// Same shape as the other suites, and lifted the same way: the dapp is one HTML
// file with its script inline, so this reads that file, pulls declarations out
// by name into a sandbox, and stubs only what each one will not run without. A
// missing name throws rather than returning nothing, so a rename fails the suite
// instead of quietly deleting its coverage.
//
// These functions are four lines each and have no branches worth arguing about,
// which is exactly why they had no tests and exactly why they are worth some.
// Every one of them sits between a string somebody else wrote and a number this
// app acts on:
//
//   weiStr / bigOr0   a `numeric` column on an anon-writable table, handed to
//                     BigInt() by every render path. BigInt('1.5') throws, and
//                     one such row emptied the whole queue on load.
//   toUnits           what the operator typed, scaled to base units. Get the
//                     scaling wrong and the proposal moves the wrong amount,
//                     correctly signed by everybody.
//   esc / jstr        an ERC-20 `symbol()` is whatever an arbitrary contract
//                     chose to return, and it reaches both an HTML sink and a
//                     JS string literal inside an inline handler. They are not
//                     the same escape and using one for the other is an XSS.
//   fmtBal            a balance that is not zero must never print as zero, on a
//                     screen whose whole subject is what a vault is holding.
//
// Real ethers, because formatUnits and parseEther are where the scaling actually
// happens and a stand-in for them would be this suite testing its own opinion of
// what a wei is.

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
    if (end >= LINES.length) throw new Error(`values.test.js: no closing line found for 'const ${name}'.`);
    return LINES.slice(asConst, end + 1).join('\n');
  }
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`values.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`values.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const NEEDED = [
  '_ESC', '_escOne', 'esc', 'jstr',
  'DECIMALS', 'stripCommas', 'weiStr', 'bigOr0', 'toUnits',
  '_amtTrim', '_amtDisp', 'groupInt', 'fmtBal', 'fmtAmount', 'fmtUsd', 'tokRate',
  'NOW', 'fmtEta', 'fmtD', 'fmtDelay', 'fmtRemaining',
  'UNIT_SEC', 'UNIT_LABEL', 'SHORT_DELAY_SEC', 'toSec', 'fromSec', 'setNd',
  'shortAddr',
];

const sandbox = {
  console: { ...console, warn() {}, error() {} },
  S: {},
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
  if (sandbox[n] === undefined) throw new Error(`values.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}

const {
  esc, jstr, DECIMALS, stripCommas, weiStr, bigOr0, toUnits,
  _amtTrim, _amtDisp, groupInt, fmtBal, fmtAmount, tokRate,
  NOW, fmtEta, fmtD, fmtDelay, fmtRemaining, toSec, fromSec, setNd,
  UNIT_SEC, SHORT_DELAY_SEC, shortAddr,
} = sandbox;

// ── escaping ──────────────────────────────────────────────────────

test('every character that can end an HTML text node or an attribute is escaped', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  // Ampersand first, or the entities the others produce get double-escaped —
  // the classic ordering bug in a chain of replaces. One pass cannot have it,
  // which is part of why this is one pass.
  assert.equal(esc('&lt;'), '&amp;lt;');
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)');
});

test('esc takes anything, because what it is handed is not always a string', () => {
  assert.equal(esc(null), 'null');
  assert.equal(esc(undefined), 'undefined');
  assert.equal(esc(0), '0');
  assert.equal(esc(123n), '123');
  assert.equal(esc(['<a>']), '&lt;a&gt;');
});

test('a token symbol reaching an inline handler is escaped for JS first and HTML second', () => {
  // The browser HTML-decodes an attribute before the JS parser sees it, so
  // esc()'s &#39; arrives back as a bare quote and closes the literal early.
  // An ERC-20 symbol() returns whatever an arbitrary contract chose to return.
  const evil = `x'); alert(1); //`;
  const out = jstr(evil);
  assert.ok(!out.includes(`'`), 'a bare quote survived jstr and would close the literal');
  assert.ok(out.includes('\\&#39;'), 'the quote was not backslash-escaped before being entity-escaped');
  // Round-tripping the way the browser does: HTML-decode, then read as JS.
  const htmlDecoded = out.replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(eval(`'${htmlDecoded}'`), evil, 'the value did not survive the round trip intact');
});

test('a backslash cannot escape its way out of a jstr literal', () => {
  // `\'` un-escaped by a naive quote-only escaper leaves the literal open. The
  // backslash has to be doubled first, and before the quote is touched.
  const evil = `x\\'); alert(1); //`;
  const out = jstr(evil);
  const htmlDecoded = out.replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(eval(`'${htmlDecoded}'`), evil);
});

test('jstr still escapes for HTML, so it is safe in the attribute it lands in', () => {
  assert.ok(!jstr('<img src=x>').includes('<'));
  assert.ok(!jstr('" onload="x').includes('"'));
});

// ── an untrusted value ────────────────────────────────────────────

test('a value is a wei string only when it is a non-negative whole number', () => {
  assert.equal(weiStr('0'), '0');
  assert.equal(weiStr('1000000000000000000'), '1000000000000000000');
  assert.equal(weiStr(42), '42');
  // Leading zeros are a different spelling of the same number, not a different
  // number — canonicalised rather than rejected.
  assert.equal(weiStr('007'), '7');
  assert.equal(weiStr('  5  '), '5');
  assert.equal(weiStr(null), '0');
  assert.equal(weiStr(undefined), '0');
});

test('every value the vault could never execute is refused, not coerced', () => {
  // `value` is `numeric`, which happily accepts all of these, and every one of
  // them throws in BigInt().
  for (const bad of ['1.5', '-1', '1e40', '0x10', 'abc', '', '  ', '+1', '1 000', Infinity, NaN, {}]) {
    assert.equal(weiStr(bad), null, `weiStr accepted ${JSON.stringify(String(bad))}`);
  }
});

test('the render path reads an unusable value as zero, because it must not throw', () => {
  // There is no row to skip inside a render — a throw there is a blank page for
  // everyone looking at that vault.
  assert.equal(bigOr0('1.5'), 0n);
  assert.equal(bigOr0('-1'), 0n);
  assert.equal(bigOr0(null), 0n);
  assert.equal(bigOr0('12'), 12n);
  assert.equal(bigOr0('1000000000000000000'), 10n ** 18n);
});

test('a value larger than any supply still reads exactly, with no float in the middle', () => {
  const huge = (2n ** 255n).toString();
  assert.equal(weiStr(huge), huge);
  assert.equal(bigOr0(huge), 2n ** 255n);
});

// ── scaling what was typed ────────────────────────────────────────

test('an amount is scaled by the token\'s own decimals', () => {
  assert.equal(toUnits('1', 18), '1000000000000000000');
  assert.equal(toUnits('1', 6), '1000000');
  assert.equal(toUnits('1', 8), '100000000');
  assert.equal(toUnits('0.5', 18), '500000000000000000');
  assert.equal(toUnits('1.000001', 6), '1000001');
});

test('a fraction longer than the token can hold is truncated, never rounded up', () => {
  // Rounding up would move more than the operator typed, out of a vault, with
  // everybody's signature on it.
  assert.equal(toUnits('1.9999999', 6), '1999999');
  assert.equal(toUnits('0.0000009', 6), '0');
});

test('commas are for reading and are stripped before anything is scaled', () => {
  assert.equal(stripCommas('1,234,567.89'), '1234567.89');
  assert.equal(toUnits('1,000', 18), '1000000000000000000000');
});

test('an amount that is not a number is refused by name, not silently zeroed', () => {
  // "INVALID" is a value every caller checks for. A silent 0 would build a
  // proposal that moves nothing and looks like it was meant to.
  for (const bad of ['1.2.3', '-1', 'abc', '1e5', '0x10', '.']) {
    assert.equal(toUnits(bad, 18), 'INVALID', `toUnits accepted ${JSON.stringify(bad)}`);
  }
  // Zero and empty are the resting state of an untouched field, not an error.
  assert.equal(toUnits('', 18), '0');
  assert.equal(toUnits('0', 18), '0');
});

test('the decimals table states the two that a reflex would get wrong', () => {
  // MEGA and USDm are both 18. USDm is a stablecoin and the reflex for those
  // is 6, which would scale a transfer by a factor of a trillion.
  assert.equal(DECIMALS.USDm, 18);
  assert.equal(DECIMALS.MEGA, 18);
  assert.equal(DECIMALS.USDC, 6);
  assert.equal(DECIMALS.USDT, 6);
  assert.equal(DECIMALS.WBTC, 8);
  assert.equal(DECIMALS.cbBTC, 8);
  assert.equal(DECIMALS.ETH, 18);
});

// ── displaying a balance ──────────────────────────────────────────

test('a balance that is not zero never prints as zero', () => {
  // One wei of an 18-decimal token does not reach the sixth decimal place.
  assert.equal(fmtBal(1n, 18), '<0.000001');
  assert.equal(fmtBal(999999999999n, 18), '<0.000001');
  assert.equal(fmtBal(0n, 18), '0');
});

test('a balance is grouped for reading and truncated to six places, exactly', () => {
  assert.equal(fmtBal(10n ** 18n, 18), '1');
  assert.equal(fmtBal(1234567n * 10n ** 18n, 18), '1,234,567');
  assert.equal(fmtBal(1500000n, 6), '1.5');
  assert.equal(fmtBal(10n ** 18n + 123456789012345n, 18), '1.000123');
});

test('grouping touches the integer part and leaves the fraction digit-for-digit', () => {
  assert.equal(groupInt('1234567.891234'), '1,234,567.891234');
  assert.equal(groupInt('999'), '999');
  assert.equal(groupInt('1000'), '1,000');
  assert.equal(groupInt('0.000001'), '0.000001');
});

test('trailing zeros are dropped without dropping the number', () => {
  assert.equal(_amtTrim('1.500000'), '1.5');
  assert.equal(_amtTrim('1.000000'), '1');
  assert.equal(_amtTrim('100'), '100');
  assert.equal(_amtTrim('0.000000'), '0');
  assert.equal(_amtTrim(''), '0');
  assert.equal(_amtDisp('1.1234567890'), '1.123456');
});

test('a raw amount formats back to what it was, and an unformattable one is shown as itself', () => {
  assert.equal(fmtAmount(1500000n, 6), '1.5');
  assert.equal(fmtAmount(10n ** 18n, 18), '1');
  assert.equal(fmtAmount('not a number', 18), 'not a number');
});

test('a USD rate needs both sides to be real numbers before it is a rate', () => {
  assert.equal(tokRate({ usd: '$1,000.00', balance: '2' }), 500);
  assert.equal(tokRate({ usd: '$0.00', balance: '2' }), 0);
  assert.equal(tokRate({ usd: '$100', balance: '0' }), 0);
  assert.equal(tokRate(null), 0);
  assert.equal(tokRate({}), 0);
});

// ── time ──────────────────────────────────────────────────────────

test('a matured timelock reads READY and nothing else', () => {
  assert.equal(fmtEta(NOW() - 1), 'READY');
  assert.equal(fmtEta(NOW()), 'READY');
  // No eta is not a matured eta — it is a proposal that was never queued.
  assert.equal(fmtEta(0), null);
  assert.equal(fmtEta(null), null);
  assert.equal(fmtEta(undefined), null);
});

test('a live timelock counts down in the largest unit that still says something', () => {
  const now = NOW();
  assert.match(fmtEta(now + 7200), /^2H \d+M$/);
  assert.match(fmtEta(now + 300), /^[45]M \d+S$/);
  assert.match(fmtEta(now + 5), /^[3-5]S$/);
});

test('a delay is spelled one way in the timelock column and another in a sentence', () => {
  // fmtD is the compact column form; fmtDelay is the one that goes in a note a
  // co-signer reads. They are allowed to differ, but neither may lie.
  assert.equal(fmtD(86400), '1D');
  assert.equal(fmtD(3600), '1H');
  assert.equal(fmtD(1800), '30M');
  assert.equal(fmtD(5400), '1.5H');
  assert.equal(fmtD(0), '0');
  assert.equal(fmtDelay(86400), '1 DAY');
  assert.equal(fmtDelay(172800), '2 DAYS');
  assert.equal(fmtDelay(3600), '1 HOUR');
  assert.equal(fmtDelay(7200), '2 HOURS');
  assert.equal(fmtDelay(60), '1 MIN');
  assert.equal(fmtDelay(600), '10 MINS');
  // A delay under a minute still has to say something, and rounds up to one
  // rather than down to none.
  assert.equal(fmtDelay(1), '1 MIN');
});

test('a delay entered in one unit and read back in another is the same delay', () => {
  for (const [unit, secs] of Object.entries(UNIT_SEC)) {
    for (const n of [1, 2, 7, 30]) {
      const sec = toSec(String(n), unit);
      assert.equal(sec, n * secs);
      const back = fromSec(sec);
      assert.equal(back.val * UNIT_SEC[back.unit], sec, `${n}${unit} did not round-trip`);
    }
  }
});

test('seconds come back in the tidiest unit that represents them exactly', () => {
  assert.deepEqual(fromSec(86400), { val: 1, unit: 'd' });
  assert.deepEqual(fromSec(172800), { val: 2, unit: 'd' });
  assert.deepEqual(fromSec(3600), { val: 1, unit: 'h' });
  assert.deepEqual(fromSec(5400), { val: 90, unit: 'm' });
  assert.deepEqual(fromSec(0), { val: 0, unit: 'h' });
  assert.deepEqual(fromSec(-5), { val: 0, unit: 'h' });
});

test('a delay is whole seconds, because the chain stores a uint32 of them', () => {
  assert.equal(toSec('1.5', 'h'), 5400);
  assert.equal(toSec('0.0001', 'm'), 0);
  assert.equal(toSec('abc', 'h'), 0);
  assert.equal(toSec('', 'h'), 0);
  // An unknown unit falls back to hours rather than to zero, which would
  // silently turn a typed delay into none at all.
  assert.equal(toSec('2', 'z'), 7200);
});

test('the admin form takes its unit from the delay, not the other way round', () => {
  setNd(86400);
  assert.equal(sandbox.S.nd, 1);
  assert.equal(sandbox.S.ndUnit, 'd');
  setNd(5400);
  assert.equal(sandbox.S.nd, 90);
  assert.equal(sandbox.S.ndUnit, 'm');
});

test('the short-delay warning sits where a timelock stops being a review window', () => {
  assert.equal(SHORT_DELAY_SEC, 600);
});

test('a remaining time reads down to seconds and says EXPIRED at the end', () => {
  assert.equal(fmtRemaining(0), 'EXPIRED');
  assert.equal(fmtRemaining(-100), 'EXPIRED');
  assert.equal(fmtRemaining(90061), '1D 1H');
  assert.equal(fmtRemaining(3660), '1H 1M');
  assert.equal(fmtRemaining(120), '2M');
  assert.equal(fmtRemaining(45), '45S');
});

// ── addresses ─────────────────────────────────────────────────────

test('an address is shortened only when it really is one, and passes through when it is not', () => {
  const a = '0x1234567890123456789012345678901234567890';
  assert.equal(shortAddr(a), '0x1234…7890');
  // A name, a hash, or a truncated address is not an address — shortening one
  // would produce something that reads like an address and is not.
  assert.equal(shortAddr('alice.eth'), 'alice.eth');
  assert.equal(shortAddr('0x1234'), '0x1234');
  assert.equal(shortAddr('0x' + 'ab'.repeat(32)), '0x' + 'ab'.repeat(32));
  assert.equal(shortAddr(null), '');
  assert.equal(shortAddr(undefined), '');
});
