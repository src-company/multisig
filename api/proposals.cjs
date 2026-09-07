'use strict';

// The same pinned crypto implementation used by the dapp, without an npm install.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHmac } = require('node:crypto');
const { createServer } = require('node:http');
const context = vm.createContext({ TextEncoder, TextDecoder, Uint8Array });
context.window = context;
vm.runInContext(fs.readFileSync(path.join(__dirname, '../dapp/ethers.slim.min.js'), 'utf8'), context);
const ethers = context.ethers;
const TYPES = { Execute: [
  { name: 'target', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' }, { name: 'nonce', type: 'uint32' },
] };
const iface = new ethers.Interface([
  'function isOwner(address) view returns (bool)',
  'function approved(address,bytes32) view returns (bool)',
  'function threshold() view returns (uint16)',
  'function ownerCount() view returns (uint16)',
]);
const BODY_LIMIT = 72 * 1024;
class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function check(ok, message) { if (!ok) throw new RequestError(400, message); }
function senderSlot(address) {
  return '0x' + address.slice(2).toLowerCase().padStart(64, '0') + '0'.repeat(64) + '00';
}

// No caller-controlled URLs, owner lists, or JWTs enter this boundary.
async function verifyProposal(input, { getWallet, readVault }) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Expected a proposal');
  check(typeof input.p_wallet_id === 'string' && /^[0-9a-f-]{36}$/i.test(input.p_wallet_id), 'Invalid wallet id');
  check(Number.isInteger(input.p_chain_id) && input.p_chain_id > 0, 'Invalid chain id');
  check(Number.isInteger(input.p_nonce) && input.p_nonce >= 0 && input.p_nonce <= 2147483647, 'Invalid nonce');
  check(typeof input.p_target === 'string' && /^0x[0-9a-f]{40}$/i.test(input.p_target), 'Invalid target');
  check(typeof input.p_value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(input.p_value), 'Value must be an integer string');
  check(BigInt(input.p_value) < (1n << 256n), 'Value exceeds uint256');
  check(typeof input.p_call_data === 'string' && /^0x([0-9a-f]{2})*$/i.test(input.p_call_data) && input.p_call_data.length <= 65536, 'Invalid calldata');
  check(typeof input.p_tx_hash === 'string' && /^0x[0-9a-f]{64}$/i.test(input.p_tx_hash), 'Invalid transaction hash');
  check(typeof input.p_proposed_by === 'string' && /^0x[0-9a-f]{40}$/i.test(input.p_proposed_by), 'Invalid proposer');
  check(input.p_description == null || (typeof input.p_description === 'string' && input.p_description.length <= 512), 'Description is too long');
  check(typeof input.p_signature === 'string' && /^0x[0-9a-f]{130}$/i.test(input.p_signature), 'A proposer signature is required');
  const sigType = input.p_sig_type || 'ecdsa';
  check(sigType === 'ecdsa' || sigType === 'approval', 'Unsupported signature type');

  const wallet = await getWallet(input.p_wallet_id);
  check(wallet && wallet.chain_id === input.p_chain_id && /^0x[0-9a-f]{40}$/i.test(wallet.address), 'Wallet or chain does not match');
  const proposer = input.p_proposed_by.toLowerCase();
  const hash = ethers.TypedDataEncoder.hash(
    { name: 'Multisig', version: '1', chainId: wallet.chain_id, verifyingContract: wallet.address.toLowerCase() },
    TYPES,
    { target: input.p_target.toLowerCase(), value: input.p_value, data: input.p_call_data, nonce: input.p_nonce },
  );
  check(hash === input.p_tx_hash.toLowerCase(), 'Transaction hash does not match the proposal');
  if (sigType === 'ecdsa') {
    check(/(1b|1c)$/i.test(input.p_signature), 'Noncanonical signature');
    let recovered;
    try { recovered = ethers.recoverAddress(hash, input.p_signature); } catch (_) {}
    check(recovered && recovered.toLowerCase() === proposer, 'Signature does not match the proposer');
  } else {
    // A sender slot alone proves nothing. Only the vault's approved mapping does.
    check(input.p_signature.toLowerCase() === senderSlot(proposer), 'Invalid approval slot');
  }
  const state = await readVault(wallet.chain_id, wallet.address.toLowerCase(), proposer, hash, sigType);
  if (!state.isOwner) throw new RequestError(403, 'Proposer is not a current on-chain owner');
  if (sigType === 'approval' && !state.approved) throw new RequestError(403, 'Transaction has not been approved on chain');
  check(Number.isInteger(input.p_threshold) && input.p_threshold >= state.threshold && input.p_threshold <= state.ownerCount,
    'Invalid proposal threshold');
  return {
    p_wallet_id: input.p_wallet_id, p_chain_id: wallet.chain_id, p_nonce: input.p_nonce,
    p_target: input.p_target.toLowerCase(), p_value: input.p_value, p_call_data: input.p_call_data.toLowerCase(),
    p_tx_hash: hash, p_threshold: input.p_threshold, p_proposed_by: proposer,
    p_description: input.p_description ?? null, p_signature: input.p_signature.toLowerCase(), p_sig_type: sigType,
  };
}

function serviceToken(secret) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ role: 'proposal_writer', iat: now, exp: now + 30 });
  return data + '.' + createHmac('sha256', secret).update(data).digest('base64url');
}

function dependencies({ postgrestUrl, jwtSecret, rpcUrls }, fetcher = fetch) {
  async function json(url, options) {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new RequestError(503, 'Proposal storage or chain verification is unavailable');
    return response.json();
  }
  return {
    async getWallet(id) {
      const rows = await json(`${postgrestUrl}/wallets?select=chain_id,address&id=eq.${encodeURIComponent(id)}&limit=1`);
      return rows[0];
    },
    async readVault(chainId, address, proposer, hash, sigType) {
      const url = rpcUrls[chainId];
      check(url, 'Unsupported chain');
      async function rpc(method, params) {
        const result = await json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (result.error || result.result === undefined) throw new RequestError(503, 'Chain verification failed');
        return result.result;
      }
      const [actualChain, block] = await Promise.all([rpc('eth_chainId', []), rpc('eth_blockNumber', [])]);
      if (BigInt(actualChain) !== BigInt(chainId)) throw new RequestError(503, 'Configured RPC serves the wrong chain');
      async function call(name, args = []) {
        const result = await rpc('eth_call', [{ to: address, data: iface.encodeFunctionData(name, args) }, block]);
        return iface.decodeFunctionResult(name, result)[0];
      }
      const [isOwner, threshold, ownerCount, approved] = await Promise.all([
        call('isOwner', [proposer]), call('threshold'), call('ownerCount'),
        sigType === 'approval' ? call('approved', [proposer, hash]) : false,
      ]);
      return { isOwner, threshold: Number(threshold), ownerCount: Number(ownerCount), approved };
    },
    async saveProposal(proposal) {
      return json(`${postgrestUrl}/rpc/propose_tx`, { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${serviceToken(jwtSecret)}`,
      }, body: JSON.stringify(proposal) });
    },
  };
}

function createHandler(deps, allowedOrigins = []) {
  let active = 0;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.url === '/health' && req.method === 'GET') { res.writeHead(200); res.end('ok'); return; }
    if (req.url !== '/proposals') { res.writeHead(404); res.end(); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (active >= 32) { res.writeHead(503); res.end(); return; }
    active++;
    try {
      check(/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''), 'Expected application/json');
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > BODY_LIMIT) throw new RequestError(413, 'Proposal is too large');
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (_) { throw new RequestError(400, 'Invalid JSON'); }
      const proposal = await verifyProposal(input, deps);
      const id = await deps.saveProposal(proposal);
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new RequestError(503, 'Proposal was not saved');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(id));
    } catch (error) {
      res.writeHead(error.status || 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: error.status ? error.message : 'Proposal verification is unavailable' }));
    } finally { active--; }
  };
}

if (require.main === module) {
  const { PGRST_URL, PGRST_JWT_SECRET, PROPOSAL_RPC_URLS, PROPOSAL_ORIGINS, PORT = '3000' } = process.env;
  if (!PGRST_URL || !PGRST_JWT_SECRET || PGRST_JWT_SECRET.length < 32 || !PROPOSAL_RPC_URLS || !PROPOSAL_ORIGINS)
    throw new Error('Configure PGRST_URL, PGRST_JWT_SECRET, PROPOSAL_RPC_URLS and PROPOSAL_ORIGINS');
  const rpcUrls = JSON.parse(PROPOSAL_RPC_URLS);
  for (const url of [PGRST_URL, ...Object.values(rpcUrls)]) {
    if (!/^https:\/\//.test(url)) throw new Error('Backend URLs must use HTTPS');
  }
  const server = createServer(createHandler(dependencies({ postgrestUrl: PGRST_URL.replace(/\/$/, ''), jwtSecret: PGRST_JWT_SECRET, rpcUrls }), PROPOSAL_ORIGINS.split(',')));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(Number(PORT), '0.0.0.0');
}

module.exports = { verifyProposal, createHandler, dependencies, serviceToken, senderSlot, ethers, TYPES, iface };
