const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createECDH, createHmac } = require('node:crypto');
const { Readable } = require('node:stream');
const { verifyProposal, createHandler, dependencies, serviceToken, senderSlot, ethers, TYPES, iface } = require('../api/proposals.cjs');

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const VAULT = '0x2222222222222222222222222222222222222222';
const TARGET = '0x3333333333333333333333333333333333333333';
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const hex = x => x.toString(16).padStart(64, '0');
function publicKey(key) {
  const curve = createECDH('secp256k1');
  curve.setPrivateKey(Buffer.from(hex(key), 'hex'));
  return curve.getPublicKey();
}
function address(key) { return '0x' + ethers.keccak256('0x' + publicKey(key).subarray(1).toString('hex')).slice(-40); }
// Test-only ECDSA fixture signer. Fixed k=2 is deliberately confined to these
// public test keys; NEVER use this helper for a real wallet or production key.
function sign(hash, key = 1n) {
  const point = publicKey(2n);
  const r = BigInt('0x' + point.subarray(1, 33).toString('hex')) % N;
  let s = ((BigInt(hash) + r * key) * ((N + 1n) / 2n)) % N;
  let parity = point[64] & 1;
  if (s > N / 2n) { s = N - s; parity ^= 1; }
  return '0x' + hex(r) + hex(s) + (27 + parity).toString(16);
}
function proposal(overrides = {}, key = 1n) {
  const p = { p_wallet_id: WALLET_ID, p_chain_id: 1, p_nonce: 7,
    p_target: TARGET, p_value: '900719925474099312345', p_call_data: '0x1234',
    p_threshold: 2, p_proposed_by: address(key), p_description: 'test proposal', ...overrides };
  p.p_tx_hash = ethers.TypedDataEncoder.hash({ name: 'Multisig', version: '1', chainId: p.p_chain_id, verifyingContract: VAULT }, TYPES,
    { target: p.p_target, value: p.p_value, data: p.p_call_data, nonce: p.p_nonce });
  p.p_signature = sign(p.p_tx_hash, key);
  return p;
}
function backend(overrides = {}) {
  return { getWallet: async () => ({ chain_id: 1, address: VAULT }),
    readVault: async () => ({ isOwner: true, threshold: 2, ownerCount: 3, approved: false }),
    saveProposal: async () => WALLET_ID, ...overrides };
}
async function request(body, deps = backend(), headers = {}, url = '/proposals', method = 'POST') {
  const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { headers: { 'content-type': 'application/json', ...headers }, url, method });
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(body = '') { this.body = body; } };
  await createHandler(deps, ['https://app.example'])(req, res);
  return res;
}

test('real owner signature is verified and exact normalized payload reaches storage once', async () => {
  const input = proposal();
  let writes = 0;
  const result = await request(input, backend({ saveProposal: async p => {
    writes++;
    assert.equal(p.p_value, input.p_value);
    assert.equal(p.p_tx_hash, input.p_tx_hash);
    assert.equal(p.p_signature, input.p_signature);
    assert.equal(p.p_proposed_by, address(1n));
    assert.equal(p.p_sig_type, 'ecdsa');
    return WALLET_ID;
  } }), { origin: 'https://app.example' });
  assert.equal(result.status, 200);
  assert.equal(writes, 1);
  assert.equal(JSON.parse(result.body), WALLET_ID);
  assert.equal(result.headers['Access-Control-Allow-Origin'], 'https://app.example');
});

test('unsigned, forged, wrong-owner, and malformed signatures never reach storage', async () => {
  const cases = [undefined, '0x', '0x' + '11'.repeat(65), proposal({}, 2n).p_signature,
    proposal().p_signature.slice(0, -2) + '00', proposal().p_signature + '00'];
  for (const p_signature of cases) {
    const result = await request({ ...proposal(), p_signature }, backend({ saveProposal: async () => assert.fail('unauthorized write') }));
    assert.equal(result.status, 400, String(p_signature));
  }
});

test('signature binds target, value, calldata, nonce, chain, vault, and claimed proposer', async () => {
  const base = proposal();
  for (const change of [{ p_target: VAULT }, { p_value: '42' }, { p_call_data: '0x5678' },
    { p_nonce: 8 }, { p_chain_id: 8453 }, { p_proposed_by: address(2n) }]) {
    // Recompute attacker-controlled hash, but keep the original signature.
    const input = { ...proposal(change), p_signature: base.p_signature };
    const result = await request(input, backend({ saveProposal: async () => assert.fail('altered transaction stored') }));
    assert.equal(result.status, 400, JSON.stringify(change));
  }
  const result = await request(base, backend({ getWallet: async () => ({ chain_id: 1, address: TARGET }),
    saveProposal: async () => assert.fail('wrong vault stored') }));
  assert.equal(result.status, 400);
});

test('current chain ownership is required even when supplied database owners claim otherwise', async () => {
  let reads = 0;
  const result = await request({ ...proposal(), owners: [address(1n)], rpcUrl: 'https://attacker.example', role: 'proposal_writer' }, backend({
    readVault: async (chainId, vault, owner, hash) => {
      reads++;
      assert.equal(chainId, 1); assert.equal(vault, VAULT); assert.equal(owner, address(1n));
      assert.equal(hash, proposal().p_tx_hash);
      return { isOwner: false, threshold: 2, ownerCount: 3 };
    }, saveProposal: async () => assert.fail('nonowner stored'),
  }));
  assert.equal(result.status, 403);
  assert.equal(reads, 1);
});

test('approval slot requires actual on-chain approval and preserves contract-owner workflow', async () => {
  const p = proposal();
  p.p_sig_type = 'approval'; p.p_signature = senderSlot(p.p_proposed_by);
  assert.equal((await request(p)).status, 403);
  const good = backend({ readVault: async () => ({ isOwner: true, approved: true, threshold: 2, ownerCount: 3 }) });
  assert.equal((await request(p, good)).status, 200);
  assert.equal((await request({ ...p, p_signature: senderSlot(address(2n)) }, good)).status, 400);
  assert.equal((await request(p, backend({ readVault: async () => ({ isOwner: false, approved: true }) }))).status, 403);
});

test('unanimous acceleration, large integer values, and hex case variants remain valid', async () => {
  const p = proposal({ p_threshold: 3 });
  p.p_target = '0x' + p.p_target.slice(2).toUpperCase();
  p.p_tx_hash = '0x' + p.p_tx_hash.slice(2).toUpperCase();
  p.p_signature = '0x' + p.p_signature.slice(2).toUpperCase();
  const verified = await verifyProposal(p, backend());
  assert.equal(verified.p_threshold, 3);
  assert.equal(verified.p_value, '900719925474099312345');
  assert.equal(verified.p_signature, p.p_signature.toLowerCase());
});

test('backend outages and invalid backend responses fail closed', async () => {
  for (const fn of ['getWallet', 'readVault', 'saveProposal']) {
    const result = await request(proposal(), backend({ [fn]: async () => { throw new Error('secret backend details'); } }));
    assert.equal(result.status, 503);
    assert.doesNotMatch(result.body, /secret/);
  }
  assert.equal((await request(proposal(), backend({ saveProposal: async () => null }))).status, 503);
});

test('invalid request shapes, numeric coercion, unsupported modes and oversized bodies are rejected', async () => {
  for (const p of [null, [], { ...proposal(), p_value: 42 }, { ...proposal(), p_value: '1e5' },
    { ...proposal(), p_nonce: '7' }, { ...proposal(), p_sig_type: 'erc1271' },
    { ...proposal(), p_threshold: 1 }, { ...proposal(), p_threshold: 4 }]) {
    assert.equal((await request(p)).status, 400);
  }
  assert.equal((await request('{')).status, 400);
  assert.equal((await request(' '.repeat(73 * 1024))).status, 413);
  assert.equal((await request(proposal(), backend(), { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await request(proposal(), backend(), {}, '/rpc/propose_tx')).status, 404);
});

test('backend uses configured RPC and one block, validates chain id, and sends JWT only to SQL', async () => {
  const urls = [];
  const secret = 'test-secret-'.repeat(4);
  const deps = dependencies({ postgrestUrl: 'https://db.example', jwtSecret: secret, rpcUrls: { 1: 'https://rpc.example' } }, async (url, options) => {
    urls.push(url);
    if (url.startsWith('https://db.example/wallets')) return { ok: true, json: async () => [{ chain_id: 1, address: VAULT }] };
    if (url.endsWith('/rpc/propose_tx')) {
      assert.match(options.headers.Authorization, /^Bearer /);
      const payload = JSON.parse(options.body);
      assert.equal(payload.p_signature, proposal().p_signature);
      assert.equal(payload.rpcUrl, undefined);
      return { ok: true, json: async () => WALLET_ID };
    }
    assert.equal(url, 'https://rpc.example');
    assert.equal(options.headers.Authorization, undefined);
    const rpc = JSON.parse(options.body);
    let result;
    if (rpc.method === 'eth_chainId') result = '0x1';
    else if (rpc.method === 'eth_blockNumber') result = '0x123';
    else {
      assert.equal(rpc.params[1], '0x123');
      const call = iface.parseTransaction({ data: rpc.params[0].data });
      result = iface.encodeFunctionResult(call.name, [call.name === 'isOwner' ? true : call.name === 'threshold' ? 2 : 3]);
    }
    return { ok: true, json: async () => ({ result }) };
  });
  assert.equal((await request({ ...proposal(), rpcUrl: 'https://attacker.example' }, deps)).status, 200);
  assert.ok(urls.every(url => !url.includes('attacker')));
  const wrong = dependencies({ postgrestUrl: 'https://db.example', jwtSecret: secret, rpcUrls: { 1: 'https://rpc.example' } },
    async () => ({ ok: true, json: async () => ({ result: '0x2' }) }));
  await assert.rejects(wrong.readVault(1, VAULT, address(1n), proposal().p_tx_hash, 'ecdsa'), /wrong chain/);
  await assert.rejects(wrong.readVault(8453, VAULT, address(1n), proposal().p_tx_hash, 'ecdsa'), /Unsupported chain/);
});

test('service token is signed, short-lived, and carries only restricted role', () => {
  const secret = 'test-secret-'.repeat(4);
  const token = serviceToken(secret);
  const [header, payload, sig] = token.split('.');
  assert.equal(sig, createHmac('sha256', secret).update(header + '.' + payload).digest('base64url'));
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.role, 'proposal_writer');
  assert.equal(claims.exp - claims.iat, 30);
});
