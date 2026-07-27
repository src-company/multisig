// Name resolution — the parts of it that are decidable without a network.
//
//   node --test test/
//
// No dependencies and no build step, because the dapp has neither: it is one
// HTML file with its script inline, served as written. That shape is deliberate
// and this suite does not ask it to change. It reads the file, lifts the
// functions out by name, and runs them in a sandbox with the smallest set of
// stubs each one needs.
//
// The lifting is the fragile part, so it is the loud part. grab() throws when a
// name is missing rather than returning nothing, and every name is lifted before
// a single test runs — so renaming a function in the dapp fails this suite
// immediately and unmistakably, instead of quietly removing its coverage and
// leaving a green run behind.
//
// What is NOT here: anything that needs a chain or the .mega resolver. Those are
// exercised against the real networks, which cannot be a build-time dependency.
// This covers the logic that decides what the network is even asked — which
// suffix routes where, what a field says, which names may be spelled into a
// link, and how an answer is cached — and that is where the bugs have been.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dapp', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

// A `const NAME = ...;` one-liner, or a `function NAME(...)` — which in that
// file is written both ways: closed on its own line by a brace in column 0, or
// small enough to sit entirely on one. Both shapes are checked, because
// scanning for the column-0 brace alone walks straight past a one-liner and
// swallows the sixty lines of declarations that follow it.
function grab(name) {
  const asConst = LINES.findIndex(l => l.startsWith(`const ${name} `) || l.startsWith(`const ${name}=`));
  if (asConst !== -1) return LINES[asConst];
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`names.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];      // whole function on one line
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`names.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const NEEDED = [
  'NAME_RE', 'NAME_KINDS', 'nameKindsHint',
  'MEGA_CHAIN_ID', 'MEGA_SUFFIX_RE', 'MEGA_NAME_RE', 'megaNamesOn', 'isMegaName',
  'BASE_CHAIN_ID', 'BASE_NAME_RE', 'BASE_LINK_RE', 'baseNamesOn', 'isBaseName',
  'WNS_CHAIN_ID', 'WNS_NAME_RE',
  'nameNearMiss', 'linkableName', 'parseDeepLink',
  '_addrState', 'addrHint', 'ownerRowNote', '_onKey',
];

// Stubs, kept as thin as each function will tolerate. Anything with real
// behaviour worth asserting is lifted from the dapp instead of written here.
const sandbox = {
  S: { chainId: 1 },
  CHAINS: { 1: {}, 8453: {}, 42161: {}, 10: {}, 11155111: {}, 84532: {}, 4326: {} },
  _OWNER_STATE_COLOR: { address: 'var(--g)', name: 'var(--a)', invalid: 'var(--r)', dup: 'var(--r)', empty: 'var(--d)' },
  ethers: {
    isAddress: a => /^0x[0-9a-fA-F]{40}$/.test(String(a)) && !/^0x[0-9a-f]*[A-F]/.test(String(a).slice(0, 2)),
    getAddress: a => String(a),
  },
  esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  shortAddr: a => (/^0x[0-9a-fA-F]{40}$/.test(a || '') ? a.slice(0, 6) + '…' + a.slice(-4) : (a || '')),
  // ownerRowNote asks the chain whether an owner is a contract. That answer is
  // a network fact; what this suite checks is what the row does with it, so it
  // is supplied rather than fetched.
  cannotSign: () => false,
  CONTRACT_NOTE: 'CONTRACT &middot; APPROVES ON-CHAIN, CANNOT SIGN',
};
vm.createContext(sandbox);
// Function declarations land on the context by themselves; `const` ones do not,
// because they live in the script's own lexical scope. So each name is handed
// out explicitly afterwards — otherwise half of these read as undefined and the
// tests comparing against them pass for the wrong reason.
const handOut = NEEDED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n');
vm.runInContext(NEEDED.map(grab).join('\n') + '\n' + handOut, sandbox);
for (const n of NEEDED) {
  if (sandbox[n] === undefined) throw new Error(`names.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}
const {
  NAME_RE, NAME_KINDS, nameKindsHint, MEGA_CHAIN_ID, BASE_CHAIN_ID, WNS_CHAIN_ID,
  MEGA_NAME_RE, BASE_LINK_RE, isMegaName, isBaseName, megaNamesOn, baseNamesOn,
  nameNearMiss, linkableName, parseDeepLink, _addrState, addrHint, ownerRowNote, _onKey,
} = sandbox;

const ADDR = '0x2211d1D0020DAEA8039E46Cf1367962070d77DA9';

test('every namespace is one matcher, on every chain', () => {
  for (const n of ['nick.eth', 'ross.wei', 'donnoh.gwei', 'jesse.base.eth', 'bread.mega']) {
    assert.ok(NAME_RE.test(n), `${n} should be a name`);
    assert.ok(NAME_RE.test(n.toUpperCase()), `${n} should match case-insensitively`);
  }
  // A name means the same thing wherever the app is pointed — that is the whole
  // reason resolution is picked by suffix and not by the chain in play.
  for (const chainId of Object.keys(sandbox.CHAINS).map(Number)) {
    sandbox.S.chainId = chainId;
    assert.ok(NAME_RE.test('jesse.base.eth') && NAME_RE.test('bread.mega'));
  }
  sandbox.S.chainId = 1;
  assert.ok(!NAME_RE.test('alice.xyz'));
  assert.ok(!NAME_RE.test('alice.megax'));
  assert.ok(!NAME_RE.test(ADDR));
});

test('suffixes do not collide', () => {
  // '.gwei' does not end in '.wei', which is what lets nsFor pick by suffix
  // without hashing a name into the wrong registry.
  assert.ok(!'foo.gwei'.endsWith('.wei'));
  assert.ok(isBaseName('jesse.base.eth'));
  assert.ok(!isBaseName('nick.eth'), 'a plain ENS name is not a basename');
  assert.ok(isMegaName('bread.mega'));
  assert.ok(!isMegaName('bread.base.eth'));
  assert.ok(baseNamesOn(BASE_CHAIN_ID) && !baseNamesOn(MEGA_CHAIN_ID));
  assert.ok(megaNamesOn(MEGA_CHAIN_ID) && !megaNamesOn(BASE_CHAIN_ID));
});

test('the hint says what the field takes, compactly, from one source', () => {
  const hint = nameKindsHint();
  for (const k of ['.eth', '.wei', '.gwei', '.base.eth', '.mega']) assert.ok(hint.includes(k));
  // Width is why it is compact: at 46 characters it was 90% of an owner row on
  // a phone, which made the dimmest text on the screen the widest thing on it.
  assert.ok(!/ \/ /.test(hint), 'the at-rest hint drops the spaces around separators');
  assert.ok(hint.length <= 34, `hint is ${hint.length} chars — it has grown back`);
  // Spelled once. The prose form keeps its spacing for the sentence it sits in.
  assert.equal(hint.replace(/\//g, ' / '), NAME_KINDS);
  assert.ok(NAME_KINDS.includes(' / '));
});

test('a field at rest names the namespaces, and stops the moment it has news', () => {
  assert.equal(addrHint('').txt, nameKindsHint());
  assert.equal(addrHint('').color, 'var(--d)');
  assert.equal(_addrState('').txt, '', 'the raw state stays empty; only addrHint fills it');
  assert.equal(addrHint(ADDR).txt, 'VALID ADDRESS');
  assert.equal(addrHint('jesse.base.eth').txt, 'NAME · RESOLVED ON BASE');
  assert.equal(addrHint('bread.mega').txt, 'NAME · RESOLVED ON MEGAETH');
  assert.equal(addrHint('nick.eth').txt, 'NAME · RESOLVED ON MAINNET');
  assert.equal(addrHint('nonsense').txt, 'NOT A VALID ADDRESS OR NAME');
  assert.match(addrHint('0x2211').txt, /HEX CHARS/);
});

test('.base is diagnosed, never silently expanded', () => {
  // `jesse.base` is how people say a basename out loud and is not one — the
  // registry hashes it to a different node and answers the zero address. The
  // app names the fix rather than picking a name the operator did not type.
  const near = nameNearMiss('jesse.base');
  assert.match(near, /DID YOU MEAN JESSE\.BASE\.ETH\?/);
  assert.equal(nameNearMiss('jesse.base.eth'), null, 'the real thing is not a near miss');
  assert.equal(nameNearMiss('nick.eth'), null);
  assert.equal(addrHint('jesse.base').color, 'var(--y)', 'advisory, not an error');
  assert.ok(!NAME_RE.test('jesse.base'), 'and it never resolves as a name');
});

test('a link may only be spelled with a name the arriving browser will read', () => {
  assert.equal(linkableName('vault.id.wei', WNS_CHAIN_ID), 'vault.id.wei');
  assert.equal(linkableName('vault.id.wei', BASE_CHAIN_ID), null);
  assert.equal(linkableName('vault.base.eth', BASE_CHAIN_ID), 'vault.base.eth');
  assert.equal(linkableName('vault.base.eth', WNS_CHAIN_ID), null);
  assert.equal(linkableName('vault.mega', MEGA_CHAIN_ID), 'vault.mega');
  assert.equal(linkableName('vault.mega', BASE_CHAIN_ID), null);
  // ENS is excluded on purpose: a .eth name may only answer through an offchain
  // gateway, and a link that opens on some networks and not others is worse
  // than one that spells its address out.
  assert.equal(linkableName('vault.eth', WNS_CHAIN_ID), null);
  assert.equal(linkableName(null, WNS_CHAIN_ID), null);
  assert.equal(linkableName('base.eth', BASE_CHAIN_ID), null, 'a bare suffix names nothing');
});

test('a deep link takes its chain from the suffix, and a number may not contradict it', () => {
  assert.equal(parseDeepLink('vault.base.eth').chainId, BASE_CHAIN_ID);
  assert.equal(parseDeepLink('vault.mega').chainId, MEGA_CHAIN_ID);
  assert.equal(parseDeepLink('vault.id.wei').chainId, WNS_CHAIN_ID);
  assert.equal(parseDeepLink(`${BASE_CHAIN_ID}/vault.base.eth`).chainId, BASE_CHAIN_ID);
  assert.equal(parseDeepLink(`${WNS_CHAIN_ID}/vault.base.eth`), null, 'a chain that disagrees is a broken link');
  assert.equal(parseDeepLink(`${BASE_CHAIN_ID}/vault.mega`), null);
  assert.equal(parseDeepLink('vault.base.eth/tx/7').nonce, 7);
  assert.equal(parseDeepLink('nick.eth'), null, 'ENS is not linkable');
  assert.equal(parseDeepLink('.mega'), null);
  assert.equal(parseDeepLink('base.eth'), null);
});

test('an owner row says what it takes once per form, not once per row', () => {
  const empty = { state: 'empty', raw: '', pv: null };
  assert.equal(ownerRowNote(empty, 1, '', true, 1).html, sandbox.esc(nameKindsHint()));
  assert.equal(ownerRowNote(empty, 2, '', false, 1).html, '', 'every other empty row is silent');
  assert.equal(ownerRowNote({ state: 'address', raw: ADDR, pv: null }, 0, '', true, 1).html, '');
  assert.match(ownerRowNote({ state: 'invalid', raw: 'nonsense', pv: null }, 0, '', true, 1).html, /NOT A VALID ADDRESS/);
  assert.match(ownerRowNote({ state: 'name', raw: 'x.eth', pv: { state: 'resolving' } }, 0, '', true, 1).html, /RESOLVING/);
  // What the row echoes back is what the operator typed, and it lands in HTML.
  const xss = ownerRowNote({ state: 'invalid', raw: '<img src=x onerror=alert(1)>.base', pv: null }, 0, '', true, 1);
  assert.ok(!xss.html.includes('<img'), 'the echoed input is escaped');
  assert.match(xss.html, /DID YOU MEAN/);
});

test('a contract owner is marked, because the owner set cannot be taken back', () => {
  sandbox.cannotSign = () => true;
  const note = ownerRowNote({ state: 'address', raw: ADDR, pv: null }, 0, '', false, BASE_CHAIN_ID);
  assert.match(note.html, /CANNOT SIGN/);
  assert.equal(note.color, 'var(--y)', 'advisory — a DAO or nested multisig owner is a legitimate choice');
  sandbox.cannotSign = () => false;
  assert.equal(ownerRowNote({ state: 'address', raw: ADDR, pv: null }, 0, '', false, BASE_CHAIN_ID).html, '');
});

test('a cached name is scoped to the ordering that produced it', () => {
  // Three orderings — at home on Base, at home on MegaETH, and everywhere else,
  // which all share one. A key that ignored this would show a signer their
  // MegaETH name after a switch to Base.
  const base = { chainId: BASE_CHAIN_ID, scope: 'base' };
  const mega = { chainId: MEGA_CHAIN_ID, scope: 'mega' };
  const keys = new Set([_onKey(ADDR, null), _onKey(ADDR, base), _onKey(ADDR, mega)]);
  assert.equal(keys.size, 3, 'each ordering gets its own cache entry');
  assert.equal(_onKey(ADDR, base), _onKey(ADDR.toLowerCase(), base), 'and it is case-insensitive');
});
