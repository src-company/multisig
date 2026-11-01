'use strict';
// Bitcoin vaults: k-of-n spending with no contract. No DOM and no network state
// in here — bitcoin-app.js is the page, and the tests drive this file directly
// against a real Bitcoin Core.
//
// There is nothing to deploy on Bitcoin, so a vault is not a thing on chain. It
// is a policy, and the address is a hash of that policy. That one fact accounts
// for every way this file differs from Multisig.sol:
//
//   - The owners cannot be read back from the chain. Until the first spend
//     nothing public says who they are, so the descriptor IS the vault, and an
//     owner who loses it can no longer spend even with every key to hand.
//   - A vault is many addresses, not one. Each owner is an extended key, and
//     receive and change each walk their own chain, so coins do not pile up on one
//     address, and because that is the only shape hardware wallets will sign for.
//   - Owners and thresholds cannot change. A new policy is a new address, and
//     changing owners means sweeping the coins to it.
//   - There is no nonce. A signature names the coins it spends, so replay is
//     impossible and two proposals over the same coin cannot both land.
//   - There is no queue, because there is no state to hold an ETA. See PATHS.
//
// The shape is the one Bitcoin Core calls tr(H,multi_a(...)): a taproot output
// whose key path is provably unspendable, so every spend goes through a script
// that shows k signatures. Each owner signs alone, in any order, whenever they
// like, which is what lets proposals collect signatures the way the EVM side
// does. MuSig2 or FROST would make the spend smaller and quieter, but both need
// signers online together for nonces, and an audited threshold signer in a
// browser does not exist yet.

(function(root){

const { Transaction, Script, Address, OutScript, HDKey, NETWORK, TEST_NETWORK, TAPROOT_UNSPENDABLE_KEY, p2tr, p2pkh, p2wpkh, p2sh, schnorr, secp256k1, sha256, keccak_256, bech32m, hex, base64 } = root.btc;

// signet shares testnet's address format, so TEST_NETWORK is right for it.
// `owner` on the handle is deliberately different per network: a key pasted from
// the wrong network is refused at the paste, not discovered at the first spend.
const XPUB = { private: 0x0488ade4, public: 0x0488b21e }, TPUB = { private: 0x04358394, public: 0x043587cf };
const NETWORKS = {
  mainnet: { name: 'mainnet', params: NETWORK,      owner: 'msig',  versions: XPUB, coin: 0, explorer: 'https://mempool.space',
             api: ['https://mempool.space/api', 'https://blockstream.info/api'] },
  signet:  { name: 'signet',  params: TEST_NETWORK, owner: 'tmsig', versions: TPUB, coin: 1, explorer: 'https://mempool.space/signet',
             api: ['https://mempool.space/signet/api', 'https://blockstream.info/signet/api'] },
};
const net = n => { if(!Object.hasOwn(NETWORKS, n)) throw new Error(`unknown network ${n}`); return NETWORKS[n]; };

const MAX_OWNERS = 20;
const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const MAX_OLDER = 0xffff;        // BIP-68 keeps 16 bits of blocks
const DUST = 546;
const MAX_FEE_RATE = 1000;       // sat/vB. A typo here spends the vault on fees.
const MAX_VSIZE = 95000;         // nodes will not relay a transaction past 100,000 vbytes
const MAX_INPUTS = 400, MAX_OUTPUTS = 32;
const FINAL_RBF = 0xfffffffd;
const HARDENED = 0x80000000;
const GAP = 20;                  // BIP-44's gap limit: unused addresses before a scan stops
const MAX_INDEX = 2000;          // past this a scan stops, and nothing is called change
const COOLDOWN_MS = 60000, TIMEOUT_MS = 8000;
const te = new TextEncoder();

// The unspendable internal key, as an extended key. BIP-388 has no way to write the
// bare BIP-341 point H, so a wallet policy needs it as an xpub. The chain code is
// public and fixed, which keeps it provable: anyone can check that every child is H
// plus a known tweak, and so that no one has its private key.
const numsKey = network => new HDKey({ publicKey: hex.decode('02' + hex.encode(TAPROOT_UNSPENDABLE_KEY)), chainCode: new Uint8Array(32), versions: net(network).versions });

// ── OWNERS ─────────────────────────────────────────────────
// An Ethereum address is a hash and a Bitcoin script needs a key, so an owner on
// Bitcoin has to hand one over. The handle is built the way tacit1 is: bech32m
// over [version][flags][lanes in flag-bit order], the lane bits saying what is
// present. 0x01 is the Bitcoin key and is required: fingerprint, account path, chain
// code and public key. 0x02 is the Ethereum address the key belongs to, so one
// person reads as one owner on every chain. Alone it is a label and proves nothing.
// 0x04 is that address's signature over this key, which is what makes it a fact, and
// the only form mirror() accepts. 0x08 is a Bitcoin wallet's address and that wallet's
// signature naming the Ethereum address, so an owner who came with UniSat can be found
// by their bc1… address. Bits above those are reserved: later lanes follow
// the known ones, so an old reader takes what it knows and ignores the rest. Unlike
// tacit1 there is no scan key and no pool key, because a vault receives at its own
// addresses.
//
// Owners from a hardware wallet paste the text every descriptor tool already
// prints, [fingerprint/path]xpub, so they need no handle at all.
const OWNER_VERSION = 0, LANE_BTC = 1, LANE_EVM = 2, LANE_PROOF = 4, LANE_WALLET = 8, LANE_KEY = 16;

const pathText = path => path.map(n => n >= HARDENED ? `${n - HARDENED}h` : `${n}`).join('/');
const parsePath = text => text ? text.split('/').map(p => {
  const m = /^(\d+)(h?)$/.exec(p);
  if(!m || +m[1] >= HARDENED) throw new Error('bad derivation path');
  return +m[1] + (m[2] ? HARDENED : 0);
}) : [];
const originText = o => `[${o.fingerprint}${o.path.length ? '/' + pathText(o.path) : ''}]${o.xpub}`;

// Every way a key enters comes through here, so a key is checked the same way
// whichever door it used: on the curve, for this network, and at the depth its path
// claims. A signer finds its key by that path, so a wrong one is a key that can
// never sign.
function ownerOf({ network, fingerprint, path, xpub, evm = null }){
  let k;
  try { k = HDKey.fromExtendedKey(xpub, net(network).versions); }
  catch(_) { throw new Error(`not a ${network} extended public key`); }
  if(k.privateKey) throw new Error('that is a private key. Never paste it anywhere.');
  if(!/^[0-9a-f]{8}$/.test(fingerprint)) throw new Error('bad key fingerprint');
  if(k.depth !== path.length || (path.length && path[path.length - 1] !== k.index)) throw new Error('the key path does not match the key');
  if(k.depth > 253) throw new Error('that key is too deep to derive addresses from');
  return { fingerprint, path, xpub, evm };
}

function encodeOwner({ network, fingerprint, path, xpub, evm, proof, wallet, possession }){
  ownerOf({ network, fingerprint, path, xpub });
  const k = HDKey.fromExtendedKey(xpub, net(network).versions);
  let flags = LANE_BTC;
  // Parent fingerprint and child number are there to rebuild the xpub byte for byte,
  // so the same key is the same text however it arrived.
  const parts = [new Uint8Array([OWNER_VERSION, 0]), hex.decode(fingerprint), new Uint8Array([path.length]), ...path.map(u32),
    k.chainCode, k.publicKey, u32(k.parentFingerprint), u32(k.index)];
  if(evm){
    if(!/^0x[0-9a-fA-F]{40}$/.test(evm)) throw new Error('not an Ethereum address');
    parts.push(hex.decode(evm.slice(2).toLowerCase())); flags |= LANE_EVM;
    if(proof){ parts.push(hex.decode(proof.replace(/^0x/, '').toLowerCase())); flags |= LANE_PROOF; }
    if(wallet){
      if(!proof) throw new Error('a wallet link needs the Ethereum proof beside it');
      const a = te.encode(wallet.address), sig = base64.decode(wallet.signature);
      if(a.length > 90 || sig.length !== 65) throw new Error('cannot use that wallet signature');
      parts.push(new Uint8Array([a.length]), a, sig); flags |= LANE_WALLET;
    }
    if(possession){
      if(!proof) throw new Error('a key proof needs the Ethereum proof beside it');
      parts.push(hex.decode(possession)); flags |= LANE_KEY;
    }
  }
  const body = concat(...parts);
  body[1] = flags;
  return bech32m.encode(net(network).owner, bech32m.toWords(body), false);
}
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };

function decodeOwner(text, network){
  const s = String(text).trim();
  const m = /^\[([0-9a-fA-F]{8})((?:\/\d+['h]?)*)\]([1-9A-HJ-NP-Za-km-z]+)$/.exec(s);
  if(m) return ownerOf({ network, fingerprint: m[1].toLowerCase(), path: parsePath(m[2].slice(1).replace(/'/g, 'h')), xpub: m[3] });
  if(/^[xt]pub/.test(s)) throw new Error('that key has no origin. Paste it as [fingerprint/path]key, or a hardware wallet cannot find it.');
  let d;
  try { d = bech32m.decode(s, false); } catch(_) { throw new Error('not an owner handle or a key'); }
  if(d.prefix !== net(network).owner) throw new Error(`that owner is for another network: expected ${net(network).owner}1…`);
  const b = bech32m.fromWords(d.words);
  if(b.length < 7 || b[0] !== OWNER_VERSION) throw new Error('unsupported owner handle');
  if(!(b[1] & LANE_BTC)) throw new Error('owner handle has no Bitcoin key');
  const fingerprint = hex.encode(b.subarray(2, 6)), depth = b[6], at = 7 + 4 * depth;
  if((b[1] & LANE_PROOF) && !(b[1] & LANE_EVM)) throw new Error('owner handle has a proof of no address');
  if((b[1] & LANE_WALLET) && !(b[1] & LANE_PROOF)) throw new Error('owner handle has a wallet link with no proof');
  let want = at + 32 + 33 + 8 + (b[1] & LANE_EVM ? 20 : 0) + (b[1] & LANE_PROOF ? 65 : 0);
  const walletAt = want;
  if(b[1] & LANE_WALLET) want += 1 + (b[walletAt] ?? 0) + 65;
  const keyAt = want;
  if(b[1] & LANE_KEY) want += 64;
  if(b[1] & ~(LANE_BTC | LANE_EVM | LANE_PROOF | LANE_WALLET | LANE_KEY) ? b.length < want : b.length !== want) throw new Error('owner handle has the wrong length');
  const dv = new DataView(b.buffer, b.byteOffset), path = [];
  for(let i = 0; i < depth; i++) path.push(dv.getUint32(7 + 4 * i));
  let k;
  try {
    k = new HDKey({ versions: net(network).versions, depth, parentFingerprint: dv.getUint32(at + 65), index: dv.getUint32(at + 69),
      chainCode: b.slice(at, at + 32), publicKey: b.slice(at + 32, at + 65) });
  } catch(_) { throw new Error('owner handle holds a bad key'); }
  const evm = b[1] & LANE_EVM ? '0x' + hex.encode(b.subarray(at + 73, at + 93)) : null;
  const owner = ownerOf({ network, fingerprint, path, xpub: k.publicExtendedKey, evm });
  if(b[1] & LANE_PROOF){
    if(evmSigner(bindingMessage(network, owner), b.subarray(at + 93, at + 158)) !== evm) throw new Error('owner handle was not signed by the address it names');
    owner.proven = true;
  }
  if(b[1] & LANE_WALLET){
    const len = b[walletAt], address = new TextDecoder().decode(b.subarray(walletAt + 1, walletAt + 1 + len));
    const sig = b.subarray(walletAt + 1 + len, walletAt + 1 + len + 65);
    if(!bitcoinSigners(linkMessage(network, evm), sig, network).includes(address)) throw new Error('owner handle was not signed by the Bitcoin wallet it names');
    owner.wallet = address;
  }
  // The address signing for the key is half of it, and anyone can sign for a key they
  // saw. This half is the key signing for the address, which only its holder can do.
  if(b[1] & LANE_KEY){
    const sig = b.subarray(keyAt, keyAt + 64);
    if(!(b[1] & LANE_PROOF) || !schnorr.verify(sig, possessionHash(network, evm), k.publicKey.subarray(1))) throw new Error('owner handle has a bad key proof');
    owner.possession = hex.encode(sig);
    owner.possessed = true;
  }
  return owner;
}
const possessionHash = (network, evm) => sha256(concat(te.encode('multisig-owner-possession-v1\0'), te.encode(net(network).name), hex.decode(evm.slice(2))));
function signPossession(signer, network, evm){
  const account = signer.derive(`m/87'/${net(network).coin}'/0'`), sig = hex.encode(schnorr.sign(possessionHash(network, evm), account.privateKey));
  account.wipePrivateData();
  return sig;
}

// The embedded key. A wallet that speaks Ethereum cannot produce a BIP-340
// signature over a Bitcoin sighash, so, as Tacit does, the wallet signs one fixed
// message and the seed is a hash of the signature. Same account, same key, on any
// device, with nothing to back up beyond the wallet. Two differences from Tacit,
// both on purpose. The text is ours, because reusing Tacit's would make the
// multisig key and the Tacit key the same key. And it is its own key per network.
//
// What this costs has to be said where it is used: the key is in this page's
// memory while it signs, so a hardware wallet protects the derivation and not the
// spend, and any site that talks an owner into signing this text has that key.
function ownerMessage(network){
  return [
    'Multisig Bitcoin owner key',
    '',
    'Signing this creates your Bitcoin owner key. Anyone who has this signature can sign as you on every Bitcoin vault this key owns.',
    '',
    'Sign it only in a Multisig app you trust. Every Multisig app asks for exactly this message.',
    '',
    `network: ${net(network).name}`,
    'version: 1',
  ].join('\n');
}

// What an Ethereum account signs to say a Bitcoin key is its own. Separate from the
// message above on purpose: that signature is the key and must never leave the page.
// This one is meant to be published, and is worth nothing to anyone who copies it.
function bindingMessage(network, owner){
  return [
    'Multisig Bitcoin owner link',
    '',
    'This makes the key below your Bitcoin owner key. Whoever holds that key can sign as you on Bitcoin vaults built from your address.',
    '',
    'Sign this only in a Multisig app you trust, and only for a key that app just made for you.',
    '',
    `network: ${net(network).name}`,
    `key: ${originText(owner)}`,
    'version: 2',
  ].join('\n');
}
// EIP-191, the hash personal_sign signs.
const evmMessageHash = text => {
  const msg = te.encode(text);
  return keccak_256(concat(te.encode(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
};
const evmAddressOf = uncompressed => '0x' + hex.encode(keccak_256(uncompressed.subarray(1)).subarray(12));
// Wallets give v as 27/28 or 0/1. Returns null for a signature that recovers nothing.
function evmSigner(text, sig){
  if(sig.length !== 65) return null;
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  if(v > 1) return null;
  try {
    const pub = secp256k1.recoverPublicKey(concat(new Uint8Array([v]), sig.subarray(0, 64)), evmMessageHash(text), { prehash: false });
    return evmAddressOf(secp256k1.Point.fromBytes(pub).toBytes(false));
  } catch(_) { return null; }
}

// A Bitcoin wallet's owner. UniSat cannot make the signature an Ethereum contract
// verifies, so, as Tacit does, the wallet signs one fixed message and everything comes
// from that: the Bitcoin owner key on BIP-87 as usual, and an Ethereum key on the
// standard path, which sits on an Ethereum multisig as an ordinary owner. One seed
// across networks, because the 0x address must be one address on every chain.
function walletMessage(){
  return [
    'Multisig wallet key',
    '',
    'Signing this creates your multisig keys for Bitcoin and Ethereum. Anyone who has this signature can sign as you on every vault these keys own.',
    '',
    'Sign it only in a Multisig app you trust. Every Multisig app asks for exactly this message.',
    '',
    'version: 1',
  ].join('\n');
}
function linkMessage(network, evm){
  return [
    'Multisig Bitcoin wallet link',
    '',
    'This links your Bitcoin wallet to a multisig owner. It cannot move funds.',
    '',
    `network: ${net(network).name}`,
    `ethereum: ${evm}`,
    'version: 1',
  ].join('\n');
}
// r and s alone, low-s, so the header a wallet picks for its address type cannot
// change the key. Anything else, such as a BIP-322 witness, is hashed as it came.
function canonicalWalletSignature(b64){
  const raw = base64.decode(b64);
  if(raw.length !== 65) return raw;
  const out = raw.slice(1), s = BigInt('0x' + hex.encode(out.subarray(32)));
  if(s > CURVE_N / 2n) out.set(hex.decode((CURVE_N - s).toString(16).padStart(64, '0')), 32);
  return out;
}
function keyFromWalletSignature(b64, network){
  const n = net(network), seed = sha256(concat(te.encode('multisig-wallet-v1\0'), canonicalWalletSignature(b64)));
  const evmKey = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0"), evmPriv = evmKey.privateKey.slice();
  evmKey.wipePrivateData();
  const signer = HDKey.fromMasterSeed(seed, n.versions), account = signer.derive(`m/87'/${n.coin}'/0'`);
  const xpub = account.publicExtendedKey;
  account.wipePrivateData();
  const pub = secp256k1.Point.fromBytes(secp256k1.getPublicKey(evmPriv)).toBytes(false);
  return { signer, evmPriv, evm: evmAddressOf(pub), owner: { fingerprint: fingerprintOf(signer), path: ownPath(network), xpub, evm: null } };
}
// Signs as an Ethereum wallet does, from a key held here.
const evmSignHash = (hash, priv) => {
  const r = secp256k1.sign(hash, priv, { prehash: false, format: 'recovered' });
  return '0x' + hex.encode(r.subarray(1)) + (r[0] + 27).toString(16);
};
const evmSignMessage = (text, priv) => evmSignHash(evmMessageHash(text), priv);

// BIP-137. A signature names a key, and a key several addresses, so this gives them all
// and the caller asks whether the claimed one is among them.
function bitcoinMessageHash(text){
  const m = te.encode(text);
  const len = m.length < 253 ? [m.length] : [253, m.length & 255, m.length >> 8];
  return sha256(sha256(concat(te.encode('\x18Bitcoin Signed Message:\n'), new Uint8Array(len), m)));
}
function bitcoinSigners(text, sig, network){
  if(sig.length !== 65 || sig[0] < 27 || sig[0] > 42) return [];
  try {
    const pub = secp256k1.recoverPublicKey(concat(new Uint8Array([(sig[0] - 27) % 4]), sig.subarray(1)), bitcoinMessageHash(text), { prehash: false });
    const params = net(network).params, wpkh = p2wpkh(pub, params);
    return [p2pkh(pub, params).address, wpkh.address, p2sh(wpkh, params).address, p2tr(pub.subarray(1), undefined, params).address];
  } catch(_) { return []; }
}

// Asks once. This used to ask twice in a row to prove the wallet repeats itself, and
// Rainbow answers a second identical request with an empty popup and a rejection. So a
// wallet is held to it another way: connecting compares this key with the one on record
// for the address, and contract accounts, the usual ones that cannot repeat, are refused.
async function deriveOwnerKey(signMessage, network){
  const sig = await signMessage(ownerMessage(network));
  if(!sig) throw new Error('The wallet returned no signature.');
  return keyFromSignature(sig, network);
}

// BIP-87, the path for multisig accounts, so this key could be found again by any
// tool given the seed.
// The same signature reaches us in several spellings: v as 27/28 or 0/1, or the
// 64-byte form that folds v into s. The seed hashes one spelling of them, or a change
// of wallet or firmware would hand an owner a different key and cost them their seat.
function canonicalSignature(sig){
  const raw = hex.decode(sig.replace(/^0x/, '').toLowerCase());
  const out = new Uint8Array(65);
  out.set(raw.subarray(0, 64));
  if(raw.length === 64){ out[64] = 27 + (raw[32] >> 7); out[32] &= 0x7f; }
  else if(raw.length === 65 && [0, 1, 27, 28].includes(raw[64])) out[64] = raw[64] < 27 ? raw[64] + 27 : raw[64];
  else throw new Error('This wallet returned a signature in a form this page cannot use. Nothing was derived.');
  // (r, s, v) and (r, n-s, v^1) are one signature, so they are one spelling too.
  const s = BigInt('0x' + hex.encode(out.subarray(32, 64)));
  if(s > CURVE_N / 2n){
    out.set(hex.decode((CURVE_N - s).toString(16).padStart(64, '0')), 32);
    out[64] = out[64] === 27 ? 28 : 27;
  }
  return out;
}
function keyFromSignature(sig, network){
  const bytes = canonicalSignature(sig);
  const n = net(network);
  const signer = HDKey.fromMasterSeed(sha256(concat(te.encode('multisig-bitcoin-owner-v1\0'), bytes)), n.versions);
  const path = ownPath(network);
  const account = signer.derive(`m/87'/${n.coin}'/0'`);
  const xpub = account.publicExtendedKey;
  account.wipePrivateData();
  return { signer, owner: { fingerprint: fingerprintOf(signer), path, xpub, evm: null } };
}
const ownPath = network => [87 + HARDENED, net(network).coin + HARDENED, HARDENED];
const fingerprintOf = k => k.fingerprint.toString(16).padStart(8, '0');

// ── POLICY ─────────────────────────────────────────────────
// PATHS. A policy is one or two spending paths, each k-of-n, the second optionally
// behind OP_CHECKSEQUENCEVERIFY. Two presets are made of this:
//
//   recovery:  k-of-n now, r-of-m once a coin has sat `d` blocks unspent. This is
//              the DeadmanSwitch and SocialRecovery mods, and here it is enforced
//              by consensus with no contract. Spending, or sending to the vault
//              itself, is the heartbeat.
//   hold:      all owners now, k-of-n once a coin is `d` blocks old. The same
//              routing TimelockExecutor uses, but NOT the same protection. See below.
//
// What cannot be built is the EVM timelock: k owners queue, everyone sees it, and
// the delay runs from that moment. CSV counts from when a coin confirmed, not from
// when anyone proposed anything, so a coin that has been sitting for longer than
// `d` has no delay left at all. And nothing in Script can make the first of two
// steps go only to a queue, because without a covenant the keys that can move a
// coin can move it anywhere. That needs CTV or OP_VAULT, and neither is active.
// An xpub's text also holds its depth and parent, which are free to differ for one
// key, so two strings can be one key in two seats. What makes a key is its point and
// chain code.
const keyId = (owner, network) => {
  const k = HDKey.fromExtendedKey(owner.xpub, net(network).versions);
  return hex.encode(k.publicKey) + hex.encode(k.chainCode);
};
// True when two owner records are one key, however their xpub text is dressed.
const sameKey = (a, b, network) => a.xpub === b.xpub || keyId(a, network) === keyId(b, network);
function policyOf({ network, paths }){
  net(network);
  if(!Array.isArray(paths) || paths.length < 1 || paths.length > 2) throw new Error('a vault has one or two paths');
  const out = paths.map(p => {
    const keys = p.keys.map(k => ownerOf({ ...k, network })).sort((a, b) => a.xpub < b.xpub ? -1 : a.xpub > b.xpub ? 1 : 0);
    if(new Set(keys.map(k => keyId(k, network))).size !== keys.length) throw new Error('the same key appears twice');
    if(!keys.length || keys.length > MAX_OWNERS) throw new Error(`a path has 1 to ${MAX_OWNERS} keys`);
    const threshold = p.threshold, older = p.older || 0;
    if(!Number.isInteger(threshold) || threshold < 1 || threshold > keys.length) throw new Error(`threshold must be 1 to ${keys.length}`);
    if(!Number.isInteger(older) || older < 0 || older > MAX_OLDER) throw new Error(`delay must be 0 to ${MAX_OLDER} blocks`);
    return { threshold, keys, older };
  });
  // A first path behind a delay leaves a coin unspendable by anyone while it ages,
  // and a second with no delay is just a weaker first path.
  if(out[0].older) throw new Error('the first path cannot have a delay');
  if(out[1] && !out[1].older) throw new Error('the second path needs a delay');
  return { network, paths: out };
}

// BIP-388 will not let one key appear twice on the same derivation paths, and a
// signer that sees the same child key in two leaves cannot say which it is signing
// for. So a key's second appearance walks chains 2 and 3 instead of 0 and 1.
const chainBase = (policy, pathIdx, key) => pathIdx && policy.paths[0].keys.some(k => keyId(k, policy.network) === keyId(key, policy.network)) ? 2 : 0;

const _child = new Map();
function childKey(xpub, chain, index, network){
  const k = `${xpub}/${chain}`;
  if(!_child.has(k)) capped(_child, 2000).set(k, HDKey.fromExtendedKey(xpub, net(network).versions).deriveChild(chain));
  return _child.get(k).deriveChild(index).publicKey.slice(1);
}

function leafScript(keys, threshold, older){
  const multi = keys.flatMap((k, i) => [k, i ? 'CHECKSIGADD' : 'CHECKSIG']).concat([threshold, 'NUMEQUAL']);
  return Script.encode(older ? [older, 'CHECKSEQUENCEVERIFY', 'VERIFY', ...multi] : multi);
}

// BIP-380, the checksum Bitcoin Core puts on a descriptor.
function descriptorChecksum(s){
  const INPUT = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
  const CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GEN = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];
  const poly = (c, v) => { const t = c >> 35n; c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(v); GEN.forEach((g, i) => { if((t >> BigInt(i)) & 1n) c ^= g; }); return c; };
  let c = 1n, cls = 0, n = 0;
  for(const ch of s){
    const p = INPUT.indexOf(ch);
    if(p < 0) throw new Error('descriptor has an invalid character');
    c = poly(c, p & 31); cls = cls * 3 + (p >> 5);
    if(++n === 3){ c = poly(c, cls); cls = 0; n = 0; }
  }
  if(n) c = poly(c, cls);
  for(let i = 0; i < 8; i++) c = poly(c, 0);
  c ^= 1n;
  let out = '';
  for(let i = 0; i < 8; i++) out += CHARS[Number((c >> (5n * BigInt(7 - i))) & 31n)];
  return out;
}

const pathDescriptor = (policy, i) => {
  const p = policy.paths[i];
  const keys = p.keys.map(k => { const b = chainBase(policy, i, k); return `${originText(k)}/<${b};${b + 1}>/*`; });
  const m = `multi_a(${p.threshold},${keys.join(',')})`;
  return p.older ? `and_v(v:older(${p.older}),${m})` : m;
};
function descriptorBody(policy){
  const leaves = policy.paths.map((_, i) => pathDescriptor(policy, i));
  return `tr(${numsKey(policy.network).publicExtendedKey}/<0;1>/*,${leaves.length === 1 ? leaves[0] : `{${leaves.join(',')}}`})`;
}
function descriptor(policy){
  const body = descriptorBody(policy);
  return `${body}#${descriptorChecksum(body)}`;
}

// Reads back exactly what descriptor() writes and nothing else. This is the string
// a co-signer pastes in, so a general parser would be a larger attack surface to
// no purpose. The round trip at the end refuses anything that reads as one vault
// and would write as another.
function parseDescriptor(text, network){
  const s = String(text).trim();
  const hash = s.lastIndexOf('#');
  const body = hash < 0 ? s : s.slice(0, hash);
  // Required, not just checked: without it a mistyped threshold is simply another vault.
  if(hash < 0) throw new Error('descriptor has no checksum');
  if(s.slice(hash + 1) !== descriptorChecksum(body)) throw new Error('descriptor checksum does not match');
  const prefix = `tr(${numsKey(network).publicExtendedKey}/<0;1>/*,`;
  if(!body.startsWith(prefix) || !body.endsWith(')')) throw new Error('not a multisig vault descriptor');
  let inner = body.slice(prefix.length, -1);
  if(inner.startsWith('{')){
    if(!inner.endsWith('}')) throw new Error('not a multisig vault descriptor');
    inner = inner.slice(1, -1);
  }
  const key = String.raw`\[[0-9a-f]{8}(?:/\d+h?)*\][1-9A-HJ-NP-Za-km-z]+/<\d+;\d+>/\*`;
  const leaf = new RegExp(String.raw`(?:and_v\(v:older\((\d+)\),)?multi_a\((\d+),(${key}(?:,${key})*)\)\)?`, 'y');
  const paths = [];
  while(leaf.lastIndex < inner.length){
    const m = leaf.exec(inner);
    if(!m) throw new Error('not a multisig vault descriptor');
    const keys = m[3].split(',').map(k => decodeOwner(k.slice(0, k.indexOf('/<')), network));
    paths.push({ threshold: +m[2], keys, older: m[1] ? +m[1] : 0 });
    if(inner[leaf.lastIndex] === ',') leaf.lastIndex++;
  }
  const policy = policyOf({ network, paths });
  if(descriptorBody(policy) !== body) throw new Error('descriptor is not in canonical form');
  return policy;
}

// The same policy as a BIP-388 wallet policy, the form Ledger registers: a template
// and a list of keys, with the unspendable key as @0.
function walletPolicy(policy){
  const keys = [numsKey(policy.network).publicExtendedKey];
  const at = k => {
    const text = originText(k).replace(/^\[[^\]]*\]/, o => o.replace(/h/g, "'"));
    if(!keys.includes(text)) keys.push(text);
    return keys.indexOf(text);
  };
  const leaves = policy.paths.map((p, i) => {
    const list = p.keys.map(k => { const b = chainBase(policy, i, k); return `@${at(k)}/${b ? `<${b};${b + 1}>/*` : '**'}`; });
    const m = `multi_a(${p.threshold},${list.join(',')})`;
    return p.older ? `and_v(v:older(${p.older}),${m})` : m;
  });
  return { template: `tr(@0/**,${leaves.length === 1 ? leaves[0] : `{${leaves.join(',')}}`})`, keys };
}

// ── THE SAME OWNERS AS AN ETHEREUM VAULT ───────────────────
// Bitcoin keys cannot be computed from Ethereum addresses: each comes from its owner's
// own signature. So every owner takes part once, by publishing a signed handle, and
// from there the vault is arithmetic. Owners are sorted and the threshold is read from
// the contract, so everyone holding the same handles arrives at the same descriptor,
// and no one has to create it.
//
// The handle must be proven, because the list decides who can spend. A label would
// let anyone name an owner's address beside their own key and take that seat. A key
// is also not filled in from a past transaction, though the Ethereum public key could
// be recovered from one: no Ethereum wallet can make the signature a Bitcoin script
// needs, so coins sent there could never move.
const EVM_CHAINS = {
  1:        { name: 'Ethereum',     rpc: 'https://ethereum.publicnode.com' },
  8453:     { name: 'Base',         rpc: 'https://base.publicnode.com' },
  4326:     { name: 'MegaETH',      rpc: 'https://mainnet.megaeth.com/rpc' },
  42161:    { name: 'Arbitrum',     rpc: 'https://arbitrum-one.publicnode.com' },
  10:       { name: 'OP Mainnet',   rpc: 'https://optimism.publicnode.com' },
  4663:     { name: 'Robinhood',    rpc: 'https://rpc.mainnet.chain.robinhood.com' },
  11155111: { name: 'Sepolia',      rpc: 'https://ethereum-sepolia.publicnode.com' },
  84532:    { name: 'Base Sepolia', rpc: 'https://base-sepolia.publicnode.com' },
};
const selector = sig => '0x' + hex.encode(keccak_256(te.encode(sig)).subarray(0, 4));

// A .wei or .gwei name to the address it points at, the way the main app does it. Each
// service hashes its own suffix away, so the service is picked by suffix first.
const NAME_SERVICES = { wei: '0x0000000000696760E15f265e828DB644A0c242EB', gwei: '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6' };
const isName = t => /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.g?wei$/i.test(t);
async function resolveName(name, doFetch = (...a) => root.fetch(...a)){
  const to = NAME_SERVICES[name.toLowerCase().split('.').pop()];
  const call = async data => {
    const r = await doFetch(EVM_CHAINS[1].rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: root.AbortSignal?.timeout(TIMEOUT_MS),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
    const j = await r.json();
    if(j.error || !/^0x[0-9a-f]{64}$/i.test(j.result || '')) throw new Error('That name could not be read.');
    return j.result.slice(2);
  };
  const bytes = te.encode(name.toLowerCase()), padded = hex.encode(bytes).padEnd(Math.ceil(bytes.length / 32) * 64, '0');
  const id = await call(selector('computeId(string)') + (32).toString(16).padStart(64, '0') + bytes.length.toString(16).padStart(64, '0') + padded);
  const word = await call(selector('resolve(uint256)') + id);
  const address = '0x' + word.slice(24);
  if(/^0x0+$/.test(address)) throw new Error('That name is not registered.');
  return address;
}

// The same words on every page, so a vault reads the same wherever it is opened.
const HOW_IT_WORKS = [
  ['A vault is an address with its rules built in', 'No contract and nothing to deploy, so it is free to make, and Bitcoin itself enforces the rules.'],
  ['The rules are fixed', 'Changing an owner or a delay means a new vault and moving the coins over. An Ethereum vault can change these in place.'],
  ['Spending is a proposal', 'One owner proposes, the others sign in any order, and anyone can send it once enough have signed. The vault pays the miner fee.'],
  ['Each owner brings a wallet', 'An Ethereum or Bitcoin wallet signs once and that makes the owner key, the same on any device. So an Ethereum wallet can hold a seat on Bitcoin with no new seed phrase.'],
  ['Delays run per coin', 'A clock starts when a coin confirms, and moving the coin restarts it. So an active vault stays ahead of any delay.'],
  ['The backup is the way out', 'It holds no private key. With it and enough keys, the coins can be spent without this site.'],
];
const aboutBlocks = b => { const d = Math.round(b / 144), h = Math.round(b / 6); return d >= 2 ? `about ${d} days` : h >= 2 ? `about ${h} hours` : b >= 6 ? 'about 1 hour' : `about ${b * 10} minutes`; };
const sameKeys = (a, b, network) => a.length === b.length && a.every(k => b.some(o => sameKey(k, o, network)));
function describePolicy(policy){
  return policy.paths.map(p => {
    const one = sameKeys(p.keys, policy.paths[0].keys, policy.network) ? 'owner' : 'recovery key';
    const every = p.keys.length === 2 ? `Both ${one}s` : `All ${p.keys.length} ${one}s`;
    if(!p.older && p.keys.length === 1) return `The ${one} can spend alone.`;
    if(!p.older) return `${p.threshold === p.keys.length ? every : `Any ${p.threshold} of ${p.keys.length} ${one}s`} must sign.`;
    const who = p.keys.length === 1 ? `The ${one}` : p.threshold === p.keys.length ? every : `Any ${p.threshold} of ${p.keys.length} ${one}s`;
    return `${who} can also spend any coin unmoved for ${p.older} blocks, ${aboutBlocks(p.older)}.`;
  });
}

// What a vault is, read from nothing but its own rules, so a vault from a stranger's link
// is named the same way as one made here.
function policySummary(policy){
  const [first, later, ...rest] = policy.paths, n = first.keys.length;
  const base = { rules: describePolicy(policy), delay: later?.older || 0 }, short = later?.older < 144 ? ' This delay is very short.' : '';
  if(rest.length || (later && !later.older)) return { ...base, kind: 'custom', name: 'CUSTOM', note: 'This vault has its own rules. Read each one.' };
  if(!later) return { ...base, kind: 'standard', name: 'STANDARD',
    note: n === 1 ? 'One key. A single-signature wallet.' : first.threshold === n ? 'One lost wallet locks the coins.' : first.threshold === 1 ? 'Any one owner can spend alone.' : `Still spends if ${n - first.threshold === 1 ? 'one wallet is' : `${n - first.threshold} wallets are`} lost.` };
  if(sameKeys(later.keys, first.keys, policy.network)){
    if(first.threshold === n && later.threshold < n) return { ...base, kind: 'aged', name: 'AGED COINS', note: `A lost wallet delays the coins and does not lock them.${later.threshold === 1 ? ' After the delay, one stolen wallet could spend them too.' : ''}${short}` };
    return { ...base, kind: 'custom', name: 'CUSTOM', note: 'This vault has its own rules. Read each one.' };
  }
  const inside = later.keys.every(k => first.keys.some(o => sameKey(k, o, policy.network)));
  return { ...base, kind: 'deadman', name: 'DEADMAN SWITCH', note: `${inside ? 'After the delay, the owners listed there can spend without the others.' : 'If the owners stop moving coins, the recovery keys can take over after the delay.'}${short}` };
}

async function readEvmVault(chainId, address, doFetch = (...a) => root.fetch(...a)){
  const c = EVM_CHAINS[chainId];
  if(!c) throw new Error('unknown chain');
  if(!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('not an Ethereum address');
  const call = async data => {
    const r = await doFetch(c.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: root.AbortSignal?.timeout(TIMEOUT_MS),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data }, 'latest'] }) });
    const j = await r.json();
    if(j.error || !j.result || j.result === '0x') throw new Error(`no vault at that address on ${c.name}`);
    return j.result.slice(2);
  };
  const [list, min] = await Promise.all([call(selector('getOwners()')), call(selector('threshold()'))]);
  const count = parseInt(list.slice(64, 128), 16);
  if(!(count > 0 && count <= MAX_OWNERS) || list.length < 128 + count * 64) throw new Error('that vault cannot be mirrored');
  const owners = Array.from({ length: count }, (_, i) => '0x' + list.slice(128 + i * 64 + 24, 128 + (i + 1) * 64));
  return { chainId, address, owners, threshold: parseInt(min, 16) };
}

// The handle registry. Everything read from it is checked here, so it is a place to
// find handles and not something to trust: a row that does not prove itself, or that
// names a different address from the one asked for, is dropped.
const API = 'https://multisig-proposals.onrender.com', STORE = 'https://multisig-postgrest.onrender.com';
async function publishHandle(handle, network, doFetch = (...a) => root.fetch(...a)){
  const r = await doFetch(`${API}/handle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, network }), signal: root.AbortSignal?.timeout(TIMEOUT_MS) });
  if(!r.ok) throw new Error('Could not publish this handle');
}
// A bc1… address to the owner behind it. Checked like any handle, and it must be the
// same wallet that was asked about.
async function handleForWallet(network, address, doFetch = (...a) => root.fetch(...a)){
  const r = await doFetch(`${STORE}/rpc/btc_handle_for_wallet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_network: network, p_wallet: address }), signal: root.AbortSignal?.timeout(TIMEOUT_MS) });
  if(!r.ok) throw new Error('Could not read owner handles');
  const [row] = await r.json();
  if(!row) return null;
  const h = decodeOwner(row.handle, network);
  return h.proven && h.wallet === address ? { handle: row.handle, evm: h.evm } : null;
}
async function fetchHandles(network, addresses, doFetch = (...a) => root.fetch(...a)){
  net(network);
  const wanted = addresses.map(a => a.toLowerCase());
  const r = await doFetch(`${STORE}/rpc/btc_handles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_network: network, p_addresses: wanted }), signal: root.AbortSignal?.timeout(TIMEOUT_MS) });
  if(!r.ok) throw new Error('Could not read owner handles');
  const out = [];
  for(const row of await r.json()){
    try { const h = decodeOwner(row.handle, network); if(h.proven && h.evm === row.address && wanted.includes(h.evm)) out.push(row.handle); } catch(_) {}
  }
  return out;
}

// The wallets behind a vault's keys. A descriptor holds only keys, and the handle on record
// proves which wallet made each one, so nothing here is taken on the store's word.
async function ownersOf(policy, doFetch = (...a) => root.fetch(...a)){
  const { network } = policy, ids = new Map();
  for(const p of policy.paths) for(const k of p.keys) ids.set(keyId(k, network), k.xpub);
  const r = await doFetch(`${STORE}/rpc/btc_handles_by_key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_network: network, p_keys: [...ids.keys()].slice(0, 64) }), signal: root.AbortSignal?.timeout(TIMEOUT_MS) });
  if(!r.ok) throw new Error('Could not read owner handles');
  const out = {};
  for(const row of await r.json()){
    try {
      const h = decodeOwner(row.handle, network), xpub = ids.get(keyId(h, network));
      if(h.possessed && xpub) out[xpub] = { evm: h.evm, wallet: h.wallet };
    } catch(_) {}
  }
  return out;
}

// An owner saying "this is me" to the service without another wallet prompt. The account
// key behind their handle signs, so the wallet is asked nothing, and the service checks
// it against the xpub in the handle. Dated, and bound to one action.
const AUTH_WINDOW = 300;
const authHash = (network, action, at) => sha256(te.encode(`multisig owner auth v1\n${network}\n${action}\n${at}`));
function signOwnerAuth(signer, network, action, at = Math.floor(Date.now() / 1000)){
  const account = signer.derive(`m/${pathText(ownPath(network)).replace(/h/g, "'")}`);
  const sig = hex.encode(schnorr.sign(authHash(network, action, at), account.privateKey));
  account.wipePrivateData();
  return { at, sig };
}
// The account key in full, for spending without this site. The xprv stands in for its
// xpub in a descriptor, and Bitcoin Core does the rest.
function exportAccountKey(signer, network){
  const account = signer.derive(`m/${pathText(ownPath(network)).replace(/h/g, "'")}`);
  const text = `[${fingerprintOf(signer)}/${pathText(ownPath(network))}]${account.privateExtendedKey}`;
  account.wipePrivateData();
  return text;
}
// What a backup says about recovery. Written out in full so that it still works if
// everything else about this project is gone.
function recoveryText(network){
  const n = net(network), lines = s => s.split('\n').map(l => `    ${l}`).join('\n');
  return [
    'Spending without this site:',
    '',
    `Owners on a hardware wallet: sign with your wallet, using account m/87'/${n.coin}'/0'-style paths in the descriptor.`,
    '',
    'Owners who connected a wallet: your key comes from one signature, and you can make it again.',
    '  Ethereum wallet: personal_sign this exact text, without the indent.',
    lines(ownerMessage(network)),
    '    Take r||s||v as 65 bytes, s low, v 27 or 28.',
    '    seed = sha256("multisig-bitcoin-owner-v1" || 0x00 || signature)',
    '  Bitcoin wallet: sign this exact text, without the indent, BIP-137. Leather signs in BIP-322,',
    '  so a Leather owner exports their key from the wallet menu instead, and keeps that copy.',
    lines(walletMessage()),
    '    Take r||s from the 65 bytes, s low.',
    '    seed = sha256("multisig-wallet-v1" || 0x00 || r || s)',
    `  The BIP-32 master of that seed, at m/87'/${n.coin}'/0', is your key. Put its xprv where your`,
    '  xpub is in the descriptor, import it to Bitcoin Core, and sign there. The app can also',
    '  export this key for you, from your wallet menu, and runs from an IPFS gateway that gives',
    '  each site its own origin, such as a dweb.link subdomain.',
  ].join('\n');
}
function verifyOwnerAuth(owner, network, action, at, sig, now = Math.floor(Date.now() / 1000)){
  if(!Number.isInteger(at) || Math.abs(now - at) > AUTH_WINDOW || !/^[0-9a-f]{128}$/.test(String(sig))) return false;
  try { return schnorr.verify(hex.decode(sig), authHash(network, action, at), HDKey.fromExtendedKey(owner.xpub, net(network).versions).publicKey.subarray(1)); }
  catch(_) { return false; }
}
const postJson = (doFetch, url, body) => doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: root.AbortSignal?.timeout(TIMEOUT_MS) });
// `handles` are the other owners', so the vault can be offered to them. Only the signer
// is recorded as having agreed.
async function saveVault(policy, signer, handle, handles = [], doFetch = (...a) => root.fetch(...a)){
  const auth = signOwnerAuth(signer, policy.network, `save:${vaultId(policy)}`);
  const r = await postJson(doFetch, `${API}/btc-vault`, { network: policy.network, descriptor: descriptor(policy), handle, handles, ...auth });
  if(!r.ok) throw new Error('Could not save this vault');
}
// What the service says this owner sits on, kept only where this owner's key really is.
async function listVaults(network, signer, handle, doFetch = (...a) => root.fetch(...a)){
  const auth = signOwnerAuth(signer, network, 'list');
  const r = await postJson(doFetch, `${API}/btc-vaults`, { network, handle, ...auth });
  if(!r.ok) throw new Error('Could not read your vaults');
  const me = decodeOwner(handle, network), out = [];
  for(const row of await r.json()){
    try {
      const policy = parseDescriptor(row.descriptor, network);
      if(!policy.paths.some(p => p.keys.some(k => sameKey(k, me, network)))) continue;
      // Confirmed by this owner's signature, checked here. The server's word is not
      // enough: anyone who could write that row could plant a vault as trusted.
      const signed = !!row.confirmed && verifyOwnerAuth(me, network, `save:${vaultId(policy)}`, row.at, row.sig, row.at);
      out.push({ policy, confirmed: signed });
    } catch(_) {}
  }
  return out;
}

// The queue. A proposal is known by its unsigned transaction, so every signed copy of
// one is the same proposal, and a vault by a hash of its descriptor, so the queue can
// be found only by someone who can compute that. For a vault mirrored from Ethereum that
// is anyone: its owners are public and so are their handles. What comes back is re-read
// against the policy: a row that does not parse, or does not belong, is simply not there.
// Fingerprints and paths are left out of the hash, as they do not change the addresses.
const proposalId = psbt => hex.encode(sha256(load(psbt).unsignedTx));
const vaultId = policy => hex.encode(sha256(te.encode(JSON.stringify(policy.paths.map(p => [p.threshold, p.older, p.keys.map(k => keyId(k, policy.network))])))));
async function publishProposal(psbt, policy, doFetch = (...a) => root.fetch(...a)){
  const r = await doFetch(`${API}/btc-proposal`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: root.AbortSignal?.timeout(TIMEOUT_MS),
    body: JSON.stringify({ psbt, descriptor: descriptor(policy), network: policy.network }) });
  if(!r.ok) throw new Error('Could not save this proposal to the queue');
}
async function fetchProposals(policy, doFetch = (...a) => root.fetch(...a)){
  const r = await doFetch(`${STORE}/rpc/btc_vault_proposals`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: root.AbortSignal?.timeout(TIMEOUT_MS),
    body: JSON.stringify({ p_vault: vaultId(policy) }) });
  if(!r.ok) throw new Error('Could not read the queue');
  const out = [];
  for(const row of await r.json()){
    try { if(proposalId(row.psbt) === row.id){ inspect(row.psbt, policy); out.push(row.psbt); } } catch(_) {}
  }
  return out;
}
// Proposals still able to happen. For a page without a coin list: one with a coin
// already spent can never confirm, so it is over, whichever way it went.
async function openProposals(policy, c, doFetch){
  const out = [];
  for(const psbt of await fetchProposals(policy, doFetch)){
    const { inputs } = inspect(psbt, policy);
    if(!(await Promise.all(inputs.map(i => c.spent(i.txid, i.vout)))).some(Boolean)) out.push(psbt);
  }
  return out;
}

// `missing` is who has not published yet. A proven handle from someone who is not an
// owner is an error rather than ignored, since it is probably the wrong vault.
function mirror({ network, vault, handles }){
  const byOwner = new Map(), owners = vault.owners.map(o => o.toLowerCase());
  for(const text of handles){
    const h = decodeOwner(text, network);
    if(!h.proven) throw new Error('every handle must be signed by its Ethereum address. Ask that owner to connect again and copy a fresh one.');
    if(!owners.includes(h.evm)) throw new Error(`${h.evm} is not an owner of that vault`);
    // One address, one key, or the same handles could give two different vaults.
    if(byOwner.has(h.evm) && byOwner.get(h.evm).xpub !== h.xpub) throw new Error(`${h.evm} has two different keys here`);
    byOwner.set(h.evm, h);
  }
  const missing = owners.filter(o => !byOwner.has(o));
  if(missing.length) return { missing, policy: null };
  return { missing, policy: policyOf({ network, paths: [{ threshold: vault.threshold, keys: owners.map(o => byOwner.get(o)) }] }) };
}

// One address of a vault. `branch` is 0 for receive and 1 for change.
const _slots = new Map();
function vaultOf(policy, branch = 0, index = 0){
  const id = `${descriptorBody(policy)}|${branch}|${index}`;
  if(_slots.has(id)) return _slots.get(id);
  const internal = HDKey.fromExtendedKey(numsKey(policy.network).publicExtendedKey, net(policy.network).versions).deriveChild(branch).deriveChild(index).publicKey.slice(1);
  const paths = policy.paths.map((p, i) => {
    const keys = p.keys.map(k => {
      const chain = chainBase(policy, i, k) + branch;
      return { owner: k, chain, pubkey: childKey(k.xpub, chain, index, policy.network) };
    });
    return { keys, script: leafScript(keys.map(k => k.pubkey), p.threshold, p.older) };
  });
  const scripts = paths.map(p => ({ script: p.script }));
  const pay = p2tr(internal, scripts.length === 1 ? scripts[0] : scripts, net(policy.network).params, true);
  for(const p of paths){
    const same = ([, s]) => hex.encode(s.subarray(0, -1)) === hex.encode(p.script);
    p.leaf = pay.tapLeafScript.find(same);
    p.hash = pay.leaves.find(l => hex.encode(l.script) === hex.encode(p.script)).hash;
  }
  const slot = { address: pay.address, script: pay.script, internal, merkleRoot: pay.tapMerkleRoot, paths, branch, index };
  capped(_slots, 2000).set(id, slot);
  return slot;
}

// What a signer needs to find its own child key, and what a hardware wallet needs to
// recognize change. Every key on `which` leaves is listed, with the leaf it signs.
const derivations = (slot, which) => {
  const rows = new Map();
  for(const p of which) for(const k of p.keys){
    const id = hex.encode(k.pubkey);
    if(!rows.has(id)) rows.set(id, [k.pubkey, { hashes: [], der: { fingerprint: parseInt(k.owner.fingerprint, 16), path: [...k.owner.path, k.chain, slot.index] } }]);
    rows.get(id)[1].hashes.push(p.hash);
  }
  return [...rows.values()];
};

// Which address of this vault a script is. The PSBT's derivation says where to look
// and nothing more: the claim is re-derived from the policy, so a hostile proposal
// cannot pass off its own address as change.
//
// Deriving a slot is the expensive step, and this runs on hostile input before any
// signature is looked at, on the server too. So a claim is tried only once, an honest
// item never needs more than two, and the whole proposal has a budget. Spending it just
// makes an item read as not ours.
const MAX_CLAIMS = 2;
function locate(policy, script, entries, budget, limit = MAX_INDEX){
  const tried = new Set();
  for(const [, { der }] of (entries || []).slice(0, 64)){
    if(der.path.length < 2) continue;
    const [chain, index] = der.path.slice(-2);
    if(chain >= HARDENED || index >= limit) continue;
    const id = `${chain % 2}/${index}`;
    if(tried.has(id)) continue;
    if(tried.size >= MAX_CLAIMS || budget.left <= 0) return null;
    tried.add(id);
    budget.left--;
    const slot = vaultOf(policy, chain % 2, index);
    if(hex.encode(slot.script) === hex.encode(script)) return slot;
  }
  return null;
}
// Long-lived on the page and on the server, so they are capped rather than left to grow.
const capped = (map, max) => { if(map.size >= max) map.clear(); return map; };

// ── FEES ───────────────────────────────────────────────────
// Weight is exact rather than guessed: everything in the witness is known once the
// path is, and an underestimate on a large multi_a is a transaction no one relays.
function varlen(n){ return n < 0xfd ? 1 : 3; }
function vsize(policy, pathIdx, inputs, outputScripts){
  const p = policy.paths[pathIdx];
  const script = vaultOf(policy).paths[pathIdx].script.length, control = 33 + 32 * (policy.paths.length - 1);
  const witness = 1 + p.threshold * 65 + (p.keys.length - p.threshold)
    + varlen(script) + script + 1 + control;
  const outs = outputScripts.reduce((n, l) => n + 8 + varlen(l) + l, 0);
  const base = 4 + varlen(inputs) + inputs * 41 + varlen(outputScripts.length) + outs + 4;
  return Math.ceil((base * 4 + 2 + inputs * witness) / 4);
}

// A coin can go down a delayed path from the block `older` after the one it
// confirmed in, and BIP-68 counts from the coin's block, so the spending block
// must be at least height + older.
//
// Some coins are never spent as sats, because spending one could destroy a token on it.
// Coins of 546 sats or less are left alone, the rule the Tacit dapp keeps, but a sender
// picks an output's value, so that alone misses a token on a larger coin. Tacit's check
// does not need a wallet's keys: a Tacit coin comes from a transaction carrying a Tacit
// envelope. So each coin's creating transaction is read, which any explorer can answer,
// and misses nothing. Only coins that trip that are put to Tacit's own classifier, which
// clears the false alarms and names the asset, so an ordinary vault tells Tacit nothing.
// A coin is released only on a plain "plain": asset stays set aside, and unverified,
// missing or any failure does too, and is tried again. Spending one as sats burns the
// note, and a vault has no key to read it with. Runes and inscriptions on large coins
// are not detected.
const isProtected = coin => coin.value <= DUST || !!coin.quarantine;
const ENVELOPE_MARKER = '5441434954'; // "TACIT"
// Names for the assets anyone is likely to meet. The classifier gives ids; any other
// shows as its id, which is still the truth.
const TACIT_ASSETS = {
  f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b: 'TAC',
  '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34': 'tETH',
  '62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8': 'cBTC',
  '8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d': 'cUSD',
};
const hasTacitEnvelope = tx => {
  // A reply with no inputs is no answer. Calling it clear would release the coin.
  if(!Array.isArray(tx?.vin) || !tx.vin.length) throw new Error('not a transaction');
  return tx.vin.some(i => (i.witness || []).some(w => w.includes(ENVELOPE_MARKER)));
};
function coinsFor(policy, pathIdx, utxos, tip){
  const older = policy.paths[pathIdx].older;
  return utxos.filter(u => u.height > 0 && !isProtected(u) && (!older || tip + 1 >= u.height + older));
}

// ── PROPOSALS ──────────────────────────────────────────────
// A proposal is a PSBT. It needs no server: it travels by paste, link or file, and
// any BIP-174 tool can read it. `outputs` empty with `sweep` names one address and
// takes every eligible coin, which is how a vault moves to a new policy. `change` is
// the index of the next unused change address, from scan().
function propose({ policy, utxos, tip, outputs = [], sweep = null, feeRate, path = 0, change: changeIndex = 0 }){
  const p = policy.paths[path];
  if(!p) throw new Error('no such path');
  // Below 1 sat/vB most nodes will not relay it at all.
  if(!(feeRate >= 1 && feeRate <= MAX_FEE_RATE)) throw new Error(`fee rate must be 1 to ${MAX_FEE_RATE} sat/vB`);
  const params = net(policy.network).params, changeSlot = vaultOf(policy, 1, changeIndex);
  const eligible = coinsFor(policy, path, utxos, tip).slice().sort((a, b) => b.value - a.value);
  if(!eligible.length) throw new Error(p.older ? `no coin here has aged ${p.older} blocks yet` : 'no confirmed coins');
  const scriptOf = a => { try { return Address(params).decode(a); } catch(_) { throw new Error(`not a ${policy.network} address: ${a}`); } };

  let picked = [], sends, change = 0;
  if(sweep){
    if(outputs.length) throw new Error('a sweep takes one address and no outputs');
    scriptOf(sweep);
    // Largest first, and only what fits in one transaction. The rest takes another.
    const out0 = outScriptLen(sweep, params);
    picked = eligible.slice(0, Math.min(MAX_INPUTS, eligible.length));
    while(picked.length > 1 && vsize(policy, path, picked.length, [out0]) > MAX_VSIZE) picked.pop();
    const total = picked.reduce((n, u) => n + u.value, 0);
    const out = outScriptLen(sweep, params);
    const value = total - Math.ceil(vsize(policy, path, picked.length, [out]) * feeRate);
    if(value < DUST) throw new Error('not enough here to pay the fee');
    sends = [{ address: sweep, sats: value }];
  } else {
    if(!outputs.length) throw new Error('nothing to send');
    sends = outputs.map(o => {
      scriptOf(o.address);
      if(!Number.isSafeInteger(o.sats) || o.sats < DUST) throw new Error(`an output must be at least ${DUST} sats`);
      return o;
    });
    const lens = sends.map(o => outScriptLen(o.address, params)), want = sends.reduce((n, o) => n + o.sats, 0);
    let have = 0, fee = 0, done = false;
    for(const u of eligible){
      picked.push(u); have += u.value;
      if(picked.length > MAX_INPUTS || vsize(policy, path, picked.length, lens) > MAX_VSIZE) throw new Error('that needs too many small coins for one transaction. Send a smaller amount first');
      fee = Math.ceil(vsize(policy, path, picked.length, [...lens, changeSlot.script.length]) * feeRate);
      // Change must clear the dust line, or it would become a coin this page never spends.
      if(have >= want + fee + DUST + 1){ change = have - want - fee; done = true; break; }
      // Exactly enough, or short of a change output worth making: the rest is fee.
      const noChange = Math.ceil(vsize(policy, path, picked.length, lens) * feeRate);
      if(have >= want + noChange){ change = 0; done = true; break; }
    }
    if(!done) throw new Error('not enough to cover that and the fee');
  }

  const tx = new Transaction({ version: 2, allowUnknownInputs: true, allowUnknownOutputs: false });
  for(const u of picked){
    const slot = vaultOf(policy, u.branch, u.index), leaf = slot.paths[path];
    tx.addInput({
      txid: u.txid, index: u.vout, sequence: p.older || FINAL_RBF,
      witnessUtxo: { script: slot.script, amount: BigInt(u.value) },
      tapInternalKey: slot.internal, tapMerkleRoot: slot.merkleRoot, tapLeafScript: [leaf.leaf],
      tapBip32Derivation: derivations(slot, [leaf]),
    });
  }
  for(const o of sends) tx.addOutputAddress(o.address, BigInt(o.sats), params);
  if(change) tx.addOutput({
    script: changeSlot.script, amount: BigInt(change), tapInternalKey: changeSlot.internal,
    tapTree: changeSlot.paths.map(l => ({ depth: changeSlot.paths.length - 1, version: 0xc0, script: l.script })),
    tapBip32Derivation: derivations(changeSlot, changeSlot.paths),
  });
  return base64.encode(tx.toPSBT());
}
function outScriptLen(address, params){
  const d = Address(params).decode(address);
  return { wpkh: 22, wsh: 34, tr: 34, pkh: 25, sh: 23 }[d.type] ?? (() => { throw new Error('cannot pay that address type'); })();
}

const controlBytes = c => {
  const out = new Uint8Array(33 + 32 * c.merklePath.length);
  out[0] = c.version;
  out.set(c.internalKey, 1);
  c.merklePath.forEach((h, i) => out.set(h, 33 + 32 * i));
  return out;
};
// Only signatures for the leaf being spent count. A signer holding a key on both
// leaves may sign both, and the other one is not an error, just not this spend.
const sigsFor = (inp, spend) => (inp.tapScriptSig || []).filter(([{ leafHash }]) => hex.encode(leafHash) === hex.encode(spend.leafHash));
const load = psbt => Transaction.fromPSBT(base64.decode(String(psbt).trim()), { allowUnknownInputs: true });

// What an owner is about to put their name to, read out of the PSBT itself. A
// proposal arrives from someone else, possibly someone hostile, so nothing the page
// shows comes from anywhere else: every input must be this vault's, down a path of
// this policy, and every signature is checked rather than counted.
//
// The amounts in the PSBT are claims too, but safe ones. BIP-341 signs over every
// input's amount, so a PSBT that overstates or understates one, to disguise a fee,
// produces signatures the network rejects.
function inspect(psbtText, policy, known = { receive: 0, change: 0 }){
  const tx = load(psbtText);
  const params = net(policy.network).params;
  if(!tx.inputsLength || !tx.outputsLength) throw new Error('proposal is empty');
  let pathIdx = -1, inTotal = 0n;
  if(tx.inputsLength > MAX_INPUTS || tx.outputsLength > MAX_OUTPUTS) throw new Error('proposal is too large');
  const budget = { left: tx.inputsLength + tx.outputsLength + 4 };
  const scripts = [], amounts = [], inputs = [], outpoints = new Set();
  // Both are things k owners could otherwise sign without seeing: a locktime makes a
  // payment that looks dead come alive later.
  if(tx.lockTime !== 0) throw new Error('proposal has a locktime');
  if(tx.version !== 2) throw new Error('proposal has an unexpected transaction version');
  for(let i = 0; i < tx.inputsLength; i++){
    const inp = tx.getInput(i);
    const slot = inp.witnessUtxo && locate(policy, inp.witnessUtxo.script, inp.tapBip32Derivation, budget);
    if(!slot) throw new Error(`input ${i} does not belong to this vault`);
    // A proposal names one leaf, but a signer that knows the whole policy may add the
    // rest on its way through, so more than one is not an error. Each must be this
    // vault's. The sequence says which is being spent, and it has to be exact: a
    // delayed path carries its delay and nothing else, the first path carries RBF.
    const offered = inp.tapLeafScript || [];
    const leaves = offered.map(([control, withVer]) => ({ control, idx: slot.paths.findIndex(p => hex.encode(p.script) === hex.encode(withVer.subarray(0, -1))) }));
    if(!leaves.length || leaves.some(l => l.idx < 0)) throw new Error(`input ${i} spends down a path this vault does not have`);
    const pick = leaves.find(l => (policy.paths[l.idx].older || FINAL_RBF) === inp.sequence);
    if(!pick) throw new Error(`input ${i} does not carry the path's delay`);
    if(inp.finalScriptSig?.length || inp.finalScriptWitness?.length) throw new Error(`input ${i} is already finalized`);
    const id = `${hex.encode(inp.txid)}:${inp.index}`;
    if(outpoints.has(id)) throw new Error(`input ${i} repeats a coin`);
    outpoints.add(id);
    const idx = pick.idx, control = pick.control, script = slot.paths[idx].script, leafHash = slot.paths[idx].hash;
    if(pathIdx >= 0 && idx !== pathIdx) throw new Error('proposal mixes two paths');
    pathIdx = idx;
    if(inp.sighashType !== undefined && inp.sighashType !== 0) throw new Error(`input ${i} asks for a non-default sighash`);
    inTotal += inp.witnessUtxo.amount;
    scripts.push(inp.witnessUtxo.script); amounts.push(inp.witnessUtxo.amount);
    inputs.push({ txid: hex.encode(inp.txid), vout: inp.index, sats: Number(inp.witnessUtxo.amount), control: controlBytes(control), script, leafHash, slot, keys: slot.paths[idx].keys });
  }
  const p = policy.paths[pathIdx];
  let outTotal = 0n;
  const outputs = [];
  for(let i = 0; i < tx.outputsLength; i++){
    const o = tx.getOutput(i);
    outTotal += o.amount;
    // The address shown must be the bytes signed. The decoder forgives a non-minimal
    // push, so `OP_1 PUSHDATA1 <key>` reads as the payee's address while being, on
    // chain, a script anyone can spend. Re-encoding exposes the difference.
    const decoded = OutScript.decode(o.script);
    if(hex.encode(OutScript.encode(decoded)) !== hex.encode(o.script)) throw new Error(`output ${i} is not a standard address`);
    // Ours, and also somewhere a scan will find it. An address far past the gap is
    // this vault's on paper and lost in practice, so it does not count as change.
    const slot = locate(policy, o.script, o.tapBip32Derivation, budget, HARDENED);
    const reach = slot && slot.index < MAX_INDEX && slot.index < (slot.branch ? known.change : known.receive) + GAP;
    outputs.push({ address: Address(params).encode(decoded), sats: Number(o.amount), change: !!reach, stranded: !!slot && !reach, index: slot ? slot.index : null, branch: slot ? slot.branch : null });
  }
  if(outTotal > inTotal) throw new Error('outputs exceed inputs');
  const fee = Number(inTotal - outTotal);
  const size = vsize(policy, pathIdx, tx.inputsLength, outputs.map(o => outScriptLen(o.address, params)));

  // One tally per input: a proposal is ready when the worst input is. An owner is
  // named by their extended key, since their child key differs on every input.
  const signedBy = new Set(), onEvery = new Map();
  let ready = true;
  for(let i = 0; i < tx.inputsLength; i++){
    const inp = tx.getInput(i), seen = new Set();
    const msg = tx.preimageWitnessV1(i, scripts, 0, amounts, -1, inputs[i].script, 0xc0);
    for(const [{ pubKey }, sig] of sigsFor(inp, inputs[i])){
      const key = inputs[i].keys.find(k => hex.encode(k.pubkey) === hex.encode(pubKey));
      if(!key) throw new Error(`input ${i} carries a signature from a key that is not an owner`);
      if(sig.length !== 64 || !schnorr.verify(sig, msg, pubKey)) throw new Error(`input ${i} carries a signature that does not verify`);
      seen.add(key.owner.xpub); signedBy.add(key.owner.xpub);
    }
    for(const x of seen) onEvery.set(x, (onEvery.get(x) || 0) + 1);
    if(seen.size < p.threshold) ready = false;
  }
  return { path: pathIdx, threshold: p.threshold, keys: p.keys, older: p.older, inputs, outputs, fee, vsize: size,
    feeRate: fee / size, signedBy: [...signedBy], signedAll: [...onEvery].filter(([, n]) => n === tx.inputsLength).map(([x]) => x), ready };
}

// `signer` is the embedded key's root. An owner on a hardware wallet does not come
// through here: their wallet signs the PSBT and they paste back the result.
function sign(psbtText, signer, policy, known){
  const view = inspect(psbtText, policy, known);
  if(view.feeRate > MAX_FEE_RATE) throw new Error(`refusing to sign: the fee is ${view.feeRate.toFixed(0)} sat/vB`);
  if(view.vsize > MAX_VSIZE) throw new Error('refusing to sign: this is too large for a node to relay');
  if(view.outputs.some(o => o.stranded)) throw new Error('refusing to sign: this sends coins to a vault address no scan would ever find');
  if(view.inputs.some(i => i.sats <= DUST)) throw new Error('refusing to sign: this spends a dust coin, which may hold a token');
  if(view.inputs.some(i => known?.quarantined?.includes(`${i.txid}:${i.vout}`))) throw new Error('refusing to sign: this spends a quarantined coin, which may hold a token');
  const account = signer.derive(`m/${pathText(ownPath(policy.network)).replace(/h/g, "'")}`), xpub = account.publicExtendedKey;
  account.wipePrivateData();
  const self = { xpub };
  if(!view.keys.some(k => sameKey(k, self, policy.network))) throw new Error('this key is not an owner on that path');
  // Signed on a transaction built from what was reviewed and nothing else: one leaf,
  // and this key's own seat found by its xpub. A descriptor's fingerprint and path
  // are text that no one can check, so a creator who altered them, or a co-owner
  // borrowing this fingerprint, must not be able to stop an owner signing.
  const src = load(psbtText);
  const clean = new Transaction({ version: 2, allowUnknownInputs: true, allowUnknownOutputs: true });
  view.inputs.forEach((inp, i) => {
    const leaf = inp.slot.paths[view.path], mine = leaf.keys.find(k => sameKey(k.owner, self, policy.network));
    const from = src.getInput(i);
    clean.addInput({
      txid: from.txid, index: from.index, sequence: from.sequence, witnessUtxo: from.witnessUtxo,
      tapInternalKey: inp.slot.internal, tapMerkleRoot: inp.slot.merkleRoot, tapLeafScript: [leaf.leaf],
      tapBip32Derivation: [[mine.pubkey, { hashes: [leaf.hash], der: { fingerprint: signer.fingerprint, path: [...ownPath(policy.network), mine.chain, inp.slot.index] } }]],
    });
  });
  for(let i = 0; i < src.outputsLength; i++){ const o = src.getOutput(i); clean.addOutput({ script: o.script, amount: o.amount }); }
  if(clean.sign(signer, [0]) !== src.inputsLength) throw new Error('could not sign every input');
  // The signatures go back on the proposal as it arrived, so what a co-signer's
  // wallet needs from it is still there.
  addSignatures(src, clean);
  return base64.encode(src.toPSBT());
}

// Signing is randomized, so one key can make two valid signatures for one input. The
// first one in stays, or two copies of a proposal could never merge.
function addSignatures(to, from){
  for(let i = 0; i < to.inputsLength; i++){
    const have = new Set((to.getInput(i).tapScriptSig || []).map(([k]) => hex.encode(k.pubKey) + hex.encode(k.leafHash)));
    const fresh = (from.getInput(i).tapScriptSig || []).filter(([k]) => !have.has(hex.encode(k.pubKey) + hex.encode(k.leafHash)));
    if(fresh.length) to.updateInput(i, { tapScriptSig: fresh }, true);
  }
}

// Signatures are collected by merging copies of one proposal. Only signatures are
// taken from a copy. A signer is free to rewrite the rest (Bitcoin Core adds every
// leaf and reorders the tree), and nothing in another owner's file gets to change
// what this proposal says.
function combine(psbts, policy){
  const [first, ...rest] = psbts.map(load);
  for(const other of rest){
    if(hex.encode(other.unsignedTx) !== hex.encode(first.unsignedTx)) throw new Error('those are two different proposals');
    // Amounts are not in the unsigned transaction, so one proposal id can arrive
    // claiming different ones. A copy that does is not a copy.
    for(let i = 0; i < first.inputsLength; i++){
      if(first.getInput(i).witnessUtxo?.amount !== other.getInput(i).witnessUtxo?.amount) throw new Error('those copies disagree about an amount');
    }
    addSignatures(first, other);
  }
  const out = base64.encode(first.toPSBT());
  inspect(out, policy);
  return out;
}

// The library's finalizer does not know a delayed multi_a leaf, and a witness is
// easy to get exactly right by hand: one item per key in reverse script order, a
// signature for the first k who signed and empty for the rest, then script and
// control block. Extra signatures must be left out, because the script requires
// NUMEQUAL k rather than at least k.
function finalize(psbtText, policy){
  const view = inspect(psbtText, policy);
  if(!view.ready) throw new Error(`needs ${view.threshold} signatures on every input`);
  const tx = load(psbtText);
  for(let i = 0; i < tx.inputsLength; i++){
    const inp = tx.getInput(i), by = new Map(sigsFor(inp, view.inputs[i]).map(([{ pubKey }, sig]) => [hex.encode(pubKey), sig]));
    let left = view.threshold;
    const sigs = view.inputs[i].keys.map(k => {
      const id = hex.encode(k.pubkey);
      return left > 0 && by.has(id) ? (left--, by.get(id)) : new Uint8Array(0);
    }).reverse();
    tx.updateInput(i, { finalScriptWitness: [...sigs, view.inputs[i].script, view.inputs[i].control] }, true);
  }
  return hex.encode(tx.extract());
}
const txidOf = raw => Transaction.fromRaw(hex.decode(raw), { allowUnknownInputs: true }).id;

// True when a seat holds this owner's key but describes it wrongly. The key still
// signs here, but a hardware wallet finds keys by exactly that text.
const seatMisdescribed = (policy, owner) => policy.paths.some(p => p.keys.some(k => sameKey(k, owner, policy.network)
  && (k.fingerprint !== owner.fingerprint || pathText(k.path) !== pathText(owner.path))));

// ── CHAIN ──────────────────────────────────────────────────
// An Esplora API, with a second operator for when the first is down. It can lie
// about what is spendable, and the worst that gets it is a proposal that cannot
// confirm; it cannot make anyone sign away more than the review shows.
//
// A scan is dozens of requests, and an explorer that has blocked this address fails
// every one of them. So a server that fails goes to the back of the line for a
// minute, as Tacit does, or each lookup would wait on it first and a scan would take
// as long as forty failures. It is moved back, not dropped: if the other is down too,
// it is still asked.
const _down = new Map();
function chain(network, doFetch = (...a) => root.fetch(...a), bases = net(network).api){
  const isDown = b => (_down.get(b) || 0) > Date.now();
  const get = async (path, opts = {}, read = 'json') => {
    let last;
    for(const b of [...bases].sort((x, y) => isDown(x) - isDown(y))){
      try {
        const r = await doFetch(b + path, { ...opts, signal: root.AbortSignal?.timeout(TIMEOUT_MS) });
        if(r.ok) return await r[read]();
        last = new Error(await r.text());
        // A node refusing a transaction refuses it everywhere: asking the next one
        // only hides the reason behind a second, less useful error.
        if(r.status === 400) break;
      } catch(e) { last = e; }
      _down.set(b, Date.now() + COOLDOWN_MS);
    }
    throw last;
  };
  return {
    async tip(){
      const height = await get('/blocks/tip/height');
      if(!Number.isSafeInteger(height) || height < 0) throw new Error('the explorer sent a bad block height');
      return height;
    },
    async used(address){
      const a = await get(`/address/${address}`);
      return a.chain_stats.tx_count + a.mempool_stats.tx_count > 0;
    },
    // Every operator, not the first that answers.
    async usedByAll(address){
      for(const b of bases){
        const r = await doFetch(`${b}/address/${address}`, { signal: root.AbortSignal?.timeout(TIMEOUT_MS) });
        const a = await r.json();
        if(a.chain_stats.tx_count + a.mempool_stats.tx_count <= 0) return false;
      }
      return true;
    },
    async utxos(address){
      // Checked here, once, because all of this ends up on a page. An explorer is a
      // stranger and its strings are not trusted to be numbers or hashes.
      return (await get(`/address/${address}/utxo`)).map(u => {
        const coin = { txid: u.txid, vout: u.vout, value: u.value, height: u.status?.confirmed ? u.status.block_height : 0 };
        if(!/^[0-9a-f]{64}$/.test(coin.txid) || !Number.isSafeInteger(coin.vout) || !Number.isSafeInteger(coin.value) || coin.value < 0 || !Number.isSafeInteger(coin.height)) throw new Error('the explorer sent a bad coin');
        return coin;
      });
    },
    fees: () => get('/fee-estimates'),
    tx: txid => get(`/tx/${txid}`),
    async classify(outpoints){
      const r = await doFetch(`https://api.tacit.finance/outpoints/classify?network=${network}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outpoints }), signal: root.AbortSignal?.timeout(30000) });
      if(!r.ok) throw new Error('Tacit check failed');
      return (await r.json()).coins || {};
    },
    spent: async (txid, vout) => (await get(`/tx/${txid}/outspend/${vout}`)).spent === true,
    broadcast: tx => get('/tx', { method: 'POST', body: tx }, 'text'),
  };
}

// Walks both chains until GAP addresses in a row have never been used. Small batches,
// because a public explorer rate-limits a page that asks for forty addresses at once.
async function scan(policy, c, gap = GAP){
  const coins = [], next = [0, 0];
  let truncated = false;
  for(const branch of [0, 1]){
    let index = 0, idle = 0;
    while(idle < gap){
      // Deposits can be spread out on purpose to make a scan run on. It stops here and
      // says so, and the coins it found stay usable.
      if(index >= MAX_INDEX){ truncated = true; break; }
      const batch = Array.from({ length: Math.min(5, gap - idle, MAX_INDEX - index) }, (_, i) => index + i);
      const seen = await Promise.all(batch.map(i => c.used(vaultOf(policy, branch, i).address)));
      for(let i = 0; i < batch.length; i++){
        if(!seen[i]){ idle++; continue; }
        idle = 0;
        next[branch] = batch[i] + 1;
        for(const u of await c.utxos(vaultOf(policy, branch, batch[i]).address)) coins.push({ ...u, branch, index: batch[i] });
      }
      index += batch.length;
    }
    // How far along a vault is decides what counts as change, so one explorer alone
    // does not get to move it past the gap: another operator must agree.
    if(next[branch] > gap && c.usedByAll){
      const sure = await c.usedByAll(vaultOf(policy, branch, next[branch] - 1).address).catch(() => false);
      if(!sure) throw new Error('the explorers disagree about this vault, so its balance cannot be trusted right now');
    }
    // A vault pushed to the end reuses addresses inside the range, not ones past it: the
    // next deposit and the next change must land where a scan and a signer will look.
    next[branch] = Math.min(next[branch], MAX_INDEX - gap);
  }
  if(c.tx) await classifyCoins(coins, c);
  return { coins, receive: next[0], change: next[1], truncated };
}

// Sets `quarantine` on any coin that is not provably plain. Fails closed throughout: a
// coin that could not be checked is treated as one that failed.
async function classifyCoins(coins, c){
  if(!c.tx) throw new Error('cannot check coins for tokens');
  const hits = [];
  // Dust is never spent anyway, so a flood of it costs no lookups. Anything larger is
  // asked about a few at a time, so a flood just over the line stays a slow page.
  const spendable = coins.filter(u => u.value > DUST);
  for(let i = 0; i < spendable.length; i += 8) await Promise.all(spendable.slice(i, i + 8).map(async u => {
    u.quarantine = undefined;
    try { if(hasTacitEnvelope(await c.tx(u.txid))) hits.push(u); }
    catch(_) { u.quarantine = 'unknown'; }
  }));
  for(let i = 0; i < hits.length; i += 100){
    const chunk = hits.slice(i, i + 100);
    if(!c.classify){ chunk.forEach(u => { u.quarantine = 'tacit'; }); continue; }
    let verdicts;
    try { verdicts = await c.classify(chunk.map(u => `${u.txid}:${u.vout}`)); }
    catch(_) { chunk.forEach(u => { u.quarantine = 'unknown'; }); continue; }
    for(const u of chunk){
      const v = verdicts[`${u.txid}:${u.vout}`];
      if(v?.status === 'plain') continue;
      if(v?.status === 'asset'){ u.quarantine = 'tacit'; u.asset = v.asset_ids?.[0]; }
      else u.quarantine = 'unknown';
    }
  }
}

// The same check on exactly what is about to be signed. A coin list can be minutes old,
// and a proposal can come from someone else. Throws rather than letting a signature out.
async function assertSpendable(inputs, c){
  const coins = inputs.map(i => ({ txid: i.txid, vout: i.vout, value: i.sats }));
  await classifyCoins(coins, c);
  if(coins.some(isProtected)) throw new Error('A coin in this proposal may hold a Tacit asset, or could not be checked, so it was not signed. Try again shortly.');
}

function concat(...parts){
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for(const p of parts){ out.set(p, at); at += p.length; }
  return out;
}

const keyPoint = (owner, network) => HDKey.fromExtendedKey(owner.xpub, net(network).versions).publicKey;
root.BitcoinVault = Object.freeze({ policySummary, aboutBlocks, signPossession, keyPoint, ownersOf, HOW_IT_WORKS, describePolicy, keyId, isName, resolveName, exportAccountKey, recoveryText, sameKey, TACIT_ASSETS, signOwnerAuth, verifyOwnerAuth, saveVault, listVaults, assertSpendable, isProtected, hasTacitEnvelope, walletMessage, linkMessage, keyFromWalletSignature, evmSignHash, evmSignMessage, bitcoinMessageHash, bitcoinSigners, handleForWallet, proposalId, vaultId, publishProposal, fetchProposals, openProposals, publishHandle, fetchHandles, MAX_INDEX, txidOf, seatMisdescribed, EVM_CHAINS, selectors: { threshold: selector('threshold()') }, readEvmVault, mirror, bindingMessage, evmMessageHash, NETWORKS, DUST, GAP, MAX_OWNERS, MAX_OLDER, MAX_FEE_RATE, encodeOwner, decodeOwner, originText, ownerMessage, deriveOwnerKey, keyFromSignature, fingerprintOf,
  policyOf, descriptor, descriptorChecksum, parseDescriptor, walletPolicy, vaultOf, vsize, coinsFor, propose, inspect, sign, combine, finalize, chain, scan, evmSigner });

})(typeof window !== 'undefined' ? window : globalThis);
