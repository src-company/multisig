# The Executor Role

One address in the packed slot, `executor`, and it does two unrelated jobs: it is
a bypass role, and — if its address carries the right marker — it is also a
pre/post transaction guard. Both are worth understanding before setting one.

## The bypass

```solidity
if (msg.sender != _executor) { /* verify threshold signatures */ }
...
if (_delay == 0 || msg.sender == _executor) { /* execute now */ }
```

The executor skips signature verification **and** the timelock. That is not an
oversight to be tightened later; it is the whole mechanism, and it is what makes
the role composable. Two patterns follow from it:

**Security council.** A protocol's admin is a timelocked multisig — say 3-of-5
with a two-day delay. Its executor is a separate, larger council, say 5-of-9.
During an active exploit the council calls `execute` directly: no owner
signatures, no delay. Owners retain the ability to revoke with
`setExecutor(address(0))`.

**Social recovery.** The executor is a guardian set. If the owner loses their keys,
guardians call `execute` to rotate the owner list through
`addOwner`/`removeOwner`/`setThreshold`.

> **The executor is a full key.** It can move every asset the wallet holds, at any
> time, with no signatures and no delay. The timelock gives stakeholders an exit
> window against the *owners*; the executor operates outside it. Treat any
> executor address as a co-owner with unilateral authority and hold it to the same
> standard as the wallet itself.
>
> This is the one place the design diverges sharply from Safe. A Safe Guard can
> only *block*; here, a guard is installed **as** the executor, so installing a
> guard grants full custody to the guard contract.

If an executor is compromised, the recovery path is the ordinary timelocked one:
owners sign `setExecutor(address(0))` and wait out the delay.

## Guard mode

The executor doubles as a transaction guard when it lives at a vanity address.
The behaviour is encoded in the address itself — no extra storage, no new
functions, no registry:

```solidity
if (uint160(_executor) >> 144 == 0x1111)        // leading 2 bytes  -> pre-guard
if ((uint160(_executor) & 0xFFFF) == 0x1111)    // trailing 2 bytes -> post-guard
```

| Leading 2 bytes | Trailing 2 bytes | Behaviour                                |
|-----------------|------------------|------------------------------------------|
| `0x1111`        | any              | Pre-transaction guard, called before execution |
| any             | `0x1111`         | Post-transaction guard, called after execution |
| `0x1111`        | `0x1111`         | Both                                     |
| other           | other            | Plain executor, no guard calls           |

The guard receives an `execute(target, value, data, sigs)` call. It can inspect the
transaction and revert to block it, or return quietly to allow it. Mining a 4-byte
vanity address (2 leading + 2 trailing) is comparable in cost to mining a 4-byte
prefix — minutes on a GPU. See `script/VanityMiner.sol` and `script/vanity_mine.py`.

Four details about when the hooks fire, each an accepted design tradeoff rather
than an oversight:

- **The pre-hook fires before signature validation** (F-2). A guard therefore sees
  transactions that will go on to fail verification, and must not treat being
  called as evidence of authorisation.
- **The post-hook fires even when the transaction was only queued** (F-5). Under a
  delay, the post-hook runs at queue time, not at execution time.
- **`executeQueued` triggers both hooks too**, passing empty `sigs`. A guard that
  requires non-empty `sigs` will brick the queued path.
- **A marked address gets both hooks called** if it happens to satisfy both
  patterns (F-6), which is the intended way to install a pre+post guard.

## Two ways to brick a wallet

> **Warning:** a guard that cannot handle the forwarded `execute` call — one that
> always reverts, or one that holds no code at all — bricks the wallet. `execute`,
> `executeQueued` **and** `setExecutor` all trigger the hook, so the call that
> would remove the bad guard is the same call that fails. There is no recovery
> path for a clone. Verify the guard contract answers the `execute` interface
> before assigning it.
>
> The codeless case catches people out: Solidity emits an `extcodesize` check
> ahead of a high-level call, so a `0x1111`-marked address with no code reverts
> the hook rather than silently succeeding.

> **Warning:** the same applies to a wallet at a `0x1111`-marked address that sets
> **itself** as its own executor. Each `execute` re-enters itself through the guard
> hook until it runs out of gas, and `setExecutor` is only reachable through
> `execute`. **Never call `setExecutor(address(this))`.** A clone has no recovery;
> an EIP-7702 account can recover by revoking its delegation. (Shred Security L-1,
> Opus M-1, leftclaw H-1.)

Both are [refused outright by the interface](../dapp/guardrails.md), which also
reads the chain before proposing a marked executor.

## Routing to many modules

There is one executor slot, and that is on purpose. To dispatch across several
sub-modules, point the executor at a router contract that fans out. The wallet
keeps its one-slot state, and the per-wallet storage cost of the extra modules is
zero.

Ready-made singleton modules are documented in [Modules](modules.md).
