# Modules

`src/mods/` holds five module contracts. Each is a **singleton**: deployed once,
serving every multisig, with all per-wallet state keyed by `msg.sender`. A wallet
opts in by making itself the caller — through
[`createWithCalls`](deployment.md#deploying-with-module-setup) at birth, or through
`execute` afterwards — and by setting the module as its `executor`.

Only `TimelockExecutor` has a canonical deployment; the other four are reference
implementations, meant to be read as patterns and deployed by whoever needs them.

| Module              | Role                                       | Safe/Zodiac equivalent            |
|---------------------|--------------------------------------------|-----------------------------------|
| `TimelockExecutor`  | Executor                                   | — (cancel, forward, accelerate)   |
| `AllowlistGuard`    | Pre-guard (vanity `0x1111` prefix)         | Zodiac TransactionGuard           |
| `SpendingAllowance` | Executor                                   | Safe AllowanceModule              |
| `SocialRecovery`    | Executor                                   | Safe SocialRecoveryModule         |
| `DeadmanSwitch`     | Post-guard + executor (vanity `0x1111` suffix) | Zodiac Dead Man's Switch      |

Every one of them holds the [executor's full authority](executor.md#the-bypass)
while installed.

## TimelockExecutor

Live at
[`0x00000000a72A30AdBf38e14d36BCE2610ec3973F`](https://contractscan.xyz/contract/0x00000000a72A30AdBf38e14d36BCE2610ec3973F).
This is the default executor, and the one the [interface](../dapp/overview.md)
installs.

Its design idea is to reuse the wallet's own signatures. It verifies against the
**same EIP-712 `Execute` digest at the wallet's live nonce**, so the signatures a
client already collects for `Multisig.execute()` work here with no new signing UX,
and the choice of route is made at submission time rather than at signing time.

```solidity
forward(address multisig, address target, uint256 value, bytes data, bytes sigs)
```

`forward` counts the signatures it requires, verifies them itself, and then calls
`multisig.execute(target, value, data, "")` — with empty `sigs`, because the wallet
skips verification for its executor. The module enforces its own rules; the wallet
only ever sees a trusted caller.

How many signatures it requires depends on what is being asked:

| Signatures collected           | Action              | Route                                                |
|--------------------------------|---------------------|------------------------------------------------------|
| `threshold`                    | Normal execute      | `Multisig.execute()` — queues under the timelock     |
| `threshold`, targeting `cancelQueued` | Cancel a queued tx | `TimelockExecutor.forward()` — cancels immediately |
| `ownerCount` (all owners)      | Immediate execute   | `TimelockExecutor.forward()` — bypasses the timelock |
| `ownerCount`, targeting `executeQueued` | Accelerate a queued tx | `TimelockExecutor.forward()` — consumes the queued entry |

The asymmetry is deliberate. **Cancel is always available** at threshold: it is a
defensive action, and taking the brake away from a quorum that could have signed
the transaction in the first place buys nothing. **Forward and accelerate require
`enableForward(true)`**, because the timelock is a security boundary and should
only be bypassable when the wallet explicitly opts in.

A useful consequence of verifying at the live nonce: signatures accrue toward the
faster route. Collect `threshold` and a proposal is queueable; if a further owner
signs the same proposal before it is submitted, it becomes instantly executable,
with nobody re-signing.

Two caveats:

- **Where `threshold == ownerCount` there is no escalation.** On a 2-of-2 or 3-of-3
  every quorum is already unanimous, so the same bundle can queue *or* execute
  immediately at the submitter's choice, and the delay becomes the default route
  rather than a guarantee. Legitimate if that is what you want. Cancellation is
  unaffected.
- **A shared digest means a shared bundle.** Because `forward` authorises against
  the wallet's own digest, a bundle collected for one route is valid for the other.
  See [route substitution](security.md#route-substitution).

> **Warning:** do not deploy `TimelockExecutor` at a vanity `0x1111` address. The
> wallet's guard hook would call into it with a signature bundle it does not
> accept, and revert.

## AllowlistGuard

A pre-transaction guard that whitelists `(target, selector)` pairs. Deploy at an
address with a leading `0x1111` so the wallet calls it before execution.

```solidity
set(address target, bytes4 sel, bool ok)     // called by the wallet
```

Three behaviours to know:

- **Calls to the guard itself always pass.** `execute` returns early when
  `target == address(this)`, so owners can still reconfigure the allowlist after
  the guard is active — otherwise activating a guard with an empty allowlist would
  be terminal.
- **Plain ETH transfers need `bytes4(0)` allowlisted.** Empty calldata has no
  selector, and the guard reads it as `bytes4(0)` rather than exempting it.
- Calldata shorter than 4 bytes is likewise treated as `bytes4(0)`.

## SpendingAllowance

An executor that grants one spender a periodic **ETH** allowance, so routine
payments do not need a signature round.

```solidity
configure(address spender, uint128 allowance, uint32 period)   // called by the wallet
spend(address multisig, address to, uint128 amount)            // called by the spender
```

The period is a lazy reset, not a schedule: the first `spend` at or after
`lastReset + period` zeroes the counter and restarts the window from that moment.
`period` must be non-zero. ERC-20 allowances are not covered — this module moves
native ETH only.

## SocialRecovery

An executor with its own guardian set and its own delay, independent of the
wallet's.

```solidity
setDelay(uint32 delay)                       // called by the wallet, first
setGuardian(address guardian, bool active)   // called by the wallet
propose(address multisig, address target, uint256 value, bytes data)   // guardian
finalize(address multisig, address target, uint256 value, bytes data)  // anyone
cancel(address multisig)                                              // guardian
```

Guardians propose an arbitrary call — typically a `batch` that rotates owners —
wait out the module's delay, then finalise. Details worth noting:

- **`setDelay` must come before `setGuardian`.** Activating a guardian requires a
  non-zero delay to already be set, so a guardian can never be added into an
  instant-recovery configuration by accident.
- One proposal at a time per wallet. A new `propose` is refused until the current
  one matures, at which point it replaces it.
- `finalize` is permissionless once mature, but the arguments must hash to the
  pending commitment.
- Any guardian can `cancel`, unilaterally.

## DeadmanSwitch

A post-guard *and* executor that lets a beneficiary sweep the wallet's ETH after a
period of inactivity.

```solidity
configure(address beneficiary, uint256 timeout)   // called by the wallet
claim(address multisig)                           // called by the beneficiary
```

Deploy at an address with a trailing `0x1111`, so every wallet execution calls the
post-hook and resets the heartbeat. `configure` enforces this: it reverts unless
the contract's own address carries the marker, which stops a wallet arming a switch
whose heartbeat will never be fed.

`claim` sweeps the wallet's **entire ETH balance** to the beneficiary and reverts
while the balance is zero. Tokens are not swept.

## Reference

Generated per-contract APIs for all of these are in the
[Contract Reference](../reference.md).
