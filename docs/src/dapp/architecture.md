# Architecture

## No build step

`dapp/index.html` is the whole application — markup, styles and logic in one file —
and it runs when opened. `ethers` and WalletConnect are vendored next to it rather
than pulled from a CDN, so the app has no build pipeline to trust and no third-party
script host to depend on. WalletConnect is ~635 KB and only needed if the user picks
it, so it is injected on demand, once, with concurrent callers sharing a single
download.

Serving it is copying a directory. `render.yaml` publishes `./dapp` as a static
site, but nothing about the app requires that host.

## Content Security Policy

`index.html` carries its own CSP in a `<meta>` tag. `default-src 'self'`, `img-src`
limited to `'self'` and `data:`, and `connect-src` enumerated: the PostgREST
service, Sourcify, the RPC hosts for the seven supported chains, the Coinbase price
endpoint, and `wss:` for WalletConnect. Fonts come from Google Fonts and are the
only external style and font sources.

`render.yaml` notes the alternative of serving the same policy as a real response
header instead of a meta tag, which is stricter; the meta form is what ships so the
file is self-contained.

## RPC resilience

Each chain is read through an ethers `FallbackProvider` over two or three public
RPCs with a one-provider quorum and a 2-second stall timeout.

One detail is load-bearing. A `FallbackProvider` is not self-healing: ethers marks a
backend with `_lastFatalError` the first time its `getBlockNumber` throws and never
clears it, and once every backend carries one, the provider answers *"no runners?!"*
to everything from then on. Cached forever, a single network blip — a sleeping
laptop, a dropped tunnel — would silently kill a chain for the rest of the page
session. Mainnet is the worst one to lose, because every `.eth` / `.wei` / `.gwei`
name is resolved there no matter which chain the app is on, so a wedged mainnet
provider would take name resolution down everywhere. The app therefore watches for
that error and rebuilds the provider on the next call.

### One deliberate exception

[Simulation](interface.md#simulation) is the one read that does not go through the
`FallbackProvider`. `eth_simulateV1` is not part of the standard provider surface, so
it is sent as a raw `send()` over a single `JsonRpcProvider` built on the chain's
first RPC and cached per chain.

The trade is accepted rather than overlooked: a chain whose primary RPC does not
implement the method, or is down, loses the rich simulation and falls back to
`eth_call` plus `estimateGas` over the resilient provider — degraded to a revert
check, labelled as such in the panel, never silently wrong. A dry-run is advisory,
so losing detail is tolerable in a way that losing a balance read would not be.

## Name resolution

`wallet.js` handles wallet connection and name resolution. Two registries are read,
both on mainnet, with identical ABIs: WNS (`.wei`) and its fork GNS (`.gwei`).
Reverse resolution tries WNS first, then GNS, then ENS — so `.wei` wins where both
exist. Resolution is always a mainnet read, whichever chain is selected.

## The optional data layer

Off-chain proposals and the signatures collected against them have to live
somewhere. Signatures are EIP-712 blobs that mean nothing until `threshold` of them
are submitted together, and until then nothing about them exists on-chain.

`db/` and `render.yaml` provision that store: Postgres plus **self-hosted
PostgREST**, both on Render. Six tables — `wallets`, `owners`, `transactions`,
`signatures`, `approvals`, `config_log` — with three views for the queries the UI
actually makes.

The privilege model is the part worth reading before deploying it:

- The browser talks to PostgREST as an **anonymous role**, with no credentials
  shipped in the page.
- **Reads** are plain `SELECT`s gated by row-level security policies. Everything in
  here is public chain data or a signature that is worthless alone, so the policies
  are permissive by design rather than by omission.
- **Writes** go only through `SECURITY DEFINER` functions — `register_wallet`,
  `propose_tx`, `add_signature`, `mark_executed`, `mark_queued`, `cancel_tx`, and so
  on — each of which runs its own owner check. The anonymous role has no direct
  `INSERT`, `UPDATE` or `DELETE` on any table.
- PostgREST connects as a low-privilege `authenticator` login that only holds the
  right to `SET ROLE anon`. It must **not** connect as the database owner. Render
  only auto-exposes the owner connection string, which is why `PGRST_DB_URI` is set
  by hand and marked `sync: false` so it never reaches version control.

Setup is three steps, documented at the top of `render.yaml`: run `db/schema.sql`,
run `db/roles.sql`, then set a password on `authenticator` and point `PGRST_DB_URI`
at it.

### What depends on it, and what does not

The database is the **only** store for off-chain proposals and signatures, so a
dropped write loses coordination state. Client requests therefore retry: a 12-second
per-attempt timeout, four attempts, exponential backoff with jitter, retrying network
failures and transient statuses (408, 425, 429, 5xx). Only operations that are
idempotent or self-healing go through that path — reads, upserts, and nonce marks
that are reconciled against on-chain state by a state sync on the next load.

What does **not** depend on it:

- Reading any wallet. Owners, threshold, delay, executor, nonce, balances and the
  queue are all read from the chain.
- Deploying a wallet, and verifying the deployment.
- Executing anything. Submission is a chain transaction.
- **On-chain approvals.** `approve(hash, true)` registers authorisation in the
  wallet's own storage, so a wallet whose owners approve on-chain needs no
  coordination service at all — it keeps working if this app, its database and its
  operator all disappear. That independence is the reason the option exists, even
  though most signers should prefer the cheaper, private, front-run-resistant
  off-chain route. See
  [Signatures](../protocol/signatures.md#on-chain-approval).

## Client-side state

Preferences and the wallet list are kept in `localStorage` — theme (`ms_light`),
balance privacy (`ms_priv`), selected chain (`ms_chain`), last connected wallet
(`ms_wallet`), and user-added custom tokens. Custom tokens are validated on load
rather than trusted, and their `symbol` and `decimals` are read from the token
contract rather than taken from what was typed.

## In-app documentation

`dapp/docs.html` is the user-facing documentation, assembled client-side into five
hash-addressable tabs — `#overview`, `#contract`, `#executor`, `#interface`,
`#audits` — so the app footer can link straight to a section. An unknown or absent
hash falls back to OVERVIEW rather than rendering an empty page, and a `<noscript>`
block points at the repository for readers with JavaScript off.

That page and this book cover the same ground for different readers: `docs.html`
answers questions a user has while operating a wallet, and is shipped with the app;
this book is the repository's reference, and is the place where the protocol is
documented independently of any client.
