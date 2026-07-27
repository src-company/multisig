(function() {
'use strict';

// WNS (.wei) and its direct fork GNS (.gwei) — identical ABI, both on mainnet.
// Reverse resolution is tried in this order, so .wei wins when both exist.
const WEINS = '0x0000000000696760E15f265e828DB644A0c242EB';
const GWEINS = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6';
const WEINS_ABI = ['function reverseResolve(address) view returns (string)'];
const WC_PROJECT_ID = '1e8390ef1c1d8a185e035912a1409749';

// Coinbase Smart Wallet — a passkey account with no extension and no app to
// install, which is the one Coinbase product the two paths below cannot reach.
// An installed Coinbase extension announces itself over EIP-6963 and the mobile
// app pairs over WalletConnect; the smart wallet lives behind a popup at
// keys.coinbase.com and is only reachable through Coinbase's SDK.
//
// It matters here more than it would elsewhere: a Basename usually resolves to
// one of these accounts rather than to an EOA, so the owner a Base user is most
// likely to name is an account this app could not previously connect at all.
//
// Vendored rather than loaded from a CDN, because script-src is 'self'. The SDK
// ships no browser build, so the file beside this one is produced from the
// published package with:
//
//   npm pack @coinbase/wallet-sdk@4.3.7      # sha512 z6e5XDw6EF06Rqke...
//   echo "export { createCoinbaseWalletSDK } from '@coinbase/wallet-sdk';" > entry.js
//   esbuild entry.js --bundle --format=iife --minify \
//     --global-name=CoinbaseWalletSDKBundle --define:process.env.NODE_ENV='"production"' \
//     --outfile=coinbase.min.js
//
// 116 KB, against WalletConnect's 635 KB, and loaded on the same terms: only if
// someone picks it.
let _cbLoadPromise = null;
function loadCoinbase() {
  if (globalThis.CoinbaseWalletSDKBundle) return Promise.resolve();
  if (_cbLoadPromise) return _cbLoadPromise;
  _cbLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = './coinbase.min.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { _cbLoadPromise = null; reject(new Error('Failed to load Coinbase Wallet SDK')); };
    document.head.appendChild(s);
  });
  return _cbLoadPromise;
}

// WalletConnect (~635KB) is only needed if the user actually picks it, so it is
// not shipped in the initial page load. Inject it on demand, once, and cache
// the promise so concurrent/repeat callers share a single download.
let _wcLoadPromise = null;
function loadWalletConnect() {
  if (globalThis['@walletconnect/ethereum-provider']) return Promise.resolve();
  if (_wcLoadPromise) return _wcLoadPromise;
  _wcLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = './walletconnect.min.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { _wcLoadPromise = null; reject(new Error('Failed to load WalletConnect')); };
    document.head.appendChild(s);
  });
  return _wcLoadPromise;
}

// What the session asks the wallet for. Every chain the app supports is offered as
// *optional*, and exactly one — mainnet, or the target if the app is not offering
// mainnet at all — is required.
//
// Both halves were wrong before, and each broke the connection in its own way.
//
// The chains: a required namespace is all-or-nothing, so naming the chain the app
// happened to be on meant a wallet that has never heard of MegaETH refused the
// whole session rather than pairing without it. And only the approved chains can
// be switched to afterwards, so a session pinned to one chain could never follow
// the app to another — which this app does constantly, and a multichain deploy
// does mid-run.
//
// The methods: the required set is `eth_sendTransaction` and `personal_sign`, and
// nothing else. Everything in this app is signed with EIP-712 — `signTypedData`,
// i.e. `eth_signTypedData_v4` — and a method outside the session is not refused by
// the wallet, it is quietly routed to the chain's *RPC node* instead, which
// answers "method not found". So WalletConnect could connect and then sign
// nothing. Asking for the optional set is what puts typed-data signing (and
// `wallet_switchEthereumChain`) in the session where the wallet will see it.
//
// Every chain is given its RPC here as well, and that is load-bearing twice over:
// the provider sends reads (`eth_call`, `eth_estimateGas`) to whatever URL it has
// for the current chain, and a chain with no entry gets WalletConnect's own RPC
// host — which is not in the page's CSP, by choice, so those reads would be
// blocked rather than merely routed off-site.
function _wcSessionConfig() {
  const rpcMap = {};
  for (const c of (_wcChains || [])) {
    if (c && c.id && c.rpc) rpcMap[Number(c.id)] = c.rpc;
  }
  if (!rpcMap[_targetChainId]) rpcMap[_targetChainId] = _targetRpc;
  const optionalChains = Object.keys(rpcMap).map(Number);
  // The one required chain has to be one a wallet can be relied on to know.
  const required = rpcMap[1] ? 1 : _targetChainId;
  return { chains: [required], optionalChains, rpcMap };
}

// The smart wallet's provider. One per page — the SDK holds the popup and the
// session behind it, so a second instance would be a second session competing
// for the same account.
//
// `smartWalletOnly` deliberately: the SDK can also drive the extension and the
// mobile QR flow, and both of those are already offered above by routes that do
// not cost a 116 KB download. Asking for only the account this exists to reach
// keeps that promise, and keeps the WalletLink hosts out of the CSP entirely.
//
// Every chain the app offers is declared, not just the current one, for the same
// reason WalletConnect's session is: this app moves between chains as a matter
// of course and a multichain deploy moves mid-run. Chains the smart wallet does
// not support — MegaETH among them today — simply fail the switch, which the
// deploy loop already reports per chain rather than treating as fatal.
let _coinbaseProvider = null;
let _cbProviderPromise = null;
function getCoinbaseProvider() {
  if (_coinbaseProvider) return Promise.resolve(_coinbaseProvider);
  // The promise is cached, not just the result. Two callers can arrive before
  // either has finished — the connect button and auto-reconnect race on a
  // returning visitor, and a double-click races with itself — and awaiting the
  // download separately would build a second SDK, which is the second session
  // this is supposed to prevent. A failure clears the slot so a retry is a
  // retry rather than the same rejection handed out forever.
  if (_cbProviderPromise) return _cbProviderPromise;
  _cbProviderPromise = (async () => {
    await loadCoinbase();
    const make = globalThis.CoinbaseWalletSDKBundle?.createCoinbaseWalletSDK;
    if (!make) throw new Error('Coinbase Wallet SDK not available');
    const sdk = make({
      appName: _appName,
      appChainIds: (_wcChains || [{ id: _targetChainId }]).map(c => Number(c.id)),
      preference: { options: 'smartWalletOnly' },
    });
    const p = sdk.getProvider();
    if (!p) throw new Error('Coinbase Wallet SDK returned no provider');
    _coinbaseProvider = p;
    return p;
  })();
  _cbProviderPromise.catch(() => { _cbProviderPromise = null; });
  return _cbProviderPromise;
}

// One provider per page, kept rather than rebuilt. Rebuilding it used to be the
// first thing a second connect attempt did — `disconnect()` then `init()` again —
// which is fine for a stale attempt the user is retrying and destroys the one
// thing worth keeping: a session restored from storage, which is what auto-connect
// hands to this function. `enable()` below is safe to call either way; it only
// opens the QR modal when there is no session to use.
async function getWalletConnectProvider() {
  await loadWalletConnect();
  const WCProvider = globalThis['@walletconnect/ethereum-provider']?.EthereumProvider;
  if (!WCProvider?.init) throw new Error('WalletConnect not available');
  if (_walletConnectProvider) return _walletConnectProvider;
  const { chains, optionalChains, rpcMap } = _wcSessionConfig();
  const p = await WCProvider.init({
    projectId: WC_PROJECT_ID,
    chains, optionalChains, rpcMap,
    showQrModal: true,
    metadata: { name: _appName, description: _appName, url: window.location.origin, icons: [] }
  });
  // A session can also end from the other side — disconnected in the wallet, or
  // simply expired — and nothing here would have noticed: the provider stayed
  // installed, the header still said connected, and the next signature went to a
  // session that was gone. Registered on the instance, once, so the listener
  // cannot stack up across reconnects.
  p.on('disconnect', () => {
    if (_connectedWalletProvider === p) window.disconnectWallet();
    else if (_walletConnectProvider === p) _walletConnectProvider = null;
  });
  _walletConnectProvider = p;
  return p;
}

// Quotes are escaped as well as markup: every _esc() below lands in an HTML
// *attribute* at least once (data-wallet-key, src, aria-label), and an EIP-6963
// announcement is whatever an installed extension chose to broadcast — a uuid or
// a name carrying a bare quote would close the attribute and open a tag.
const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function _esc(s) { return String(s).replace(/[&<>"']/g, m => _escMap[m]); }

// localStorage is not always there to be read. Safari in private mode, a
// third-party iframe with storage partitioned off, and a browser with cookies
// blocked all throw on the *getter*, not just the setter — and every read below
// sits on a path (auto-reconnect, wallet lookup) that must degrade to "no saved
// wallet" rather than throw out of it.
function _lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function _lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function _lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

// --- State (globals for app to read) ---
window._walletProvider = null;
window._signer = null;
window._connectedAddress = null;
window._walletDisplayName = null;
window._walletConnecting = false;
window._connectedWalletProvider = null;
window.eip6963Providers = new Map();

let _walletConnectProvider = null;
let _isConnecting = false;
let _walletEventHandlers = null;
let _onConnectCallbacks = [];
let _onDisconnectCallbacks = [];
let _appName = 'Multisig';
let _targetChainId = 1;
let _targetChainHex = '0x1';
let _targetRpc = 'https://ethereum.publicnode.com';
let _addChainParams = null;
// [{ id, rpc }] — every chain the app offers, for the WalletConnect session to ask
// about. The app owns this list; without it a session is built for the one chain
// the page is currently on.
let _wcChains = null;
// How often a provider built here should ask the wallet whether the head moved.
// This is what decides when `tx.wait()` reports a receipt, and ethers' default of
// four seconds was written for a chain whose blocks take twelve. On a one-second
// chain it means the interface stands still for up to four seconds after the
// transaction has landed — the wait is the app's, not the chain's. The app owns
// the number because only it knows which chain the wallet is on; 0 leaves the
// ethers default alone.
let _pollMs = 0;
function _browserProvider(wp) {
  const p = new ethers.BrowserProvider(wp, 'any');
  if (_pollMs) p.pollingInterval = _pollMs;
  return p;
}

// --- EIP-6963 ---
window.addEventListener('eip6963:announceProvider', (event) => {
  try {
    const { info, provider } = event.detail || {};
    if (info?.uuid && provider) eip6963Providers.set(info.uuid, { info, provider });
  } catch (e) {}
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

// --- Provider detection ---
function detectWallets() {
  const detected = [], seenNames = new Set();
  for (const [uuid, { info, provider }] of eip6963Providers.entries()) {
    const name = info?.name || 'Unknown';
    if (seenNames.has(name.toLowerCase())) continue;
    // data: only. The page's `img-src` allows no remote host but WalletConnect's
    // explorer, so an https icon is blocked by the browser and renders as a broken
    // image rather than as the wallet's mark — and allowing a remote URL here would
    // also let any installed extension turn opening this sheet into a request to a
    // host of its choosing.
    const iconUrl = info.icon && info.icon.startsWith('data:image/') ? info.icon : null;
    const safeIcon = iconUrl ? `<img src="${_esc(iconUrl)}" alt="" style="width:1.5rem;height:1.5rem;">` : '';
    detected.push({ key: `eip6963_${uuid}`, name, icon: safeIcon, getProvider: () => provider });
    seenNames.add(name.toLowerCase());
  }
  if (!detected.length && window.ethereum) detected.push({ key: 'injected', name: 'Browser Wallet', icon: '', getProvider: () => window.ethereum });
  // Named for the account, not the company, because an installed Coinbase
  // extension is listed separately just above under its own EIP-6963 name. They
  // are different accounts — an EOA the extension holds, and a passkey smart
  // account — and offering both under one label would make picking the wrong one
  // the easiest mistake on this sheet. Drawn inline: img-src admits no remote
  // host, and a mark is the one part of a wallet row that has to render.
  const CB_ICON = '<svg width="24" height="24" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#0052FF"/><rect x="11" y="11" width="10" height="10" rx="2" fill="#fff"/></svg>';
  detected.push({ key: 'coinbase', name: 'Coinbase Smart Wallet', icon: CB_ICON });
  const WC_ICON = '<svg width="24" height="16" viewBox="0 0 480 332" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="m126.613 93.9842c62.622-61.3123 164.152-61.3123 226.775 0l7.536 7.3788c3.131 3.066 3.131 8.036 0 11.102l-25.781 25.242c-1.566 1.533-4.104 1.533-5.67 0l-10.371-10.154c-43.687-42.7734-114.517-42.7734-158.204 0l-11.107 10.874c-1.565 1.533-4.103 1.533-5.669 0l-25.781-25.242c-3.132-3.066-3.132-8.036 0-11.102zm280.093 52.2038 22.946 22.465c3.131 3.066 3.131 8.036 0 11.102l-103.463 101.301c-3.131 3.065-8.208 3.065-11.339 0l-73.432-71.896c-.783-.767-2.052-.767-2.835 0l-73.43 71.896c-3.131 3.065-8.208 3.065-11.339 0l-103.4657-101.302c-3.1311-3.066-3.1311-8.036 0-11.102l22.9456-22.466c3.1311-3.065 8.2077-3.065 11.3388 0l73.4333 71.897c.782.767 2.051.767 2.834 0l73.429-71.897c3.131-3.065 8.208-3.065 11.339 0l73.433 71.897c.783.767 2.052.767 2.835 0l73.431-71.895c3.132-3.066 8.208-3.066 11.339 0z" fill="#3396ff"/></svg>';
  detected.push({ key: 'walletconnect', name: 'WalletConnect', icon: WC_ICON });
  return detected;
}

// --- DOM: inject modal only (button rendered by app) ---
function injectWalletModal() {
  if (document.getElementById('walletModal')) return;
  const overlay = document.createElement('div');
  overlay.className = 'wallet-modal-overlay';
  overlay.id = 'walletModal';
  overlay.onclick = function(e) { if (e.target === this) closeWalletModal(); };
  overlay.innerHTML = `<div class="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="walletModalTitle">
    <div class="wallet-modal-header">
      <div class="wallet-modal-title" id="walletModalTitle">Connect Wallet</div>
      <button class="wallet-modal-close" onclick="closeWalletModal()" aria-label="Close">✕</button>
    </div>
    <div class="wallet-modal-body" id="walletOptions"></div>
  </div>`;
  document.body.appendChild(overlay);
}

// --- Modal ---
let _walletFocusReturn = null;
function showWalletModal() {
  injectWalletModal();
  _walletFocusReturn = document.activeElement;
  document.getElementById('walletModal').classList.add('active');
  document.body.classList.add('modal-open');
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const closeBtn = document.querySelector('.wallet-modal-close');
  if (closeBtn) closeBtn.focus();
  window.dispatchEvent(new Event('ms:overlay-change'));
  setTimeout(() => {
    const wallets = detectWallets();
    const container = document.getElementById('walletOptions');
    if (_connectedAddress) {
      container.innerHTML = `<div class="wallet-addr-display">${_esc(_connectedAddress)}</div>
        <button type="button" class="wallet-option disconnect" onclick="disconnectWallet()"><span class="wallet-option-name">Disconnect</span></button>`;
      const first = container.querySelector('.wallet-option');
      if (first && document.activeElement === closeBtn) first.focus();
    } else {
      container.innerHTML = wallets.length > 0 ? wallets.map(w =>
        `<button type="button" class="wallet-option" data-wallet-key="${_esc(w.key)}">${w.icon ? `<span class="wallet-option-icon" aria-hidden="true">${w.icon}</span>` : ''}<span class="wallet-option-name">${_esc(w.name)}</span></button>`
      ).join('') : '<div style="padding:16px;text-align:center;font-size:11px;letter-spacing:2px;color:var(--d)">NO WALLETS DETECTED</div>';
      container.querySelectorAll('[data-wallet-key]').forEach(el => {
        el.addEventListener('click', () => connectWithWallet(el.dataset.walletKey));
      });
      const firstOpt = container.querySelector('.wallet-option');
      if (firstOpt && document.activeElement === closeBtn) firstOpt.focus();
    }
  }, 200);
}

window.closeWalletModal = function() {
  const modal = document.getElementById('walletModal');
  if (modal) modal.classList.remove('active');
  document.body.classList.remove('modal-open');
  // The app may still have an overlay of its own underneath; let it restate the
  // lock rather than assuming this sheet was the only thing holding it.
  window.dispatchEvent(new Event('ms:overlay-change'));
  // The app rebuilds its header from innerHTML, so the node that opened this
  // sheet is often gone by now — fall back to whatever is playing that role.
  const back = _walletFocusReturn; _walletFocusReturn = null;
  const target = (back && back.isConnected) ? back : document.querySelector('.wallet-btn');
  if (target && typeof target.focus === 'function') target.focus();
};
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('walletModal');
  if (modal && modal.classList.contains('active')) { e.stopPropagation(); window.closeWalletModal(); }
}, true);
window.toggleWallet = function() { showWalletModal(); };
window.showWalletModal = showWalletModal;

// --- Connect ---
async function connectWithWallet(walletKey) {
  if (_isConnecting) return;
  _isConnecting = true;
  _walletConnecting = true;
  notifyDisplayUpdate();
  try {
    closeWalletModal();
    let walletProvider;
    if (walletKey === 'walletconnect') {
      walletProvider = await getWalletConnectProvider();
      await walletProvider.enable();
    } else if (walletKey === 'coinbase') {
      // No enable() of its own — eth_requestAccounts below is what opens the
      // passkey popup, the same call every injected wallet answers.
      walletProvider = await getCoinbaseProvider();
    } else if (walletKey.startsWith('eip6963_')) {
      const uuid = walletKey.replace('eip6963_', '');
      walletProvider = eip6963Providers.get(uuid)?.provider;
      if (!walletProvider) {
        const savedName = _lsGet('ms_wallet_name')?.toLowerCase();
        if (savedName) {
          for (const [, { info, provider }] of eip6963Providers) {
            if (info?.name?.toLowerCase() === savedName) { walletProvider = provider; break; }
          }
        }
      }
    } else {
      walletProvider = window.ethereum;
    }
    if (!walletProvider) throw new Error('Wallet not found');

    if (walletKey !== 'walletconnect') await walletProvider.request({ method: 'eth_requestAccounts' });

    // Switch to target chain. BigInt rather than a parse: WalletConnect answers
    // eth_chainId with a number and an injected wallet with a hex string, and
    // BigInt is the one reading that is right for both.
    const chainId = await walletProvider.request({ method: 'eth_chainId' });
    if (BigInt(chainId) !== BigInt(_targetChainId)) {
      const cameFrom = typeof chainId === 'string' && /^0x/i.test(chainId)
        ? chainId : '0x' + Number(chainId).toString(16);
      try {
        await walletProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: _targetChainHex }] });
      } catch (switchErr) {
        if (switchErr.code === 4902 && _addChainParams) {
          await walletProvider.request({ method: 'wallet_addEthereumChain', params: [_addChainParams] });
        } else if (walletKey === 'walletconnect' || walletKey === 'coinbase') {
          // Not fatal here. A WalletConnect session holds an account per chain
          // the wallet approved, and a chain it declined cannot be switched to
          // at all; the smart wallet supports a fixed list and will refuse a
          // chain outside it, MegaETH among them today. Either way that is a
          // reason to connect and say so, not to refuse the connection over a
          // chain the operator may not be about to sign on. The app already
          // tells a wallet sitting on the wrong chain to switch before signing.
          console.warn('chain switch declined by wallet:', switchErr);
        } else throw switchErr;
      }
      // ...and the switch reporting success is not the same as the session having
      // an account there. WalletConnect will happily point itself at a chain the
      // wallet never approved, and on that chain eth_accounts is empty and ethers
      // cannot build a signer at all — so the whole connect would fail, silently,
      // for a chain switch. Point it back at the chain it answered on and let the
      // app say what it says about any wallet sitting elsewhere: switch to sign.
      if (walletKey === 'walletconnect') {
        try {
          const accts = await walletProvider.request({ method: 'eth_accounts' });
          if (!accts || !accts.length) {
            await walletProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: cameFrom }] });
          }
        } catch (e) { console.warn('WalletConnect account check:', e); }
      }
    }

    // 'any' is load-bearing, not a default spelled out. Without it ethers detects
    // the chain on first use and pins the provider to it, then throws
    // NETWORK_ERROR "network changed: 1 => 8453" at everything that touches it
    // once the wallet moves. This app switches chains as a matter of course, and a
    // multichain deploy switches *mid-run*: the vault landed on Base, the receipt
    // was mined, and tx.wait() threw on the way back because the provider had
    // decided its network was a constant. The row went red over a deployed vault,
    // the run walked on to the next chain and did the same again, and neither
    // clone was ever recorded — the DB write sits after the throw.
    _walletProvider = _browserProvider(walletProvider);
    _signer = await _walletProvider.getSigner();
    _connectedAddress = await _signer.getAddress();
    _walletDisplayName = _connectedAddress.slice(0,6) + '...' + _connectedAddress.slice(-4);
    _walletConnecting = false;
    const oldWP = _connectedWalletProvider;
    _connectedWalletProvider = walletProvider;

    resolveWeiName(_connectedAddress);

    if (oldWP && _walletEventHandlers) {
      try {
        oldWP.removeListener('accountsChanged', _walletEventHandlers.accountsChanged);
        oldWP.removeListener('chainChanged', _walletEventHandlers.chainChanged);
      } catch (e) {}
    }
    // A wallet-side chain or account change used to reload the page. That resyncs,
    // and it also throws away whatever the app was in the middle of — most
    // destructively a multichain deploy, which switches chains *itself*: asking
    // the wallet for chain 2 fired chainChanged, which reloaded the page out from
    // under the run, losing the create form, the mined salt and every chain that
    // had not been signed for yet. Hand the event to the app when it is willing
    // to absorb one, and reload only as a fallback for a page that is not.
    _walletEventHandlers = {
      accountsChanged: accts => {
        _onAccountsChanged(accts).catch(e => { console.error('accountsChanged:', e); window.location.reload(); });
      },
      chainChanged: hex => {
        const id = typeof hex === 'string' ? parseInt(hex, 16) : Number(hex);
        if (!Number.isFinite(id) || id <= 0) { window.location.reload(); return; }
        // Keep the switch target in step with where the wallet actually is, so a
        // later auto-reconnect or preflight does not try to drag it back to a
        // chain it left.
        _targetChainId = id;
        _targetChainHex = '0x' + id.toString(16);
        onTargetChainChanged();
        if (typeof window.onWalletChainChanged === 'function') {
          try { window.onWalletChainChanged(id); return; } catch (e) { console.error('onWalletChainChanged:', e); }
        }
        window.location.reload();
      }
    };
    walletProvider.on('accountsChanged', _walletEventHandlers.accountsChanged);
    walletProvider.on('chainChanged', _walletEventHandlers.chainChanged);

    _lsSet('ms_wallet', walletKey);
    if (walletKey.startsWith('eip6963_')) {
      const uuid = walletKey.replace('eip6963_', '');
      const name = eip6963Providers.get(uuid)?.info?.name;
      if (name) _lsSet('ms_wallet_name', name);
    }
    notifyDisplayUpdate();
    for (const fn of _onConnectCallbacks) { try { fn(); } catch (e) { console.error('onConnect error:', e); } }
  } catch (error) {
    console.error('Wallet connect error:', error);
    _walletConnecting = false;
    _walletDisplayName = null;
    notifyDisplayUpdate();
  } finally { _isConnecting = false; }
}

window.disconnectWallet = function() {
  if (_connectedWalletProvider && _walletEventHandlers) {
    try {
      _connectedWalletProvider.removeListener('accountsChanged', _walletEventHandlers.accountsChanged);
      _connectedWalletProvider.removeListener('chainChanged', _walletEventHandlers.chainChanged);
    } catch (e) {}
  }
  _walletEventHandlers = null;

  if (_walletConnectProvider) {
    try { _walletConnectProvider.disconnect(); } catch (e) {}
    _walletConnectProvider = null;
  }
  // The smart wallet's session outlives this page unless it is ended here.
  // Dropping the saved choice stops auto-reconnect, but it would not stop the
  // next Connect from coming back authorised with no passkey prompt — so
  // disconnecting would have logged the operator out of the interface and not
  // out of the account. On a shared machine that is the whole point of the
  // button. The provider goes with it, so the next connect builds a new one.
  if (_coinbaseProvider) {
    try { _coinbaseProvider.disconnect(); } catch (e) {}
    _coinbaseProvider = null;
  }
  _cbProviderPromise = null;

  _walletProvider = null;
  _signer = null;
  _connectedAddress = null;
  _nameOf = _blankNames(null);
  _connectedWalletProvider = null;
  _walletDisplayName = null;
  _walletConnecting = false;

  closeWalletModal();
  _lsDel('ms_wallet'); _lsDel('ms_wallet_name');
  for (const fn of _onDisconnectCallbacks) { try { fn(); } catch (e) {} }
};

window.connectWallet = async function() {
  if (_signer) return _signer;
  showWalletModal();
  return null;
};

// --- Name resolution ---
const _ethRpcs = ['https://ethereum.publicnode.com','https://1rpc.io/eth','https://eth.drpc.org'];
const _ethMainProvider = new ethers.FallbackProvider(
  _ethRpcs.map((url, i) => ({ provider: new ethers.JsonRpcProvider(url, 1, {staticNetwork:true}), priority: i + 1, stallTimeout: 2000 })), 1, { quorum: 1 }
);

// The chain-local namespaces — Basenames on Base, MegaNames on MegaETH — are
// owned by the app, which holds their resolvers, caches and rate budget. This
// file loads first, so the list is read at call time and everything here
// degrades to "mainnet names only" if it is not there.
function _localNs() { return window.localNames || []; }

// What the connected account is called, held per namespace rather than as one
// string. Switching chains then re-picks which name to show instead of
// re-resolving — an account with both a .eth and a Basename would otherwise
// flicker back to its hex address and re-fetch on every switch, and this app
// switches chains constantly.
let _nameOf = { addr: null, eth: null, local: {}, asked: {} };
function _blankNames(addr) { return { addr: addr || null, eth: null, local: {}, asked: {} }; }
function _shortAddr(a) { return a.slice(0, 6) + '...' + a.slice(-4); }
function _applyWalletName() {
  const addr = _connectedAddress;
  if (!addr || _nameOf.addr !== addr) return;
  // The same precedence the signer list uses, so a person reads the same in the
  // header as they do in their own row: the chain you are on names you first,
  // then a mainnet name, then any other chain-local one in list order.
  let pick = _nameOf.local[_targetChainId] || _nameOf.eth || null;
  if (!pick) for (const ns of _localNs()) { if (_nameOf.local[ns.chainId]) { pick = _nameOf.local[ns.chainId]; break; } }
  const next = pick || _shortAddr(addr);
  if (next === _walletDisplayName) return;
  _walletDisplayName = next;
  notifyDisplayUpdate();
}

// Ask one chain-local namespace what it calls this account. Once per account
// per namespace, hit or miss; a lookup that could not complete is un-asked so a
// later chain switch can try it again.
function _resolveLocalName(addr, chainId) {
  const ns = _localNs().find(n => n.chainId === chainId);
  if (!ns || _nameOf.addr !== addr || _nameOf.local[chainId] || _nameOf.asked[chainId]) return;
  _nameOf.asked[chainId] = true;
  ns.reverse(addr).then(name => {
    if (!name || _nameOf.addr !== addr) return;
    _nameOf.local[chainId] = String(name).toLowerCase();
    _applyWalletName();
  }).catch(() => { if (_nameOf.addr === addr) _nameOf.asked[chainId] = false; });
}
function _resolveAllLocalNames(addr) {
  for (const ns of _localNs()) _resolveLocalName(addr, ns.chainId);
}

// Name the connected wallet: .wei, then .gwei, then ENS, then the chain-local
// namespaces. Each mainnet step only runs if the one before it came back empty,
// so the preferred name always wins — except on a chain that has a namespace of
// its own, where that one is asked for straight away because it is what will be
// displayed there whatever mainnet says.
//
// The mainnet chain runs on those chains too. It is what the account is called
// the moment the app moves off them, and this app moves between chains as a
// matter of course; finding it out during the switch would cost a round trip
// with the header already repainted.
function resolveWeiName(addr) {
  _nameOf = _blankNames(addr);
  try {
    const apply = name => {
      if (_nameOf.addr !== addr) return;      // account changed — drop it
      _nameOf.eth = String(name).toLowerCase();
      _applyWalletName();
    };
    const tryEns = () => {
      _ethMainProvider.lookupAddress(addr).then(ensName => {
        if (ensName) apply(ensName);
        else _resolveAllLocalNames(addr);     // nothing on mainnet — try the rest
      }).catch(() => _resolveAllLocalNames(addr));
    };
    const tryNS = (registry, next) => {
      const ns = new ethers.Contract(registry, WEINS_ABI, _ethMainProvider);
      ns.reverseResolve(addr).then(name => {
        if (name) apply(name);
        else next();
      }).catch(next);
    };
    tryNS(WEINS, () => tryNS(GWEINS, tryEns));
  } catch (e) {}
  _resolveLocalName(addr, _targetChainId);
}
window.resolveWeiName = resolveWeiName;

// The app moved to another chain. Re-pick the name from what is already known,
// and go and find that chain's own name if arriving there is the first time it
// has been worth asking for.
function onTargetChainChanged() {
  if (!_connectedAddress) return;
  _resolveLocalName(_connectedAddress, _targetChainId);
  _applyWalletName();
}

// The selected account changed under us. Re-derive the signer for the new account
// so the app can resync in place — a reload here is what stopped the deploy loop's
// own "switch back to <deployer>" guard from ever being reachable, because the
// page was gone before the next chain could notice the salt no longer matched its
// signer. An empty list is the wallet locking or revoking this site: a disconnect.
async function _onAccountsChanged(accts) {
  const next = Array.isArray(accts) ? accts[0] : null;
  const canDelegate = typeof window.onWalletAccountsChanged === 'function';
  if (!next) {
    if (canDelegate) window.disconnectWallet();
    else window.location.reload();
    return;
  }
  if (_connectedAddress && next.toLowerCase() === _connectedAddress.toLowerCase()) return;
  if (!canDelegate || !_connectedWalletProvider) { window.location.reload(); return; }
  const prev = _connectedAddress;
  _walletProvider = _browserProvider(_connectedWalletProvider);
  _signer = await _walletProvider.getSigner();
  _connectedAddress = await _signer.getAddress();
  _walletDisplayName = _connectedAddress.slice(0, 6) + '...' + _connectedAddress.slice(-4);
  resolveWeiName(_connectedAddress);
  notifyDisplayUpdate();
  window.onWalletAccountsChanged(_connectedAddress, prev);
}

function notifyDisplayUpdate() {
  if (typeof window.onWalletDisplayUpdate === 'function') {
    try { window.onWalletDisplayUpdate(); } catch(e) {}
  }
}

// --- Auto-reconnect ---
async function tryAutoConnect() {
  const savedWallet = _lsGet('ms_wallet');
  if (!savedWallet) return;
  _walletConnecting = true;
  notifyDisplayUpdate();
  await new Promise(r => setTimeout(r, 400));
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise(r => setTimeout(r, 300));
  try {
    let probe;
    if (savedWallet.startsWith('eip6963_')) {
      const uuid = savedWallet.replace('eip6963_', '');
      probe = eip6963Providers.get(uuid)?.provider;
      if (!probe) {
        const savedName = _lsGet('ms_wallet_name')?.toLowerCase();
        if (savedName) {
          for (const [, { info, provider }] of eip6963Providers) {
            if (info?.name?.toLowerCase() === savedName) { probe = provider; break; }
          }
        }
      }
    } else if (savedWallet === 'walletconnect') {
      // A saved WalletConnect choice is not a live session. The pairing can be
      // dropped from the phone or expire on its own, and `init()` reports that by
      // handing back a provider with no session rather than by failing — so
      // `enable()` would go straight on to open the QR modal, and a returning
      // visitor would be asked to scan a code on page load, having asked for
      // nothing. Restore the provider, and treat "no session came back with it"
      // the way the injected branch treats an empty `eth_accounts`. The saved
      // choice goes too: an expired session is not something a later load can
      // pick up, so keeping it would only buy the same 635 KB every visit.
      const wc = await getWalletConnectProvider();
      if (!wc.session) {
        _lsDel('ms_wallet');
        _walletConnecting = false;
        notifyDisplayUpdate();
        return;
      }
    } else if (savedWallet === 'coinbase') {
      // The SDK keeps its own session, so a returning visitor whose passkey
      // session is still live reconnects with no popup — and one whose session
      // has gone answers an empty eth_accounts below and is left disconnected
      // rather than having a popup opened at them on page load, which is the
      // same rule the injected branch follows.
      probe = await getCoinbaseProvider();
    } else {
      probe = window.ethereum;
    }
    if (probe) {
      const accts = await probe.request({ method: 'eth_accounts' });
      if (!accts || accts.length === 0) { _walletConnecting = false; notifyDisplayUpdate(); return; }
    }
    await connectWithWallet(savedWallet);
  } catch (e) {
    _walletConnecting = false;
    _walletDisplayName = null;
    notifyDisplayUpdate();
  } finally {
    if (!_connectedAddress && typeof window._onAutoReconnectFail === 'function') {
      try { window._onAutoReconnectFail(); } catch (_) {}
    }
  }
}

// --- Public API ---
window.walletInit = function(opts) {
  _appName = opts.appName || 'Multisig';
  _targetChainId = opts.chainId || 1;
  _targetChainHex = opts.chainHex || '0x' + _targetChainId.toString(16);
  _targetRpc = opts.rpc || 'https://ethereum.publicnode.com';
  _addChainParams = opts.addChainParams || null;
  _wcChains = Array.isArray(opts.chains) && opts.chains.length ? opts.chains.slice() : null;
  _onConnectCallbacks = Array.isArray(opts.onConnect) ? opts.onConnect : (opts.onConnect ? [opts.onConnect] : []);
  _onDisconnectCallbacks = Array.isArray(opts.onDisconnect) ? opts.onDisconnect : (opts.onDisconnect ? [opts.onDisconnect] : []);
  if (opts.pollMs) window.walletSetPollMs(opts.pollMs);
  injectWalletModal();
  tryAutoConnect();
};

// Called by the app whenever the chain under it changes, from either direction —
// its own switcher or the wallet moving on its own. The live provider is updated
// as well as the next one built: a wait already in flight is exactly the case
// this is for, and a provider is not rebuilt on a chain change (deliberately, so
// a switch mid-deploy does not throw away the run).
window.walletSetPollMs = function(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return;
  _pollMs = n;
  try { if (window._walletProvider) window._walletProvider.pollingInterval = n; } catch (e) {}
};

// Every code path here used to end in an empty catch, which collapsed three
// different outcomes — the user declined, the wallet has never heard of this
// chain, the request worked — into the same silence. A multichain deploy has to
// tell them apart to say anything useful about a chain it could not reach, so
// report the outcome instead of throwing or swallowing it.
function _switchErrCode(e) {
  return e && (e.code !== undefined ? e.code : (e.data && e.data.originalError && e.data.originalError.code));
}
const _rejected = c => c === 4001 || c === 'ACTION_REJECTED';

// Re-derive the provider and signer against the wallet's chain as it stands now.
// 'any' above is what keeps a moved chain from throwing, but it does not undo a
// signer that is already mid-flight against the old one, and the deploy loop
// needs a definite answer at a definite moment rather than a provider that will
// notice on its own eventually. So this is the awaited version of that: cheap
// (two provider calls, no wallet prompt), and it hands back the signer it built
// so the caller cannot pick up the previous one by mistake.
//
// The account is named rather than taken as whichever one the wallet is offering,
// and _connectedAddress is read but never written. Both halves of that are the
// same point: this function's job is the chain, not the identity. A bare
// getSigner() returns the *selected* account, so an account switched under us
// mid-run would be adopted here silently — and the deploy loop's guard against
// exactly that compares against _connectedAddress, which has not been updated
// yet either, so it would wave through a signer for someone else and the factory
// would revert on a salt bound to the original deployer, after the prompt was
// approved. Naming the address makes ethers refuse instead: the previous signer
// stays, and accountsChanged — whose business this is — gets to report the swap
// where the operator can see it.
// Resolves { signer } on success, { moved: true } when the wallet no longer offers
// the account this session belongs to, or null when there is no wallet to ask.
// "Moved" is reported rather than absorbed: the caller is about to sign something
// bound to a particular account, and it is the only layer that knows what to say
// about that. Nothing is installed in that case — the previous signer stays, and
// stale is safer than confidently wrong.
window.walletRebindSigner = async function() {
  if (!_connectedWalletProvider) return null;
  const p = _browserProvider(_connectedWalletProvider);
  let s;
  if (_connectedAddress) {
    // getSigner(address) checks the address against the wallet's accounts and
    // throws if it is not among them, which is the signal wanted here.
    try { s = await p.getSigner(_connectedAddress); }
    catch (e) { return { moved: true }; }
  } else {
    s = await p.getSigner();
  }
  _walletProvider = p;
  _signer = s;
  return { signer: s };
};

// Switch chain at runtime. Resolves to { ok, rejected?, unsupported?, code?, error? }.
window.walletSwitchChain = async function(opts) {
  _targetChainId = opts.chainId;
  _targetChainHex = opts.chainHex || '0x' + opts.chainId.toString(16);
  _targetRpc = opts.rpc || _targetRpc;
  _addChainParams = opts.addChainParams || null;
  onTargetChainChanged();
  if (!_connectedWalletProvider) return { ok: true, noWallet: true };
  try {
    const current = await _connectedWalletProvider.request({method:'eth_chainId'});
    if (BigInt(current) === BigInt(_targetChainId)) return { ok: true, already: true };
  } catch (_) { /* chain id unreadable — ask for the switch anyway */ }
  try {
    await _connectedWalletProvider.request({method:'wallet_switchEthereumChain', params:[{chainId:_targetChainHex}]});
    return { ok: true };
  } catch (e) {
    const code = _switchErrCode(e);
    if (_rejected(code)) return { ok: false, rejected: true, code, error: e };
    // 4902 — the wallet does not know this chain (some wrap it in -32603). Add
    // it, then ask for the switch *again*: adding leaves some wallets on the
    // chain they were already on, and assuming otherwise is how a deploy ended
    // up signing on the previous chain's network.
    if ((code === 4902 || code === -32603) && _addChainParams) {
      try {
        await _connectedWalletProvider.request({method:'wallet_addEthereumChain', params:[_addChainParams]});
      } catch (addErr) {
        const ac = _switchErrCode(addErr);
        if (_rejected(ac)) return { ok: false, rejected: true, code: ac, error: addErr };
        return { ok: false, unsupported: true, code: ac, error: addErr };
      }
      try {
        await _connectedWalletProvider.request({method:'wallet_switchEthereumChain', params:[{chainId:_targetChainHex}]});
        return { ok: true, added: true };
      } catch (e2) {
        const c2 = _switchErrCode(e2);
        return { ok: false, added: true, rejected: _rejected(c2), code: c2, error: e2 };
      }
    }
    if (code === 4902) return { ok: false, unsupported: true, code, error: e };
    return { ok: false, code, error: e };
  }
};

})();
