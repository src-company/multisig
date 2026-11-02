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

const { secp256k1, schnorr, sha256, hex, bech32m, p2wpkh } = root.btc;
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

// Where a tacit1 payment lands: a plain send pays the key's own P2WPKH address.
const inboxAddress = (priv, network) => p2wpkh(secp256k1.getPublicKey(priv, true), BV.NETWORKS[network].params).address;

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

// What sits in the inbox. An amount is only shown for a coin Tacit's own check calls an
// asset, because a note that opens is not yet a note that is valid: anyone can write one.
async function readInbox(priv, network, chain){
  const coins = (await chain.utxos(inboxAddress(priv, network))).slice(0, 50), out = [];
  const verdicts = coins.length ? await chain.classify(coins.map(c => `${c.txid}:${c.vout}`)).catch(() => ({})) : {};
  for(const c of coins){
    const status = verdicts[`${c.txid}:${c.vout}`]?.status;
    if(status === 'plain'){ out.push({ ...c, status }); continue; }
    const n = status === 'asset' ? openNote(await chain.tx(c.txid), c.vout, priv) : null;
    out.push({ ...c, status: status === 'asset' && !n ? 'unreadable' : status || 'unverified', asset: verdicts[`${c.txid}:${c.vout}`]?.asset_ids?.[0] || n?.asset, amount: n?.amount, blinding: n?.blinding });
  }
  return out;
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

// ── MOVING A NOTE ───────────────────────────────────────────
// Tacit calls an op a commit and a reveal. The commit pays a Taproot output that holds the
// envelope, and the reveal spends it first and the notes after. Fees come from plain sats
// at V's own address, so nothing here touches the vault's bitcoin.
//
// A vault spend is signed here and not by the vault's PSBT signer, which refuses every
// foreign input on purpose and stays that way. The price is that everything the PSBT
// signer would have checked is checked again here, and more: a bad op on Tacit destroys
// its inputs, so a broken proof from a co-owner is a burn, not a failed transaction.
const DUST_OUT = 546, SEQ = 0xfffffffd, MAX_NOTES = 16;
const tag = (t, m) => { const h = sha256(te.encode(t)); return sha256(concat(h, h, m)); };
const dsha = b => sha256(sha256(b));
const le64 = n => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const varint = n => n < 0xfd ? Uint8Array.of(n) : Uint8Array.of(0xfd, n & 255, n >> 8);
const vbytes = b => concat(varint(b.length), b);
const hash160 = pub => p2wpkh(pub, BV.NETWORKS.signet.params).script.slice(2);
const wpkh = pub => concat(Uint8Array.of(0, 20), hash160(pub));
const reversedHex = h => reversed(hex.decode(h));
const prevout = i => concat(reversedHex(i.txid), u32(i.vout));
const outsBytes = tx => concat(...tx.outs.map(o => concat(le64(o.value), vbytes(hex.decode(o.spk)))));
function rawTx(tx, wit){
  const ins = concat(...tx.ins.map(i => concat(prevout(i), Uint8Array.of(0), u32(SEQ))));
  return concat(u32(2), wit ? Uint8Array.of(0, 1) : new Uint8Array(0), varint(tx.ins.length), ins, varint(tx.outs.length), outsBytes(tx),
    wit ? concat(...wit.map(w => concat(varint(w.length), ...w.map(vbytes)))) : new Uint8Array(0), u32(0));
}
const txidOf = tx => hex.encode(reversed(dsha(rawTx(tx))));
function sigV0(tx, i, priv){
  const pub = secp256k1.getPublicKey(priv, true), n = tx.ins[i];
  const code = concat(Uint8Array.of(0x19, 0x76, 0xa9, 0x14), hash160(pub), Uint8Array.of(0x88, 0xac));
  const h = dsha(concat(u32(2), dsha(concat(...tx.ins.map(prevout))), dsha(concat(...tx.ins.map(() => u32(SEQ)))), prevout(n), code, le64(n.value), u32(SEQ), dsha(outsBytes(tx)), u32(0), u32(1)));
  return concat(secp256k1.sign(h, priv, { prehash: false, format: 'der' }), Uint8Array.of(1));
}
function leafHash(tx, i, script){
  const leaf = tag('TapLeaf', concat(Uint8Array.of(0xc0), vbytes(script)));
  return tag('TapSighash', concat(Uint8Array.of(0, 0), u32(2), u32(0), sha256(concat(...tx.ins.map(prevout))), sha256(concat(...tx.ins.map(n => le64(n.value)))),
    sha256(concat(...tx.ins.map(n => vbytes(hex.decode(n.spk))))), sha256(concat(...tx.ins.map(() => u32(SEQ)))), sha256(outsBytes(tx)), Uint8Array.of(2), u32(i), leaf, Uint8Array.of(0), Uint8Array.of(255, 255, 255, 255)));
}
const push = d => d.length <= 75 ? concat(Uint8Array.of(d.length), d) : d.length <= 255 ? concat(Uint8Array.of(0x4c, d.length), d) : concat(Uint8Array.of(0x4d, d.length & 255, d.length >> 8), d);
function envelopeScript(xonly, payload){
  const parts = [push(xonly), Uint8Array.of(0xac, 0x00, 0x63), push(te.encode('TACIT')), push(Uint8Array.of(1))];
  for(let i = 0; i < payload.length; i += 520) parts.push(push(payload.subarray(i, i + 520)));
  return concat(...parts, Uint8Array.of(0x68));
}
function envelopeOutput(script){
  const internal = root.btc.TAPROOT_UNSPENDABLE_KEY, leaf = tag('TapLeaf', concat(Uint8Array.of(0xc0), vbytes(script)));
  const t = big(tag('TapTweak', concat(internal, leaf))) % N;
  const q = secp256k1.Point.fromHex(`02${hex.encode(internal)}`).add(secp256k1.Point.BASE.multiply(t)).toBytes(true);
  return { spk: concat(Uint8Array.of(0x51, 0x20), q.slice(1)), control: concat(Uint8Array.of(0xc0 | (q[0] & 1)), internal) };
}

// A transfer's payload, from outputs that already know their blindings.
function kernelMessage(asset, ins, commitments){
  return sha256(concat(te.encode('tacit-kernel-v1'), asset, Uint8Array.of(ins.length), ...ins.map(prevout), Uint8Array.of(commitments.length), ...commitments, new Uint8Array(8)));
}
const bytes32 = n => hex.decode(n.toString(16).padStart(64, '0'));
function buildPayload(prover, asset, ins, outs){
  const Cs = outs.map(o => commit(o.amount, o.r).toBytes(true));
  const excess = ((outs.reduce((s, o) => s + o.r, 0n) - ins.reduce((s, i) => s + i.r, 0n)) % N + N) % N;
  if(excess === 0n) throw new Error('that transfer has no kernel');
  const sig = schnorr.sign(kernelMessage(asset, ins, Cs), bytes32(excess));
  const proof = prover.prove(outs.map(o => o.amount), outs.map(o => o.r));
  return concat(Uint8Array.of(0x23), asset, sig, Uint8Array.of(outs.length), ...outs.flatMap((o, i) => [Cs[i], o.ct]), Uint8Array.of(proof.length & 255, proof.length >> 8), proof);
}
const mask = (v, ks) => { const b = new Uint8Array(8); for(let i = 0; i < 8; i++) b[i] = Number((v >> BigInt(8 * i)) & 255n) ^ ks[i]; return b; };
const selfOut = (priv, anchor, i, amount) => ({ amount, r: derive.selfBlind(priv, anchor, i), ct: mask(amount, derive.selfStream(priv, anchor, i)) });
const sentOut = (priv, pub, anchor, i, amount) => ({ amount, r: derive.blind(priv, pub, anchor, i), ct: mask(amount, derive.stream(priv, pub, anchor, i)) });

// The commit, signed with V, and the reveal's skeleton on top of it. `fee` is a plain coin
// at V's address. What is left after both fees goes back there.
function frame({ priv, fee, rate, script, assets, spks }){
  const pub = secp256k1.getPublicKey(priv, true), mine = hex.encode(wpkh(pub)), env = envelopeOutput(script);
  const revealFee = Math.ceil((170 + 80 * assets.length + 45 * spks.length + script.length / 4) * rate), commitFee = Math.ceil(170 * rate);
  const carried = assets.reduce((n, a) => n + a.value, 0), need = Math.max(DUST_OUT * spks.length + revealFee - carried, DUST_OUT);
  const change = fee.value - need - commitFee;
  if(change < 0) throw new Error(`the note key's address needs ${-change} more sats for fees`);
  const commitTx = { ins: [{ txid: fee.txid, vout: fee.vout, value: fee.value, spk: mine }], outs: [{ value: need, spk: hex.encode(env.spk) }, ...(change >= DUST_OUT ? [{ value: change, spk: mine }] : [])] };
  const commitWit = [[sigV0(commitTx, 0, priv), pub]];
  const reveal = { ins: [{ txid: txidOf(commitTx), vout: 0, value: need, spk: hex.encode(env.spk) }, ...assets], outs: spks.map(spk => ({ value: DUST_OUT, spk })) };
  const spare = need + carried - DUST_OUT * spks.length - revealFee;
  if(spare >= DUST_OUT) reveal.outs.push({ value: spare, spk: mine });
  return { commit: hex.encode(rawTx(commitTx, commitWit)), reveal, env };
}

// Inbox to vault. One owner can do this, since V can already move these notes, and the
// sooner it happens the better. It leaves a zero note at V for the next send to lead with.
function buildSweep({ priv, notes, fee, rate, vaultSpk, prover }){
  if(!notes.length || notes.length > MAX_NOTES) throw new Error('nothing to move');
  if(new Set(notes.map(n => n.asset)).size !== 1) throw new Error('one asset at a time');
  const pub = secp256k1.getPublicKey(priv, true), mine = hex.encode(wpkh(pub));
  const ins = notes.map(n => ({ txid: n.txid, vout: n.vout, value: n.value, spk: mine, r: n.blinding }));
  const anchor = prevout(ins[0]), total = notes.reduce((s, n) => s + n.amount, 0n);
  const outs = [selfOut(priv, anchor, 0, total), selfOut(priv, anchor, 1, 0n)];
  const payload = buildPayload(prover, hex.decode(notes[0].asset), ins, outs);
  const script = envelopeScript(pub.subarray(1), payload);
  const { commit: commitHex, reveal, env } = frame({ priv, fee, rate, script, assets: ins.map(({ r, ...a }) => a), spks: [hex.encode(vaultSpk), mine] });
  const wit = [[schnorr.sign(leafHash(reveal, 0, script), priv), script, env.control], ...ins.map((_, i) => [sigV0(reveal, i + 1, priv), pub])];
  return { commit: commitHex, reveal: hex.encode(rawTx(reveal, wit)) };
}

// Vault to anyone. Output 0 pays the recipient, 1 is the vault's change, and 2 and 3 are
// zero notes at V, the next send's lead. A plain send's receiver reads the sender from
// the first asset input, and a vault has no key to show there, so V's zero note goes first.
function buildSend({ priv, keyNote, notes, recipient, amount, fee, rate, slot, prover }){
  if(amount <= 0n || !notes.length || notes.length > MAX_NOTES) throw new Error('nothing to send');
  if(new Set([keyNote, ...notes].map(n => n.asset)).size !== 1) throw new Error('one asset at a time');
  const total = notes.reduce((s, n) => s + n.amount, 0n);
  if(amount > total) throw new Error('that is more than this vault holds');
  const pub = secp256k1.getPublicKey(priv, true), mine = hex.encode(wpkh(pub));
  const ins = [{ txid: keyNote.txid, vout: keyNote.vout, value: keyNote.value, spk: mine, r: keyNote.blinding, kind: 'key' },
    ...notes.map(n => ({ txid: n.txid, vout: n.vout, value: n.value, spk: hex.encode(BV.vaultOf(slot.policy, n.branch, n.index).script), r: n.blinding, kind: 'vault', branch: n.branch, index: n.index }))];
  const anchor = prevout(ins[0]);
  const outs = [sentOut(priv, recipient, anchor, 0, amount), selfOut(priv, anchor, 1, total - amount), selfOut(priv, anchor, 2, 0n), selfOut(priv, anchor, 3, 0n)];
  const payload = buildPayload(prover, hex.decode(keyNote.asset), ins, outs);
  const script = envelopeScript(pub.subarray(1), payload);
  const change = BV.vaultOf(slot.policy, 0, slot.index), spks = [hex.encode(wpkh(recipient)), hex.encode(change.script), mine, mine];
  const { commit: commitHex, reveal, env } = frame({ priv, fee, rate, script, assets: ins.map(({ r, ...a }) => a), spks });
  const proposal = { v: 1, commit: commitHex, script: hex.encode(script), reveal, recipient: hex.encode(recipient), amount: amount.toString(), changeIndex: slot.index,
    envSig: hex.encode(schnorr.sign(leafHash(reveal, 0, script), priv)), keySig: hex.encode(sigV0(reveal, 1, priv)), sigs: {} };
  return { ...proposal, control: hex.encode(env.control), keyPub: hex.encode(pub) };
}

// Everything a signer must know before putting a signature on a send. The proposal is a
// stranger's text. Each output is rebuilt from V, so no amount or address is taken from
// it, and a proof or kernel that would burn the notes stops here.
async function reviewSend(p, policy, priv, chain, prover){
  const refuse = why => { throw new Error(`refusing this send: ${why}`); };
  const pub = secp256k1.getPublicKey(priv, true), mine = hex.encode(wpkh(pub)), { reveal } = p;
  if(p.v !== 1 || !/^[0-9a-f]+$/.test(String(p.script)) || !/^0[23][0-9a-f]{64}$/.test(String(p.recipient))) refuse('it is not a send');
  if(!Array.isArray(reveal?.ins) || !Array.isArray(reveal?.outs) || reveal.ins.length < 3 || reveal.ins.length > MAX_NOTES + 2) refuse('it has the wrong inputs');
  const script = hex.decode(p.script), payload = envelopeOf(script), body = outputsOf(payload), recipient = hex.decode(p.recipient);
  if(!body || payload[0] !== 0x23 || body.outputs.length !== 4) refuse('it is not a transfer');
  if(hex.encode(script.subarray(1, 33)) !== hex.encode(pub.subarray(1))) refuse('it is not signed by this vault\'s note key');
  // Inputs: the envelope, V's zero note, then notes held by this vault, and nothing else.
  const env = envelopeOutput(script), [e, key, ...held] = reveal.ins;
  if(e.spk !== hex.encode(env.spk) || e.vout !== 0) refuse('the envelope input does not match');
  if(key.kind !== 'key' || key.spk !== mine) refuse('it does not lead with the note key');
  if(p.control !== hex.encode(env.control)) refuse('the envelope path does not match');
  const seen = new Set(reveal.ins.map(i => `${i.txid}:${i.vout}`));
  if(seen.size !== reveal.ins.length) refuse('it repeats a coin');
  const opened = [];
  for(const i of [key, ...held]){
    const tx = await chain.tx(i.txid);
    if(tx.txid !== i.txid || tx.vout?.[i.vout]?.value !== i.value || tx.vout[i.vout].scriptpubkey !== i.spk) refuse('an input is not what it says');
    const n = openNote(tx, i.vout, priv);
    if(!n || n.asset !== body.asset) refuse('an input is not a note of this asset');
    opened.push(n);
  }
  for(const i of held){
    if(i.kind !== 'vault' || !Number.isInteger(i.branch) || !Number.isInteger(i.index) || i.index >= BV.MAX_INDEX) refuse('an input is not the vault\'s');
    if(hex.encode(BV.vaultOf(policy, i.branch, i.index).script) !== i.spk) refuse('an input is not the vault\'s');
  }
  if(opened[0].amount !== 0n) refuse('the lead note is not empty');
  const verdicts = await chain.classify([...seen].slice(1));
  for(const id of [...seen].slice(1)) if(verdicts[id]?.status !== 'asset') refuse('Tacit does not vouch for an input');
  // Outputs: rebuilt from V. Anything that does not come out the same is not this send.
  const anchor = prevout(key), amount = BigInt(p.amount), total = opened.reduce((s, n) => s + n.amount, 0n);
  if(amount <= 0n || amount > total) refuse('the amount does not fit');
  if(!Number.isInteger(p.changeIndex) || p.changeIndex < 0 || p.changeIndex >= BV.MAX_INDEX) refuse('the change address is out of range');
  const change = BV.vaultOf(policy, 0, p.changeIndex);
  const want = [sentOut(priv, recipient, anchor, 0, amount), selfOut(priv, anchor, 1, total - amount), selfOut(priv, anchor, 2, 0n), selfOut(priv, anchor, 3, 0n)];
  const spks = [hex.encode(wpkh(recipient)), hex.encode(change.script), mine, mine];
  want.forEach((o, i) => {
    if(hex.encode(commit(o.amount, o.r).toBytes(true)) !== hex.encode(body.outputs[i].commitment) || hex.encode(o.ct) !== hex.encode(body.outputs[i].ct)) refuse('a note does not match what is shown');
    if(reveal.outs[i]?.spk !== spks[i] || reveal.outs[i].value !== DUST_OUT) refuse('an address does not match what is shown');
  });
  const extra = reveal.outs.slice(4);
  if(extra.length > 1 || extra.some(o => o.spk !== mine)) refuse('it pays somewhere else');
  // What would make Tacit void the op, and so destroy the notes.
  const cs = body.outputs.map(o => o.commitment), ins = reveal.ins.slice(1);
  const E = cs.reduce((s, c) => s.add(secp256k1.Point.fromHex(hex.encode(c))), secp256k1.Point.ZERO ?? null);
  const excess = opened.reduce((s, n) => s.subtract(commit(n.amount, n.blinding) ?? secp256k1.Point.ZERO), E);
  const kernel = payload.subarray(33, 97), rpAt = 98 + 41 * 4, proof = payload.subarray(rpAt + 2, rpAt + 2 + (payload[rpAt] | (payload[rpAt + 1] << 8)));
  if(!schnorr.verify(kernel, kernelMessage(hex.decode(body.asset), ins, cs), excess.toBytes(true).subarray(1))) refuse('its kernel does not verify');
  if(payload.length !== rpAt + 2 + proof.length || !prover.verify(cs, proof)) refuse('its range proof does not verify');
  // The commit must pay this envelope, and the reveal must spend exactly that.
  if(commitIdOf(hex.decode(String(p.commit))) !== e.txid) refuse('the commit does not match');
  return { asset: body.asset, amount, total, change: total - amount, recipient: p.recipient, sats: reveal.ins.reduce((n, i) => n + i.value, 0) - reveal.outs.reduce((n, o) => n + o.value, 0) };
}

// A segwit transaction's id, read from its raw form.
function commitIdOf(raw){
  let p = 4;
  if(raw[p] !== 0 || raw[p + 1] !== 1) return null;
  p += 2;
  const start = p, nIn = raw[p++];
  for(let i = 0; i < nIn; i++){ p += 36; p += 1 + raw[p] + 4; }
  const nOut = raw[p++];
  for(let i = 0; i < nOut; i++){ p += 8; p += 1 + raw[p]; }
  return hex.encode(reversed(dsha(concat(raw.subarray(0, 4), raw.subarray(start, p), raw.subarray(raw.length - 4)))));
}

const sendId = p => hex.encode(sha256(te.encode(`${p.commit}|${p.script}`)));
function vaultLeaf(policy, input){
  const slot = BV.vaultOf(policy, input.branch, input.index), path = slot.paths[0], control = path.leaf[0];
  return { path, script: path.script, control: concat(Uint8Array.of(control.version), control.internalKey, ...control.merklePath) };
}
// Reviewed first, always. This owner's signature on every vault input, under the first
// path, the one that takes the quorum.
function signSend(p, signer, self, policy){
  const account = accountOf(signer, policy.network), held = p.reveal.ins.slice(2), sigs = {};
  held.forEach((input, n) => {
    const { path } = vaultLeaf(policy, input), me = path.keys.find(k => BV.sameKey(k.owner, self, policy.network));
    if(!me) throw new Error('this key is not an owner on that path');
    const child = account.deriveChild(me.chain).deriveChild(input.index);
    if(hex.encode(child.publicKey.subarray(1)) !== hex.encode(me.pubkey)) throw new Error('this key does not match its seat');
    sigs[n] = hex.encode(schnorr.sign(leafHash(p.reveal, n + 2, path.script), child.privateKey));
    child.wipePrivateData();
  });
  account.wipePrivateData();
  return { ...p, sigs: { ...p.sigs, [BV.keyId(self, policy.network)]: sigs } };
}
// Signatures that check out, per owner. One that does not is simply not counted.
function signersOf(p, policy){
  const threshold = policy.paths[0].threshold, held = p.reveal.ins.slice(2), done = [];
  for(const k of policy.paths[0].keys){
    const id = BV.keyId(k, policy.network), got = p.sigs?.[id];
    if(!got) continue;
    const ok = held.every((input, n) => {
      const { path } = vaultLeaf(policy, input), seat = path.keys.find(x => BV.sameKey(x.owner, k, policy.network));
      try { return /^[0-9a-f]{128}$/.test(String(got[n])) && schnorr.verify(hex.decode(got[n]), leafHash(p.reveal, n + 2, path.script), seat.pubkey); } catch(_) { return false; }
    });
    if(ok) done.push(id);
  }
  return { signed: done, threshold, ready: done.length >= threshold };
}
function finishSend(p, policy){
  const { signed, threshold, ready } = signersOf(p, policy);
  if(!ready) throw new Error(`needs ${threshold} signatures`);
  const chosen = new Set(signed.slice(0, threshold)), held = p.reveal.ins.slice(2);
  const wit = held.map((input, n) => {
    const { path, script, control } = vaultLeaf(policy, input);
    // multi_a reads its first key off the top of the stack, so the last key goes first.
    const stack = [...path.keys].reverse().map(k => { const id = BV.keyId(k.owner, policy.network); return chosen.has(id) ? hex.decode(p.sigs[id][n]) : new Uint8Array(0); });
    return [...stack, script, control];
  });
  const key = hex.decode(p.keyPub);
  return { commit: p.commit, reveal: hex.encode(rawTx(p.reveal, [[hex.decode(p.envSig), hex.decode(p.script), hex.decode(p.control)], [hex.decode(p.keySig), key], ...wit])) };
}
const parseRecipient = (text, network) => {
  const t = String(text).trim();
  if(/^0[23][0-9a-fA-F]{64}$/.test(t)) return hex.decode(t.toLowerCase());
  const { prefix, words } = bech32m.decode(t.toLowerCase(), 1023);
  if(prefix !== HRP[network]) throw new Error('that tacit address is for another network');
  const b = bech32m.fromWords(words);
  if(b[0] !== 0 || !(b[1] & LANE_BTC) || b.length < 68) throw new Error('that tacit address has no Bitcoin lane');
  return Uint8Array.from(b.slice(2, 35));
};
const loadProver = async () => {
  // Classic proofs, because Tacit's outpoint check does not yet read Bulletproofs+.
  const [bp, deps] = await Promise.all([import('./tacit/bulletproofs.js'), import('./tacit/vendor/tacit-deps.min.js')]);
  return { prove: (v, r) => bp.bpRangeAggProve(v, r).proof, verify: (cs, proof) => bp.bpRangeAggVerify(cs.map(c => deps.secp.ProjectivePoint.fromHex(hex.encode(c))), proof) };
};

root.BitcoinTacit = Object.freeze({ parts: Object.freeze({ selfOut, sentOut, buildPayload, envelopeScript, frame, sigV0, leafHash, rawTx, wpkh, prevout, txidOf }), buildSweep, buildSend, reviewSend, signSend, signersOf, finishSend, sendId, parseRecipient, loadProver, inboxAddress, readInbox, tacitAddress, noteAddress, makeNoteKey, makeRecord, verifyRecord, openRecord, openNote, envelopeOf, outputsOf });

})(typeof window !== 'undefined' ? window : globalThis);
