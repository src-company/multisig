// Every text field this app draws holds what was typed in it in state.
//
//   node --test              (from the repo root; discovers every suite)
//
// This one is a reader over the source rather than a harness around a function,
// because what it asserts is a property of the markup: that no field is left
// uncontrolled.
//
// Why it is a rule and not a preference. This app rebuilds its entire DOM on
// every render(), and render() is called by things the person typing did not
// do — a two-second poll tick finding a matured timelock, a balance read
// landing, a holdings reload, an ABI lookup returning, a wallet changing chain.
// An <input> with no value= is rebuilt empty, so any of those events silently
// erases half-typed input: an address pasted into ADD OWNER, a calldata blob in
// the CUSTOM tab, a token address in + CUSTOM. Nothing reports it. The field is
// simply blank again, and the natural reading is that you mistyped.
//
// The state declaration in S already says this out loud —
//
//   "Amount/recipient live in state (not just the DOM) so a re-render — token
//    switch, delivery change, poll tick — never wipes half-typed input"
//
// — and seven fields had been added since without it. This suite is what makes
// the eighth fail here rather than in somebody's wallet.
//
// The other half of the rule, which only a reader can state and not enforce: a
// field held in state no longer clears itself, because clearing itself was a
// side effect of being wiped on every render. Whatever consumes it has to empty
// it once the thing it was for has actually happened — and only then, so that a
// declined wallet prompt does not also throw away the address.

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
    if (end >= LINES.length) throw new Error(`fields.test.js: no closing line found for 'const ${name}'.`);
    return LINES.slice(asConst, end + 1).join('\n');
  }
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`fields.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`fields.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

function lineOf(index) { return SRC.slice(0, index).split('\n').length; }
function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

// Every <input>/<textarea> this file draws, with the classes that mark it as one
// of the app's own text fields. .inp is the shared field style; .amt-in is the
// headline amount in the send builder, the stake tab and the top up dialog.
function textFields() {
  const out = [];
  for (const m of SRC.matchAll(/<(input|textarea)\b[^>]*>/g)) {
    const tag = m[0];
    const cls = attr(tag, 'class') || '';
    if (!/\binp\b|\bamt-in\b/.test(cls)) continue;
    const type = attr(tag, 'type') || 'text';
    // Non-text controls carry their value a different way (checked, files) and
    // are not what this rule is about. None exist today; the filter is here so
    // that adding one is not a false failure somebody has to argue with.
    if (['checkbox', 'radio', 'file', 'submit', 'button'].includes(type)) continue;
    out.push({ tag, type, line: lineOf(m.index), id: attr(tag, 'id') || '(no id)', kind: m[1], index: m.index });
  }
  return out;
}

test('the source still contains the fields this suite is about', () => {
  // A reader over source text is only as good as its match. If a refactor moves
  // the markup somewhere this regex cannot see, every assertion below passes by
  // finding nothing — which is the one way a lint like this fails silently.
  const found = textFields();
  assert.ok(found.length >= 20, `only ${found.length} text fields matched — the reader has lost sight of the markup`);
  const ids = found.map(f => f.id);
  for (const id of ['tx-amount', 'tx-to', 'topup-amount', 'topup-custom-addr', 'cx-data', 'admin-add-owner']) {
    assert.ok(ids.includes(id), `${id} was not matched — the reader is not seeing the markup it is meant to check`);
  }
});

test('every input is drawn with the value it is meant to be holding', () => {
  const naked = textFields()
    .filter(f => f.kind === 'input')
    .filter(f => !/\bvalue="/.test(f.tag));
  assert.deepEqual(naked.map(f => `${f.id} (line ${f.line})`), [],
    'these inputs are rebuilt empty by every render, so anything typed into them is erased by a poll tick');
});

test('every textarea is drawn with the value it is meant to be holding', () => {
  // A textarea has no value attribute — what it shows is its content, so the
  // check is that something is interpolated between the tags.
  const bad = [];
  for (const f of textFields().filter(f => f.kind === 'textarea')) {
    const close = SRC.indexOf('</textarea>', f.index);
    const body = close === -1 ? '' : SRC.slice(f.index + f.tag.length, close);
    if (!body.includes('${')) bad.push(`${f.id} (line ${f.line})`);
  }
  assert.deepEqual(bad, [],
    'these textareas are rebuilt empty by every render — a pasted calldata blob does not survive one');
});

test('a field that holds its value also has a way to write it', () => {
  // value= without an oninput is worse than neither: the field is repainted from
  // a state slot that nothing updates, so typing into it is undone by the next
  // render rather than merely forgotten by it. Fields whose value is a fact
  // about the vault rather than something being composed are named here.
  //
  // Empty, and worth keeping that way. The last entry was admin-vault-name,
  // which showed the vault's saved name and so gave a rename in progress
  // nowhere to live. It is not excepted any more: it holds a draft like the
  // THRESHOLD and DELAY editors beside it, and says which of the two answers is
  // on screen the same way they do — see renameState.
  const REPAINTED_FROM_TRUTH = new Set([]);
  // An exception list is a claim about the code, and a stale one quietly widens
  // the rule it is meant to narrow. Each entry has to still be earning its
  // place: drawn, and failing the rule without it.
  const all = textFields();
  for (const id of REPAINTED_FROM_TRUTH) {
    const f = all.find(x => x.id === id);
    assert.ok(f, `${id} is excepted here but is no longer drawn — drop it from the list`);
    assert.ok(/\bvalue="/.test(f.tag) && !/\bon(input|change)="/.test(f.tag),
      `${id} no longer needs this exception — it passes the rule on its own`);
  }
  const bad = textFields()
    .filter(f => /\bvalue="/.test(f.tag) && !REPAINTED_FROM_TRUTH.has(f.id))
    .filter(f => !/\bon(input|change)="/.test(f.tag))
    .map(f => `${f.id} (line ${f.line})`);
  assert.deepEqual(bad, [], 'these are painted from state that nothing writes back to');
});

// ── the two helpers the sweep introduced ──────────────────────────

const NEEDED = ['NAME_RE', 'NAME_KINDS', 'nameNearMiss', 'loadStatusFor', 'clearAdminFields', 'renameState'];
const sandbox = {
  console: { ...console, warn() {}, error() {} },
  S: {},
  nameKindsHint: () => 'ENTER A NAME',
  ethers: { isAddress: a => /^0x[0-9a-fA-F]{40}$/.test(a) },
  TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
  crypto: globalThis.crypto,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(NEEDED.map(grab).join('\n') + '\n' +
  NEEDED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n'), sandbox);
const { loadStatusFor, clearAdminFields, renameState } = sandbox;

test('the line under the LOAD field describes what is in the field', () => {
  // Painted from state at render time as well as patched on input. It used to be
  // hardcoded to the empty-field hint, so a rebuild left a valid address sitting
  // above a note telling you to enter one.
  assert.equal(loadStatusFor('').txt, 'ENTER A NAME');
  assert.equal(loadStatusFor('0x' + 'a'.repeat(40)).txt, 'VALID ADDRESS');
  assert.match(loadStatusFor('treasury.eth').txt, /RESOLVES ON LOAD/);
  assert.match(loadStatusFor('not an address').txt, /ENTER AN ADDRESS OR/);
  // Each state is a different colour, or the note is doing half its job.
  const colors = ['', '0x' + 'a'.repeat(40), 'treasury.eth', 'not an address'].map(v => loadStatusFor(v).color);
  assert.equal(new Set(colors).size, 4, 'two states of the LOAD field look the same');
});

test('the admin fields are emptied together, once something has been proposed', () => {
  // They are consumed by one flow and cleared at its success points. Clearing
  // one and not the others would leave an address sitting in a form that has
  // already acted on it, ready to be proposed a second time.
  sandbox.S.adminExec = '0xabc';
  sandbox.S.adminAddOwner = '0xdef';
  sandbox.S.adminAddLabel = 'TREASURER';
  clearAdminFields();
  assert.equal(sandbox.S.adminExec, '');
  assert.equal(sandbox.S.adminAddOwner, '');
  assert.equal(sandbox.S.adminAddLabel, '');
});

// ── the rename draft ──────────────────────────────────────────────

const VAULT_A = { address: '0x' + 'a'.repeat(40), name: 'TREASURY' };
const VAULT_B = { address: '0x' + 'b'.repeat(40), name: 'PAYROLL' };

test('with nothing typed, the field is the vault name and the button says NO CHANGE', () => {
  sandbox.S.rename = null;
  assert.deepEqual(renameState(VAULT_A), { text: 'TREASURY', dirty: false });
});

test('a rename in progress survives, and the button says there is something to save', () => {
  // The whole point: a poll tick used to snap this back to TREASURY mid-word.
  sandbox.S.rename = { addr: VAULT_A.address, text: 'TREASURY 2' };
  const rn = renameState(VAULT_A);
  assert.equal(rn.text, 'TREASURY 2');
  assert.ok(rn.dirty, 'an edit that differs from the saved name is not offered for saving');
});

test('a draft belongs to the vault it was typed for, and does not follow the selection', () => {
  // S.topup is an instance for the same reason. A draft carried onto another
  // vault's name field is an edit to a thing you were not editing.
  sandbox.S.rename = { addr: VAULT_A.address, text: 'TREASURY 2' };
  assert.deepEqual(renameState(VAULT_B), { text: 'PAYROLL', dirty: false });
});

test('typing the name it already has is not a change', () => {
  // Otherwise SAVE lights up for an edit that would do nothing, and pressing it
  // reports RENAMED for a rename that did not happen.
  sandbox.S.rename = { addr: VAULT_A.address, text: 'TREASURY' };
  assert.equal(renameState(VAULT_A).dirty, false);
  // Whitespace either side of it is still not a change.
  sandbox.S.rename = { addr: VAULT_A.address, text: '  TREASURY  ' };
  assert.equal(renameState(VAULT_A).dirty, false);
});

test('an emptied field is not an edit — the placeholder is showing the real name', () => {
  sandbox.S.rename = { addr: VAULT_A.address, text: '' };
  assert.equal(renameState(VAULT_A).dirty, false, 'an empty box offered to save nothing over the name');
  sandbox.S.rename = { addr: VAULT_A.address, text: '   ' };
  assert.equal(renameState(VAULT_A).dirty, false);
});

test('the field survives a vault with no name at all', () => {
  sandbox.S.rename = null;
  assert.deepEqual(renameState({ address: VAULT_A.address }), { text: '', dirty: false });
  assert.deepEqual(renameState(null), { text: '', dirty: false });
});
