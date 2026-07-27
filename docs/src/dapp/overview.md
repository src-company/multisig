# The Interface

`dapp/` is the client for the protocol: a static single-page application that
deploys wallets, builds proposals, collects signatures and drives the timelock. It
has no build step. `index.html` is opened directly and works.

It is one client, not the protocol's coordination layer. Everything it does can be
done with `cast` and a text editor, and a wallet whose owners
[approve on-chain](../protocol/signatures.md#on-chain-approval) keeps working if this
app, its database and its operator all disappear.

## What it is made of

| File                      | Role                                                                             |
|---------------------------|----------------------------------------------------------------------------------|
| `index.html`              | The whole application — markup, styles and logic in one file                      |
| `docs.html`               | In-app documentation, rendered client-side, tab-addressable by URL hash           |
| `wallet.js`               | Wallet connection, and `.wei`/`.gwei`/`.eth` name resolution                       |
| `wallet.css`              | Styles for the connection UI                                                      |
| `ethers.min.js`           | Vendored ethers v6 — no CDN, so the app runs from a local file or an offline host  |
| `walletconnect.min.js`    | Vendored WalletConnect, ~635 KB, injected on demand rather than on load           |

There is no framework and no bundler. The tradeoff is deliberate: a wallet client
that anyone can read end to end, serve from anywhere, and audit without trusting a
build pipeline.

## Chains

Seven networks, with the same wallet address on each via CREATE2:

| Network      | Chain ID   | Explorer                          |
|--------------|------------|-----------------------------------|
| Ethereum     | 1          | etherscan.io                      |
| Base         | 8453       | basescan.org                      |
| Arbitrum     | 42161      | arbiscan.io                       |
| OP Mainnet   | 10         | optimistic.etherscan.io           |
| MegaETH      | 4326       | mega.etherscan.io                 |
| Sepolia      | 11155111   | sepolia.etherscan.io (testnet)    |
| Base Sepolia | 84532      | sepolia.basescan.org (testnet)    |

Each chain is read through a `FallbackProvider` over two or three public RPCs with
a one-provider quorum. Ethereum is read on every chain regardless of which one is
selected, because all name resolution lives there.

## Tokens

Balances and the transfer builder cover a per-chain list, with decimals handled
explicitly so a human-readable amount always converts to the right raw units.

| Network    | Tokens                                          |
|------------|-------------------------------------------------|
| Ethereum   | ETH, USDC, USDT, DAI, WBTC, wstETH              |
| Base       | ETH, USDC, USDT, DAI, cbBTC, wstETH             |
| Arbitrum   | ETH, USDC, USDT, DAI, WBTC, wstETH              |
| OP Mainnet | ETH, USDC, USDT, DAI, WBTC, wstETH              |
| MegaETH    | ETH, MEGA, USDm, USDT0, WBTC, wstETH            |
| Testnets   | ETH                                             |

Decimals: ETH/DAI/wstETH/MEGA/USDm 18, USDC/USDT/USDT0 6, WBTC/cbBTC 8 — USDm is
dollar-pegged but carries 18, not the 6 a stablecoin is usually read as. Any other token can
be reached through the [custom-call builder](interface.md#tx-builder), and
user-added tokens are read for their real `symbol` and `decimals` rather than
assumed.

The wallet itself accepts native ETH through `receive()` and ERC-721/1155 through
the [fallback callbacks](../protocol/overview.md#token-callbacks).

## What to read next

- [Using the Interface](interface.md) — the screens, and what each one submits
- [Guardrails](guardrails.md) — every proposal the app refuses to build, and why
- [Architecture](architecture.md) — hosting, the optional data layer, and what
  happens without it
