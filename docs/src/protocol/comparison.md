# Comparison with Safe

Safe composes features as separate contracts — modules, guards, fallback handlers.
This multisig ships them as built-in primitives in one file with all hot-path state
in one slot. That is the whole of the difference, and both the gas advantage and
the sharper edges follow from it.

| Feature                     | This Multisig                              | Safe                                    |
|-----------------------------|--------------------------------------------|-----------------------------------------|
| Source, code lines          | 275 (single file, wallet + factory)        | 702 (16 files)                          |
| Runtime bytecode, wallet    | 10,532 bytes                               | 23,579 bytes                            |
| Runtime bytecode, parity    | 12,881 bytes                               | 32,680 bytes                            |
| Proxy clone size            | 45 bytes (PUSH0)                           | 45 bytes (EIP-1167)                     |
| Storage: core state         | 1 slot (packed)                            | Multiple slots                          |
| SLOAD/SSTORE for state      | 1 / 1                                      | Multiple                                |
| Timelock                    | Built-in (`delay`)                         | Modular (Zodiac Delay)                  |
| Executor role               | Built-in                                   | Modular (`execTransactionFromModule`)   |
| Batch execution             | Built-in (`batch`)                         | Composable (MultiSend)                  |
| Delegate call               | Built-in (`delegateCall`)                  | Built-in (operation enum)               |
| EIP-712 / EIP-1271          | Built-in                                   | Built-in                                |
| Signature types             | ECDSA, on-chain approval, sender bypass    | ECDSA, EIP-1271, pre-approved hashes    |
| EIP-7702                    | Native (dual-path `init`)                  | SafeEIP7702Proxy                        |
| Module system               | Single-slot (`executor`) + singletons      | Multi-module (linked list)              |
| Guard system                | Yes (vanity address encoding)              | Yes (pre/post transaction hooks)        |
| CREATE2 factory             | Yes (sender-bound salt)                    | Yes                                     |
| Atomic module setup         | `createWithCalls`                          | `setup` delegatecall                    |

Two differences are not simplifications and should be read as tradeoffs:

- **A guard here holds full custody.** It is installed *as* the executor, so it can
  move funds; a Safe Guard can only block. See
  [The Executor Role](executor.md#guard-mode).
- **One executor slot, not a module list.** Dispatching to several modules means
  pointing the executor at a router. The upside is zero per-wallet storage for the
  extra modules; the downside is that the router is a single point of failure.

The size figures come from `forge build --sizes` and from source with comments and
blank lines stripped. On bytecode the wallet is **55% smaller**; on source it is
**61% fewer lines**. The parity row adds `CompatibilityFallbackHandler` and
`MultiSendCallOnly` to Safe's side, since this multisig has EIP-1271, the token
receiver hooks and batching built in.

## Gas benchmarks

`forge test --mc SafeComparisonTest -vv` measures both wallets in a single harness.
Safe runs as its exact canonical mainnet bytecode, codehash-verified, so no compiler
or optimizer difference enters the result. Both sides get cold storage with the
transaction's `to` account pre-warmed per EIP-2929, a cold delegatecall target, a
cold and already-existing recipient, and full transaction accounting — 21,000
intrinsic plus EIP-7623 calldata cost on the identical calldata each wallet would
receive on-chain.

Figures are **total transaction gas**, what a receipt reports.

| Operation                        | This Multisig | Safe v1.4.1 | Delta |
|----------------------------------|---------------|-------------|-------|
| **Deploy (proxy + init)**        |               |             |       |
| 1 owner                          | 137,060       | 259,400     | −47%  |
| 2 owners                         | 160,116       | 282,882     | −43%  |
| 3 owners                         | 183,171       | 306,366     | −40%  |
| 5 owners                         | 229,282       | 353,332     | −35%  |
| **ETH transfer** (steady state)  |               |             |       |
| 1-of-1                           | 45,603        | 54,031      | −16%  |
| 2-of-2                           | 52,917        | 61,113      | −13%  |
| 2-of-3                           | 52,918        | 61,113      | −13%  |
| 3-of-3                           | 60,232        | 68,183      | −12%  |
| 3-of-5                           | 60,233        | 68,195      | −12%  |
| **ERC20 transfer** 2-of-3        | 57,828        | 65,934      | −12%  |
| **First transaction** 2-of-3     | 55,414        | 78,206      | −29%  |
| **Batch 3 transfers** 2-of-3     | 81,318        | 80,946      | +0.5% |
| **Module / executor path**       | 38,004        | 35,874      | +5.9% |
| **Timelock: queue** 2-of-3       | 68,398        | —           | built-in |
| **Timelock: execute queued**     | 42,314        | —           | built-in |

Reading the table:

- **Deployment is 35–47% cheaper**, the largest and most durable advantage. Safe
  writes each owner into a linked list plus separate slots for threshold, owner
  count, nonce, singleton and fallback handler; this multisig packs `delay`,
  `nonce`, `threshold` and `ownerCount` into one slot. Removing Safe's fallback
  handler entirely still leaves it at 283,921 for three owners, so this is not
  fallback-handler overhead.
- **Signature-verified execution is 12–16% cheaper**, from single-slot state
  packing and smaller calldata — `execute` takes four arguments, `execTransaction`
  takes ten.
- Cost tracks the **threshold**, not the owner count: 2-of-3 costs the same as
  2-of-2, and 3-of-5 the same as 3-of-3. Only signatures actually verified are paid
  for.
- **The first transaction is 29% cheaper** because Safe keeps `nonce` in a dedicated
  slot and pays a 20,000 gas zero-to-nonzero `SSTORE` once. That is a one-time cost,
  so the steady-state rows are the fair headline.
- **Per additional signer Safe is marginally cheaper** — about 7,070 gas against
  7,315 here. The advantage is in fixed overhead, so it narrows as signers grow.
- **Batching is a wash.** `MultiSendCallOnly` is lean and its packed encoding is
  denser than the ABI-encoded arrays `batch` takes. The win is needing no second
  contract, not gas.
- **The executor path costs about 6% more than Safe's module path.** `execute`
  bumps the nonce and computes the EIP-712 hash even when the caller is the
  executor. That is deliberate: the nonce becomes a single serialisation point
  across the signed and executor routes, so a signature cannot be replayed around
  an executor call.
- **The timelock has no Safe equivalent** without the Zodiac Delay Modifier, a
  separately deployed contract, so it is reported unpaired.
- Safe's remaining overhead is not waste — it pays for guard hooks that cannot
  spend, gas refunds, `safeTxGas` metering, an arbitrary number of modules, and
  fallback handler dispatch.

`forge test --mc GasTest -vv` reports `gasleft()` deltas with warm storage and no
intrinsic or calldata cost. Those numbers track regressions in this repo but are not
comparable to Safe's published benchmarks, which report `receipt.gasUsed`. A full
`.gas-snapshot` for the whole test suite is committed at the repository root.
