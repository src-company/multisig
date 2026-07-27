(function() {
'use strict';

// WNS (.wei) and its direct fork GNS (.gwei) — identical ABI, both on mainnet.
// Reverse resolution is tried in this order, so .wei wins when both exist.
const WEINS = '0x0000000000696760E15f265e828DB644A0c242EB';
const GWEINS = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6';
const WEINS_ABI = ['function reverseResolve(address) view returns (string)'];
const WC_PROJECT_ID = '1e8390ef1c1d8a185e035912a1409749';

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
      await loadWalletConnect();
      const wcModule = globalThis['@walletconnect/ethereum-provider'];
      const WCProvider = wcModule?.EthereumProvider;
      if (!WCProvider?.init) throw new Error('WalletConnect not available');
      if (_walletConnectProvider) { try { await _walletConnectProvider.disconnect?.(); } catch (e) {} _walletConnectProvider = null; }
      _walletConnectProvider = await WCProvider.init({ projectId: WC_PROJECT_ID, chains: [_targetChainId], showQrModal: true, rpcMap: { [_targetChainId]: _targetRpc }, metadata: { name: _appName, description: _appName, url: window.location.origin, icons: [] } });
      await _walletConnectProvider.enable();
      walletProvider = _walletConnectProvider;
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

    // Switch to target chain
    const chainId = await walletProvider.request({ method: 'eth_chainId' });
    if (BigInt(chainId) !== BigInt(_targetChainId)) {
      try {
        await walletProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: _targetChainHex }] });
      } catch (switchErr) {
        if (switchErr.code === 4902 && _addChainParams) {
          await walletProvider.request({ method: 'wallet_addEthereumChain', params: [_addChainParams] });
        } else throw switchErr;
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
    _walletProvider = new ethers.BrowserProvider(walletProvider, 'any');
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

  _walletProvider = null;
  _signer = null;
  _connectedAddress = null;
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

// Name the connected wallet: .wei, then .gwei, then ENS. Each step only runs
// if the one before it came back empty, so the preferred name always wins.
function resolveWeiName(addr) {
  try {
    const apply = name => {
      if (_connectedAddress !== addr) return; // account changed — drop it
      _walletDisplayName = name.toLowerCase();
      notifyDisplayUpdate();
    };
    const tryEns = () => {
      _ethMainProvider.lookupAddress(addr).then(ensName => {
        if (ensName && _connectedAddress === addr) {
          _walletDisplayName = ensName;
          notifyDisplayUpdate();
        }
      }).catch(() => {});
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
}
window.resolveWeiName = resolveWeiName;

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
  _walletProvider = new ethers.BrowserProvider(_connectedWalletProvider, 'any');
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
    } else if (savedWallet !== 'walletconnect') {
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
  _onConnectCallbacks = Array.isArray(opts.onConnect) ? opts.onConnect : (opts.onConnect ? [opts.onConnect] : []);
  _onDisconnectCallbacks = Array.isArray(opts.onDisconnect) ? opts.onDisconnect : (opts.onDisconnect ? [opts.onDisconnect] : []);
  injectWalletModal();
  tryAutoConnect();
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
  const p = new ethers.BrowserProvider(_connectedWalletProvider, 'any');
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
