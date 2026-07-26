# Comparison with Safe

Safe composes features as separate contracts — modules, guards, fallback handlers.
This multisig ships them as built-in primitives in one file with all hot-path state
in one slot. That is the whole of the difference, and both the gas advantage and
the sharper edges follow from it.

| Feature                     | This Multisig                              | Safe                                    |
|-----------------------------|--------------------------------------------|-----------------------------------------|
| Core LOC                    | 321 (single file)                          | ~3,500 (multiple files)                 |
| Runtime bytecode            | ~10 KB                                     | ~23 KB                                  |
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

## Gas benchmarks

This multisig: `forge test --mc GasTest -vv` — `gasleft()` snapshots, warm storage.
Safe: `npm run benchmark` in
[safe-smart-account](https://github.com/safe-global/safe-smart-account).

| Operation                  | This Multisig | Safe    | Delta |
|----------------------------|---------------|---------|-------|
| **Deploy (proxy + init)**  |               |         |       |
| 1 owner                    | 142,024       | 166,375 | -15%  |
| 2 owners                   | 164,796       | 189,886 | -13%  |
| 3 owners                   | 187,569       | 213,385 | -12%  |
| **ETH transfer**           |               |         |       |
| 1-of-1                     | 43,550        | 58,142  | -25%  |
| 2-of-2                     | 47,826        | 65,193  | -27%  |
| 2-of-3                     | 47,826        | —       | —     |
| 3-of-3                     | 52,104        | 72,293  | -28%  |
| 3-of-5                     | 52,104        | 72,281  | -28%  |
| **Executor (no sigs)**     | 40,932        | —       | —     |
| **Queue (delay)**          | 35,810        | —       | —     |
| **Execute queued**         | 38,855        | —       | —     |
| **Batch 3 ETH transfers**  | 65,689        | —       | —     |

Reading the table:

- Execution is 25–28% cheaper, almost entirely from single-slot state packing.
  Each additional signer adds roughly 4,300 gas — one `ecrecover` plus one
  ownership `SLOAD`.
- Cost tracks the **threshold**, not the owner count: 2-of-3 costs the same as
  2-of-2, and 3-of-5 the same as 3-of-3. Only signatures actually verified are paid
  for.
- Executor, timelock and batch are built-in; the Safe equivalents need external
  modules and MultiSend, so those rows have no like-for-like comparison.
- Deployment is 12–15% cheaper because the sorted linked list needs exactly one
  storage write per owner.
- Safe's overhead is not waste — it pays for guard hooks that cannot spend, gas
  refunds, EIP-1271 contract signatures as *owners*, and fallback handler dispatch.

A full `.gas-snapshot` for the whole test suite is committed at the repository
root.
