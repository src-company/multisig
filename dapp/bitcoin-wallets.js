'use strict';
// Bitcoin wallets. UniSat, Xverse and Leather connect here, on both pages. They cannot
// sign what an Ethereum contract verifies, so a wallet signs one fixed message and an
// owner's keys come from that signature (keyFromWalletSignature in bitcoin.js).
//
// In the main app that identity is announced over EIP-6963 as if it were an Ethereum
// wallet. Everything there signs through personal_sign and eth_signTypedData_v4, so a
// Bitcoin owner proposes, signs and approves on every chain with no change to that code.
// The one thing it cannot do is send a transaction: it has no ETH, and that is refused
// in words. Another owner, or anyone, submits once the signatures are in.
//
// The heavy libraries load on the first connect, so this file costs a visitor with no
// Bitcoin wallet next to nothing.

(function(){

let _libs = null;
function loadBitcoinLibs(){
  if(window.BitcoinVault) return Promise.resolve(window.BitcoinVault);
  return _libs || (_libs = new Promise((ok, no) => {
    const add = (src, next) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = next;
      el.onerror = () => { _libs = null; no(new Error('Could not load the Bitcoin libraries')); };
      document.head.appendChild(el);
    };
    add('./btc.min.js', () => add('./bitcoin.js', () => ok(window.BitcoinVault)));
  }));
}

const b64 = s => { if(typeof s !== 'string' || !s) throw new Error('The wallet returned no signature'); return s; };
const WALLETS = [
  { key: 'unisat', name: 'UniSat', present: () => !!window.unisat,
    async account(){ const [a] = await window.unisat.requestAccounts(); return a; },
    sign: (m) => window.unisat.signMessage(m, 'ecdsa').then(b64) },
  { key: 'xverse', name: 'Xverse', present: () => !!window.XverseProviders?.BitcoinProvider,
    async account(){
      const r = await window.XverseProviders.BitcoinProvider.request('getAccounts', { purposes: ['payment'] });
      if(r.error) throw new Error(r.error.message);
      return (r.result.accounts || r.result)[0].address;
    },
    async sign(m, address){
      const r = await window.XverseProviders.BitcoinProvider.request('signMessage', { address, message: m, protocol: 'ECDSA' });
      if(r.error) throw new Error(r.error.message);
      return b64(r.result.signature);
    } },
  { key: 'leather', name: 'Leather', present: () => !!window.LeatherProvider,
    async account(){
      const r = await window.LeatherProvider.request('getAddresses');
      return r.result.addresses.find(a => a.type === 'p2wpkh').address;
    },
    async sign(m, address, network){
      const r = await window.LeatherProvider.request('signMessage', { message: m, paymentType: 'p2wpkh', network: network === 'mainnet' ? 'mainnet' : 'signet' });
      return b64(r.result.signature);
    } },
];
const detect = () => WALLETS.filter(w => w.present());

// An address only ever belongs to one network, so a wallet on the other is said now.
const onNetwork = (address, network) => network === 'mainnet' ? /^(bc1|1|3)/.test(address) : /^(tb1|m|n|2)/.test(address);

// The hosting headers do not travel to a mirror, so every route to a key checks for itself.
function checkPlace(){
  if(/^\/ip[fn]s\//.test(location.pathname)) throw new Error('Open this page from its own domain to use a key.');
  if(window.top !== window || window.opener) throw new Error('Open this page in its own tab to use a key.');
}

// One wallet prompt. Wallets go quiet, queue, or close a popup and call it a rejection,
// and a page that simply awaits them sits there with every button dead. So a prompt can
// be cancelled, times out, waits its turn if the wallet says one is pending, and is
// reported in words that do not accuse anyone of declining.
const PROMPT_MS = 120000, GAP_MS = 600;
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
let _cancel = null, _cancelled = false;
const cancelPrompt = () => { _cancelled = true; _cancel?.(new Error('Cancelled. Nothing was changed.')); };
async function ask(fn){
  for(let tries = 0; ; tries++){
    let timer;
    try {
      return await Promise.race([fn(), new Promise((_, no) => {
        _cancel = no;
        timer = setTimeout(() => no(new Error('Your wallet did not answer. Open it, look for a waiting request, and try again.')), PROMPT_MS);
      })]);
    } catch(e) {
      const text = String(e?.message || '');
      if((e?.code === -32002 || /already pending/i.test(text)) && tries < 3){ await sleep(1500); continue; }
      if(e?.code === 4001 || /reject|denied/i.test(text)) throw new Error('Your wallet closed that request, so nothing was changed. Try again.');
      throw e;
    } finally { clearTimeout(timer); _cancel = null; }
  }
}

// A key that differs from the one on record means this wallet is not repeating itself,
// or is another account. Either way it is said now, not when the owner goes to sign.
// Returns whether a record matched: a wallet that matched has proved it repeats.
async function checkOnRecord(BV, network, evm, xpub, walletAddress){
  if(walletAddress){
    const found = await BV.handleForWallet(network, walletAddress).catch(() => null);
    if(found && found.evm !== evm) throw new Error('This wallet gave a different key from the one on record for this address, so it cannot sign for that seat. Nothing was changed.');
  }
  const [known] = await BV.fetchHandles(network, [evm]).catch(() => []);
  if(!known) return false;
  if(BV.decodeOwner(known, network).xpub !== xpub) throw new Error('This wallet gave a different key from the one on record for this address, so it cannot sign for that seat. Nothing was changed.');
  return true;
}
const gap = async () => { await sleep(GAP_MS); if(_cancelled) throw new Error('Cancelled. Nothing was changed.'); };

async function connectWallet(wallet, network, onStep = () => {}){
  checkPlace();
  _cancelled = false;
  const BV = await loadBitcoinLibs();
  const address = await ask(() => wallet.account());
  if(!onNetwork(address, network)) throw new Error(`${wallet.name} is not on ${network === 'mainnet' ? 'Bitcoin mainnet' : 'signet'}. Switch it, then connect again.`);
  onStep(1, 2);
  const sign = () => ask(() => wallet.sign(BV.walletMessage(), address, network));
  const key = BV.keyFromWalletSignature(await sign(), network);
  try {
    const repeats = await checkOnRecord(BV, network, key.evm, key.owner.xpub, address);
    await gap();
    onStep(2, 2);
    const signature = await ask(() => wallet.sign(BV.linkMessage(network, key.evm), address, network));
    const proof = BV.evmSignMessage(BV.bindingMessage(network, key.owner), key.evmPriv);
    // Only a BIP-137 signature can be checked here. Leather answers in BIP-322, and that
    // owner is still a full owner: they just cannot be found by their bc1 address.
    const provable = BV.bitcoinSigners(BV.linkMessage(network, key.evm), window.btc.base64.decode(signature), network).includes(address);
    const owner = { ...key.owner, evm: key.evm, proof, ...(provable ? { wallet: { address, signature } } : {}) };
    const handle = BV.encodeOwner({ network, ...owner });
    const published = await BV.publishHandle(handle, network).then(() => true, () => false);
    const recheck = repeats ? null : async () => { const k = BV.keyFromWalletSignature(await sign(), network); k.signer.wipePrivateData(); k.evmPriv.fill(0); return k.owner.xpub; };
    return { ...key, owner, handle, address, published, recheck };
  } catch(e) { key.signer.wipePrivateData(); key.evmPriv.fill(0); throw e; }
}

// An Ethereum wallet: one signature makes the key, a second says it belongs to this
// address. The number does not depend on the vault. The setup page wipes the key as soon
// as the handle exists; a page that goes on to sign asks to keep it. A wallet with no key
// on record yet gets `recheck`, asked once at the moment it matters and long after the
// first prompt, because coins must not go to a key the wallet cannot make again.
async function connectEvmForHandle(eth, network, { keep = false, onStep = () => {} } = {}){
  checkPlace();
  _cancelled = false;
  const BV = await loadBitcoinLibs();
  const [raw] = await ask(() => eth.request({ method: 'eth_requestAccounts' }));
  if(!raw) throw new Error('Your wallet shared no account. Unlock it, then connect again.');
  const evm = raw.toLowerCase();
  const code = await eth.request({ method: 'eth_getCode', params: [raw, 'latest'] }).catch(() => '0x');
  // 7702 delegations start 0xef0100 and still sign as the key behind them.
  if(typeof code === 'string' && code !== '0x' && !code.startsWith('0xef0100')) throw new Error('Contract wallets cannot hold a Bitcoin key here, because they do not repeat a signature. Nothing was changed.');
  const hexMsg = m => '0x' + window.btc.hex.encode(new TextEncoder().encode(m));
  const derive = () => BV.deriveOwnerKey(m => ask(() => eth.request({ method: 'personal_sign', params: [hexMsg(m), raw] })), network);
  onStep(1, 2);
  const key = await derive();
  try {
    const repeats = await checkOnRecord(BV, network, evm, key.owner.xpub);
    await gap();
    onStep(2, 2);
    const proof = await ask(() => eth.request({ method: 'personal_sign', params: [hexMsg(BV.bindingMessage(network, key.owner)), raw] }));
    // A contract wallet on a chain it is not deployed on passes the code check, and
    // signs in a way that recovers to nobody.
    if(BV.evmSigner(BV.bindingMessage(network, key.owner), window.btc.hex.decode(proof.replace(/^0x/, ''))) !== evm) throw new Error('This wallet signs in a way that does not prove its address, so it cannot hold a Bitcoin key here. Nothing was changed.');
    if(!keep) key.signer.wipePrivateData();
    const owner = { ...key.owner, evm, proof }, handle = BV.encodeOwner({ network, ...owner });
    const published = await BV.publishHandle(handle, network).then(() => true, () => false);
    const recheck = repeats ? null : async () => { const k = await derive(); k.signer.wipePrivateData(); return k.owner.xpub; };
    return { owner, handle, evm, published, recheck, signer: keep ? key.signer : null, label: `0x${evm.slice(2, 6)}…${evm.slice(-4)}` };
  } catch(e) { key.signer.wipePrivateData(); throw e; }
}

// WalletConnect is only fetched by someone who picks it, so a page that can hold a key
// does not carry a relay client for the owners who never use one.
const WC_PROJECT_ID = '1e8390ef1c1d8a185e035912a1409749';
let _wc = null;
function walletConnect(){
  return _wc || (_wc = new Promise((ok, no) => {
    const el = document.createElement('script');
    el.src = './walletconnect.min.js';
    el.onerror = () => { _wc = null; no(new Error('Could not load WalletConnect')); };
    el.onload = async () => {
      try {
        const BV = await loadBitcoinLibs();
        const p = await globalThis['@walletconnect/ethereum-provider'].EthereumProvider.init({ projectId: WC_PROJECT_ID, chains: [1], showQrModal: true, metadata: { name: 'multisig', description: 'multisig', url: location.origin, icons: [] }, rpcMap: { 1: BV.EVM_CHAINS[1].rpc } });
        await p.enable();
        ok(p);
      } catch(e) { _wc = null; no(e); }
    };
    document.head.appendChild(el);
  }));
}

// ── AS AN ETHEREUM WALLET ──────────────────────────────────
const RPCS = () => window.BitcoinVault.EVM_CHAINS;
const APP_TYPES = new Set(['Execute', 'Metadata', 'Action', 'Session']);
const READS = new Set(['eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_feeHistory', 'eth_gasPrice', 'eth_getBalance', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_maxPriorityFeePerGas']);
function providerFor(wallet){
  let key = null, chain = 1, idle;
  // Same limit as the Bitcoin page. A key left in an open tab is a risk for no benefit.
  const forget = () => { clearTimeout(idle); if(key){ key.evmPriv.fill(0); key = null; } };
  const touch = () => { clearTimeout(idle); idle = setTimeout(forget, 15 * 60 * 1000); };
  const listeners = {};
  const emit = (e, v) => (listeners[e] || []).forEach(f => { try { f(v); } catch(_) {} });
  const refuse = (code, message) => Object.assign(new Error(message), { code });
  const signing = () => { if(!key) throw refuse(4100, 'Connect first'); touch(); return key; };
  return {
    disconnect: forget,
    on(e, f){ (listeners[e] ||= []).push(f); },
    removeListener(e, f){ listeners[e] = (listeners[e] || []).filter(x => x !== f); },
    async request({ method, params = [] }){
      switch(method){
        case 'eth_requestAccounts':
          if(!key){
            key = await connectWallet(wallet, 'mainnet');
            // Only the Ethereum key is used here, so the Bitcoin root goes at once.
            key.signer.wipePrivateData();
            key.signer = null;
            touch();
          }
          return [key.evm];
        case 'eth_accounts': return key ? [key.evm] : [];
        case 'eth_chainId': return '0x' + chain.toString(16);
        case 'net_version': return String(chain);
        case 'wallet_switchEthereumChain': {
          const id = parseInt(params[0]?.chainId, 16);
          if(!window.BitcoinVault.EVM_CHAINS[id]) throw refuse(4902, 'That chain is not available here');
          chain = id;
          emit('chainChanged', params[0].chainId);
          return null;
        }
        case 'wallet_addEthereumChain': return null;
        // Nothing else is signed. No wallet window stands behind this key, so the page is
        // the only review there is, and any script here could ask. It signs the app's own
        // messages, on the account and chain it is on, and refuses everything else, so it
        // cannot be turned on a token permit or an arbitrary text.
        case 'eth_signTypedData_v4': {
          const k = signing(), { domain, types, primaryType, message } = JSON.parse(params[1]);
          if(String(params[0]).toLowerCase() !== k.evm) throw refuse(4100, 'That is not this account');
          if(domain?.name !== 'Multisig' || !APP_TYPES.has(primaryType)) throw refuse(4200, 'This wallet only signs this app\'s own messages');
          if(primaryType !== 'Session' && Number(domain.chainId) !== chain) throw refuse(4901, 'That message is for another chain');
          const { EIP712Domain, ...rest } = types;
          const hash = window.ethers.TypedDataEncoder.hash(domain, rest, message);
          return window.BitcoinVault.evmSignHash(window.btc.hex.decode(hash.slice(2)), k.evmPriv);
        }
        case 'eth_sendTransaction':
          throw refuse(4200, `${wallet.name} holds no ETH to send this. Your signature counts: another owner can submit it.`);
        default: {
          const c = RPCS()[chain];
          if(!c) throw refuse(4901, 'That chain is not available here');
          if(!READS.has(method)) throw refuse(4200, 'That is not available from this wallet');
          const r = await fetch(c.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
          const j = await r.json();
          if(j.error) throw refuse(j.error.code, j.error.message);
          return j.result;
        }
      }
    },
  };
}

const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#F7931A"/></svg>');
function announce(){
  if(!window.__multisigMainApp) return;
  for(const w of detect()){
    const provider = (w.provider ||= providerFor(w));
    const detail = Object.freeze({ info: { uuid: `multisig-btc-${w.key}`, name: `${w.name} (Bitcoin)`, icon: ICON, rdns: `software.multisig.${w.key}` }, provider });
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  }
}
window.addEventListener('eip6963:requestProvider', () => loadBitcoinLibs().then(announce, () => {}));
if(detect().length) loadBitcoinLibs().then(announce, () => {});

window.BitcoinWallets = { detect, connectWallet, connectEvmForHandle, cancelPrompt, walletConnect, loadBitcoinLibs, providerFor };

})();
