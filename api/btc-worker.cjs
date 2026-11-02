'use strict';

// Reading a stranger's PSBT is real work, done before anything proves who sent it. Here
// it runs off the event loop every API route shares, on a clock the parent enforces, so
// the worst request costs a few seconds of this thread and nothing of anyone else's.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parentPort } = require('node:worker_threads');

const context = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto });
context.globalThis = context;
for (const file of ['btc.min.js', 'bitcoin.js', 'bitcoin-tacit.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../dapp', file), 'utf8'), context);
const BV = context.BitcoinVault, BT = context.BitcoinTacit;

const ops = {
  admit({ descriptor, network, psbt }) {
    const policy = BV.parseDescriptor(descriptor, network);
    const view = BV.inspect(psbt, policy);
    if (!view.signedBy.length) throw Object.assign(new Error('A proposal needs an owner signature'), { refused: true });
    return { vault: BV.vaultId(policy), id: BV.proposalId(psbt) };
  },
  // Records a vault for the owner who signed, and offers it to the others named. A row is
  // marked confirmed only for the signer: handles are public, so anyone could name anyone.
  save(input) {
    const fail = message => Object.assign(new Error(message), { refused: true });
    const { network } = input, policy = BV.parseDescriptor(input.descriptor, network), vault = BV.vaultId(policy);
    const onVault = x => policy.paths.some(p => p.keys.some(k => BV.sameKey(k, x, network)));
    const signer = BV.decodeOwner(input.handle, network);
    if (!signer.proven) throw fail('A handle must be signed by its Ethereum address');
    if (!BV.verifyOwnerAuth(signer, network, `save:${vault}`, input.at, input.sig)) throw fail('Signature has expired or does not verify');
    if (!onVault(signer)) throw fail('That owner is not on this vault');
    const offered = [], seen = new Set([signer.evm]);
    for (const text of input.handles.slice(0, 40)) {
      let h;
      try { h = BV.decodeOwner(String(text), network); } catch (_) { continue; }
      if (h.proven && onVault(h) && !seen.has(h.evm)) { seen.add(h.evm); offered.push(h.evm); }
    }
    return { vault, signer: signer.evm, offered };
  },
  // An owner's record of the vault's note key, checked in full before it is stored.
  notekey({ network, descriptor, handle, at, sig, record }) {
    const fail = message => Object.assign(new Error(message), { refused: true });
    const policy = BV.parseDescriptor(descriptor, network), vault = BV.vaultId(policy);
    const signer = BV.decodeOwner(handle, network);
    if (!signer.proven) throw fail('A handle must be signed by its Ethereum address');
    if (!BV.verifyOwnerAuth(signer, network, `notekey:${vault}`, at, sig)) throw fail('Signature has expired or does not verify');
    if (!BT.verifyRecord(policy, record) || record.by !== BV.keyId(signer, network)) throw fail('That note key record does not check out');
    return { vault };
  },
  // A Tacit send, from an owner of the vault. What is inside is for the owners' pages to
  // check, with a note key this service never sees.
  tacsend({ network, descriptor, handle, at, sig, id }) {
    const policy = BV.parseDescriptor(descriptor, network), vault = BV.vaultId(policy);
    const signer = BV.decodeOwner(handle, network);
    if (!signer.proven || !BV.verifyOwnerAuth(signer, network, `tacsend:${vault}:${id}`, at, sig)) throw Object.assign(new Error('Signature has expired or does not verify'), { refused: true });
    if (!policy.paths.some(p => p.keys.some(k => BV.sameKey(k, signer, network)))) throw Object.assign(new Error('That owner is not on this vault'), { refused: true });
    return { vault };
  },
  merge({ descriptor, network, prior, psbt }) {
    return { psbt: BV.combine([prior, psbt], BV.parseDescriptor(descriptor, network)) };
  },
};

parentPort.on('message', ({ id, op, input }) => {
  try { parentPort.postMessage({ id, result: ops[op](input) }); }
  catch (error) { parentPort.postMessage({ id, error: String(error?.message || error) }); }
});
