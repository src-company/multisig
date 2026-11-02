'use strict';
// The Bitcoin page. Everything that decides anything is in bitcoin.js; this file
// holds the screen. Vaults are descriptors kept in this browser, in links, and on each
// owner's record with the service, which is told about them on connecting. Proposals
// go through a shared queue, whose rows are re-read here and never believed, and can
// also move by link or PSBT, so the queue being down stops nothing.
//
// The layout is the Ethereum dashboard's on purpose: the same header, tabs, stat and
// queue card, so that Bitcoin reads as another chain and not as another product.

(function(){

const BV = window.BitcoinVault;
const $ = id => document.getElementById(id);
const _escMap = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, m => _escMap[m]);
// A path gateway gives every site on it this origin, so what is stored here could have
// been written by any of them. Nothing from it is believed.
const SHARED = /^\/ip[fn]s\//.test(location.pathname);
const lsGet = k => { if(SHARED) return null; try { return localStorage.getItem(k); } catch(_) { return null; } };
const lsSet = (k, v) => { if(SHARED) return; try { localStorage.setItem(k, v); } catch(_) {} };
const lsJson = (k, d) => { try { return JSON.parse(lsGet(k)) ?? d; } catch(_) { return d; } };
const btcOf = sats => (sats / 1e8).toFixed(8);
const short = s => s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
const days = blocks => { const d = blocks / 144; return d >= 2 ? `${Math.round(d)}D` : blocks >= 6 ? `${Math.round(blocks / 6)}H` : `${blocks * 10}M`; };
const asc = n => '/'.repeat(n);

// bitcoin.js is network-agnostic, so this is the one switch. Turning it off stops new
// use of mainnet from this page. It moves no one's coins, and any descriptor tool can
// still spend them.
const MAINNET = true;
// A key left in an open tab is a key at risk for no benefit.
const IDLE_MS = 15 * 60 * 1000;
const DELAYS = [['1D', 144], ['7D', 1008], ['30D', 4320], ['90D', 12960], ['1Y', 52560]];
const BTC_ICON = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#F7931A"/><path fill="#FFF" d="M22.3 14.1c.3-2.1-1.3-3.2-3.5-4l.7-2.8-1.7-.4-.7 2.7-1.4-.3.7-2.8-1.7-.4-.7 2.8-1.1-.3-2.4-.6-.5 1.8s1.3.3 1.3.3c.7.2.8.6.8 1l-.8 3.2.2.1-.2-.1-1.1 4.5c-.1.2-.3.5-.8.4 0 0-1.3-.3-1.3-.3l-.9 2 2.3.6 1.2.3-.7 2.9 1.7.4.7-2.8 1.4.3-.7 2.8 1.7.4.7-2.9c2.9.6 5.1.3 6-2.3.8-2.1 0-3.3-1.6-4.1 1.1-.3 2-1.1 2.3-2.7zm-3.9 5.4c-.5 2.1-4.1 1-5.2.7l.9-3.7c1.2.3 4.9.9 4.3 3zm.5-5.4c-.5 1.9-3.4.9-4.4.7l.8-3.3c1 .2 4.1.7 3.6 2.6z"/></svg>`;
const ETH_ICON = '<svg viewBox="0 0 32 32" aria-hidden="true"><polygon fill="#80D8FF" points="16,3 16,20.6 7.5,16"/><polygon fill="#B3E5FC" points="16,3 24.5,16 16,20.6"/><polygon fill="#80D8FF" points="16,22.3 7.5,17.7 16,29"/><polygon fill="#B3E5FC" points="16,22.3 24.5,17.7 16,29"/></svg>';
const KEY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/></svg>';

const TAC_ICON = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#0a0a0a"/><circle cx="16" cy="16" r="13" fill="none" stroke="#f4efe6" stroke-width="2.5"/><path d="M17.5 7L13 22.5Q13 25 18 24" fill="none" stroke="#f7931a" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11L21 11" stroke="#f7931a" stroke-width="2.4" stroke-linecap="round"/></svg>`;

const S = {
  network: MAINNET && lsGet('ms_btc_net') === 'mainnet' ? 'mainnet' : 'signet',
  dark: !lsGet('ms_light'),
  // The key lives here and nowhere else, for this tab's lifetime. It is never
  // written down, so a reload asks the wallet again.
  owner: null,       // { signer, xpub, fingerprint, path, evm }
  view: 'dash',      // dash | admin | create
  ovl: null,         // connect | me | share
  policy: null, trusted: false,
  coins: null, tip: null, fees: {}, receive: 0, change: 0,
  // The queue: every proposal on this vault still able to happen. psbt and review are
  // whichever one an action is acting on.
  queue: [], psbt: null, review: null, compose: false, invited: [],
  mirror: null,
  form: { name: '', kind: 'plain', evmChain: '1', evmVault: '', owners: '', threshold: '2', second: '', secondThreshold: '1', older: '4320', to: '', amt: '', rate: '', path: '0', paste: '', merge: '', import: '', hw: '' },
  msg: null, busy: false,
};
const myHandle = () => BV.encodeOwner({ network: S.network, ...S.owner });
function forget(){ S.pending = null; S.noteKey?.fill(0); Object.assign(S, { noteKey: null, noteLocked: false, inbox: null, notes: null, tacQueue: null }); if(S.owner){ S.owner.signer.wipePrivateData(); S.owner = null; } }
const known = () => S.coins ? { receive: S.receive, change: S.change, quarantined: S.coins.filter(c => c.quarantine).map(c => `${c.txid}:${c.vout}`) } : undefined;
let idle;
// Timers stop while a device sleeps, so the wall clock is checked as well.
let lastActive = Date.now();
const touch = () => { lastActive = Date.now(); clearTimeout(idle); if(S.owner) idle = setTimeout(() => { forget(); render(); }, IDLE_MS); };
const say = (text, kind = 'bad') => { S.msg = { text, kind }; render(); };
let _toast;
const toast = text => { $('toast').innerHTML = `<div class="toast">${esc(text)}</div>`; clearTimeout(_toast); _toast = setTimeout(() => { $('toast').innerHTML = ''; }, 1600); };

// A saved vault this version cannot read is left off the list, not fatal to the page.
function saved(){
  return rawSaved().filter(d => { try { return !!BV.parseDescriptor(d, S.network); } catch(_) { return false; } });
}
// Written from the raw list. An entry this version cannot read may still be someone's
// only copy of a vault, and rewriting from saved() would delete it.
const rawSaved = () => { const l = lsJson(`ms_btc_vaults_${S.network}`, []); return Array.isArray(l) ? l : []; };
function remember(policy){
  const d = BV.descriptor(policy), list = rawSaved();
  if(!list.includes(d)){ list.unshift(d); lsSet(`ms_btc_vaults_${S.network}`, JSON.stringify(list)); }
}
// Names and backups are this browser's notes about a vault, keyed by its descriptor.
const noteKey = kind => `ms_btc_${kind}_${S.network}`;
const noteOf = (kind, d) => lsJson(noteKey(kind), {})[d];
const setNote = (kind, d, v) => { const m = lsJson(noteKey(kind), {}); if(v === undefined) delete m[d]; else m[d] = v; lsSet(noteKey(kind), JSON.stringify(m)); };
const nameOf = (d, i) => noteOf('names', d) || `VAULT_${i + 1}`;
const curDesc = () => S.policy ? BV.descriptor(S.policy) : null;
const backedUp = () => !!noteOf('backup', curDesc());
const labelOf = k => noteOf('labels', k.xpub) || k.fingerprint;
// The wallet behind a key, once its record has been read and checked.
function whoOf(k, full){
  // This page's own owner needs no record: the connected wallet is the proof.
  const own = isMe(k) && S.owner.evm ? { evm: S.owner.evm, wallet: S.owner.wallet?.address || S.owner.wallet } : null;
  const w = own || S.who?.[k.xpub], show = t => full ? t : short(t);
  if(w?.wallet) return { mark: BTC_ICON, text: show(w.wallet) };
  if(w) return { mark: ETH_ICON, text: show(w.evm) };
  return { mark: KEY_ICON, text: k.fingerprint };
}
const chip = (k, full) => { const w = whoOf(k, full === true); return `<span class="who-c"><span class="who-i">${w.mark}</span>${esc(w.text)}${isMe(k) ? '<span class="you">YOU</span>' : ''}</span>`; };
const isMe = k => !!S.owner && BV.sameKey(k, S.owner, S.network);
// Dust and known notes are never moved as sats, so they cannot restart a clock.
const movable = c => c.value > BV.DUST && c.quarantine !== 'tacit';
const iSigned = r => r.keys.some(k => isMe(k) && r.signedAll.includes(k.xpub));
const allKeys = p => [...new Map(p.paths.flatMap(x => x.keys).map(k => [k.xpub, k])).values()];

// ── OWNER KEY ──────────────────────────────────────────────
// The extensions that announce themselves, a plain window.ethereum if none do.
const evmWallets = new Map();
window.addEventListener('eip6963:announceProvider', e => {
  const { info, provider } = e.detail || {};
  if(info?.uuid && provider && !info.rdns?.startsWith('software.multisig.')) evmWallets.set(info.uuid, { name: String(info.name), provider, icon: info.icon });
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
const walletConnect = () => window.BitcoinWallets.walletConnect();

async function connect(el){
  const choice = el?.dataset?.w || '';
  if(choice.startsWith('btc:')){
    checkPlace();
    const wallet = window.BitcoinWallets.detect().find(w => w.key === choice.slice(4));
    const key = await window.BitcoinWallets.connectWallet(wallet, S.network, onStep);
    S.progress = null;
    forget();
    S.owner = { ...key.owner, signer: key.signer, evm: key.evm, via: `${wallet.name} ${short(key.address)}` };
    key.evmPriv.fill(0);
    S.msg = null;
    touch();
    awaitConfirm(key);
    return;
  }
  return connectEvm(choice === 'wc' ? await walletConnect() : choice ? evmWallets.get(choice).provider : window.ethereum);
}

function checkPlace(){
  // A path gateway gives every site on it this same origin, and the key would be
  // within their reach.
  if(/^\/ip[fn]s\//.test(location.pathname)) throw new Error('Open this page from its own domain to use a key. This address shares its origin with other sites.');
  // The hosting headers do not travel to a mirror, so the page checks for itself.
  if(window.top !== window || window.opener) throw new Error('Open this page in its own tab to use a key.');
}

async function connectEvm(eth){
  checkPlace();
  if(!eth) throw new Error('No Ethereum wallet in this browser. Owners on a hardware wallet need no connection here: copy the PSBT and sign it there.');
  const got = await window.BitcoinWallets.connectEvmForHandle(eth, S.network, { keep: true, onStep });
  forget();
  S.owner = { ...got.owner, signer: got.signer };
  S.progress = null;
  S.msg = null;
  touch();
  awaitConfirm(got);
}
// A wallet with no key on record repeats itself before it can do anything here, the same
// check /btc makes, because a seat on a key it cannot make again is a seat lost.
function awaitConfirm(got){
  if(got.repeats){ S.ovl = null; findVaults(); setTimeout(readOwners, 2500); return; }
  S.pending = got.finish;
  S.unanswered = false;
  S.ovl = 'confirm';
}
async function finishConnect(skip){
  S.progress = 'APPROVE IN YOUR WALLET';
  render();
  try {
    await S.pending({ skip });
    S.pending = null;
    S.progress = null;
    S.ovl = null;
    findVaults();
    readOwners();
  } catch(e) {
    S.progress = null;
    if(e.mismatch){ forget(); S.ovl = null; throw e; }
    S.unanswered = true;
    S.ovl = 'confirm';
    toast('YOUR WALLET CLOSED THAT REQUEST');
  }
}
// The vaults on this owner's record. Their own go straight on the list. One that names
// them but they never agreed to is an invitation, and opens through the owner check,
// because handles are public and anyone could build a vault around someone's key.
// Vaults kept only in this browser are added to the record while we are here.
async function findVaults(){
  if(!S.owner?.signer) return;
  const list = await BV.listVaults(S.network, S.owner.signer, myHandle()).catch(() => null);
  if(!list || !S.owner) return;
  for(const { policy, confirmed } of list) if(confirmed){ remember(policy); setNote('backup', BV.descriptor(policy), 1); }
  const known = new Set(list.filter(v => v.confirmed).map(v => BV.descriptor(v.policy)));
  S.invited = list.filter(v => !v.confirmed).map(v => BV.descriptor(v.policy)).filter(d => !saved().includes(d));
  for(const d of saved().filter(x => !known.has(x))){
    const p = BV.parseDescriptor(d, S.network);
    if(allKeys(p).some(isMe)) BV.saveVault(p, S.owner.signer, myHandle(), [myHandle()]).then(() => setNote('backup', d, 1)).catch(() => {});
  }
  if(!S.policy && saved()[0]) open(BV.parseDescriptor(saved()[0], S.network));
  render();
}
const onStep = (n, of) => { S.progress = `APPROVE ${n} OF ${of} IN YOUR WALLET`; render(); };

// ── VAULTS ─────────────────────────────────────────────────
const words = text => text.split(/[\s,]+/).filter(Boolean);
const parseOwners = text => words(text).map(t => BV.decodeOwner(t, S.network));
// A Bitcoin address in an owner box is swapped for that owner's handle, if they have
// connected. Otherwise the row says so, and the box keeps what was typed.
const isWalletAddress = t => /^(bc1|tb1)[a-z0-9]{20,}$/i.test(t);
const _askedWallets = new Set();
async function resolveWallets(field){
  for(const t of words(S.form[field]).filter(isWalletAddress)){
    if(_askedWallets.has(t)) continue;
    _askedWallets.add(t);
    const found = await BV.handleForWallet(S.network, t).catch(() => null);
    if(found){ S.form[field] = S.form[field].replace(t, found.handle); render(); }
  }
}

// Each line checked as it is typed, so a bad paste is found at the paste.
function ownerRows(text){
  return words(text).map(t => {
    try {
      const o = BV.decodeOwner(t, S.network);
      // A handle's 0x address is only a label until it is proven. Unproven, it is not shown.
      return { ok: true, text: o.possessed ? short(o.evm) : o.fingerprint, proven: !!o.possessed, me: isMe(o) };
    } catch(e) { return { ok: false, text: short(t), err: isWalletAddress(t) ? 'This wallet has not connected yet' : e.message }; }
  });
}

async function readMirror(){
  S.mirror = await BV.readEvmVault(+S.form.evmChain, S.form.evmVault.trim());
  S.form.threshold = String(S.mirror.threshold);
  const found = await BV.fetchHandles(S.network, S.mirror.owners).catch(() => []);
  S.form.owners = [...new Set([...words(S.form.owners), ...found])].join('\n');
  S.msg = null;
}

function policyFromForm(){
  const f = S.form;
  if(f.kind === 'mirror'){
    if(!S.mirror) throw new Error('Read the Ethereum vault first.');
    const { missing, policy } = BV.mirror({ network: S.network, vault: S.mirror, handles: words(f.owners) });
    if(missing.length) throw new Error(`Still waiting on ${missing.length} of ${S.mirror.owners.length} owners.`);
    S.mirrored = true;
    return policy;
  }
  const keys = parseOwners(f.owners), threshold = +f.threshold;
  const paths = [{ threshold, keys }];
  if(f.kind === 'recovery') paths.push({ threshold: +f.secondThreshold, keys: parseOwners(f.second), older: +f.older });
  // The hold preset is the same two leaves the other way up: everyone at once, or
  // the quorum once a coin has aged.
  if(f.kind === 'hold'){
    paths[0] = { threshold: keys.length, keys };
    paths.push({ threshold, keys, older: +f.older });
  }
  return BV.policyOf({ network: S.network, paths });
}

function createVault(){
  if(S.pending) throw new Error('Confirm your wallet first.');
  const policy = policyFromForm(), d = BV.descriptor(policy), f = S.form, from = S.moving;
  if(from === d) throw new Error('These are the same rules as the current vault.');
  if(f.name.trim()) setNote('names', d, f.name.trim().slice(0, 24).toUpperCase().replace(/\s+/g, '_'));
  for(const t of [...words(f.owners), ...words(f.second)]){
    try { const o = BV.decodeOwner(t, S.network); if(o.possessed) setNote('labels', o.xpub, short(o.evm)); } catch(_) {}
  }
  Object.assign(S.form, { name: '', owners: '', second: '', evmVault: '' });
  S.mirror = null;
  // Owners read from one RPC get the same check as any vault someone hands you.
  const fromRpc = S.mirrored;
  S.mirrored = false;
  // Both ends of a move are fixed here. The page can be pointed elsewhere after this.
  Object.assign(S, { moveFrom: from || null, moveTo: from ? d : null });
  return open(policy, fromRpc);
}

// A vault that arrives in a link is not yet this person's vault. It could be anyone's
// keys under the words "our vault", so it is not saved, and its address is not shown
// to be paid until they have looked at the owners and said so.
async function open(policy, fromLink = false){
  const trusted = !fromLink || saved().includes(BV.descriptor(policy));
  S.moving = null;
  if(S.moveTo !== BV.descriptor(policy)) Object.assign(S, { moveFrom: null, moveTo: null });
  if(trusted) remember(policy);
  S.noteKey?.fill(0);
  Object.assign(S, { receive: 0, change: 0, noteLocked: false, notes: null, tacQueue: null, noteKey: null, noteRecord: undefined, noteBad: false, inbox: null, who: null, policy, trusted, view: 'dash', compose: false, coins: null, tip: null, queue: [], psbt: null, review: null, msg: null });
  syncHash();
  render();
  // In the background: a click's busy lock must not outlast the click, or every button
  // goes dead for as long as an explorer takes to answer.
  scanned = refresh();
}

// Numbered, because a slow scan of the last vault must not land on this one.
let scanning = 0, lastScan = 0, scanned = Promise.resolve(), retries = 0;
// Anything that fails simply shows no address: a record that does
// not check out against this vault's keys is treated as no record at all.
async function readTacit(){
  const policy = S.policy, BT = window.BitcoinTacit;
  if(!policy || !BT || !S.trusted) return;
  const record = await BV.fetchNoteRecord(policy).catch(() => undefined);
  if(policy !== S.policy || record === undefined) return;
  S.noteRecord = record && BT.verifyRecord(policy, record) ? record : null;
  S.noteBad = !!record && !S.noteRecord;
  const owner = S.owner, here = () => policy === S.policy && owner === S.owner;
  if(S.noteRecord && owner?.signer && allKeys(policy).some(isMe) && !S.noteKey){
    const key = await BT.openRecord(S.noteRecord, owner.signer, owner, policy).catch(() => null);
    // The page may have moved on, and a key must not land on another vault or a forgotten owner.
    if(!here()){ key?.fill(0); return; }
    S.noteKey = key;
    S.noteLocked = !key;
  }
  if(S.noteKey && S.coins){
    const c = BV.chain(S.network), key = S.noteKey;
    const inbox = await BT.readInbox(key, S.network, c).catch(() => S.inbox);
    const candidates = S.coins.filter(x => x.quarantine === 'tacit' || x.value <= BV.DUST).slice(0, 64), held = [];
    const verdicts = candidates.length ? await c.classify(candidates.map(x => `${x.txid}:${x.vout}`)).catch(() => ({})) : {};
    let pendingNotes = 0;
    for(const coin of candidates){
      const verdict = verdicts[`${coin.txid}:${coin.vout}`];
      if(verdict?.status === 'plain') continue;
      const n = BT.openNote(await c.tx(coin.txid).catch(() => null), coin.vout, key);
      if(n && verdict?.status === 'asset' && verdict.asset_ids?.[0] === n.asset) held.push({ ...coin, ...n, value: coin.value });
      else if(n) pendingNotes++;
    }
    const prover = await BT.loadProver();
    const open = await BV.fetchTacSends(policy).catch(() => []), queue = [];
    for(const p of open.slice(0, 20)){
      try {
        // Gone once its coins are spent, the same way a Bitcoin proposal closes.
        if(!p.reveal.ins.filter(i => i.kind === 'vault').every(i => S.coins.some(x => x.txid === i.txid && x.vout === i.vout))) continue;
        queue.push({ p, id: BT.sendId(p), review: await BT.reviewSend(p, policy, key, c, prover, known()), votes: BT.signersOf(p, policy) });
      } catch(e) { queue.push({ error: e.message }); }
    }
    if(!here() || S.noteKey !== key) return;
    Object.assign(S, { inbox, notes: held, tacQueue: queue, pendingNotes });
    // Tacit's check can be slow or briefly down, and a held note must not just look gone.
    clearTimeout(S.tacTimer);
    if(pendingNotes || inbox?.some(n => n.status === 'unverified')) S.tacTimer = setTimeout(() => { if(here()) readTacit(); }, 30000);
  }
  if(policy === S.policy) render();
}
const tacAll = () => {
  const inbox = S.inbox || [], notes = inbox.filter(n => n.status === 'asset'), held = (S.notes || []).filter(n => n.amount > 0n);
  // A send leads with a zero note of its own asset, and anyone can send a zero note.
  const leadFor = asset => notes.find(n => n.amount === 0n && n.asset === asset);
  // Anyone can pay a vault a note, so the owner picks the asset and a stranger's cannot hide theirs.
  const assets = [...new Set(held.map(n => n.asset))], asset = assets.includes(S.form.tacAsset) ? S.form.tacAsset : assets[0];
  return { waiting: notes.filter(n => n.amount > 0n), leadFor, fee: inbox.filter(n => n.status === 'plain').sort((a, b) => b.value - a.value)[0], held, assets, asset, sendable: leadFor(asset) ? asset : undefined };
};
function renderTacit(){
  if(!S.trusted || !window.BitcoinTacit) return '';
  const BT = window.BitcoinTacit, head = '<div class="head"><span>TACIT</span></div>';
  if(S.noteBad) return `${head}<div class="note warn"><b>This vault's Tacit record does not check out.</b> No address is shown.</div>`;
  if(!S.noteRecord) return S.noteRecord === undefined ? '' : `${head}<p class="small" style="padding:10px 8px">Give this vault a tacit1 address, so any Tacit wallet can pay it.</p>
    <div class="btns">${S.owner && allKeys(S.policy).some(isMe) ? '<button class="btn btn-outline btn-sm" data-act="tacit-setup">SET UP TACIT</button>' : '<button class="btn btn-outline btn-sm" data-act="wallet">CONNECT TO SET UP</button>'}</div>`;
  if(S.noteLocked) return `${head}<div class="note warn"><b>Your copy of the note key does not open.</b> Ask the owner who set up Tacit for this vault.</div>`;
  if(!S.noteKey) return `${head}<p class="small" style="padding:10px 8px">This vault has a tacit1 address. Connect as an owner to see it.</p>`;
  const f = S.form, { waiting, fee, held, sendable, assets, asset } = tacAll(), name = a => esc(assetName(a));
  const row = (n, side) => `<div class="row"><span class="asset"><span class="btc" style="width:20px;height:20px">${TAC_ICON}</span>${name(n.asset)}</span><span class="r">${noteUnits(n.asset, n.amount)} ${side}</span></div>`;
  const checking = (S.inbox || []).filter(n => n.status !== 'asset' && n.status !== 'plain').length + (S.pendingNotes || 0);
  const card = q => q.error ? `<div class="tx"><span class="tag">REFUSED</span><p class="small">${esc(q.error)}</p></div>` : `<div class="tx" data-tac="${esc(q.id)}">
      <div class="tx-top"><div><span class="tag">${q.review.reseed ? 'PREPARE SENDING' : 'TACIT SEND'}</span><div class="tx-val">${noteUnits(q.review.asset, q.review.reseed ? q.review.total : q.review.amount)} ${name(q.review.asset)}</div></div><span class="tx-status ${q.votes.ready ? 'ok' : 'wait'}">${q.votes.ready ? 'READY' : `${q.votes.signed.length} OF ${q.votes.threshold} SIGNED`}</span></div>
      <div class="tx-to">→ ${q.review.reseed ? 'STAYS IN THIS VAULT' : esc(q.review.recipient)}</div>
      <div class="tx-sub">${q.review.reseed ? 'NOTHING LEAVES' : `${noteUnits(q.review.asset, q.review.change)} BACK TO THE VAULT`} · FEE ${q.review.sats.toLocaleString('en-US')} SATS${q.review.back ? ` · ${q.review.back.toLocaleString('en-US')} SATS TO THE NOTE KEY` : ''} · CHECKED AGAINST THE NOTE KEY</div>
      <div class="btns"><div class="right">${q.votes.ready ? '<button class="btn btn-fill" data-act="tacit-broadcast">SEND</button>' : q.votes.signed.includes(BV.keyId(S.owner, S.network)) ? '' : '<button class="btn btn-fill" data-act="tacit-sign">SIGN</button>'}</div></div>
    </div>`;
  return `${head}<div class="mono" style="font-size:11px;font-weight:400;padding:12px 8px">${esc(BT.noteAddress(S.noteKey, S.network))}</div>
    <div class="btns"><button class="btn btn-outline btn-sm" data-act="copy-tacit">COPY TACIT ADDRESS</button></div>
    <p class="small" style="padding:10px 8px 0">For Tacit assets on Bitcoin only. Plain bitcoin sent here will not show up.</p>
    ${held.map(n => row(n, 'IN THE VAULT')).join('')}
    ${waiting.map(n => row(n, 'IN THE INBOX')).join('')}
    ${checking ? `<div class="row"><span class="small">${checking} NOTE${checking > 1 ? 'S' : ''} WAITING FOR TACIT TO VERIFY</span></div>` : ''}
    ${waiting.length ? `<div class="note warn"><b>Move this into the vault.</b> Until it does, any owner could take it alone.</div>
      <div class="btns"><button class="btn btn-fill btn-sm" data-act="tacit-sweep"${fee ? '' : ' disabled'}>MOVE INTO VAULT</button></div>` : ''}
    ${fee ? '' : `<p class="small" style="padding:10px 8px">Moving notes costs a miner fee, paid from the note key's address. Send about 10,000 sats to <button class="addrline" data-act="copy-tacit-fee">${esc(BT.inboxAddress(S.noteKey, S.network))} ⧉</button></p>`}
    ${(S.tacQueue || []).map(card).join('')}
    ${assets.length > 1 ? `<div class="pills" style="padding:10px 8px">${assets.map(a => `<button class="pill${a === asset ? ' on' : ''}" data-act="tacit-asset" data-a="${esc(a)}">${name(a)}</button>`).join('')}</div>` : ''}
    ${held.length && !sendable && fee && !(S.tacQueue || []).some(q => !q.error) ? '<div class="btns"><button class="btn btn-outline btn-sm" data-act="tacit-reseed">PREPARE TO SEND</button></div>' : ''}
    ${sendable && fee && !S.tacOpen ? '<div class="btns"><button class="btn btn-outline btn-sm" data-act="tacit-open">SEND TACIT</button></div>' : ''}
    ${sendable && fee && S.tacOpen ? `<div class="send">
      <label class="lbl" for="tacTo">SEND TO</label><input class="inp" id="tacTo" data-field="tacTo" spellcheck="false" autocomplete="off" placeholder="${S.network === 'mainnet' ? 'tacit1…' : 'tactt1…'}" value="${esc(f.tacTo || '')}">
      <label class="lbl" for="tacAmt">AMOUNT <span class="dim">${name(asset)}</span></label><input class="inp" id="tacAmt" data-field="tacAmt" inputmode="decimal" autocomplete="off" value="${esc(f.tacAmt || '')}">
      <div class="btns"><div class="right"><button class="btn btn-ghost" data-act="tacit-open">CANCEL</button><button class="btn btn-fill" data-act="tacit-propose">PROPOSE</button></div></div></div>` : ''}
    <p class="small" style="padding:10px 8px">Pilot. Use small amounts.</p>`;
}
// An explorer's estimate is a stranger's number, and these ops pay from a small float.
const tacRate = () => Math.min(Math.max(feeOf('6'), 1), 50);
const tacCard = el => {
  const id = el.closest('[data-tac]')?.dataset.tac, q = (S.tacQueue || []).find(x => x.id === id);
  if(!q) throw new Error('This send changed. Check it again.');
  return q;
};
// The reveal spends the commit, so it waits until an explorer has heard of it.
async function tacBroadcast({ commit, reveal }){
  const c = BV.chain(S.network);
  // A retry finds the commit already there, which is fine.
  await c.broadcast(commit).catch(e => { if(!/already|known|conflict/i.test(e.message)) throw e; });
  for(let tries = 0; ; tries++){
    try { return await c.broadcast(reveal); }
    catch(e) { if(tries >= 5 || !/missing|spent/i.test(e.message)) throw e; await new Promise(ok => setTimeout(ok, 3000)); }
  }
}
function readOwners(){
  const policy = S.policy;
  readTacit();
  if(policy) BV.ownersOf(policy).then(who => { if(policy === S.policy){ S.who = who; render(); } }, () => {});
}
async function refresh(){
  const c = BV.chain(S.network), run = ++scanning;
  lastScan = Date.now();
  readOwners();
  try {
    const [found, tip, fees] = await Promise.all([BV.scan(S.policy, c), c.tip(), c.fees().catch(() => ({}))]);
    if(run !== scanning) return;
    Object.assign(S, { coins: found.coins, receive: found.receive, change: found.change, truncated: found.truncated, tip, fees });
    await syncQueue();
    render();
    readTacit();
    // A slow first look at a coin answers "retry". Each try gets further, so it clears.
    if(S.coins.some(c => c.quarantine === 'unknown') && retries++ < 5) setTimeout(() => { if(run === scanning) scanned = refresh(); }, 30000);
    else if(!S.coins.some(c => c.quarantine === 'unknown')) retries = 0;
  } catch(e) {
    if(run !== scanning) return;
    // A rate limit passes by itself, so it gets a calm word and another try.
    if(e.message === BV.EXPLORERS_BUSY){ say('The Bitcoin explorers are busy. Trying again shortly.'); setTimeout(() => { if(run === scanning) scanned = refresh(); }, 30000); }
    else say(`Could not read the chain: ${e.message}`);
  }
}

// What the vault's queue holds, joined with anything only this browser has. A copy held
// on both sides is merged, so a signature made anywhere shows up everywhere. A proposal
// whose coin is gone can no longer happen, so it leaves the queue: that is what closes
// one on Bitcoin, whether it confirmed or lost to another.
async function syncQueue(){
  const remote = await BV.fetchProposals(S.policy).catch(() => null);
  if(remote) S.shared = new Set(remote.map(BV.proposalId));
  const byId = new Map(S.queue.map(q => [q.id, q.psbt]));
  for(const psbt of remote || []){
    const id = BV.proposalId(psbt);
    // One bad row stays one bad row: the copy already here is kept.
    try { byId.set(id, byId.has(id) ? BV.combine([byId.get(id), psbt], S.policy) : psbt); } catch(_) {}
  }
  const live = psbt => BV.inspect(psbt, S.policy, known()).inputs.every(i => S.coins.some(c => c.txid === i.txid && c.vout === i.vout));
  S.queue = [...byId].filter(([id, psbt]) => !noteOf('hidden', id) && live(psbt)).map(([id, psbt]) => ({ id, psbt, review: BV.inspect(psbt, S.policy, known()) }));
  const on = S.psbt && S.queue.find(q => q.id === BV.proposalId(S.psbt));
  Object.assign(S, on ? { psbt: on.psbt, review: on.review } : { psbt: null, review: null });
}

// A vault link carries everything a co-signer needs, proposal included, and the
// browser sends none of a fragment anywhere.
function linkFor(){
  const d = encodeURIComponent(BV.descriptor(S.policy));
  return `${location.origin}${location.pathname}#${S.network}/${d}${S.psbt ? '/' + encodeURIComponent(S.psbt) : ''}`;
}
function syncHash(){ try { history.replaceState(null, '', S.policy ? linkFor() : location.pathname); } catch(_) {} }

async function readHash(){
  const [network, d, psbt] = location.hash.slice(1).split('/');
  if(!d || !Object.hasOwn(BV.NETWORKS, network)) return false;
  if(network === 'mainnet' && !MAINNET){ say('Mainnet is not open yet. This page works on signet.'); return true; }
  try {
    const next = decodeURIComponent(d), proposal = psbt ? decodeURIComponent(psbt) : null;
    // Another tab that opened this one can change its fragment. A proposal someone is
    // reading does not get replaced underneath them without asking.
    if(S.psbt && proposal && S.psbt !== proposal && !window.confirm('This link replaces the proposal on screen. Continue?')){ syncHash(); return true; }
    const policy = BV.parseDescriptor(next, network);
    // A key is per network, so a link to the other one does not carry it across.
    if(network !== S.network){ forget(); S.network = network; }
    await open(policy, true);
    // Change is judged against the scan, so a proposal waits for it.
    if(proposal){ await scanned; load(proposal); render(); }
  } catch(e) { say(e.message); }
  return true;
}

// ── PROPOSALS ──────────────────────────────────────────────
function load(psbt){
  const review = BV.inspect(psbt, S.policy, known()), id = BV.proposalId(psbt);
  setNote('hidden', id, undefined);
  const at = S.queue.findIndex(q => q.id === id);
  if(at >= 0) S.queue[at] = { id, psbt, review }; else S.queue.unshift({ id, psbt, review });
  Object.assign(S, { psbt, review });
  S.compose = false;
  S.msg = null;
  syncHash();
}

function propose(){
  const f = S.form, addr = f.to.trim();
  if(!addr) throw new Error('Enter an address to send to.');
  // There is no fee bump, so a guess at the floor could leave a spend stuck.
  if(!+f.rate && !Object.keys(S.fees || {}).length) throw new Error('Fee estimates are unavailable. Enter a rate.');
  const args = sendArgs(addr);
  if(!args) throw new Error('Amount is in BTC, up to 8 places, or use MAX.');
  load(BV.propose(args));
  const all = args.sweep ? BV.coinsFor(S.policy, args.path, args.utxos, args.tip).length : 0;
  if(all > S.review.inputs.length) S.msg = { text: `MAX TAKES ${S.review.inputs.length} OF ${all} COINS. SEND AGAIN FOR THE REST`, kind: 'ok' };
  Object.assign(S.form, { to: '', amt: '', rate: '', tier: '', max: false, path: '0' });
}

// Into the shared queue, or, if that cannot be reached, by hand. A signature is never
// lost to a failed save, only less convenient.
async function persist(){
  try { await BV.publishProposal(S.psbt, S.policy); (S.shared ||= new Set()).add(BV.proposalId(S.psbt)); toast('SAVED TO THE QUEUE'); }
  catch(_) { if(!S.review.ready) S.ovl = 'share'; }
}

async function sign(){
  if(S.pending) throw new Error('Confirm your wallet first.');
  if(!S.owner) throw new Error('Connect first: nothing here can sign without your owner key.');
  if(!S.trusted) throw new Error('Check this vault\'s owners first.');
  // Held here, so a link opened during the check cannot change what gets signed.
  const psbt = S.psbt, policy = S.policy, inputs = S.review.inputs;
  // The key is already in this page, so no wallet prompt follows. This is the prompt.
  const sends = S.review.outputs.filter(o => !o.change).map(o => `${btcOf(o.sats)} BTC to ${o.address}`).join('\n');
  if(!window.confirm(`Sign with your vault key?\n\n${sends}\nFee ${S.review.fee.toLocaleString('en-US')} sats\n\nYour wallet will not ask again. This is your approval.`)) return;
  // A coin's first check can take a while, and a page that sits still reads as broken.
  S.msg = { text: 'CHECKING THE COINS, THEN SIGNING. THIS CAN TAKE A MINUTE', kind: 'ok' };
  render();
  await BV.assertSpendable(inputs, BV.chain(S.network));
  if(S.psbt !== psbt) throw new Error('This proposal changed. Check it again.');
  load(BV.sign(psbt, S.owner.signer, policy, known()));
  touch();
  await persist();
}

async function merge(){
  const more = S.form.merge.trim();
  if(!more) return;
  load(BV.combine([S.psbt, more], S.policy));
  S.form.merge = '';
  await persist();
}

async function broadcast(){
  const c = BV.chain(S.network);
  // A coin spent since this was proposed makes the whole proposal void. Say that,
  // rather than show a node's refusal.
  for(const i of S.review.inputs) if(await c.spent(i.txid, i.vout)) throw new Error('A coin in this proposal has already been spent. It is void; propose again.');
  // Signatures can arrive from a wallet that never saw this check.
  await BV.assertSpendable(S.review.inputs, c);
  const raw = BV.finalize(S.psbt, S.policy), txid = BV.txidOf(raw), said = (await c.broadcast(raw)).trim();
  // The signatures are not thrown away on an explorer's word.
  if(said !== txid) throw new Error('The explorer gave an unexpected reply, so this may not have been sent. The proposal is still here.');
  S.queue = S.queue.filter(q => q.psbt !== S.psbt);
  Object.assign(S, { psbt: null, review: null });
  syncHash();
  S.msg = { text: `SENT ${short(txid)}`, kind: 'ok', href: `${BV.NETWORKS[S.network].explorer}/tx/${txid}` };
  scanned = refresh();
}

// The file an owner keeps. It is everything needed to spend without this page, so it
// says so in words someone can follow in ten years.
function backupText(){
  const p = S.policy, d = BV.descriptor(p), w = BV.walletPolicy(p);
  return [
    `MULTISIG BITCOIN VAULT BACKUP (${S.network})`,
    '',
    'Keep this. Bitcoin keeps no record of who owns this vault: without this text the',
    'coins cannot be spent, even with every key. It holds no private key. Anyone who',
    'reads it can see the vault\'s balance and history, but cannot spend.',
    '',
    'Rules:',
    ...p.paths.map(x => `  ${x.threshold} of ${x.keys.length}${x.older ? ` after a coin has sat ${x.older} blocks` : ''}`),
    '',
    'Descriptor. Works in Bitcoin Core and other descriptor wallets:',
    d,
    '',
    'BIP-388 wallet policy, for hardware wallets:',
    JSON.stringify(w, null, 2),
    '',
    BV.recoveryText(S.network),
    '',
    ...(S.noteRecord ? ['Tacit note key record. Each owner can open their own copy with their key:', JSON.stringify(S.noteRecord), ''] : []),
  ].join('\n');
}
function download(){
  const url = URL.createObjectURL(new Blob([backupText()], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `multisig-${S.network}-${(noteOf('names', curDesc()) || BV.vaultOf(S.policy).address.slice(-8)).toLowerCase()}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setNote('backup', curDesc(), 1);
  toast('BACKUP SAVED');
}

// ── SCREEN ─────────────────────────────────────────────────
const feeOf = t => Math.max(1, Math.ceil(S.fees[t] || 1));

function renderHeader(){
  const label = S.owner ? (S.owner.via || `0x${S.owner.evm.slice(2, 6)}…${S.owner.evm.slice(-4)}`) : 'CONNECT';
  const vaultAddr = S.policy && S.trusted ? `${short(BV.vaultOf(S.policy, 0, S.receive).address)}` : '';
  return `<div class="hbar" aria-hidden="true">${asc(200)}</div>
    <div class="hdr">
      <div>
        <h1 class="logo"><a href="./index.html">MULTISIG</a></h1>
        <div class="sub" aria-hidden="true">.software</div>
        <div class="addr">${esc(vaultAddr)}</div>
      </div>
      <div class="hdr-r">
        <button class="theme-btn" data-act="theme" aria-label="Switch to ${S.dark ? 'light' : 'dark'} theme">${S.dark ? '☀' : '☾'}</button>
        <button class="wallet-btn" data-act="wallet" aria-haspopup="dialog">${S.owner ? '<span class="dot-sm" aria-hidden="true"></span>' : ''}${esc(label)}</button>
        ${S.owner ? '<button class="wallet-btn" data-act="disconnect" aria-label="Disconnect and forget this key">DISCONNECT</button>' : ''}
      </div>
    </div>
    <nav class="nav">
      ${[['dash', 'DASHBOARD'], ['admin', 'ADMIN'], ['create', 'CREATE']].map(([k, l]) => `<button class="${S.view === k ? 'on' : ''}"${S.view === k ? ' aria-current="page"' : ''} data-act="view" data-v="${k}">${l}</button>`).join('')}
      <div class="nets">
        <a href="./index.html">ETHEREUM ↗</a>
        ${(MAINNET ? ['mainnet', 'signet'] : ['signet']).map(n => `<button class="pill${n === S.network ? ' on' : ''}" data-act="net" data-n="${n}"${n === S.network ? ' aria-current="true"' : ''}>${n.toUpperCase()}</button>`).join('')}
      </div>
    </nav>`;
}

function renderBars(){
  const out = [];
  const m = S.msg;
  // The same line the Ethereum dashboard opens with: what is waiting on you.
  if(S.view === 'dash' && S.queue.length){
    const need = S.owner ? S.queue.filter(q => !q.review.ready && q.review.keys.some(isMe) && !iSigned(q.review)).length : 0;
    const ready = S.queue.filter(q => q.review.ready).length;
    if(need || ready) out.push(`<div class="attn"><b>${need + ready} ACTION${need + ready > 1 ? 'S' : ''}</b><span>${[need ? `${need} NEEDS YOUR SIG` : '', ready ? `${ready} READY TO SEND` : ''].filter(Boolean).join(' · ')}</span></div>`);
  }
  if(SHARED) out.push('<div class="attn bad"><b>THIS ADDRESS IS SHARED WITH OTHER SITES</b><a href="https://multisig.wei.limo/bitcoin.html">OPEN IT HERE</a></div>');
  if(S.truncated) out.push('<div class="attn"><b>THIS VAULT HAS MORE ADDRESSES THAN THE SCAN COVERS</b><span>LATER COINS ARE NOT SHOWN. A DESCRIPTOR WALLET CAN FIND THEM</span></div>');
  if(m) out.push(`<div class="attn ${m.kind === 'ok' ? 'ok' : 'bad'}" role="status"><b>${esc(m.text)}</b>${m.href ? `<a href="${esc(m.href)}" target="_blank" rel="noopener">VIEW ↗</a>` : ''}<button class="end" data-act="dismiss" aria-label="Dismiss">✕</button></div>`);
  if(S.policy && S.owner && BV.seatMisdescribed(S.policy, S.owner)) out.push(`<div class="attn"><b>YOUR KEY IS MISDESCRIBED IN THIS VAULT</b><span>IT STILL SIGNS HERE, BUT ASK WHO CREATED IT WHY</span></div>`);
  if(S.view === 'dash' && S.moveFrom && S.trusted && curDesc() === S.moveTo) out.push(`<div class="attn ok"><b>NEW VAULT READY</b><span>${backedUp() ? 'NOW MOVE THE COINS FROM THE OLD ONE' : 'SAVE ITS BACKUP, THEN MOVE THE COINS FROM THE OLD ONE'}</span>${backedUp() ? '<button class="end" data-act="movecoins">MOVE COINS</button>' : ''}</div>`);
  if(S.view === 'dash' && S.policy && S.trusted && !backedUp() && S.coins?.length) out.push(`<div class="attn"><b>BACK UP THIS VAULT</b><span>WITHOUT IT THE COINS CANNOT BE SPENT, EVEN WITH EVERY KEY</span></div>`);
  return out.join('');
}

function renderTabs(){
  const list = saved(), cur = curDesc();
  if(!list.length && !S.policy && !S.invited.length) return '';
  const tabs = list.map((d, i) => {
    const p = BV.parseDescriptor(d, S.network), on = d === cur;
    const total = on && S.queue.length ? `${S.queue.length} PENDING` : on && S.coins ? `${btcOf(S.coins.filter(c => !BV.isProtected(c)).reduce((n, c) => n + c.value, 0))} BTC` : `${p.paths[0].threshold}/${p.paths[0].keys.length} SIG`;
    return `<button class="vtab${on ? ' on' : ''}" data-act="open" data-i="${i}"${on ? ' aria-current="true"' : ''}><div class="vtab-name">${esc(nameOf(d, i))}${on && S.queue.length ? '<span class="vtab-dot" aria-hidden="true"></span>' : ''}</div><div class="vtab-info">${esc(total)}</div></button>`;
  });
  if(S.policy && !S.trusted) tabs.unshift(`<button class="vtab on" aria-current="true"><div class="vtab-name">FROM A LINK<span class="vtab-dot" aria-hidden="true"></span></div><div class="vtab-info">NOT SAVED</div></button>`);
  S.invited.forEach((d, i) => { if(d !== cur) tabs.push(`<button class="vtab" data-act="invited" data-i="${i}"><div class="vtab-name">INVITED<span class="vtab-dot" aria-hidden="true"></span></div><div class="vtab-info">CHECK THE OWNERS</div></button>`); });
  return `<div class="vtabs"><div class="vtabs-inner">${tabs.join('')}</div></div>`;
}

const renderHow = () => `<details><summary>HOW BITCOIN VAULTS WORK</summary>${BV.HOW_IT_WORKS.map(([t, d]) => `<div class="step"><b>${esc(t.toUpperCase())}</b><span>${esc(d)}</span></div>`).join('')}</details>`;

function renderEmpty(){
  return `<div class="empty">
    <div class="empty-title">BITCOIN VAULTS</div>
    <div class="empty-sub">SIGN WITH YOUR ETHEREUM OR BITCOIN WALLET. DEADMAN SWITCH INCLUDED.</div>
    ${S.network === 'signet' ? '<div class="empty-sub">SIGNET COINS ARE FREE AND WORTH NOTHING.</div>' : ''}
    <a class="btn btn-fill" style="text-decoration:none" href="./btc.html">CREATE A VAULT</a>
    ${S.owner ? '' : '<div class="btns" style="justify-content:center"><button class="btn btn-outline" data-act="wallet">CONNECT TO FIND YOUR VAULTS</button></div>'}
    ${renderHow()}
    <details><summary>OPEN AN EXISTING VAULT</summary>
      <textarea class="inp" id="import" data-field="import" spellcheck="false" aria-label="Vault descriptor" placeholder="Paste a descriptor, tr(…">${esc(S.form.import)}</textarea>
      <div class="btns"><button class="btn btn-outline btn-sm" data-act="import">OPEN</button></div>
    </details>
    <div class="steps">
      <div class="step"><b>1 / OWNERS</b><span>Each owner brings a key, from an Ethereum wallet, a Bitcoin wallet or a hardware wallet. Nothing is deployed and it costs nothing.</span></div>
      <div class="step"><b>2 / RECEIVE</b><span>Save the backup, then send bitcoin to the vault. Each deposit can use a fresh address.</span></div>
      <div class="step"><b>3 / SPEND</b><span>One owner proposes, the others sign in any order, and Bitcoin itself enforces the threshold.</span></div>
    </div>
  </div>`;
}

const chips = (r) => `<div class="approvals">${r.keys.map(k => {
  const did = r.signedAll.includes(k.xpub);
  return `<span class="${did ? 'ap-ok' : 'ap-no'}"><span aria-hidden="true">${did ? '✓' : '○'}</span><span class="sr">${did ? 'Signed:' : 'Not signed:'}</span>${esc(labelOf(k).toUpperCase())}${isMe(k) ? ' ★' : ''}</span>`;
}).join('')}</div>`;

function renderProposal(item, i){
  const r = item.review, n = S.queue.length - i;
  const clash = S.queue.some(q => q.id !== item.id && q.review.inputs.some(a => r.inputs.some(b => a.txid === b.txid && a.vout === b.vout)));
  const mine = S.owner && r.keys.some(isMe), signed = iSigned(r);
  const dust = r.inputs.some(x => x.sats <= BV.DUST || S.coins?.some(c => c.quarantine && c.txid === x.txid && c.vout === x.vout));
  const stranded = r.outputs.some(o => o.stranded) || dust;
  const sends = r.outputs.filter(o => !o.change), back = r.outputs.filter(o => o.change);
  const value = sends.reduce((n, o) => n + o.sats, 0);
  // A delayed proposal can be fully signed long before it can confirm.
  const heights = r.older && S.coins ? r.inputs.map(i => S.coins.find(c => c.txid === i.txid && c.vout === i.vout)?.height || 0) : [];
  const validAt = heights.length ? Math.max(...heights) + r.older : 0;
  const early = validAt > (S.tip || 0) + 1;
  const have = r.signedAll.length, status = stranded ? ['bad', 'DO NOT SIGN'] : r.ready ? ['ok', 'READY'] : ['wait', `${have} OF ${r.threshold} SIGNED`];
  const canSign = mine && !signed && S.trusted && !stranded;
  return `<div class="tx${r.ready ? ' ready' : ''}" data-pid="${esc(item.id)}">
    <div class="tx-top">
      <div>
        <span class="tx-nonce">#${n}</span>
        <span class="tag">${sends.length ? 'BTC TRANSFER' : 'CLOCK RESET'}${r.older ? ' · DELAYED PATH' : ''}</span>
        ${clash ? '<span class="tag" title="These spend the same coins, so only one can happen">CONFLICT</span>' : ''}
        ${r.signedBy.length ? (S.shared?.has(item.id) ? '' : '<span class="tag" title="Other owners cannot see this copy until someone signs it here">NOT IN THE QUEUE · ONLY ON THIS DEVICE</span>') : '<span class="tag">DRAFT · ONLY ON THIS DEVICE</span>'}
        <div class="tx-val"><span class="btc" style="width:18px;height:18px">${BTC_ICON}</span>${btcOf(sends.length ? value : back.reduce((n, o) => n + o.sats, 0))} BTC</div>
      </div>
      <span class="tx-status ${status[0]}">${status[1]}</span>
    </div>
    ${sends.map(o => `<div class="tx-to">→ ${esc(o.address)}${sends.length > 1 ? ` · ${btcOf(o.sats)} BTC` : ''}${o.stranded ? ' · LOST ADDRESS' : ''}</div>`).join('')}
    <div class="tx-sub">FEE ${btcOf(r.fee)} BTC · ${r.feeRate.toFixed(1)} SAT/VB${back.length ? ` · ${btcOf(back.reduce((n, o) => n + o.sats, 0))} BTC BACK TO THE VAULT` : ''}</div>
    ${chips(r)}
    ${!sends.length && S.coins?.some(BV.isProtected) ? '<p class="tx-sub">COINS SET ASIDE STAY WHERE THEY ARE, SO THEIR CLOCK DOES NOT RESTART.</p>' : ''}
    ${early ? `<div class="note warn"><b>Not valid until block ${validAt}.</b> Once signed it can be sent any time after that, even if it is discarded here.</div>` : ''}
    ${r.signedBy.length ? '<p class="tx-sub">TO CANCEL THIS FOR EVERYONE, SPEND THESE COINS. DISMISS ONLY HIDES IT HERE.</p>' : ''}
    ${r.feeRate > 200 ? '<div class="note warn"><b>That fee is unusually high.</b> Check it before signing.</div>' : ''}
    ${dust ? '<div class="note bad">This spends a coin that may hold a token, which would destroy it. Do not sign it.</div>' : stranded ? '<div class="note bad">This sends coins to a vault address so far along that no scan would find them. Do not sign it.</div>' : ''}
    ${mine && !S.trusted ? '<div class="note warn">Confirm the owners above before signing.</div>' : ''}
    <div class="btns">
      <button class="btn btn-ghost btn-sm" data-act="ovl" data-o="share">SHARE</button>
      <div class="right">
        <button class="btn btn-ghost" data-act="discard">${r.signedBy.length ? 'DISMISS' : 'DELETE'}</button>
        ${!S.owner && !r.ready ? '<button class="btn btn-outline" data-act="wallet">CONNECT TO SIGN</button>' : ''}
        ${canSign ? `<button class="btn btn-fill" data-act="sign"${S.coins ? '' : ' disabled'}>${S.coins ? 'SIGN' : 'SCANNING…'}</button>` : ''}
        ${r.ready && !stranded ? '<button class="btn btn-green btn-big" data-act="broadcast">BROADCAST</button>' : ''}
      </div>
    </div>
    <details><summary>ADD A SIGNATURE FROM ANOTHER WALLET</summary>
      <textarea class="inp" id="merge-${i}" data-field="merge" spellcheck="false" aria-label="Signed PSBT" placeholder="Paste a PSBT signed elsewhere, such as Sparrow with a hardware wallet">${esc(S.form.merge)}</textarea>
      <div class="btns"><button class="btn btn-outline btn-sm" data-act="merge">ADD</button></div>
    </details>
  </div>`;
}

// The send as it stands, built the way PROPOSE builds it, so what the form says is what
// the proposal will be. Before an address is in, the vault's own stands in for the size.
function sendArgs(to){
  const f = S.form, amt = f.amt.trim();
  const args = { policy: S.policy, utxos: S.coins || [], tip: S.tip, feeRate: +f.rate || feeOf('6'), path: +f.path, change: S.change };
  if(f.max) return { ...args, sweep: to };
  if(!/^\d+(\.\d{1,8})?$/.test(amt)) return null;
  const [whole, frac = ''] = amt.split('.');
  return { ...args, outputs: [{ address: to, sats: Number(BigInt(whole) * 100000000n + BigInt(frac.padEnd(8, '0'))) }] };
}
function sendPreview(){
  const f = S.form, args = sendArgs(f.to.trim() || BV.vaultOf(S.policy, 0, 0).address);
  if(!args || !S.coins) return null;
  try {
    const v = BV.inspect(BV.propose(args), S.policy, known()), inSats = v.inputs.reduce((n, i) => n + i.sats, 0);
    const send = f.max ? inSats - v.fee : args.outputs[0].sats;
    const all = S.coins.filter(c => !BV.isProtected(c)).reduce((n, c) => n + c.value, 0);
    return { send, fee: v.fee, left: Math.max(all - send - v.fee, 0) };
  } catch(e) { return { error: e.message }; }
}

function renderCompose(){
  const f = S.form, p = S.policy;
  const tiers = [['SLOW', '144'], ['NORMAL', '6'], ['FAST', '1']], tier = f.rate ? f.tier : '6';
  const view = sendPreview();
  if(f.max) f.amt = view?.send > 0 ? btcOf(view.send) : '';
  const sats = n => `${n.toLocaleString('en-US')} sats`;
  return `<div class="tx send">
    <label class="lbl" for="to">SEND TO</label>
    <input class="inp" id="to" data-field="to" spellcheck="false" autocomplete="off" placeholder="${S.network === 'signet' ? 'tb1…' : 'bc1…'}" value="${esc(f.to)}">
    <label class="lbl" for="amt">AMOUNT</label>
    <div class="amt-row"><input class="inp" id="amt" data-field="amt" inputmode="decimal" autocomplete="off" placeholder="0.00000000" value="${esc(f.amt)}"><span class="unit">BTC</span><button class="pill${f.max ? ' on' : ''}" data-act="max" aria-pressed="${!!f.max}">MAX</button></div>
    <span class="lbl">SPEED</span>
    <div class="speed">${tiers.map(([l, t]) => `<button class="pill${tier === t ? ' on' : ''}" data-act="tier" data-t="${t}" aria-pressed="${tier === t}">${l}</button>`).join('')}
      <label class="rate"><input class="inp" id="rate" data-field="rate" inputmode="decimal" autocomplete="off" aria-label="Fee rate in sats per vbyte" value="${esc(f.rate || String(feeOf('6')))}"><span>sat/vB</span></label></div>
    ${p.paths.length > 1 ? `<span class="lbl">SPEND WITH</span><div class="pills">${p.paths.map((x, i) => `<button class="pill${f.path === String(i) ? ' on' : ''}" data-act="path" data-p="${i}">${pathLabel(x)}</button>`).join('')}</div>` : ''}
    ${view?.error ? `<div class="send-err">${esc(view.error)}</div>` : view ? `<div class="send-sum">
      <div><span>RECIPIENT GETS</span><b>${btcOf(view.send)} BTC</b></div>
      <div><span>NETWORK FEE</span><b>${sats(view.fee)}</b></div>
      <div><span>LEFT IN VAULT</span><b>${btcOf(view.left)} BTC</b></div>
    </div>` : ''}
    <div class="btns"><div class="right"><button class="btn btn-ghost" data-act="compose">CANCEL</button><button class="btn btn-fill" data-act="propose"${S.coins && view && !view.error ? '' : ' disabled'}>PROPOSE</button></div></div>
  </div>`;
}

const pathLabel = x => `${x.threshold}/${x.keys.length}${x.older ? ` AFTER ${days(x.older)}` : ''}`;

function renderQueue(){
  const cards = S.queue.map(renderProposal).join('');
  const body = (S.compose ? renderCompose() : '') + (cards || (S.compose ? '' : `<div class="empty-row">NOTHING PENDING<details><summary>OPEN A PROPOSAL SOMEONE SENT YOU</summary>
        <textarea class="inp" id="paste" data-field="paste" spellcheck="false" aria-label="PSBT" placeholder="Paste a PSBT">${esc(S.form.paste)}</textarea>
        <div class="btns"><button class="btn btn-outline btn-sm" data-act="paste">OPEN</button></div>
      </details></div>`));
  return `<div class="head"><span>QUEUE</span>${S.compose ? '' : `<button class="btn btn-outline btn-sm" data-act="compose"${S.coins && S.coins.length ? '' : ' disabled'}>SEND</button>`}</div>${body}`;
}

function renderReceive(){
  if(!S.trusted) return `<div class="head"><span>CHECK BEFORE YOU USE THIS</span></div>
    <div class="note warn"><b>Someone else gave you this vault, and they chose these keys.</b> Compare every key below in full, with its owner, over a channel you trust. A close match is not a match.</div>
    ${(s => `<div class="rule"><b>${esc(s.name)}</b><span>${esc(s.rules.join(' '))} ${esc(s.note)}</span></div>`)(BV.policySummary(S.policy))}
    ${renderPaths()}
    <div class="btns"><button class="btn btn-fill" data-act="trust">I HAVE CHECKED EVERY KEY</button></div>`;
  if(!backedUp()) return `<div class="head"><span>RECEIVE</span></div>
    <div class="grid"><div>
      <div class="note warn"><b>Save the backup first.</b> Bitcoin keeps no record of who owns this vault, so the backup is what makes these coins spendable. It holds no private key. Every owner should have a copy.</div>
      <div class="btns"><button class="btn btn-fill" data-act="download">DOWNLOAD BACKUP</button><button class="btn btn-ghost" data-act="copy-descriptor">COPY INSTEAD</button></div>
    </div></div>`;
  const a = BV.vaultOf(S.policy, 0, S.receive).address;
  return `<div class="head"><span>RECEIVE</span></div>
    <div class="grid">
      <div>
        <div class="mono">${S.coins ? esc(a) : '<span class="pulse">SCANNING…</span>'}</div>
        <div class="btns"><button class="btn btn-outline btn-sm" data-act="copy-address"${S.coins ? '' : ' disabled'}>COPY ADDRESS</button></div>
        <p class="small" style="margin-top:14px">A fresh address appears after each deposit. Send sats only.</p>
        ${S.network === 'signet' ? `<p class="small">Need test coins? <a class="lk" href="https://faucet.coinbin.org" target="_blank" rel="noopener">Signet faucet ↗</a></p>` : ''}
      </div>
      ${S.coins ? `<div class="qr" role="img" aria-label="QR code of the address">${window.btc.encodeQR(a.toUpperCase(), 'svg')}</div>` : ''}
    </div>`;
}

// TAC is shown and entered in whole TAC. Anything else stays in base units, because an
// asset's decimals are fixed at issuance and are not known here.
const noteUnits = (asset, amount) => {
  if(BV.TACIT_ASSETS[asset] !== 'TAC') return String(amount);
  const s = amount.toString().padStart(9, '0'), whole = s.slice(0, -8), frac = s.slice(-8).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};
function readUnits(asset, text){
  const t = String(text).trim();
  if(BV.TACIT_ASSETS[asset] !== 'TAC'){
    if(!/^[1-9]\d*$/.test(t)) throw new Error('Enter a whole amount.');
    return BigInt(t);
  }
  if(!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error('Enter an amount, up to 8 places.');
  const [whole, frac = ''] = t.split('.'), units = BigInt(whole) * 100000000n + BigInt(frac.padEnd(8, '0'));
  if(units <= 0n) throw new Error('Enter an amount above zero.');
  return units;
}
const assetName = id => BV.TACIT_ASSETS[id] || (id ? short(id) : 'TACIT ASSET');
// Tacit assets in this vault. That one is here, and which, can be read from the chain
// by anyone with no signature. How much cannot: a note's amount is blinded to a key this
// vault does not have, so it says so rather than showing a number it does not know.
function renderAssets(){
  const held = (S.coins || []).filter(c => c.quarantine === 'tacit');
  if(!held.length) return '';
  const groups = new Map();
  for(const c of held) groups.set(c.asset || '', (groups.get(c.asset || '') || 0) + 1);
  return `<div class="head"><span>TACIT ASSETS</span></div>
    ${[...groups].map(([id, n]) => `<div class="row"><span class="asset"><span class="btc" style="width:20px;height:20px">${TAC_ICON}</span>${esc(assetName(id))}</span><span class="r">${n} NOTE${n > 1 ? 'S' : ''} · AMOUNT HIDDEN</span></div>`).join('')}
    <p class="small" style="padding:10px 8px 0">Set aside and never spent as sats. This vault can't read the amounts or move these yet, because a note is locked to one key and a vault has none.</p>`;
}

function renderCoins(){
  const coins = S.coins, p = S.policy;
  if(!coins || !coins.length) return '';
  const delayed = p.paths[1];
  return `<div class="head"><span>COINS</span></div>
    ${coins.map(c => {
      const left = delayed && c.height ? c.height + delayed.older - S.tip - 1 : null;
      if(BV.isProtected(c)) return `<div class="row"><span>${btcOf(c.value)} BTC</span><span class="r" title="This page will not spend it as sats">${c.quarantine === 'tacit' ? `${esc(assetName(c.asset))} · NOT SPENT` : c.quarantine ? 'CHECKING…' : 'SET ASIDE · MAY HOLD A TOKEN'}</span></div>`;
      return `<div class="row"><span>${btcOf(c.value)} BTC</span><span class="r">${!c.height ? 'UNCONFIRMED' : delayed ? (left > 0 ? `DELAYED PATH OPENS IN ${days(left)}` : 'DELAYED PATH OPEN') : `${S.tip - c.height + 1} CONF`}</span></div>`;
    }).join('')}`;
}

// Whole keys, sorted by path. A shortened key can be ground to look like another, and
// a stranger's key on the delayed path is a different thing from one in the quorum.
function renderPaths(){
  return S.policy.paths.map((x, i) => `<div class="tx-sub" style="padding:10px 8px 0">${i ? `SECOND PATH · ${x.threshold} OF ${x.keys.length} AFTER ${x.older} BLOCKS, ABOUT ${days(x.older)}` : `FIRST PATH · ${x.threshold} OF ${x.keys.length} AT ANY TIME`}</div>
    ${x.keys.map(k => `<div class="row"><span>${S.who?.[k.xpub] && S.trusted ? `<span class="who">${chip(k, true)}</span>` : ''}<span class="mono" style="font-size:11px;font-weight:400">${esc(BV.originText(k))}${isMe(k) && !(S.who?.[k.xpub] && S.trusted) ? '<span class="you">YOU</span>' : ''}</span></span></div>`).join('')}`).join('');
}

// The deadman switch is the point of a delayed vault, so its clock is out in the open.
// It follows the oldest coin, the first one the second path can reach.
function renderClock(){
  const later = S.policy.paths[1], coins = (S.coins || []).filter(c => c.height && movable(c));
  if(!later || !S.coins) return '';
  const { kind, name } = BV.policySummary(S.policy);
  const who = kind === 'aged' ? `${later.threshold} of ${later.keys.length} owners` : kind === 'custom' ? 'The keys on the second path' : `${later.threshold === later.keys.length ? 'The' : `${later.threshold} of ${later.keys.length}`} recovery key${later.keys.length > 1 ? 's' : ''}`;
  const left = coins.length ? Math.min(...coins.map(c => c.height + later.older - S.tip - 1)) : null;
  if(left !== null && left <= 0) return '';
  const pct = left === null ? 0 : Math.max(2, Math.round(100 * (1 - left / later.older))), late = left !== null && left < later.older * 0.1;
  return `<div class="clock${late ? ' late' : ''}">
    <div class="clock-top"><b>${name}</b><span>${left === null ? `ARMED · ${days(later.older)}` : `OPENS IN ${days(left)}`}</span></div>
    <div class="clock-bar"><i style="width:${pct}%"></i></div>
    <p class="small">${left === null ? `The clock starts when a coin confirms. After ${days(later.older)} unmoved, ${esc(who.charAt(0).toLowerCase() + who.slice(1))} can spend it.` : `${esc(who)} can spend the oldest coin after this. Moving coins restarts the clock.`}</p>
    ${left !== null ? '<button class="addrline" data-act="reset">RESTART THE CLOCK</button>' : ''}
  </div>`;
}

function renderWho(){
  const [first, ...later] = S.policy.paths, s = BV.policySummary(S.policy), plain = k => chip(k);
  const rest = s.kind === 'aged' ? [] : later;
  return `${S.trusted ? `<div class="who">${first.keys.map(plain).join('')}${rest.map(p => `<span class="who-l">${p.older ? `AFTER ${days(p.older)}` : 'OR'}</span>${p.keys.map(plain).join('')}`).join('')}</div>` : ''}
    <div class="rule"><b>${esc(s.name)}</b><span>${esc(s.rules.join(' '))} ${esc(s.note)}</span></div>`;
}

function renderDash(){
  if(!S.policy) return renderEmpty();
  const p = S.policy, coins = S.coins, delayed = p.paths[1];
  const total = (coins || []).filter(c => !BV.isProtected(c)).reduce((n, c) => n + c.value, 0), pending = (coins || []).filter(c => !c.height).length;
  const open = delayed && coins ? coins.filter(c => c.height && movable(c) && c.height + delayed.older - S.tip - 1 <= 0).length : 0;
  const mine = S.owner && allKeys(p).some(isMe), seated = S.owner && p.paths[0].keys.some(isMe);
  return `<div class="stats">
      <div class="stat-row"><span class="btc">${BTC_ICON}</span><span class="stat-big">${coins ? btcOf(total) : '<span class="pulse">…</span>'}</span><span class="stat-token">BTC</span>${coins && total ? `<span class="stat-sats">${total.toLocaleString('en-US')} SATS</span>` : ''}
      ${coins ? `<button class="addrline" data-act="refresh" aria-label="Scan again">↻</button>` : ''}
      ${S.trusted ? `<button class="addrline" data-act="download">BACKUP ↓</button>` : ''}</div>
      <div class="meta">
        <span><b>${p.paths[0].threshold}/${p.paths[0].keys.length}</b> SIG</span>
        ${delayed ? `<span><b>${pathLabel(delayed)}</b> ${open ? '<span class="y">OPEN</span>' : ''}</span>` : ''}
        ${S.network === 'mainnet' ? '' : '<span>SIGNET</span>'}
        ${pending ? `<span class="y">${pending} UNCONFIRMED</span>` : ''}
        ${S.owner ? `<span class="${mine ? 'g' : ''}">${seated ? 'YOU ARE AN OWNER' : mine ? 'RECOVERY KEY ONLY' : 'NOT AN OWNER'}</span>` : ''}
      </div>
      ${renderWho()}
    </div>
    ${open ? `<div class="note warn"><b>The delayed path is open on ${open} coin${open > 1 ? 's' : ''}.</b> Send them back to this vault to restart the clock. <button class="addrline" data-act="reset">SET THIS UP</button></div>` : ''}
    ${renderClock()}
    ${renderQueue()}
    ${renderTacit()}
    ${renderAssets()}
    ${renderReceive()}
    ${renderCoins()}`;
}

function renderAdmin(){
  if(!S.policy) return renderEmpty();
  const p = S.policy, d = BV.descriptor(p), list = saved(), i = list.indexOf(d);
  const s = BV.policySummary(p);
  return `<div class="head"><span>THIS VAULT'S RULES</span></div>
    <div class="rule"><b>${esc(s.name)}</b><span>${esc(s.rules.join(' '))} ${esc(s.note)}</span></div>
    <div class="btns"><button class="btn btn-outline btn-sm" data-act="changerules">CHANGE THESE RULES</button></div>
    <p class="small" style="padding:8px">Rules are part of the address, so a change is a new vault. This sets one up with the same owners, then helps you move the coins across.</p>
    <div class="head"><span>OWNERS</span></div>
    ${renderPaths()}
    ${renderHow()}
    <div class="head"><span>BACKUP</span></div>
    <p class="small" style="padding:12px 8px 0">The file spends this vault without this site. Every owner should keep a copy.</p>
    <div class="btns"><button class="btn btn-fill btn-sm" data-act="download">DOWNLOAD BACKUP</button><button class="btn btn-ghost btn-sm" data-act="copy-link">COPY LINK</button></div>
    <details><summary>FOR OTHER WALLETS</summary>
      <div class="mono" style="font-size:11px;font-weight:400;padding:12px 0">${esc(d)}</div>
      <div class="btns"><button class="btn btn-ghost btn-sm" data-act="copy-descriptor">COPY DESCRIPTOR</button><button class="btn btn-ghost btn-sm" data-act="copy-policy">COPY WALLET POLICY</button></div>
    </details>
    ${i >= 0 ? `<div class="head"><span>THIS BROWSER</span></div>
      <label class="lbl" for="rename">VAULT NAME</label><input class="inp" id="rename" data-field="rename" value="${esc(S.form.rename ?? nameOf(d, i))}" maxlength="24">
      <div class="btns"><button class="btn btn-outline btn-sm" data-act="rename">SAVE NAME</button><div class="right"><button class="btn btn-danger btn-sm" data-act="remove">REMOVE FROM THIS BROWSER</button></div></div>` : ''}`;
}

function stepper(act, value, max){
  return `<div class="stepper"><button data-act="${act}" data-d="-1" aria-label="Fewer">−</button><output>${value} OF ${max}</output><button data-act="${act}" data-d="1" aria-label="More">+</button></div>`;
}

function renderOwnerRows(text){
  return ownerRows(text).map(r => `<div class="oln${r.ok ? '' : ' bad'}"><span class="tick" aria-hidden="true">${r.ok ? '✓' : '✕'}</span><span>${esc(r.text)}</span>${r.me ? '<span class="you">YOU</span>' : ''}${r.ok ? '' : `<span>${esc(r.err)}</span>`}</div>`).join('');
}

function renderCreate(){
  const f = S.form;
  const kinds = [
    ['plain', 'QUORUM', 'A set number of owners can spend at any time.'],
    ['recovery', 'QUORUM + RECOVERY', 'Recovery keys can also spend any coin left idle past a delay. The deadman switch, enforced by Bitcoin.'],
    ['hold', 'ALL OWNERS + AGED COINS', 'Everyone can spend at once. The quorum can spend coins older than a delay.'],
    ['mirror', 'SAME AS AN ETHEREUM VAULT', 'Take the owners and threshold from a vault you already run.'],
  ];
  let n = 0;
  try { n = parseOwners(f.owners).length; } catch(_) { n = ownerRows(f.owners).filter(r => r.ok).length; }
  const hasDelay = f.kind === 'recovery' || f.kind === 'hold';
  const th = Math.min(+f.threshold || 1, Math.max(n, 1));
  let ready = null, why = null;
  try { ready = policyFromForm(); } catch(e) { why = !words(f.owners).length && f.kind !== 'mirror' ? 'Add at least one owner.' : e.message; }
  // The two shapes that fail badly, said before anyone funds them.
  const q = ready && ready.paths[0];
  const risk = !q || ready.paths.length > 1 ? null
    : q.threshold === 1 && q.keys.length > 1 ? 'Any one owner can spend alone, so this protects against lost keys and not against a stolen one.'
    : q.threshold === q.keys.length && q.keys.length > 1 ? 'If one owner loses their key, these coins are stuck for good. Consider a lower threshold, or a recovery path.'
    : q.keys.length === 1 ? 'One owner and one key. This is a single-signature wallet, not a multisig.' : null;
  return `<div class="create">
    <div>
      ${S.moving ? '<div class="note"><b>Changing the rules.</b> Set the new rules here. The old vault stays as it is until the owners sign a move.</div>' : ''}
      <label class="lbl" for="name">VAULT NAME <span class="dim">kept in this browser</span></label>
      <input class="inp" id="name" data-field="name" maxlength="24" placeholder="TREASURY" autocomplete="off" value="${esc(f.name)}">
      <span class="lbl">POLICY</span>
      <div role="radiogroup" aria-label="Policy">${kinds.map(([k, t, d]) => `<button class="kind${f.kind === k ? ' on' : ''}" role="radio" aria-checked="${f.kind === k}" data-act="kind" data-k="${k}"><b><span style="font-size:8px" aria-hidden="true">${f.kind === k ? '●' : '○'}</span>${t}</b><span>${d}</span></button>`).join('')}</div>
      ${f.kind === 'mirror' ? renderMirror() : `
        <label class="lbl" for="owners">OWNERS <span class="dim">one per line</span></label>
        <textarea class="inp" id="owners" data-field="owners" spellcheck="false" placeholder="${BV.NETWORKS[S.network].owner}1… or [fingerprint/path]xpub">${esc(f.owners)}</textarea>
        <div class="btns" style="margin-top:8px">${S.owner ? '<button class="btn btn-ghost btn-sm" data-act="add-me">+ ADD ME</button>' : '<button class="btn btn-ghost btn-sm" data-act="wallet">CONNECT TO ADD YOURSELF</button>'}</div>
        ${renderOwnerRows(f.owners)}
        <span class="lbl">${f.kind === 'hold' ? 'QUORUM ON AGED COINS' : 'SIGNATURES NEEDED'}</span>
        ${stepper('th', th, Math.max(n, 1))}
        ${hasDelay ? `<span class="lbl">DELAY</span>
          <div class="pills">${DELAYS.map(([l, b]) => `<button class="pill${+f.older === b ? ' on' : ''}" data-act="delay" data-b="${b}">${l}</button>`).join('')}
          <input class="inp" id="older" data-field="older" inputmode="numeric" aria-label="Delay in blocks" style="width:90px;padding:6px 0;font-size:12px" value="${esc(f.older)}"><span class="small">BLOCKS</span></div>` : ''}
        ${f.kind === 'hold' ? `<div class="note warn"><b>This is not the Ethereum timelock.</b> The clock starts when a coin arrives, not when someone proposes, and no one can cancel. A coin that has sat past the delay has no delay left.</div>` : ''}
        ${f.kind === 'recovery' ? `<label class="lbl" for="second">RECOVERY KEYS <span class="dim">one per line</span></label>
          <textarea class="inp" id="second" data-field="second" spellcheck="false">${esc(f.second)}</textarea>
          ${renderOwnerRows(f.second)}
          <span class="lbl">RECOVERY SIGNATURES NEEDED</span>
          ${stepper('st', +f.secondThreshold || 1, Math.max(ownerRows(f.second).filter(r => r.ok).length, 1))}
          <div class="note">Spending, or sending coins back to the vault, restarts the clock. An idle vault must do that before the delay runs out, or the recovery keys can spend.</div>` : ''}`}
    </div>
    <aside class="side">
      <b>SUMMARY</b>
      <div class="kv"><span>NETWORK</span><span>${S.network === 'mainnet' ? 'BITCOIN' : 'SIGNET'}</span></div>
      <div class="kv"><span>COST</span><span>FREE</span></div>
      ${ready ? ready.paths.map((x, i) => `<div class="kv"><span>${i ? 'SECOND PATH' : 'FIRST PATH'}</span><span>${pathLabel(x)}</span></div>`).join('') + `<div class="kv"><span>FIRST ADDRESS</span><span>${esc(short(BV.vaultOf(ready).address))}</span></div>` : `<p style="margin-top:10px">${esc(why || '')}</p>`}
      ${risk ? `<div class="note warn" style="margin-bottom:0">${esc(risk)}</div>` : ''}
      <p style="margin-top:12px">Nothing goes on chain. The vault exists once someone pays it, and its rules cannot change after that.</p>
      <button class="btn btn-fill btn-w" style="margin-top:12px" data-act="create"${ready ? '' : ' disabled'}>CREATE VAULT</button>
    </aside>
  </div>
  <details><summary>OPEN AN EXISTING VAULT</summary>
    <textarea class="inp" id="import" data-field="import" spellcheck="false" aria-label="Vault descriptor" placeholder="Paste a descriptor, tr(…">${esc(f.import)}</textarea>
    <div class="btns"><button class="btn btn-outline btn-sm" data-act="import">OPEN</button></div>
  </details>`;
}

function renderMirror(){
  const f = S.form, v = S.mirror;
  const chains = Object.entries(BV.EVM_CHAINS).map(([id, c]) => `<option value="${id}"${+f.evmChain === +id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const have = new Set();
  for(const t of words(f.owners)){ try { const h = BV.decodeOwner(t, S.network); if(h.proven) have.add(h.evm); } catch(_) {} }
  return `<div class="cols">
      <div><label class="lbl" for="evmChain">CHAIN</label><select class="inp" id="evmChain" data-field="evmChain">${chains}</select></div>
      <div><label class="lbl" for="evmVault">VAULT ADDRESS</label><input class="inp" id="evmVault" data-field="evmVault" spellcheck="false" autocomplete="off" placeholder="0x…" value="${esc(f.evmVault)}"></div>
    </div>
    <div class="btns"><button class="btn btn-outline btn-sm" data-act="read-mirror">READ VAULT</button></div>
    <div class="note warn"><b>A copy of the vault as it is now.</b> It cannot follow later changes to the owners or threshold, and it has no timelock. Contract owners, such as a Safe, cannot take part, and every owner signs with a key held in this page rather than on a hardware wallet.</div>
    ${v ? `<span class="lbl">${v.threshold} OF ${v.owners.length} OWNERS</span>
      ${v.owners.map(o => `<div class="oln"><span class="tick" aria-hidden="true">${have.has(o) ? '✓' : '○'}</span><span>${esc(o)}</span><span style="margin-left:auto">${have.has(o) ? 'READY' : 'WAITING'}</span></div>`).join('')}
      <label class="lbl" for="owners">OWNER HANDLES <span class="dim">each owner connects once and shares theirs</span></label>
      <textarea class="inp" id="owners" data-field="owners" spellcheck="false">${esc(f.owners)}</textarea>
      ${S.owner ? '<div class="btns" style="margin-top:8px"><button class="btn btn-ghost btn-sm" data-act="add-me">+ ADD ME</button></div>' : ''}` : ''}`;
}

function walletRows(){
  const btc = window.BitcoinWallets.detect(), evm = [...evmWallets];
  const row = (w, name, icon) => `<button class="wal" data-act="connect" data-w="${esc(w)}">${icon}<span>${esc(name)}</span></button>`;
  const img = w => /^data:image\//.test(w.icon || '') ? `<img src="${esc(w.icon)}" alt="">` : ETH_ICON;
  return `${btc.length ? `<div class="wal-h">BITCOIN WALLETS</div><div class="wals">${btc.map(w => row(`btc:${w.key}`, w.name, BTC_ICON)).join('')}</div>` : ''}
    <div class="wal-h">ETHEREUM WALLETS</div>
    <div class="wals">${evm.map(([id, w]) => row(id, w.name, img(w))).join('')}
    ${!evm.length && window.ethereum ? row('', 'Browser wallet', ETH_ICON) : ''}
    ${row('wc', 'WalletConnect', ETH_ICON)}</div>`;
}

function renderOverlay(){
  if(S.ovl === 'confirm' && S.pending) return `<div class="ovl"><div class="ovl-card" role="dialog" aria-modal="true" aria-label="Confirm your wallet">
    <div class="ovl-head"><span>ONE LAST SIGNATURE</span><button class="x-btn" data-act="disconnect" aria-label="Forget this key">✕</button></div>
    <p class="small">This checks your wallet makes the same key every time. It only happens once.</p>
    ${S.progress ? `<div class="connecting" role="status">${esc(S.progress)}<button class="btn btn-ghost btn-sm" data-act="cancelconnect">CANCEL</button></div>` : '<button class="btn btn-fill btn-w" style="margin-top:12px" data-act="finish">CONFIRM</button>'}
    ${S.unanswered && !S.progress ? '<div class="btns"><button class="addrline" data-act="skipcheck">My wallet will not show this. Continue anyway. If it cannot repeat this key, this address cannot be fixed later</button></div>' : ''}
  </div></div>`;
  if(S.ovl === 'connect') return `<div class="ovl" data-act="close-bg"><div class="ovl-card" role="dialog" aria-modal="true" aria-label="Connect">
    <div class="ovl-head"><span>CONNECT A WALLET</span><button class="x-btn" data-act="close" aria-label="Close">✕</button></div>
    <p class="small">Your wallet signs once to make your Bitcoin key. Same wallet, same key, on any device. No transaction, no new seed phrase.</p>
    ${S.progress ? `<div class="connecting" role="status">${esc(S.progress)}<button class="btn btn-ghost btn-sm" data-act="cancelconnect">CANCEL</button></div>` : walletRows()}
    <details class="wal-more"><summary>WHAT HAPPENS</summary>
      <p class="small">Expect two prompts, however many owners a vault has. Your public key is saved to your wallet's record, so any device finds your vaults. Your private key stays in this page while you use it and clears after 15 idle minutes. Only sign this message here.</p>
      <p class="small">On a hardware wallet? Skip this. Paste your <span class="lk">[fingerprint/path]xpub</span> as an owner, and sign each PSBT in your wallet.</p>
    </details>
  </div></div>`;
  if(S.ovl === 'me' && S.owner) return `<div class="ovl" data-act="close-bg"><div class="ovl-card" role="dialog" aria-modal="true" aria-label="Your owner key">
    <div class="ovl-head"><span>YOUR OWNER KEY</span><button class="x-btn" data-act="close" aria-label="Close">✕</button></div>
    <p class="small">Share this with whoever is creating a vault. It is public, and it cannot move funds.</p>
    ${S.owner.via ? `<p class="small">Your address on Ethereum multisigs: <button class="addrline" data-act="copy-evm">${esc(S.owner.evm)} ⧉</button></p>` : ''}
    <div class="mono" style="font-size:11px;font-weight:400;margin:12px 0">${esc(myHandle())}</div>
    <button class="btn btn-fill btn-w" data-act="copy-owner">COPY</button>
    <button class="btn btn-ghost btn-w" style="margin-top:8px" data-act="exportkey">EXPORT KEY</button>
    <button class="btn btn-ghost btn-w" style="margin-top:8px" data-act="disconnect">FORGET KEY</button>
  </div></div>`;
  if(S.ovl === 'share' && S.review){
    const left = Math.max(S.review.threshold - S.review.signedAll.length, 0);
    return `<div class="ovl" data-act="close-bg"><div class="ovl-card" role="dialog" aria-modal="true" aria-label="Share proposal">
    <div class="ovl-head"><span>${left ? `${left} MORE SIGNATURE${left > 1 ? 'S' : ''} NEEDED` : 'SHARE'}</span><button class="x-btn" data-act="close" aria-label="Close">✕</button></div>
    <p class="small">Co-signers see this in the queue. This link is the other way: it carries the proposal and your signature. Send it to a co-signer, who adds theirs and sends it on.</p>
    <button class="btn btn-fill btn-w" style="margin-top:12px" data-act="copy-link">COPY LINK</button>
    <p class="small" style="margin-top:14px">Signing with a hardware wallet? Use the PSBT in Sparrow or similar, then add it back here.</p>
    <button class="btn btn-ghost btn-w" style="margin-top:8px" data-act="copy-psbt">COPY PSBT</button>
  </div></div>`;
  }
  return '';
}

// Everything typed lives in S.form, so a redraw when a scan lands costs nothing but
// the cursor, and this puts that back.
function render(){
  document.body.classList.toggle('light', !S.dark);
  const el = document.activeElement, id = el && el.id, sel = el && el.selectionStart != null ? [el.selectionStart, el.selectionEnd] : null;
  const open = [...document.querySelectorAll('details')].map(d => d.open);
  $('app').innerHTML = `<div class="frame">
      <div class="rail rail-l" aria-hidden="true">${asc(400)}</div><div class="rail rail-r" aria-hidden="true">${asc(400)}</div>
      ${renderHeader()}${renderBars()}
      ${S.view === 'create' ? '' : renderTabs()}
      <div class="content">${S.view === 'create' ? renderCreate() : S.view === 'admin' ? renderAdmin() : renderDash()}</div>
      <div class="footer"><span>BITCOIN · ${S.network === 'mainnet' ? 'MAINNET' : 'SIGNET'}${S.tip ? ` · BLOCK ${esc(S.tip)}` : ''}</span><span><a href="./docs.html">DOCS</a></span></div>
    </div>`;
  $('ovl').innerHTML = renderOverlay();
  const ds = document.querySelectorAll('details');
  if(ds.length === open.length) ds.forEach((d, i) => { d.open = open[i]; });
  if(id && $(id)){ $(id).focus(); if(sel) try { $(id).setSelectionRange(sel[0], sel[1]); } catch(_) {} }
}

const copy = async (text, label = 'COPIED') => {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch(_) { toast('THE BROWSER REFUSED THE CLIPBOARD'); }
};

function goNet(network){
  // A key is per network, so it does not carry across.
  forget();
  Object.assign(S, { moving: null, moveFrom: null, moveTo: null, network, invited: [], view: 'dash', ovl: null, policy: null, queue: [], psbt: null, review: null, msg: null, coins: null, tip: null });
  lsSet('ms_btc_net', network);
  syncHash();
  const first = saved()[0];
  if(first) return open(BV.parseDescriptor(first, network));
}

const ACT = {
  connect, propose, sign, merge, broadcast, download,
  finish(){ return finishConnect(false); },
  skipcheck(){ return finishConnect(true); },
  refresh(){ scanned = refresh(); },
  theme(){ S.dark = !S.dark; lsSet('ms_light', S.dark ? '' : '1'); },
  wallet(){ S.ovl = S.pending ? 'confirm' : S.owner ? 'me' : 'connect'; },
  disconnect(){ forget(); S.ovl = null; },
  // For spending without this site. An xprv is the key itself, so it is asked for first.
  exportkey(){
    if(!window.confirm('This copies your private key. Anyone who has it can sign as you. Continue?')) return;
    return copy(BV.exportAccountKey(S.owner.signer, S.network), 'KEY COPIED');
  },
  close(){ S.ovl = null; },
  'close-bg'(el, e){ if(e.target === el) S.ovl = null; },
  ovl(el){ S.ovl = el.dataset.o; },
  dismiss(){ S.msg = null; },
  view(el){ S.view = el.dataset.v; S.msg = null; S.form.rename = undefined; if(S.view !== 'create') S.moving = null; },
  trust(){
    if(S.pending) throw new Error('Confirm your wallet first.');
    remember(S.policy);
    S.trusted = true;
    S.invited = S.invited.filter(d => d !== curDesc());
    if(S.owner && allKeys(S.policy).some(isMe)) BV.saveVault(S.policy, S.owner.signer, myHandle(), [myHandle()]).catch(() => {});
  },
  invited(el){ return open(BV.parseDescriptor(S.invited[+el.dataset.i], S.network), true); },
  net(el){ if(S.network !== el.dataset.n) return goNet(el.dataset.n); },
  open(el){ return open(BV.parseDescriptor(saved()[+el.dataset.i], S.network)); },
  // Someone who pastes a descriptor already holds the backup, but it may be a stranger's
  // text, so it goes through the same check as a link.
  async import(){ const p = BV.parseDescriptor(S.form.import, S.network); S.form.import = ''; setNote('backup', BV.descriptor(p), 1); await open(p, true); },
  create: createVault,
  'read-mirror': readMirror,
  kind(el){ S.form.kind = el.dataset.k; S.mirror = null; },
  delay(el){ S.form.older = el.dataset.b; },
  th(el){ const n = Math.max(ownerRows(S.form.owners).filter(r => r.ok).length, 1); S.form.threshold = String(Math.min(n, Math.max(1, Math.min(+S.form.threshold || 1, n) + +el.dataset.d))); },
  st(el){ const n = Math.max(ownerRows(S.form.second).filter(r => r.ok).length, 1); S.form.secondThreshold = String(Math.min(n, Math.max(1, (+S.form.secondThreshold || 1) + +el.dataset.d))); },
  'add-me'(){ if(S.pending) throw new Error('Confirm your wallet first.'); const f = S.form, me = myHandle(); if(!f.owners.includes(me)) f.owners = (f.owners.trim() + '\n' + me).trim(); },
  compose(){ S.compose = !S.compose; S.msg = null; },
  max(){ S.form.max = !S.form.max; if(!S.form.max) S.form.amt = ''; },
  tier(el){ Object.assign(S.form, { rate: String(feeOf(el.dataset.t)), tier: el.dataset.t }); },
  path(el){ S.form.path = el.dataset.p; },
  // Sending coins to the vault's own next address is how their clock restarts.
  reset(){ Object.assign(S.form, { to: BV.vaultOf(S.policy, 0, S.receive).address, max: true, path: '0' }); S.compose = true; },
  paste(){ load(S.form.paste.trim()); S.form.paste = ''; },
  discard(){
    const id = BV.proposalId(S.psbt);
    setNote('hidden', id, 1);
    S.queue = S.queue.filter(q => q.id !== id);
    Object.assign(S, { psbt: null, review: null });
    syncHash();
  },
  rename(){ const v = (S.form.rename ?? '').trim(); if(v){ setNote('names', curDesc(), v.slice(0, 24).toUpperCase().replace(/\s+/g, '_')); toast('SAVED'); } },
  remove(){
    if(!window.confirm('Remove this vault from this browser? The coins are not touched, but you will need its backup to open it again.')) return;
    const d = curDesc();
    lsSet(`ms_btc_vaults_${S.network}`, JSON.stringify(rawSaved().filter(x => x !== d)));
    Object.assign(S, { policy: null, view: 'dash', queue: [], psbt: null, review: null, coins: null });
    syncHash();
    const first = saved()[0];
    if(first) return open(BV.parseDescriptor(first, S.network));
  },
  'copy-owner'(){ if(S.pending) throw new Error('Confirm your wallet first.'); return copy(myHandle(), 'HANDLE COPIED'); },
  // A vault's rules cannot change, so this is a new vault with the old one's owners,
  // and the coins follow once it exists. Nothing moves until the owners sign that.
  changerules(){
    if(!S.trusted) throw new Error('Check this vault\'s keys first.');
    const p = S.policy, s = BV.policySummary(p), [first, later] = p.paths;
    if(s.kind === 'custom') throw new Error('This vault has custom rules. Set up the new one in Create.');
    Object.assign(S.form, { kind: s.kind === 'deadman' ? 'recovery' : s.kind === 'aged' ? 'hold' : 'plain', owners: first.keys.map(BV.originText).join('\n'),
      threshold: String(s.kind === 'aged' ? later.threshold : first.threshold), second: s.kind === 'deadman' ? later.keys.map(BV.originText).join('\n') : '', secondThreshold: String(later?.threshold || 1), older: String(later?.older || 4320) });
    S.moving = BV.descriptor(p);
    S.view = 'create';
  },
  // Every owner needs this vault before coins reach it, so its backup comes first, and
  // both ends must be vaults this person has already accepted.
  async movecoins(){
    const { moveFrom: from, moveTo } = S;
    if(!from || curDesc() !== moveTo || !S.trusted || !saved().includes(from)) throw new Error('That move no longer applies.');
    if(!backedUp()) throw new Error('Save this vault\'s backup first.');
    const target = BV.parseDescriptor(moveTo, S.network), to = BV.vaultOf(target, 0, 0).address;
    if(S.owner?.signer && allKeys(target).some(isMe)) await BV.saveVault(target, S.owner.signer, myHandle(), [myHandle()]).catch(() => {});
    Object.assign(S, { moveFrom: null, moveTo: null });
    await open(BV.parseDescriptor(from, S.network));
    await scanned;
    Object.assign(S.form, { to, max: true, path: '0' });
    S.compose = true;
  },
  async 'tacit-setup'(){
    if(S.pending) throw new Error('Confirm your wallet first.');
    const record = await window.BitcoinTacit.makeRecord(S.owner.signer, S.owner, S.policy);
    await BV.publishNoteRecord(S.policy, S.owner.signer, myHandle(), record);
    await readTacit();
  },
  'copy-tacit'(){ return copy(window.BitcoinTacit.noteAddress(S.noteKey, S.network), 'ADDRESS COPIED'); },
  'copy-tacit-fee'(){ return copy(window.BitcoinTacit.inboxAddress(S.noteKey, S.network), 'ADDRESS COPIED'); },
  async 'tacit-sweep'(){
    if(!S.coins) throw new Error('Still reading this vault.');
    const BT = window.BitcoinTacit, { waiting, fee } = tacAll(), asset = waiting[0].asset;
    S.msg = { text: 'BUILDING THE TRANSFER. THIS CAN TAKE A MOMENT', kind: 'ok' };
    render();
    const prover = await BT.loadProver();
    const built = BT.buildSweep({ priv: S.noteKey, notes: waiting.filter(n => n.asset === asset).slice(0, 8), fee, rate: tacRate(), vaultSpk: BV.vaultOf(S.policy, 0, S.receive).script, prover });
    await tacBroadcast(built);
    toast('SENT TO THE VAULT');
    S.msg = null;
    await readTacit();
  },
  'tacit-open'(){ S.tacOpen = !S.tacOpen; },
  'tacit-asset'(el){ S.form.tacAsset = el.dataset.a; },
  async 'tacit-reseed'(){
    if(!S.coins) throw new Error('Still reading this vault.');
    const BT = window.BitcoinTacit, { fee, held, asset } = tacAll(), notes = held.filter(n => n.asset === asset).sort((a, b) => (a.amount < b.amount ? 1 : -1)).slice(0, 16);
    S.msg = { text: 'BUILDING THE TRANSFER. THIS CAN TAKE A MOMENT', kind: 'ok' };
    render();
    const prover = await BT.loadProver();
    const p = BT.buildReseed({ priv: S.noteKey, notes, fee, rate: tacRate(), slot: { policy: S.policy, index: S.receive }, prover });
    await BT.reviewSend(p, S.policy, S.noteKey, BV.chain(S.network), prover, known());
    await BV.publishTacSend(S.policy, S.owner.signer, myHandle(), BT.sendId(p), p);
    S.msg = null;
    await readTacit();
  },
  async 'tacit-propose'(){
    if(!S.coins) throw new Error('Still reading this vault.');
    const BT = window.BitcoinTacit, f = S.form, { leadFor, fee, held, sendable } = tacAll();
    const recipient = BT.parseRecipient(f.tacTo, S.network), amount = readUnits(sendable, f.tacAmt || ''), lead = leadFor(sendable);
    const notes = held.filter(n => n.asset === sendable).sort((a, b) => (a.amount < b.amount ? 1 : -1)).slice(0, 16);
    S.msg = { text: 'BUILDING THE TRANSFER. THIS CAN TAKE A MOMENT', kind: 'ok' };
    render();
    const prover = await BT.loadProver();
    const p = BT.buildSend({ priv: S.noteKey, keyNote: lead, notes, recipient, to: f.tacTo.trim().toLowerCase(), amount, fee, rate: tacRate(), slot: { policy: S.policy, index: S.receive }, prover });
    await BT.reviewSend(p, S.policy, S.noteKey, BV.chain(S.network), prover, known());
    await BV.publishTacSend(S.policy, S.owner.signer, myHandle(), BT.sendId(p), p);
    Object.assign(f, { tacTo: '', tacAmt: '' });
    S.tacOpen = false;
    S.msg = null;
    await readTacit();
  },
  // Reviewed again here against the chain and V, whatever the queue said a moment ago.
  async 'tacit-sign'(el){
    const BT = window.BitcoinTacit, q = tacCard(el), prover = await BT.loadProver();
    const r = await BT.reviewSend(q.p, S.policy, S.noteKey, BV.chain(S.network), prover, known());
    if(!window.confirm(`Sign this Tacit ${r.reseed ? 'refresh' : 'send'}?\n\n${r.reseed ? `${noteUnits(r.asset, r.total)} ${assetName(r.asset)} stays in this vault` : `${noteUnits(r.asset, r.amount)} ${assetName(r.asset)} to ${r.recipient}\n${noteUnits(r.asset, r.change)} back to the vault`}\nFee ${r.sats.toLocaleString('en-US')} sats${r.back ? `\n${r.back.toLocaleString('en-US')} sats to the note key` : ''}\n\nYour wallet will not ask again. This is your approval.`)) return;
    const id = BT.sendId(q.p);
    // Whatever another owner saved meanwhile is kept, not written over.
    const latest = (await BV.fetchTacSends(S.policy).catch(() => [])).find(x => { try { return BT.sendId(x) === id; } catch(_) { return false; } });
    const signed = BT.signSend(latest ? BT.mergeSigs(q.p, latest, S.policy) : q.p, S.owner.signer, S.owner, S.policy);
    await BV.publishTacSend(S.policy, S.owner.signer, myHandle(), id, signed);
    await readTacit();
  },
  async 'tacit-broadcast'(el){
    const BT = window.BitcoinTacit, q = tacCard(el), prover = await BT.loadProver();
    const c = BV.chain(S.network);
    await BT.reviewSend(q.p, S.policy, S.noteKey, c, prover, known());
    // Checked first, because the commit spends its fee whether or not the reveal lands.
    for(const i of q.p.reveal.ins.slice(1)) if(await c.spent(i.txid, i.vout)) throw new Error('A coin in this send has already moved. Propose it again.');
    await tacBroadcast(BT.finishSend(q.p, S.policy));
    toast('SENT');
    scanned = refresh();
  },
  'copy-evm'(){ return copy(S.owner.evm, 'ADDRESS COPIED'); },
  'copy-address'(){ return copy(BV.vaultOf(S.policy, 0, S.receive).address, 'ADDRESS COPIED'); },
  async 'copy-descriptor'(){ await copy(BV.descriptor(S.policy), 'DESCRIPTOR COPIED'); setNote('backup', curDesc(), 1); },
  'copy-policy'(){ return copy(JSON.stringify(BV.walletPolicy(S.policy), null, 2), 'POLICY COPIED'); },
  'copy-psbt'(){ return copy(S.psbt, 'PSBT COPIED'); },
  'copy-link'(){ return copy(linkFor(), 'LINK COPIED'); },
};

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  touch();
  // Past the busy lock on purpose: the lock is what a stuck wallet would be holding.
  if(el?.dataset.act === 'cancelconnect'){ window.BitcoinWallets.cancelPrompt(); return; }
  if(!el || S.busy) return;
  S.busy = true;
  try {
    // A card's buttons act on that card.
    const card = el.closest('[data-pid]'), item = card && S.queue.find(q => q.id === card.dataset.pid);
    // A card can outlive its proposal on screen. Acting on whatever was selected last
    // would sign something other than what the button is on.
    if(card && !item) throw new Error('This proposal changed. Check it again.');
    if(item) Object.assign(S, { psbt: item.psbt, review: item.review });
    await ACT[el.dataset.act](el, e);
    render();
  }
  catch(err) { S.ovl = null; S.progress = null; say(err?.message || String(err)); }
  finally { S.busy = false; }
});
document.addEventListener('input', e => {
  const k = e.target.dataset?.field;
  if(!k) return;
  S.form[k] = e.target.value;
  if(k === 'amt') S.form.max = false;
  if(k === 'rate') S.form.tier = '';
  if(k === 'evmChain' || k === 'evmVault') S.mirror = null;
  // Only the create form reads itself back as it is typed in. The fee pills light up
  // from the rate, so that one field redraws too.
  if(k === 'owners' || k === 'second') resolveWallets(k);
  if(S.view === 'create' || k === 'rate' || k === 'amt' || k === 'to') render();
});
document.addEventListener('keydown', e => { if(e.key === 'Escape' && S.ovl && S.ovl !== 'confirm'){ S.ovl = null; render(); } });
window.addEventListener('hashchange', readHash);
// Coming back to a tab: the key may be past its time, and the coins may have moved.
document.addEventListener('visibilitychange', () => {
  if(document.hidden) return;
  if(S.owner && Date.now() - lastActive > IDLE_MS){ forget(); render(); }
  if(S.policy && !S.busy && Date.now() - lastScan > 5 * 60 * 1000) refresh();
});

render();
readHash().then(handled => {
  if(handled) return;
  // Sent here from the main app to find this wallet's vaults, which takes its signature.
  if(location.hash === '#find' && !S.owner){ S.ovl = 'connect'; render(); }
  const first = saved()[0];
  if(first) return open(BV.parseDescriptor(first, S.network));
});

})();
