'use strict';
// The Ethereum key a Bitcoin wallet makes, offered to index.html as an EIP-1193
// provider. No wallet window stands behind it, so its allowlist is the only
// review a signature gets — and the allowlist has to hold against the struct a
// caller actually hands ethers, not the name it declares.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DAPP = path.join(__dirname, '..', 'dapp');
const c = {
  setTimeout, clearTimeout, Date, Promise, TextEncoder, TextDecoder, Uint8Array, URL, AbortSignal,
  crypto: globalThis.crypto, console,
  location: { pathname: '/' }, addEventListener() {}, dispatchEvent() {}, Event: class {}, CustomEvent: class {},
  fetch: async () => { throw new Error('offline'); },
};
c.window = c.top = c.globalThis = c;
vm.createContext(c);
for (const f of ['btc.min.js', 'bitcoin.js', 'ethers.slim.min.js', 'bitcoin-wallets.js'])
  vm.runInContext(fs.readFileSync(path.join(DAPP, f), 'utf8'), c, { filename: f });
const { ethers } = c;

// A stand-in wallet: one account, one fixed 65-byte message signature. The key
// derived from it is deterministic, which is all these tests need of it.
const sig65 = c.btc.base64.encode(new Uint8Array(65).map((_, i) => (i === 0 ? 31 : i)));
const wallet = { key: 'unisat', name: 'UniSat', account: async () => 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', sign: async () => sig65 };
const VAULT = '0x1111111111111111111111111111111111111111';
const domain = { name: 'Multisig', version: '1', chainId: 1, verifyingContract: VAULT };
const EXECUTE = { Execute: [
  { name: 'target', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' }, { name: 'nonce', type: 'uint32' },
] };

let provider, account;
test.before(async () => {
  provider = c.BitcoinWallets.providerFor(wallet);
  [account] = await provider.request({ method: 'eth_requestAccounts' });
});
// Forgetting the key also clears its fifteen-minute idle timer, which would
// otherwise hold the process open long after the last assertion.
test.after(() => provider && provider.disconnect());
const sign = payload => provider.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(payload)] });

test('the app\'s own messages sign, and recover to the key', async () => {
  const message = { target: VAULT, value: '0', data: '0x', nonce: 3 };
  const sig = await sign({ domain, types: EXECUTE, primaryType: 'Execute', message });
  const digest = ethers.TypedDataEncoder.hash(domain, EXECUTE, message);
  assert.equal(ethers.recoverAddress(digest, sig).toLowerCase(), account);
});

test('a declared primary type cannot carry a different struct', async () => {
  // Declared Session, which skips the chain check; the struct is the one the
  // vault's ERC-1271 path accepts. ethers hashes the struct, so this was a
  // signature over SafeMessage on any chain.
  const safe = { domain: { ...domain, chainId: 8453 }, types: { SafeMessage: [{ name: 'hash', type: 'bytes32' }] },
    primaryType: 'Session', message: { hash: '0x' + 'ab'.repeat(32) } };
  await assert.rejects(sign(safe), e => e.code === 4200);
  // The same move between two of the app's own types.
  await assert.rejects(sign({ domain, types: EXECUTE, primaryType: 'Session',
    message: { target: VAULT, value: '0', data: '0x', nonce: 1 } }), e => e.code === 4200);
});

test('a struct with fields added, renamed or retyped is not the app\'s message', async () => {
  const message = { target: VAULT, value: '0', data: '0x', nonce: 3 };
  const variants = [
    { Execute: [...EXECUTE.Execute, { name: 'extra', type: 'uint256' }] },
    { Execute: EXECUTE.Execute.map(f => f.name === 'nonce' ? { ...f, type: 'uint256' } : f) },
    { Execute: EXECUTE.Execute.map(f => f.name === 'target' ? { ...f, name: 'to' } : f) },
    { ...EXECUTE, Permit: [{ name: 'owner', type: 'address' }] },
  ];
  for (const types of variants) await assert.rejects(sign({ domain, types, primaryType: 'Execute', message }), e => e.code === 4200);
  await assert.rejects(sign({ domain, types: EXECUTE, primaryType: 'constructor', message }), e => e.code === 4200);
});
