// validateCreate() — the last gate before a vault that cannot be edited.
//
//   node --test              (from the repo root; discovers every suite)
//
// Same shape as the other suites, and lifted the same way: the dapp is one HTML
// file with its script inline, so this reads that file, pulls declarations out
// by name into a sandbox, and stubs only what each one will not run without. A
// missing name throws rather than returning nothing, so a rename fails the suite
// instead of quietly deleting its coverage.
//
// Why this one function gets a suite. Everything a vault is — its owner set, its
// threshold, its timelock — is fixed by init() at deploy time and can afterwards
// only be changed by a full multisig round through the vault itself. There is no
// undo, the address is mined before the transaction is sent, and on a multi-chain
// deploy the same mistake is committed once per chain. So the value of catching a
// bad owner set here rather than in a revert is not "a better error message" — it
// is the difference between a form that stays open and gas spent on a vault
// nobody can use.
//
// Three of the checks below exist because the contract's own rules are not
// guessable from the outside:
//
//   0x0 and 0x1     init() walks a linked list headed by address(1) and requires
//                   each owner to be strictly greater than the last, so neither
//                   sentinel can ever be an owner. A name that RESOLVES to one is
//                   the same rejection, applied to a value the operator never
//                   typed and cannot see.
//   duplicates      init() reverts on a repeat — after the salt has been mined
//                   and the gas paid. Two names, or a name and the address it
//                   points at, are one owner.
//   1008 owners     Audit H-2: execute() computes `threshold * 65` in uint16
//                   inside an unchecked block, so past 1008 the length check and
//                   the verification loop cannot both be satisfied and the
//                   owners' signature path is dead permanently.
//
// Name resolution is stood in for. previewName reaches mainnet and its own
// caches, and what is being asserted here is what validateCreate does with an
// answer — including the answer "still resolving", which must hold the button.

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
    if (end >= LINES.length) throw new Error(`create.test.js: no closing line found for 'const ${name}'.`);
    return LINES.slice(asConst, end + 1).join('\n');
  }
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`create.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`create.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const NEEDED = [
  'NAME_RE', 'OWNER_NS_CHAIN', 'MAX_SAFE_THRESHOLD', 'validateCreate',
  'parseOwnerPaste', 'pasteOwners',
  'THRESH_BTNS_MAX', 'thresholdPicker', 'setCreateThreshold',
  // ADMIN's setter, lifted here rather than left to a suite of its own. It is
  // named only inside an onclick string, which nothing parses: renaming it would
  // leave a picker whose every button throws ReferenceError, on a page that goes
  // blank rather than saying so. Lifting it means a rename fails this suite.
  'setAdminThreshold',
  // The note under an owner row. Only its invalid branch is exercised below —
  // the rest reaches the chain for an owner's code — but the whole function is
  // lifted, so a rename or a reshuffle of the branches fails here.
  'NAME_KINDS', 'nameNearMiss', '_OWNER_STATE_COLOR', 'ownerRowNote',
];

// What previewName is told to answer, keyed by the raw text of the name. A name
// with no entry has not been asked about yet, which is 'resolving' — the state
// that holds the DEPLOY button.
const previews = new Map();

const sandbox = {
  console: { ...console, warn() {}, error() {} },
  S: {},
  render: () => {},
  // Every message this file asserts about is read off the returned state, not
  // off the toast — but pasteOwners raises one, and a paste that throws on the
  // way to reporting itself has not pasted anything.
  flash: (m) => { sandbox._flashed = m; },
  // Reaches the chain for an owner's code and answers null until it replies.
  // What is asserted here is the note a rejected row carries, which is decided
  // before this is consulted; a valid row only has to reach it without throwing.
  cannotSign: () => false,
  esc: (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  shortAddr: (a) => (/^0x[0-9a-fA-F]{40}$/.test(a || '') ? a.slice(0, 6) + '\u2026' + a.slice(-4) : (a || '')),
  previewName: (raw) => previews.get(raw) || { state: 'resolving' },
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
  if (sandbox[n] === undefined) throw new Error(`create.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}

const { validateCreate, MAX_SAFE_THRESHOLD } = sandbox;

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';

// The create form as validateCreate reads one.
const form = (addrs, o) => Object.assign({
  owners: addrs.map(a => ({ addr: a })), threshold: '1', delayVal: '24',
}, o);

// ── the shape of a usable form ────────────────────────────────────

test('a single owner at threshold one is a vault, and is allowed to be', () => {
  const r = validateCreate(form([A]), false);
  assert.equal(r.ready, true);
  assert.equal(r.filled, 1);
  assert.equal(r.reason, '');
});

test('an empty form asks for an owner rather than reporting a threshold problem', () => {
  const r = validateCreate(form([]), false);
  assert.equal(r.ready, false);
  assert.match(r.reason, /ADD AT LEAST ONE OWNER/);
  // Blank rows are the form's resting state, not errors — a fresh form has
  // three of them and must not be red.
  const blanks = validateCreate(form(['', '  ', '']), false);
  assert.equal(blanks.filled, 0);
  assert.match(blanks.reason, /ADD AT LEAST ONE OWNER/);
  assert.deepEqual(blanks.owners.map(o => o.state), ['empty', 'empty', 'empty']);
});

test('the threshold has to be reachable by the owners actually listed', () => {
  assert.equal(validateCreate(form([A, B], { threshold: '3' }), false).ready, false);
  assert.match(validateCreate(form([A, B], { threshold: '3' }), false).reason, /THRESHOLD MUST BE 1\.\.2/);
  assert.equal(validateCreate(form([A, B], { threshold: '0' }), false).ready, false);
  assert.equal(validateCreate(form([A, B], { threshold: '' }), false).ready, false);
  assert.equal(validateCreate(form([A, B], { threshold: '2' }), false).ready, true);
  // Blank rows between filled ones do not count towards the ceiling.
  assert.equal(validateCreate(form([A, '', B], { threshold: '2' }), false).ready, true);
  assert.equal(validateCreate(form([A, '', B], { threshold: '3' }), false).ready, false);
});

test('a delay must be a non-negative number, and no delay is a valid answer', () => {
  assert.equal(validateCreate(form([A], { delayVal: '' }), false).ready, true);
  assert.equal(validateCreate(form([A], { delayVal: '0' }), false).ready, true);
  assert.equal(validateCreate(form([A], { delayVal: '1.5' }), false).ready, true);
  const bad = validateCreate(form([A], { delayVal: '-1' }), false);
  assert.equal(bad.ready, false);
  assert.match(bad.reason, /DELAY MUST BE A POSITIVE NUMBER/);
  assert.equal(validateCreate(form([A], { delayVal: 'abc' }), false).ready, false);
});

// ── the two addresses the contract cannot hold ────────────────────

test('the owner-list sentinels are refused here, not by a reverted deploy', () => {
  // init() walks a linked list headed by address(1), each owner strictly greater
  // than the last. Neither 0x0 nor 0x1 can ever be in it.
  for (const sentinel of ['0x' + '0'.repeat(40), '0x' + '0'.repeat(39) + '1']) {
    const r = validateCreate(form([sentinel]), false);
    assert.equal(r.owners[0].state, 'invalid', `${sentinel} was accepted as an owner`);
    assert.equal(r.ready, false);
  }
  // One past the sentinel is an ordinary address and is allowed.
  const ok = validateCreate(form(['0x' + '0'.repeat(39) + '2']), false);
  assert.equal(ok.owners[0].state, 'address');
  assert.equal(ok.ready, true);
});

test('a name that resolves to a sentinel is refused too, and says which name did it', () => {
  // The 0x0/0x1 rejection has to be re-run on what a name resolved to, not only
  // on what was typed — a name can point anywhere, including at the sentinels
  // the owner list is built out of.
  previews.set('trap.eth', { state: 'ok', addr: '0x' + '0'.repeat(40) });
  const r = validateCreate(form(['trap.eth']), false);
  assert.equal(r.ready, false);
  assert.match(r.reason, /TRAP\.ETH RESOLVES TO 0x0/);
  previews.delete('trap.eth');
});

// ── one owner, however they were spelled ──────────────────────────

test('the same address listed twice is one owner, and the deploy is held', () => {
  const r = validateCreate(form([A, A]), false);
  assert.equal(r.owners[1].state, 'dup');
  assert.equal(r.ready, false);
  assert.match(r.reason, /DUPLICATE OWNER ADDRESSES/);
});

test('the same address in two casings is still the same address', () => {
  const r = validateCreate(form([A, A.toUpperCase().replace('0X', '0x')]), false);
  assert.equal(r.owners[1].state, 'dup');
  assert.equal(r.ready, false);
});

test('a name and the address it points at are one owner, once the name resolves', () => {
  // init() reverts on a repeat, after the salt has been mined and the gas paid.
  previews.set('alice.eth', { state: 'ok', addr: A });
  const r = validateCreate(form(['alice.eth', A]), false);
  assert.equal(r.owners[1].state, 'dup');
  assert.equal(r.ready, false);
  previews.delete('alice.eth');
});

test('two names pointing at one address are one owner', () => {
  previews.set('alice.eth', { state: 'ok', addr: A });
  previews.set('alice.wei', { state: 'ok', addr: A });
  const r = validateCreate(form(['alice.eth', 'alice.wei']), false);
  assert.equal(r.owners[1].state, 'dup');
  assert.equal(r.ready, false);
  previews.delete('alice.eth');
  previews.delete('alice.wei');
});

test('two unresolved names are not assumed to be the same owner, or to differ', () => {
  // Before an answer arrives there is nothing to dedup on but the text, so two
  // different names are two owners — and the form is held anyway until they
  // resolve, which is what stops the guess from mattering.
  const r = validateCreate(form(['alice.eth', 'bob.eth']), false);
  assert.equal(r.owners[0].state, 'name');
  assert.equal(r.owners[1].state, 'name');
  assert.equal(r.ready, false);
  assert.match(r.reason, /RESOLVING/);
  // The same name typed twice is a duplicate on its text alone.
  const same = validateCreate(form(['alice.eth', 'ALICE.ETH']), false);
  assert.equal(same.owners[1].state, 'dup');
});

// ── names in flight ───────────────────────────────────────────────

test('a name still resolving holds the deploy, because the owner set is not known yet', () => {
  // Deploying now would sign for an owner set the operator has not seen.
  const r = validateCreate(form([A, 'alice.eth'], { threshold: '2' }), false);
  assert.equal(r.ready, false);
  assert.match(r.reason, /RESOLVING OWNER NAMES/);
});

test('a name that resolved is an owner like any other', () => {
  previews.set('alice.eth', { state: 'ok', addr: B });
  const r = validateCreate(form([A, 'alice.eth'], { threshold: '2' }), false);
  assert.equal(r.ready, true);
  assert.equal(r.filled, 2);
  assert.equal(r.owners[1].pv.addr, B);
  previews.delete('alice.eth');
});

test('a name that failed reports its own error, not a generic one', () => {
  previews.set('gone.eth', { state: 'err', err: 'MAINNET DID NOT ANSWER' });
  const r = validateCreate(form(['gone.eth']), false);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'MAINNET DID NOT ANSWER');
  // And falls back to naming the name when the failure carried no message.
  previews.set('gone.eth', { state: 'err' });
  assert.match(validateCreate(form(['gone.eth']), false).reason, /GONE\.ETH DOES NOT RESOLVE/);
  previews.delete('gone.eth');
});

test('an invalid owner is reported before a name that has not answered yet', () => {
  // Both are reasons to hold the button. Only one of them is the operator's to
  // fix, and reporting "RESOLVING…" over a typo would leave them waiting for it.
  const r = validateCreate(form(['not-an-address', 'alice.eth']), false);
  assert.equal(r.ready, false);
  assert.match(r.reason, /INVALID/);
});

// ── things that are not addresses and not names ───────────────────

test('text that is neither an address nor a name is invalid, and named as such', () => {
  for (const junk of ['hello', '0x1234', '0xZZZZ', 'alice', 'alice.com', '0x' + '1'.repeat(41)]) {
    const r = validateCreate(form([junk]), false);
    assert.equal(r.owners[0].state, 'invalid', `${junk} was not rejected`);
    assert.equal(r.ready, false);
    assert.match(r.reason, /ONE OR MORE OWNER ADDRESSES ARE INVALID/);
  }
});

test('a mis-checksummed address is refused, because it is probably a typo', () => {
  // ethers.isAddress rejects a mixed-case address that fails EIP-55. That is
  // the checksum doing its job: one wrong character in an owner address is a
  // vault with an owner nobody controls.
  const mixed = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
  const flipped = mixed.slice(0, -1) + (mixed.slice(-1) === 'a' ? 'A' : 'a');
  assert.equal(validateCreate(form([flipped]), false).owners[0].state, 'invalid');
  // All-lowercase carries no checksum to fail, and is accepted.
  assert.equal(validateCreate(form([mixed.toLowerCase()]), false).owners[0].state, 'address');
});

// ── the ceiling the contract's arithmetic imposes ─────────────────

test('an owner set past the point where the signature-length check overflows is refused', () => {
  // Audit H-2. Raised here so it is a disabled button rather than a rejection
  // after the form is filled in — and it is filled in with 1009 addresses.
  const many = n => Array.from({ length: n }, (_, i) => '0x' + (i + 2).toString(16).padStart(40, '0'));
  const ok = validateCreate(form(many(MAX_SAFE_THRESHOLD), { threshold: '1' }), false);
  assert.equal(ok.ready, true);
  const over = validateCreate(form(many(MAX_SAFE_THRESHOLD + 1), { threshold: '1' }), false);
  assert.equal(over.ready, false);
  assert.match(over.reason, /OVERFLOW THE SIGNATURE-LENGTH CHECK/);
});

// ── the demo, which has no chain behind it ────────────────────────

test('the demo takes any text as an owner, and never asks a resolver about it', () => {
  // There is no resolver behind the demo, so a name cannot become an address.
  // Accepting the text is honest there; what it must not do is call previewName
  // and sit at RESOLVING forever.
  let asked = 0;
  const spy = sandbox.previewName;
  sandbox.previewName = (...a) => { asked++; return spy(...a); };
  const r = validateCreate(form(['alice', 'bob.eth'], { threshold: '2' }), true);
  sandbox.previewName = spy;
  assert.equal(asked, 0, 'the demo asked a resolver that is not there');
  assert.equal(r.ready, true);
  assert.equal(r.filled, 2);
});

test('the demo still refuses two of the same owner', () => {
  const r = validateCreate(form(['alice', 'alice']), true);
  assert.equal(r.owners[1].state, 'dup');
  assert.equal(r.ready, false);
});

test('the demo is not held by the owner ceiling, because nothing is deployed', () => {
  const many = n => Array.from({ length: n }, (_, i) => 'owner' + i);
  assert.equal(validateCreate(form(many(MAX_SAFE_THRESHOLD + 1), { threshold: '1' }), true).ready, true);
});

// ── pasting an owner list ─────────────────────────────────────────
//
// An owner set is almost never composed in this form. It exists first in a
// spreadsheet, a document or a chat message, and it gets into the form by being
// copied. Before this, copying it in put the whole list into one row and the row
// said NOT A VALID ADDRESS, so the only way in was retyping — which is where a
// transposed character in an immutable owner set comes from.
//
// What is asserted here is the parse and the row arithmetic. Nothing about what
// the addresses mean: parseOwnerPaste decides only what is an owner-shaped token
// and where it lands, and validateCreate above judges the result on exactly the
// same terms as a row somebody typed. That split is the point — a pasted list
// gets no shortcut through the checks.

const { parseOwnerPaste, pasteOwners, thresholdPicker, THRESH_BTNS_MAX, setCreateThreshold } = sandbox;

const D = '0x4444444444444444444444444444444444444444';

test('one address per line is one owner per line', () => {
  const r = parseOwnerPaste(`${A}\n${B}\n${C}`);
  assert.deepEqual(r.map(o => o.addr), [A, B, C]);
  assert.deepEqual(r.map(o => o.label), ['', '', '']);
});

test('several owners on one line are several owners, and none of them is a label', () => {
  // "0xA, 0xB" has no leftover text to be a label. Handing the second address to
  // the first as its name would file a signer under an address.
  const r = parseOwnerPaste(`${A}, ${B}; ${C}`);
  assert.deepEqual(r.map(o => o.addr), [A, B, C]);
  assert.deepEqual(r.map(o => o.label), ['', '', '']);
});

test('a line with one owner donates its leftover text as the label', () => {
  // The second column of a spreadsheet, which is where owner lists are kept.
  const r = parseOwnerPaste(`${A}, Alice\n${B}\tBob Treasury`);
  assert.deepEqual(r, [{ addr: A, label: 'Alice' }, { addr: B, label: 'Bob Treasury' }]);
});

test('document decoration is not part of an address', () => {
  const r = parseOwnerPaste(`- ${A}\n* ${B}\n1. ${C}\n> "${D}"`);
  assert.deepEqual(r.map(o => o.addr), [A, B, C, D]);
});

test('an owner list copied out of a script is still a list', () => {
  // The shape a Safe export, a deploy script or a JSON blob hands over. Quotes
  // and brackets separate; they do not become part of an address.
  assert.deepEqual(parseOwnerPaste(`["${A}", "${B}"]`).map(o => o.addr), [A, B]);
  assert.deepEqual(parseOwnerPaste(`owners: ['${A}']`).map(o => o.addr), [A]);
});

test('a separator between a name and its address is not part of either', () => {
  assert.deepEqual(parseOwnerPaste(`Alice: ${A}\nBob - ${B}`),
    [{ addr: A, label: 'Alice' }, { addr: B, label: 'Bob' }]);
});

test('a name is an owner, and a word is not', () => {
  // The same NAME_RE the form's own validation uses, so the paste cannot admit
  // a namespace the deploy would then fail to resolve.
  const r = parseOwnerPaste(`alice.eth\nnotes: this list is from the old safe\nbob.wei\ncarol.mega`);
  assert.deepEqual(r.map(o => o.addr), ['alice.eth', 'bob.wei', 'carol.mega']);
});

test('a line with nothing owner-shaped on it is skipped, not turned into a bad row', () => {
  assert.deepEqual(parseOwnerPaste('OWNERS\n\n  \nsigners:'), []);
});

test('a pasted label is held to the same 64 characters the label input is', () => {
  const long = 'L'.repeat(200);
  assert.equal(parseOwnerPaste(`${A}, ${long}`)[0].label.length, 64);
});

// ── where a pasted list lands ─────────────────────────────────────

const cf = (owners, o) => (sandbox.S.cf = Object.assign({
  owners: owners.map(a => (typeof a === 'string' ? { addr: a, label: '' } : a)),
  threshold: '1',
}, o));

// A paste event, as much of one as pasteOwners reads.
function paste(text) {
  let prevented = false;
  pasteOwners({ clipboardData: { getData: () => text }, preventDefault() { prevented = true; } }, arguments[1] || 0);
  return prevented;
}

test('a list pasted into the first row fills the form from that row down', () => {
  cf(['', '', '']);                          // the three blank rows a form opens with
  assert.equal(paste(`${A}\n${B}\n${C}`), true, 'the browser was left to paste the blob into one field');
  assert.deepEqual(sandbox.S.cf.owners.map(o => o.addr), [A, B, C]);
});

test('blank rows below the paste are placeholders and get consumed', () => {
  cf(['', '', '', '', '']);
  paste(`${A}\n${B}`);
  assert.deepEqual(sandbox.S.cf.owners.map(o => o.addr), [A, B],
    'the list landed with the form\'s own empty rows left sitting under it');
});

test('rows below the paste that somebody filled in are owners, and are kept', () => {
  cf([D, '', C]);
  paste(`${A}\n${B}`, 1);
  assert.deepEqual(sandbox.S.cf.owners.map(o => o.addr), [D, A, B, C]);
});

test('a single address is left to the browser', () => {
  // Selection replacement, undo and a paste into the middle of a field are all
  // things the browser already does correctly, and taking one address over would
  // mean reimplementing them for no gain.
  cf(['', '', '']);
  assert.equal(paste(A), false);
  assert.equal(paste('not an address at all'), false);
  assert.deepEqual(sandbox.S.cf.owners.map(o => o.addr), ['', '', ''], 'the form was rewritten anyway');
});

test('a pasted list cannot carry the owner count past the ceiling', () => {
  // Audit H-2 again, at the one input that can now add a thousand owners in a
  // keystroke: past MAX_SAFE_THRESHOLD the owners\' signature path is dead
  // permanently, so the surplus is dropped here and said out loud.
  cf(['']);
  const many = Array.from({ length: MAX_SAFE_THRESHOLD + 20 }, (_, i) =>
    '0x' + String(i + 1).padStart(40, '0')).join('\n');
  paste(many);
  assert.equal(sandbox.S.cf.owners.length, MAX_SAFE_THRESHOLD);
  assert.match(sandbox._flashed, /20 DROPPED/);
});

test('a paste that shortens the owner list brings the threshold down with it', () => {
  cf(['', '', ''], { threshold: '3' });
  paste(`${A}\n${B}`);
  assert.equal(sandbox.S.cf.threshold, '2', 'the form kept a threshold no owner set can satisfy');
});

// ── choosing a threshold at either size ───────────────────────────

test('a vault of a handful of owners still gets one button each', () => {
  const html = thresholdPicker(2, 5, 'setCreateThreshold', 'x');
  assert.equal((html.match(/<button/g) || []).length, 5);
  assert.equal(html.includes('<input'), false);
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);
  assert.match(html, /aria-current="true"[^>]*onclick="setCreateThreshold\(2\)"/,
    'the current threshold is not the one marked');
});

test('past the ceiling the wall of buttons becomes a number', () => {
  // A cloned Safe may bring a hundred signers and a pasted list a thousand. One
  // button per owner is a picker at 5 and eight wrapped lines of identical
  // numbers at 100, repainted in full on every keystroke elsewhere in the form.
  const html = thresholdPicker(7, 40, 'setCreateThreshold', 'cf-thresh-n');
  assert.match(html, /<input[^>]*id="cf-thresh-n"/);
  assert.match(html, /max="40"/);
  assert.match(html, /value="7"/);
  assert.equal((html.match(/<button/g) || []).length, 3, 'only ANY ONE / MAJORITY / ALL stay as buttons');
});

test('the majority preset is a majority, not half', () => {
  // Half of an even owner set is a tie, and a tie is not a quorum. This is the
  // arithmetic that is tedious to do by hand and easy to get wrong by one, which
  // is the whole reason the preset exists.
  assert.match(thresholdPicker(1, 40, 'f', 'x'), /MAJORITY &middot; 21/);
  assert.match(thresholdPicker(1, 41, 'f', 'x'), /MAJORITY &middot; 21/);
});

test('the picker switches over at the stated size and not one owner early', () => {
  assert.equal(thresholdPicker(1, THRESH_BTNS_MAX, 'f', 'x').includes('<input'), false);
  assert.equal(thresholdPicker(1, THRESH_BTNS_MAX + 1, 'f', 'x').includes('<input'), true);
});

test('a threshold typed into the number is clamped to an owner set that can meet it', () => {
  // The buttons cannot offer an impossible threshold; a free-text number can, and
  // this is the same 1..filled the DEPLOY button is gated on.
  cf([A, B, C]);
  setCreateThreshold('99');
  assert.equal(sandbox.S.cf.threshold, '3');
  setCreateThreshold('0');
  assert.equal(sandbox.S.cf.threshold, '1');
  setCreateThreshold('');
  assert.equal(sandbox.S.cf.threshold, '1', 'an emptied field is not a threshold of zero');
  setCreateThreshold('2');
  assert.equal(sandbox.S.cf.threshold, '2');
});

test('the clamp counts owners, not rows', () => {
  cf([A, '', B, '']);
  setCreateThreshold('4');
  assert.equal(sandbox.S.cf.threshold, '2', 'two blank rows were counted as owners that could sign');
});

test('the admin picker clamps to the owner set the vault actually has', () => {
  // Same control, different state: ADMIN revises a threshold against a vault
  // whose owner count is a fact on chain rather than a count of filled rows.
  sandbox.S.vaults = [{ ownerCount: 4 }];
  sandbox.S.sel = 0;
  sandbox.setAdminThreshold('9');
  assert.equal(sandbox.S.nt, 4);
  sandbox.setAdminThreshold('3');
  assert.equal(sandbox.S.nt, 3);
  assert.equal(typeof sandbox.S.nt, 'number', 'ADMIN holds a number, not the form\'s string');
  // Between vaults, S.sel can point at nothing for a paint. A picker that throws
  // there takes the whole page with it.
  sandbox.S.sel = 7;
  sandbox.setAdminThreshold('3');
  assert.equal(sandbox.S.nt, 1);
});

// ── the four a mutation run found nothing standing in front of ────
//
// Everything above was written against the feature. These were written against
// deliberate breakages of it that the suite let through: give every owner on a
// multi-owner line the leftover label, silently dedup the list, hand the picker
// an owner count it cannot use, clamp the admin threshold at only one end. Each
// one is a plausible edit, each one passed, and each one now does not.

test('nobody on a multi-owner line gets the leftover text as their label', () => {
  // The existing case had no leftover to give away, so a version that handed one
  // out went unnoticed. "0xA, 0xB" has nothing to be a label; "team: 0xA, 0xB"
  // has something, and it still belongs to neither of them — filing two signers
  // under one word is worse than filing them under none.
  const r = parseOwnerPaste(`team ${A}, ${B}`);
  assert.deepEqual(r.map(o => o.addr), [A, B]);
  assert.deepEqual(r.map(o => o.label), ['', ''],
    'the leftover text on a multi-owner line was handed out as a label');
});

test('a repeat in the pasted list survives the paste, so the form can show it', () => {
  // Deduping here would be the quietest possible way to tell somebody their
  // source list was wrong. validateCreate marks the second row DUPLICATE and
  // holds the deploy; that is where a repeat gets dealt with, in front of the
  // operator, on the row it arrived on.
  const r = parseOwnerPaste(`${A}\n${B}\n${A}`);
  assert.deepEqual(r.map(o => o.addr), [A, B, A]);
  // And end to end: pasted, then judged.
  const v = validateCreate({ owners: r, threshold: '1', delayVal: '24' }, false);
  assert.equal(v.owners[2].state, 'dup');
  assert.equal(v.ready, false);
});

test('the picker floors at one button, whatever it is told the owner count is', () => {
  // renderAdmin passes v.ownerCount straight in. Every path that builds a vault
  // today produces a number, so none of these is reachable now — which is the
  // reason to pin them: the guard is a `Math.max(max, 1)` whose whole job is to
  // be there when a caller stops being careful, and a guard nothing tests is a
  // guard that quietly stops working. What must never appear is a picker with no
  // way to choose, or a button offering to set the threshold to nothing.
  for (const max of [0, -3, null, undefined, NaN, '4']) {
    const html = thresholdPicker(1, max, 'setAdminThreshold', 'x');
    assert.ok(/<button|<input/.test(html), `an owner count of ${String(max)} drew no control at all`);
    assert.ok(!/NaN/.test(html), `an owner count of ${String(max)} put NaN in the markup`);
    assert.ok(!/onclick="setAdminThreshold\((?:0|-\d+)\)"/.test(html),
      `an owner count of ${String(max)} offered a threshold below one`);
  }
});

test('the admin threshold is clamped at both ends, not just the top', () => {
  // Math.min alone lets a negative through: the number input is typed into, and
  // a pasted or spinner-driven -5 reaches this. A threshold below one is a vault
  // whose setThreshold call reverts.
  sandbox.S.vaults = [{ ownerCount: 4 }];
  sandbox.S.sel = 0;
  for (const typed of ['-5', '-1', '0', '', 'abc']) {
    sandbox.setAdminThreshold(typed);
    assert.ok(sandbox.S.nt >= 1, `"${typed}" set the admin threshold to ${sandbox.S.nt}`);
    assert.ok(sandbox.S.nt <= 4, `"${typed}" set the admin threshold above the owner count`);
  }
  // The same at the create form's end, which holds a string rather than a number.
  sandbox.S.cf = { owners: [{ addr: A }, { addr: B }], threshold: '1' };
  for (const typed of ['-5', '0', 'abc']) {
    setCreateThreshold(typed);
    assert.equal(sandbox.S.cf.threshold, '1', `"${typed}" did not clamp to one`);
  }
});

// ── an address that is nearly one ─────────────────────────────────
//
// ethers.isAddress rejects a truncated address and a mixed-case one whose
// checksum does not verify — which is what a chat client, an editor or a retype
// makes of a good address. Treating those as "not an owner" and skipping the
// line would take a five-line paste and seat four signers into an owner set that
// cannot be revised without a full multisig round of the vault being created.

const BAD_SUM = '0xDAC17F958D2ee523a2206206994597C13D831ec7';   // one letter case-flipped
const GOOD_SUM = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const SHORT = '0x111111111111111111111111111111111111111';      // 39 hex characters

test('the fixtures are what this section claims they are', () => {
  // Otherwise a change in ethers turns the four tests below into tests of
  // nothing at all, silently.
  assert.equal(sandbox.ethers.isAddress(GOOD_SUM), true);
  assert.equal(sandbox.ethers.isAddress(BAD_SUM), false, 'the bad-checksum fixture verifies');
  assert.equal(sandbox.ethers.isAddress(SHORT), false);
});

test('an address with a broken checksum lands in a row, it does not vanish', () => {
  const r = parseOwnerPaste(`${A}\n${BAD_SUM}\n${B}`);
  assert.deepEqual(r.map(o => o.addr), [A, BAD_SUM, B],
    'a signer was dropped out of an owner set that cannot be corrected after deploy');
});

test('a truncated address lands in a row too, in the position it was pasted at', () => {
  assert.deepEqual(parseOwnerPaste(`${A}\n${SHORT}`).map(o => o.addr), [A, SHORT]);
});

test('a row that is nearly an address is a row the form refuses to deploy', () => {
  // The whole point of carrying it through: validateCreate judges it exactly as
  // it judges a typed one, and the reason names the row rather than the paste.
  const v = validateCreate(form([A, BAD_SUM]), false);
  assert.equal(v.owners[1].state, 'invalid');
  assert.equal(v.ready, false);
  assert.match(v.reason, /INVALID/);
});

test('the paste says there is a bad row, because forty rows do not fit on a screen', () => {
  cf(['']);
  paste(`${A}\n${BAD_SUM}\n${B}`);
  assert.deepEqual(sandbox.S.cf.owners.map(o => o.addr), [A, BAD_SUM, B]);
  assert.match(sandbox._flashed, /PASTED 3 OWNERS/);
  assert.match(sandbox._flashed, /1 NOT A VALID ADDRESS/);
});

test('a near-miss address is not mistaken for the label of the owner beside it', () => {
  // "0xGOOD, 0xBROKEN" is two attempts at an owner, not an owner named 0xBROKEN.
  const r = parseOwnerPaste(`${A}, ${SHORT}`);
  assert.equal(r.length, 2);
  assert.equal(r[0].label, '');
});

test('a word is still a label and a header is still skipped', () => {
  // The widened net catches 0x-shaped tokens only. Everything else reads as
  // before, or the change would turn every spreadsheet header into a red row.
  assert.deepEqual(parseOwnerPaste('OWNERS\nsigners:'), []);
  assert.deepEqual(parseOwnerPaste(`${A}, Alice`), [{ addr: A, label: 'Alice' }]);
});

// ── what a rejected owner row says ────────────────────────────────
//
// The row is where a bad owner gets fixed, so the note on it is the whole
// remedy. Every one of these was "NOT A VALID ADDRESS OR .ETH / .WEI / … NAME"
// — a sentence that is true of all of them and useful for none, and which sends
// somebody who pasted forty owners back to re-copy the list when one row needs
// one character.

const note = (raw) => sandbox.ownerRowNote(validateCreate(form([raw]), false).owners[0], 0, 'https://x', false, 1);

test('a case-damaged address is named as one, not as a bad format', () => {
  assert.match(note(BAD_SUM).html, /BAD CHECKSUM/);
});

test('a truncated address counts itself', () => {
  assert.match(note(SHORT).html, /39\/40 HEX CHARS/);
});

test('a sentinel is a good address that cannot be an owner, and is told apart from a typo', () => {
  // 0x0 is right in every character. Reporting it as malformed sends the
  // operator to check the characters, which are fine.
  const z = note('0x' + '0'.repeat(40)).html;
  assert.match(z, /SENTINEL/);
  assert.doesNotMatch(z, /NOT A VALID ADDRESS/);
});

test('text that is not an address at all still says which names a row takes', () => {
  assert.match(note('carol').html, /NOT A VALID ADDRESS OR/);
  assert.match(note('carol').html, /\.eth/i);
});

test('a basename near-miss keeps its own correction', () => {
  assert.match(note('alice.base').html, /DID YOU MEAN/);
});

test('a valid owner is not given an error note at all', () => {
  assert.equal(/CHECKSUM|HEX CHARS|SENTINEL|NOT A VALID/.test(note(A).html), false);
});
