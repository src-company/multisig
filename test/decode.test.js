// The link that hands a payload to an external decoder.
//
//   node --test              (from the repo root; discovers every suite)
//
// Same shape as the suites beside it: the dapp is one HTML file with its script
// inline, so this reads that file, pulls declarations out by name into a
// sandbox, and stubs only what they will not run without. A missing name throws
// rather than returning nothing, so a rename fails the suite instead of quietly
// deleting its coverage.
//
// Why this one is worth asserting. txKind() names the calls this interface
// knows and says so plainly when it does not — and for everything it does not,
// this URL is the only remaining answer to "what does this actually do". Two
// ways for it to be worse than nothing:
//
//   It can be wrong. An address on the wrong chain, a truncated payload, a
//   chainId that came from the connected wallet rather than the vault: each
//   produces a decode that looks authoritative and describes a different call
//   than the one being signed. A signer reading it would be misled by this
//   interface, which is the failure this whole app is built against.
//
//   It can leak. Everything on the far side of it is a third party, so what
//   goes into the query string is a decision, not a detail — the payload,
//   because the signer asked for it, and nothing else that was not asked for.
//
// So: the exact string, for the exact inputs, including the case where half of
// them are missing because the person is still typing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dapp', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

// A `const NAME = ...` one-liner, or a `function NAME(...)` closed by a brace in
// column 0. Kept identical to the other suites on purpose: copies of a nine-line
// reader are cheaper than a shared module in a repo that deliberately has no
// build step, and the day they diverge, they diverge loudly.
function grab(name) {
  const asConst = LINES.findIndex(l => l.startsWith(`const ${name} `) || l.startsWith(`const ${name}=`));
  if (asConst !== -1) return LINES[asConst];
  const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`decode.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  if (end >= LINES.length) throw new Error(`decode.test.js: no closing brace found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const NEEDED = ['SWISSKNIFE_DECODER', 'DECODE_TITLE', 'swissKnifeUrl', 'decoderChainId', 'txDecodeLink'];

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// isAddress accepts either case, the way ethers does — a signer pastes whatever
// their explorer handed them. getAddress is stubbed to the one pair of forms
// these tests move between rather than to a vendored keccak: what lives in this
// file is that the call is made at all, not EIP-55 itself.
const sandbox = {
  console,
  // A browser global the sandbox does not get for free, and the one doing the
  // escaping in the URL under test — so it is handed over rather than replaced.
  URLSearchParams,
  S: { demoMode: false, chainId: 1, sel: 0, vaults: [] },
  esc,
  ethers: {
    isAddress: a => /^0x[0-9a-fA-F]{40}$/.test(a || ''),
    getAddress: a => WSTETH_LOWER === a ? WSTETH : (LIDO_WQ_LOWER === a ? LIDO_WQ : a),
  },
  chainIdOfName: name => ({ ETHEREUM: 1, BASE: 8453, ARBITRUM: 42161 }[name] || 1),
};
vm.createContext(sandbox);

// The two addresses these tests move between cases, in both forms. Declared
// before the lift so the getAddress stub above closes over something real.
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
const WSTETH_LOWER = WSTETH.toLowerCase();
const LIDO_WQ = '0xD54cb65224410F3Ff97a8E72f363f224419f4FB0';
const LIDO_WQ_LOWER = LIDO_WQ.toLowerCase();

const handOut = NEEDED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n');
vm.runInContext(NEEDED.map(grab).join('\n') + '\n' + handOut, sandbox);
for (const n of NEEDED) {
  if (sandbox[n] === undefined) throw new Error(`decode.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);
}
const { SWISSKNIFE_DECODER, swissKnifeUrl, decoderChainId, txDecodeLink } = sandbox;

// A real multicall — the shape the decoder earns its place on, because this
// interface reads it as one opaque CALL 0xac9650d8 and can say nothing about
// either of the two calls inside it. Truncated in the middle: what is asserted
// is that the bytes arrive unaltered, and 4 KB of them proves that no better
// than 200 does.
const MULTICALL = '0xac9650d8'
  + '0000000000000000000000000000000000000000000000000000000000000020'
  + '0000000000000000000000000000000000000000000000000000000000000002'
  + '0000000000000000000000000000000000000000000000000000000000000040'
  + '0000000000000000000000000000000000000000000000000000000000000200';

const TRANSFER = '0xa9059cbb'
  + '0000000000000000000000001111111111111111111111111111111111111111'
  + '0000000000000000000000000000000000000000000000000de0b6b3a7640000';

// ── the URL ───────────────────────────────────────────────────────

test('a payload, a target and a chain go out as the three documented parameters', () => {
  assert.strictEqual(
    swissKnifeUrl(MULTICALL, LIDO_WQ, 1),
    `${SWISSKNIFE_DECODER}?calldata=${MULTICALL}&address=${LIDO_WQ}&chainId=1`
  );
});

test('the payload goes out byte for byte, with nothing appended and nothing trimmed', () => {
  const url = new URL(swissKnifeUrl(MULTICALL, LIDO_WQ, 1));
  assert.strictEqual(url.searchParams.get('calldata'), MULTICALL);
});

test('nothing but those three parameters is sent to a third party', () => {
  const url = new URL(swissKnifeUrl(MULTICALL, LIDO_WQ, 1));
  assert.deepStrictEqual([...url.searchParams.keys()].sort(), ['address', 'calldata', 'chainId']);
  assert.strictEqual(url.origin + url.pathname, SWISSKNIFE_DECODER);
});

test('surrounding whitespace on a pasted payload is not part of the payload', () => {
  const url = new URL(swissKnifeUrl(`\n  ${TRANSFER}  `, '', 1));
  assert.strictEqual(url.searchParams.get('calldata'), TRANSFER);
});

// ── the half-typed cases, which are most of the builder's life ────

test('a payload with no target still decodes — the address is a hint, not a requirement', () => {
  assert.strictEqual(
    swissKnifeUrl(MULTICALL, '', 1),
    `${SWISSKNIFE_DECODER}?calldata=${MULTICALL}&chainId=1`
  );
});

test('a target that is not yet an address is left out rather than sent as garbage', () => {
  for (const notYet of ['0x7f39C5', 'treasury.eth', '0x', 'wsteth', null, undefined]) {
    const url = swissKnifeUrl(TRANSFER, notYet, 1);
    assert.ok(!url.includes('address='), `sent an address parameter for ${String(notYet)}`);
  }
});

test('a shortened address — what the target field shows once it loses focus — is not an address', () => {
  const url = swissKnifeUrl(TRANSFER, '0x7f39…2Ca0', 1);
  assert.ok(!url.includes('address='));
});

test('an unknown chain is left out rather than defaulting to mainnet', () => {
  for (const nope of [0, undefined, null, NaN, '', 'ethereum']) {
    const url = swissKnifeUrl(TRANSFER, LIDO_WQ, nope);
    assert.ok(!url.includes('chainId='), `sent a chainId for ${String(nope)}`);
  }
});

test('a lowercase address is checksummed on the way out', () => {
  // ethers.getAddress does this for real; the stub above only proves the call
  // is made, which is the part that lives in this file.
  const url = new URL(swissKnifeUrl(TRANSFER, WSTETH_LOWER, 1));
  assert.strictEqual(url.searchParams.get('address'), WSTETH);
});

// ── what is not calldata at all ───────────────────────────────────

test('there is no link for a payload that carries no selector', () => {
  for (const empty of ['0x', '', '   ', '0xa9059c', null, undefined, 0, {}]) {
    assert.strictEqual(swissKnifeUrl(empty, LIDO_WQ, 1), '', `built a link for ${JSON.stringify(empty)}`);
  }
});

test('there is no link for something that is not hex, or is hex of an impossible length', () => {
  assert.strictEqual(swissKnifeUrl('0xa9059cbb0000zz', LIDO_WQ, 1), '');
  assert.strictEqual(swissKnifeUrl('a9059cbb00000000', LIDO_WQ, 1), '');
  assert.strictEqual(swissKnifeUrl(TRANSFER + 'a', LIDO_WQ, 1), '');
});

// ── which chain's ABIs to read ────────────────────────────────────

test('production reads the connected chain, which is the one the proposal executes on', () => {
  sandbox.S.demoMode = false;
  sandbox.S.chainId = 8453;
  assert.strictEqual(decoderChainId({ chain: 'ETHEREUM' }), 8453);
  sandbox.S.chainId = 1;
});

test('a demo vault has a chain name and no connection, so the name is what answers', () => {
  sandbox.S.demoMode = true;
  sandbox.S.chainId = 1;
  assert.strictEqual(decoderChainId({ chain: 'ARBITRUM' }), 42161);
  assert.strictEqual(decoderChainId({ chain: 'BASE' }), 8453);
  assert.strictEqual(decoderChainId(undefined), 0);
  sandbox.S.demoMode = false;
});

// ── the link on a posted proposal ─────────────────────────────────

test('a proposal with a payload gets a decoder link built from its own bytes and target', () => {
  const html = txDecodeLink({ callData: MULTICALL, target: LIDO_WQ }, { chain: 'ETHEREUM' });
  assert.ok(html.includes(`href="${SWISSKNIFE_DECODER}?calldata=${MULTICALL}&amp;address=${LIDO_WQ}&amp;chainId=1"`), html);
  assert.ok(html.includes('DECODE'));
});

test('a plain ETH transfer offers nothing to decode, so no link is drawn', () => {
  assert.strictEqual(txDecodeLink({ callData: '0x', target: LIDO_WQ }, {}), '');
  assert.strictEqual(txDecodeLink({ target: LIDO_WQ }, {}), '');
});

test('the link opens away from this page and takes no handle on it, and no referrer', () => {
  const html = txDecodeLink({ callData: TRANSFER, target: WSTETH }, {});
  assert.ok(html.includes('target="_blank"'), html);
  assert.ok(/rel="noopener noreferrer"/.test(html), html);
});

test('the ampersands in the href are escaped, because it is written into markup', () => {
  const href = txDecodeLink({ callData: TRANSFER, target: WSTETH }, {}).match(/href="([^"]*)"/)[1];
  assert.ok(!/&(?!amp;)/.test(href), href);
});

// A proposal row is anon-writable — the coordination record holds what somebody
// posted to it, and this interface reads it before the chain has agreed with a
// word of it. An href is a markup context and a URL context at once, so a row
// that carries a quote and a tag must not be able to close either.
test('a proposal row cannot break out of the attribute it is written into', () => {
  const html = txDecodeLink({
    callData: '0xa9059cbb" onmouseover="alert(1)',
    target: '" onclick="alert(1)',
  }, {});
  assert.strictEqual(html, '');

  const withTail = txDecodeLink({ callData: TRANSFER, target: '"><script>alert(1)</script>' }, {});
  assert.ok(!withTail.includes('<script'), withTail);
  assert.ok(!/href="[^"]*"[^>]*onmouseover/.test(withTail), withTail);
});
