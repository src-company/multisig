// The file that is actually served.
//
//   node --test              (from the repo root; discovers every suite)
//
// Every other suite in this directory reads dapp/index.html. Render serves
// dist/index.html, which is a different file: build.js strips the comments and
// the whitespace that laid them out, and 788 KB becomes 450 KB. So the whole of
// the coverage beside this file is coverage of the source, and the thing a
// visitor's browser runs has never been executed by any of it.
//
// build.js already proves a great deal about its own output — that the stripped
// text holds exactly the same literals in the same order as its input, and that
// every script still parses — and that is a stronger check than most build steps
// have. It is not this check. "The same literals in the same order" is a
// statement about tokens; what a co-signer depends on is a statement about
// answers. A build that dropped a line, mis-detected a regular expression and
// swallowed the rest of a function, or left a `//` inside a URL eating the code
// after it would have to survive both, and only the second one is about whether
// the vault still behaves.
//
// So this suite builds, lifts the same declarations out of BOTH files, and runs
// the same battery through each. Any answer that differs is a build that changed
// the program. The declarations chosen are the ones the other suites cover: the
// classifier a signature is given on the strength of, the packing that decides
// what lands on chain, and the parsing that stands between an anon-writable row
// and a BigInt.
//
// It also runs the build rather than trusting whatever is in dist/. dist/ is
// gitignored and is whatever the last local run left there, which on a fresh
// checkout is nothing at all.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DAPP = path.join(ROOT, 'dapp');
const DIST = path.join(ROOT, 'dist');

// Refuses rather than guesses, and leaves the previous dist/ where it is when it
// cannot prove its output — so a throw here is the build declining to ship, which
// is a suite failure and not a suite error.
execFileSync(process.execPath, [path.join(ROOT, 'build.js')], { cwd: ROOT, stdio: 'pipe' });

// The reader the other suites use finds the end of a declaration by looking for
// the next `}` in column 0. That works on the source and does not work here:
// build.js removes the indentation along with the comments it was laying out, so
// in dist/index.html every closing brace is in column 0, including the ones that
// close an `if` three levels inside a function. The first suite draft lifted a
// third of isKnownMultisigSelector and reported a syntax error.
//
// So this one grows the span a line at a time and asks V8 whether it has a whole
// program yet. That is not a heuristic about braces — it is the same parser that
// will run the file, which is the only thing that can be right about where a
// declaration ends in a file whose layout is not ours. Any syntax error that is
// NOT "unexpected end of input" means the span is complete and genuinely broken;
// it is returned so it fails where the failure can be read, rather than being
// grown until it swallows the rest of the file.
//
// Applied to both files, so the comparison below is never between two different
// ideas of where a function starts and stops.
const MAX_SPAN = 400;
function reader(file, label) {
  const LINES = fs.readFileSync(file, 'utf8').split('\n');
  const whole = (text) => {
    try { new vm.Script(text); return true; }
    catch (e) { return !/Unexpected end of input/.test(e.message); }
  };
  return function grab(name) {
    let start = LINES.findIndex(l =>
      ['const', 'let'].some(kw => l.startsWith(`${kw} ${name} `) || l.startsWith(`${kw} ${name}=`)));
    if (start === -1) {
      start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
    }
    if (start === -1) throw new Error(`dist.test.js: '${name}' is not in ${label} — it was renamed, removed, or the build lost it.`);
    let text = LINES[start];
    for (let end = start + 1; !whole(text); end++) {
      if (end - start > MAX_SPAN || end >= LINES.length) {
        throw new Error(`dist.test.js: '${name}' in ${label} does not close within ${MAX_SPAN} lines.`);
      }
      text += '\n' + LINES[end];
    }
    return text;
  };
}

const NEEDED = [
  'FACTORY', 'IMPLEMENTATION', 'TIMELOCK_EXECUTOR', 'WSTETH_ADDRESS',
  'WEINS', 'WNS_ID_REGISTRAR', 'WNS_ID_PARENT', 'WNS_ID_SUFFIX',
  'MAX_SAFE_THRESHOLD', 'DELAY_SANE_MAX',
  'MULTISIG_ABI', 'msIface', 'TIMELOCK_EXECUTOR_ABI', 'tlIface',
  'ERC20_ABI', 'erc20Iface', 'SLOW_ABI', 'slowIface',
  'WEINS_ABI', 'weinsIface', 'wnsRegIface',
  'SEL', 'SEL_RE', 'selOf',
  '_ESC', '_escOne', 'esc', 'jstr', 'DECIMALS', 'stripCommas',
  'weiStr', 'bigOr0', 'toUnits', '_amtTrim', '_amtDisp', 'groupInt', 'fmtBal',
  'shortAddr', 'fmtD', 'fmtDelay', 'toSec', 'fromSec',
  'asciiLower', 'wnsSubId', 'wnsFullName', 'WNS_LABEL_RE', 'WNS_LABEL_MAX',
  'wnsLabelValid', 'wnsIdentityBatch',
  'isStakeCall', 'isGuardHookAddr', 'executorRisk', 'fastPathVoidsTimelock',
  'NO_WITHDRAWAL', 'lockedDest', '_msSelectors', 'isKnownMultisigSelector',
  'SELECTOR_LABELS', 'selectorToLabel',
  'txKind', 'isCancelTx', 'nextNonce', 'POLICY_SELECTORS', 'pendingPolicyChanges',
  'EIP712_DOMAIN', 'EIP712_TYPES',
  'senderSlot', 'sigSlot', 'pickSigs', 'packSigs', 'senderSig',
];

function load(file, label) {
  const grab = reader(file, label);
  const sandbox = {
    console: { ...console, warn() {}, error() {} },
    S: { demoMode: false, chainId: 1 },
    provider: null,
    TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
    crypto: globalThis.crypto,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // The bundle the page loads, from beside the file under test — so the built
  // copy is exercised against the built library, exactly as the browser gets it.
  vm.runInContext(fs.readFileSync(path.join(path.dirname(file), 'ethers.slim.min.js'), 'utf8'), sandbox);
  const handOut = NEEDED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n');
  vm.runInContext(NEEDED.map(grab).join('\n') + '\n' + handOut, sandbox);
  for (const n of NEEDED) {
    if (sandbox[n] === undefined) throw new Error(`dist.test.js: '${n}' lifted as undefined from ${label}.`);
  }
  return sandbox;
}

const src = load(path.join(DAPP, 'index.html'), 'dapp/index.html');
const out = load(path.join(DIST, 'index.html'), 'dist/index.html');

const VAULT = '0x9999999999999999999999999999999999999999';
const ALICE = '0x2222222222222222222222222222222222222222';
const BOB = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const MARKED = '0x1111' + '22'.repeat(18);

// Built once against the source's interfaces. Both copies decode the same bytes,
// which is the point — if the built copy's ABI differed, it would decode these
// differently or not at all, and that is the failure this is looking for.
const ms = (fn, args) => src.msIface.encodeFunctionData(fn, args);
const vault = o => Object.assign({
  address: VAULT, ownerCount: 3, threshold: 2, delay: 86400,
  executor: '0x00000000a72A30AdBf38e14d36BCE2610ec3973F', fastPath: false, queue: [],
}, o);
const prop = o => Object.assign({ target: ALICE, rawValue: '0', callData: '0x', nonce: 7 }, o);

// Every call is run against both copies and the answers compared. A case is
// added here rather than as a test of its own so that the battery grows with
// the classifier instead of alongside it.
const CASES = [
  // ── the classifier, over the states a queue card can be in ──
  ['txKind', [prop({ rawValue: '1000000000000000000' }), vault()]],
  ['txKind', [prop({ target: VAULT }), vault()]],
  ['txKind', [prop({ target: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', rawValue: '5' }), vault()]],
  ['txKind', [prop({ target: '0x000000000e8CB9ed9DC2114d79d9215eacb9cB07', rawValue: '1' }), vault()]],
  ['txKind', [prop({ target: TOKEN, callData: src.erc20Iface.encodeFunctionData('transfer', [BOB, 1n]) }), vault()]],
  ['txKind', [prop({ target: TOKEN, callData: src.erc20Iface.encodeFunctionData('approve', [BOB, 2n ** 256n - 1n]) }), vault()]],
  ['txKind', [prop({ target: VAULT, callData: ms('addOwner', [BOB]) }), vault()]],
  ['txKind', [prop({ target: VAULT, callData: ms('removeOwner', [ALICE, BOB]) }), vault({ ownerCount: 2 })]],
  ['txKind', [prop({ target: VAULT, callData: ms('setThreshold', [1]) }), vault()]],
  ['txKind', [prop({ target: VAULT, callData: ms('setDelay', [0]) }), vault()]],
  ['txKind', [prop({ target: VAULT, callData: ms('setDelay', [40 * 86400]) }), vault()]],
  ['txKind', [prop({ target: MARKED, callData: ms('setExecutor', [MARKED]) }), vault({ address: MARKED })]],
  ['txKind', [prop({ target: VAULT, callData: ms('setExecutor', [VAULT]) }), vault()]],
  ['txKind', [prop({ target: VAULT, callData: ms('setExecutor', ['0x' + '00'.repeat(20)]) }), vault()]],
  ['txKind', [prop({ target: VAULT, callData: ms('cancelQueued', ['0x' + 'ab'.repeat(32)]) }),
              vault({ queue: [{ nonce: 4, txHash: '0x' + 'ab'.repeat(32) }] })]],
  ['txKind', [prop({ target: VAULT, callData: ms('executeQueued', [ALICE, 0n, '0x', 9]) }), vault()]],
  ['txKind', [prop({ target: VAULT, callData: ms('delegateCall', [BOB, '0x1234']) }), vault()]],
  ['txKind', [prop({ target: VAULT, callData: ms('batch', [[ALICE, BOB], [1n, 0n], ['0x', '0xdeadbeef']]) }), vault()]],
  ['txKind', [prop({ target: VAULT, callData: '0xdeadbeef', nonce: 12 }), vault()]],
  ['txKind', [prop({ target: BOB, callData: '0xdeadbeef' }), vault()]],
  ['txKind', [prop({ target: '0x53745292f0d30d68204a63002C17bDa16C772bf7',
                     callData: src.wnsRegIface.encodeFunctionData('register', [BigInt(src.WNS_ID_PARENT), 'alice']) }), vault()]],
  ['txKind', [prop({ target: '0x53745292f0d30d68204a63002C17bDa16C772bf7',
                     callData: src.wnsRegIface.encodeFunctionData('register', [1234n, 'alice']) }), vault()]],
  ['txKind', [prop({ callData: '0xzz' }), vault()]],
  ['txKind', [prop({ rawValue: '1.5' }), vault()]],

  // ── the parsing that stands in front of BigInt() ──
  ...['0', '007', '  5  ', '1.5', '-1', '1e40', 'abc', '', null, undefined, (2n ** 255n).toString()]
    .map(v => ['weiStr', [v]]),
  ...['1.5', '-1', null, '12', '1000000000000000000'].map(v => ['bigOr0', [v]]),
  ...[['1', 18], ['1', 6], ['1.9999999', 6], ['1,000', 18], ['1.2.3', 18], ['', 18], ['-1', 18]]
    .map(a => ['toUnits', a]),

  // ── escaping, at both sinks ──
  ...[`&<>"'`, '&lt;', '<script>alert(1)</script>', `x'); alert(1); //`, `x\\'); alert(1); //`, null, 0]
    .flatMap(s => [['esc', [s]], ['jstr', [s]]]),

  // ── the guards ──
  ...['0x1111' + '00'.repeat(18), '0x' + '00'.repeat(18) + '1111', ALICE, 'nope']
    .map(a => ['isGuardHookAddr', [a]]),
  ...[[MARKED, MARKED], [VAULT, VAULT], [MARKED, VAULT], [ALICE, BOB]].map(a => ['executorRisk', a]),
  ...['0x000000000e8CB9ed9DC2114d79d9215eacb9cB07', '0x' + '00'.repeat(20), ALICE, undefined]
    .map(a => ['lockedDest', [a]]),
  ['fastPathVoidsTimelock', [{ delay: 86400, ownerCount: 3, threshold: 3 }]],
  ['fastPathVoidsTimelock', [{ delay: 86400, ownerCount: 3, threshold: 2 }]],

  // ── the slots the contract reads ──
  ['senderSlot', [ALICE]],
  ['senderSig', [ALICE]],
  ['sigSlot', [{ signer: ALICE, sigType: 'approval', sig: '0xdeadbeef' }]],
  ['sigSlot', [{ signer: ALICE, sig: '0x' + 'ab'.repeat(65) }]],
  ['packSigs', [[{ signer: ALICE, sig: '0x' + 'ab'.repeat(65) }, { signer: BOB, sig: '0x' + 'cd'.repeat(65) }]]],
  ['pickSigs', [[{ signer: BOB }, { signer: ALICE }, { signer: VAULT }], 2, VAULT]],

  // ── display ──
  ...[[1n, 18], [999999999999n, 18], [0n, 18], [1234567n * 10n ** 18n, 18], [1500000n, 6]]
    .map(a => ['fmtBal', a]),
  ...[86400, 3600, 1800, 5400, 0].flatMap(s => [['fmtD', [s]], ['fmtDelay', [s]], ['fromSec', [s]]]),
  ...['0x1234567890123456789012345678901234567890', 'alice.eth', null].map(a => ['shortAddr', [a]]),
  ...Object.values(src.SEL).map(s => ['selectorToLabel', [s + '00'.repeat(32)]]),
  ['selectorToLabel', ['0x']],
  ['selectorToLabel', ['0xdeadbeef']],
  ['nextNonce', [{ nonce: 3, queue: [{ nonce: 3 }, { nonce: 5 }] }]],
  ['isCancelTx', [prop({ target: VAULT, callData: ms('cancelQueued', ['0x' + 'ab'.repeat(32)]) }), vault()]],
];

// Compared as text, because these answers are objects holding strings, BigInts
// and undefined — none of which survive JSON, and all of which differ visibly.
const show = v => require('node:util').inspect(v, { depth: 8, sorted: true, breakLength: Infinity });
const call = (ctx, fn, args) => {
  try { return show(ctx[fn](...args)); } catch (e) { return `threw: ${e.message}`; }
};

test('the built dapp answers exactly as the source does, on every case the suites cover', () => {
  const diffs = [];
  for (const [fn, args] of CASES) {
    const a = call(src, fn, args), b = call(out, fn, args);
    if (a !== b) diffs.push(`${fn}(${args.map(x => show(x).slice(0, 60)).join(', ')})\n  dapp: ${a}\n  dist: ${b}`);
  }
  assert.deepEqual(diffs, [], `the build changed the program:\n\n${diffs.join('\n\n')}`);
});

test('the build carries every declaration the source makes at the top level', () => {
  // build.js removes comment spans and the whitespace that laid them out, and a
  // declaration that disappeared on the way is a ReferenceError the moment the
  // page reaches it — which for most of this file means the first render, and a
  // blank page. The battery above covers seventy of these; this covers all of
  // them, by name.
  //
  // Only in that direction. The built file is dedented, so a `const` nested
  // three levels inside a function now begins in column 0 too and is
  // indistinguishable, by line, from a top-level one. "The build declared
  // something the source did not" cannot be asked this way and is not asked.
  const topLevel = (f) => {
    const names = new Set();
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)
        || line.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=;]/);
      if (m) names.add(m[1]);
    }
    return names;
  };
  const source = topLevel(path.join(DAPP, 'index.html'));
  assert.ok(source.size > 400, `only ${source.size} declarations found in the source — the reader stopped matching`);
  const built = topLevel(path.join(DIST, 'index.html'));
  assert.deepEqual([...source].filter(n => !built.has(n)), [], 'the build dropped a declaration the source makes');
});

test('the vendored libraries are copied, not processed', () => {
  // These are already minified and are not this project's code. A build that
  // rewrote them would be rewriting the signing library, which is the one thing
  // in the tree that must arrive byte-for-byte.
  for (const f of ['ethers.slim.min.js', 'walletconnect.min.js', 'coinbase.min.js']) {
    assert.deepEqual(
      fs.readFileSync(path.join(DIST, f)), fs.readFileSync(path.join(DAPP, f)),
      `${f} differs between dapp/ and dist/`);
  }
});

test('every file the deployed pages ask for is in the directory that gets deployed', () => {
  // A page that references an asset the build did not copy is a 404 in
  // production and nothing at all in development, where dapp/ is served whole.
  const pages = ['index.html', 'docs.html', 'brand.html'];
  const missing = [];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(DIST, page), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="\.\/([^"?#]+)/g)) {
      if (!fs.existsSync(path.join(DIST, m[1]))) missing.push(`${page} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'the deployed pages reference files the build did not produce');
});

test('the content security policy survives the build, character for character', () => {
  // The CSP is a <meta> tag inside the HTML the build rewrites, and it is the
  // only thing naming which hosts this page may talk to. A connect-src that lost
  // an entry is an RPC that silently stops answering in production and works
  // everywhere else; one that gained a wildcard is worse.
  const csp = f => (fs.readFileSync(f, 'utf8').match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1];
  for (const page of ['index.html', 'docs.html', 'brand.html']) {
    const a = csp(path.join(DAPP, page));
    assert.ok(a, `${page} carries no CSP meta tag`);
    assert.equal(csp(path.join(DIST, page)), a, `the build changed ${page}'s CSP`);
  }
});
