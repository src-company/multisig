# Timelock

The timelock is not a module. `delay` is four bytes of the packed slot, and the
branch that uses it is three lines of `execute`.

## Queue and execute

When `delay != 0` and the caller is not the executor, a fully-signed `execute`
does not perform the call — it records an ETA and stops:

```solidity
if (_delay == 0 || msg.sender == _executor) {
    target.call{value: value}(data);            // immediate
    emit ExecutionSuccess(hash, _nonce);
} else {
    queued[hash] = block.timestamp + _delay;    // deferred
    emit Queued(hash, _nonce, eta);
}
```

The nonce is consumed either way. Later, anyone calls:

```solidity
executeQueued(address target, uint256 value, bytes calldata data, uint32 nonce)
```

which recomputes the hash from those four arguments, checks the ETA, deletes the
entry and makes the call. It is **permissionless** by design (F-4): the
authorisation happened when the entry was queued, so requiring an owner to be the
one to press the button afterwards would add a liveness dependency and no security.

The queue is keyed by transaction hash, and the hash includes the nonce, so an
entry cannot be double-executed — the first `executeQueued` deletes it.

## Reading a failure

`executeQueued` reverts with a single error for two distinct situations:

```solidity
require(eta != 0 && (msg.sender == address(this) || block.timestamp >= eta), NotReady(eta));
```

- `eta == 0` — nothing is queued under this hash. Either it was never queued, the
  arguments do not match what was signed, or it has already run or been cancelled.
- `eta > block.timestamp` — queued, but the delay has not elapsed.

The error payload carries the ETA, so a client can tell these apart and should.
Reporting "not ready" for an entry that does not exist sends an operator looking
for a clock problem when the real problem is a mismatched argument (Shred I-1,
Opus L-2).

## Cancellation

```solidity
cancelQueued(bytes32 hash) public payable onlySelf
```

`cancelQueued` deletes the entry and emits `Queued(hash, 0, 0)` — an ETA of zero
*is* the cancellation signal; there is no separate event.

Being `onlySelf` means cancel is not a privileged shortcut: it has to be routed as
a self-call through `execute`, exactly like any other governance action. That
choice is what lets an executor module gate cancellation behind its own signature
rules while still executing it immediately.

It also has a consequence that has to be stated plainly:

> **A timelock with no executor cannot be cancelled in time.** The cancel is a
> self-call, so it goes through the same queue as everything else and matures no
> earlier than the thing it means to stop. Third parties still get their full
> notice period, but nobody — including the owners — can stop a queued
> transaction. A non-zero `delay` should always be paired with an executor that
> can cancel. (Opus M-3.)

`cancelQueued` does not revert on an absent entry. A cancel that arrives after its
target has already executed deletes nothing and reports success — which is why
cancel timing matters and why the interface binds cancel bundles to their
submitter. See [Security](security.md#route-substitution).

## Acceleration

`executeQueued` skips the ETA check for one caller — the wallet itself:

```solidity
msg.sender == address(this) || block.timestamp >= eta
```

So an already-queued entry can be executed early by routing a self-call to
`executeQueued` through the executor. This is how
[`TimelockExecutor`](modules.md#timelockexecutor) offers acceleration without any
extra storage or a second queue. Note that the acceleration call is itself an
`execute`, so it consumes a fresh nonce of its own.

## Two properties of the queue to plan around

**Queued entries never expire, and re-check nothing.** `executeQueued` verifies the
hash and the elapsed time. It does not re-check the owner set, the threshold, or
the executor — none of those are in the hash. A transaction signed by an owner set
that has since been rotated still executes. Review and clear the queue before
rotating owners, changing the threshold or the executor, or making a large
deposit.

**The delay bounds its own repair.** `delay` is a `uint32` of seconds, so any value
up to roughly 136 years is accepted, and the proposal that would shorten a bad
delay is itself queued for the full bad delay. Combined with the point above about
executors, the two unrecoverable configurations are an extreme delay, and removing
the executor while a delay is live. Both are [refused by the
interface](../dapp/guardrails.md) (Opus M-2, M-3).

## Lifecycle

```text
delay == 0
  collect threshold sigs ──▶ execute ──▶ done

delay > 0
  collect threshold sigs ──▶ execute ──▶ queued (ETA) ──▶ executeQueued ──▶ done
                                             │
                                             ├─▶ cancelQueued via executor ──▶ gone
                                             └─▶ executeQueued self-call via executor ──▶ done early

msg.sender == executor
  (no sigs) ──▶ execute ──▶ done, regardless of delay
```
