'use strict';
// The Bitcoin page. Everything that decides anything is in bitcoin.js; this file
// holds the screen. There is no server behind it: vaults are descriptors kept in
// this browser and in links, and a proposal moves between owners as a PSBT in a
// link fragment, which never reaches a web server's log.
//
// The layout is the Ethereum dashboard's on purpose: the same header, tabs, stat and
// queue card, so that Bitcoin reads as another chain and not as another product.

(function(){

// The address is /bitcoin. In-app links stay bitcoin.html because that is the only
// spelling an IPFS gateway resolves, so the page tidies the bar itself, on our own host
// only, and keeps the fragment that holds a vault or a proposal.
if(/(^|\.)multisig\.software$/.test(location.hostname) && location.pathname === '/bitcoin.html'){
  try { history.replaceState(null, '', `/bitcoin${location.search}${location.hash}`); } catch(_) {}
}

const BV = window.BitcoinVault;
const $ = id => document.getElementById(id);
const _escMap = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, m => _escMap[m]);
const lsGet = k => { try { return localStorage.getItem(k); } catch(_) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch(_) {} };
const lsJson = (k, d) => { try { return JSON.parse(lsGet(k)) ?? d; } catch(_) { return d; } };
const btcOf = sats => (sats / 1e8).toFixed(8);
const short = s => s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
const days = blocks => { const d = blocks / 144; return d < 2 ? `${Math.max(1, Math.round(blocks / 6))}H` : `${Math.round(d)}D`; };
const asc = n => '/'.repeat(n);

// bitcoin.js is network-agnostic, so this is the one switch. Turning it off stops new
// use of mainnet from this page. It moves no one's coins, and any descriptor tool can
// still spend them.
const MAINNET = true;
// A key left in an open tab is a key at risk for no benefit.
const IDLE_MS = 15 * 60 * 1000;
const DELAYS = [['1D', 144], ['7D', 1008], ['30D', 4320], ['90D', 12960], ['1Y', 52560]];
const BTC_ICON = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#F7931A"/><path fill="#FFF" d="M22.3 14.1c.3-2.1-1.3-3.2-3.5-4l.7-2.8-1.7-.4-.7 2.7-1.4-.3.7-2.8-1.7-.4-.7 2.8-1.1-.3-2.4-.6-.5 1.8s1.3.3 1.3.3c.7.2.8.6.8 1l-.8 3.2.2.1-.2-.1-1.1 4.5c-.1.2-.3.5-.8.4 0 0-1.3-.3-1.3-.3l-.9 2 2.3.6 1.2.3-.7 2.9 1.7.4.7-2.8 1.4.3-.7 2.8 1.7.4.7-2.9c2.9.6 5.1.3 6-2.3.8-2.1 0-3.3-1.6-4.1 1.1-.3 2-1.1 2.3-2.7zm-3.9 5.4c-.5 2.1-4.1 1-5.2.7l.9-3.7c1.2.3 4.9.9 4.3 3zm.5-5.4c-.5 1.9-3.4.9-4.4.7l.8-3.3c1 .2 4.1.7 3.6 2.6z"/></svg>`;

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
  psbt: null, review: null, compose: false,
  mirror: null,
  form: { name: '', kind: 'plain', evmChain: '1', evmVault: '', owners: '', threshold: '2', second: '', secondThreshold: '1', older: '4320', to: '', amt: '', rate: '', path: '0', paste: '', merge: '', import: '', hw: '' },
  msg: null, busy: false,
};
const myHandle = () => BV.encodeOwner({ network: S.network, ...S.owner });
function forget(){ if(S.owner){ S.owner.signer.wipePrivateData(); S.owner = null; } }
const known = () => S.coins ? { receive: S.receive, change: S.change } : undefined;
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
const isMe = k => !!S.owner && S.owner.xpub === k.xpub;
const allKeys = p => [...new Map(p.paths.flatMap(x => x.keys).map(k => [k.xpub, k])).values()];

// ── OWNER KEY ──────────────────────────────────────────────
async function connect(){
  // A path gateway gives every site on it this same origin, and the key would be
  // within their reach.
  if(/^\/ip[fn]s\//.test(location.pathname)) throw new Error('Open this page from its own domain to use a key. This address shares its origin with other sites.');
  // The hosting headers do not travel to a mirror, so the page checks for itself.
  if(window.top !== window || window.opener) throw new Error('Open this page in its own tab to use a key.');
  const eth = window.ethereum;
  if(!eth) throw new Error('No Ethereum wallet in this browser. Owners on a hardware wallet need no connection here: copy the PSBT and sign it there.');
  const [evm] = await eth.request({ method: 'eth_requestAccounts' });
  const hexMsg = m => '0x' + window.btc.hex.encode(new TextEncoder().encode(m));
  const key = await BV.deriveOwnerKey(m => eth.request({ method: 'personal_sign', params: [hexMsg(m), evm] }), S.network);
  // A third signature, but a harmless one: this is the one that gets published, and
  // it is what lets an owner's handle count towards a vault mirrored from Ethereum.
  const proof = await eth.request({ method: 'personal_sign', params: [hexMsg(BV.bindingMessage(S.network, key.owner)), evm] });
  forget();
  S.owner = { ...key.owner, signer: key.signer, evm: evm.toLowerCase(), proof };
  S.msg = null;
  S.ovl = 'me';
  touch();
}

// ── VAULTS ─────────────────────────────────────────────────
const words = text => text.split(/[\s,]+/).filter(Boolean);
const parseOwners = text => words(text).map(t => BV.decodeOwner(t, S.network));

// Each line checked as it is typed, so a bad paste is found at the paste.
function ownerRows(text){
  return words(text).map(t => {
    try {
      const o = BV.decodeOwner(t, S.network);
      return { ok: true, text: o.evm ? short(o.evm) : o.fingerprint, proven: !!o.proven, me: isMe(o) };
    } catch(e) { return { ok: false, text: short(t), err: e.message }; }
  });
}

async function readMirror(){
  S.mirror = await BV.readEvmVault(+S.form.evmChain, S.form.evmVault.trim());
  S.form.threshold = String(S.mirror.threshold);
  S.msg = null;
}

function policyFromForm(){
  const f = S.form;
  if(f.kind === 'mirror'){
    if(!S.mirror) throw new Error('Read the Ethereum vault first.');
    const { missing, policy } = BV.mirror({ network: S.network, vault: S.mirror, handles: words(f.owners) });
    if(missing.length) throw new Error(`Still waiting on ${missing.length} of ${S.mirror.owners.length} owners.`);
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
  const policy = policyFromForm(), d = BV.descriptor(policy), f = S.form;
  if(f.name.trim()) setNote('names', d, f.name.trim().slice(0, 24).toUpperCase().replace(/\s+/g, '_'));
  for(const t of [...words(f.owners), ...words(f.second)]){
    try { const o = BV.decodeOwner(t, S.network); if(o.evm) setNote('labels', o.xpub, short(o.evm)); } catch(_) {}
  }
  Object.assign(S.form, { name: '', owners: '', second: '', evmVault: '' });
  S.mirror = null;
  return open(policy);
}

// A vault that arrives in a link is not yet this person's vault. It could be anyone's
// keys under the words "our vault", so it is not saved, and its address is not shown
// to be paid until they have looked at the owners and said so.
async function open(policy, fromLink = false){
  const trusted = !fromLink || saved().includes(BV.descriptor(policy));
  if(trusted) remember(policy);
  Object.assign(S, { policy, trusted, view: 'dash', compose: false, coins: null, tip: null, psbt: null, review: null, msg: null });
  syncHash();
  render();
  // In the background: a click's busy lock must not outlast the click, or every button
  // goes dead for as long as an explorer takes to answer.
  scanned = refresh();
}

// Numbered, because a slow scan of the last vault must not land on this one.
let scanning = 0, lastScan = 0, scanned = Promise.resolve();
async function refresh(){
  const c = BV.chain(S.network), run = ++scanning;
  lastScan = Date.now();
  try {
    const [found, tip, fees] = await Promise.all([BV.scan(S.policy, c), c.tip(), c.fees().catch(() => ({}))]);
    if(run !== scanning) return;
    Object.assign(S, { coins: found.coins, receive: found.receive, change: found.change, tip, fees });
    // Change is judged against how far the scan reached, so a proposal opened before
    // it finished is read again now that it has.
    if(S.psbt) S.review = BV.inspect(S.psbt, S.policy, known());
    render();
  } catch(e) { if(run === scanning) say(`Could not read the chain: ${e.message}`); }
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
    if(S.psbt && S.psbt !== proposal && !window.confirm('This link replaces the proposal on screen. Continue?')){ syncHash(); return true; }
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
  S.review = BV.inspect(psbt, S.policy, known());
  S.psbt = psbt;
  S.compose = false;
  S.msg = null;
  syncHash();
}

function propose(){
  const f = S.form, addr = f.to.trim(), amt = f.amt.trim();
  const args = { policy: S.policy, utxos: S.coins || [], tip: S.tip, feeRate: +f.rate || feeOf('3'), path: +f.path, change: S.change };
  if(!addr) throw new Error('Enter an address to send to.');
  if(amt.toLowerCase() === 'all') args.sweep = addr;
  else {
    if(!/^\d+(\.\d{1,8})?$/.test(amt)) throw new Error('Amount is in BTC, up to 8 places, or use MAX.');
    const [whole, frac = ''] = amt.split('.');
    args.outputs = [{ address: addr, sats: Number(BigInt(whole) * 100000000n + BigInt(frac.padEnd(8, '0'))) }];
  }
  load(BV.propose(args));
  Object.assign(S.form, { to: '', amt: '', rate: '', path: '0' });
}

function sign(){
  if(!S.owner) throw new Error('Connect first: nothing here can sign without your owner key.');
  load(BV.sign(S.psbt, S.owner.signer, S.policy, known()));
  touch();
  // The next thing to do after signing is nearly always to pass it on.
  if(!S.review.ready) S.ovl = 'share';
}

function merge(){
  const more = S.form.merge.trim();
  if(!more) return;
  load(BV.combine([S.psbt, more], S.policy));
  S.form.merge = '';
  toast('SIGNATURES ADDED');
}

async function broadcast(){
  const c = BV.chain(S.network);
  // A coin spent since this was proposed makes the whole proposal void. Say that,
  // rather than show a node's refusal.
  for(const i of S.review.inputs) if(await c.spent(i.txid, i.vout)) throw new Error('A coin in this proposal has already been spent. It is void; propose again.');
  const raw = BV.finalize(S.psbt, S.policy), txid = BV.txidOf(raw), said = (await c.broadcast(raw)).trim();
  // The signatures are not thrown away on an explorer's word.
  if(said !== txid) throw new Error('The explorer gave an unexpected reply, so this may not have been sent. The proposal is still here.');
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
  const label = S.owner ? `0x${S.owner.evm.slice(2, 6)}…${S.owner.evm.slice(-4)}` : 'CONNECT';
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
      </div>
    </div>
    <nav class="nav">
      ${[['dash', 'DASHBOARD'], ['admin', 'ADMIN'], ['create', 'CREATE']].map(([k, l]) => `<button class="${S.view === k ? 'on' : ''}"${S.view === k ? ' aria-current="page"' : ''} data-act="view" data-v="${k}">${l}</button>`).join('')}
      <div class="nets">
        <a href="./index.html">ETHEREUM ↗</a>
        ${(MAINNET ? ['mainnet', 'signet'] : ['signet']).map(n => `<button class="pill${n === S.network ? ' on' : ''}" data-act="net" data-n="${n}"${n === S.network ? ' aria-current="true"' : ''}>${n === 'mainnet' ? 'BITCOIN' : 'SIGNET'}</button>`).join('')}
      </div>
    </nav>`;
}

function renderBars(){
  const out = [];
  const m = S.msg;
  if(m) out.push(`<div class="attn ${m.kind === 'ok' ? 'ok' : 'bad'}" role="status"><b>${esc(m.text)}</b>${m.href ? `<a href="${esc(m.href)}" target="_blank" rel="noopener">VIEW ↗</a>` : ''}<button class="end" data-act="dismiss" aria-label="Dismiss">✕</button></div>`);
  if(S.network === 'mainnet') out.push(`<div class="attn"><b>REAL BITCOIN</b><span>NOT INDEPENDENTLY REVIEWED · START WITH AN AMOUNT YOU CAN LOSE</span></div>`);
  if(S.policy && S.owner && BV.seatMisdescribed(S.policy, S.owner)) out.push(`<div class="attn"><b>YOUR KEY IS MISDESCRIBED IN THIS VAULT</b><span>IT STILL SIGNS HERE, BUT ASK WHO CREATED IT WHY</span></div>`);
  if(S.view === 'dash' && S.policy && S.trusted && !backedUp()) out.push(`<div class="attn"><b>BACK UP THIS VAULT</b><span>WITHOUT IT THE COINS CANNOT BE SPENT, EVEN WITH EVERY KEY</span></div>`);
  return out.join('');
}

function renderTabs(){
  const list = saved(), cur = curDesc();
  if(!list.length && !S.policy) return '';
  const tabs = list.map((d, i) => {
    const p = BV.parseDescriptor(d, S.network), on = d === cur;
    const total = on && S.coins ? `${btcOf(S.coins.reduce((n, c) => n + c.value, 0))} BTC` : `${p.paths[0].threshold}/${p.paths[0].keys.length} SIG`;
    return `<button class="vtab${on ? ' on' : ''}" data-act="open" data-i="${i}"${on ? ' aria-current="true"' : ''}><div class="vtab-name">${esc(nameOf(d, i))}${on && S.psbt ? '<span class="vtab-dot" aria-hidden="true"></span>' : ''}</div><div class="vtab-info">${esc(total)}</div></button>`;
  });
  if(S.policy && !S.trusted) tabs.unshift(`<button class="vtab on" aria-current="true"><div class="vtab-name">FROM A LINK<span class="vtab-dot" aria-hidden="true"></span></div><div class="vtab-info">NOT SAVED</div></button>`);
  return `<div class="vtabs"><div class="vtabs-inner">${tabs.join('')}</div></div>`;
}

function renderEmpty(){
  return `<div class="empty">
    <div class="empty-title">NO VAULTS</div>
    <div class="empty-sub">${S.network === 'signet' ? 'TRY ONE ON SIGNET. COINS ARE FREE AND WORTH NOTHING.' : 'K-OF-N BITCOIN. NO CONTRACT, NO SERVER.'}</div>
    <button class="btn btn-fill" data-act="view" data-v="create">CREATE A VAULT</button>
    <details><summary>OPEN AN EXISTING VAULT</summary>
      <textarea class="inp" id="import" data-field="import" spellcheck="false" aria-label="Vault descriptor" placeholder="Paste a descriptor, tr(…">${esc(S.form.import)}</textarea>
      <div class="btns"><button class="btn btn-outline btn-sm" data-act="import">OPEN</button></div>
    </details>
    <div class="steps">
      <div class="step"><b>1 / OWNERS</b><span>Each owner brings a key, from an Ethereum wallet or a hardware wallet. Nothing is deployed and it costs nothing.</span></div>
      <div class="step"><b>2 / RECEIVE</b><span>Save the backup, then send bitcoin to the vault. Each deposit can use a fresh address.</span></div>
      <div class="step"><b>3 / SPEND</b><span>One owner proposes, the others sign in any order, and Bitcoin itself enforces the threshold.</span></div>
    </div>
  </div>`;
}

const chips = (r) => `<div class="approvals">${r.keys.map(k => {
  const did = r.signedAll.includes(k.xpub);
  return `<span class="${did ? 'ap-ok' : 'ap-no'}"><span aria-hidden="true">${did ? '✓' : '○'}</span><span class="sr">${did ? 'Signed:' : 'Not signed:'}</span>${esc(labelOf(k).toUpperCase())}${isMe(k) ? ' ★' : ''}</span>`;
}).join('')}</div>`;

function renderProposal(){
  const r = S.review;
  const mine = S.owner && r.keys.some(k => k.xpub === S.owner.xpub), signed = S.owner && r.signedAll.includes(S.owner.xpub);
  const stranded = r.outputs.some(o => o.stranded);
  const sends = r.outputs.filter(o => !o.change), back = r.outputs.filter(o => o.change);
  const value = sends.reduce((n, o) => n + o.sats, 0);
  // A delayed proposal can be fully signed long before it can confirm.
  const heights = r.older && S.coins ? r.inputs.map(i => S.coins.find(c => c.txid === i.txid && c.vout === i.vout)?.height || 0) : [];
  const validAt = heights.length ? Math.max(...heights) + r.older : 0;
  const early = validAt > (S.tip || 0) + 1;
  const have = r.signedAll.length, status = stranded ? ['bad', 'DO NOT SIGN'] : r.ready ? ['ok', 'READY'] : ['wait', `${have} OF ${r.threshold} SIGNED`];
  const canSign = mine && !signed && S.trusted && !stranded;
  return `<div class="tx${r.ready ? ' ready' : ''}">
    <div class="tx-top">
      <div>
        <span class="tag">${sends.length ? 'BTC TRANSFER' : 'CLOCK RESET'}${r.older ? ' · DELAYED PATH' : ''}</span>
        <div class="tx-val"><span class="btc" style="width:18px;height:18px">${BTC_ICON}</span>${btcOf(sends.length ? value : back.reduce((n, o) => n + o.sats, 0))} BTC</div>
      </div>
      <span class="tx-status ${status[0]}">${status[1]}</span>
    </div>
    ${sends.map(o => `<div class="tx-to">→ ${esc(o.address)}${sends.length > 1 ? ` · ${btcOf(o.sats)} BTC` : ''}${o.stranded ? ' · LOST ADDRESS' : ''}</div>`).join('')}
    <div class="tx-sub">FEE ${btcOf(r.fee)} BTC · ${r.feeRate.toFixed(1)} SAT/VB${back.length ? ` · ${btcOf(back.reduce((n, o) => n + o.sats, 0))} BTC BACK TO THE VAULT` : ''}</div>
    ${chips(r)}
    ${early ? `<div class="note warn"><b>Not valid until block ${validAt}.</b> Once signed it can be sent any time after that, even if it is discarded here.</div>` : ''}
    ${r.signedBy.length ? '<p class="tx-sub">DISCARD ONLY CLEARS THIS PAGE. SIGNATURES ALREADY SHARED STAY VALID UNTIL THESE COINS MOVE.</p>' : ''}
    ${r.feeRate > 200 ? '<div class="note warn"><b>That fee is unusually high.</b> Check it before signing.</div>' : ''}
    ${stranded ? '<div class="note bad">This sends coins to a vault address so far along that no scan would find them. Do not sign it.</div>' : ''}
    ${mine && !S.trusted ? '<div class="note warn">Confirm the owners above before signing.</div>' : ''}
    <div class="btns">
      <button class="btn btn-ghost btn-sm" data-act="ovl" data-o="share">SHARE</button>
      <div class="right">
        <button class="btn btn-ghost" data-act="discard">DISCARD</button>
        ${!S.owner && !r.ready ? '<button class="btn btn-outline" data-act="wallet">CONNECT TO SIGN</button>' : ''}
        ${canSign ? `<button class="btn btn-fill" data-act="sign"${S.coins ? '' : ' disabled'}>${S.coins ? 'SIGN' : 'SCANNING…'}</button>` : ''}
        ${r.ready ? '<button class="btn btn-green btn-big" data-act="broadcast">BROADCAST</button>' : ''}
      </div>
    </div>
    <details><summary>ADD A SIGNATURE FROM ANOTHER WALLET</summary>
      <textarea class="inp" id="merge" data-field="merge" spellcheck="false" aria-label="Signed PSBT" placeholder="Paste a PSBT signed elsewhere, such as Sparrow with a hardware wallet">${esc(S.form.merge)}</textarea>
      <div class="btns"><button class="btn btn-outline btn-sm" data-act="merge">ADD</button></div>
    </details>
  </div>`;
}

function renderCompose(){
  const f = S.form, p = S.policy;
  const tiers = [['SLOW', '144'], ['NORMAL', '6'], ['FAST', '1']];
  const cur = f.rate || String(feeOf('6'));
  return `<div class="tx">
    <label class="lbl" for="to">TO</label>
    <input class="inp" id="to" data-field="to" spellcheck="false" autocomplete="off" placeholder="${S.network === 'signet' ? 'tb1…' : 'bc1…'}" value="${esc(f.to)}">
    <div class="cols">
      <div>
        <label class="lbl" for="amt">AMOUNT <span class="dim">BTC</span></label>
        <input class="inp" id="amt" data-field="amt" inputmode="decimal" autocomplete="off" placeholder="0.00000000" value="${esc(f.amt)}">
        <div class="pills" style="margin-top:8px"><button class="pill${f.amt === 'all' ? ' on' : ''}" data-act="max">MAX</button></div>
      </div>
      <div>
        <label class="lbl" for="rate">FEE <span class="dim">sat/vB</span></label>
        <input class="inp" id="rate" data-field="rate" inputmode="decimal" autocomplete="off" value="${esc(cur)}">
        <div class="pills" style="margin-top:8px">${tiers.map(([l, t]) => `<button class="pill${cur === String(feeOf(t)) ? ' on' : ''}" data-act="tier" data-t="${t}">${l} ${feeOf(t)}</button>`).join('')}</div>
      </div>
    </div>
    ${p.paths.length > 1 ? `<label class="lbl">SPEND WITH</label><div class="pills">${p.paths.map((x, i) => `<button class="pill${f.path === String(i) ? ' on' : ''}" data-act="path" data-p="${i}">${pathLabel(x)}</button>`).join('')}</div>` : ''}
    <div class="btns"><div class="right"><button class="btn btn-ghost" data-act="compose">CANCEL</button><button class="btn btn-fill" data-act="propose"${S.coins ? '' : ' disabled'}>PROPOSE</button></div></div>
  </div>`;
}

const pathLabel = x => `${x.threshold}/${x.keys.length}${x.older ? ` AFTER ${days(x.older)}` : ''}`;

function renderQueue(){
  const body = S.review ? renderProposal() : S.compose ? renderCompose()
    : `<div class="empty-row">NOTHING PENDING<details><summary>OPEN A PROPOSAL SOMEONE SENT YOU</summary>
        <textarea class="inp" id="paste" data-field="paste" spellcheck="false" aria-label="PSBT" placeholder="Paste a PSBT">${esc(S.form.paste)}</textarea>
        <div class="btns"><button class="btn btn-outline btn-sm" data-act="paste">OPEN</button></div>
      </details></div>`;
  return `<div class="head"><span>QUEUE</span>${S.review || S.compose ? '' : `<button class="btn btn-outline btn-sm" data-act="compose"${S.coins && S.coins.length ? '' : ' disabled'}>+ NEW</button>`}</div>${body}`;
}

function renderReceive(){
  if(!S.trusted) return `<div class="head"><span>CHECK BEFORE YOU USE THIS</span></div>
    <div class="note warn"><b>Someone else gave you this vault, and they chose these keys.</b> Compare every key below in full, with its owner, over a channel you trust. A close match is not a match.</div>
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
        <p class="small" style="margin-top:14px">A fresh address appears after each deposit. Every address here belongs to this vault.</p>
        ${S.network === 'signet' ? `<p class="small">Need test coins? <a class="lk" href="https://faucet.coinbin.org" target="_blank" rel="noopener">Signet faucet ↗</a></p>` : ''}
      </div>
      ${S.coins ? `<div class="qr" role="img" aria-label="QR code of the address">${window.btc.encodeQR(a.toUpperCase(), 'svg')}</div>` : ''}
    </div>`;
}

function renderCoins(){
  const coins = S.coins, p = S.policy;
  if(!coins || !coins.length) return '';
  const delayed = p.paths[1];
  return `<div class="head"><span>COINS</span></div>
    ${coins.map(c => {
      const left = delayed && c.height ? c.height + delayed.older - S.tip - 1 : null;
      return `<div class="row"><span>${btcOf(c.value)} BTC</span><span class="r">${!c.height ? 'UNCONFIRMED' : delayed ? (left > 0 ? `DELAYED PATH OPENS IN ${days(left)}` : 'DELAYED PATH OPEN') : `${S.tip - c.height + 1} CONF`}</span></div>`;
    }).join('')}`;
}

// Whole keys, sorted by path. A shortened key can be ground to look like another, and
// a stranger's key on the delayed path is a different thing from one in the quorum.
function renderPaths(){
  return S.policy.paths.map((x, i) => `<div class="tx-sub" style="padding:10px 8px 0">${i ? `SECOND PATH · ${x.threshold} OF ${x.keys.length} AFTER ${x.older} BLOCKS, ABOUT ${days(x.older)}` : `FIRST PATH · ${x.threshold} OF ${x.keys.length} AT ANY TIME`}</div>
    ${x.keys.map(k => `<div class="row"><span class="mono" style="font-size:11px;font-weight:400">${esc(k.xpub)}${isMe(k) ? '<span class="you">YOU</span>' : ''}</span></div>`).join('')}`).join('');
}

function renderDash(){
  if(!S.policy) return renderEmpty();
  const p = S.policy, coins = S.coins, delayed = p.paths[1];
  const total = (coins || []).reduce((n, c) => n + c.value, 0), pending = (coins || []).filter(c => !c.height).length;
  const open = delayed && coins ? coins.filter(c => c.height && c.height + delayed.older - S.tip - 1 <= 0).length : 0;
  const mine = S.owner && allKeys(p).some(isMe);
  return `<div class="stats">
      <div class="stat-row"><span class="btc">${BTC_ICON}</span><span class="stat-big">${coins ? btcOf(total) : '<span class="pulse">…</span>'}</span><span class="stat-token">BTC</span>
      ${coins ? `<button class="addrline" data-act="refresh" aria-label="Scan again">↻</button>` : ''}</div>
      <div class="meta">
        <span><b>${p.paths[0].threshold}/${p.paths[0].keys.length}</b> SIG</span>
        ${delayed ? `<span><b>${pathLabel(delayed)}</b> ${open ? '<span class="y">OPEN</span>' : ''}</span>` : ''}
        <span>${S.network === 'mainnet' ? 'BITCOIN' : 'SIGNET'}</span>
        ${pending ? `<span class="y">${pending} UNCONFIRMED</span>` : ''}
        ${S.owner ? `<span class="${mine ? 'g' : ''}">${mine ? 'YOU ARE AN OWNER' : 'NOT AN OWNER'}</span>` : ''}
      </div>
    </div>
    ${open ? `<div class="note warn"><b>The delayed path is open on ${open} coin${open > 1 ? 's' : ''}.</b> Send them back to this vault to restart the clock. <button class="addrline" data-act="reset">SET THIS UP</button></div>` : ''}
    ${renderQueue()}
    ${renderReceive()}
    ${renderCoins()}`;
}

function renderAdmin(){
  if(!S.policy) return renderEmpty();
  const p = S.policy, d = BV.descriptor(p), list = saved(), i = list.indexOf(d);
  return `<div class="head"><span>OWNERS</span></div>
    ${renderPaths()}
    <p class="small" style="padding:12px 8px">Rules are part of the address, so they cannot change. Different owners or a different threshold means a new vault, and sending the coins to it.</p>
    <div class="head"><span>BACKUP</span></div>
    <div class="mono" style="font-size:11px;font-weight:400;padding:12px 8px">${esc(d)}</div>
    <div class="btns"><button class="btn btn-fill btn-sm" data-act="download">DOWNLOAD BACKUP</button><button class="btn btn-ghost btn-sm" data-act="copy-descriptor">COPY DESCRIPTOR</button><button class="btn btn-ghost btn-sm" data-act="copy-policy">COPY WALLET POLICY</button><button class="btn btn-ghost btn-sm" data-act="copy-link">COPY LINK</button></div>
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
      ${v.owners.map(o => `<div class="oln"><span class="tick" aria-hidden="true">${have.has(o) ? '✓' : '○'}</span><span>${esc(short(o))}</span><span style="margin-left:auto">${have.has(o) ? 'READY' : 'WAITING'}</span></div>`).join('')}
      <label class="lbl" for="owners">OWNER HANDLES <span class="dim">each owner connects once and shares theirs</span></label>
      <textarea class="inp" id="owners" data-field="owners" spellcheck="false">${esc(f.owners)}</textarea>
      ${S.owner ? '<div class="btns" style="margin-top:8px"><button class="btn btn-ghost btn-sm" data-act="add-me">+ ADD ME</button></div>' : ''}` : ''}`;
}

function renderOverlay(){
  if(S.ovl === 'connect') return `<div class="ovl" data-act="close-bg"><div class="ovl-card" role="dialog" aria-modal="true" aria-label="Connect">
    <div class="ovl-head"><span>CONNECT AN OWNER KEY</span><button class="x-btn" data-act="close" aria-label="Close">✕</button></div>
    <p class="small">An Ethereum wallet cannot sign for Bitcoin directly, so it signs a message and your Bitcoin key is derived from that signature. Same wallet, same key, on any device. Expect three prompts.</p>
    <div class="note warn"><b>The key sits in this page while you use it,</b> so a hardware wallet protects the derivation, not each spend. Any site that gets you to sign the same text gets this key. It clears after 15 idle minutes or a reload.</div>
    <button class="btn btn-fill btn-w" data-act="connect">CONNECT WALLET</button>
    <p class="small" style="margin-top:14px">On a hardware wallet? Skip this. Paste your <span class="lk">[fingerprint/path]xpub</span> as an owner, and sign each PSBT in your wallet.</p>
  </div></div>`;
  if(S.ovl === 'me' && S.owner) return `<div class="ovl" data-act="close-bg"><div class="ovl-card" role="dialog" aria-modal="true" aria-label="Your owner key">
    <div class="ovl-head"><span>YOUR OWNER KEY</span><button class="x-btn" data-act="close" aria-label="Close">✕</button></div>
    <p class="small">Share this with whoever is creating a vault. It is public, and it cannot move funds.</p>
    <div class="mono" style="font-size:11px;font-weight:400;margin:12px 0">${esc(myHandle())}</div>
    <button class="btn btn-fill btn-w" data-act="copy-owner">COPY</button>
    <button class="btn btn-ghost btn-w" style="margin-top:8px" data-act="disconnect">FORGET KEY</button>
  </div></div>`;
  if(S.ovl === 'share' && S.review){
    const left = Math.max(S.review.threshold - S.review.signedAll.length, 0);
    return `<div class="ovl" data-act="close-bg"><div class="ovl-card" role="dialog" aria-modal="true" aria-label="Share proposal">
    <div class="ovl-head"><span>${left ? `${left} MORE SIGNATURE${left > 1 ? 'S' : ''} NEEDED` : 'SHARE'}</span><button class="x-btn" data-act="close" aria-label="Close">✕</button></div>
    <p class="small">The link carries the proposal and your signature. It reaches no server. Send it to a co-signer, who adds theirs and sends it on.</p>
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
      <div class="footer"><span>BITCOIN · ${S.network === 'mainnet' ? 'MAINNET' : 'SIGNET'}${S.tip ? ` · BLOCK ${S.tip}` : ''}</span><span><a href="./docs.html">DOCS</a></span></div>
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
  Object.assign(S, { network, view: 'dash', ovl: null, policy: null, psbt: null, review: null, msg: null, coins: null, tip: null });
  lsSet('ms_btc_net', network);
  syncHash();
  const first = saved()[0];
  if(first) return open(BV.parseDescriptor(first, network));
}

const ACT = {
  connect, propose, sign, merge, broadcast, download,
  refresh(){ scanned = refresh(); },
  theme(){ S.dark = !S.dark; lsSet('ms_light', S.dark ? '' : '1'); },
  wallet(){ S.ovl = S.owner ? 'me' : 'connect'; },
  disconnect(){ forget(); S.ovl = null; },
  close(){ S.ovl = null; },
  'close-bg'(el, e){ if(e.target === el) S.ovl = null; },
  ovl(el){ S.ovl = el.dataset.o; },
  dismiss(){ S.msg = null; },
  view(el){ S.view = el.dataset.v; S.msg = null; S.form.rename = undefined; },
  trust(){ remember(S.policy); S.trusted = true; },
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
  'add-me'(){ const f = S.form, me = myHandle(); if(!f.owners.includes(me)) f.owners = (f.owners.trim() + '\n' + me).trim(); },
  compose(){ S.compose = !S.compose; S.msg = null; },
  max(){ S.form.amt = 'all'; },
  tier(el){ S.form.rate = String(feeOf(el.dataset.t)); },
  path(el){ S.form.path = el.dataset.p; },
  // Sending coins to the vault's own next address is how their clock restarts.
  reset(){ Object.assign(S.form, { to: BV.vaultOf(S.policy, 0, S.receive).address, amt: 'all', path: '0' }); S.compose = true; },
  paste(){ load(S.form.paste.trim()); S.form.paste = ''; },
  discard(){ Object.assign(S, { psbt: null, review: null }); syncHash(); },
  rename(){ const v = (S.form.rename ?? '').trim(); if(v){ setNote('names', curDesc(), v.slice(0, 24).toUpperCase().replace(/\s+/g, '_')); toast('SAVED'); } },
  remove(){
    if(!window.confirm('Remove this vault from this browser? The coins are not touched, but you will need its backup to open it again.')) return;
    const d = curDesc();
    lsSet(`ms_btc_vaults_${S.network}`, JSON.stringify(rawSaved().filter(x => x !== d)));
    Object.assign(S, { policy: null, view: 'dash', psbt: null, review: null, coins: null });
    syncHash();
    const first = saved()[0];
    if(first) return open(BV.parseDescriptor(first, S.network));
  },
  'copy-owner'(){ return copy(myHandle(), 'HANDLE COPIED'); },
  'copy-address'(){ return copy(BV.vaultOf(S.policy, 0, S.receive).address, 'ADDRESS COPIED'); },
  async 'copy-descriptor'(){ await copy(BV.descriptor(S.policy), 'DESCRIPTOR COPIED'); setNote('backup', curDesc(), 1); },
  'copy-policy'(){ return copy(JSON.stringify(BV.walletPolicy(S.policy), null, 2), 'POLICY COPIED'); },
  'copy-psbt'(){ return copy(S.psbt, 'PSBT COPIED'); },
  'copy-link'(){ return copy(linkFor(), 'LINK COPIED'); },
};

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  touch();
  if(!el || S.busy) return;
  S.busy = true;
  try { await ACT[el.dataset.act](el, e); render(); }
  catch(err) { S.ovl = null; say(err?.message || String(err)); }
  finally { S.busy = false; }
});
document.addEventListener('input', e => {
  const k = e.target.dataset?.field;
  if(!k) return;
  S.form[k] = e.target.value;
  if(k === 'evmChain' || k === 'evmVault') S.mirror = null;
  // Only the create form reads itself back as it is typed in. The fee pills light up
  // from the rate, so that one field redraws too.
  if(S.view === 'create' || k === 'rate' || k === 'amt') render();
});
document.addEventListener('keydown', e => { if(e.key === 'Escape' && S.ovl){ S.ovl = null; render(); } });
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
  const first = saved()[0];
  if(first) return open(BV.parseDescriptor(first, S.network));
});

})();
