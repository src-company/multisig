// The chain tables, and the agreement between them.
//
//   node --test              (from the repo root; discovers every suite)
//
// Multichain support in this app is not one table, it is eight of them keyed by
// the same chain id — CHAINS, ADD_CHAIN_PARAMS, NETS, CHAIN_ICONS, PROD_TOKENS,
// CHAINLINK_FEEDS, SLOW_CHAINS — plus a connect-src in a <meta> tag naming the
// hosts the page is allowed to reach. Adding a chain means writing the same id
// into several of them, and every failure in this file is a row that landed in
// one and not another. None of it is caught by anything else here: the other
// suites lift functions and check answers, and a chain that is simply absent
// from a table has no answer to be wrong.
//
// Each block below is a defect that was live, written as the thing that must now
// be true instead.
//
//   connect-src            Sepolia's third RPC was dRPC, whose free tier refuses
//                          the chain outright — every method, including the
//                          handshake. Replacing it exposed the real gap: nothing
//                          checked that an RPC host is one the CSP permits, so a
//                          new backend is reachable in every test and blocked in
//                          the browser, which is the one place it matters.
//
//   EIP-55 checksums       A mixed-case address whose checksum does not verify
//                          throws at encode time, and both tables are encoded
//                          into a single aggregate3() per chain — so one bad
//                          constant does not hide one row, it blanks every
//                          holding on that chain. That shipped twice (MegaETH's
//                          USDT0 and wstETH, Arbitrum's ETH feed) and each time
//                          looked like an empty treasury rather than an error.
//
//   hex vs. key            CHAINS[id].hex is what a wallet is asked to switch
//                          to. A hex that decodes to a different number than the
//                          key it sits under sends the operator to another chain
//                          and reads the vault on this one.
//
//   table agreement        A chain in CHAINS but not NETS cannot be selected; in
//                          NETS but not CHAINS has no RPC; missing from
//                          ADD_CHAIN_PARAMS cannot be added to a wallet that
//                          does not already know it — which, for MegaETH and
//                          Robinhood, is every wallet.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'dapp', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

// Same lift as the other suites: the dapp is one HTML file with its script
// inline, so pull declarations out by name. A missing name throws rather than
// returning nothing, so a rename fails the suite instead of quietly deleting its
// coverage.
function grab(name) {
  const re = new RegExp(`^(const|let|var|function)\\s+${name}\\b`);
  const start = LINES.findIndex(l => re.test(l));
  if (start === -1) throw new Error(`chains.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  // A one-line declaration with no braces at all — `new Set([...]);`.
  if (opens === 0 && /;\s*$/.test(LINES[start])) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`chains.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const NEEDED = ['CHAINS', 'ADD_CHAIN_PARAMS', 'NETS', 'CHAIN_ICONS', 'PROD_TOKENS', 'CHAINLINK_FEEDS', 'SLOW_CHAINS'];

const sandbox = { console: { ...console, warn() {}, error() {} } };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'dapp', 'ethers.slim.min.js'), 'utf8'), sandbox);
// The icons are presentation and are defined far from the tables that name
// them. Stubbed so the tables can be lifted without dragging in every SVG.
for (const n of ['ETH_ICON', 'USDC_ICON', 'USDT_ICON', 'DAI_ICON', 'WBTC_ICON', 'WSTETH_ICON',
  'CBBTC_ICON', 'MEGA_ICON', 'USDM_ICON', 'USDG_ICON', 'USDE_ICON', 'BASE_LOGO', 'OP_LOGO',
  'ARB_LOGO', 'MEGA_LOGO', 'ROBINHOOD_LOGO']) {
  vm.runInContext(`globalThis[${JSON.stringify(n)}] = '';`, sandbox);
}
vm.runInContext('globalThis.equityIcon = () => "";', sandbox);
vm.runInContext(NEEDED.map(grab).join('\n') + '\n' + NEEDED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n'), sandbox);
for (const n of NEEDED) {
  if (sandbox[n] === undefined) throw new Error(`chains.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}

const { ethers, CHAINS, ADD_CHAIN_PARAMS, NETS, CHAIN_ICONS, PROD_TOKENS, CHAINLINK_FEEDS, SLOW_CHAINS } = sandbox;
const IDS = Object.keys(CHAINS).map(Number);

// ── the CSP is part of the chain config ───────────────────────────

test('every RPC the app dials is a host the CSP allows', () => {
  const csp = (SRC.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1];
  assert.ok(csp, 'index.html carries no CSP meta tag');
  const connect = (csp.split(';').find(d => d.trim().startsWith('connect-src')) || '').trim();
  assert.ok(connect, 'the CSP has no connect-src, so every fetch on the page is governed by default-src');

  const sources = connect.split(/\s+/).slice(1).filter(s => /^https?:\/\//.test(s));
  // A CSP host-source with no path matches any path on that host, and a leading
  // `*.` matches one or more leading labels — but never the bare domain.
  const allowed = host => sources.some(s => {
    const h = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    return h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h;
  });

  const missing = [];
  for (const id of IDS) {
    for (const url of CHAINS[id].rpcs) {
      const host = new URL(url).host;
      if (!allowed(host)) missing.push(`chain ${id} (${CHAINS[id].name}) dials ${host}`);
    }
  }
  // ADD_CHAIN_PARAMS is deliberately not checked: those URLs are handed to the
  // wallet through wallet_addEthereumChain and are dialled by the wallet, not by
  // this page, so connect-src has no say over them.
  assert.deepEqual(missing, [], 'these RPCs are configured but blocked by connect-src — they answer in every test and fail in the browser');
});

test('every chain carries more than one RPC, so one bad backend is not the chain', () => {
  // makeProvider builds a FallbackProvider only when a chain has more than one
  // backend, and ethers marks a backend fatally the first time its
  // getBlockNumber throws and never clears it. A single-RPC chain is one blip
  // away from being gone for the rest of the page session.
  for (const id of IDS) {
    assert.ok(CHAINS[id].rpcs.length >= 2, `chain ${id} (${CHAINS[id].name}) has ${CHAINS[id].rpcs.length} RPC(s)`);
    assert.equal(new Set(CHAINS[id].rpcs).size, CHAINS[id].rpcs.length, `chain ${id} lists the same RPC twice, which is one backend wearing two priorities`);
  }
});

// ── the id a wallet is asked to switch to ─────────────────────────

test('each chain hex decodes to the key it is filed under', () => {
  for (const id of IDS) {
    assert.equal(parseInt(CHAINS[id].hex, 16), id, `CHAINS[${id}].hex is ${CHAINS[id].hex}`);
  }
  for (const id of Object.keys(ADD_CHAIN_PARAMS).map(Number)) {
    assert.equal(parseInt(ADD_CHAIN_PARAMS[id].chainId, 16), id, `ADD_CHAIN_PARAMS[${id}].chainId is ${ADD_CHAIN_PARAMS[id].chainId}`);
    assert.equal(ADD_CHAIN_PARAMS[id].chainId, CHAINS[id] && CHAINS[id].hex, `ADD_CHAIN_PARAMS[${id}] and CHAINS[${id}] disagree on the hex chain id`);
  }
});

test('a chain a wallet is asked to add points at the explorer the app links to', () => {
  for (const id of Object.keys(ADD_CHAIN_PARAMS).map(Number)) {
    const a = ADD_CHAIN_PARAMS[id];
    assert.ok(CHAINS[id], `ADD_CHAIN_PARAMS[${id}] describes a chain that is not in CHAINS`);
    assert.ok(a.rpcUrls && a.rpcUrls.length, `ADD_CHAIN_PARAMS[${id}] hands the wallet no RPC`);
    assert.ok(a.blockExplorerUrls.includes(CHAINS[id].explorer),
      `ADD_CHAIN_PARAMS[${id}] would teach the wallet ${a.blockExplorerUrls} while the app links to ${CHAINS[id].explorer}`);
    assert.equal(a.nativeCurrency.decimals, 18, `ADD_CHAIN_PARAMS[${id}] native currency is not 18 decimals`);
  }
});

// ── one chain, every table ────────────────────────────────────────

test('every configured chain can be reached from the network switcher, and back', () => {
  const netIds = new Set(NETS.map(n => n.id));
  for (const id of IDS) assert.ok(netIds.has(id), `chain ${id} (${CHAINS[id].name}) is configured but absent from NETS, so it cannot be selected`);
  for (const n of NETS) assert.ok(CHAINS[n.id], `NETS offers "${n.name}" (${n.id}) which has no CHAINS entry, so selecting it has no RPC`);
  assert.equal(new Set(NETS.map(n => n.id)).size, NETS.length, 'NETS lists a chain id twice');
});

test('every configured chain has an icon and a way into a wallet that does not know it', () => {
  for (const id of IDS) {
    assert.ok(id in CHAIN_ICONS, `chain ${id} (${CHAINS[id].name}) has no CHAIN_ICONS entry`);
    // Mainnet is the one chain every wallet already ships with.
    if (id !== 1) assert.ok(ADD_CHAIN_PARAMS[id], `chain ${id} (${CHAINS[id].name}) has no ADD_CHAIN_PARAMS`);
  }
});

test('SLOW is only claimed on chains the app is configured for', () => {
  for (const id of SLOW_CHAINS) assert.ok(CHAINS[id], `SLOW_CHAINS names chain ${id}, which is not configured`);
});

// ── the tables an amount is denominated in ────────────────────────

test('every token list leads with the native asset and names each symbol once', () => {
  for (const id of Object.keys(PROD_TOKENS).map(Number)) {
    const list = PROD_TOKENS[id];
    assert.ok(CHAINS[id], `PROD_TOKENS[${id}] is a chain that is not configured`);
    assert.equal(list[0].address, ethers.ZeroAddress, `PROD_TOKENS[${id}] does not lead with the native asset`);
    const syms = list.map(t => t.symbol);
    assert.equal(new Set(syms).size, syms.length, `PROD_TOKENS[${id}] lists a symbol twice: ${syms}`);
    const addrs = list.map(t => t.address.toLowerCase());
    assert.equal(new Set(addrs).size, addrs.length, `PROD_TOKENS[${id}] lists an address twice`);
    for (const t of list) {
      // decimals is the half of a token row that silently destroys an amount
      // when it is wrong, so it is asserted as a whole number in range rather
      // than merely present.
      assert.ok(Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 18,
        `PROD_TOKENS[${id}] ${t.symbol} has decimals=${t.decimals}`);
    }
  }
});

test('every price feed prices something that chain actually lists', () => {
  for (const id of Object.keys(CHAINLINK_FEEDS).map(Number)) {
    assert.ok(CHAINS[id], `CHAINLINK_FEEDS[${id}] is a chain that is not configured`);
    const syms = new Set((PROD_TOKENS[id] || []).map(t => t.symbol));
    for (const sym of Object.keys(CHAINLINK_FEEDS[id])) {
      assert.ok(syms.has(sym), `CHAINLINK_FEEDS[${id}] prices ${sym}, which is not in PROD_TOKENS[${id}]`);
    }
  }
});

test('every address in both tables is EIP-55 as ethers spells it', () => {
  // Not cosmetic, and not left to the runtime canonicaliser: these strings are
  // encoded as `address` arguments in one aggregate3() per chain, so a single
  // mis-cased constant throws before the call is made and blanks every holding
  // on that chain. The load-time fixer turns that into a console warning nobody
  // reads; this turns it into a failure before it ships.
  const bad = [];
  const check = (addr, where) => {
    let ok = false;
    try { ok = ethers.getAddress(addr) === addr; } catch (_) {}
    if (!ok) bad.push(`${where}: ${addr} should be ${ethers.getAddress(addr.toLowerCase())}`);
  };
  for (const id of Object.keys(PROD_TOKENS).map(Number)) {
    for (const t of PROD_TOKENS[id]) {
      if (t.address === ethers.ZeroAddress) continue;
      check(t.address, `PROD_TOKENS[${id}] ${t.symbol}`);
    }
  }
  for (const id of Object.keys(CHAINLINK_FEEDS).map(Number)) {
    for (const [sym, addr] of Object.entries(CHAINLINK_FEEDS[id])) check(addr, `CHAINLINK_FEEDS[${id}] ${sym}`);
  }
  assert.deepEqual(bad, [], 'these constants throw at encode time and take the whole chain\'s balance read with them');
});

// ── how fast the interface thinks each chain is ───────────────────

test('every chain states a block time, and it is a plausible one', () => {
  for (const id of IDS) {
    const ms = CHAINS[id].blockMs;
    assert.ok(Number.isFinite(ms) && ms > 0 && ms <= 12000,
      `CHAINS[${id}] (${CHAINS[id].name}) has blockMs=${ms}; chainPollMs floors at 1s and caps at 12s, so anything outside that is either a typo or a chain this app cannot pace`);
  }
});
