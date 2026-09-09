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
// Metadata is not a vault operation and must never be confused for one: this is
// a distinct primary type, so an Execute signature can never be replayed as a
// rename and a rename can never be replayed as a transaction. `subject` is the
// owner a label belongs to, or the zero address when the value is a vault name.
const META_TYPES = { Metadata: [
  { name: 'vault', type: 'address' }, { name: 'subject', type: 'address' },
  { name: 'value', type: 'string' }, { name: 'issuedAt', type: 'uint64' },
] };
// Retracting a signature is not a metadata edit and must not share its type: a
// signature over one must never be presentable as the other.
const ACTION_TYPES = { Action: [
  { name: 'vault', type: 'address' }, { name: 'action', type: 'string' },
  { name: 'txHash', type: 'bytes32' }, { name: 'issuedAt', type: 'uint64' },
] };
// Proving an address in order to READ. A fourth primary type, unrelated to any
// vault, so a session signature cannot be presented as an operation on one.
const SESSION_TYPES = { Session: [
  { name: 'address', type: 'address' }, { name: 'issuedAt', type: 'uint64' },
] };
// How long a read session lasts. Long enough that an operator is not re-prompted
// while working, short enough that a token lifted off a machine stops being
// useful the same afternoon. It grants reading, never writing: every write is
// verified on its own terms regardless of any session.
const SESSION_TTL_SECONDS = 3600;
const ZERO = '0x0000000000000000000000000000000000000000';
// A signature that never expires is a standing permission to rewrite a label.
// Five minutes is long enough for a hardware wallet to be found and confirmed,
// and short enough that a captured one is worthless by the time it is read. A
// replay inside the window rewrites the same field with the same value.
const META_WINDOW_SECONDS = 300;
const iface = new ethers.Interface([
  'function isOwner(address) view returns (bool)',
  'function approved(address,bytes32) view returns (bool)',
  'function threshold() view returns (uint16)',
  'function ownerCount() view returns (uint16)',
  // Reconciliation reads both of these, and needs both. See verifyReconcile.
  'function nonce() view returns (uint32)',
  'function queued(bytes32) view returns (uint256)',
  // Registration derives the whole vault record from these rather than
  // accepting one. An address with no code answers none of them.
  'function getOwners() view returns (address[])',
  'function delay() view returns (uint32)',
  'function executor() view returns (address)',
  // Confirming an execution reads this out of the receipt. The vault emits it,
  // so it is proof regardless of who sent the transaction or whether it came
  // through an executor module.
  'event ExecutionSuccess(bytes32 indexed txHash, uint256 nonce)',
]);
const EXECUTION_SUCCESS_TOPIC = iface.getEvent('ExecutionSuccess').topicHash;
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

// No caller-controlled URLs, owner lists, or JWTs enter this boundary either.
// The signer is recovered, never supplied, and ownership is settled by the vault.
async function verifyMetadata(input, { getWallet, readOwner }, now = Date.now()) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Expected a metadata change');
  check(typeof input.wallet_id === 'string' && /^[0-9a-f-]{36}$/i.test(input.wallet_id), 'Invalid wallet id');
  check(input.kind === 'name' || input.kind === 'label', 'Unsupported metadata field');
  check(typeof input.signature === 'string' && /^0x[0-9a-f]{130}$/i.test(input.signature), 'An owner signature is required');
  check(/(1b|1c)$/i.test(input.signature), 'Noncanonical signature');
  check(Number.isInteger(input.issued_at) && input.issued_at > 0, 'Invalid issue time');
  // Both directions. A future timestamp would otherwise buy an unbounded window.
  check(Math.abs(Math.floor(now / 1000) - input.issued_at) <= META_WINDOW_SECONDS, 'Signature has expired');
  // The column ceilings in schema.sql, enforced before the write rather than as
  // a constraint violation the operator would see as a failed save.
  const limit = input.kind === 'name' ? 128 : 64;
  check(typeof input.value === 'string' && input.value.length <= limit, 'Value is too long');
  // A label is written against one owner; a name belongs to the vault itself.
  const subject = input.kind === 'label' ? input.subject : ZERO;
  check(typeof subject === 'string' && /^0x[0-9a-f]{40}$/i.test(subject), 'Invalid subject address');

  const wallet = await getWallet(input.wallet_id);
  check(wallet && /^0x[0-9a-f]{40}$/i.test(wallet.address), 'Wallet does not match');
  const vault = wallet.address.toLowerCase();
  const hash = ethers.TypedDataEncoder.hash(
    { name: 'Multisig', version: '1', chainId: wallet.chain_id, verifyingContract: vault },
    META_TYPES,
    { vault, subject: subject.toLowerCase(), value: input.value, issuedAt: input.issued_at },
  );
  let signer;
  try { signer = ethers.recoverAddress(hash, input.signature); } catch (_) {}
  check(signer, 'Signature could not be recovered');
  signer = signer.toLowerCase();

  // The database owner list is not proof; the vault is. Same rule as a proposal.
  if (!await readOwner(wallet.chain_id, vault, signer)) {
    throw new RequestError(403, 'Signer is not a current on-chain owner');
  }

  return input.kind === 'name'
    ? { fn: 'set_wallet_name', args: { p_wallet_id: input.wallet_id, p_name: input.value } }
    : { fn: 'set_owner_label', args: { p_wallet_id: input.wallet_id, p_address: subject.toLowerCase(), p_label: input.value } };
}

// Retracting one's own signature from a live proposal. The signer is recovered,
// never supplied, and the row deleted is the recovered signer's own — so this
// cannot be used to strip a co-signer, which the RPC it replaces allowed.
async function verifyAction(input, { getProposal, readOwner }, now = Date.now()) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Expected an action');
  check(typeof input.tx_id === 'string' && /^[0-9a-f-]{36}$/i.test(input.tx_id), 'Invalid transaction id');
  check(input.action === 'unsign', 'Unsupported action');
  check(typeof input.signature === 'string' && /^0x[0-9a-f]{130}$/i.test(input.signature), 'An owner signature is required');
  check(/(1b|1c)$/i.test(input.signature), 'Noncanonical signature');
  check(Number.isInteger(input.issued_at) && input.issued_at > 0, 'Invalid issue time');
  check(Math.abs(Math.floor(now / 1000) - input.issued_at) <= META_WINDOW_SECONDS, 'Signature has expired');

  // The vault and the digest come from the stored proposal, not the request, so
  // a signature cannot be aimed at a different vault than the one it names.
  const proposal = await getProposal(input.tx_id);
  check(proposal && /^0x[0-9a-f]{40}$/i.test(proposal.address || ''), 'Proposal not found');
  check(/^0x[0-9a-f]{64}$/i.test(proposal.tx_hash || ''), 'Proposal has no transaction hash');
  const vault = proposal.address.toLowerCase();
  const txHash = proposal.tx_hash.toLowerCase();
  const hash = ethers.TypedDataEncoder.hash(
    { name: 'Multisig', version: '1', chainId: proposal.chain_id, verifyingContract: vault },
    ACTION_TYPES,
    { vault, action: input.action, txHash, issuedAt: input.issued_at },
  );
  let signer;
  try { signer = ethers.recoverAddress(hash, input.signature); } catch (_) {}
  check(signer, 'Signature could not be recovered');
  signer = signer.toLowerCase();

  if (!await readOwner(proposal.chain_id, vault, signer)) {
    throw new RequestError(403, 'Signer is not a current on-chain owner');
  }

  return { fn: 'signed_remove_signature', args: { p_tx_id: input.tx_id, p_signer: signer } };
}

// Adding a co-signer's signature. This one needs no wallet prompt of its own:
// the signature IS the credential, and it is already in the request. The digest
// is rebuilt from the stored proposal's own fields rather than read from its
// tx_hash column, so a legacy row carrying a digest nobody verified cannot lend
// its authority to a signature over different terms.
async function verifySignature(input, { getProposal, readVault, readOwner }) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Expected a signature');
  check(typeof input.tx_id === 'string' && /^[0-9a-f-]{36}$/i.test(input.tx_id), 'Invalid transaction id');
  check(typeof input.signer === 'string' && /^0x[0-9a-f]{40}$/i.test(input.signer), 'Invalid signer');
  check(typeof input.signature === 'string' && /^0x[0-9a-f]{130}$/i.test(input.signature), 'A signature is required');
  const sigType = input.sig_type || 'ecdsa';
  check(sigType === 'ecdsa' || sigType === 'approval', 'Unsupported signature type');

  const p = await getProposal(input.tx_id);
  check(p && /^0x[0-9a-f]{40}$/i.test(p.address || ''), 'Proposal not found');
  // The SQL refuses these too. Refusing here as well keeps the reason specific,
  // and keeps a settled proposal from being reopened by a request that reached
  // the database at all.
  check(['proposed', 'executing', 'queued'].includes(p.status), 'Proposal is no longer open for signatures');
  check(typeof p.target === 'string' && /^0x[0-9a-f]{40}$/i.test(p.target), 'Proposal has no target');
  check(typeof p.call_data === 'string' && /^0x([0-9a-f]{2})*$/i.test(p.call_data), 'Proposal has no calldata');
  check(Number.isInteger(p.nonce) && p.nonce >= 0, 'Proposal has no nonce');
  const value = String(p.value);
  check(/^(0|[1-9][0-9]{0,77})$/.test(value), 'Proposal value is not an integer');

  const vault = p.address.toLowerCase();
  const signer = input.signer.toLowerCase();
  const hash = ethers.TypedDataEncoder.hash(
    { name: 'Multisig', version: '1', chainId: p.chain_id, verifyingContract: vault },
    TYPES,
    { target: p.target.toLowerCase(), value, data: p.call_data.toLowerCase(), nonce: p.nonce },
  );
  if (sigType === 'ecdsa') {
    check(/(1b|1c)$/i.test(input.signature), 'Noncanonical signature');
    let recovered;
    try { recovered = ethers.recoverAddress(hash, input.signature); } catch (_) {}
    check(recovered && recovered.toLowerCase() === signer, 'Signature does not match the signer');
  } else {
    check(input.signature.toLowerCase() === senderSlot(signer), 'Invalid approval slot');
  }
  // An ECDSA signature needs one fact: is this address an owner. An approval
  // slot proves nothing by itself and needs the vault's approved mapping too,
  // which has to be read at the same block as the ownership it accompanies.
  if (sigType === 'ecdsa') {
    if (!await readOwner(p.chain_id, vault, signer)) {
      throw new RequestError(403, 'Signer is not a current on-chain owner');
    }
  } else {
    const state = await readVault(p.chain_id, vault, signer, hash, sigType);
    if (!state.isOwner) throw new RequestError(403, 'Signer is not a current on-chain owner');
    if (!state.approved) throw new RequestError(403, 'Transaction has not been approved on chain');
  }

  return { fn: 'signed_add_signature', args: {
    p_tx_id: input.tx_id, p_signer: signer,
    p_signature: input.signature.toLowerCase(), p_sig_type: sigType } };
}

// Retiring a proposal the vault has moved past.
//
// cancel_tx and prune_tx are not owner actions and cannot be made into them: the
// client calls both from reconciliation, writing back what it just read from the
// chain, and loadVaultQueue prunes superseded rows in a loop. A wallet prompt
// there would fire on ordinary page loads.
//
// But what they assert is not an identity claim at all — it is a claim about the
// chain, and the chain can be asked. A proposal whose nonce the vault has
// already consumed can never execute, by anyone, ever. That is checkable without
// knowing who is calling, which is why this endpoint takes no signature and
// still cannot be used to retire a live proposal.
async function verifyReconcile(input, { getProposal, readVaultState }) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Expected a reconciliation');
  check(typeof input.tx_id === 'string' && /^[0-9a-f-]{36}$/i.test(input.tx_id), 'Invalid transaction id');
  check(input.state === 'cancelled' || input.state === 'stale', 'Unsupported state');

  const p = await getProposal(input.tx_id);
  check(p && /^0x[0-9a-f]{40}$/i.test(p.address || ''), 'Proposal not found');
  check(Number.isInteger(p.nonce) && p.nonce >= 0, 'Proposal has no nonce');
  check(['proposed', 'executing', 'queued'].includes(p.status), 'Proposal is already settled');
  check(typeof p.target === 'string' && /^0x[0-9a-f]{40}$/i.test(p.target), 'Proposal has no target');
  check(typeof p.call_data === 'string' && /^0x([0-9a-f]{2})*$/i.test(p.call_data), 'Proposal has no calldata');
  const value = String(p.value);
  check(/^(0|[1-9][0-9]{0,77})$/.test(value), 'Proposal value is not an integer');

  const vault = p.address.toLowerCase();
  // Rebuilt from the row's own fields, not read from its tx_hash column, so a
  // digest nobody verified cannot be used to ask about a different transaction.
  const hash = ethers.TypedDataEncoder.hash(
    { name: 'Multisig', version: '1', chainId: p.chain_id, verifyingContract: vault },
    TYPES,
    { target: p.target.toLowerCase(), value, data: p.call_data.toLowerCase(), nonce: p.nonce },
  );

  const state = await readVaultState(p.chain_id, vault, hash);
  check(Number.isInteger(state.nonce) && state.nonce >= 0, 'Vault nonce unavailable');

  // Both conditions, and the second is the one that matters.
  //
  // execute() advances the nonce whether it runs the call or queues it, so a
  // queued proposal ALWAYS reads as behind the vault's nonce — and it is still
  // fully executable, by executeQueued, at that original nonce. Retiring on the
  // nonce alone would therefore have retired precisely the live proposals this
  // endpoint exists to protect, and without a signature. The queue mapping is
  // what actually says whether the vault will still honour it.
  if (state.queuedEta !== 0n) {
    throw new RequestError(409, 'That proposal is queued on chain and can still execute');
  }
  if (p.nonce >= state.nonce) {
    throw new RequestError(409, 'That proposal can still execute at the vault current nonce');
  }
  return { fn: 'reconcile_tx', args: { p_tx_id: input.tx_id, p_state: input.state } };
}

// Recording a vault.
//
// register_wallet has to be reachable without proving anything — a vault is
// registered by whoever opens it, who may be reading rather than signing — so it
// could not be signature-gated and was left anonymous. That made it an
// unauthenticated row-creating endpoint on a 256 MB database with no ceiling on
// how many vaults may exist, which is a storage exhaustion attack with a rate
// limit in front of it rather than a defence.
//
// Nothing about a vault needs to be taken on trust, though: every field is
// readable from the contract. The caller now supplies an address and nothing
// else that matters, and an address with no code answers none of these calls, so
// fabricated vaults cannot be recorded at all. What remains registerable is the
// set of genuinely deployed multisigs, which is finite and costs gas to grow.
async function verifyRegistration(input, { readVaultRecord }) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Expected a registration');
  check(Number.isInteger(input.chain_id) && input.chain_id > 0, 'Invalid chain id');
  check(typeof input.address === 'string' && /^0x[0-9a-f]{40}$/i.test(input.address), 'Invalid vault address');
  check(input.name == null || (typeof input.name === 'string' && input.name.length <= 128), 'Name is too long');
  check(input.labels == null || (Array.isArray(input.labels) && input.labels.length <= 64
    && input.labels.every(l => l == null || (typeof l === 'string' && l.length <= 64))), 'Invalid labels');
  // Informational only, and bounded so they cannot be used as free storage.
  const salt = input.salt == null ? '0' : String(input.salt);
  check(/^(0|[1-9][0-9]{0,77})$/.test(salt), 'Invalid salt');
  const block = Number.isInteger(input.block) && input.block >= 0 ? input.block : 0;
  const tx = typeof input.tx === 'string' && /^0x[0-9a-f]{64}$/i.test(input.tx) ? input.tx.toLowerCase() : '';

  const vault = input.address.toLowerCase();
  const r = await readVaultRecord(input.chain_id, vault);
  check(Array.isArray(r.owners) && r.owners.length > 0, 'No multisig at that address on that chain');
  check(Number.isInteger(r.threshold) && r.threshold > 0, 'No multisig at that address on that chain');

  return { fn: 'register_wallet', args: {
    p_chain_id: input.chain_id, p_address: vault,
    // A real current owner, so register_wallet's own writer test is satisfied by
    // the chain rather than by a claim. Never the caller's address.
    p_deployer: r.owners[0].toLowerCase(),
    p_salt: salt,
    p_owners: r.owners.map(o => o.toLowerCase()),
    p_threshold: r.threshold, p_delay: r.delay, p_executor: r.executor.toLowerCase(),
    p_block: block, p_tx: tx,
    p_name: input.name ?? null, p_labels: input.labels ?? null,
    p_nonce: r.nonce,
  } };
}

// Confirming what the chain did with a proposal.
//
// mark_executed and mark_queued were the last writes taking a caller's address
// and checking it against the owner list. Like reconciliation they are not owner
// actions — the client observes the chain and writes back what it saw — so a
// prompt would be wrong, and like reconciliation what they assert can simply be
// asked of the chain.
//
// The two are checked differently because they claim different things. Queued is
// a question about current state: is this digest in the vault's queue. Executed
// is a question about history, and the vault's own ExecutionSuccess log is what
// answers it — emitted by the vault, so it holds whoever sent the transaction
// and whether it arrived through an executor module. Neither the block, the eta
// nor the transaction hash is taken from the request: they are read back.
async function verifyConfirm(input, { getProposal, readVaultState, readReceipt }) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Expected a confirmation');
  check(typeof input.tx_id === 'string' && /^[0-9a-f-]{36}$/i.test(input.tx_id), 'Invalid transaction id');
  check(input.state === 'executed' || input.state === 'queued', 'Unsupported state');

  const p = await getProposal(input.tx_id);
  check(p && /^0x[0-9a-f]{40}$/i.test(p.address || ''), 'Proposal not found');
  check(Number.isInteger(p.nonce) && p.nonce >= 0, 'Proposal has no nonce');
  check(typeof p.target === 'string' && /^0x[0-9a-f]{40}$/i.test(p.target), 'Proposal has no target');
  check(typeof p.call_data === 'string' && /^0x([0-9a-f]{2})*$/i.test(p.call_data), 'Proposal has no calldata');
  const value = String(p.value);
  check(/^(0|[1-9][0-9]{0,77})$/.test(value), 'Proposal value is not an integer');

  const vault = p.address.toLowerCase();
  const hash = ethers.TypedDataEncoder.hash(
    { name: 'Multisig', version: '1', chainId: p.chain_id, verifyingContract: vault },
    TYPES,
    { target: p.target.toLowerCase(), value, data: p.call_data.toLowerCase(), nonce: p.nonce },
  );

  if (input.state === 'queued') {
    check(['proposed', 'executing'].includes(p.status), 'Proposal is not awaiting a queue');
    const state = await readVaultState(p.chain_id, vault, hash);
    if (state.queuedEta === 0n) throw new RequestError(409, 'That proposal is not queued on chain');
    // The eta the vault holds, not the one the caller offered.
    return { fn: 'confirm_queued', args: {
      p_tx_id: input.tx_id, p_eta: Number(state.queuedEta),
      p_block: Number.isInteger(input.block) && input.block >= 0 ? input.block : 0,
      p_queue_tx: typeof input.tx === 'string' && /^0x[0-9a-f]{64}$/i.test(input.tx) ? input.tx.toLowerCase() : null,
    } };
  }

  check(['proposed', 'executing', 'queued'].includes(p.status), 'Proposal is already settled');
  check(typeof input.tx === 'string' && /^0x[0-9a-f]{64}$/i.test(input.tx), 'An execution transaction is required');
  const receipt = await readReceipt(p.chain_id, input.tx.toLowerCase());
  if (!receipt) throw new RequestError(409, 'That transaction is not mined');
  if (receipt.status !== 1) throw new RequestError(409, 'That transaction did not succeed');
  // The vault's own log, for this exact digest. A receipt that merely touched
  // the vault proves nothing about which proposal ran.
  const ran = (receipt.logs || []).some(l =>
    String(l.address || '').toLowerCase() === vault &&
    Array.isArray(l.topics) && l.topics.length >= 2 &&
    String(l.topics[0]).toLowerCase() === EXECUTION_SUCCESS_TOPIC.toLowerCase() &&
    String(l.topics[1]).toLowerCase() === hash.toLowerCase());
  if (!ran) throw new RequestError(409, 'That transaction did not execute this proposal');
  return { fn: 'confirm_executed', args: {
    p_tx_id: input.tx_id, p_block: receipt.blockNumber, p_execution_tx: input.tx.toLowerCase() } };
}

// Issuing a read session.
//
// The signature store is the one read that is not already public on chain, and
// SECURITY.md scopes its risk to "anyone reading the signature store": a
// threshold-sized set of signatures can be replayed into the other route,
// imposing the timelock on something that already reached quorum. World-readable
// bytes therefore promote the entire internet into the co-signer row of that
// table.
//
// This does not make the signer list private — who signed is largely inferable
// from on-chain approvals, and the count is what an observer actually wants for
// legitimate reasons. It makes the BYTES require a proven address.
//
// No chain call: whoever signed is who they are, and what they may read is
// decided by the database against the owner rows, not here. That keeps the
// cheapest and most frequent request on this service free of an RPC round trip.
async function verifySession(input, _deps, now = Date.now()) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Expected a session request');
  check(typeof input.address === 'string' && /^0x[0-9a-f]{40}$/i.test(input.address), 'Invalid address');
  check(typeof input.signature === 'string' && /^0x[0-9a-f]{130}$/i.test(input.signature), 'A signature is required');
  check(/(1b|1c)$/i.test(input.signature), 'Noncanonical signature');
  check(Number.isInteger(input.issued_at) && input.issued_at > 0, 'Invalid issue time');
  check(Math.abs(Math.floor(now / 1000) - input.issued_at) <= META_WINDOW_SECONDS, 'Signature has expired');
  check(Number.isInteger(input.chain_id) && input.chain_id > 0, 'Invalid chain id');

  const address = input.address.toLowerCase();
  const hash = ethers.TypedDataEncoder.hash(
    { name: 'Multisig', version: '1', chainId: input.chain_id },
    SESSION_TYPES,
    { address, issuedAt: input.issued_at },
  );
  let recovered;
  try { recovered = ethers.recoverAddress(hash, input.signature); } catch (_) {}
  check(recovered && recovered.toLowerCase() === address, 'Signature does not match the address');
  return address;
}

function serviceToken(secret, role = 'proposal_writer') {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ role, iat: now, exp: now + 30 });
  return data + '.' + createHmac('sha256', secret).update(data).digest('base64url');
}

function dependencies({ postgrestUrl, jwtSecret, rpcUrls }, fetcher = fetch) {
  // Closure scope, not a property, and deliberately so: the verifiers destructure
  // these methods out of the object — `const { readVault } = deps` — which
  // detaches them from any `this`. A cache reached through `this` works when the
  // object is called as a method and throws the moment one is passed by name,
  // which is how every one of them is actually used.
  const chainOk = new Set();
  // One message reaches the operator for every way this can fail — a sleeping
  // database, an RPC that rate-limited us, a JWT the storage layer rejected, and
  // a proposal the SQL refused on its merits all read as "unavailable". That is
  // the right answer to give a browser, which must not be told why a write was
  // refused in terms it could probe. It is the wrong answer to give whoever has
  // to fix it, and this service logs nothing, so the only evidence of a failed
  // proposal was the operator's console saying storage was unavailable while
  // storage was up. Say what actually happened, on the server, where it is safe.
  async function json(url, options, what) {
    let response;
    try {
      response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
    } catch (error) {
      console.error(`[${what}] request failed:`, error && error.message);
      throw new RequestError(503, 'Proposal storage or chain verification is unavailable');
    }
    if (!response.ok) {
      // Bounded, and never forwarded to the client — a 4xx body from PostgREST
      // carries the SQL function's own message, which names its checks.
      let body = '';
      try { body = (await response.text()).slice(0, 400); } catch (_) {}
      console.error(`[${what}] HTTP ${response.status}:`, body);
      throw new RequestError(503, 'Proposal storage or chain verification is unavailable');
    }
    return response.json();
  }
  // Verified once per chain per process rather than once per request. The RPC
  // map is read from the environment at startup and cannot change under a
  // running process, so asking every request whether the configured node still
  // serves the chain it served a moment ago bought nothing and cost a round trip
  // on the hot path. Scoped to this closure, so a second set of dependencies —
  // a test's — does not inherit the first one's answers.
  // The one place a verified write reaches PostgREST. The function name comes
  // from a verifier and never from a request, and the role travels with it so a
  // token minted to rename a vault cannot reach the RPC that deletes a
  // signature. Returns void: these RPCs answer 204 with no body.
  async function postRpc(fn, args, role) {
    const response = await fetcher(`${postgrestUrl}/rpc/${fn}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceToken(jwtSecret, role)}`,
      },
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      let body = '';
      try { body = (await response.text()).slice(0, 400); } catch (_) {}
      console.error(`[${fn}] HTTP ${response.status}:`, body);
      throw new RequestError(503, 'Metadata storage is unavailable');
    }
  }
  async function ensureChain(chainId, rpc) {
    if (chainOk.has(chainId)) return;
    const actual = await rpc('eth_chainId', []);
    if (BigInt(actual) !== BigInt(chainId)) throw new RequestError(503, 'Configured RPC serves the wrong chain');
    chainOk.add(chainId);
  }
  return {
    async getWallet(id) {
      const rows = await json(`${postgrestUrl}/wallets?select=chain_id,address&id=eq.${encodeURIComponent(id)}&limit=1`, undefined, 'getWallet');
      return rows[0];
    },
    // One eth_call, for the three endpoints whose only question is whether an
    // address is an owner right now.
    //
    // They were routed through readVault, which pins a block and then reads
    // isOwner, threshold and ownerCount together — five round trips for one
    // boolean, on every rename, relabel, unsign and added signature. Each
    // request holds one of thirty-two slots for as long as those take, so the
    // waste was not latency but capacity: this service is now on the path of
    // every write that used to go straight to the database, and it is one
    // instance. Four calls saved is roughly four times the concurrent writes it
    // can carry before it starts refusing them.
    //
    // No block pin, deliberately. A pin makes several reads agree with each
    // other, and there is only one read; 'latest' is the same question asked
    // more cheaply, and ownership can change after any verification anyway —
    // which is why the client re-checks against the chain on every load.
    async readOwner(chainId, address, who) {
      const url = rpcUrls[chainId];
      check(url, 'Unsupported chain');
      const rpc = async (method, params) => {
        const result = await json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, `rpc:${method}:chain${chainId}`);
        if (result.error || result.result === undefined) throw new RequestError(503, 'Chain verification failed');
        return result.result;
      };
      await ensureChain(chainId, rpc);
      const raw = await rpc('eth_call', [{ to: address, data: iface.encodeFunctionData('isOwner', [who]) }, 'latest']);
      try { return Boolean(iface.decodeFunctionResult('isOwner', raw)[0]); } catch (_) { return false; }
    },
    async readVault(chainId, address, proposer, hash, sigType) {
      const url = rpcUrls[chainId];
      check(url, 'Unsupported chain');
      async function rpc(method, params) {
        const result = await json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, `rpc:${method}:chain${chainId}`);
        if (result.error || result.result === undefined) {
          console.error(`[rpc:${method}:chain${chainId}] node returned:`, JSON.stringify(result).slice(0, 300));
          throw new RequestError(503, 'Chain verification failed');
        }
        return result.result;
      }
      // Still pinned to one block: this path reads four things that have to
      // agree with each other, and the chain check is amortised.
      const [, block] = await Promise.all([ensureChain(chainId, rpc), rpc('eth_blockNumber', [])]);
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
      }, body: JSON.stringify(proposal) }, 'saveProposal');
    },
    // The vault a proposal belongs to, so an action's typed data is built from
    // the stored row rather than from anything the request supplied.
    async getProposal(id) {
      const rows = await json(
        `${postgrestUrl}/transactions?select=tx_hash,chain_id,nonce,target,value,call_data,status,wallets(address)&id=eq.${encodeURIComponent(id)}&limit=1`,
        undefined, 'getProposal');
      const row = rows && rows[0];
      if (!row) return null;
      return {
        tx_hash: row.tx_hash, chain_id: row.chain_id, nonce: row.nonce,
        target: row.target, value: row.value, call_data: row.call_data, status: row.status,
        address: row.wallets && row.wallets.address,
      };
    },
    async saveAction({ fn, args }) {
      return postRpc(fn, args, 'action_writer');
    },
    // Returns the resulting signature count, which the dapp shows.
    // One eth_call, no block pin: the question is whether the vault has moved
    // past a nonce, and a slightly stale answer only ever refuses a write that
    // the next page load will ask for again.
    // The vault's nonce and this digest's queue entry, read at the same block so
    // the two cannot disagree about a proposal that queued between them.
    async readVaultState(chainId, address, hash) {
      const url = rpcUrls[chainId];
      check(url, 'Unsupported chain');
      const call = async (data, what) => {
        const result = await json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
            params: [{ to: address, data }, 'latest'] }) }, what);
        if (result.error || result.result === undefined) throw new RequestError(503, 'Chain verification failed');
        return result.result;
      };
      const [nonceRaw, queuedRaw] = await Promise.all([
        call(iface.encodeFunctionData('nonce'), `rpc:nonce:chain${chainId}`),
        call(iface.encodeFunctionData('queued', [hash]), `rpc:queued:chain${chainId}`),
      ]);
      return {
        nonce: Number(iface.decodeFunctionResult('nonce', nonceRaw)[0]),
        queuedEta: BigInt(iface.decodeFunctionResult('queued', queuedRaw)[0]),
      };
    },
    // Every field of a vault, read from the vault, at one block.
    async readVaultRecord(chainId, address) {
      const url = rpcUrls[chainId];
      check(url, 'Unsupported chain');
      const call = async (name, what) => {
        const result = await json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
            params: [{ to: address, data: iface.encodeFunctionData(name) }, 'latest'] }) }, what);
        // An address with no code returns '0x' rather than erroring, and that is
        // the answer this endpoint exists to act on: not a multisig.
        if (result.error || !result.result || result.result === '0x') return null;
        try { return iface.decodeFunctionResult(name, result.result)[0]; } catch (_) { return null; }
      };
      const [owners, threshold, delay, executor, nonce] = await Promise.all([
        call('getOwners', `rpc:getOwners:chain${chainId}`),
        call('threshold', `rpc:threshold:chain${chainId}`),
        call('delay', `rpc:delay:chain${chainId}`),
        call('executor', `rpc:executor:chain${chainId}`),
        call('nonce', `rpc:nonce:chain${chainId}`),
      ]);
      if (!owners || threshold == null) return { owners: null };
      return {
        owners: Array.from(owners), threshold: Number(threshold),
        delay: Number(delay ?? 0), executor: String(executor ?? ZERO),
        nonce: Number(nonce ?? 0),
      };
    },
    async saveRegistration({ fn, args }) {
      return json(`${postgrestUrl}/rpc/${fn}`, { method: 'POST', headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceToken(jwtSecret, 'registry_writer')}`,
      }, body: JSON.stringify(args) }, 'saveRegistration');
    },
    // One call. Receipts are only read to confirm an execution, which happens
    // once per proposal.
    async readReceipt(chainId, txHash) {
      const url = rpcUrls[chainId];
      check(url, 'Unsupported chain');
      const result = await json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }) },
        `rpc:receipt:chain${chainId}`);
      if (result.error) throw new RequestError(503, 'Chain verification failed');
      const r = result.result;
      if (!r) return null;
      return { status: Number(r.status), blockNumber: Number(r.blockNumber), logs: r.logs || [] };
    },
    readerToken(address, exp) {
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const data = encode({ alg: 'HS256', typ: 'JWT' }) + '.' +
        encode({ role: 'reader', address, iat: Math.floor(Date.now() / 1000), exp });
      return data + '.' + createHmac('sha256', jwtSecret).update(data).digest('base64url');
    },
    async saveConfirm({ fn, args }) {
      return postRpc(fn, args, 'action_writer');
    },
    async saveReconcile({ fn, args }) {
      return postRpc(fn, args, 'action_writer');
    },
    async saveSignature({ fn, args }) {
      return json(`${postgrestUrl}/rpc/${fn}`, { method: 'POST', headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceToken(jwtSecret, 'action_writer')}`,
      }, body: JSON.stringify(args) }, 'saveSignature');
    },
    // The function name is chosen by verifyMetadata/verifyAction, never by the
    // request, so this cannot be steered at another RPC by anything a caller
    // sends. The role travels with it for the same reason: a token minted to
    // rename a vault must not reach the one that deletes a signature.
    async saveMetadata({ fn, args }, role = 'metadata_writer') {
      return postRpc(fn, args, role);
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
    if (!['/proposals', '/metadata', '/action', '/signature', '/reconcile', '/register', '/confirm', '/session'].includes(req.url)) { res.writeHead(404); res.end(); return; }
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
      if (req.url === '/metadata') {
        await deps.saveMetadata(await verifyMetadata(input, deps));
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/action') {
        await deps.saveAction(await verifyAction(input, deps));
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/register') {
        const id = await deps.saveRegistration(await verifyRegistration(input, deps));
        if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new RequestError(503, 'Vault was not registered');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(id));
        return;
      }
      if (req.url === '/session') {
        const address = await verifySession(input, deps);
        const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
        // A reader token. It carries the proven address and nothing else, and
        // the `reader` role holds SELECT and no write grant at all — so a stolen
        // session cannot be turned into a write even against the vaults it can
        // read.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: deps.readerToken(address, exp), address, exp }));
        return;
      }
      if (req.url === '/confirm') {
        await deps.saveConfirm(await verifyConfirm(input, deps));
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/reconcile') {
        await deps.saveReconcile(await verifyReconcile(input, deps));
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/signature') {
        const count = await deps.saveSignature(await verifySignature(input, deps));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(typeof count === 'number' ? count : null));
        return;
      }
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

module.exports = { verifyProposal, verifyMetadata, verifyAction, verifySignature, verifyReconcile, verifyRegistration, verifyConfirm, verifySession, createHandler, dependencies, serviceToken, senderSlot, ethers, TYPES, META_TYPES, ACTION_TYPES, SESSION_TYPES, iface };
