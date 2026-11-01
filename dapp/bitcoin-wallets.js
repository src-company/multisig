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

async function connectWallet(wallet, network){
  checkPlace();
  const BV = await loadBitcoinLibs();
  const address = await wallet.account();
  if(!onNetwork(address, network)) throw new Error(`${wallet.name} is not on ${network === 'mainnet' ? 'Bitcoin mainnet' : 'signet'}. Switch it, then connect again.`);
  // Twice, as with an Ethereum wallet: a key that cannot be derived again is lost.
  const msg = BV.walletMessage(), one = await wallet.sign(msg, address, network), two = await wallet.sign(msg, address, network);
  if(one !== two) throw new Error(`${wallet.name} signs differently each time, so it cannot hold a key here. Nothing was derived.`);
  const key = BV.keyFromWalletSignature(one, network);
  const signature = await wallet.sign(BV.linkMessage(network, key.evm), address, network);
  const proof = BV.evmSignMessage(BV.bindingMessage(network, key.owner), key.evmPriv);
  const owner = { ...key.owner, evm: key.evm, proof, wallet: { address, signature } };
  const handle = BV.encodeOwner({ network, ...owner });
  BV.publishHandle(handle, network).catch(() => {});
  return { ...key, owner, handle, address };
}

// An Ethereum wallet on the page that only sets a vault up. The key is needed for one
// moment, to make the public handle, and is wiped straight after.
async function connectEvmForHandle(eth, network){
  checkPlace();
  const BV = await loadBitcoinLibs();
  const [raw] = await eth.request({ method: 'eth_requestAccounts' }), evm = raw.toLowerCase();
  const hexMsg = m => '0x' + window.btc.hex.encode(new TextEncoder().encode(m));
  const key = await BV.deriveOwnerKey(m => eth.request({ method: 'personal_sign', params: [hexMsg(m), raw] }), network);
  key.signer.wipePrivateData();
  const proof = await eth.request({ method: 'personal_sign', params: [hexMsg(BV.bindingMessage(network, key.owner)), raw] });
  const owner = { ...key.owner, evm, proof }, handle = BV.encodeOwner({ network, ...owner });
  await BV.publishHandle(handle, network).catch(() => {});
  return { owner, handle, evm, label: `0x${evm.slice(2, 6)}…${evm.slice(-4)}` };
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
function providerFor(wallet){
  let key = null, chain = 1;
  const listeners = {};
  const emit = (e, v) => (listeners[e] || []).forEach(f => { try { f(v); } catch(_) {} });
  const refuse = (code, message) => Object.assign(new Error(message), { code });
  const signing = () => { if(!key) throw refuse(4100, 'Connect first'); return key; };
  return {
    on(e, f){ (listeners[e] ||= []).push(f); },
    removeListener(e, f){ listeners[e] = (listeners[e] || []).filter(x => x !== f); },
    async request({ method, params = [] }){
      switch(method){
        case 'eth_requestAccounts':
          key = key || await connectWallet(wallet, 'mainnet');
          return [key.evm];
        case 'eth_accounts': return key ? [key.evm] : [];
        case 'eth_chainId': return '0x' + chain.toString(16);
        case 'net_version': return String(chain);
        case 'wallet_switchEthereumChain':
          chain = parseInt(params[0].chainId, 16);
          emit('chainChanged', params[0].chainId);
          return null;
        case 'wallet_addEthereumChain': return null;
        case 'personal_sign': {
          const k = signing(), raw = params[0], text = /^0x/.test(raw) ? new TextDecoder().decode(window.btc.hex.decode(raw.slice(2))) : raw;
          return window.BitcoinVault.evmSignMessage(text, k.evmPriv);
        }
        case 'eth_signTypedData_v4': {
          const k = signing(), { domain, types, message } = JSON.parse(params[1]);
          const { EIP712Domain, ...rest } = types;
          const hash = window.ethers.TypedDataEncoder.hash(domain, rest, message);
          return window.BitcoinVault.evmSignHash(window.btc.hex.decode(hash.slice(2)), k.evmPriv);
        }
        case 'eth_sendTransaction':
          throw refuse(4200, `${wallet.name} holds no ETH to send this. Your signature counts: another owner can submit it.`);
        default: {
          const c = RPCS()[chain];
          if(!c) throw refuse(4901, 'That chain is not available here');
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

window.BitcoinWallets = { detect, connectWallet, connectEvmForHandle, walletConnect, loadBitcoinLibs, providerFor };

})();
