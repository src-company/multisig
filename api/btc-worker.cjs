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
for (const file of ['btc.min.js', 'bitcoin.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../dapp', file), 'utf8'), context);
const BV = context.BitcoinVault;

const ops = {
  admit({ descriptor, network, psbt }) {
    const policy = BV.parseDescriptor(descriptor, network);
    const view = BV.inspect(psbt, policy);
    if (!view.signedBy.length) throw Object.assign(new Error('A proposal needs an owner signature'), { refused: true });
    return { vault: BV.vaultId(policy), id: BV.proposalId(psbt) };
  },
  merge({ descriptor, network, prior, psbt }) {
    return { psbt: BV.combine([prior, psbt], BV.parseDescriptor(descriptor, network)) };
  },
};

parentPort.on('message', ({ id, op, input }) => {
  try { parentPort.postMessage({ id, result: ops[op](input) }); }
  catch (error) { parentPort.postMessage({ id, error: String(error?.message || error) }); }
});
