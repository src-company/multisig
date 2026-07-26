# Security

The contracts are immutable singletons, already live at mined addresses on every
supported chain. There is no upgrade path and no admin, so the security posture is
a fixed thing: what the reviews found, what was changed before deployment, what is
answered in the client, and what remains a property of the design that operators
have to configure around.

This chapter is a map. The authoritative record — every finding, every disposition,
and the arguments behind the disputed ones — is
[`SECURITY.md`](https://github.com/src-company/multisig/blob/main/SECURITY.md), with
each report reproduced in full under
[`audit/`](https://github.com/src-company/multisig/tree/main/audit).

## Reviews

| Date | Auditor | Scope | Result | Report |
|---|---|---|---|---|
| 2026-07-26 | GPT-5.6 Sol (Pro) | `Multisig.sol` + `TimelockExecutor.sol` composition @ `main` | 1 high, 1 medium, 4 low, 5 informational | [response](https://github.com/src-company/multisig/blob/main/audit/report-gpt56-sol.md) · [transcript](https://chatgpt.com/share/6a650af3-f6bc-83ea-b5f3-f83452e9c744) |
| 2026-07-26 | Claude Opus 5 (max effort) | `Multisig.sol` + `TimelockExecutor.sol` @ `09e2c38`, plus 20 adversarial PoC tests | 2 high, 6 medium, 6 low, 9 informational — all configuration-dependent | [response](https://github.com/src-company/multisig/blob/main/audit/report-opus5-max.md) · [transcript](https://claude.ai/share/c8a3a7d4-962f-4cb3-9fea-5690e9c7c7a2) |
| 2026-07-25 | [leftclaw](https://leftclaw.services/result/500.html) (multi-agent pipeline, via One Dollar Audit) | `Multisig.sol` + `TimelockExecutor.sol` + `IMultisig` | 1 critical, 2 high, 4 medium, 5 low | [response](https://github.com/src-company/multisig/blob/main/audit/report-leftclaw.md) · [original](https://leftclaw.services/result/500.html) |
| 2026-07-11 | [Shred Security](https://www.shredsecurity.io/) (kenzo, yashar) | `Multisig.sol` @ `2329339`, plus stateful invariant fuzzing | 0 high, 0 medium, 2 low, 2 informational | [response](https://github.com/src-company/multisig/blob/main/audit/report-shred-security.md) · [PDF](https://audit.multisig.wei.limo) — marked DRAFT |
| 2026-04-03 / 04-04 | Pashov Skills (8-agent parallelized, internal, multi-pass) | `Multisig.sol` and `MultisigFactory`; all five modules; `TimelockExecutor` and its composition with the wallet | 0 critical, 0 high, 7 medium, 9 low, 4 leads | [multisig](https://github.com/src-company/multisig/blob/main/audit/report-multisig.md) · [mods](https://github.com/src-company/multisig/blob/main/audit/report-mods.md) · [timelock](https://github.com/src-company/multisig/blob/main/audit/report-timelock-executor.md) |

**No reviewer found a way for an unauthorised party to move funds from a correctly
configured wallet.** The signature scheme, nonce handling, owner list, replay
protection and clone bytecode were each independently verified sound by several of
them, and nothing found warranted redeploying.

Severities were not consistent across reports. One filed a critical that rested on
a misreading of which address a branch tests; two mis-sized the same arithmetic bug
by a factor of 65. Each response records where the finding was accepted, where it
was disputed, and why — disputed findings are argued rather than quietly dropped.

### The internal pass came first, and shaped the rest

The 2026-04 Pashov Skills reviews were an internal process, run and recorded before
the external reviews, and they are the reason several of the later ones came back
clean. They are also the widest in scope — the only pass to cover all five modules
rather than the wallet and `TimelockExecutor` alone.

Several findings were fixed in code rather than merely acknowledged, and those
fixes are in the deployed contracts. **`cancelQueued` exists because of this pass** —
the wallet review found that queued transactions had no cancellation mechanism at
all. `DeadmanSwitch.claim` lost its `unchecked` and gained a zero-amount guard. Two
more were recorded as "acknowledged — design choice" and hardened afterwards
anyway: `SocialRecovery.setGuardian` now refuses to activate a guardian until a
non-zero delay is set, and `SpendingAllowance.configure` now rejects `period == 0`.
The reports' own status columns are behind the code on those two.

Two things about that scope are worth knowing when reading the reports. The
disposition sits in a `Status` column per finding rather than in prose, and the
modules report covers a sixth contract, `CancelTx`, which no longer exists — it was
superseded by [`TimelockExecutor`](modules.md#timelockexecutor), which is why no
page for it appears in the [Contract Reference](../reference.md).

What the reviews found falls into three groups, below.

## Configuration traps

One-way doors that a wallet's owners would have to deliberately sign their way
into. Every one of them is [refused by the interface](../dapp/guardrails.md), but
they are properties of the contract and apply to any client.

| Trap | Effect | Reference |
|---|---|---|
| Wallet set as its own executor | At a `0x1111`-marked address, recurses through its own guard hook until out of gas; `setExecutor` is only reachable through the failing call | Shred L-1, Opus M-1, leftclaw H-1 |
| Guard that reverts, or a `0x1111`-marked address with no code | Same brick, from the other direction: `execute`, `executeQueued` and `setExecutor` all trigger the hook | [Executor](executor.md#two-ways-to-brick-a-wallet) |
| Extreme `delay` | `uint32` seconds accepts ~136 years, and the proposal that would shorten it waits the full term first | Opus M-2 |
| Executor removed while a delay is live | Every queued proposal becomes uncancellable; a cancel raised without an executor is itself queued | Opus M-3 |
| Value sent to a singleton | The factory, the implementation and the `TimelockExecutor` have no withdrawal path and no owners; funds are gone permanently | Shred L-2, GPT-5.6 L-04 |
| Threshold ≥ 1009 | See below | leftclaw H-2 |

### The threshold overflow

`execute` reads `threshold` into a `uint16` local and then computes
`_threshold * 65` inside the function-wide `unchecked` block. That is `uint16`
arithmetic, so the product wraps modulo 65,536. At a threshold of 1009 the length
check demands 49 bytes while the verification loop still walks 1009 slots — no
`sigs` value satisfies both, and the owner-signed path is permanently unusable.

`isValidSignature` and `TimelockExecutor.forward` widen to `uint256` before the
same multiplication and are unaffected. That is what makes this an owner lockout
rather than a full brick — and also what would make an attacker-held executor
unremovable.

Two earlier reviews looked at the same region and put the break point at 65,536
owners, dismissing it as beyond the block gas limit. The real figure is 65× lower
and fits in a mainnet block. Reachable only by deliberately configuring 1009+
owners; `test/ThresholdOverflow.t.sol` pins it down, and the interface caps owners
and thresholds at 1008.

## Route substitution

The one open residual. The internal pass found the mechanism first and accepted it
(Pashov `TimelockExecutor` F-1, Low, "by design"); GPT-5.6 (H-01) and leftclaw (M-2)
independently re-raised it in July and escalated it, and they were right to.

The April response reasoned that "the worst outcome is a delayed cancel, which is
strictly less harmful than no cancel." That is true of an ordinary transaction and
**false of a cancellation**, which is the case it missed: the proposal being
cancelled was queued first, so it matures first, `executeQueued` is permissionless,
and `cancelQueued` does not revert on an absent entry. A cancel forced down the
slow route therefore arrives after its target has already executed, deletes
nothing, and reports success. Delayed, for a cancel, *is* defeated. Worth reading as
a warning about the shape of the reasoning rather than about this one finding: an
impact argument that holds for the general case can fail on the one call whose whole
value is being fast.

The mechanism itself: `Multisig.execute()` and `TimelockExecutor.forward()` verify
the **same** EIP-712 digest. Nothing in the signed payload says which route the
signers meant, so a bundle collected for one is valid for the other. Someone who
sees a bundle before it lands can submit it down the queueing route instead: the
proposal is queued rather than executed now, and the nonce is consumed, so the
intended call then reverts.

For an ordinary transaction it is griefing, not theft — not blocked and not lost, it
executes when the delay elapses, the substitution cannot be repeated once the entry
is queued, and it can be accelerated to recover. For a cancellation it is fatal, per
above. Three things narrow it further:

1. **Submit through a private RPC.** The attack needs the bundle to be public
   first, and on Base, Arbitrum and OP Mainnet there is no public mempool to read.
2. **Spend one slot on a sender slot.** A `v = 0` slot naming the submitter can
   only be filled by that submitter, so a copied bundle is inert. This needs no
   contract change and is what the interface does. It is *complete* for
   cancellation, where the bundle is exactly `threshold` slots — bind one and a
   copier is a signature short. It is *partial* for unanimous fast-path bundles on
   a k-of-n wallet, where a threshold subset of the remaining signatures can still
   be extracted to queue the action.
3. **Use a second wallet as the executor** — the council pattern. Since the
   executor bypass needs no bundle at all, an executor that authorises against its
   *own* digest leaves nothing in existence that can be replayed against the wallet.
   Deploy a second wallet with the same owners, a unanimous threshold and no
   timelock, and install it as the main wallet's executor. Ordinary proposals still
   queue for the full delay, unanimity acts immediately, and those signatures can
   never be aimed at the main wallet because they carry a different
   `verifyingContract`.

The council's tradeoff is that its threshold governs both bypass *and*
cancellation — one dial, not two — so at unanimous, cancelling costs every owner
rather than a quorum. `TimelockExecutor` charges only a quorum to cancel and is the
better default; the council is the choice when the replay surface should be gone
entirely.

Cancellation is where timing actually matters, because `cancelQueued` does not
revert on an absent entry: a cancel that arrives late deletes nothing and reports
success. `test/RouteSubstitution.t.sol` and `test/CouncilExecutor.t.sol` pin down
both the attack and both mitigations.

## Accepted, not fixed

Documented design rather than oversight.

- **The executor is a full key.** It bypasses signatures and the delay by design,
  and a guard is installed *as* the executor, so installing one grants full
  custody. See [The Executor Role](executor.md).
- **Queued proposals outlive configuration changes.** `executeQueued` re-checks the
  hash and the clock, nothing else — not the owner set, the threshold or the
  executor — and entries never expire.
- **Stale approvals survive owner removal.** Keyed by address and never cleared, so
  re-adding a removed address restores its approvals.
- **EIP-7702 configuration is effectively permanent**, and the delegating key
  remains a superuser throughout. See
  [Deployment](deployment.md#configuration-is-effectively-permanent).
- **Zero-prefix salts are not front-run protected** (F-1). Only the caller-bound
  form protects a counterfactual address.
- **Pre-hook fires before signature validation** (F-2); **post-hook fires even when
  the transaction was only queued** (F-5); **`executeQueued` is permissionless**
  (F-4).
- **Message signing is not subject to the delay.** A timelock constrains
  transactions, not ERC-1271 signatures.
- **The fallback returns success for unknown selectors.** A mistyped governance
  self-call burns a nonce, emits `ExecutionSuccess` and changes nothing.

## Verifying a deployment

Every wallet is the same 45-byte clone, so its runtime code can be compared against
the audited build byte for byte:

```text
0x5f5f365f5f37365f73D54cb65224410F3Ff97a8E72f363f224419f4FB05af43d5f5f3e6029573d5ffd5b3d5ff3
```

Three checks are worth making, and the interface makes all three:

- **Before deploying** — ask the factory on the target chain for its
  `implementation()` and require the audited address. Code merely being present at
  the factory address proves nothing.
- **After deploying** — a mined receipt is not a deployment. On a chain without the
  factory, `create()` is a plain transfer to a codeless address: it succeeds, emits
  no `Created` event and deploys nothing. Read the runtime bytecode back and match
  the owners, threshold, delay and executor against what was requested.
- **On every load** — a wallet can arrive from a pasted address, where answering
  `threshold()` and `getOwners()` proves only that something implements the shape.

## Tests

```bash
forge build
forge test
```

321 tests across 7 suites, all passing at the current commit:

| Suite | Covers |
|---|---|
| `Multisig.t.sol` | The wallet: signatures, owners, nonces, timelock, guards, batching |
| `Mods.t.sol` | All five modules in `src/mods/` |
| `EIP7702.t.sol` | The delegation path, including `init` from `address(this)` |
| `Gas.t.sol` | The `gasleft()` snapshots behind [Comparison](comparison.md#gas-benchmarks) |
| `RouteSubstitution.t.sol` | GPT-5.6 H-01 / leftclaw M-2 and the sender-slot mitigation |
| `CouncilExecutor.t.sol` | The council pattern, with contracts already live |
| `ThresholdOverflow.t.sol` | leftclaw H-2, including the arithmetic in isolation |

The last three are regression tests written against specific findings; each carries
the finding it answers in its file-level doc comment.

## For the next reviewer

[`SECURITY.md`](https://github.com/src-company/multisig/blob/main/SECURITY.md) is
written partly for whoever audits this next, and reading it first will save
duplicating five reviews' worth of work. It carries the scope, the architecture and
access-control model, the invariants the stateful fuzzing campaign did and did not
cover, the critical code paths in priority order, the severity criteria used, and —
most usefully — a catalogue of **false-positive patterns not to flag**, each with
the reason it looks like a bug and is not.
