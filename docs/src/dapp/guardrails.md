# Guardrails

The contracts are immutable, so every review finding that a *client* can answer is
answered at the point the transaction is built. Two consequences worth being clear
about: a proposal raised by other tooling gets flagged here the same way, and none of
this is enforced on-chain. These are client-side refusals, not protocol
restrictions.

The findings behind them are catalogued in [Security](../protocol/security.md).

## Refused outright

| The app will not build | Why |
|---|---|
| `setExecutor(address(this))` | Points the wallet at itself. At a `0x1111`-marked address this locks the wallet permanently, and `setExecutor` is only reachable through the call that now fails. No legitimate use. |
| Clearing the executor while a delay is live | The executor is the only role that can cancel inside the delay window. After this, everything queued executes on schedule and nothing can stop it. |
| A delay over 30 days on a wallet with no executor | Unrecoverable: the proposal that would undo it waits out the full term first. |
| Value to the factory, the implementation, the `TimelockExecutor`, `address(0)` or `address(1)` | None has a withdrawal path or owners. Covers transfers, custom calls and individual batch legs. |
| An owner at `0x0` or `0x1` | The contract requires `_owner > SENTINEL`; these would revert after the gas is spent. |
| A duplicate owner in the create form | `init()` requires strictly ascending owners and reverts on a repeat — after the salt is mined and paid for. |
| More than 1008 owners, or a threshold above 1008 | At 1009 the `uint16` length arithmetic in `execute` wraps and the owner-signed path dies permanently (leftclaw H-2). |
| A zero-prefix CREATE2 salt | Only the sender-bound form protects a counterfactual address from being claimed first. There is no code path here that produces the open form. |

## Warned, with a second press required

Legitimate configurations that are easy to reach by accident.

- **A delay over 30 days**, where an executor *is* set. Long delays are a valid
  choice; an accidental extra digit is not.
- **A wallet where `threshold == ownerCount`** with the fast path enabled. Every
  quorum is already unanimous, so the delay becomes the default route rather than a
  guarantee, and the same bundle can queue or execute at the submitter's choice.
  Flagged at create, and asking for a second press in admin rather than refusing.
- **A `0x1111`-marked executor address.** The chain is read before the proposal is
  built, because a marked address with no code bricks the wallet just as surely as a
  guard that reverts.
- **Any executor address at all.** The executor is a full key. The proposal states
  that in words before it is signed.

## Decoded, not passed through

- **Two different failures, two different messages.** `executeQueued` reverts with
  one error for "nothing is queued" and for "the timelock has not elapsed". The app
  decodes the ETA out of `NotReady(eta)` and reports them separately, so an operator
  chasing a clock problem is not sent looking when the real cause is a mismatched
  argument.
- **Self-calls with no matching function.** The wallet's fallback returns *success*
  for unknown selectors, so a mistyped governance self-call would burn a nonce, emit
  `ExecutionSuccess` and change nothing. Proposals carrying one are flagged before
  signing.
- **Unverified code.** A wallet loaded from a pasted address has its runtime bytecode
  compared against the audited clone; anything else is badged **UNVERIFIED CODE**, and
  its builder falls back to raw calldata rather than pretending to know the ABI.

## Route substitution

Every executor bundle spends one slot on a
[sender slot](../protocol/signatures.md#the-sender-bypass) bound to whoever submits,
so a copied bundle is inert on either route.

This is **complete for cancellation**, where the bundle is exactly `threshold` slots
and binding one leaves a copier a signature short. It is **partial for unanimous
fast-path bundles** on a k-of-n wallet, where a threshold subset of the remaining
signatures can still be extracted to queue the action — which delays it rather than
defeating it. A cancel should therefore be submitted by one of its own signers; the
app spends a slot on that signer and tells you when it could not.

For a wallet that wants the replay surface gone entirely rather than narrowed, use
the [council pattern](../protocol/security.md#route-substitution) instead of
`TimelockExecutor`.

## Verifying the audited build

Three checks, on every deploy and every load:

- **Before deploying** — the factory on each target chain is asked for its
  `implementation()` and must name the audited address. Code merely being present at
  the factory address proves nothing.
- **After deploying** — the wallet's runtime bytecode is read back and compared, and
  its owners, threshold, delay and executor matched against what was requested. A
  chain that will not answer reads **DEPLOYED · UNVERIFIED** rather than counting as
  verified.
- **On every load** — the same bytecode check runs each time a wallet is opened.
  Answering `threshold()` and `getOwners()` proves only that something implements the
  shape.

## Operational guidance the app cannot enforce

Some things are properties of the design rather than of any proposal, so they are
documented rather than blocked.

- **Pair a non-zero delay with an executor.** Without one, queueing works and third
  parties get their notice period, but nothing can be stopped — cancel is a self-call
  and matures no earlier than the thing it cancels.
- **Cancelling is the reliable brake**, not the fast path. It needs only threshold
  signatures, works whether or not the fast path is enabled, and executes
  immediately. If you are considering the fast path for emergencies, you already have
  what you need; the fast path is for *speed* — routine payments, trading — on a
  wallet that normally acts on partial consensus.
- **Clear the queue before reconfiguring.** `executeQueued` re-checks nothing but the
  hash and the clock, and entries never expire. Review the queue before rotating
  owners, changing the threshold or executor, or making a large deposit.
- **Never re-add a removed owner.** On-chain approvals are keyed by address and never
  cleared, so re-adding an address restores its old approvals.
- **The delay does not gate signed messages.** Anything expressible as a signed
  order — Permit2, Seaport, intents — is authorised instantly with threshold
  signatures, however long the delay.
- **A passing [simulation](interface.md#simulation) is not a guarantee.** It is one
  block's snapshot, and on a timelocked wallet the gap between signing and executing
  is measured in days. Re-run it before executing, not only before signing — and
  read the timestamp on the panel rather than the verdict alone.
