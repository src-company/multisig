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
  threshold: 2, name: '', policy: null, saved: false,
};
let _t;
const toast = t => { $('toast').innerHTML = `<div class="toast">${esc(t)}</div>`; clearTimeout(_t); _t = setTimeout(() => { $('toast').innerHTML = ''; }, 1600); };
const evmWallets = new Map();
window.addEventListener('eip6963:announceProvider', e => {
  const { info, provider } = e.detail || {};
  if(info?.uuid && provider && !info.rdns?.startsWith('software.multisig.')) evmWallets.set(info.uuid, { name: String(info.name), provider });
  if(document.getElementById('app').firstChild) render();
});

const filled = () => [...(S.me ? [{ owner: S.me.owner, state: 'ready' }] : []), ...S.rows.filter(r => r.text.trim())];
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
      if(h) Object.assign(row, { owner: BV.decodeOwner(h, S.network), state: 'ready' }); else row.state = 'waiting';
    } else if(/^(bc1|tb1)[a-z0-9]{20,}$/i.test(t)){
      const f = await BV.handleForWallet(S.network, t);
      if(f) Object.assign(row, { owner: BV.decodeOwner(f.handle, S.network), state: 'ready' }); else row.state = 'waiting';
    } else Object.assign(row, { owner: BV.decodeOwner(t, S.network), state: 'ready' });
  } catch(e) { Object.assign(row, { state: 'bad', error: e.message }); }
}

function statusOf(r){
  return { ready: '<span class="st ok">READY</span>', waiting: '<span class="st">WAITING</span>', bad: '<span class="st bad">NOT VALID</span>', empty: '', checking: '<span class="st">…</span>' }[r.state] || '';
}

function create(){
  const keys = filled().map(r => r.owner);
  S.policy = BV.policyOf({ network: S.network, paths: [{ threshold: Math.min(S.threshold, keys.length), keys }] });
  const d = BV.descriptor(S.policy), k = `ms_btc_vaults_${S.network}`, list = lsJson(k, []);
  if(Array.isArray(list) && !list.includes(d)){ list.unshift(d); lsSet(k, JSON.stringify(list)); }
  if(S.name.trim()){
    const nk = `ms_btc_names_${S.network}`, n = lsJson(nk, {});
    n[d] = S.name.trim().slice(0, 24).toUpperCase().replace(/\s+/g, '_');
    lsSet(nk, JSON.stringify(n));
  }
}

function backup(){
  const p = S.policy, d = BV.descriptor(p);
  const text = [`MULTISIG BITCOIN VAULT BACKUP (${S.network})`, '',
    'Keep this. Bitcoin keeps no record of who owns this vault: without this text the',
    'coins cannot be spent, even with every key. It holds no private key.', '',
    `Rule: ${p.paths[0].threshold} of ${p.paths[0].keys.length}`, '', 'Descriptor:', d, '',
    'BIP-388 wallet policy:', JSON.stringify(BV.walletPolicy(p), null, 2), ''].join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' })), a = document.createElement('a');
  a.href = url; a.download = `multisig-${S.network}-vault.txt`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const bk = `ms_btc_backup_${S.network}`, m = lsJson(bk, {}); m[d] = 1; lsSet(bk, JSON.stringify(m));
  S.saved = true;
}

function render(){
  document.body.classList.toggle('light', !S.dark);
  const el = document.activeElement, id = el?.id, at = el?.selectionStart;
  const n = total(), th = Math.min(S.threshold, Math.max(n, 1));
  const btc = BW.detect(), evm = [...evmWallets];
  const opt = (w, name, hint) => `<button class="opt" data-act="connect" data-w="${esc(w)}"${S.busy ? ' disabled' : ''}>${esc(name)}<span>${hint}</span></button>`;
  const stepOne = S.me ? `<p>Connected as <strong>${esc(S.me.label)}</strong>. Your public key is published so vaults you sit on can find it.</p>`
    : `<p>Your wallet signs a message, and your vault key comes from that signature. No transaction, no fee.</p>
      ${btc.map(w => opt(`btc:${w.key}`, w.name.toUpperCase(), 'BITCOIN')).join('')}
      ${evm.map(([k, w]) => opt(k, w.name.toUpperCase(), 'ETHEREUM')).join('')}
      ${!evm.length && window.ethereum ? opt('eth', 'BROWSER WALLET', 'ETHEREUM') : ''}
      ${opt('wc', 'WALLETCONNECT', 'ETHEREUM')}
      <p>On a hardware wallet? Skip this and paste your [fingerprint/path]xpub as an owner.</p>`;
  const risk = n > 1 && th === n ? 'If one owner loses their key, the coins are stuck for good.' : n > 1 && th === 1 ? 'Any one owner can spend alone.' : null;
  const waiting = filled().filter(r => r.state === 'waiting').length;
  const done = S.policy;
  $('app').innerHTML = `<div class="frame">
    <div class="hdr"><div class="logo"><a href="./index.html">MULTISIG</a></div>
      <div class="pills">${['mainnet', 'signet'].map(k => `<button class="pill${k === S.network ? ' on' : ''}" data-act="net" data-n="${k}"${done ? ' disabled' : ''}>${k === 'mainnet' ? 'BITCOIN' : 'SIGNET'}</button>`).join('')}</div></div>
    <div class="hero">
      <div class="marks"><span class="mark">${BTC}</span><span class="mark">${TAC}</span></div>
      <h1>A Bitcoin multisig,<br>from any wallet</h1>
      <div class="sub">Bring an Ethereum or a Bitcoin wallet. Several owners, one vault, and Bitcoin itself enforces the rule.</div>
      <div class="free">FREE · NOTHING TO DEPLOY</div>
    </div>
    ${S.msg ? `<div class="note bad" role="status">${esc(S.msg)}</div>` : ''}
    <section class="step"><h2><span>1</span>CONNECT${S.me ? '<span class="ok">DONE</span>' : ''}</h2>${stepOne}</section>
    <section class="step${done ? ' off' : ''}"><h2><span>2</span>OWNERS</h2>
      <p>Paste a 0x address, a Bitcoin address, or an xpub. Each owner connects here once, and shows READY when they have.</p>
      ${S.me ? `<div class="row"><span class="inp">${esc(S.me.label)} · YOU</span><span class="st ok">READY</span></div>` : ''}
      ${S.rows.map((r, i) => `<div class="row"><input class="inp" id="o${i}" data-row="${i}" aria-label="Owner" spellcheck="false" autocomplete="off" placeholder="0x…, ${S.network === 'mainnet' ? 'bc1' : 'tb1'}… or xpub" value="${esc(r.text)}"${done ? ' disabled' : ''}>${statusOf(r)}<button class="x" data-act="drop" data-i="${i}" aria-label="Remove">✕</button></div>${r.error ? `<div class="st bad" style="padding:4px 0">${esc(r.error)}</div>` : ''}`).join('')}
      <div class="btns"><button class="btn line" data-act="add"${done ? ' disabled' : ''}>+ ADD OWNER</button>${waiting ? '<button class="btn line" data-act="check">CHECK AGAIN</button><button class="btn line" data-act="invite">COPY INVITE LINK</button>' : ''}</div>
      <div><div class="stepper"><button data-act="th" data-d="-1" aria-label="Fewer"${done ? ' disabled' : ''}>−</button><output>${th} OF ${Math.max(n, 1)}</output><button data-act="th" data-d="1" aria-label="More"${done ? ' disabled' : ''}>+</button></div></div>
      ${risk ? `<div class="note">${risk}</div>` : ''}
    </section>
    <section class="step${allReady() || done ? '' : ' off'}"><h2><span>3</span>BACK UP${S.saved ? '<span class="ok">DONE</span>' : ''}</h2>
      <p>Bitcoin keeps no record of who owns a vault, so this file is what makes the coins spendable. It holds no private key. Every owner should have a copy.</p>
      <input class="inp" id="name" data-name="1" aria-label="Vault name" maxlength="24" placeholder="NAME THIS VAULT (OPTIONAL)" autocomplete="off" value="${esc(S.name)}" style="margin-top:10px;border-bottom:1px solid var(--ln)"${done ? ' disabled' : ''}>
      ${S.saved ? '' : `<button class="btn fill w" data-act="backup"${allReady() ? '' : ' disabled'}>CREATE AND SAVE BACKUP</button>`}
      ${allReady() || done ? '' : `<p style="font-size:10px;color:var(--d);margin-top:10px">${n ? 'Waiting on every owner.' : 'Connect, or add an owner.'}</p>`}
    </section>
    <section class="step${S.saved ? '' : ' off'}"><h2><span>4</span>RECEIVE</h2>
      ${S.saved ? (() => { const a = BV.vaultOf(S.policy).address; return `<div class="addr">${esc(a)}</div>
        <div class="qr" role="img" aria-label="QR code of the address">${window.btc.encodeQR(a.toUpperCase(), 'svg')}</div>
        <div class="btns"><button class="btn line" data-act="copy">COPY ADDRESS</button></div>
        <div class="note">Send sats only. Tacit assets that arrive are set aside and never spent as sats, but this vault cannot move them yet.</div>
        <a class="btn go w" href="./bitcoin.html#${S.network}/${encodeURIComponent(BV.descriptor(S.policy))}">OPEN VAULT</a>`; })() : '<p>Your vault address appears here. Sending to it is the first thing that happens on chain.</p>'}
    </section>
    <div class="foot"><a href="./index.html">ETHEREUM AND L2 ↗</a><a href="./bitcoin.html">MY VAULTS</a></div>
  </div>`;
  if(id && $(id)){ $(id).focus(); if(at != null) try { $(id).setSelectionRange(at, at); } catch(_) {} }
}

const ACT = {
  async connect(el){
    const w = el.dataset.w;
    if(window.top !== window || window.opener) throw new Error('Open this page in its own tab to use a key.');
    if(/^\/ip[fn]s\//.test(location.pathname)) throw new Error('Open this page from its own domain to use a key.');
    if(w.startsWith('btc:')){
      const wallet = BW.detect().find(x => x.key === w.slice(4)), key = await BW.connectWallet(wallet, S.network);
      key.signer.wipePrivateData(); key.evmPriv.fill(0);
      S.me = { owner: key.owner, handle: key.handle, label: `${wallet.name} ${short(key.address)}` };
    } else {
      const eth = w === 'wc' ? await BW.walletConnect() : w === 'eth' ? window.ethereum : evmWallets.get(w).provider;
      S.me = await BW.connectEvmForHandle(eth, S.network);
    }
  },
  net(el){
    S.network = el.dataset.n; S.me = null;
    S.rows.forEach(r => { r.owner = null; r.state = r.text.trim() ? 'checking' : 'empty'; });
    return ACT.check();
  },
  add(){ S.rows.push({ text: '', owner: null, state: 'empty' }); },
  drop(el){ S.rows.splice(+el.dataset.i, 1); },
  th(el){ const max = Math.max(total(), 1); S.threshold = Math.max(1, Math.min(max, Math.min(S.threshold, max) + +el.dataset.d)); },
  async check(){ await Promise.all(S.rows.map(resolve)); },
  invite(){ return navigator.clipboard.writeText(`${location.origin}${location.pathname}`).then(() => toast('LINK COPIED'), () => toast('THE BROWSER REFUSED THE CLIPBOARD')); },
  backup(){ create(); backup(); },
  copy(){ return navigator.clipboard.writeText(BV.vaultOf(S.policy).address).then(() => toast('ADDRESS COPIED'), () => toast('THE BROWSER REFUSED THE CLIPBOARD')); },
};

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if(!el || el.disabled || S.busy) return;
  S.busy = true;
  try { await ACT[el.dataset.act](el); S.msg = null; }
  catch(err) { S.msg = err?.message || String(err); }
  S.busy = false;
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

window.dispatchEvent(new Event('eip6963:requestProvider'));
render();

})();
