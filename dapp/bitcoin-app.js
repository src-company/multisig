'use strict';
// The Bitcoin page. Everything that decides anything is in bitcoin.js; this file
// holds the screen. There is no server behind it: vaults are descriptors kept in
// this browser and in links, and a proposal moves between owners as a PSBT in a
// link fragment, which never reaches a web server's log.

(function(){

const BV = window.BitcoinVault;
const $ = id => document.getElementById(id);
const _escMap = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, m => _escMap[m]);
const lsGet = k => { try { return localStorage.getItem(k); } catch(_) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch(_) {} };
const btcOf = sats => (sats / 1e8).toFixed(8);
const short = s => s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s;
const days = blocks => { const d = blocks / 144; return d < 2 ? `about ${Math.round(blocks / 6)} hours` : `about ${Math.round(d)} days`; };

// bitcoin.js is network-agnostic, so this is the one switch. Turning it off stops new
// use of mainnet from this page. It moves no one's coins, and any descriptor tool can
// still spend them.
const MAINNET = true;
// A key left in an open tab is a key at risk for no benefit.
const IDLE_MS = 15 * 60 * 1000;

const S = {
  network: MAINNET && lsGet('ms_btc_net') === 'mainnet' ? 'mainnet' : 'signet',
  // The key lives here and nowhere else, for this tab's lifetime. It is never
  // written down, so a reload asks the wallet again.
  owner: null,       // { signer, xpub, fingerprint, path, evm }
  view: 'home',      // home | new | vault
  policy: null, trusted: false,
  coins: null, tip: null, feeRate: null, receive: 0, change: 0,
  psbt: null, review: null,
  mirror: null,
  form: { kind: 'plain', evmChain: '1', evmVault: '', owners: '', threshold: '2', second: '', secondThreshold: '1', older: '4320' },
  msg: null, busy: false,
};
const myHandle = () => BV.encodeOwner({ network: S.network, ...S.owner });
function forget(){ if(S.owner){ S.owner.signer.wipePrivateData(); S.owner = null; } }
const known = () => S.coins ? { receive: S.receive, change: S.change } : undefined;
let idle;
const touch = () => { clearTimeout(idle); if(S.owner) idle = setTimeout(() => { forget(); render(); }, IDLE_MS); };
const say = (text, kind = 'bad') => { S.msg = { text, kind }; render(); };

// A saved vault this version cannot read is left off the list, not fatal to the page.
function saved(){
  let list = [];
  try { list = JSON.parse(lsGet(`ms_btc_vaults_${S.network}`) || '[]'); } catch(_) {}
  return list.filter(d => { try { return !!BV.parseDescriptor(d, S.network); } catch(_) { return false; } });
}
function remember(policy){
  const d = BV.descriptor(policy), list = saved();
  if(!list.includes(d)){ list.unshift(d); lsSet(`ms_btc_vaults_${S.network}`, JSON.stringify(list)); }
}

// ── OWNER KEY ──────────────────────────────────────────────
async function connect(){
  // A path gateway gives every site on it this same origin, and the key would be
  // within their reach.
  if(/^\/ip[fn]s\//.test(location.pathname)) throw new Error('Open this page from its own domain to use a key. This address shares its origin with other sites.');
  const eth = window.ethereum;
  if(!eth) return say('No Ethereum wallet in this browser. Install one, or take part from a tool that signs PSBTs.');
  const [evm] = await eth.request({ method: 'eth_requestAccounts' });
  const hexMsg = m => '0x' + window.btc.hex.encode(new TextEncoder().encode(m));
  const key = await BV.deriveOwnerKey(m => eth.request({ method: 'personal_sign', params: [hexMsg(m), evm] }), S.network);
  // A third signature, but a harmless one: this is the one that gets published, and
  // it is what lets an owner's handle count towards a vault mirrored from Ethereum.
  const proof = await eth.request({ method: 'personal_sign', params: [hexMsg(BV.bindingMessage(S.network, key.owner)), evm] });
  forget();
  S.owner = { ...key.owner, signer: key.signer, evm: evm.toLowerCase(), proof };
  S.msg = null;
  touch();
}

// ── VAULTS ─────────────────────────────────────────────────
const parseOwners = text => text.split(/[\s,]+/).filter(Boolean).map(t => BV.decodeOwner(t, S.network));

async function readMirror(){
  const v = await BV.readEvmVault(+S.form.evmChain, S.form.evmVault.trim());
  S.mirror = v;
  S.msg = null;
}

function createVault(){
  if(S.form.kind === 'mirror'){
    if(!S.mirror) throw new Error('Read the Ethereum vault first.');
    const { missing, policy } = BV.mirror({ network: S.network, vault: S.mirror, handles: S.form.owners.split(/\s+/).filter(Boolean) });
    if(missing.length) throw new Error(`Still waiting on ${missing.length} of ${S.mirror.owners.length} owners.`);
    return open(policy);
  }
  const f = S.form, keys = parseOwners(f.owners), threshold = +f.threshold;
  const paths = [{ threshold, keys }];
  if(f.kind === 'recovery') paths.push({ threshold: +f.secondThreshold, keys: parseOwners(f.second), older: +f.older });
  // The hold preset is the same two leaves the other way up: everyone at once, or
  // the quorum once a coin has aged.
  if(f.kind === 'hold'){
    paths[0] = { threshold: keys.length, keys };
    paths.push({ threshold, keys, older: +f.older });
  }
  return open(BV.policyOf({ network: S.network, paths }));
}

// A vault that arrives in a link is not yet this person's vault. It could be anyone's
// keys under the words "our vault", so it is not saved, and its address is not shown
// to be paid until they have looked at the owners and said so.
async function open(policy, fromLink = false){
  const trusted = !fromLink || saved().includes(BV.descriptor(policy));
  if(trusted) remember(policy);
  Object.assign(S, { policy, trusted, view: 'vault', coins: null, tip: null, psbt: null, review: null, msg: null });
  syncHash();
  render();
  await refresh();
}

// Numbered, because a slow scan of the last vault must not land on this one.
let scanning = 0;
async function refresh(){
  const c = BV.chain(S.network), run = ++scanning;
  try {
    const [found, tip, fees] = await Promise.all([BV.scan(S.policy, c), c.tip(), c.fees().catch(() => ({}))]);
    if(run !== scanning) return;
    Object.assign(S, { coins: found.coins, receive: found.receive, change: found.change, tip, feeRate: Math.max(1, Math.ceil(fees['3'] || 1)) });
    render();
  } catch(e) { if(run === scanning) say(`Could not read the chain: ${e.message}`); }
}

// A vault link carries everything a co-signer needs, proposal included, and the
// browser sends none of a fragment anywhere.
function linkFor(){
  const d = encodeURIComponent(BV.descriptor(S.policy));
  return `${location.origin}${location.pathname}#${S.network}/${d}${S.psbt ? '/' + encodeURIComponent(S.psbt) : ''}`;
}
function syncHash(){ try { history.replaceState(null, '', linkFor()); } catch(_) {} }

async function readHash(){
  const [network, d, psbt] = location.hash.slice(1).split('/');
  if(!d || !BV.NETWORKS[network]) return;
  if(network === 'mainnet' && !MAINNET) return say('Mainnet is not open yet. This page works on signet.');
  try {
    const next = decodeURIComponent(d), proposal = psbt ? decodeURIComponent(psbt) : null;
    // Another tab that opened this one can change its fragment. A proposal someone is
    // reading does not get replaced underneath them without asking.
    if(S.psbt && S.psbt !== proposal && !window.confirm('This link replaces the proposal on screen. Continue?')) return syncHash();
    const policy = BV.parseDescriptor(next, network);
    // A key is per network, so a link to the other one does not carry it across.
    if(network !== S.network){ forget(); S.network = network; }
    await open(policy, true);
    if(proposal){ load(proposal); render(); }
  } catch(e) { say(e.message); }
}

// ── PROPOSALS ──────────────────────────────────────────────
function load(psbt){
  S.review = BV.inspect(psbt, S.policy, known());
  S.psbt = psbt;
  S.msg = null;
  syncHash();
}

function propose(){
  const addr = $('to').value.trim(), amt = $('amt').value.trim(), feeRate = +$('rate').value, path = +$('path').value;
  const args = { policy: S.policy, utxos: S.coins || [], tip: S.tip, feeRate, path, change: S.change };
  if(amt.toLowerCase() === 'all') args.sweep = addr;
  else {
    if(!/^\d+(\.\d{1,8})?$/.test(amt)) throw new Error('amount is in BTC, up to 8 places, or "all"');
    const [whole, frac = ''] = amt.split('.');
    args.outputs = [{ address: addr, sats: Number(BigInt(whole) * 100000000n + BigInt(frac.padEnd(8, '0'))) }];
  }
  load(BV.propose(args));
}

function sign(){
  if(!S.owner) throw new Error('Connect first: nothing here can sign without your owner key.');
  load(BV.sign(S.psbt, S.owner.signer, S.policy, known()));
  touch();
}

function merge(){
  const more = $('merge').value.trim();
  if(more) load(BV.combine([S.psbt, more], S.policy));
}

async function broadcast(){
  const c = BV.chain(S.network);
  // A coin spent since this was proposed makes the whole proposal void. Say that,
  // rather than show a node's refusal.
  for(const i of S.review.inputs) if(await c.spent(i.txid, i.vout)) throw new Error('A coin in this proposal has already been spent. It is void; propose again.');
  const txid = await c.broadcast(BV.finalize(S.psbt, S.policy));
  Object.assign(S, { psbt: null, review: null });
  syncHash();
  S.msg = { text: `Sent: ${txid}`, kind: 'ok', href: `${BV.NETWORKS[S.network].explorer}/tx/${txid}` };
  await refresh();
}

// ── SCREEN ─────────────────────────────────────────────────
function renderOwner(){
  if(!S.owner) return `<section class="sec"><h2>Your owner key</h2>
    <p>On Bitcoin an owner is a public key, so your wallet signs one message and your key is derived from the signature. Same wallet, same key, on any device.</p>
    <div class="note warn">This key is held in this page while you use it, so a hardware wallet protects only the derivation, not each Bitcoin spend. Any site that gets you to sign the same text gets this key. A vault that needs two owners survives one of those; a 1-of-n vault does not.</div>
    <button class="btn fill" data-act="connect">Connect wallet</button></section>`;
  return `<section class="sec"><h2>Your owner key</h2>
    <p>Give this to whoever is creating the vault.</p>
    <div class="mono">${esc(myHandle())}</div>
    <button class="btn" data-act="copy-owner">Copy</button></section>`;
}

function renderHome(){
  const list = saved();
  return `${renderOwner()}
  <section class="sec"><h2>Vaults</h2>
    ${list.length ? list.map((d, i) => {
      const a = BV.vaultOf(BV.parseDescriptor(d, S.network)).address;
      return `<button class="item" data-act="open" data-i="${i}">${esc(short(a))}</button>`;
    }).join('') : '<p class="dim">None in this browser.</p>'}
    <button class="btn fill" data-act="new">New vault</button>
    <label for="import">Open a vault from its descriptor</label>
    <textarea id="import" spellcheck="false" placeholder="tr(50929b74…"></textarea>
    <button class="btn" data-act="import">Open</button>
  </section>`;
}

function renderNew(){
  const f = S.form;
  const opt = (v, t) => `<option value="${v}"${f.kind === v ? ' selected' : ''}>${t}</option>`;
  const notes = {
    plain: '',
    recovery: `<div class="note">The quorum spends at any time. Once a coin has gone unspent for the delay, the recovery keys can spend it too, enforced by Bitcoin itself. Spending, or sending to the vault itself, restarts the clock, and an idle vault has to do that before it runs out.</div>`,
    hold: `<div class="note warn">This is not the Ethereum timelock. Every owner together can spend at once, and the quorum can spend a coin once that coin is older than the delay. The clock starts when a coin arrives, not when someone proposes, and no one can cancel. A coin that has sat longer than the delay has no delay left.</div>`,
  };
  return `<section class="sec"><h2>New vault</h2>
    <label for="kind">Policy</label>
    <select id="kind" data-field="kind">${opt('plain', 'Quorum')}${opt('recovery', 'Quorum, with recovery after a delay')}${opt('hold', 'All owners now, quorum on aged coins')}${opt('mirror', 'Same owners as an Ethereum vault')}</select>
    ${notes[f.kind]}
    ${f.kind === 'mirror' ? renderMirror() : `
    <label for="owners">Owners, one per line. A handle, or [fingerprint/path]xpub from a hardware wallet</label>
    <textarea id="owners" data-field="owners" spellcheck="false" placeholder="${BV.NETWORKS[S.network].owner}1…">${esc(f.owners)}</textarea>
    ${S.owner ? '<button class="btn" data-act="add-me">Add me</button>' : ''}
    <div class="row">
      <div><label for="threshold">Signatures needed</label><input id="threshold" data-field="threshold" inputmode="numeric" value="${esc(f.threshold)}"></div>
      ${f.kind === 'plain' ? '' : `<div><label for="older">Delay in blocks</label><input id="older" data-field="older" inputmode="numeric" value="${esc(f.older)}"></div>`}
    </div>
    ${f.kind === 'recovery' ? `<label for="second">Recovery keys, one per line</label>
      <textarea id="second" data-field="second" spellcheck="false">${esc(f.second)}</textarea>
      <label for="st">Recovery signatures needed</label><input id="st" data-field="secondThreshold" inputmode="numeric" value="${esc(f.secondThreshold)}">` : ''}`}
    <button class="btn fill" data-act="create">Create</button>
    <button class="btn" data-act="home">Back</button>
  </section>`;
}

function renderMirror(){
  const f = S.form, v = S.mirror;
  const chains = Object.entries(BV.EVM_CHAINS).map(([id, c]) => `<option value="${id}"${+f.evmChain === +id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const have = new Set();
  for(const t of f.owners.split(/\s+/).filter(Boolean)){ try { const h = BV.decodeOwner(t, S.network); if(h.proven) have.add(h.evm); } catch(_) {} }
  return `<div class="note">Each owner connects here once and shares their handle. With every handle in, the owners and threshold come from the contract, and anyone with the same handles gets the same vault.</div>
    <div class="note warn">This copies the vault as it is now. The Bitcoin vault cannot follow later changes to the owners or threshold, and it has no timelock. An owner that is a contract, such as a Safe, cannot take part.</div>
    <div class="row">
      <div><label for="evmChain">Chain</label><select id="evmChain" data-field="evmChain">${chains}</select></div>
      <div><label for="evmVault">Vault address</label><input id="evmVault" data-field="evmVault" spellcheck="false" autocomplete="off" value="${esc(f.evmVault)}"></div>
    </div>
    <button class="btn" data-act="read-mirror">Read vault</button>
    ${v ? `<h3>${v.threshold} of ${v.owners.length}</h3>
      ${v.owners.map(o => `<div class="kv"><span>${esc(short(o))}</span><span class="dim">${have.has(o) ? 'Ready' : 'Waiting'}</span></div>`).join('')}
      <label for="owners">Owner handles, one per line</label>
      <textarea id="owners" data-field="owners" spellcheck="false">${esc(f.owners)}</textarea>
      ${S.owner ? '<button class="btn" data-act="add-me">Add me</button>' : ''}
      <button class="btn" data-act="noop">Check</button>` : ''}`;
}

function pathLabel(p, i){
  return `${i ? 'Delayed: ' : ''}${p.threshold} of ${p.keys.length}${p.older ? ` after ${p.older} blocks (${days(p.older)})` : ''}`;
}

function renderReview(){
  const r = S.review;
  if(!r) return '';
  const mine = S.owner && r.keys.some(k => k.xpub === S.owner.xpub), signed = S.owner && r.signedAll.includes(S.owner.xpub);
  const stranded = r.outputs.some(o => o.stranded);
  const sends = r.outputs.filter(o => !o.change);
  const outLabel = o => o.stranded ? 'Lost address' : o.change ? `Back to vault (${o.branch ? 'change' : 'receive'} ${o.index})` : 'Pays';
  return `<section class="sec"><h2>Proposal</h2>
    ${sends.length ? '' : '<div class="note">This only moves coins within the vault. It restarts their clock.</div>'}
    ${r.outputs.map(o => `<div class="kv"><span class="dim">${esc(outLabel(o))}</span><span>${btcOf(o.sats)} BTC ${o.change ? '' : '→ ' + esc(o.address)}</span></div>`).join('')}
    <div class="kv"><span class="dim">Fee</span><span>${btcOf(r.fee)} BTC (${r.feeRate.toFixed(1)} sat/vB)</span></div>
    <div class="kv"><span class="dim">Path</span><span>${esc(pathLabel(S.policy.paths[r.path], r.path))}</span></div>
    <div class="kv"><span class="dim">Signed</span><span>${r.signedBy.length} of ${r.threshold} needed</span></div>
    ${r.feeRate > 200 ? `<div class="note warn">That fee is unusually high. Check it before signing.</div>` : ''}
    ${stranded ? '<div class="note bad">This sends coins to a vault address so far along that no scan would find it. Do not sign it.</div>' : ''}
    ${mine && !signed && S.trusted && !stranded ? '<button class="btn fill" data-act="sign">Sign</button>' : ''}
    ${!S.owner ? '<button class="btn" data-act="connect">Connect to sign</button>' : ''}
    ${r.ready ? '<button class="btn go" data-act="broadcast">Broadcast</button>' : ''}
    <button class="btn" data-act="copy-link">Copy link for co-signers</button>
    <button class="btn" data-act="copy-psbt">Copy PSBT</button>
    <button class="btn" data-act="discard">Discard</button>
    <label for="merge">Add a co-signer's copy</label>
    <textarea id="merge" spellcheck="false" placeholder="Paste a PSBT signed elsewhere, such as Sparrow with a hardware wallet"></textarea>
    <button class="btn" data-act="merge">Merge</button>
  </section>`;
}

function renderVault(){
  const p = S.policy, v = BV.vaultOf(p, 0, S.receive), coins = S.coins;
  const total = (coins || []).reduce((n, c) => n + c.value, 0), pending = (coins || []).filter(c => !c.height).length;
  const delayed = p.paths[1];
  const ages = delayed && coins ? coins.filter(c => c.height).map(c => c.height + delayed.older - S.tip - 1) : [];
  const nextDue = ages.length ? Math.min(...ages) : null;
  return `<section class="sec"><h2>Vault</h2>
    <div class="big">${coins ? btcOf(total) : '…'} BTC</div>
    ${pending ? `<p class="dim">${pending} unconfirmed, not spendable yet.</p>` : ''}
    ${S.trusted ? `<label>Receive at</label>
    <div class="mono">${coins ? esc(v.address) : '…'}</div>
    <button class="btn" data-act="copy-address"${coins ? '' : ' disabled'}>Copy address</button>
    ${S.network === 'signet' ? `<p class="dim">Signet coins are free and worth nothing. Copy the address, then get some from a <a href="https://faucet.coinbin.org" target="_blank" rel="noopener">faucet</a> to try this vault.</p>` : ''}` : `<div class="note warn">This vault came from a link. Check that you know every owner below before you pay it or sign for it. Whoever sent the link chose these keys.</div>
    <button class="btn fill" data-act="trust">I know these owners</button>`}
    <h3>Owners</h3>
    ${S.owner ? `<p class="${p.paths.some(x => x.keys.some(k => k.xpub === S.owner.xpub)) ? '' : 'dim'}">${p.paths.some(x => x.keys.some(k => k.xpub === S.owner.xpub)) ? 'You are an owner.' : 'You are not an owner of this vault.'}</p>` : ''}
    ${[...new Map(p.paths.flatMap(x => x.keys).map(k => [k.xpub, k])).values()].map(k => `<div class="kv"><span>${esc(k.fingerprint)}</span><span class="dim">${esc(short(k.xpub))}${S.owner && S.owner.xpub === k.xpub ? ' (you)' : ''}</span></div>`).join('')}
    ${p.paths.map((x, i) => `<div class="kv"><span class="dim">${i ? 'Second path' : 'First path'}</span><span>${esc(pathLabel(x, i))}</span></div>`).join('')}
    ${delayed ? (nextDue === null ? '' : nextDue > 0
      ? `<div class="kv"><span class="dim">Delayed path opens</span><span>in ${nextDue} blocks (${days(nextDue)})</span></div>`
      : `<div class="note warn">The delayed path is open on at least one coin. Send them to this vault's own receive address to close it again.</div>`) : ''}
    <h3>Back this up</h3>
    <div class="note warn">Bitcoin keeps no record of who owns this vault. Every owner must keep this descriptor: without it the coins cannot be spent, even with every key. Bitcoin Core and other descriptor wallets can read it.</div>
    <div class="mono">${esc(BV.descriptor(p))}</div>
    <button class="btn" data-act="copy-descriptor">Copy descriptor</button>
    <button class="btn" data-act="copy-policy">Copy wallet policy</button>
    <button class="btn" data-act="copy-link">Copy link</button>
    <button class="btn" data-act="home">All vaults</button>
  </section>
  ${renderReview()}
  ${S.review ? '' : `<section class="sec"><h2>Propose</h2>
    <label for="to">To</label><input id="to" spellcheck="false" autocomplete="off">
    <div class="row">
      <div><label for="amt">Amount in BTC, or "all"</label><input id="amt" autocomplete="off"></div>
      <div><label for="rate">Fee rate, sat/vB</label><input id="rate" inputmode="decimal" value="${S.feeRate || 1}"></div>
    </div>
    <label for="path">Path</label>
    <select id="path">${p.paths.map((x, i) => `<option value="${i}">${esc(pathLabel(x, i))}</option>`).join('')}</select>
    <button class="btn fill" data-act="propose"${coins ? '' : ' disabled'}>Propose</button>
    <label for="paste">Or open a proposal</label>
    <textarea id="paste" spellcheck="false" placeholder="Paste a PSBT"></textarea>
    <button class="btn" data-act="paste">Open</button>
  </section>`}`;
}

function render(){
  $('nets').innerHTML = (MAINNET ? ['signet', 'mainnet'] : ['signet']).map(n => `<button class="pill${n === S.network ? ' on' : ''}" data-act="net" data-n="${n}"${n === S.network ? ' aria-current="true"' : ''}>${n.toUpperCase()}</button>`).join('');
  const banner = S.network === 'mainnet' ? `<div class="note warn">Real bitcoin. This page has been tested against Bitcoin Core and has not had an independent review. Start with an amount you can lose.</div>` : '';
  const m = S.msg;
  const msg = m ? `<div class="note ${m.kind}" role="status">${esc(m.text)}${m.href ? ` <a href="${esc(m.href)}" target="_blank" rel="noopener">view</a>` : ''}</div>` : '';
  $('app').innerHTML = banner + msg + (S.view === 'new' ? renderNew() : S.view === 'vault' ? renderVault() : renderHome());
}

const copy = async text => {
  try { await navigator.clipboard.writeText(text); S.msg = { text: 'Copied.', kind: 'ok' }; }
  catch(_) { S.msg = { text: 'The browser refused the clipboard. Select the text instead.', kind: 'bad' }; }
};

const ACT = {
  connect,
  trust(){ remember(S.policy); S.trusted = true; },
  net(el){
    if(S.network === el.dataset.n) return;
    // A key is per network, so it does not carry across.
    forget();
    Object.assign(S, { network: el.dataset.n, view: 'home', policy: null, psbt: null, review: null, msg: null });
    lsSet('ms_btc_net', S.network);
    try { history.replaceState(null, '', location.pathname); } catch(_) {}
  },
  new(){ S.view = 'new'; S.msg = null; },
  home(){ Object.assign(S, { view: 'home', policy: null, psbt: null, review: null, msg: null }); try { history.replaceState(null, '', location.pathname); } catch(_) {} },
  open(el){ return open(BV.parseDescriptor(saved()[+el.dataset.i], S.network)); },
  import(){ return open(BV.parseDescriptor($('import').value, S.network)); },
  create: createVault,
  'read-mirror': readMirror,
  noop(){ S.msg = null; },
  'add-me'(){ const f = S.form, me = myHandle(); if(!f.owners.includes(me)) f.owners = (f.owners.trim() + '\n' + me).trim(); },
  propose,
  paste(){ load($('paste').value.trim()); },
  sign, merge, broadcast,
  discard(){ Object.assign(S, { psbt: null, review: null }); syncHash(); },
  'copy-owner'(){ return copy(myHandle()); },
  'copy-address'(){ return copy(BV.vaultOf(S.policy, 0, S.receive).address); },
  'copy-descriptor'(){ return copy(BV.descriptor(S.policy)); },
  'copy-policy'(){ return copy(JSON.stringify(BV.walletPolicy(S.policy), null, 2)); },
  'copy-psbt'(){ return copy(S.psbt); },
  'copy-link'(){ return copy(linkFor()); },
};

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  touch();
  if(!el || S.busy) return;
  S.busy = true;
  try { await ACT[el.dataset.act](el); render(); }
  catch(err) { say(err?.message || String(err)); }
  finally { S.busy = false; }
});
document.addEventListener('input', e => {
  const k = e.target.dataset?.field;
  if(!k) return;
  S.form[k] = e.target.value;
  if(k === 'evmChain' || k === 'evmVault') S.mirror = null;
  if(k === 'kind' || k === 'evmChain') render();
});
window.addEventListener('hashchange', readHash);

render();
readHash();

})();
