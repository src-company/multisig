// The custom-call builder's argument parser — the step between what is typed in
// a parameter field and the bytes a co-signer signs.
//
//   node --test              (from the repo root; discovers every suite)
//
// Why this one has a suite of its own. Everywhere else in this app a value the
// operator types is echoed back in the same units it was typed in, so a
// misreading shows up on the screen that produced it. Here it does not: the
// CALLDATA preview and the DECODE panel are both rendered FROM this parse, so a
// value read wrongly is displayed wrongly in exactly the same way, and there is
// nothing on screen to disagree with it. The proposal then goes to co-signers
// carrying bytes nobody has seen contradicted.
//
// So the assertions below do not check what parseCxArg returns. They encode its
// output with the real ethers bundle this page ships and decode it back, which
// is the only question that matters: is what lands in the calldata what was
// asked for. Two of the three defects this suite covers were invisible to a
// return-value check — `['true','false']` looks plausible until BooleanCoder
// applies a truthiness test to it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dapp', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

// Same reader as the suites beside it, kept as a copy for the reason they give:
// in a repo with no build step, copies of a short reader are cheaper than a
// shared module, and the day they diverge they diverge loudly.
function grab(name) {
  const asConst = LINES.findIndex(l =>
    ['const', 'let'].some(kw => l.startsWith(`${kw} ${name} `) || l.startsWith(`${kw} ${name}=`)));
  if (asConst !== -1) {
    const line = LINES[asConst];
    if (/;\s*(\/\/.*)?$/.test(line)) return line;
    let end = asConst + 1;
    while (end < LINES.length && !/^[}\])]/.test(LINES[end])) end++;
    if (end >= LINES.length) throw new Error(`cxargs.test.js: no closing line found for 'const ${name}'.`);
    return LINES.slice(asConst, end + 1).join('\n');
  }
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`cxargs.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`cxargs.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const NEEDED = ['parseCxBool', 'parseCxArg'];

const sandbox = {
  console: { ...console, warn() {}, error() {} },
  TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
  crypto: globalThis.crypto,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
// The bundle the browser loads, so the coders under test are the shipped ones.
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dapp', 'ethers.slim.min.js'), 'utf8'), sandbox);

const handOut = NEEDED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n');
vm.runInContext(NEEDED.map(grab).join('\n') + '\n' + handOut, sandbox);
for (const n of NEEDED) {
  if (sandbox[n] === undefined) throw new Error(`cxargs.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}
const { ethers, parseCxArg } = sandbox;

// Encode through the real coders and read it straight back. `roundTrip` is what
// the vault would actually see.
const IFACE = new ethers.Interface([
  'function one(bool a)',
  'function many(bool[] a)',
  'function words(string[] a)',
  'function nums(uint256[] a)',
]);
const roundTrip = (fn, type, raw) =>
  IFACE.decodeFunctionData(fn, IFACE.encodeFunctionData(fn, [parseCxArg(raw, type)]))[0];

// ── bool ──────────────────────────────────────────────────────────

test('a bool encodes what was typed, in either spelling and either case', () => {
  for (const yes of ['true', 'TRUE', 'True', ' true ', '1']) {
    assert.equal(roundTrip('one', 'bool', yes), true, `"${yes}" did not encode as true`);
  }
  for (const no of ['false', 'FALSE', 'False', ' false ', '0']) {
    assert.equal(roundTrip('one', 'bool', no), false, `"${no}" did not encode as false`);
  }
});

test('a bool that is neither is refused rather than read as false', () => {
  // `raw === 'true' || raw === '1'` made every other spelling false, silently.
  // Typing `True` encoded the OPPOSITE of what was meant, and the preview and
  // the DECODE panel agreed with the wrong answer because both render from this
  // same parse. A field that will not encode is visible; one that encodes the
  // wrong value is not.
  for (const bad of ['yes', 'no', 'y', '', 'maybe', '2', 'null']) {
    assert.throws(() => parseCxArg(bad, 'bool'), /Expected true or false/,
      `"${bad}" was accepted as a bool`);
  }
});

// ── bool[] ────────────────────────────────────────────────────────

test('a bool[] written as a comma list encodes each element, not each element\'s truthiness', () => {
  // The comma fallback returned an array of STRINGS, and ethers' BooleanCoder
  // is `writer.writeValue(r ? 1 : 0)` — a plain truthiness test, under which
  // the non-empty string "false" is true. So `true,false` set BOTH flags.
  assert.deepEqual([...roundTrip('many', 'bool[]', 'true,false')], [true, false]);
  assert.deepEqual([...roundTrip('many', 'bool[]', 'false,false')], [false, false]);
  assert.deepEqual([...roundTrip('many', 'bool[]', '1,0,true')], [true, false, true]);
});

test('a bool[] written as JSON encodes the same way', () => {
  assert.deepEqual([...roundTrip('many', 'bool[]', '[true,false]')], [true, false]);
});

test('one unreadable element costs the whole bool[], rather than becoming true', () => {
  assert.throws(() => parseCxArg('true,yes', 'bool[]'), /Expected true or false/);
});

// ── string[] ──────────────────────────────────────────────────────

test('a string[] must be JSON, because a comma cannot be both separator and content', () => {
  // `hello, world` silently became two arguments instead of one — a change to
  // the call's arity as well as its content. There is no split that is right
  // here, so the notation that says which is required.
  assert.throws(() => parseCxArg('hello, world', 'string[]'), /must be written as JSON/);
  assert.deepEqual([...roundTrip('words', 'string[]', '["hello, world"]')], ['hello, world']);
  assert.deepEqual([...roundTrip('words', 'string[]', '["a","b"]')], ['a', 'b']);
  assert.deepEqual([...parseCxArg('', 'string[]')], []);
});

// ── the comma fallback that was always right ──────────────────────

test('a numeric array still takes a bare comma list, which is what it is for', () => {
  assert.deepEqual([...roundTrip('nums', 'uint256[]', '1,2,3')], [1n, 2n, 3n]);
  assert.deepEqual([...roundTrip('nums', 'uint256[]', '[4,5]')], [4n, 5n]);
  assert.deepEqual([...parseCxArg('', 'uint256[]')], []);
});

test('an array written as something that is not an array is refused', () => {
  assert.throws(() => parseCxArg('{"a":1}', 'uint256[]'), /Expected an array/);
});
