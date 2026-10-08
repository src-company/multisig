// Getting in: the read session, and the one provider the connect path builds.
//
//   node --test              (from the repo root; discovers every suite)
//
// Two things the operator experiences as "logging in is flaky", and neither of
// them was a wallet being flaky.
//
// The read session is the half nobody sees. The `signature` column is granted to
// `reader` and withheld from `anon` (db/roles.sql), so the bytes only come back
// to a client holding a token minted by api/proposals.cjs against an EIP-712
// Session signature. Without one, verifySigs has nothing to recover an address
// from, and loadVaultQueue's hide-check reads "no signature verified" as "nobody
// signed this" and drops every proposal the vault is not already holding queued
// — which is every proposal still collecting signatures. So whether a token is
// held decides whether the queue has anything in it, and the rules about when to
// ask for one, when to stop asking, and who the answer belongs to are load-
// bearing rather than cosmetic. They are what this file pins.
//
// The provider is the half everybody sees. getWalletConnectProvider is reached
// by two callers that race by construction — tryAutoConnect awaits it before it
// has set _isConnecting, so a returning visitor pressing Connect during that
// wait arrives with the first init outstanding — and `init()` is a 635 KB
// download, a storage read and a relay handshake long. Both suites below ask the
// same question: does the second caller get the first caller's answer, or its
// own?

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Same two readers the suites beside this one use, for the reason they give:
// copies of a short reader are cheaper than a shared module in a repo that
// deliberately has no build step, and the day they diverge, they diverge loudly.
function reader(file, suite) {
  const LINES = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n');
  return function grab(name) {
    const decl = LINES.findIndex(l =>
      ['const', 'let'].some(kw => l.startsWith(`${kw} ${name} `) || l.startsWith(`${kw} ${name}=`)));
    if (decl !== -1) {
      if (/;\s*(\/\/.*)?$/.test(LINES[decl])) return LINES[decl];
      let end = decl + 1;
      while (end < LINES.length && !/^[}\])]/.test(LINES[end])) end++;
      if (end >= LINES.length) throw new Error(`${suite}: no closing line for '${name}'.`);
      return LINES.slice(decl, end + 1).join('\n');
    }
    const start = LINES.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
    if (start === -1) throw new Error(`${suite}: '${name}' is no longer in ${file} — it was renamed or removed, and its coverage went with it.`);
    const opens = (LINES[start].match(/\{/g) || []).length;
    const closes = (LINES[start].match(/\}/g) || []).length;
    if (opens > 0 && opens === closes) return LINES[start];
    let end = start + 1;
    while (end < LINES.length && !LINES[end].startsWith('}')) end++;
    if (end >= LINES.length) throw new Error(`${suite}: no closing brace for '${name}'.`);
    return LINES.slice(start, end + 1).join('\n');
  };
}

const grabApp = reader('dapp/index.html', 'session.test.js');
const grabWallet = reader('dapp/wallet.js', 'session.test.js');

const ME = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const THEM = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SIG = '0x' + '11'.repeat(64) + '1b';

// ── the read session ──────────────────────────────────────────────

// One sandbox per test: every rule here is about state that persists for the
// page, so a shared one would have each test inherit the last one's answer.
function sessionCtx({ sign, post } = {}) {
  const prompts = [], posts = [];
  const ctx = {
    console: { warn() {}, error() {} },
    S: { chainId: 1 },
    PROPOSAL_API_URL: 'https://verifier.example',
    PGRST_URL: 'https://pgrst.example',
    JSON, Date, Math, Number, String,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const name of ['EIP712_DOMAIN', 'EIP712_SESSION_TYPES', 'normalizeSigV',
    '_session', '_sessionInFlight', '_sessionDeclinedBy', 'SESSION_RETRY_MS',
    '_sessionFailedAt', 'sessionToken', 'sigsReadable', 'ensureSession'])
    vm.runInContext(grabApp(name), ctx);
  vm.runInContext('globalThis.ensureSession = ensureSession; globalThis.sessionToken = sessionToken; globalThis.sigsReadable = sigsReadable;', ctx);
  ctx._connectedAddress = ME;
  ctx._signer = { signTypedData: async (...args) => { prompts.push(args); return sign ? sign(prompts.length) : SIG; } };
  ctx.pgFetch = async (p, init, base) => {
    posts.push({ p, base, body: JSON.parse(init.body) });
    return (post && post(posts.length)) || { ok: true, text: async () => JSON.stringify({ token: 'tok' + posts.length, exp: Math.floor(Date.now() / 1000) + 3600 }) };
  };
  return { ctx, prompts, posts };
}

const rejection = () => Object.assign(new Error('user rejected action'), { code: 'ACTION_REJECTED' });
const blip = () => new Error('No matching key. session topic doesn\'t exist');

test('a minted session is held, and is what makes the signature bytes readable', async () => {
  const { ctx, prompts } = sessionCtx();
  assert.equal(ctx.sigsReadable(), false, 'claimed readable before anything was signed');
  assert.equal(await ctx.ensureSession(), true);
  assert.equal(ctx.sessionToken(), 'tok1');
  assert.equal(ctx.sigsReadable(), true);
  // The second ask is free. loadVaultQueue calls it on every reload, and a
  // prompt per reload would be the whole cost of having a session.
  assert.equal(await ctx.ensureSession(), true);
  assert.equal(prompts.length, 1, 'a held token was re-minted');
});

test('two callers arriving before either has a token share one prompt', async () => {
  // The vault loader runs more than once on an ordinary page load. Two prompts
  // for one session, back to back, before anything has been read.
  const { ctx, prompts } = sessionCtx();
  const [a, b] = await Promise.all([ctx.ensureSession(), ctx.ensureSession()]);
  assert.deepEqual([a, b], [true, true]);
  assert.equal(prompts.length, 1);
});

test('a decline is this account\'s answer and is not asked again', async () => {
  const { ctx, prompts } = sessionCtx({ sign: () => { throw rejection(); } });
  assert.equal(await ctx.ensureSession(), false);
  assert.equal(await ctx.ensureSession(), false);
  assert.equal(prompts.length, 1, 'a considered no was turned into nagging');
});

test('a declining account does not decline for the next one', async () => {
  // A different person at the same machine, or the second key of a 2-of-2. The
  // refusal used to latch as a bare flag, so the account that arrived after one
  // inherited a no it had never been asked for — and could not read a signature,
  // and so could not see the queue, until the page was reloaded.
  const { ctx, prompts } = sessionCtx({ sign: n => { if (n === 1) throw rejection(); return SIG; } });
  assert.equal(await ctx.ensureSession(), false);
  ctx._connectedAddress = THEM;
  assert.equal(await ctx.ensureSession(), true, 'the new account inherited the old one\'s refusal');
  assert.equal(prompts.length, 2);
  assert.equal(ctx.sessionToken(), 'tok1');
});

test('a wallet that could not carry the question is asked again once, later', async () => {
  // signTypedData rejects for a decline and for every transient wallet fault
  // there is: a WalletConnect relay dropped between prompt and answer, a
  // provider mid-reconnect, a locked hardware wallet. Latching those cost the
  // page its queue on the strength of one blip at connect time. Not latched,
  // and not retried on the spot either: loadVaultQueue runs after every sign,
  // submit, execute and cancel, and a prompt per reload is its own problem.
  const now = Date.now();
  const { ctx, prompts } = sessionCtx({ sign: n => { if (n === 1) throw blip(); return SIG; } });
  ctx.Date = { now: () => now };
  assert.equal(await ctx.ensureSession(), false);
  assert.equal(await ctx.ensureSession(), false);
  assert.equal(prompts.length, 1, 'a prompt was fired again on the next reload');
  ctx.Date = { now: () => now + 60001 };
  assert.equal(await ctx.ensureSession(), true, 'one blip cost the page its session');
  assert.equal(prompts.length, 2);
});

test('a decline outlasts the cooldown, because it is an answer and not a fault', async () => {
  const now = Date.now();
  const { ctx, prompts } = sessionCtx({ sign: () => { throw rejection(); } });
  ctx.Date = { now: () => now };
  assert.equal(await ctx.ensureSession(), false);
  ctx.Date = { now: () => now + 86400 * 1000 };
  assert.equal(await ctx.ensureSession(), false);
  assert.equal(prompts.length, 1, 'a considered no was asked again a day later');
});

test('a refusal from the verifier waits out a cooldown rather than re-prompting', async () => {
  // A skewed clock or a sleeping verifier refuses every signature it is sent, and
  // each attempt costs a wallet prompt that was never going to work.
  const now = Date.now();
  const { ctx, prompts } = sessionCtx({ post: n => n === 1 ? { ok: false, status: 400, text: async () => 'expired' } : null });
  ctx.Date = { now: () => now };
  assert.equal(await ctx.ensureSession(), false);
  assert.equal(await ctx.ensureSession(), false);
  assert.equal(prompts.length, 1, 'a doomed prompt was fired again immediately');
  ctx.Date = { now: () => now + 60001 };
  assert.equal(await ctx.ensureSession(), true, 'the cooldown never expired');
  assert.equal(prompts.length, 2);
});

test('a token belongs to the address that proved it, and to no other', async () => {
  const { ctx } = sessionCtx();
  assert.equal(await ctx.ensureSession(), true);
  ctx._connectedAddress = THEM;
  assert.equal(ctx.sessionToken(), null, 'one account read with another account\'s token');
  assert.equal(ctx.sigsReadable(), false);
});

test('a token within a minute of expiry is not offered to a request', async () => {
  const now = Date.now();
  const { ctx } = sessionCtx({ post: () => ({ ok: true, text: async () => JSON.stringify({ token: 'tok', exp: Math.floor(now / 1000) + 3600 }) }) });
  assert.equal(await ctx.ensureSession(), true);
  ctx.Date = { now: () => now + 3600 * 1000 - 59000 };
  assert.equal(ctx.sessionToken(), null, 'a token was chosen that would expire before it was used');
});

test('the session proof names an address and a chain, and never a vault', async () => {
  // Its own EIP-712 primary type, so a signature made to read cannot be
  // presented as an operation on a vault. api/proposals.cjs recovers against
  // exactly this, and verifies the request against what was signed.
  const { ctx, prompts, posts } = sessionCtx();
  await ctx.ensureSession();
  const [domain, types, value] = prompts[0];
  assert.deepEqual(Object.keys(types), ['Session']);
  assert.deepEqual(types.Session.map(f => f.name), ['address', 'issuedAt']);
  assert.equal(domain.chainId, 1);
  assert.equal(domain.verifyingContract, undefined, 'a read proof named a contract');
  assert.equal(value.address, ME);
  assert.equal(posts[0].base, 'https://verifier.example', 'the proof went somewhere other than the verifier');
  assert.deepEqual(posts[0].body, { address: ME, chain_id: 1, issued_at: value.issuedAt, signature: SIG });
});

// ── the WalletConnect provider ────────────────────────────────────

function wcCtx() {
  const inits = [];
  const ctx = {
    console: { warn() {}, error() {} },
    Promise, Object, Number, Error,
    WC_PROJECT_ID: 'pid',
    _appName: 'Multisig',
    _targetChainId: 1,
    _targetRpc: 'https://rpc.example',
    _wcChains: [{ id: 1, rpc: 'https://one.example' }, { id: 8453, rpc: 'https://base.example' }],
    _connectedWalletProvider: null,
    location: { origin: 'https://app.example' },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const name of ['_wcSessionConfig', '_walletConnectProvider', '_wcProviderPromise', 'getWalletConnectProvider'])
    vm.runInContext(grabWallet(name), ctx);
  vm.runInContext('globalThis.getWalletConnectProvider = getWalletConnectProvider;', ctx);
  // Stood in for rather than lifted: what the download does is inject a script
  // tag, and what this suite is about is how many providers come out the far end.
  ctx.loadWalletConnect = async () => {};
  ctx.disconnectWallet = () => {};
  ctx['@walletconnect/ethereum-provider'] = { EthereumProvider: { init: async (opts) => {
    inits.push(opts);
    const listeners = {};
    return { id: inits.length, session: null, on(ev, fn) { listeners[ev] = fn; }, fire(ev) { listeners[ev] && listeners[ev](); } };
  } } };
  return { ctx, inits };
}

test('two callers racing for the provider get one provider', async () => {
  // tryAutoConnect awaits this before it has set _isConnecting, so a returning
  // visitor who presses Connect during the wait arrives here with the first init
  // still outstanding. Checking only the resolved slot let both run, and the
  // second one's provider overwrote the first in a variable the first had not
  // reached yet: two relay sockets competing for one pairing, and the orphan
  // still holding the session `disconnect` was registered on.
  const { ctx, inits } = wcCtx();
  const [a, b, c] = await Promise.all([
    ctx.getWalletConnectProvider(), ctx.getWalletConnectProvider(), ctx.getWalletConnectProvider(),
  ]);
  assert.equal(inits.length, 1, `${inits.length} WalletConnect sessions were built for one connect`);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('a later caller is handed the provider already built', async () => {
  const { ctx, inits } = wcCtx();
  const first = await ctx.getWalletConnectProvider();
  assert.equal(await ctx.getWalletConnectProvider(), first);
  assert.equal(inits.length, 1);
});

test('a failed init is a retry, not a rejection handed out forever', async () => {
  const { ctx } = wcCtx();
  let fail = true;
  ctx['@walletconnect/ethereum-provider'] = { EthereumProvider: { init: async () => {
    if (fail) throw new Error('relay unreachable');
    return { id: 'second', session: null, on() {} };
  } } };
  await assert.rejects(ctx.getWalletConnectProvider(), /relay unreachable/);
  fail = false;
  assert.equal((await ctx.getWalletConnectProvider()).id, 'second');
});

test('a session ended from the far side is not handed out again', async () => {
  // The pairing can be dropped from the phone or expire on its own. Caching the
  // instance without dropping the cached init on disconnect would hand the next
  // caller back a provider whose session is gone — which is the state nothing
  // noticed in the first place.
  const { ctx, inits } = wcCtx();
  const first = await ctx.getWalletConnectProvider();
  first.fire('disconnect');
  const second = await ctx.getWalletConnectProvider();
  assert.notEqual(second, first, 'a dead session was handed to the next connect');
  assert.equal(inits.length, 2);
});

test('the session asks about every chain the app offers, and requires one', async () => {
  // A required namespace is all-or-nothing, and only approved chains can be
  // switched to afterwards — this app switches chains as a matter of course.
  const { ctx, inits } = wcCtx();
  await ctx.getWalletConnectProvider();
  assert.deepEqual(inits[0].chains, [1]);
  assert.deepEqual(inits[0].optionalChains.sort((x, y) => x - y), [1, 8453]);
  assert.equal(inits[0].rpcMap[8453], 'https://base.example');
});
