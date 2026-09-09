const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createECDH, createHmac } = require('node:crypto');
const { Readable } = require('node:stream');
const { verifyProposal, verifyMetadata, verifyAction, verifySignature, verifyReconcile, verifyRegistration, verifyConfirm, createHandler, dependencies, serviceToken, senderSlot, ethers, TYPES, META_TYPES, ACTION_TYPES, iface } = require('../api/proposals.cjs');

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const VAULT = '0x2222222222222222222222222222222222222222';
const TARGET = '0x3333333333333333333333333333333333333333';
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const TX_HASH = '0x' + '5'.repeat(64);
const STORED = { tx_hash: TX_HASH, chain_id: 1, nonce: 7, target: TARGET,
  value: '900719925474099312345', call_data: '0x1234', status: 'proposed', address: VAULT };
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
    saveProposal: async () => WALLET_ID, saveMetadata: async () => {}, saveAction: async () => {},
    readOwner: async () => true,
    saveSignature: async () => 2, saveReconcile: async () => {}, readVaultState: async () => ({ nonce: 9, queuedEta: 0n }),
    saveRegistration: async () => WALLET_ID, saveConfirm: async () => {},
    readReceipt: async () => ({ status: 1, blockNumber: 1234, logs: [
      { address: VAULT, topics: [EXEC_TOPIC, storedHash()] } ] }),
    readVaultRecord: async () => ({ owners: [address(1n), address(2n)], threshold: 2, delay: 0, executor: ZERO_ADDR, nonce: 5 }),
    getProposal: async () => ({ ...STORED }), ...overrides };
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

// ── SIGNED METADATA WRITES ────────────────────────────────────────
// A name and a label are the only columns the chain cannot put back, so the
// writes that set them are verified the same way a proposal is: the signer is
// recovered from the signature and confirmed against the vault, never supplied.
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const OWNER = '0x4444444444444444444444444444444444444444';
function metaHash(m) {
  const subject = (m.kind === 'label' ? m.subject : ZERO_ADDR).toLowerCase();
  return ethers.TypedDataEncoder.hash(
    { name: 'Multisig', version: '1', chainId: m.chainId ?? 1, verifyingContract: (m.vault ?? VAULT).toLowerCase() },
    META_TYPES,
    { vault: (m.vault ?? VAULT).toLowerCase(), subject, value: m.value, issuedAt: m.issued_at });
}
// Unlike a proposal, a metadata payload carries no separate hash field to
// cross-check — the digest is derived from the payload itself, so the only
// thing standing between a forged signature and a write is the recovered
// address failing isOwner(). A mock that answers true for every signer would
// not model that, and would pass a payload production rejects.
function metaBackend(overrides = {}) {
  return backend({
    readOwner: async (chainId, vault, who) => who === address(1n).toLowerCase(),
    readVault: async (chainId, vault, signer) => ({
      isOwner: signer === address(1n).toLowerCase(), threshold: 2, ownerCount: 3, approved: false,
    }), ...overrides });
}
function metadata(overrides = {}, key = 1n) {
  const m = { wallet_id: WALLET_ID, kind: 'name', subject: ZERO_ADDR, value: 'TREASURY',
    issued_at: Math.floor(Date.now() / 1000), ...overrides };
  m.signature = sign(metaHash(m), key);
  delete m.chainId; delete m.vault;
  return m;
}

test('a signed name and label reach their own RPC with the recovered subject', async () => {
  const calls = [];
  const deps = backend({ saveMetadata: async write => { calls.push(write); } });
  assert.equal((await request(metadata(), deps, {}, '/metadata')).status, 204);
  assert.equal((await request(metadata({ kind: 'label', subject: OWNER, value: 'COLD KEY' }), deps, {}, '/metadata')).status, 204);
  assert.deepEqual(calls[0], { fn: 'set_wallet_name', args: { p_wallet_id: WALLET_ID, p_name: 'TREASURY' } });
  assert.deepEqual(calls[1], { fn: 'set_owner_label',
    args: { p_wallet_id: WALLET_ID, p_address: OWNER.toLowerCase(), p_label: 'COLD KEY' } });
});

test('forged, wrong-key and malformed metadata signatures never reach storage', async () => {
  const cases = [undefined, '0x', '0x' + '11'.repeat(65), metadata({}, 2n).signature,
    metadata().signature.slice(0, -2) + '00', metadata().signature + '00'];
  for (const signature of cases) {
    const result = await request({ ...metadata(), signature },
      metaBackend({ saveMetadata: async () => assert.fail('unauthorized metadata write') }), {}, '/metadata');
    assert.ok(result.status === 400 || result.status === 403, `${signature} -> ${result.status}`);
  }
});

test('a metadata signature binds value, subject, vault and chain', async () => {
  const base = metadata({ kind: 'label', subject: OWNER, value: 'COLD KEY' });
  // Each change re-signs nothing: the original signature is kept, so a payload
  // altered in flight recovers to a different address than the one on chain.
  for (const change of [{ value: 'PWNED' }, { subject: TARGET }, { kind: 'name' }]) {
    const result = await request({ ...base, ...change },
      metaBackend({ saveMetadata: async () => assert.fail('altered metadata stored') }), {}, '/metadata');
    assert.ok(result.status === 400 || result.status === 403, `${JSON.stringify(change)} -> ${result.status}`);
  }
  // A different vault or chain moves the domain, so the same bytes stop matching.
  for (const wallet of [{ chain_id: 1, address: TARGET }, { chain_id: 8453, address: VAULT }]) {
    const result = await request(base, metaBackend({ getWallet: async () => wallet,
      saveMetadata: async () => assert.fail('wrong domain stored') }), {}, '/metadata');
    assert.ok(result.status === 400 || result.status === 403, `${JSON.stringify(wallet)} -> ${result.status}`);
  }
});

test('a metadata signature expires, in both directions', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const issued_at of [now - 301, now + 301]) {
    const result = await request(metadata({ issued_at }),
      backend({ saveMetadata: async () => assert.fail('stale metadata stored') }), {}, '/metadata');
    assert.equal(result.status, 400, String(issued_at));
  }
  assert.equal((await request(metadata({ issued_at: now - 299 }), backend(), {}, '/metadata')).status, 204);
});

test('current chain ownership gates a metadata write, whatever the database says', async () => {
  const result = await request(metadata(), backend({ readOwner: async () => false,
    readVault: async () => ({ isOwner: false, threshold: 2, ownerCount: 3 }),
    saveMetadata: async () => assert.fail('non-owner wrote metadata') }), {}, '/metadata');
  assert.equal(result.status, 403);
});

test('an Execute signature cannot be replayed as a metadata write', async () => {
  const p = proposal();
  const result = await request({ wallet_id: WALLET_ID, kind: 'name', subject: ZERO_ADDR,
    value: 'TREASURY', issued_at: Math.floor(Date.now() / 1000), signature: p.p_signature },
    metaBackend({ saveMetadata: async () => assert.fail('proposal signature reused as metadata') }), {}, '/metadata');
  assert.ok(result.status === 400 || result.status === 403, String(result.status));
});

test('metadata length ceilings match the columns, and the RPC is never caller-chosen', async () => {
  assert.equal((await request(metadata({ value: 'x'.repeat(129) }), backend(), {}, '/metadata')).status, 400);
  assert.equal((await request(metadata({ kind: 'label', subject: OWNER, value: 'x'.repeat(65) }), backend(), {}, '/metadata')).status, 400);
  assert.equal((await request(metadata({ kind: 'drop_table' }), backend(), {}, '/metadata')).status, 400);
  // A caller-supplied fn is ignored: verifyMetadata returns the name itself.
  const write = await verifyMetadata({ ...metadata(), fn: 'propose_tx' }, backend());
  assert.equal(write.fn, 'set_wallet_name');
});

// ── SIGNED UNSIGN ─────────────────────────────────────────────────
// Withdrawing a signature was reachable by anyone willing to name an owner,
// which is enough to hold a vault below quorum indefinitely. The signer is now
// recovered, and the row removed is that signer's own.
function actionHash(a) {
  return ethers.TypedDataEncoder.hash(
    { name: 'Multisig', version: '1', chainId: a.chainId ?? 1, verifyingContract: (a.vault ?? VAULT).toLowerCase() },
    ACTION_TYPES,
    { vault: (a.vault ?? VAULT).toLowerCase(), action: a.action, txHash: (a.txHash ?? TX_HASH).toLowerCase(), issuedAt: a.issued_at });
}
function action(overrides = {}, key = 1n) {
  const a = { tx_id: WALLET_ID, action: 'unsign', issued_at: Math.floor(Date.now() / 1000), ...overrides };
  a.signature = sign(actionHash({ ...a, txHash: overrides.txHash, vault: overrides.vault, chainId: overrides.chainId }), key);
  delete a.chainId; delete a.vault; delete a.txHash;
  return a;
}
function actionBackend(overrides = {}) {
  return backend({
    readOwner: async (chainId, vault, who) => who === address(1n).toLowerCase(),
    readVault: async (chainId, vault, signer) => ({
      isOwner: signer === address(1n).toLowerCase(), threshold: 2, ownerCount: 3, approved: false,
    }), ...overrides });
}

test('a signed unsign removes only the recovered signer own signature', async () => {
  const calls = [];
  const res = await request(action(), actionBackend({ saveAction: async w => { calls.push(w); } }), {}, '/action');
  assert.equal(res.status, 204);
  assert.deepEqual(calls[0], { fn: 'signed_remove_signature', args: { p_tx_id: WALLET_ID, p_signer: address(1n).toLowerCase() } });
});

test('an unsign cannot be aimed at another owner signature', async () => {
  // There is no field to aim with: p_signer is the recovered address, so a
  // valid signature from key 2 can only ever delete key 2's own row.
  const other = action({}, 2n);
  const res = await request(other, actionBackend({ saveAction: async () => assert.fail('non-owner unsigned') }), {}, '/action');
  assert.equal(res.status, 403);
});

test('forged, malformed and expired unsign requests never reach storage', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    { ...action(), signature: '0x' + '11'.repeat(65) },
    { ...action(), signature: undefined },
    { ...action(), action: 'cancel' },
    { ...action(), issued_at: now - 301 },
    { ...action(), issued_at: now + 301 },
    { ...action(), tx_id: 'not-a-uuid' },
  ];
  for (const c of cases) {
    const res = await request(c, actionBackend({ saveAction: async () => assert.fail('bad action stored') }), {}, '/action');
    assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(c.action || c.issued_at)} -> ${res.status}`);
  }
});

test('an unsign signature is bound to the stored proposal, not the request', async () => {
  // The vault and digest come from getProposal. A proposal stored against a
  // different vault or digest moves the domain, so the same bytes stop matching.
  for (const p of [{ tx_hash: TX_HASH, chain_id: 1, address: TARGET },
                   { tx_hash: '0x' + '6'.repeat(64), chain_id: 1, address: VAULT },
                   { tx_hash: TX_HASH, chain_id: 8453, address: VAULT }]) {
    const res = await request(action(), actionBackend({ getProposal: async () => p,
      saveAction: async () => assert.fail('rebound action stored') }), {}, '/action');
    assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(p)} -> ${res.status}`);
  }
  const missing = await request(action(), actionBackend({ getProposal: async () => null,
    saveAction: async () => assert.fail('unknown proposal stored') }), {}, '/action');
  assert.equal(missing.status, 400);
});

test('a metadata signature cannot be replayed as an unsign', async () => {
  const m = metadata();
  const res = await request({ tx_id: WALLET_ID, action: 'unsign',
    issued_at: Math.floor(Date.now() / 1000), signature: m.signature },
    actionBackend({ saveAction: async () => assert.fail('metadata signature reused') }), {}, '/action');
  assert.ok(res.status === 400 || res.status === 403, String(res.status));
});

// ── SIGNED ADD-SIGNATURE ──────────────────────────────────────────
// The digest is rebuilt from the stored proposal, so a signature is only
// accepted for the exact terms the row records.
function storedHash(p = STORED) {
  return ethers.TypedDataEncoder.hash(
    { name: 'Multisig', version: '1', chainId: p.chain_id, verifyingContract: p.address.toLowerCase() },
    TYPES,
    { target: p.target.toLowerCase(), value: String(p.value), data: p.call_data.toLowerCase(), nonce: p.nonce });
}
function sigInput(overrides = {}, key = 1n) {
  return { tx_id: WALLET_ID, signer: address(key), signature: sign(storedHash(), key), sig_type: 'ecdsa', ...overrides };
}
function sigBackend(overrides = {}) {
  const owns = a => a === address(1n).toLowerCase() || a === address(2n).toLowerCase();
  return backend({
    readOwner: async (chainId, vault, who) => owns(who),
    readVault: async (chainId, vault, signer) => ({
      isOwner: owns(signer), threshold: 2, ownerCount: 3, approved: false,
    }), ...overrides });
}

test('a signature verified against the stored proposal is written once', async () => {
  const calls = [];
  const res = await request(sigInput(), sigBackend({ saveSignature: async w => { calls.push(w); return 2; } }), {}, '/signature');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body), 2);
  assert.deepEqual(calls[0], { fn: 'signed_add_signature', args: {
    p_tx_id: WALLET_ID, p_signer: address(1n).toLowerCase(),
    p_signature: sigInput().signature.toLowerCase(), p_sig_type: 'ecdsa' } });
});

test('a signature filed under another owner name is refused', async () => {
  // Key 2's bytes, claimed as key 1. This is exactly what add_signature allowed.
  const forged = { ...sigInput({}, 2n), signer: address(1n) };
  const res = await request(forged, sigBackend({ saveSignature: async () => assert.fail('forged signer stored') }), {}, '/signature');
  assert.equal(res.status, 400);
});

test('a signature over different terms than the stored proposal is refused', async () => {
  const base = sigInput();
  for (const p of [{ ...STORED, target: VAULT }, { ...STORED, value: '42' },
                   { ...STORED, call_data: '0x5678' }, { ...STORED, nonce: 8 },
                   { ...STORED, chain_id: 8453 }, { ...STORED, address: TARGET }]) {
    const res = await request(base, sigBackend({ getProposal: async () => p,
      saveSignature: async () => assert.fail('mismatched terms stored') }), {}, '/signature');
    assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(p)} -> ${res.status}`);
  }
});

test('a non-owner signature and a settled proposal are both refused', async () => {
  const stranger = await request(sigInput({}, 3n), sigBackend({
    saveSignature: async () => assert.fail('non-owner stored') }), {}, '/signature');
  assert.equal(stranger.status, 403);
  for (const status of ['executed', 'cancelled', 'stale']) {
    const res = await request(sigInput(), sigBackend({ getProposal: async () => ({ ...STORED, status }),
      saveSignature: async () => assert.fail('settled proposal signed') }), {}, '/signature');
    assert.equal(res.status, 400, status);
  }
});

test('an approval slot still needs the vault to say it was approved', async () => {
  const slot = senderSlot(address(1n).toLowerCase());
  const input = { tx_id: WALLET_ID, signer: address(1n), signature: slot, sig_type: 'approval' };
  const denied = await request(input, sigBackend({
    readOwner: async () => assert.fail('approval slot took the cheap ownership path'),
    readVault: async () => ({ isOwner: true, threshold: 2, ownerCount: 3, approved: false }),
    saveSignature: async () => assert.fail('unapproved slot stored') }), {}, '/signature');
  assert.equal(denied.status, 403);
  const ok = await request(input, sigBackend({
    readVault: async () => ({ isOwner: true, threshold: 2, ownerCount: 3, approved: true }) }), {}, '/signature');
  assert.equal(ok.status, 200);
});

// ── CHAIN-VERIFIED RECONCILIATION ─────────────────────────────────
// No signature, and still not forgeable: the vault's nonce decides.
test('a proposal the vault has passed can be retired, in either terminal state', async () => {
  for (const state of ['cancelled', 'stale']) {
    const calls = [];
    // STORED.nonce is 7; the vault is at 9, so this proposal can never execute.
    const res = await request({ tx_id: WALLET_ID, state },
      backend({ saveReconcile: async w => { calls.push(w); } }), {}, '/reconcile');
    assert.equal(res.status, 204, state);
    assert.deepEqual(calls[0], { fn: 'reconcile_tx', args: { p_tx_id: WALLET_ID, p_state: state } });
  }
});

test('a proposal still executable at the vault current nonce is refused', async () => {
  for (const nonce of [7, 6, 0]) {
    const res = await request({ tx_id: WALLET_ID, state: 'cancelled' },
      backend({ readVaultState: async () => ({ nonce, queuedEta: 0n }),
        saveReconcile: async () => assert.fail('live proposal retired') }), {}, '/reconcile');
    assert.equal(res.status, 409, `chain nonce ${nonce}`);
  }
});

// The defect this pair exists for: execute() advances the nonce whether it runs
// the call or queues it, so EVERY queued proposal reads as behind the vault's
// nonce while remaining executable by executeQueued at its original nonce.
// Retiring on the nonce alone retired exactly the live proposals this endpoint
// is meant to protect, and without a signature.
test('a queued proposal is never retired, however far behind its nonce is', async () => {
  for (const nonce of [9, 100, 2 ** 31]) {
    const res = await request({ tx_id: WALLET_ID, state: 'stale' },
      backend({ readVaultState: async () => ({ nonce, queuedEta: 1788900000n }),
        saveReconcile: async () => assert.fail('queued proposal retired') }), {}, '/reconcile');
    assert.equal(res.status, 409, `chain nonce ${nonce}`);
  }
});

test('a matured queue entry that the vault has cleared can be retired', async () => {
  // queued[hash] == 0 and the nonce is behind: it ran, or it was cancelled on
  // chain. Either way nothing will honour it again.
  const calls = [];
  const res = await request({ tx_id: WALLET_ID, state: 'stale' },
    backend({ readVaultState: async () => ({ nonce: 9, queuedEta: 0n }),
      saveReconcile: async w => { calls.push(w); } }), {}, '/reconcile');
  assert.equal(res.status, 204);
  assert.equal(calls.length, 1);
});

test('reconciliation rejects bad shapes, unknown states and settled proposals', async () => {
  const bad = [
    { tx_id: 'nope', state: 'stale' },
    { tx_id: WALLET_ID, state: 'executed' },
    { tx_id: WALLET_ID, state: 'PWNED' },
    { tx_id: WALLET_ID },
    null,
  ];
  for (const b of bad) {
    const res = await request(b, backend({ saveReconcile: async () => assert.fail('bad reconcile stored') }), {}, '/reconcile');
    assert.equal(res.status, 400, JSON.stringify(b));
  }
  for (const status of ['executed', 'cancelled', 'stale']) {
    const res = await request({ tx_id: WALLET_ID, state: 'stale' },
      backend({ getProposal: async () => ({ ...STORED, status }),
        saveReconcile: async () => assert.fail('settled proposal re-retired') }), {}, '/reconcile');
    assert.equal(res.status, 400, status);
  }
});

test('reconciliation fails closed when the chain cannot be read', async () => {
  const res = await request({ tx_id: WALLET_ID, state: 'stale' },
    backend({ readVaultState: async () => { throw new Error('secret rpc detail'); },
      saveReconcile: async () => assert.fail('retired without a chain read') }), {}, '/reconcile');
  assert.equal(res.status, 503);
  assert.doesNotMatch(res.body, /secret/);
});

// ── CHAIN-DERIVED REGISTRATION ────────────────────────────────────
// The caller supplies an address. Everything that describes the vault is read
// from the vault, so a fabricated address cannot be recorded at all — which is
// what takes the storage-exhaustion primitive away.
test('a vault record is built from the chain, not from the request', async () => {
  const calls = [];
  const res = await request({
    chain_id: 1, address: VAULT,
    // All of this is either ignored or bounded. None of it describes the vault.
    owners: [TARGET], threshold: 1, delay: 999, executor: TARGET, nonce: 4242,
    deployer: TARGET, name: 'TREASURY', labels: ['A', 'B'],
  }, backend({ saveRegistration: async w => { calls.push(w); return WALLET_ID; } }), {}, '/register');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body), WALLET_ID);
  const a = calls[0].args;
  assert.equal(calls[0].fn, 'register_wallet');
  assert.deepEqual(a.p_owners, [address(1n).toLowerCase(), address(2n).toLowerCase()]);
  assert.equal(a.p_threshold, 2);
  assert.equal(a.p_delay, 0);
  assert.equal(a.p_nonce, 5);
  assert.equal(a.p_executor, ZERO_ADDR);
  // The deployer is a real chain owner, never the caller's claim.
  assert.equal(a.p_deployer, address(1n).toLowerCase());
  assert.notEqual(a.p_deployer, TARGET.toLowerCase());
  // Name and labels do pass through: the chain has no opinion about them, and
  // register_wallet only honours them while the vault is first recorded.
  assert.equal(a.p_name, 'TREASURY');
  assert.deepEqual(a.p_labels, ['A', 'B']);
});

test('an address with no multisig on it cannot be registered', async () => {
  for (const record of [{ owners: null }, { owners: [], threshold: 2 },
                        { owners: [address(1n)], threshold: 0 },
                        { owners: [address(1n)], threshold: null }]) {
    const res = await request({ chain_id: 1, address: VAULT },
      backend({ readVaultRecord: async () => record,
        saveRegistration: async () => assert.fail('phantom vault recorded') }), {}, '/register');
    assert.equal(res.status, 400, JSON.stringify(record));
  }
});

test('registration rejects bad shapes and oversized metadata', async () => {
  const bad = [
    { chain_id: 1, address: 'nope' },
    { chain_id: 0, address: VAULT },
    { chain_id: '1', address: VAULT },
    { chain_id: 1, address: VAULT, name: 'x'.repeat(129) },
    { chain_id: 1, address: VAULT, labels: ['x'.repeat(65)] },
    { chain_id: 1, address: VAULT, salt: '-1' },
    null,
  ];
  for (const b of bad) {
    const res = await request(b, backend({ saveRegistration: async () => assert.fail('bad registration stored') }), {}, '/register');
    assert.equal(res.status, 400, JSON.stringify(b));
  }
});

test('registration fails closed when the chain cannot be read', async () => {
  const res = await request({ chain_id: 1, address: VAULT },
    backend({ readVaultRecord: async () => { throw new Error('secret rpc detail'); },
      saveRegistration: async () => assert.fail('recorded without a chain read') }), {}, '/register');
  assert.equal(res.status, 503);
  assert.doesNotMatch(res.body, /secret/);
});

test('dependency methods survive being destructured out of the object', async () => {
  // The verifiers take `{ getWallet, readVault }` and call them by name, which
  // detaches them from the object. Anything reaching shared state through `this`
  // works in a method call and throws the moment it is passed that way — and the
  // only place that shows up is production. Call them exactly as the verifiers do.
  let chainIdCalls = 0;
  const deps = dependencies({ postgrestUrl: 'https://db.example', jwtSecret: 'k'.repeat(32), rpcUrls: { 1: 'https://rpc.example' } },
    async (url, options) => {
      const rpc = JSON.parse(options.body);
      if (rpc.method === 'eth_chainId') { chainIdCalls++; return { ok: true, json: async () => ({ result: '0x1' }) }; }
      if (rpc.method === 'eth_blockNumber') return { ok: true, json: async () => ({ result: '0x123' }) };
      const call = iface.parseTransaction({ data: rpc.params[0].data });
      return { ok: true, json: async () => ({ result: iface.encodeFunctionResult(call.name,
        [call.name === 'isOwner' ? true : call.name === 'threshold' ? 2 : 3]) }) };
    });
  const { readOwner, readVault } = deps;
  assert.equal(await readOwner(1, VAULT, address(1n)), true);
  assert.equal((await readVault(1, VAULT, address(1n), TX_HASH, 'ecdsa')).isOwner, true);
  // And the chain is confirmed once, not once per call.
  await readOwner(1, VAULT, address(2n));
  await readOwner(1, VAULT, address(1n));
  assert.equal(chainIdCalls, 1);
});

// ── CHAIN-CONFIRMED STATUS ────────────────────────────────────────
const EXEC_TOPIC = iface.getEvent('ExecutionSuccess').topicHash;
const EXEC_TX = '0x' + '7'.repeat(64);

test('an execution is confirmed by the vault own log, and the block is read back', async () => {
  const calls = [];
  const res = await request({ tx_id: WALLET_ID, state: 'executed', tx: EXEC_TX, block: 1 },
    backend({ saveConfirm: async w => { calls.push(w); } }), {}, '/confirm');
  assert.equal(res.status, 204);
  assert.equal(calls[0].fn, 'confirm_executed');
  assert.equal(calls[0].args.p_execution_tx, EXEC_TX);
  // 1234 from the receipt, not the 1 the caller offered.
  assert.equal(calls[0].args.p_block, 1234);
});

test('a receipt that did not execute this proposal is refused', async () => {
  const other = '0x' + '9'.repeat(64);
  const cases = [
    { status: 1, blockNumber: 5, logs: [] },                                          // no log
    { status: 0, blockNumber: 5, logs: [{ address: VAULT, topics: [EXEC_TOPIC, storedHash()] }] }, // reverted
    { status: 1, blockNumber: 5, logs: [{ address: TARGET, topics: [EXEC_TOPIC, storedHash()] }] },// wrong emitter
    { status: 1, blockNumber: 5, logs: [{ address: VAULT, topics: [EXEC_TOPIC, other] }] },        // wrong digest
    { status: 1, blockNumber: 5, logs: [{ address: VAULT, topics: [other, storedHash()] }] },      // wrong event
    null,                                                                                          // not mined
  ];
  for (const receipt of cases) {
    const res = await request({ tx_id: WALLET_ID, state: 'executed', tx: EXEC_TX },
      backend({ readReceipt: async () => receipt,
        saveConfirm: async () => assert.fail('unproven execution recorded') }), {}, '/confirm');
    assert.equal(res.status, 409, JSON.stringify(receipt));
  }
  // And an execution claim with no transaction to check is not a claim at all.
  const bare = await request({ tx_id: WALLET_ID, state: 'executed' },
    backend({ saveConfirm: async () => assert.fail('execution recorded with no receipt') }), {}, '/confirm');
  assert.equal(bare.status, 400);
});

test('a queue confirmation takes the eta from the vault, not the request', async () => {
  const calls = [];
  const res = await request({ tx_id: WALLET_ID, state: 'queued', eta: 1, block: 2, tx: EXEC_TX },
    backend({ readVaultState: async () => ({ nonce: 9, queuedEta: 1788958355n }),
      saveConfirm: async w => { calls.push(w); } }), {}, '/confirm');
  assert.equal(res.status, 204);
  assert.equal(calls[0].fn, 'confirm_queued');
  assert.equal(calls[0].args.p_eta, 1788958355);
});

test('a proposal the vault has not queued cannot be marked queued', async () => {
  const res = await request({ tx_id: WALLET_ID, state: 'queued' },
    backend({ readVaultState: async () => ({ nonce: 9, queuedEta: 0n }),
      saveConfirm: async () => assert.fail('unqueued proposal marked queued') }), {}, '/confirm');
  assert.equal(res.status, 409);
});

test('confirmation rejects bad shapes and settled proposals', async () => {
  for (const b of [{ tx_id: 'nope', state: 'executed', tx: EXEC_TX }, { tx_id: WALLET_ID, state: 'stale' },
                   { tx_id: WALLET_ID }, null]) {
    const res = await request(b, backend({ saveConfirm: async () => assert.fail('bad confirm stored') }), {}, '/confirm');
    assert.equal(res.status, 400, JSON.stringify(b));
  }
  for (const status of ['executed', 'cancelled', 'stale']) {
    const res = await request({ tx_id: WALLET_ID, state: 'executed', tx: EXEC_TX },
      backend({ getProposal: async () => ({ ...STORED, status }),
        saveConfirm: async () => assert.fail('settled proposal re-confirmed') }), {}, '/confirm');
    assert.equal(res.status, 400, status);
  }
});
