# Multisig

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="dark-logo.svg">
  <source media="(prefers-color-scheme: light)" srcset="logo.svg">
  <img alt="multisig" src="dark-logo.svg" width="64" height="64">
</picture>

![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)

Minimal k-of-n multisig wallet with optional timelock, executor module, pre/post transaction guards, onchain approvals, batched execution, and delegatecall. Two deployment paths: factory clones and EIP-7702 EOA delegation. All mutable state (`delay`, `nonce`, `threshold`, `ownerCount`, `executor`) is packed into a single storage slot.

![Explainer](explainer.svg)

![Architecture](diagram.svg)

## Usage

```bash
forge build
forge test
```

## Factory Deployment

Deploy a standalone multisig via `MultisigFactory`:

1. `MultisigFactory.create(owners, delay, threshold, executor, salt)` — deploys a deterministic PUSH0 minimal proxy clone and calls `init`.
2. Owners sign EIP-712 `Execute` messages off-chain, approve onchain via `approve(hash, true)`, or submit directly as `msg.sender`.
3. Anyone relays `execute(target, value, data, sigs)` with signatures sorted by signer address (ascending).

The salt must start with `address(0)` (permissionless deploy) or `msg.sender` (sender-bound, for pre-funding). This follows the Solady `LibClone.checkStartsWith` pattern.

When `delay` is set, transactions are queued with an ETA and executed later via `executeQueued`. Cancel queued transactions via `cancelQueued` (self-call only — route through `execute`). Self-calls to `executeQueued` skip the ETA check, enabling executor modules to accelerate already-queued transactions. Use `batch` and `delegateCall` through `execute(address(this), ...)` to atomically bundle calls or run arbitrary code in the wallet's context.

The wallet supports ERC-721 and ERC-1155 token callbacks via the fallback function (`onERC721Received`, `onERC1155Received`, `onERC1155BatchReceived`).

### Factory Deployment with Module Setup

`MultisigFactory.createWithCalls(owners, delay, threshold, executor, salt, targets, values, datas)` deploys a wallet and atomically executes a list of calls to configure singleton modules. The factory temporarily sets itself as executor to bypass signatures during setup, then sets the real executor last.

```solidity
// Deploy wallet with AllowlistGuard configured
address[] memory targets = new address[](1);
uint256[] memory values = new uint256[](1);
bytes[] memory datas = new bytes[](1);
targets[0] = guard;
datas[0] = abi.encodeCall(AllowlistGuard.set, (usdc, IERC20.transfer.selector, true));
factory.createWithCalls(owners, 0, 2, guard, salt, targets, values, datas);
```

## EIP-7702 Deployment

Turn an existing EOA into a multisig-enhanced account:

1. Submit a `SET_CODE_TX` that delegates to the Multisig implementation and calls `init(owners, delay, threshold, executor)` in the same transaction.
2. The EOA now supports `execute`, `batch`, and ERC-1271 `isValidSignature`.
3. Manage configuration atomically via `batch`: `addOwner`, `removeOwner`, `setThreshold`, `setDelay`, `setExecutor`.

The EOA private key remains a superuser — it can send regular transactions and revoke the delegation at any time. Suited for personal wallets where the key holder wants co-signing, not shared custody.

## Signature Types

Each signer occupies a fixed 65-byte slot in the `sigs` array (`r[32] || s[32] || v[1]`), sorted ascending by signer address. Three approval methods:

| `v` | Type | How it works |
|---|---|---|
| `>= 27` | **ECDSA** | Standard off-chain signature. `ecrecover` recovers the signer. |
| `0` | **On-chain approval** | `r` = signer address (left-padded). Owner calls `approve(hash, true)` beforehand. |
| `0` | **Sender bypass** | `r` = signer address. If `msg.sender == signer`, no prior `approve` needed. |

The sender bypass means a 2-of-2 wallet needs only one ECDSA signature — the other owner submits the transaction and their `msg.sender` fills the second slot. For a k-of-n wallet, collect k-1 ECDSA signatures off-chain, then the final owner submits.

Owners can revoke an onchain approval with `approve(hash, false)` before the transaction reaches quorum.

Use `getTransactionHash(target, value, data, nonce)` to compute the EIP-712 digest for signing or approving.

## Executor

An optional `executor` address bypasses both signature verification and timelock delay, enabling two patterns:

**Security Council** — A protocol's admin is a timelocked multisig (e.g. 3-of-5, 2-day delay). The executor is a separate security council (e.g. 5-of-9). During an active exploit, the council calls `execute` directly — no owner signatures, no delay. Owners revoke via `setExecutor(address(0))`.

**Social Recovery** — The executor is a guardian multisig (trusted contacts). If the owner loses their keys, guardians call `execute` to rotate owners via `addOwner`/`removeOwner`/`setThreshold`.

The executor has full control by design. The timelock gives stakeholders an exit window against the *owners* — the executor operates outside it. If the executor is compromised, owners revoke it through the normal timelocked path.

`cancelQueued(hash)` is `onlySelf` — cancel must be routed as a self-call through `execute`. This lets executor modules like `TimelockExecutor` gate cancellation behind signature verification while executing immediately. `executeQueued` skips the ETA check when called by the wallet itself (`msg.sender == address(this)`), enabling executor modules to accelerate already-queued transactions via self-call.

### Guard Mode

The executor doubles as a transaction guard when deployed to a vanity address. Guard behavior is encoded in the address itself — no extra storage, no new functions:

| Leading 2 bytes | Trailing 2 bytes | Behavior |
|---|---|---|
| `0x1111` | any | Pre-transaction guard (called before execution) |
| any | `0x1111` | Post-transaction guard (called after execution) |
| `0x1111` | `0x1111` | Both pre and post guard |
| other | other | Plain executor (no guard calls) |

The guard receives an `execute(target, value, data, sigs)` call — it can inspect the transaction and revert to block it, or no-op to allow. Both `execute` and `executeQueued` trigger guard calls (`executeQueued` passes empty sigs). Mining a 4-byte vanity address (2 leading + 2 trailing) is comparable to mining a 4-byte prefix, feasible in minutes on a GPU.

> **Warning:** If the guard contract cannot handle the forwarded `execute` call (i.e. always reverts), the wallet is bricked — `execute`, `executeQueued`, and `setExecutor` all trigger the guard, so there is no recovery path. Ensure the guard contract correctly implements the `execute` interface before assigning it.
>
> The same applies to a wallet at a `0x1111`-marked address that sets itself as its own executor: each `execute` re-enters itself through the guard hook until it runs out of gas, and `setExecutor` is only reachable through `execute`. **Never call `setExecutor(address(this))`.** Clone wallets have no recovery; an EIP-7702 wallet can recover by revoking its delegation. (Shred Security L-1 — see [`SECURITY.md`](SECURITY.md).)

## Modules

Singleton module contracts in `src/mods/` demonstrate common patterns — each is deployed once and serves all multisigs, keyed by `msg.sender`. Configure via `createWithCalls` at deployment or `execute` after.

| Module | Role | Safe/Zodiac Equivalent |
|---|---|---|
| **AllowlistGuard** | Pre-guard (vanity `0x1111` prefix) | Zodiac TransactionGuard |
| **SpendingAllowance** | Executor | Safe AllowanceModule |
| **SocialRecovery** | Executor | Safe SocialRecoveryModule |
| **DeadmanSwitch** | Post-guard + executor (vanity `0x1111` suffix) | Zodiac Dead Man's Switch |
| **TimelockExecutor** | Executor | — (cancel at threshold, forward at unanimous, accelerate queued) |

### TimelockExecutor

The `TimelockExecutor` module manages the timelock using the same EIP-712 `Execute` typehash as the multisig itself. The UI collects signatures as usual and routes based on count:

| Signatures | Action | Route |
|---|---|---|
| Threshold | Normal execute | `Multisig.execute()` — queues with timelock |
| Threshold + cancel selector | Cancel queued tx | `TimelockExecutor.forward()` — immediate cancel |
| All owners | Immediate execute | `TimelockExecutor.forward()` — bypasses timelock |
| All owners + executeQueued | Accelerate queued tx | `TimelockExecutor.forward()` — consumes queued entry |

Cancel is always available (defensive action). Forward and accelerate require `enableForward(true)` — the timelock is a security boundary that should only be bypassable when the multisig explicitly opts in.

The module supports both ECDSA signatures and onchain approvals (`v=0`), mirroring the multisig's own verification. Signatures are interchangeable between direct `execute()` and module `forward()` — the nonce is consumed atomically, preventing replay across paths.

## Comparison with Safe

| Feature | This Multisig | Safe |
|---|---|---|
| **Source, code lines** | 275 (single file, wallet + factory) | 702 (16 files) |
| **Runtime bytecode, wallet** | 10,532 bytes | 23,579 bytes |
| **Runtime bytecode, feature parity** | 12,881 bytes | 32,680 bytes |
| **Proxy clone size** | 45 bytes (PUSH0) | 45 bytes (EIP-1167) |
| **Storage: core state** | 1 slot (packed) | Multiple slots |
| **SLOAD/SSTORE for state** | 1 / 1 | Multiple |
| **Timelock** | Built-in (`delay`) | Modular (Zodiac Delay) |
| **Executor role** | Built-in | Modular (`execTransactionFromModule`) |
| **Batch execution** | Built-in (`batch`) | Composable (MultiSend) |
| **Delegate call** | Built-in (`delegateCall`) | Built-in (operation enum) |
| **EIP-712 / EIP-1271** | Built-in | Built-in |
| **Signature types** | ECDSA, onchain approval, sender bypass | ECDSA, EIP-1271, pre-approved hashes |
| **EIP-7702** | Native (dual-path init) | SafeEIP7702Proxy |
| **Module system** | Single-slot (`executor`) + singletons | Multi-module (linked list) |
| **Guard system** | Yes (vanity address encoding) | Yes (pre/post transaction hooks) |
| **CREATE2 factory** | Yes (sender-bound salt) | Yes |
| **Atomic module setup** | `createWithCalls` | `setup` delegatecall |

### Code Size

Measured from compiled runtime bytecode (`forge build --sizes`) and from source with comments and blank lines stripped. Safe figures are the canonical v1.4.1 deployments and the import graph of `Safe.sol`.

| | This Multisig | Safe v1.4.1 | Less |
|---|---|---|---|
| Wallet runtime bytecode | 10,532 B | 23,579 B | **55%** |
| Wallet + factory bytecode | 12,881 B | 26,633 B | **52%** |
| Feature parity bytecode¹ | 12,881 B | 32,680 B | **61%** |
| Source, code lines (wallet + factory) | 275 | 702 | **61%** |
| Source, physical lines | 321 | 1,473 | 78% |

¹ Adds `CompatibilityFallbackHandler` (EIP-1271, ERC-721/1155 receivers) and `MultiSendCallOnly` (batching) to Safe's side, since this multisig has both built in.

The physical-line figure flatters this multisig — Safe carries far heavier NatSpec — so the honest headline is **~55% less bytecode and ~61% fewer lines of code**.

### Gas Benchmarks

`forge test --mc SafeComparisonTest -vv` measures both wallets in one harness, so the numbers are directly comparable. Safe runs as its exact canonical mainnet bytecode (codehash-verified), removing any compiler or optimizer difference. Both sides get cold storage with the transaction's `to` account pre-warmed per EIP-2929, a cold delegatecall target, a cold and already-existing recipient, and full transaction accounting — 21,000 intrinsic plus EIP-7623 calldata cost on the identical calldata each wallet would receive on-chain.

All figures below are **total transaction gas**, what a receipt reports.

| Operation | This Multisig | Safe v1.4.1 | Delta |
|---|---|---|---|
| **Deploy (proxy + init)** | | | |
| 1 owner | 137,060 | 259,400 | **−47%** |
| 2 owners | 160,116 | 282,882 | **−43%** |
| 3 owners | 183,171 | 306,366 | **−40%** |
| 5 owners | 229,282 | 353,332 | **−35%** |
| **ETH transfer** (steady state) | | | |
| 1-of-1 | 45,603 | 54,031 | **−16%** |
| 2-of-2 | 52,917 | 61,113 | **−13%** |
| 2-of-3 | 52,918 | 61,113 | **−13%** |
| 3-of-3 | 60,232 | 68,183 | **−12%** |
| 3-of-5 | 60,233 | 68,195 | **−12%** |
| **ERC20 transfer** 2-of-3 | 57,828 | 65,934 | **−12%** |
| **First transaction** 2-of-3 | 55,414 | 78,206 | **−29%** |
| **Batch 3 transfers** 2-of-3 | 81,318 | 80,946 | +0.5% |
| **Module / executor path** | 38,004 | 35,874 | +5.9% |
| **Timelock: queue** 2-of-3 | 68,398 | — | built-in |
| **Timelock: execute queued** | 42,314 | — | built-in |

Where the difference comes from, and where it does not:

- **Deployment is 35-47% cheaper**, the largest and most durable advantage. Safe writes each owner into a linked list plus separate slots for threshold, owner count, nonce, singleton and fallback handler; this multisig packs `delay`/`nonce`/`threshold`/`ownerCount` into one slot. Stripping Safe's fallback handler entirely still leaves it at 283,921 for 3 owners — a 35% gap — so this is not fallback-handler overhead.
- **Signature-verified execution is 12-16% cheaper**, from single-slot state packing and smaller calldata (`execute` takes 4 arguments; `execTransaction` takes 10).
- **The first transaction is 29% cheaper**, because Safe stores `nonce` in a dedicated slot and pays a 20,000 gas zero-to-nonzero SSTORE once. That is a one-time cost, which is why the steady-state rows above are the fair headline.
- **Per additional signer, Safe is marginally cheaper** — ~7,070 gas against ~7,315 here. The advantage is in fixed overhead, so it narrows as the signer count grows.
- **Batching is a wash.** `MultiSendCallOnly` is lean, and its packed encoding is denser than the ABI-encoded arrays `batch` takes. The win is that batching needs no second contract.
- **The executor path costs ~6% more than Safe's module path.** `execute` bumps the nonce and computes the EIP-712 hash even when the caller is the executor. That is deliberate: it makes the nonce a single serialisation point across the signed and executor routes, so a signature cannot be replayed around an executor call.

- **The timelock has no Safe equivalent** without adding the Zodiac Delay Modifier, a separate deployed contract, so it is reported unpaired rather than compared.

Safe's remaining overhead buys gas refunds, `safeTxGas` metering, an arbitrary number of modules, and fallback handler dispatch. This multisig ships timelock, executor, batch and EIP-1271 as built-in primitives in a single file with all hot-path state in one slot. The executor doubles as a pre/post transaction guard via vanity address encoding — zero additional storage. Point the executor at a router contract to dispatch across multiple sub-modules without per-wallet storage overhead.

> `forge test --mc GasTest -vv` reports `gasleft()` deltas with warm storage and no intrinsic or calldata cost. Those numbers are useful for tracking regressions in this repo, but they are not comparable to Safe's published benchmarks, which report `receipt.gasUsed`. Use `SafeComparisonTest` for any comparison.

## Deployments

| Contract | Address |
|----------|---------|
| MultisigFactory | [`0x000000000e8CB9ed9DC2114d79d9215eacb9cB07`](https://contractscan.xyz/contract/0x000000000e8CB9ed9DC2114d79d9215eacb9cB07) |
| Multisig (implementation) | [`0xD54cb65224410F3Ff97a8E72f363f224419f4FB0`](https://contractscan.xyz/contract/0xD54cb65224410F3Ff97a8E72f363f224419f4FB0) |
| TimelockExecutor | [`0x00000000a72A30AdBf38e14d36BCE2610ec3973F`](https://contractscan.xyz/contract/0x00000000a72A30AdBf38e14d36BCE2610ec3973F) |

Deployed via [SafeSummoner](https://contractscan.xyz/contract/0x00000000004473e1f31C8266612e7FD5504e6f2a) on Ethereum, Base, MegaETH, Arbitrum, Optimism, Sepolia, and Base Sepolia.

Every wallet is the same 45-byte clone, so its runtime code can be checked against the audited build directly:

```
0x5f5f365f5f37365f73D54cb65224410F3Ff97a8E72f363f224419f4FB05af43d5f5f3e6029573d5ffd5b3d5ff3
```

> **Warning:** neither the factory nor the implementation has a withdrawal path, and the implementation is never initialized, so it has no owners who could authorize one. **ETH or tokens sent directly to either address are unrecoverable by anyone.** Value passed to `create()` / `createWithCalls()` is unaffected — the factory forwards it into the CREATE2 as the new wallet's opening balance. (Shred Security L-2.)

## Audits

| Date | Auditor | Scope | Result | Report |
|---|---|---|---|---|
| 2026-07-25 | [leftclaw](https://leftclaw.services/result/500.html) (multi-agent pipeline, via One Dollar Audit) | `Multisig.sol` + `TimelockExecutor.sol` + `IMultisig` | 1 critical, 2 high, 4 medium, 5 low | [Reproduction + our response](audit/report-leftclaw.md) &middot; [original](https://leftclaw.services/result/500.html) |
| 2026-07-26 | GPT-5.6 Sol (Pro) | `Multisig.sol` + `TimelockExecutor.sol` composition @ `main` | 1 high, 1 medium, 4 low, 5 informational | [Reproduction + our response](audit/report-gpt56-sol.md) &middot; [transcript](https://chatgpt.com/share/6a650af3-f6bc-83ea-b5f3-f83452e9c744) |
| 2026-07-26 | Claude Opus 5 (max effort) | `Multisig.sol` + `TimelockExecutor.sol` @ `09e2c38`, plus 20 adversarial PoC tests | 2 high, 6 medium, 6 low, 9 informational — all configuration-dependent | [Reproduction + our response](audit/report-opus5-max.md) &middot; [transcript](https://claude.ai/share/c8a3a7d4-962f-4cb3-9fea-5690e9c7c7a2) |
| 2026-07-11 | [Shred Security](https://www.shredsecurity.io/) (kenzo, yashar) | `Multisig.sol` @ `2329339`, plus stateful invariant fuzzing | 0 high, 0 medium, 2 low, 2 informational | [Reproduction + our response](audit/report-shred-security.md) &middot; [PDF](https://audit.multisig.wei.limo) — marked DRAFT |
| 2026-04-03 | Pashov Skills | `Multisig.sol`, modules, TimelockExecutor | see reports | [`audit/report-multisig.md`](audit/report-multisig.md), [`audit/report-mods.md`](audit/report-mods.md), [`audit/report-timelock-executor.md`](audit/report-timelock-executor.md) |

Findings and their dispositions are tracked in [`SECURITY.md`](SECURITY.md). The contracts are immutable singletons; the low and informational findings from the 2026-07-11 review are mitigated in the dapp rather than by redeployment.

## Brand and press

**[multisig.software/brand](https://www.multisig.software/brand)** — the
press kit: boilerplate at four lengths with a copy button on each, a
plain-English explainer, the numbers with the commands that reproduce them,
naming rules and a fact sheet. Written to be quoted verbatim; no permission
needed.

The logo files are in [`brand/`](brand/), all generated by
[`brand/build.py`](brand/build.py) and all font-free. The same material in
markdown is in [Brand & Press](docs/src/brand.md). Press: ross@wei.domains.

## License

MIT
