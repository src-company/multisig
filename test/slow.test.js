// SLOW: what a delayed token send actually asks the vault to execute.
//
//   node --test              (from the repo root; discovers every suite)
//
// SLOW is a deposit into a time-locked ERC-1155 wrapper, and for an ERC-20 that
// is two operations — approve the wrapper, then let it pull — which have to
// settle together or not at all. buildSlowOutbound is where that becomes
// calldata, and it is the only place in the app that emits a multi-call batch on
// the strength of a value it read from chain a moment earlier.
//
// The defect this file was written for: the batch approved the exact amount and
// nothing else, which is a revert on any token that refuses to move an allowance
// from one non-zero value to another. USDT is exactly that token, and it is in
// this app's own PROD_TOKENS on Ethereum and Base — two of the three chains SLOW
// is deployed to. Verified against the deployed mainnet contract with a state
// override: allowed[vault][SLOW] at 0 approves fine, at 1 and at 500 it reverts.
//
// A reverting ERC-20 approve is normally a retry. Here it is not: the proposal
// it bricks has already been signed by every owner and has already consumed its
// nonce, so the cost of getting this wrong is re-collecting the whole quorum.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'dapp', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

function grab(name) {
  const re = new RegExp(`^(async function|const|let|var|function)\\s+${name}\\b`);
  const start = LINES.findIndex(l => re.test(l));
  if (start === -1) throw new Error(`slow.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/[{[]/g) || []).length;
  const closes = (LINES[start].match(/[}\]]/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  if (opens === 0 && /;\s*$/.test(LINES[start])) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !/^[}\]]/.test(LINES[end])) end++;
  return LINES.slice(start, end + 1).join('\n');
}

const sandbox = { console: { ...console, warn() {}, error() {} } };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'dapp', 'ethers.slim.min.js'), 'utf8'), sandbox);

// The allowance buildSlowOutbound reads is the one thing here that comes off
// chain, and it is the input every branch below turns on. A runner that answers
// one `eth_call` is the whole stub: ethers only needs somewhere to send it.
let ALLOWANCE = 0n;
vm.runInContext(`globalThis.provider = {
  call: async () => globalThis.ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [globalThis.__allowance]),
  resolveName: async n => n,
};`, sandbox);
Object.defineProperty(sandbox, '__allowance', { get: () => ALLOWANCE });

const NEED = ['SLOW_ADDRESS', 'SLOW_ABI', 'slowIface', 'ERC20_ABI', 'erc20Iface', 'MULTISIG_ABI', 'msIface', 'fmtDelay', 'buildSlowOutbound'];
vm.runInContext(NEED.map(grab).join('\n') + '\n' + NEED.map(n => `globalThis[${JSON.stringify(n)}] = ${n};`).join('\n'), sandbox);
for (const n of NEED) if (sandbox[n] === undefined) throw new Error(`slow.test.js: '${n}' lifted as undefined — grab() matched the wrong thing.`);

const { ethers, buildSlowOutbound, slowIface, erc20Iface, msIface, SLOW_ADDRESS } = sandbox;

const TOKEN = '0xdAC17F958D2ee523a2206206994597C13D831ec7';   // mainnet USDT
const TO    = '0xbbBBbb00000000000000000000000000000000bb';
const VAULT = '0xaaAaaa00000000000000000000000000000000aA';
const AMT   = 1000000n;
const usdt  = { address: TOKEN, symbol: 'USDT', decimals: 6 };

const build = (over = {}) => buildSlowOutbound({
  tokenInfo: usdt, toAddr: TO, amountRaw: AMT, delaySec: 86400, vaultAddr: VAULT, ...over,
});

// Unpacks a vault `batch` into the calls it will actually make, in order.
function calls(out) {
  const [targets, values, datas] = msIface.decodeFunctionData('batch', out.data);
  assert.equal(targets.length, values.length, 'batch targets and values are different lengths');
  assert.equal(targets.length, datas.length, 'batch targets and datas are different lengths');
  return targets.map((t, i) => ({ target: t, value: values[i], data: datas[i] }));
}
const named = c => {
  for (const iface of [erc20Iface, slowIface]) {
    try { const p = iface.parseTransaction({ data: c.data }); if (p) return p; } catch (_) {}
  }
  throw new Error('call matched no known interface: ' + c.data.slice(0, 10));
};

test('ETH goes as value, with the zero address as the token and a zero amount', async () => {
  // SLOW reads msg.value for the native asset; passing the amount in both places
  // would be a second, unfunded figure that has to agree with the first.
  const out = await build({ tokenInfo: { address: ethers.ZeroAddress, symbol: 'ETH', decimals: 18 } });
  assert.equal(out.target, SLOW_ADDRESS);
  assert.equal(out.value, AMT.toString());
  assert.ok(!out.batched, 'an ETH deposit needs no approve and so needs no batch');
  const p = slowIface.parseTransaction({ data: out.data });
  assert.equal(p.name, 'depositTo');
  assert.equal(p.args[0], ethers.ZeroAddress);
  assert.equal(p.args[1], TO);
  assert.equal(p.args[2], 0n, 'the amount argument must be zero — SLOW takes it from msg.value');
});

test('a standing allowance that already covers it deposits directly, with no approve', async () => {
  ALLOWANCE = AMT;
  const out = await build();
  assert.equal(out.target, SLOW_ADDRESS);
  assert.equal(out.value, '0');
  assert.ok(!out.batched);
  assert.equal(slowIface.parseTransaction({ data: out.data }).name, 'depositTo');
});

test('no allowance is approve-then-deposit, atomically, and nothing more', async () => {
  ALLOWANCE = 0n;
  const out = await build();
  assert.ok(out.batched);
  assert.equal(out.target, VAULT, 'a batch is a self-call: it must be addressed to the vault');
  const cs = calls(out);
  assert.equal(cs.length, 2, 'with no allowance to clear there is nothing to reset');
  assert.deepEqual(cs.map(c => named(c).name), ['approve', 'depositTo']);
  assert.equal(cs[0].target, TOKEN);
  assert.equal(named(cs[0]).args[0], SLOW_ADDRESS, 'the approve must name SLOW, not the recipient');
  assert.equal(named(cs[0]).args[1], AMT, 'exactly the amount, so the deposit consumes the allowance whole');
  assert.equal(cs[1].target, SLOW_ADDRESS);
  assert.ok(cs.every(c => c.value === 0n), 'an ERC-20 deposit carries no ETH');
});

test('a partial allowance is reset to zero before it is raised', async () => {
  // The regression. USDT reverts on a non-zero -> non-zero approve, so a
  // stranded partial allowance makes every later SLOW send of that token fail —
  // after the quorum has signed it and the nonce is gone.
  for (const partial of [1n, AMT - 1n, AMT / 2n]) {
    ALLOWANCE = partial;
    const cs = calls(await build());
    assert.equal(cs.length, 3, `allowance ${partial} must produce reset + approve + deposit`);
    assert.deepEqual(cs.map(c => named(c).name), ['approve', 'approve', 'depositTo']);
    assert.equal(named(cs[0]).args[1], 0n, 'the first approve must zero the allowance');
    assert.equal(named(cs[1]).args[1], AMT, 'the second must raise it to the amount being sent');
    assert.equal(named(cs[0]).args[0], SLOW_ADDRESS);
    assert.equal(named(cs[1]).args[0], SLOW_ADDRESS);
    assert.deepEqual(cs.map(c => c.target), [TOKEN, TOKEN, SLOW_ADDRESS]);
  }
});

test('the deposit leg says the same thing however it was reached', async () => {
  // Whatever the allowance was, the vault must end up asking SLOW for exactly
  // one thing: this token, this recipient, this amount, this delay.
  for (const a of [0n, 1n, AMT - 1n, AMT, AMT * 2n]) {
    ALLOWANCE = a;
    const out = await build();
    const dep = out.batched ? named(calls(out).at(-1)) : slowIface.parseTransaction({ data: out.data });
    assert.equal(dep.name, 'depositTo');
    assert.equal(dep.args[0], TOKEN, `token changed at allowance ${a}`);
    assert.equal(dep.args[1], TO, `recipient changed at allowance ${a}`);
    assert.equal(dep.args[2], AMT, `amount changed at allowance ${a}`);
    assert.equal(dep.args[3], 86400n, `delay changed at allowance ${a}`);
  }
});
