// The connect sheet — what is on it, when, and what is allowed to move.
//
//   node --test              (from the repo root; discovers every suite)
//
// This is the app's front door and the one list where picking the wrong row is
// picking the wrong account, so it has two properties worth pinning and they
// pull against each other.
//
// It has to be there immediately. It used to be filled in by a fixed 200ms
// sleep — every visitor paid all of it, every time, and what they got in the
// meantime was an open dialog with an empty body. A fixed wait is the wrong
// shape for the thing it is waiting on: an EIP-6963 extension announces in
// response to the request event, and it registers that listener when its content
// script runs, which is usually before this page's scripts and occasionally
// after. So the wait can neither be skipped nor be a constant.
//
// And it has to be still. The obvious way to fold in a late announcement is to
// redraw the list, which destroys the row the pointer is over, drops the row the
// keyboard is on, and moves every row below the insertion point — at the exact
// moment somebody is reaching for one. So the sheet only ever GROWS: a wallet
// that turns up after it is open is appended, and nothing already drawn moves or
// is rebuilt. The identity assertions below are what make that a rule rather
// than an intention — they compare node objects, not markup.
//
// wallet.js has no DOM of its own to be tested against and this repo has no
// dependencies by design, so the fake below is not a DOM: it is a recorder for
// the four things _paintWalletSheet actually does to a container. What it
// answers is "which keys are drawn, in what order, and were the nodes already
// there left alone" — which is the whole claim.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dapp', 'wallet.js'), 'utf8');
const LINES = SRC.split('\n');

// wallet.js is one IIFE whose body sits unindented, so column 0 is the test —
// the same reading scope.test.js relies on. A missing name throws rather than
// returning nothing, so a rename fails the suite instead of quietly deleting its
// coverage.
function grab(name) {
  const decl = LINES.findIndex(l =>
    ['const', 'let'].some(kw => l.startsWith(`${kw} ${name} `) || l.startsWith(`${kw} ${name}=`)));
  if (decl !== -1) {
    if (/;\s*(\/\/.*)?$/.test(LINES[decl])) return LINES[decl];
    let end = decl + 1;
    while (end < LINES.length && !/^[}\])]/.test(LINES[end])) end++;
    if (end >= LINES.length) throw new Error(`walletsheet.test.js: no closing line for '${name}'.`);
    return LINES.slice(decl, end + 1).join('\n');
  }
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`walletsheet.test.js: '${name}' is no longer in dapp/wallet.js — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`walletsheet.test.js: no closing brace for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const NEEDED = [
  '_escMap', '_esc',
  'ANNOUNCE_DEADLINE_MS', 'ANNOUNCE_RETRY_MS',
  'detectWallets',
  '_sheetTimer', '_sheetDrawn', '_stopSheetPoll', '_walletRowHtml',
  '_walletFocusReturn',
  // the subjects
  '_paintWalletSheet', 'showWalletModal',
];

// ── the container, recording what is done to it ───────────────────
let _nid = 0;
const mkRow = key => ({
  nid: ++_nid, dataset: { walletKey: key }, handlers: [],
  addEventListener(_ev, fn) { this.handlers.push(fn); },
  focus() { doc.activeElement = this; },
});

function makeContainer() {
  const c = {
    rows: [], plain: [], empty: null,
    rebuilds: 0, clears: 0, appends: 0,
    get innerHTML() { return ''; },
    set innerHTML(html) {
      // Two different things assign here and only one of them is a rebuild.
      //
      // Assigning '' is the first paint emptying a body that a PREVIOUS open
      // left behind. It moves nothing, because at that point nothing from this
      // open is on screen yet, and without it the append-only draw below lays a
      // second full set of rows under the first — which is what a reopened sheet
      // used to do.
      //
      // Assigning content is a wholesale rebuild. The first paint of a CONNECTED
      // sheet is one, legitimately: a fixed two-line body with nothing for an
      // announcement to add. On any later paint either of them is the bug.
      if (html === '') { c.clears++; c.rows = []; c.plain = []; c.empty = null; return; }
      c.rebuilds++;
      c.rows = []; c.plain = [];
      c.empty = /data-sheet-empty/.test(html) ? { remove() { c.empty = null; } } : null;
      if (/wallet-option disconnect/.test(html)) c.plain = [mkRow(null)];
    },
    insertAdjacentHTML(pos, html) {
      assert.equal(pos, 'beforeend', 'the sheet inserted somewhere other than the end, so a drawn row moved');
      c.appends++;
      for (const m of html.matchAll(/data-wallet-key="([^"]*)"/g)) c.rows.push(mkRow(m[1]));
    },
    querySelector(sel) {
      if (sel === '[data-sheet-empty]') return c.empty;
      if (sel === '.wallet-option') return c.rows[0] || c.plain[0] || null;
      throw new Error('walletsheet.test.js: unexpected container selector ' + sel);
    },
    querySelectorAll(sel) {
      assert.equal(sel, '[data-wallet-key]');
      return c.rows;
    },
  };
  return c;
}

// ── the document, and the modal in it ─────────────────────────────
const closeBtn = { isClose: true, focus() { doc.activeElement = closeBtn; } };
let container = makeContainer();
const modal = {
  active: true,
  classList: { add(cl) { if (cl === 'active') modal.active = true; }, remove(cl) { if (cl === 'active') modal.active = false; }, contains: cl => cl === 'active' && modal.active },
  querySelector: sel => (sel === '.wallet-modal-close' ? closeBtn : null),
};
const doc = {
  activeElement: null,
  body: { classList: { add() {}, remove() {} } },
  getElementById: id => (id === 'walletModal' ? modal : id === 'walletOptions' ? container : null),
  querySelector: sel => (sel === '.wallet-modal-close' ? closeBtn : null),
  addEventListener() {},
};

// ── announcements, and a clock the tests drive ────────────────────
const listeners = new Map();
let now = 0;
const timers = new Map();
let _tid = 0;

const sandbox = {
  console,
  document: doc,
  Date: { now: () => now },
  Event: class { constructor(type) { this.type = type; } },
  setInterval: (fn, ms) => { const id = ++_tid; timers.set(id, { fn, ms }); return id; },
  clearInterval: id => timers.delete(id),
  setTimeout: (fn) => fn,
  clearTimeout: () => {},
  Map, Set,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.addEventListener = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); };
sandbox.removeEventListener = (type, fn) => { const s = listeners.get(type); if (s) s.delete(fn); };
sandbox.dispatchEvent = (e) => { for (const fn of [...(listeners.get(e.type) || [])]) fn(e); return true; };
sandbox.eip6963Providers = new Map();
// Real DOM work and a real connect, both out of scope here: the sheet is built
// once by walletInit and clicking a row is the next suite's problem.
sandbox.injectWalletModal = () => {};
sandbox.connectWithWallet = () => {};
vm.createContext(sandbox);
vm.runInContext(NEEDED.map(grab).join('\n') + '\n' +
  NEEDED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n') + `
  globalThis.showWalletModal = showWalletModal;
  globalThis._paintWalletSheet = _paintWalletSheet;
  globalThis._stopSheetPoll = _stopSheetPoll;
  globalThis.setConnected = a => { _connectedAddress = a; };
  globalThis.pollCount = () => 0;
`, sandbox);
for (const n of NEEDED) {
  if (sandbox[n] === undefined && n !== '_sheetTimer' && n !== '_walletFocusReturn')
    throw new Error(`walletsheet.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}

const { showWalletModal } = sandbox;
// Constants are read off the source rather than restated, so a change to either
// moves the tests with it instead of past them.
const { ANNOUNCE_DEADLINE_MS, ANNOUNCE_RETRY_MS } = sandbox;

// Announce an extension, exactly as one does: put it in the map, then fire.
function announce(uuid, name) {
  sandbox.eip6963Providers.set(uuid, { info: { uuid, name }, provider: {} });
  sandbox.dispatchEvent(new sandbox.Event('eip6963:announceProvider'));
}
// One turn of the sheet's poll.
function tick() {
  now += ANNOUNCE_RETRY_MS;
  for (const t of [...timers.values()]) t.fn();
}
function reset() {
  container = makeContainer();
  sandbox.eip6963Providers.clear();
  sandbox.ethereum = undefined;
  sandbox._connectedAddress = null;
  doc.activeElement = null;
  modal.active = true;
  listeners.clear();
  timers.clear();
  now = 0;
  _nid = 0;
}
const keys = () => container.rows.map(r => r.dataset.walletKey);

// ── the tests ─────────────────────────────────────────────────────

test('the sheet has its wallets in it the moment it opens', () => {
  // The whole point. Nothing may be waited on to draw what has already answered
  // — an extension that announced before the sheet was opened is not news.
  reset();
  announce('u1', 'Rabby');
  listeners.clear();                       // the announcement is history; the sheet has not opened yet
  showWalletModal();
  assert.deepEqual(keys(), ['eip6963_u1', 'coinbase', 'walletconnect']);
  assert.equal(container.appends, 1, 'the sheet drew in more than one pass with nothing to wait for');
  assert.equal(container.rebuilds, 0, 'the sheet rebuilt its body rather than filling an empty one');
});

test('a wallet that announces late is appended, and nothing already drawn moves', () => {
  reset();
  announce('u1', 'Rabby');
  listeners.clear();
  showWalletModal();
  const before = [...container.rows];
  announce('u2', 'Frame');
  assert.deepEqual(keys(), ['eip6963_u1', 'coinbase', 'walletconnect', 'eip6963_u2'],
    'a late arrival was inserted among the rows already on screen instead of after them');
  // Identity, not markup: these have to be the very same nodes, or the row under
  // a finger is not the row that was under it a moment ago.
  assert.deepEqual(container.rows.slice(0, 3).map(r => r.nid), before.map(r => r.nid),
    'the rows already drawn were rebuilt when a late wallet arrived');
  assert.equal(container.rebuilds, 0);
});

test('an announcement that adds nothing touches nothing', () => {
  // The sheet re-asks on a 40ms cadence and every extension answers every time.
  // Redrawing an identical list on each of those would make the sheet unusable
  // for as long as it polls.
  reset();
  announce('u1', 'Rabby');
  listeners.clear();
  showWalletModal();
  const appends = container.appends, before = [...container.rows];
  for (let i = 0; i < 5; i++) { announce('u1', 'Rabby'); tick(); }
  assert.equal(container.appends, appends, 'the sheet appended rows it had already drawn');
  assert.equal(container.rebuilds, 0);
  assert.deepEqual(container.rows.map(r => r.nid), before.map(r => r.nid));
});

test('two extensions under one name are still one row', () => {
  // detectWallets dedupes by name; the sheet must not undo that by appending the
  // second one as a row of its own.
  reset();
  showWalletModal();
  announce('u1', 'Rabby');
  announce('u2', 'rabby');
  assert.deepEqual(keys().filter(k => k.startsWith('eip6963_')), ['eip6963_u1']);
});

test('the poll asks until the deadline and then stops', () => {
  reset();
  showWalletModal();
  let asks = 0;
  sandbox.addEventListener('eip6963:requestProvider', () => { asks++; });
  const rounds = Math.ceil(ANNOUNCE_DEADLINE_MS / ANNOUNCE_RETRY_MS);
  for (let i = 0; i < rounds; i++) tick();
  assert.ok(asks > 0, 'the sheet never re-asked, so an extension that injects late is never seen');
  assert.equal(timers.size, 0, 'the poll outlived its deadline');
  const after = asks;
  tick(); tick();
  assert.equal(asks, after, 'the sheet went on asking after the deadline');
});

test('closing the sheet stops the poll on the call, not on its next tick', () => {
  reset();
  showWalletModal();
  assert.equal(timers.size, 1);
  sandbox._stopSheetPoll();               // what closeWalletModal calls, first thing
  assert.equal(timers.size, 0);
  assert.equal((listeners.get('eip6963:announceProvider') || new Set()).size, 0,
    'the announcement listener outlived the sheet and would redraw a container that is gone');
});

test('a sheet that is no longer on screen is not drawn into', () => {
  reset();
  showWalletModal();
  modal.active = false;                    // dismissed by Escape, or by a click on a row
  const before = container.appends;
  announce('u9', 'Late');
  tick();
  assert.equal(container.appends, before, 'the sheet kept filling a dialog that had closed');
  assert.equal(timers.size, 0, 'the poll did not notice the sheet had gone');
});

test('focus lands on the first wallet when the sheet opens, and is left alone after that', () => {
  reset();
  announce('u1', 'Rabby');
  listeners.clear();
  showWalletModal();
  assert.equal(doc.activeElement, container.rows[0], 'opening the sheet left focus on the close button');
  // The visitor moves to another row; a late arrival must not drag them off it.
  doc.activeElement = container.rows[1];
  announce('u2', 'Frame');
  assert.equal(doc.activeElement, container.rows[1], 'a late arrival took the keyboard off the row it was on');
});

test('a connected sheet is the disconnect button, and has no poll behind it', () => {
  reset();
  sandbox._connectedAddress = '0x1111111111111111111111111111111111111111';
  showWalletModal();
  assert.equal(container.rebuilds, 1, 'the connected body is one fixed rebuild');
  assert.equal(container.appends, 0);
  assert.equal(timers.size, 0, 'a sheet with nothing to add to it started a poll anyway');
  assert.equal(doc.activeElement, container.plain[0], 'focus was left on the close button');
});

test('an announced name and key are escaped before they reach the row', () => {
  // An EIP-6963 announcement is whatever an installed extension chose to
  // broadcast, and both halves of it land in an HTML *attribute* — a bare quote
  // in either would close the attribute and open a tag.
  const html = sandbox._walletRowHtml({ key: 'a"b', name: '<img src=x onerror=alert(1)>', icon: '' });
  assert.ok(html.includes('data-wallet-key="a&quot;b"'), 'a quote in the key was not escaped');
  assert.ok(!html.includes('<img'), 'a wallet name reached the row as markup');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the name was not escaped, it was dropped');
});

test('a sheet opened, dismissed and opened again holds one row per wallet', () => {
  // The reported defect. _sheetDrawn is cleared on every open, so every wallet
  // counts as fresh again — and the draw is append-only by design, so without
  // emptying the body first the second open laid a complete second set of rows
  // beneath the first, and the third a set beneath that. It never showed on the
  // connected sheet, which assigns its body instead of appending to it.
  reset();
  announce('u1', 'Rabby');
  announce('u2', 'Frame');

  showWalletModal();
  const first = keys();
  assert.deepEqual(first, ['eip6963_u1', 'eip6963_u2', 'coinbase', 'walletconnect']);

  for (let open = 2; open <= 4; open++) {
    sandbox._stopSheetPoll();             // what closeWalletModal does first
    modal.active = false;                 // ...then the class comes off
    modal.active = true;                  // reopened
    showWalletModal();
    assert.deepEqual(keys(), first, `open ${open} did not hold one row per wallet`);
    assert.equal(new Set(keys()).size, keys().length, `open ${open} drew a wallet twice`);
  }
  assert.equal(container.rebuilds, 0, 'the sheet rebuilt a body rather than emptying it');
});

test('emptying on reopen does not cost the stillness a late announcement relies on', () => {
  // The fix empties the body on the FIRST paint of an open and never after, so
  // the property the whole sheet is built around still holds: once a row is on
  // screen it does not move, whatever announces later.
  reset();
  announce('u1', 'Rabby');
  showWalletModal();
  const clearsAfterOpen = container.clears;
  const before = keys();

  announce('u2', 'Frame');                // arrives while the sheet is open
  tick();
  assert.deepEqual(keys().slice(0, before.length), before, 'a late announcement moved a row that was already drawn');
  assert.ok(keys().includes('eip6963_u2'), 'a late announcement never arrived');
  assert.equal(container.clears, clearsAfterOpen, 'the sheet emptied itself on a later paint');
  assert.equal(container.rebuilds, 0);
});
