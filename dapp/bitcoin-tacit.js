'use strict';
// Tacit notes under a vault. A vault has no single key, and a note needs one: its amount is
// blinded to the recipient's private key. So moving a note and reading one are split. A
// note key V reads notes and gives the vault a tacit1 address, and the owners share it. The
// note itself is moved under the vault's script, because Tacit's rules look at an output's
// envelope and ancestry, never at the script that holds it.
//
// Anyone with V can read, and can spend what is still at V's own address. So a note there
// is in an inbox, on the way to the vault, and V is never the place anything stays.
//
// V reaches owners sealed to their keys, and the record says which owner made it. The
// store only carries it: a record is checked against the vault's own keys on every load,
// because a swapped V would send every deposit to whoever swapped it.

(function(root){

const { secp256k1, schnorr, sha256, hex, bech32m } = root.btc;
const BV = root.BitcoinVault;
const te = new TextEncoder();
const N = secp256k1.Point.Fn.ORDER;
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for(const p of parts){ out.set(p, at); at += p.length; }
  return out;
};
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const big = b => BigInt(`0x${hex.encode(b)}`);
const reversed = b => Uint8Array.from(b).reverse();
function hmac(key, msg){
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256(key) : key);
  return sha256(concat(k.map(x => x ^ 0x5c), sha256(concat(k.map(x => x ^ 0x36), msg))));
}

// ── ADDRESS ─────────────────────────────────────────────────
// Bitcoin lane only. A sender on Ethereum reads another lane as a pool key, and a payment
// there would sit under V alone with no sweep to the vault, so that lane is left off.
const HRP = { mainnet: 'tacit', signet: 'tactt' };
const LANE_BTC = 0x01;
function tacitAddress(spendPub, scanPub, network){
  if(!Object.hasOwn(HRP, network)) throw new Error('no tacit address on this network');
  if(spendPub.length !== 33 || scanPub.length !== 33) throw new Error('keys must be 33 bytes');
  return bech32m.encode(HRP[network], bech32m.toWords(concat(Uint8Array.of(0, LANE_BTC), spendPub, scanPub)), 1023);
}

// ── THE NOTE KEY ────────────────────────────────────────────
const accountOf = (signer, network) => signer.derive(`m/87'/${BV.NETWORKS[network].coin}'/0'`);
// From the maker's key, so they can always make it again, and from the vault, so one
// owner's vaults never share one. The scan half is only there to fill the lane.
function makeNoteKey(signer, policy){
  const account = accountOf(signer, policy.network);
  const priv = hmac(account.privateKey, concat(te.encode('multisig-note-key-v1\0'), hex.decode(BV.vaultId(policy))));
  account.wipePrivateData();
  if(big(priv) === 0n || big(priv) >= N) throw new Error('that vault cannot use this key');
  return priv;
}
const scanOf = priv => hmac(priv, te.encode('multisig-note-scan-v1'));
const noteAddress = (priv, network) => tacitAddress(secp256k1.getPublicKey(priv, true), secp256k1.getPublicKey(scanOf(priv), true), network);

// An owner's account key, the one in the descriptor, opens their seal.
const pubOf = (owner, network) => BV.keyPoint(owner, network);
const sealKey = async (secret, iv, usage) => root.crypto.subtle.importKey('raw', sha256(concat(te.encode('multisig-note-seal-v1\0'), secret, iv)), 'AES-GCM', false, [usage]);
async function seal(priv, owner, network){
  const eph = secp256k1.utils.randomSecretKey(), iv = root.crypto.getRandomValues(new Uint8Array(12));
  const secret = secp256k1.getSharedSecret(eph, pubOf(owner, network)).slice(1);
  const ct = new Uint8Array(await root.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(secret, iv, 'encrypt'), priv));
  return { eph: hex.encode(secp256k1.getPublicKey(eph, true)), iv: hex.encode(iv), ct: hex.encode(ct) };
}

const ownersOn = policy => {
  const seen = new Map();
  for(const p of policy.paths) for(const k of p.keys) seen.set(BV.keyId(k, policy.network), k);
  return [...seen.entries()];
};
const recordHash = (policy, pub, seals) => sha256(concat(te.encode('multisig-note-record-v1\0'), hex.decode(BV.vaultId(policy)), te.encode(pub), te.encode(JSON.stringify(Object.keys(seals).sort().map(k => [k, seals[k].eph, seals[k].iv, seals[k].ct])))));

// Sealed to every owner at once, so no one has to be around for anyone else's copy.
async function makeRecord(signer, self, policy){
  if(!ownersOn(policy).some(([, k]) => BV.sameKey(k, self, policy.network))) throw new Error('only an owner can set up the note key');
  const priv = makeNoteKey(signer, policy), pub = hex.encode(secp256k1.getPublicKey(priv, true));
  const seals = {};
  for(const [id, k] of ownersOn(policy)) seals[id] = await seal(priv, k, policy.network);
  const account = accountOf(signer, policy.network);
  const sig = hex.encode(schnorr.sign(recordHash(policy, pub, seals), account.privateKey));
  account.wipePrivateData();
  return { pub, by: BV.keyId(self, policy.network), seals, sig };
}

// Everything a record claims, held against the vault's own keys. A record that fails is
// treated as no record, so the page can never show an address from one.
function verifyRecord(policy, record){
  if(!record || !/^0[23][0-9a-f]{64}$/.test(String(record.pub)) || !/^[0-9a-f]{128}$/.test(String(record.sig)) || !record.seals) return false;
  const owners = ownersOn(policy), maker = owners.find(([id]) => id === record.by);
  if(!maker || !owners.every(([id]) => record.seals[id])) return false;
  if(Object.keys(record.seals).length !== owners.length) return false;
  try { return schnorr.verify(hex.decode(record.sig), recordHash(policy, record.pub, record.seals), pubOf(maker[1], policy.network).subarray(1)); }
  catch(_) { return false; }
}

// Opens this owner's seal, and takes it only if it is the key the record names: another
// owner signed for V, but a seal is theirs to write, and a wrong one must not read as V.
async function openRecord(record, signer, self, policy){
  if(!verifyRecord(policy, record)) throw new Error('that note key record does not check out');
  const s = record.seals[BV.keyId(self, policy.network)];
  if(!s) throw new Error('this key is not an owner of that vault');
  const account = accountOf(signer, policy.network), iv = hex.decode(s.iv);
  const secret = secp256k1.getSharedSecret(account.privateKey, hex.decode(s.eph)).slice(1);
  account.wipePrivateData();
  const priv = new Uint8Array(await root.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await sealKey(secret, iv, 'decrypt'), hex.decode(s.ct)));
  if(hex.encode(secp256k1.getPublicKey(priv, true)) !== record.pub) throw new Error('that seal does not hold the note key');
  return priv;
}

// ── READING A NOTE ──────────────────────────────────────────
// Tacit's own derivations, byte for byte. `anchor` is the first asset input's outpoint.
const CXFER = new Set([0x22, 0x23]);
const H = (() => {
  const seed = sha256(te.encode('tacit-generator-H-v1'));
  for(let i = 0; i < 256; i++){
    try { return secp256k1.Point.fromHex(hex.encode(concat(Uint8Array.of(2), sha256(concat(seed, Uint8Array.of(i)))))); } catch(_) {}
  }
  throw new Error('no generator');
})();
const commit = (v, r) => {
  const a = v % N === 0n ? null : H.multiply(v % N), b = r % N === 0n ? null : secp256k1.Point.BASE.multiply(r % N);
  return a && b ? a.add(b) : a || b;
};
const ecdh = (priv, pub) => sha256(secp256k1.getSharedSecret(priv, pub).slice(1));
const derive = {
  blind: (priv, pub, anchor, vout) => big(hmac(ecdh(priv, pub), concat(te.encode('tacit-blind-v1'), anchor, u32(vout)))) % N,
  stream: (priv, pub, anchor, vout) => hmac(ecdh(priv, pub), concat(te.encode('tacit-amount-v1'), anchor, u32(vout))).slice(0, 8),
  selfBlind: (priv, anchor, vout) => big(hmac(priv, concat(te.encode('tacit-change-v1'), anchor, u32(vout)))) % N,
  selfStream: (priv, anchor, vout) => hmac(priv, concat(te.encode('tacit-amount-self-v1'), anchor, u32(vout))).slice(0, 8),
};
const unmask = (ct, ks) => {
  let v = 0n;
  for(let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(ct[i] ^ ks[i]);
  return v;
};

// The body of an envelope's reveal: <key> CHECKSIG FALSE IF "TACIT" 1 <pushes> ENDIF.
function envelopeOf(script){
  if(script?.length < 36 || script[0] !== 32 || script[33] !== 0xac || script[34] !== 0x00 || script[35] !== 0x63) return null;
  const pushes = [];
  for(let p = 36; p < script.length;){
    const op = script[p++];
    if(op === 0x68) break;
    let n;
    if(op >= 1 && op <= 75) n = op;
    else if(op === 0x4c) n = script[p++];
    else if(op === 0x4d){ n = script[p] | (script[p + 1] << 8); p += 2; }
    else return null;
    pushes.push(script.subarray(p, p + n));
    p += n;
  }
  if(pushes.length < 3 || new TextDecoder().decode(pushes[0]) !== 'TACIT' || pushes[1].length !== 1 || pushes[1][0] !== 1) return null;
  return concat(...pushes.slice(2));
}
function outputsOf(payload){
  if(!payload || !CXFER.has(payload[0]) || payload.length < 98) return null;
  const n = payload[97], asset = hex.encode(payload.subarray(1, 33));
  if(![1, 2, 4, 8].includes(n) || payload.length < 98 + n * 41) return null;
  return { asset, outputs: Array.from({ length: n }, (_, i) => ({ commitment: payload.subarray(98 + i * 41, 131 + i * 41), ct: payload.subarray(131 + i * 41, 139 + i * 41) })) };
}

// A note from an explorer's transaction, opened with V. Returns null unless the amount
// reproduces the commitment on chain, which is what makes it the amount and not a guess.
function openNote(tx, vout, priv){
  if(!tx?.vin?.[0]?.witness || tx.vin.length < 2 || tx.vin[0].witness.length < 3) return null;
  const body = outputsOf(envelopeOf(hex.decode(tx.vin[0].witness[1])));
  const out = body?.outputs[vout];
  if(!out) return null;
  const first = tx.vin[1], anchor = concat(reversed(hex.decode(first.txid)), u32(first.vout));
  const fits = (v, r) => { try { return v < (1n << 64n) && commit(v, r)?.equals(secp256k1.Point.fromHex(hex.encode(out.commitment))); } catch(_) { return false; } };
  const w = first.witness;
  if(w?.length === 2 && w[1].length === 66){
    const sender = hex.decode(w[1]);
    try {
      const amount = unmask(out.ct, derive.stream(priv, sender, anchor, vout)), blinding = derive.blind(priv, sender, anchor, vout);
      if(fits(amount, blinding)) return { asset: body.asset, amount, blinding, path: 'sent' };
    } catch(_) {}
  }
  const amount = unmask(out.ct, derive.selfStream(priv, anchor, vout)), blinding = derive.selfBlind(priv, anchor, vout);
  return fits(amount, blinding) ? { asset: body.asset, amount, blinding, path: 'self' } : null;
}

root.BitcoinTacit = Object.freeze({ tacitAddress, noteAddress, makeNoteKey, makeRecord, verifyRecord, openRecord, openNote, envelopeOf, outputsOf });

})(typeof window !== 'undefined' ? window : globalThis);
