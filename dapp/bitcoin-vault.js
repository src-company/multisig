'use strict';
// One job: a new Bitcoin vault, in as few steps as it can be. Connect, name the owners,
// save the backup, get an address. All of it is free, because nothing is deployed. It
// shares its storage with bitcoin.html, so the vault made here is simply there,
// already trusted, when this page hands over.
//
// A key is only touched here for the moment it takes to make a public handle.

(function(){

const BV = window.BitcoinVault, BW = window.BitcoinWallets;
const $ = id => document.getElementById(id);
const _escMap = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, m => _escMap[m]);
const lsGet = k => { try { return localStorage.getItem(k); } catch(_) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch(_) {} };
const lsJson = (k, d) => { try { return JSON.parse(lsGet(k)) ?? d; } catch(_) { return d; } };
const short = s => s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
const BTC = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#F7931A"/><path fill="#FFF" d="M22.3 14.1c.3-2.1-1.3-3.2-3.5-4l.7-2.8-1.7-.4-.7 2.7-1.4-.3.7-2.8-1.7-.4-.7 2.8-1.1-.3-2.4-.6-.5 1.8s1.3.3 1.3.3c.7.2.8.6.8 1l-.8 3.2.2.1-.2-.1-1.1 4.5c-.1.2-.3.5-.8.4 0 0-1.3-.3-1.3-.3l-.9 2 2.3.6 1.2.3-.7 2.9 1.7.4.7-2.8 1.4.3-.7 2.8 1.7.4.7-2.9c2.9.6 5.1.3 6-2.3.8-2.1 0-3.3-1.6-4.1 1.1-.3 2-1.1 2.3-2.7zm-3.9 5.4c-.5 2.1-4.1 1-5.2.7l.9-3.7c1.2.3 4.9.9 4.3 3zm.5-5.4c-.5 1.9-3.4.9-4.4.7l.8-3.3c1 .2 4.1.7 3.6 2.6z"/></svg>`;
const TAC = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#0a0a0a"/><circle cx="16" cy="16" r="13" fill="none" stroke="#f4efe6" stroke-width="2.5"/><path d="M17.5 7L13 22.5Q13 25 18 24" fill="none" stroke="#f7931a" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11L21 11" stroke="#f7931a" stroke-width="2.4" stroke-linecap="round"/></svg>`;

const S = {
  network: 'mainnet', dark: !lsGet('ms_light'),
  me: null, busy: false, msg: null,
  // text is what was typed. owner is set once a row is a key that can go in the vault.
  rows: [{ text: '', owner: null, state: 'empty' }, { text: '', owner: null, state: 'empty' }],
  threshold: 2, name: '', policy: null, saved: false, step: 0,
  // True when this page was opened from someone's invite: the owners are theirs to set.
  invite: false, checked: false, recorded: false, confirming: false, unanswered: false,
};
let _t;
const toast = t => { $('toast').innerHTML = `<div class="toast">${esc(t)}</div>`; clearTimeout(_t); _t = setTimeout(() => { $('toast').innerHTML = ''; }, 1600); };
const evmWallets = new Map();
window.addEventListener('eip6963:announceProvider', e => {
  const { info, provider } = e.detail || {};
  // data: only, as in wallet.js: an announcement is whatever an extension chose to send.
  const icon = /^data:image\//.test(info?.icon || '') ? info.icon : null;
  if(info?.uuid && provider && !info.rdns?.startsWith('software.multisig.')) evmWallets.set(info.uuid, { name: String(info.name), provider, icon });
  if(document.getElementById('app').firstChild) render();
});

const filled = () => [...(S.me && !S.invite ? [{ owner: S.me.owner, state: 'ready' }] : []), ...S.rows.filter(r => r.text.trim())];

// An invite carries the draft itself: network, threshold and the owners' public
// addresses. So there is nothing to coordinate. Everyone holding it works out the same
// vault the moment every owner has connected, in a fragment no server ever sees.
function inviteLink(){
  const list = [...(S.me ? [S.me.evm] : []), ...S.rows.map(r => r.text.trim()).filter(Boolean)];
  const th = Math.min(S.threshold, Math.max(list.length, 1));
  return `${location.origin}${location.pathname}#join/${S.network}/${th}/${list.map(encodeURIComponent).join(',')}`;
}
// A link is a stranger's text. It is taken exactly or refused: a bad threshold defaulting
// to 1 would quietly be a vault any single owner can empty.
function readInvite(){
  const [kind, network, th, list] = location.hash.slice(1).split('/');
  if(kind !== 'join') return false;
  try {
    const owners = list.split(',').map(decodeURIComponent).filter(Boolean);
    if(!Object.hasOwn(BV.NETWORKS, network) || !/^[1-9]\d*$/.test(th) || +th > owners.length || owners.length > BV.MAX_OWNERS || new Set(owners.map(o => o.toLowerCase())).size !== owners.length) throw new Error();
    S.network = network;
    S.threshold = +th;
    S.rows = owners.map(text => ({ text, owner: null, state: 'checking' }));
    S.invite = true;
    return true;
  } catch(_) {
    S.msg = 'That invite link is not valid. Ask for a new one.';
    return false;
  }
}
// An owner's own row is theirs the moment they connect, whichever way they did.
function takeSeat(){
  const me = S.me, row = S.rows.find(r => r.text.toLowerCase() === me.evm || r.text === me.wallet);
  if(row) Object.assign(row, { owner: me.owner, handle: me.handle, state: 'ready', mine: true, error: null });
  return !!row;
}
const total = () => filled().length;
const allReady = () => total() > 0 && filled().every(r => r.state === 'ready');

// Whatever was typed, turned into a key if that can be done now. 0x and bc1 addresses
// cannot be worked out, so they are looked up, and wait if that owner has not connected.
async function resolve(row){
  const t = row.text.trim();
  Object.assign(row, { owner: null, error: null });
  if(!t) return void (row.state = 'empty');
  try {
    if(/^0x[0-9a-fA-F]{40}$/.test(t)){
      const [h] = await BV.fetchHandles(S.network, [t]);
      if(h) Object.assign(row, { owner: BV.decodeOwner(h, S.network), handle: h, state: 'ready' }); else row.state = 'waiting';
    } else if(/^(bc1|tb1)[a-z0-9]{20,}$/i.test(t)){
      const f = await BV.handleForWallet(S.network, t);
      if(f) Object.assign(row, { owner: BV.decodeOwner(f.handle, S.network), handle: f.handle, state: 'ready' }); else row.state = 'waiting';
    } else Object.assign(row, { owner: BV.decodeOwner(t, S.network), handle: t, state: 'ready' });
  } catch(e) { Object.assign(row, { state: 'bad', error: e.message }); }
  // One key cannot take two seats. Said here, not as an error on the last step.
  const taken = [...(S.me ? [S.me.owner.xpub] : []), ...S.rows.filter(r => r !== row).map(r => r.owner?.xpub)];
  if(row.owner && taken.includes(row.owner.xpub) && !row.mine) Object.assign(row, { owner: null, state: 'bad', error: 'That owner is already on this vault.' });
}

function statusOf(r){
  return { ready: '<span class="st ok">READY</span>', waiting: '<span class="st">WAITING</span>', bad: '<span class="st bad">NOT VALID</span>', empty: '', checking: '<span class="st">…</span>' }[r.state] || '';
}

async function create(){
  const keys = filled().map(r => r.owner);
  const policy = BV.policyOf({ network: S.network, paths: [{ threshold: Math.min(S.threshold, keys.length), keys }] });
  S.policy = policy;
  const d = BV.descriptor(S.policy), k = `ms_btc_vaults_${S.network}`, list = lsJson(k, []);
  if(Array.isArray(list) && !list.includes(d)){ list.unshift(d); lsSet(k, JSON.stringify(list)); }
  if(S.name.trim()){
    const nk = `ms_btc_names_${S.network}`, n = lsJson(nk, {});
    n[d] = S.name.trim().slice(0, 24).toUpperCase().replace(/\s+/g, '_');
    lsSet(nk, JSON.stringify(n));
  }
  // On the owner's own record, so any device finds it. The key was only kept this long
  // for that. Without a connected wallet there is no record, and the file is the backup.
  if(S.me?.signer){
    const handles = [S.me.handle, ...S.rows.map(r => r.handle).filter(Boolean)];
    try {
      await BV.saveVault(S.policy, S.me.signer, S.me.handle, handles);
      S.recorded = true;
      const bk = `ms_btc_backup_${S.network}`, m = lsJson(bk, {}); m[d] = 1; lsSet(bk, JSON.stringify(m));
    } catch(_) {}
    wipe();
  }
}

function backup(){
  const p = S.policy, d = BV.descriptor(p);
  const text = [`MULTISIG BITCOIN VAULT BACKUP (${S.network})`, '',
    'Keep this. Bitcoin keeps no record of who owns this vault: without this text the',
    'coins cannot be spent, even with every key. It holds no private key.', '',
    `Rule: ${p.paths[0].threshold} of ${p.paths[0].keys.length}`, '', 'Descriptor:', d, '',
    'BIP-388 wallet policy:', JSON.stringify(BV.walletPolicy(p), null, 2), '', BV.recoveryText(S.network), ''].join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' })), a = document.createElement('a');
  a.href = url; a.download = `multisig-${S.network}-vault.txt`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const bk = `ms_btc_backup_${S.network}`, m = lsJson(bk, {}); m[d] = 1; lsSet(bk, JSON.stringify(m));
  S.saved = true;
}

// Line icons, one to a step. Drawn inline: this page's CSP loads nothing else.
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  connect: svg('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12.5h2M3 10h18"/>'),
  owners: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.6.8 2.7 2.5 3 5.2"/>'),
  backup: svg('<path d="M12 3l8 3v6c0 4.5-3.2 7.6-8 9-4.8-1.4-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'),
  receive: svg('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M4 20h16"/>'),
};
const STEPS = [['connect', 'CONNECT'], ['owners', 'OWNERS'], ['backup', 'BACK UP'], ['receive', 'RECEIVE']];

function renderFlow(){
  return `<ol class="flow">${STEPS.map(([k, l], i) => {
    const state = i < S.step ? 'done' : i === S.step ? 'now' : '';
    const back = i < S.step && !S.policy;
    return `<li class="${state}"><button data-act="go" data-s="${i}"${back ? '' : ' disabled'}${i === S.step ? ' aria-current="step"' : ''}><span class="ic">${ICONS[k]}</span><span class="t">${l}</span></button></li>`;
  }).join('')}</ol>`;
}

function renderConfirm(){
  return `<h2>One last signature</h2><p class="lead">This checks your wallet makes the same key every time, so your seat can't be lost. It only happens once.</p>
    ${S.progress ? `<div class="connecting" role="status">${esc(S.progress)}<button class="btn line" data-act="cancelconnect">CANCEL</button></div>` : `<button class="btn fill w" data-act="finish">CONFIRM</button>`}
    ${S.unanswered && !S.progress ? '<button class="link" data-act="skipcheck">My wallet will not show this. Continue without the check</button>' : ''}`;
}

function renderConnect(){
  if(S.confirming) return renderConfirm();
  const btc = BW.detect(), evm = [...evmWallets];
  const opt = (w, name, icon) => `<button class="wal" data-act="connect" data-w="${esc(w)}"${S.busy ? ' disabled' : ''}>${icon || ICONS.connect}<span>${esc(name)}</span></button>`;
  if(S.progress) return `<h2>Connect a wallet</h2><div class="connecting" role="status">${esc(S.progress)}<button class="btn line" data-act="cancelconnect">CANCEL</button></div>`;
  return `<h2>${S.invite ? 'You are invited to a Bitcoin vault' : 'Connect a wallet'}</h2><p class="lead">${S.invite ? 'Connect the wallet you were invited with to take your seat. ' : ''}Free. No transaction.</p>
    <div class="wals">${btc.map(w => opt(`btc:${w.key}`, w.name, BTC)).join('')}
    ${evm.map(([k, w]) => opt(k, w.name, w.icon ? `<img src="${esc(w.icon)}" alt="">` : '')).join('')}
    ${!evm.length && window.ethereum ? opt('eth', 'Browser wallet') : ''}
    ${opt('wc', 'WalletConnect')}</div>
    ${S.invite ? '' : '<button class="link" data-act="skip">Using a hardware wallet? Skip</button>'}`;
}

function renderOwners(){
  const n = total(), th = Math.min(S.threshold, Math.max(n, 1));
  const risk = n > 1 && th === n ? 'One lost key freezes the coins.' : n > 1 && th === 1 ? 'Any one owner can spend alone.' : null;
  const waiting = filled().some(r => r.state === 'waiting');
  if(S.invite){
    // Whoever sent this chose every line of it. A vault someone hands you can be one they
    // alone control, so the rule is said plainly and nothing is saved until it is checked.
    const rows = S.rows.map(r => `<div class="row"><span class="n">${ICONS.owners}</span><span class="inp full">${esc(r.text)}</span>${r.mine ? '<span class="st ok">YOU</span>' : statusOf(r)}</div>`).join('');
    const seated = S.rows.some(r => r.mine), others = n - (seated ? 1 : 0);
    const warn = th === 1 && n > 1 ? 'Any one owner can spend everything alone.' : others >= th ? `The other ${others === 1 ? 'owner' : `${others} owners`} can spend without you.` : null;
    return `<h2>${seated ? 'You are in' : 'You are invited'}</h2><p class="lead"><strong>${th} of ${n}</strong> must sign. ${waiting ? 'Waiting for the others. This updates by itself.' : 'Every owner is ready.'}</p>
      ${rows}
      ${S.me && !seated ? '<div class="note bad">This wallet is not one of the owners on this invite. Connect the one that is.</div>' : ''}
      ${warn ? `<div class="note">${warn}</div>` : ''}
      <button class="tick" data-act="confirm" aria-pressed="${S.checked}"><span>${S.checked ? '✓' : ''}</span>I know every owner above, and this is the rule I agreed to</button>
      <button class="btn fill w" data-act="next"${allReady() && seated && S.checked ? '' : ' disabled'}>CONTINUE</button>`;
  }
  return `<h2>Add owners</h2><p class="lead">A 0x address, a Bitcoin address, or an xpub.</p>
    ${S.me ? `<div class="row"><span class="n">${ICONS.owners}</span><span class="inp">${esc(S.me.label)}</span><span class="st ok">YOU</span></div>` : ''}
    ${S.rows.map((r, i) => `<div class="row"><span class="n">${ICONS.owners}</span><input class="inp" id="o${i}" data-row="${i}" aria-label="Owner" spellcheck="false" autocomplete="off" placeholder="${S.network === 'mainnet' ? '0x… or bc1…' : '0x… or tb1…'}" value="${esc(r.text)}">${statusOf(r)}${S.rows.length > 1 ? `<button class="x" data-act="drop" data-i="${i}" aria-label="Remove">✕</button>` : ''}</div>${r.error ? `<div class="st bad" style="padding:4px 0">${esc(r.error)}</div>` : ''}`).join('')}
    <div class="btns"><button class="link" data-act="add">+ Add owner</button></div>
    ${waiting ? `<div class="wait">Send your co-owners this link. They connect once, and this updates by itself.<div class="btns"><button class="btn fill" data-act="invite">COPY INVITE LINK</button></div></div>` : ''}
    ${n > 1 ? `<div class="th"><div class="stepper"><button data-act="th" data-d="-1" aria-label="Fewer">−</button><output>${th} OF ${n}</output><button data-act="th" data-d="1" aria-label="More">+</button></div><span>must sign</span></div>` : ''}
    ${risk ? `<div class="note">${risk}</div>` : ''}
    <button class="btn fill w" data-act="next"${allReady() ? '' : ' disabled'}>CONTINUE</button>`;
}

function renderBackup(){
  const name = `<input class="inp boxed" id="name" data-name="1" aria-label="Vault name" maxlength="24" placeholder="Vault name (optional)" autocomplete="off" value="${esc(S.name)}">`;
  if(S.progress) return `<h2>One moment</h2><div class="connecting" role="status">${esc(S.progress)}<button class="btn line" data-act="cancelconnect">CANCEL</button></div>`;
  if(S.me?.signer) return `<h2>Name your vault</h2><p class="lead">It stays on your wallet's record, so connecting on any device finds it.</p>${name}
    <button class="btn fill w" data-act="make">CREATE VAULT</button>`;
  return `<h2>Save your backup</h2><p class="lead">Without this file the coins can't be spent, even with every key. It holds no private key.</p>${name}
    <button class="btn fill w" data-act="backup">CREATE AND SAVE</button>`;
}

function renderReceive(){
  // With no record and no file, an address here could take coins nothing can spend.
  if(!S.recorded && !S.saved) return `<h2>Save your backup</h2><p class="lead">This vault could not be saved to your wallet, so this file is its only record.</p><button class="btn fill w" data-act="savefile">DOWNLOAD BACKUP</button>`;
  const a = BV.vaultOf(S.policy).address;
  return `<h2>Your vault is ready</h2><p class="lead">Send sats here to fund it.</p>
    <div class="qr" role="img" aria-label="QR code of the address">${window.btc.encodeQR(a.toUpperCase(), 'svg')}</div>
    <div class="addr">${esc(a)}</div>
    <div class="btns center"><button class="btn line" data-act="copy">COPY ADDRESS</button><button class="btn line" data-act="vaultlink">COPY VAULT LINK</button>${S.network === 'signet' ? '<a class="btn line asbtn" href="https://faucet.coinbin.org" target="_blank" rel="noopener">GET TEST COINS ↗</a>' : ''}</div>
    ${S.recorded && !S.saved ? '<div class="note ok">Saved to your wallet, so connecting on any device finds it. Keep a backup too: it works if this site is ever gone. <button class="link" data-act="savefile">Download backup</button></div>' : ''}
    <div class="note">Sats only. Tacit assets sent here are set aside, and this vault cannot move them.</div>
    <a class="btn go w" href="./bitcoin.html#${S.network}/${encodeURIComponent(BV.descriptor(S.policy))}">OPEN VAULT</a>`;
}

function render(){
  document.body.classList.toggle('light', !S.dark);
  const el = document.activeElement, id = el?.id, at = el?.selectionStart;
  const pane = [renderConnect, renderOwners, renderBackup, renderReceive][S.step];
  $('app').innerHTML = `<div class="frame">
    <div class="hbar" aria-hidden="true">${'/'.repeat(120)}</div>
    <div class="hdr"><div class="logo"><a href="./index.html">MULTISIG</a></div>
      <div class="pills"><button class="theme" data-act="theme" aria-label="Switch to ${S.dark ? 'light' : 'dark'} theme">${S.dark ? '☀' : '☾'}</button>${['mainnet', 'signet'].map(k => `<button class="pill${k === S.network ? ' on' : ''}" data-act="net" data-n="${k}"${k === S.network ? ' aria-current="true"' : ''}${S.policy ? ' disabled' : ''}>${k.toUpperCase()}</button>`).join('')}</div></div>
    <div class="hero"><div class="marks"><span class="mark">${BTC}</span><span class="mark">${TAC}</span></div>
      <h1>Bitcoin multisig</h1><div class="free">FREE · NOTHING TO DEPLOY</div></div>
    ${renderFlow()}
    ${S.msg ? `<div class="note bad" role="status">${esc(S.msg)}</div>` : ''}
    <section class="pane">${pane()}</section>
    <div class="foot"><a href="./index.html">ETHEREUM AND L2 ↗</a><a href="./bitcoin.html">MY VAULTS</a></div>
  </div>`;
  if(id && $(id)){ $(id).focus(); if(at != null) try { $(id).setSelectionRange(at, at); } catch(_) {} }
}

// A key kept for the save is still a key in an open tab, and someone waiting on a friend
// may leave one open for days. After this long it goes, and the file becomes the record.
const IDLE_MS = 15 * 60 * 1000;
const wipe = () => { S.me?.signer?.wipePrivateData(); if(S.me) S.me.signer = null; };
let _idle;
const touch = () => { clearTimeout(_idle); if(S.me?.signer) _idle = setTimeout(() => { wipe(); render(); }, IDLE_MS); };
const onStep = (n, of) => { S.progress = `Approve ${n} of ${of} in your wallet`; render(); };

function afterConnect(){
  S.confirming = false;
  S.step = 1;
  if(S.invite){ takeSeat(); if(!S.rows.some(r => r.mine)) wipe(); }
}

async function finish(skip){
  S.progress = 'Approve in your wallet';
  render();
  try {
    const published = await S.me.finish({ skip });
    afterConnect();
    // Others find an owner through this, so a failed save is worth saying.
    if(!published) S.msg = 'Connected, but your key could not be published. Co-owners will see you as WAITING. Reconnect to try again.';
  } catch(e) {
    if(e.mismatch){ wipe(); S.me = null; S.confirming = false; throw e; }
    S.unanswered = true;
    throw e;
  }
}

const ACT = {
  finish(){ return finish(false); },
  skipcheck(){ return finish(true); },
  theme(){ S.dark = !S.dark; lsSet('ms_light', S.dark ? '' : '1'); },
  skip(){ S.step = 1; },
  confirm(){ S.checked = !S.checked; },
  next(){ S.step = 2; },
  go(el){ S.step = +el.dataset.s; if(S.step === 0){ wipe(); S.me = null; } },
  async connect(el){
    const w = el.dataset.w;
    if(window.top !== window || window.opener) throw new Error('Open this page in its own tab to use a key.');
    if(/^\/ip[fn]s\//.test(location.pathname)) throw new Error('Open this page from its own domain to use a key.');
    if(w.startsWith('btc:')){
      const wallet = BW.detect().find(x => x.key === w.slice(4)), key = await BW.connectWallet(wallet, S.network, onStep);
      key.evmPriv.fill(0);
      S.me = { signer: key.signer, repeats: key.repeats, finish: key.finish, owner: key.owner, handle: key.handle, evm: key.evm, wallet: key.address, published: key.published, label: `${wallet.name} ${short(key.address)}` };
    } else {
      const eth = w === 'wc' ? await BW.walletConnect() : w === 'eth' ? window.ethereum : evmWallets.get(w).provider;
      S.me = await BW.connectEvmForHandle(eth, S.network, { onStep, keep: true });
    }
    if(S.me.repeats) return afterConnect();
    S.confirming = true;
  },
  net(el){
    wipe();
    S.network = el.dataset.n; S.me = null; S.step = 0;
    S.rows.forEach(r => { r.owner = null; r.state = r.text.trim() ? 'checking' : 'empty'; });
    return ACT.check();
  },
  add(){ S.rows.push({ text: '', owner: null, state: 'empty' }); },
  drop(el){ S.rows.splice(+el.dataset.i, 1); },
  th(el){ const max = Math.max(total(), 1); S.threshold = Math.max(1, Math.min(max, Math.min(S.threshold, max) + +el.dataset.d)); },
  async check(){ await Promise.all(S.rows.filter(r => !r.mine).map(resolve)); },
  vaultlink(){ return navigator.clipboard.writeText(`${location.origin}${location.pathname.replace(/\/[^/]*$/, '/')}bitcoin.html#${S.network}/${encodeURIComponent(BV.descriptor(S.policy))}`).then(() => toast('LINK COPIED'), () => toast('THE BROWSER REFUSED THE CLIPBOARD')); },
  invite(){ return navigator.clipboard.writeText(inviteLink()).then(() => toast('LINK COPIED'), () => toast('THE BROWSER REFUSED THE CLIPBOARD')); },
  async backup(){ await create(); backup(); S.step = 3; },
  async make(){ await create(); S.step = 3; },
  savefile(){ backup(); },
  copy(){ return navigator.clipboard.writeText(BV.vaultOf(S.policy).address).then(() => toast('ADDRESS COPIED'), () => toast('THE BROWSER REFUSED THE CLIPBOARD')); },
};

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  // Past the busy lock on purpose: the lock is what a stuck wallet would be holding.
  if(el?.dataset.act === 'cancelconnect'){ BW.cancelPrompt(); return; }
  if(!el || el.disabled || S.busy) return;
  S.busy = true;
  S.msg = null;
  try { await ACT[el.dataset.act](el); }
  catch(err) { S.msg = err?.message || String(err); }
  S.busy = false;
  S.progress = null;
  touch();
  render();
});
let _typing;
document.addEventListener('input', e => {
  if(e.target.dataset.name){ S.name = e.target.value; return; }
  const i = e.target.dataset.row;
  if(i === undefined) return;
  const row = S.rows[+i];
  row.text = e.target.value;
  row.state = row.text.trim() ? 'checking' : 'empty';
  render();
  clearTimeout(_typing);
  _typing = setTimeout(async () => { await resolve(row); render(); }, 350);
});

// The address is /btc. Links stay btc.html, the only spelling an IPFS gateway resolves,
// so the page tidies the bar itself, on our own host only.
if(/(^|\.)multisig\.software$/.test(location.hostname) && location.pathname === '/btc.html'){
  try { history.replaceState(null, '', `/btc${location.search}${location.hash}`); } catch(_) {}
}
window.dispatchEvent(new Event('eip6963:requestProvider'));
const invited = readInvite();
render();
if(invited) ACT.check().then(render);
// Nobody should have to keep pressing a button to see a friend arrive.
setInterval(async () => {
  if(S.step !== 1 || S.busy || !filled().some(r => r.state === 'waiting')) return;
  await Promise.all(S.rows.filter(r => r.state === 'waiting').map(resolve));
  render();
}, 12000);

})();
