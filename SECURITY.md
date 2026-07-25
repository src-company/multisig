# Security

> **Purpose:** Security posture document for `src/Multisig.sol`. Summarizes prior audit findings with developer responses, documents defense mechanisms and invariants, and provides structured guidance for future reviewers to avoid duplicate findings and produce consistent reports.

## Prior Audits

**Date:** 2026-07-11 (cover page marked **DRAFT**)
**Auditor:** Shred Security — researchers kenzo, yashar
**Scope:** 4-day review of `src/Multisig.sol` @ `2329339`, plus a stateful invariant fuzzing campaign
**Result:** 0 high, 0 medium, 2 low, 2 informational
**Full report:** [`audit/report-shred-security.md`](audit/report-shred-security.md) — the auditor's text reproduced in full, with our response to each finding inline
**Original PDF:** [`audit/Multisig-Shred-Audit-07-2026.pdf`](audit/Multisig-Shred-Audit-07-2026.pdf) — also at <https://audit.multisig.wei.limo> (byte-identical, sha256 `9346de4b…`)

**Date:** 2026-04-03
**Method:** Pashov Skills — 8-agent parallelized security audit (four passes)
**Full reports:** [`audit/report-multisig.md`](audit/report-multisig.md), [`audit/report-mods.md`](audit/report-mods.md)

---

## Shred Security Findings — Disposition

The factory, the `Multisig` implementation and the `TimelockExecutor` are
immutable singletons already deployed at their mined addresses across every
supported chain. None of these four findings is severe enough to justify
redeploying them and migrating existing vaults, and none can be reached without
a wallet client building the transaction that triggers it. Each is therefore
mitigated in the dapp, at the point where the transaction is constructed or
reviewed — not in the contracts.

| ID | Severity | Contract change | Mitigation |
|---|---|---|---|
| L-1 | Low | None | `dapp/index.html` refuses to raise a `setExecutor` proposal naming the vault itself, and `txKind()` classifies any inbound one as `SET EXECUTOR · LOCKS VAULT` (danger tone, "do not sign"). Executors carrying the `0x1111` guard marker require explicit confirmation. |
| L-2 | Low | None | `lockedDest()` refuses to build any transfer, custom call or batch leg that sends value to the factory, the implementation, `address(0)` or the owner-list sentinel; `txKind()` marks an inbound one `UNRECOVERABLE`. Documented below. |
| I-1 | Info | None | `decodeMultisigError()` splits `NotReady(0)` ("not queued — cancelled, executed, or a stale nonce") from `NotReady(eta)` ("timelock not elapsed — N left") across every execute path and the simulation panel. |
| I-2 | Info | None | Accepted as intended design — the live `block.chainid` read is what makes signatures fork-safe by construction. See below. |

**Auditor status vs. ours.** The report's Vulnerability Summary records
`Fixed 0 / Acknowledged 0`, which was the state at delivery, before we had
responded. Our position is **0 fixed in-contract, 4 acknowledged.**

### What the invariant fuzzing did *not* cover

Appendix B reports 10/10 invariants holding across ~327,680 handler calls with
zero contract bugs. That result is narrower than it looks, and two of its stated
exclusions land squarely on the findings in the same report:

- **Executor bypass and guardian hooks (the `0x1111` pattern)** — excluded. This
  is the exact mechanism behind L-1, so the clean fuzzing result says nothing
  about it.
- **`MultisigFactory` / `createWithCalls` deployment paths** — excluded. The
  factory is one of the two contracts in L-2.

Also uncovered: malformed signatures, EIP-7702 semantics, the module contracts,
reentrancy via malicious call targets, and cross-chain or cross-wallet replay.
Per the auditor these remain covered by the 280-test Foundry suite and prior
manual review. Do not cite Appendix B as coverage for any of the above.

---

## Fourth Review (leftclaw, 2026-07-25) — Disposition

**Full report with our responses inline:**
[`audit/report-leftclaw.md`](audit/report-leftclaw.md) ·
[original](https://leftclaw.services/result/500.html)

A multi-agent automated pipeline commissioned via One Dollar Audit. Filed 1
Critical, 2 High, 4 Medium, 5 Low. Two findings contradicted earlier reviews, so
both were settled against solc `0.8.34+commit.80d5c536` — the compiler of record
for the deployed contracts — rather than by argument.

| ID | Filed | Our position |
|---|---|---|
| C-1 | **Critical** | **Rejected.** The PoC misreads which address the hook pattern applies to. |
| H-1 | High | Already mitigated (= Shred L-1, Opus M-1). Their revert analysis is right — and contradicts their own L-5. |
| H-2 | High | **Accepted and new.** Corrects two prior audits. Now guarded in the dapp. |
| M-1 | Medium | **Accepted.** Real double-execution path; our acceleration already uses the wrapper they recommend. |
| M-2 | Medium | Confirmed — independently reaches GPT-5.6's H-01. Already mitigated. |
| M-3 | Medium | Confirmed — independently reaches Opus 5's H-1. Already surfaced. |
| M-4 | Medium | Rejected as filed (F-1); recommendation already implemented. |
| L-1, L-3, L-4 | Low | Accepted as informational. L-4 (unbounded returndata copy) is new. |
| L-2 | Low | Already mitigated (= Opus M-2). |
| L-5 | Low | **Rejected — factually wrong, and contradicts this report's own H-1.** |

### C-1 — why we rejected a Critical

The hook tests and calls the wallet's **own executor**, not itself:
`_executor := executor`, the pattern is checked on `_executor`, and the call goes
**to** `_executor`. The PoC states the hook fires because wallet A's *own*
address carries the `0x1111` suffix, forwarding to B. It does not: for A's hook
to reach B you need `A.executor == B`, so **B** must carry the pattern.

Correctly stated, the preconditions are `A.executor == B`, B carrying the
pattern, **and** `B.executor == A` — mutual executor designation. And
`B.executor == A` alone already gives whoever controls A unconditional authority
over B: `B.execute(target, value, data, "")` with `msg.sender == executor` skips
both signatures and delay. **The hook grants nothing the executor role does not
already grant.** C-1 reduces to "the executor can drain the wallet" — the first
row of the False Positive Patterns table.

Worth noting as a caution about multi-agent methodology: this was "independently
confirmed by 6+ agents," which propagated a shared misreading rather than
catching it. The two other AI reviews read the hook correctly.

**What survives:** `executeQueued()` re-reads `executor` **live** at execution
time rather than binding it at queue time, so a queued transaction fires hooks
against whatever executor exists later. No other reviewer noted this. Combined
with GPT-5.6's L-01 it is a genuine composition property.

### H-2 — the finding that corrects two prior audits

`execute()` reads `threshold` into a `uint16` local and computes
`_threshold * 65` in uint16 arithmetic inside the function-wide `unchecked`
block. Verified against the compiler's IR:

```
function wrapping_mul_t_uint16(x, y) -> product {
    product := cleanup_t_uint16(mul(x, y))     // cleaned := and(value, 0xffff)
}
```

At threshold 1009 the check demands 49 bytes while the loop reads to offset
65,584 — unsatisfiable, so owner-signed execution is permanently dead.
`isValidSignature()` and `TimelockExecutor.forward()` widen to `uint256` first
and are unaffected, which makes this an owner-lockout rather than a full brick —
and is why an attacker-held executor would become unremovable.

**Both prior reviews mis-sized this.** Opus 5's I-4 called it "unreachable in
practice (65,536 owners far exceeds the block gas limit)"; GPT-5.6's I-01
anchored on the same number. The real break point is **1,009 — 65× lower**, and
~22M gas fits in a mainnet block. Right conclusion, wrong arithmetic, twice.

We assess it Low in practice — no real deployment has 1,009 owners — but a
one-way door does not get left unguarded for lack of a plausible user.
**Mitigated:** `MAX_SAFE_THRESHOLD = 1008`; the create flow refuses a larger
owner set (the ceiling must sit on owner count, since threshold can never exceed
it) and `setThreshold` refuses any value above it.

### L-5 — settled by compiling

L-5 claims a codeless `0x1111` executor makes the hook a silent no-op. Their own
H-1 says it reverts and bricks the wallet. Compiling three minimal probes with
the compiler of record:

| Call shape | compiler-inserted `extcodesize` |
|---|---|
| High-level call to a void function (`execute(...)`) | **1** |
| High-level call to a value-returning function | 0 |
| Raw `address.call(...)` | 0 |

`Multisig.execute` returns nothing, so the guard is inserted and **the hook
reverts**. Compiling `Multisig.sol` itself yields 11 compiler-inserted guards
with zero in the source. H-1 and Opus 5's M-1 are correct; L-5 is not — it
describes raw EVM semantics rather than compiled Solidity. This matters: under
L-5's reading the dapp guard we ship for codeless marked executors would look
unnecessary.

### Methodology note

This report's **Leads** (sub-confidence-floor items) and **Rejected Claims**
sections are its best feature. Two of its leads are items earlier reviews filed
as findings — the `addOwner` `ownerCount` wrap (GPT-5.6 I-01) and the `init()`
downcast truncation (Opus 5 I-4) — and it correctly demoted both as impractical
while correctly sizing the one arithmetic bug that *is* reachable. It also
rejected a false `createWithCalls` "stranded `msg.value`" claim, correctly, on
the grounds that an internal call compiles to a `JUMP` and `CALLVALUE` belongs to
the outer transaction.

---

## Third Review (GPT-5.6 Sol, 2026-07-26) — Disposition

**Full report with our responses inline:**
[`audit/report-gpt56-sol.md`](audit/report-gpt56-sol.md) ·
[transcript](https://chatgpt.com/share/6a650af3-f6bc-83ea-b5f3-f83452e9c744)

**This review found the most consequential issue raised to date, and corrected an
error in our response to the second review.**

### H-01 — route-unbound signatures suppress emergency cancellation

Both routes verify the same EIP-712 `Execute` digest, so a cancellation bundle
can be copied and replayed down the *other* route. Submitted through
`execute()` by a non-executor it is **queued** for the full delay rather than
executed immediately, and `nonce++` invalidates the pending `forward()`. The
dangerous transaction was queued first, matures first, and `executeQueued` is
permissionless. The late cancellation then deletes an already-empty entry —
`cancelQueued` does not revert on an absent hash — so it is a silent no-op.

**Why this is worse than the prior route-substitution findings:** the cancel
branch of `forward()` requires only `threshold` signatures and **does not check
`forwardEnabled`**. Every previously identified issue lived behind that opt-in.
This one applies to **every wallet with `delay > 0` and this executor installed**.

**Correction to our own record.** In responding to the Opus 5 review we wrote
that a wallet never enabling `forwardEnabled` has "zero exposure — structurally
absent, not mitigated," and that the cancel path "carries none of the findings."
That holds for the bypass direction and is false for this one. Because the cancel
brake is the principal reason we recommend this executor at all, the error was
load-bearing.

**It also suppresses a documented mitigation.** The False Positive Patterns entry
for "executeQueued doesn't re-check signers" answers it with "the delay window +
`cancelQueued` is the intended mitigation" — which H-01 shows can be neutralised.
Combined with L-01 (queued entries never expire and survive owner rotation), this
is the sharpest composite issue in any review so far.

**Mitigation shipped.** Every `forward()` bundle the dapp builds spends one slot
on a **v=0 sender slot** naming the submitting owner, which the contract accepts
only when `msg.sender` is that owner. A copier is neither that owner nor
pre-approved, so the bundle is inert on either route. Applied at all four
`forward()` call sites.

- **The cancel path is fully closed.** That route takes exactly `threshold`
  slots, so binding one leaves `threshold - 1` usable signatures — one short of
  what `execute()` requires. This also required fixing a latent bug: the cancel
  path passed *all* collected signatures to `forward()`, which demands exactly
  `required * 65` bytes and would revert when more than `threshold` owners had
  signed. Bundles are now trimmed to exactly `threshold`, keeping the submitter.
- **The unanimous paths are reduced, not closed.** Accelerate and instant execute
  carry `n` slots; binding one leaves `n - 1 ≥ k` copyable signatures whenever
  `k < n`, so a threshold subset can still be extracted to queue the action and
  burn the nonce. Impact is delay and forced re-signing rather than a neutralised
  brake. Protected submission is the remaining mitigation.

### Other findings

| ID | Filed | Our position |
|---|---|---|
| M-01 | Medium | **Rejected as filed** (F-1) — recommendation already implemented; the dapp's salt miner is sender-bound by construction. The "actual factory caller" warning is worth keeping for relayer integrations. |
| L-01 | Low | **Accepted.** Re-validation is pre-answered as L16, but the no-expiry framing is new and the interaction with H-01 matters. Clear the queue before any configuration change or major deposit. |
| L-02 | Low | Acknowledged (N-005). Adds the unusable-wallet angle to the known self-as-owner issue. |
| L-03 | Low | Already mitigated (Shred L-1, Opus M-1). |
| L-04 | Low | **Accepted, mitigated.** A real gap: `TimelockExecutor` has no `receive` and no withdrawal path, so plain ETH bounces but **tokens sent to it are stuck permanently**. It is now in the refused-destination set alongside the factory and implementation. |
| I-01 | Info | Accepted. `ownerCount` wrapping to zero makes `required = 0` and `forward()` fail-open on an empty bundle — impractical at ~65,536 owner additions, but a `require(required != 0)` belongs in any future module. |
| I-02 | Info | Accepted. Signatures have no deadline and stay valid until some transaction consumes the nonce. |
| I-03 | Info | **Independently confirms** the `forwardEnabled` stickiness we found during the second review. Set the flag explicitly on both installation and removal. |
| I-04 | Info | Accepted — all four tooling notes already handled in this client. |
| I-05 | Info | **Accepted.** A regression test that replays a cancellation bundle down the `execute()` route and asserts the original queued transaction matures first is the single most valuable test that could be added here. |

### On the prior fuzzing campaign

The reviewer notes that Shred Security's invariant campaign — 10/10 invariants
across ~327,680 handler calls — expressly excluded executor bypass and guardian
hooks, the factory paths, malformed signatures, and cross-wallet replay. **A
clean result over a scope that excludes the executor says nothing about a
composition defect in the executor.** Do not cite that number as broader
assurance than it is.

### Does this change the redeployment answer?

**Not for `Multisig` or `MultisigFactory`.** H-01 is a composition defect between
the wallet and the module, and the reviewer's own mitigation is client-side.

**It does move a `TimelockExecutorV2` from optional to first on the post-launch
list.** The reviewer's proposed struct — binding wallet, mode, target, value,
data hash, nonce and a deadline into a module-specific digest — is a better
design than the minimal typehash split the second review proposed, because it
closes the mode and expiry gaps too. A V2 remains adoptable per-wallet through
one threshold-signed `setExecutor`, with no migration, no address changes and no
funds moving.

---

## Second Review (Opus 5, 2026-07-26) — Disposition

**Full report with our responses inline:**
[`audit/report-opus5-max.md`](audit/report-opus5-max.md) ·
[transcript](https://claude.ai/share/c8a3a7d4-962f-4cb3-9fea-5690e9c7c7a2)

An independent review of `Multisig.sol` and `TimelockExecutor.sol` at commit
`09e2c38`, with 20 proof-of-concept tests. It re-filed four items that this
document's False Positive Patterns table already answers (its own status column
discloses this), and made one factual error: it reports the `Multisig`
implementation address as unpublished, when it appears in `README.md`,
`docs/src/README.md`, this file, and both dapp pages.

Setting those aside, it produced one significant new finding and several correct
smaller ones. **No contract was changed and none will be redeployed.** Five new
dapp-side guards were added.

| ID | Severity as filed | Our position | Mitigation |
|---|---|---|---|
| H-1 | High | **Accepted as a mechanism; downgraded to Low/Medium.** See below — the review window it removes was, on an n-of-n vault, never usable against a compromised co-signer in the first place. | The dapp surfaces it at deploy and requires a deliberate second press in admin; `txKind()` flags an inbound `enableForward(true)` as `FAST PATH · TIMELOCK BECOMES ADVISORY`. Not refused. |
| H-2 | High | **Rejected as filed.** "Executor can steal all funds" is in the False Positive Patterns table and `README.md` states "The executor has full control by design." The guard-specific *framing* is a fair documentation point — Safe's Guard restricts, ours grants custody — so it is worth a Low. | Documented. |
| M-1 | Medium | **Accepted, mitigated.** Correctly generalises Shred L-1 past self-reference: solc's `extcodesize` check means *any* codeless `0x1111` address is fatal. | The dapp now reads the chain and hard-blocks a `setExecutor` naming a marked address with no code. |
| M-2 | Medium | **Accepted, mitigated.** `setDelay` is an unbounded `uint32`. | Delays over 30 days require a second press, and are refused outright when the vault has no executor (no bypass, no cancel). `txKind()` flags them `SET TIMELOCK · EXTREME`. |
| M-3 | Medium | **Accepted, mitigated.** Correct: with `delay > 0` and no executor, a cancel is queued too and matures no earlier than what it cancels. | Deploy already always pairs `delay > 0` with the TimelockExecutor. The dapp now also refuses `setExecutor(0)` while a delay is set, and flags an inbound one `SET EXECUTOR · STRANDS THE QUEUE`. |
| M-4, M-5, L-6 | Medium/Low | **Rejected as filed** — F-1, F-2 and F-4 in the False Positive Patterns table. | Unchanged. |
| M-6 | Medium | **Downgraded to Info.** The outcome (revert on a nonce race) is right, but the stated mechanism is not: both nonce reads are in one transaction and cannot be interleaved. Signatures binding to the nonce at execution time is ordinary multisig behaviour that `execute()` shares. | None needed. |
| L-2 | Low | **Accepted, mitigated.** Correct and new — the fallback returns empty success for unrecognised selectors, so a mistyped governance self-call emits `ExecutionSuccess` and does nothing. | `txKind()` flags a self-call carrying a selector the wallet has no function for as `SELF-CALL · SILENT NO-OP`. |
| L-3 | Low | **Accepted.** `approved[owner][hash]` survives removal and reactivates on re-add. | Documented: an address removed for compromise must never be re-added. |
| L-5 | Low | **Acknowledged, no change.** Correct, but `Queued(hash, 0, 0)` as a cancellation signal is deliberate and recorded under Changes Made. | Unchanged. |
| I-1..I-9 | Info | **Accepted as informational.** I-7 (EIP-7702 storage is sticky across delegation changes) is the one worth propagating to users. | Documented. |

### H-1 — the shared typehash is deliberate, and why

The reviewer identifies the shared `Execute` typehash as "a deliberate UX
decision" without recovering the design goal. It is this: **signatures are meant
to accrue monotonically.** One signature is one signature, valid wherever it is
presented. Collect `threshold` and you hold a queueable transaction; if a further
owner signs the same digest before submission, you hold an instantly-executable
one — **with nobody re-signing anything.**

A 2-of-3 collects Alice and Bob; the proposal is queueable. Carol signs an hour
later; the set is now unanimous and can execute immediately. Alice and Bob are
never asked to sign a second, differently-named struct.

Bifurcating the domain is exactly what would destroy that. Every transaction
would need an up-front decision about which kind of signature to gather, and a
late-arriving signer would trigger a full re-collection. The convenience the
reviewer identifies as "the vulnerability" is the mechanism the whole collection
flow is built on.

The convenience lives in the pre-submission window. Once queued, the nonce
advances, the original digest is dead, and accelerating requires a fresh
unanimous round over the `executeQueued` wrapper — which is the right place for
friction, since that is where a delay already running is being overridden.

This is why the auditor's recommended `ForwardExecute` typehash is deferred to a
possible `TimelockExecutorV2` rather than treated as a fix to apply now.

### H-1 — why we downgraded it, and two properties the reviewer missed

**Cancellation requires `threshold` signatures, not unanimity.**
[`TimelockExecutor.forward()`](../src/mods/TimelockExecutor.sol#L42-L43) routes a
`cancelQueued` self-call on `threshold` sigs and — importantly — *without*
requiring `forwardEnabled`. So the emergency brake is available on every wallet
using this executor, fast path or not.

The consequence the reviewer did not draw: **on an n-of-n wallet, `threshold` is
everyone.** An honest owner cannot reach cancel quorum without the compromised
key. So the review window on an n-of-n vault was never a defence against a
compromised co-signer — it is mistake-recovery requiring unanimous agreement,
and third-party notice. That is true with or without H-1.

The asymmetry is the whole story: on a 2-of-3, two honest owners *can* cancel
around a compromised third. On a 2-of-2, nobody can. The timelock's
anti-compromise value only ever existed where `threshold < ownerCount` — exactly
the configuration H-1 does not affect.

What H-1 genuinely costs, therefore, is narrower than "the timelock provides no
guarantee":

1. **Third-party notice.** A wallet acting as a protocol admin advertises "you
   get N days' warning before anything changes." On n-of-n with the fast path
   on, that promise is void. This is the case where it still deserves Medium.
2. **Mistake recovery against an interested counterparty.** Owners queue a
   transfer, spot a wrong address, and move to cancel — but the recipient, who
   can see the signatures in the mempool, front-runs with `forward()` to deny
   the window.

For ordinary self-custody it is closer to Low: the owners authorised the
transaction, and the window they gave up needed their own unanimous agreement to
use. Hence a flag, not a refusal — the configuration is legitimate, it just must
not be a surprise.

**Two further properties, both new:**

- **On-chain approvals are a stronger form of the same collapse.**
  `forward()`'s `v=0` branch accepts `approved(signer, hash)` — *public
  contract state*, not a signature. On an n-of-n vault with the fast path on,
  once every owner has called `approve(hash, true)`, **any address at all** can
  call `forward()` with `v=0` slots naming them and execute immediately. There
  is no signature blob to obtain and no mempool race; the authorisation sits in
  public storage until the nonce moves past it. This dapp exposes that approval
  path directly. It is the same failure as H-1 with the access requirement
  removed entirely.
- **`forwardEnabled` is sticky across executor rotation.** It is keyed by wallet
  address in the module and never cleared. A wallet that enables the fast path,
  rotates its executor away, and later returns to the TimelockExecutor has the
  fast path back on with no proposal ever having re-enabled it. The wallet's own
  storage records nothing. This dapp reads `forwardEnabled` live from the
  module on every load, so its display stays correct, but operators reasoning
  from the wallet's state alone will be wrong. Compounds L-4.

### Does any of this require redeployment?

**No — not of `Multisig` or `MultisigFactory`.** Every accepted finding is either
configuration-dependent and blocked client-side (H-1, M-1, M-2, M-3), or
informational (L-2, L-3, I-*). None is reachable by an unauthorised party against
a correctly configured wallet; the reviewer states this explicitly.

The one item that would genuinely benefit from new bytecode is **H-1**, and it
does not need a migration. `TimelockExecutor` is a *swappable singleton*: the
executor is per-wallet mutable storage, so a fixed `TimelockExecutorV2` — with
its own `ForwardExecute` typehash (H-1) and an explicit `expectedNonce` parameter
(M-6) — can be deployed alongside the current one and adopted by any wallet
through an ordinary threshold-signed `setExecutor`. No wallet is redeployed, no
funds move, no address changes. Until then, the n-of-n block above removes the
exposure for anything built through this dapp.

Fixing **H-2** is what would require redeploying `Multisig` and the factory: it
needs a second storage slot to split the guard role from the executor role, and
slot 0 is full at 32 bytes. Given that the executor's full authority is
documented design and on the false-positive list, that is not a trade we are
making.

**Residual risk we accept**, all of it outside this dapp: a wallet driven by
other tooling can still be pointed at a codeless `0x1111` executor (M-1), given
an unbounded delay with no executor (M-2), stripped of its executor under a live
timelock (M-3), or have the fast path enabled at n-of-n (H-1). These are one-way
doors reachable only by a threshold of owners deliberately signing for them, and
none is fixable without redeploying the singletons.

---

### L-1 — why the dapp, not the contract

The DoS needs two deliberate steps that only ever happen through a client: a
vault living at an address carrying the `0x1111` marker, and a threshold-signed
`setExecutor(address(this))`. The dapp's own salt miner searches for a `0x00`
prefix and can never produce a marked address, so a vault it deploys is not
exposed at all. What remains is an imported address or an EIP-7702 delegation
plus a proposal — and a proposal has to be raised, signed by a threshold of
owners, and (under a timelock) survive its delay. The dapp refuses to raise it
and flags it in red for every co-signer if it arrives from elsewhere.

**Residual risk.** An owner set that signs `setExecutor(address(this))` outside
this dapp, at a marked address, still bricks the vault. That is unreachable from
here and unfixable without a redeploy. If a future version of `Multisig.sol` is
ever deployed, apply the auditor's fix: `require(_executor != address(this))`.

### L-2 — ETH sent to the singletons is permanently locked

Recorded here per the auditor's second recommendation, which the payable
constructors are kept for (~24 gas at deploy time):

> **ETH or tokens sent directly to `MultisigFactory`
> (`0x000000000e8CB9ed9DC2114d79d9215eacb9cB07`) or to the `Multisig`
> implementation (`0xD54cb65224410F3Ff97a8E72f363f224419f4FB0`) are
> unrecoverable.** Neither contract has a withdrawal path, and the
> implementation is never initialized, so it has no owners to authorize one.
> There is no recovery for anyone, including the deployer.

Value passed to `create()` / `createWithCalls()` is *not* affected — the factory
forwards `callvalue()` into the CREATE2 as the new vault's opening balance.

### I-2 — accepted

`DOMAIN_SEPARATOR()` stays live. Caching it in `init()` would trade ~500–800 gas
per call for fork-awareness logic and extra clone storage, and correctness is
already unaffected: the live `block.chainid` read is what makes signatures
fork-safe by construction. This is the intended minimal design.

### Deployment checklist (Appendix A)

Gaps the dapp can close, it now closes. Deploy preflight reads
`MultisigFactory.implementation()` on every target chain and refuses to treat an
address holding other code as the factory. After a deploy lands, the vault's
runtime bytecode is compared against the audited 45-byte clone of
`IMPLEMENTATION` and its owners, threshold, delay and executor are read back and
matched against what was requested — a chain that cannot be read back is
reported `DEPLOYED · UNVERIFIED` rather than counted as verified. Every vault
load runs the same bytecode classification and badges anything that is not the
audited build as `UNVERIFIED CODE`.

The remaining gaps are operational and out of a client's reach: fork-based
mainnet tests, CI, monitoring and alerting, incident-response drills, and a
normative deployment runbook. They remain open.

---

## Architecture Overview

| Component | Lines | Description |
|---|---|---|
| `Multisig` | 4–265 | Threshold multisig with optional timelock, executor role, pre/post guardian hooks, and onchain approvals. All mutable state (`delay`, `nonce`, `threshold`, `ownerCount`, `executor`) packed in a single storage slot. |
| `MultisigFactory` | 267–321 | Minimal proxy (PUSH0 clone) factory with CREATE2, Solady-style sender-bound salt, and `createWithCalls` for atomic module setup. |

> **Note on line references:** All line numbers in this document were verified against the current source as of the audit date. If the source has been modified since, re-verify with `grep -n` before relying on cited lines.

### Access Control Model

There are **no admin keys**. The factory is permissionless. The `implementation` is deployed in the constructor and is immutable.

- **`onlySelf`** — `msg.sender == address(this)`. All configuration changes (`addOwner`, `removeOwner`, `setThreshold`, `setDelay`, `setExecutor`, `batch`, `delegateCall`) require the multisig to call itself via a signed `execute`.
- **Executor** — Optional trusted address that bypasses signatures and timelock. Comparable to Safe modules. This is critical context: any finding that requires "the executor does X" is a trust assumption, not a vulnerability.
- **Owners** — Must collectively produce >= threshold valid approvals (ECDSA signatures, onchain `approve`, or `msg.sender` bypass). Individual owners below threshold have no unilateral power.

### Key Design Decisions

- **Executor is fully trusted.** It bypasses signatures and timelock by design. If the executor is compromised, it has unilateral control. This is the intended trust model.
- **Guardian hooks are encoded via executor vanity address.** Leading `0x1111` = pre-hook, trailing `0x1111` = post-hook. No storage overhead.
- **Pre-hook fires before signature validation.** Intentional — allows blocklist/policy checks before authorization.
- **Owner linked list is sorted on init but not on addOwner.** Signature verification checks ascending signer order independently of list order.
- **CREATE2 salt uses Solady `checkStartsWith` pattern.** Zero-prefix = open deploy, sender-prefix = sender-bound. No on-chain hashing of init params (unlike Safe).
- **`isValidSignature` uses EIP-712 `SafeMessage` wrapping (Safe-inspired, not byte-compatible).** The supplied hash is wrapped in `EIP712(SafeMessage(bytes32 hash))` before verification. Safe uses `SafeMessage(bytes message)` with dynamic `bytes` encoding — same pattern, different type hash. Signatures produced by the Safe UI/SDK will not validate here. Generic ERC-1271 callers that pass a raw hash will get false negatives — this is intentional, not a bug.
- **Contract owners are supported via onchain approvals.** Contract addresses can be added as owners and approve transactions by calling `approve(hash, true)` or by submitting `execute` directly (`msg.sender` bypass with `v=0`). ERC-1271 inline verification is intentionally omitted to keep the signature loop simple and gas-efficient — the `approve` + sender bypass pattern covers all account types without external calls in the hot path.
- **`execute()` allows `msg.sender` bypass; `isValidSignature()` does not.** In `execute()`, a v=0 signature slot passes if `msg.sender == signer` (no prior `approve` needed). In `isValidSignature()` (ERC-1271, `view`), there is no caller to attribute — all v=0 slots require prior `approve`. This makes ERC-1271 strictly stronger than `execute` authorization. Intentional asymmetry.
- **`createWithCalls` uses temporary executor pattern.** The factory sets itself as executor during setup calls, then sets the real executor last. The factory is trusted immutable code and the entire operation is atomic.
- **`getTransactionHash` is a public view.** Exposes the internal EIP-712 digest computation for off-chain tooling. No state changes, no security implications.

---

## Defense Mechanisms

Before flagging a finding, verify it is not already neutralized by one of these:

| Defense | Mechanism | What It Prevents |
|---------|-----------|-----------------|
| **Ascending signer order** | `signer > prev` check in sig loop (lines 127, 155) | Duplicate signers, signature replay within a single call |
| **EIP-712 domain separation** | `DOMAIN_SEPARATOR()` includes `address(this)` and `chainId` | Cross-chain replay, cross-wallet replay |
| **Nonce increment** | `nonce++` in unchecked block, included in EIP-712 hash | Transaction replay |
| **Sender-bound salt** | `salt >> 96 == uint160(msg.sender)` (line 286) | CREATE2 front-running for pre-funded addresses |
| **Init guard** | `threshold == 0` check (line 42) — init only succeeds once | Double initialization |
| **Factory-only init** | `msg.sender == factory \|\| msg.sender == address(this)` (line 40). Factory only calls `init` on clones (line 298), never the implementation. Self-call path is unreachable on uninitialized contracts (circular: `execute` requires `threshold != 0`) | Third-party initialization of implementation or clones |
| **onlySelf modifier** | `msg.sender == address(this)` on all config functions | Unauthorized state changes |
| **Queued hash deletion** | `delete queued[hash]` before external call (line 194); if call reverts, deletion is also reverted atomically — hash remains available for retry | Replay of queued transactions |
| **cancelQueued** | Executor-only (line 183), no timelock. Deletes the queued hash; a cancelled tx cannot be revived (re-queuing produces a new hash due to nonce) | Emergency cancellation within delay window |
| **Onchain approval ownership check** | `isOwner(msg.sender)` in `approve()`, `_owners[signer] != address(0)` in sig loop | Non-owners approving, removed owners using stale approvals |
| **Sender bypass limited to one** | Only one `v=0` slot can match `msg.sender` per `execute` call; others require prior `approve` | Impersonating multiple signers via sender bypass |
| **Approval revocation** | `approve(hash, false)` sets `approved[owner][hash] = false` | Owner changing their mind before quorum is reached |
| **Solady-style assembly clone** | PUSH0 minimal proxy (lines 287–295) | Deployment gas overhead, non-deterministic addresses |

### Timelock State Machine

Each transaction hash has three possible states:

```
                    execute() with delay > 0
  UNQUEUED ────────────────────────────────► QUEUED (queued[hash] = block.timestamp + delay)
     ▲                                         │
     │                                         ├── executeQueued() after eta ──► EXECUTED (delete queued[hash])
     │                                         │
     └──── cancelQueued() by executor ─────────┘   (delete queued[hash])
```

**Key properties:**
- **Hash uniqueness:** The nonce is included in the EIP-712 hash. Each `execute()` increments the nonce, so re-queuing the same `(target, value, data)` after cancellation produces a different hash.
- **No revival:** A cancelled hash cannot be re-queued — it would require the same nonce, which has already been consumed.
- **Atomic retry:** If `executeQueued()` reverts (target call fails), the `delete queued[hash]` is also reverted. The hash remains queued for retry.
- **Executor bypass:** When `msg.sender == executor`, the transaction executes immediately regardless of delay — the queue path is never entered.
- **Permissionless execution:** Anyone can call `executeQueued()` after the ETA. Only `cancelQueued()` is gated to the executor.

---

## Key Invariants

These properties should hold. If you find a violation, it's likely a real finding:

1. **Init is one-shot** — `threshold` starts at 0 and is set to a nonzero value in `init()`. Once nonzero, `init()` reverts. No path resets `threshold` to 0.
2. **Owner linked list is well-formed** — `SENTINEL → owner₁ → owner₂ → ... → ownerₙ → SENTINEL`. No cycles, no dangling pointers, `ownerCount` matches actual list length, and `getOwners()` terminates returning exactly `ownerCount` elements.
3. **Nonce is monotonically increasing** — `nonce++` in unchecked block. Each `execute` consumes exactly one nonce. No path decrements or resets the nonce.
4. **Queued hash is a one-shot latch** — `queued[hash]` is set once (in `execute` with delay), deleted on `executeQueued` or `cancelQueued`, and never re-set for the same hash (nonce prevents collision).
5. **Signature threshold is enforced for non-executor callers** — `sigs.length == threshold * 65` and each signer is a valid owner in ascending order. Each 65-byte slot is either an ECDSA signature (`v >= 27`), an onchain approval (`v == 0`, requires `approved[signer][hash]`), or a sender bypass (`v == 0`, requires `msg.sender == signer`).
6. **Clone delegates to immutable implementation** — The factory's `implementation` is set once in the constructor and is immutable. All clones delegate to this address.
7. **Single storage slot packing** — `delay` (uint32) + `nonce` (uint32) + `threshold` (uint16) + `ownerCount` (uint16) + `executor` (address) fit in one 256-bit slot. No field write corrupts another.

---

## Resolved Findings

| ID | Title | Resolution |
|---|---|---|
| F-3 | Queued transactions had no cancellation mechanism | Added `cancelQueued(bytes32)` — executor-only emergency cancellation. The executor is the only role that can act within the timelock window without delay. |

---

## Changes Made

| Change | Status | Description |
|---|---|---|
| `cancelQueued` event | (pending) | `cancelQueued` now emits `Queued(hash, 0, 0)` for indexer visibility. `eta = 0` signals cancellation. |

---

## Acknowledged Findings (Design Tradeoffs)

### F-1: Pre-fund theft via zero-prefix CREATE2 salt front-running

**Severity:** Medium | **Confidence:** 75

The factory allows zero-prefix salts (`salt >> 96 == 0`) for permissionless deploys. Since the proxy init code is identical regardless of owners, an attacker can front-run a zero-prefix deploy with different owners and claim the address. If ETH was pre-funded to that address, the attacker controls it.

**Response:** This is the canonical Solady `LibClone.checkStartsWith` pattern. Zero-prefix salts are for gas-efficient relayer deploys where no pre-funding occurs. Sender-bound salts (`salt >> 96 == uint160(msg.sender)`) prevent front-running for the pre-fund case. Both Safe and this factory allow open deploys — this factory just does it without hashing initializer params into the salt, saving ~160 gas.

**Guidance for reviewers:** This is a known tradeoff, not a bug. Do not re-file unless you find a scenario where sender-bound salts fail to protect pre-funded addresses.

### F-2: Pre-execution hook fires before signature validation

**Severity:** Medium | **Confidence:** 90

When the executor address has leading bytes `0x1111`, the pre-hook external call fires before signature verification. Unvalidated parameters are forwarded to the executor contract.

**Response:** Intentional. The guardian needs to see (and potentially block) transactions before authorization — this is a blocklist/policy-enforcement pattern. EVM atomicity ensures no state persists if the subsequent sig check fails (for non-executor callers). When `msg.sender == executor`, sigs are already bypassed by design.

### F-4: `executeQueued` callable by anyone

**Severity:** Low | **Confidence:** 65

Once a queued transaction's ETA passes, any address can trigger execution.

**Response:** Intentional for relayer compatibility. `cancelQueued` (executor-only) provides the emergency brake.

### F-5: Post-hook fires even when transaction is only queued

**Severity:** Low | **Confidence:** 75

The post-hook fires unconditionally — including when a transaction is queued rather than executed.

**Response:** Intentional. The guardian can inspect queued parameters and revert the entire transaction (including the queue write) to act as a veto on queuing.

### F-6: Both pre-hook and post-hook fire for crafted executor address

**Severity:** Low | **Confidence:** 75

An executor address matching both `0x1111...` prefix and `...0x1111` suffix triggers `executor.execute()` twice per transaction.

**Response:** Intentional dual-hook design. Pre-hook is for blocking/banning, post-hook is for notification/veto.

---

## Leads (Reviewed, Not Scored)

These were investigated during the audit and determined to be non-issues or accepted risks. **Do not re-file** unless you have a concrete exploit path not covered below.

| ID | Lead | Assessment |
|---|---|---|
| L1 | Executor bypasses sigs + timelock | By design — trusted module pattern |
| L2 | Executor can burn nonces; cancelled queued txs leave permanent nonce gaps | Subset of executor trust; cancel-gap is operational consideration for batch workflows |
| L3 | Unsafe uint16 downcast of threshold | Unreachable — 65,536+ owners exceeds block gas limit |
| L4 | No low-s check in ecrecover (signature malleability) | Mitigated by sorted-signer ordering; both `(s)` and `(n-s)` recover the same address, and ascending signer check prevents double-counting |
| L5 | uint32 nonce overflow in unchecked block | ~4B txs required — impractical |
| L6 | Stale executor reference in post-hook | Cached at function entry; if `setExecutor` is called mid-tx, post-hook uses old address. Atomic tx limits impact |
| L7 | No reentrancy guard on execute | Non-executor reentrant calls still require valid sigs per nonce |
| L8 | Uninitialized implementation contract | Impossible to initialize: factory only calls `init` on clones (line 298), not the implementation; self-call path requires `threshold != 0` which requires prior initialization (circular). Holds no funds |
| L9 | `batch()` missing array length validation | Solidity ABI decoder reverts on out-of-bounds |
| L10 | `addOwner` breaks sorted-order invariant | Cosmetic — sig verification checks signer order, not list order |
| L11 | `msg.value` not earmarked when tx is queued | Design tradeoff — multisig is expected to hold ETH |
| L12 | EIP-7702 EOA key remains a superuser | Inherent 7702 property — EOA key bypasses threshold, can call `onlySelf` functions, and revoke delegation. Deployment caveat, not a contract bug |
| L13 | Fallback silently succeeds for unknown selectors | `fallback()` only handles 3 token callbacks; other selectors return success with empty data. Masks operator self-call typos. Not exploitable (requires threshold sigs) |
| L14 | `isValidSignature` type hash differs from Safe | Uses `SafeMessage(bytes32 hash)` vs Safe's `SafeMessage(bytes message)`. Intentional — own signing domain, not byte-compatible with Safe SDK |
| L15 | No ERC-1271 inline signature verification | Contract owners use `approve()` or `msg.sender` bypass instead of inline ERC-1271. Intentional — avoids external calls in sig loop |
| L16 | `executeQueued` does not re-validate signer set | Accepted — re-validation requires on-chain sig storage; delay + `cancelQueued` is the mitigation |
| L17 | Pre/post hook return values silently discarded | Accepted — revert-based enforcement is the intended pattern |
| L18 | v=0 `msg.sender` bypass asymmetry: `execute` vs `isValidSignature` | Intentional — submitter counts as signer in `execute` only; ERC-1271 is strictly stronger |
| L19 | Non-monotonic `ExecutionSuccess` events from `executeQueued` | Accepted — hash commits to nonce; indexers must handle out-of-order nonces |
| L20 | ERC-1271 message approvals revive on owner re-addition | `approved` mapping persists through remove→re-add; `isValidSignature` message hashes are not nonce-bound. Mitigated: rotate to fresh key instead of re-adding same address |
| L21 | Wallet can be configured as its own owner | `init()` and `addOwner()` do not reject `address(this)`. A wallet added as its own owner cannot produce ECDSA sigs, and the `v=0` sender bypass requires an already-authorized self-call (circular if the wallet's slot is needed for quorum). Config-dependent freeze — e.g., `owners=[Alice, W], threshold=2` is permanently stuck. Self-inflicted misconfiguration; no code fix warranted (blocking `address(this)` in `addOwner` would break EIP-7702 EOA-as-own-owner use case) |

---

## False Positive Patterns (Do NOT Flag These)

These patterns were repeatedly surfaced by automated auditors and confirmed as non-issues. If your analysis produces one of these, discard it:

| Pattern | Why It's Not a Bug |
|---------|-------------------|
| "Executor can steal all funds" | The executor is an intentionally trusted role — this is the design, not a finding. Users who set an executor accept full trust. Comparable to Safe modules. |
| "Pre-hook fires before sig validation" | Intentional guardian pattern (F-2). EVM atomicity prevents state persistence for unauthorized callers. |
| "No reentrancy guard on execute" | Each reentrant call requires valid signatures for a fresh nonce (L7). The nonce increment is the reentrancy defense. |
| "Anyone can call executeQueued" | Intentional for relayer compatibility (F-4). cancelQueued is the emergency brake. |
| "addOwner doesn't enforce sorted order" | Cosmetic (L10). Sig verification checks ascending *signer* order in the signature array, not the linked list order. |
| "uint32 nonce will overflow" | Requires ~4B transactions (L5). Impractical on any chain. |
| "Implementation contract is uninitialized" | Initialization is provably impossible (L8). The factory only calls `init` on clones (line 298), never the implementation. The self-call path (`msg.sender == address(this)`) is unreachable because `execute()` requires `threshold != 0` — circular dependency. It holds no funds. |
| "msg.value is not earmarked for queued tx" | Design tradeoff (L11). The multisig is expected to hold ETH. Queued txs use whatever balance exists at execution time. |
| "Zero-prefix salt allows front-running" | Known tradeoff (F-1). Use sender-bound salt for pre-fund. Zero-prefix is for open/relayer deploys. |
| "delegateCall can corrupt storage" | Intentional power — gated by `onlySelf`. Requires threshold-of-n signatures. Same design as Safe. |
| "Force-fed ETH via selfdestruct" | Economically irrational — attacker donates their own ETH. No accounting invariant depends on `address(this).balance`. |
| "No admin can freeze/pause" | There is no admin. `onlySelf` = self-governance. This is the design. |
| "EIP-7702 breaks multisig security" | The EOA key is an inherent superuser in 7702 deployments (L12). This is a deployment-model property, not a contract vulnerability. Clone-based wallets are unaffected. |
| "isValidSignature is not standard ERC-1271" | Intentional EIP-712 `SafeMessage(bytes32 hash)` wrapping — Safe-inspired pattern. Not byte-compatible with Safe's `SafeMessage(bytes message)`. Generic callers that pass a raw hash get false negatives by design. |
| "No ERC-1271 inline signature verification" | Contract owners are fully supported via `approve()` and `msg.sender` bypass (`v=0`). ERC-1271 inline checks are omitted to avoid external calls in the sig loop — the approval pattern is a simpler, universal alternative. |
| "executeQueued doesn't re-check signers" | Re-validation requires on-chain sig storage (L16). The delay window + `cancelQueued` is the intended mitigation. |
| "execute has lower effective threshold than isValidSignature" | Intentional asymmetry (L18). The submitter's `msg.sender` counts as one signer in `execute` — this is the design. `isValidSignature` (ERC-1271, `view`) has no caller to attribute. |
| "delegateCall can zero threshold and re-init" | Requires threshold-of-owners who can already drain funds directly via any `execute` call. Tautological — not a vulnerability. |
| "ExecutionSuccess events are out of order" | `executeQueued` emits historical nonces (L19). Hash commits to nonce so the value is validated. Off-chain indexers must not assume monotonic ordering. |

---

## Trust Assumptions

1. **Executor** — Has unilateral, immediate control over the wallet. Setting an executor is equivalent to granting a master key. Owners should only set an executor they fully trust (e.g., a security council multisig or social recovery guardian).
2. **Owners** — Must collectively control >= threshold keys. Individual owners below threshold have no unilateral power.
3. **Factory deployer** — The factory is permissionless. The `implementation` is deployed in the constructor and is immutable. No admin keys.
4. **Timelock** — Protects against owner compromise by giving stakeholders an exit window. The executor operates outside the timelock by design.
5. **Guardian (executor with vanity address)** — Trusted to act honestly in pre/post hooks. A malicious guardian can block all transactions (pre-hook revert) or observe transaction parameters before execution.
6. **EIP-7702 EOA key** — In 7702 deployments, the delegating EOA's private key is an implicit superuser. It can send transactions bypassing the multisig, call `onlySelf` functions (satisfies `msg.sender == address(this)`), and revoke the delegation. The k-of-n threshold is not a hard boundary — treat the EOA key as a (k=1) override. This model suits personal wallets (co-signing), not shared custody.

---

## Guidance for Future Reviewers

### Scope

- `src/Multisig.sol` — single file, ~321 lines, contains both `Multisig` and `MultisigFactory`
- `src/mods/` — singleton module contracts (AllowlistGuard, SpendingAllowance, SocialRecovery, DeadmanSwitch, CancelTx)
- Test suite: `test/Multisig.t.sol`, `test/Mods.t.sol`, `test/EIP7702.t.sol`, `test/Gas.t.sol`
- No external dependencies beyond forge-std

### Test Coverage

280 tests (201 unit/integration + 33 module tests + 46 gas benchmarks + EIP-7702), 0 failures.

**Reported by `forge coverage`:** 88.5% lines, 86.8% statements, 76.7% branches, **100% functions**.

The gap between reported and actual coverage is a forge instrumentation limitation — forge cannot instrument code inside `unchecked {}` blocks or inline `assembly` blocks. All 14 "uncovered" lines fall into these categories:

| Lines | Location | Why unreported | Actually tested by |
|-------|----------|---------------|-------------------|
| 52 | `prev = owner` in `init` unchecked loop | `unchecked` block | Every `_deploy*` helper (100+ calls) |
| 100 | `prev = signer` in `isValidSignature` unchecked loop | `unchecked` block | `test_isValidSignature_*` (9 tests) |
| 239–242 | `fallback()` assembly | inline assembly | `test_onERC721Received`, `test_onERC1155*`, `test_fallbackUnknownSelectorReturnsEmpty` |
| 269–277 | `create()` CREATE2 assembly | inline assembly | Every `factory.create` call (60+ calls), `test_factory_revertDuplicateSalt` |

Similarly, all 6 uninstrumented branches (marked `-` in lcov) are tested in both pass and revert directions. Effective coverage of reachable Solidity code paths is 100%.

**Test categories covered:**
- Factory: deterministic deploy, salt access control, value forwarding, duplicate salt revert
- Init: one-shot guard, invalid configs (threshold, ordering, duplicates, address(0), sentinel)
- Execute: ETH transfers, data calls, all signer counts, nonce replay, sig validation (invalid/duplicate/wrong-order/zero-recovery)
- Timelock: queue, execute after delay, too early, replay, wrong params (target/value/data/nonce), cancel + re-queue, multiple simultaneous queued txs, ETA verification
- Cancel: executor cancels, non-executor revert, no executor set, nonexistent hash no-op
- Executor: bypass sigs, bypass delay, set/revoke, concurrent with owner timelock
- Owner management: add, remove (first/middle/last), linked list integrity, new owner can sign, removed owner can't sign
- Batch: empty, single, multi, with values, atomic add+threshold, atomic remove+threshold, inner call failure
- EIP-1271: valid, invalid, cross-wallet isolation, domain isolation from execute, onchain approvals
- EIP-712: domain separator, type hashes, cross-chain (fork), cross-wallet, getTransactionHash
- Guards: pre, post, both, plain executor, reverts, with delay, executor bypass
- DelegateCall: via execute, via batch, not-self revert, inner failure
- EIP-7702: delegation, init via self-call, EOA superuser, batch, timelock, executor
- Onchain approvals: approve + execute, all-approvals, revoke, sender bypass, mixed ECDSA + approval ordering, contract owner approval, revert not-approved, revert not-owner, event emission
- Factory createWithCalls: sets executor, advances nonce, empty calls, value forwarding, salt validation, bad call revert, multiple calls, wallet functional after
- Modules: AllowlistGuard (createWithCalls, addedLater, self-config bypass, selector blocking), SpendingAllowance (spend, overLimit, periodReset), SocialRecovery (propose, finalize, cancel, delay), DeadmanSwitch (heartbeat, claim, timeout), CancelTx (threshold cancel, unanimous fast-forward with opt-in enableForward, double-vote revert, not-owner revert, timelock preserved)
- Fuzz: threshold bounds, removeOwner integrity, salt access control, sig length

### How to Run

```bash
forge build
forge test -vvv                    # full suite (280 tests)
forge test --mc MultisigTest -vvv  # unit/integration (201 tests)
forge test --mc ModsTest -vvv      # module tests (33 tests)
forge test --mc GasTest -vv        # gas benchmarks
forge coverage --ir-minimum        # coverage report
```

### Audit Methodology

Work in **three rounds**, producing output for each before moving to the next.

#### Round 1: Systematic Code Review

Walk through each vulnerability category in order. For each, cite specific lines, trace the code path, and state your conclusion. Include categories where you find nothing — say "No issues found" with a one-sentence explanation of the defense mechanism. Cover every function with external visibility.

**Vulnerability categories:**

1. **Reentrancy** — No `nonReentrant` guard. Defense is nonce-per-call. Verify that every reentrant path requires a fresh nonce and valid signatures. Check guardian hook callbacks.
2. **Signature / Replay** — EIP-712, ecrecover loop, ascending signer order, nonce. Check for cross-chain replay, cross-wallet replay, malleability, `ecrecover` returning `address(0)`.
3. **Access Control** — `onlySelf`, executor bypass, factory-only init. Check for privilege escalation paths, especially via `delegateCall` and `batch`.
4. **Front-Running** — CREATE2 salt pattern, `executeQueued` timing, guardian hook parameter exposure.
5. **Timelock Logic** — Queue/execute/cancel state machine. Check for hash collisions, replay after cancellation, timing edge cases, nonce reuse.
6. **Arithmetic** — uint16 downcasts, uint32 nonce in unchecked, signature length math. Check for overflow/underflow paths.
7. **Storage Packing** — Single-slot layout. Verify reads/writes don't corrupt adjacent fields.
8. **Linked List Integrity** — Owner add/remove, sentinel handling. Check for cycles, dangling pointers, off-by-one in ownerCount.
9. **EIP-7702** — Dual-path init (factory vs self-call). Verify EOA superuser semantics don't bypass intended restrictions.
10. **External Calls** — `target.call{value}(data)` in execute/executeQueued/batch, `delegatecall` in delegateCall, guardian hooks. Check return value handling.

#### Round 2: Cross-Function Analysis

Look for **interactions between mechanisms** — places where two individually-safe features create a vulnerability when combined. Focus on:
- Guardian hooks + reentrancy via `execute`
- Executor bypass + timelock + nonce burning
- `delegateCall` + `onlySelf` + storage layout
- `batch` + `addOwner`/`removeOwner` + threshold changes
- EIP-7702 EOA key + multisig init + executor
- `approve` + `removeOwner` — stale approvals after owner removal (defended by `_owners[signer]` check in sig loop)
- `msg.sender` bypass + multiple `v=0` slots — only one can match `msg.sender`, others need prior `approve`
- `createWithCalls` + factory-as-executor — verify factory cannot retain executor role after `createWithCalls` returns

For each candidate attack, estimate the economic cost vs gain.

#### Round 3: Adversarial Validation

Switch roles. You are now a **budget-protecting skeptic** whose job is to minimize false positives. For every finding from Rounds 1 and 2:

1. **Attempt to disprove it.** Find the code path, guard, or constraint that prevents the attack.
2. **Check it against the Known Findings.** If it matches F-1 through F-6 or L1 through L19, discard it as a duplicate.
3. **Check it against the False Positive Patterns table.** If it matches, discard it.
4. **Apply the trust-assumption rule.** If it requires a compromised executor, it is not a vulnerability — it is within the executor's trust boundary.
5. **Rate your confidence** (0-100) in the finding surviving disproof.
6. **Only include findings that survive all five checks.**

### Critical Code Paths (Priority Order)

1. **`execute`** (lines 134–174) — Signature verification (ECDSA + onchain approval + sender bypass), executor bypass, timelock branching, guardian hooks. Highest-risk function.
2. **`approve`** (lines 176–180) — Onchain approval/revocation. Owner-gated. Verify removed owners can't use stale approvals (checked in sig loop via `_owners[signer]`).
3. **`executeQueued`** (lines 188–199) — Permissionless execution of timelocked transactions. Hash-based replay prevention. Pre/post guardian hooks (same vanity-address encoding as `execute`).
4. **`init`** (lines 39–58) — Owner linked list construction, threshold/delay/executor setup. One-shot guard.
5. **`cancelQueued`** (lines 182–186) — Executor-only emergency cancellation. Added post-audit to resolve F-3. Simple but trust-critical: verify it cannot be called by non-executor, and that cancelled hashes cannot be revived.
6. **`isValidSignature`** (lines 107–132) — ERC-1271 support. Separate EIP-712 domain from `execute`. Supports onchain approvals (no sender bypass — `view` function).
7. **`delegateCall`** (lines 201–204) — Arbitrary code execution in wallet context. Storage corruption risk.
8. **`create`** (lines 280–300) — Factory clone deployment. Assembly CREATE2 + init call.
9. **`createWithCalls`** (lines 305–320) — Atomic deploy + module setup. Temporary factory-as-executor pattern.

### Severity Criteria

| Severity | Definition |
|----------|------------|
| **Critical** | Direct theft of funds OR permanent freeze of wallet. Exploitable by any external account without owner signatures. |
| **High** | Temporary freeze of funds, bypass of signature/timelock for non-executor callers, or significant economic damage. |
| **Medium** | Griefing, DoS, or economic inefficiency with real impact. Attacker gains no direct profit. |
| **Low** | Edge case, configuration-dependent, or requires unlikely conditions. |
| **Informational** | Best practice deviation or theoretical concern with no practical exploit path. |

**Severity adjustment rules** (apply in order):

1. **Trust-assumption rule:** If the finding requires a compromised executor — downgrade by 2 levels or mark Out of Scope. A trusted executor acting maliciously is a trust assumption, not a vulnerability.
2. **Economic irrationality:** If attack cost > gain, downgrade by 1 level.
3. **User-controlled mitigation:** If the user can avoid the issue through their own action (e.g., using sender-bound salt), downgrade by 1 level.

### Report Format

For each finding, use this structure:

```
### [SEVERITY-NUMBER] Title

**Severity:** Critical / High / Medium / Low / Informational
**Confidence:** 0-100
**Contract:** Multisig / MultisigFactory
**Function:** `functionName`, line(s) N-M
**Bug class:** (e.g., reentrancy, replay, front-running, access-control)

**Description:**
One paragraph. Reference specific variable names and line numbers.

**Attack Path:**
1. Attacker calls `function(args)` — this does X
2. State change: Y happens because Z
3. Result: quantified impact

**Proof of Concept:** (required for Medium+)
Concrete call sequence with actual function signatures and parameter values.

**Disproof Attempt:**
How you tried to disprove this finding. What defenses did you check?
Why does the attack survive despite those defenses?

**Gate Evaluation:**
- Gate 1 (Refutation): Can design intent explain this? [Yes/No]
- Gate 2 (Reachability): Is the state reachable? [Yes/No]
- Gate 3 (Trigger): Can an unprivileged attacker trigger it? [Yes/No]
- Gate 4 (Impact): Is the impact material? [Yes/No]
- Duplicates Known Finding? [No / Yes: F-N or L-N]

**Recommendation:**
Specific, minimal fix — one code change, not a redesign.
```

Findings must clear all four gates to be scored. Leads are trails that cleared some but not all gates.

### Invariant Verification

Your report must include a table verifying each invariant from the "Key Invariants" section:

| # | Invariant | Verified / Violated | Evidence |
|---|-----------|---------------------|----------|
| 1 | Init is one-shot | | |
| 2 | Owner linked list is well-formed | | |
| 3 | Nonce is monotonically increasing | | |
| 4 | Queued hash is one-shot | | |
| 5 | Signature threshold enforced for non-executor | | |
| 6 | Clone delegates to immutable implementation | | |
| 7 | Single storage slot packing is correct | | |

### Category Coverage Matrix

Your report must include a conclusion for every vulnerability category:

| # | Category | Result | Defense Verified |
|---|----------|--------|-----------------|
| 1 | Reentrancy | | |
| 2 | Signature / Replay | | |
| 3 | Access Control | | |
| 4 | Front-Running | | |
| 5 | Timelock Logic | | |
| 6 | Arithmetic | | |
| 7 | Storage Packing | | |
| 8 | Linked List Integrity | | |
| 9 | EIP-7702 | | |
| 10 | External Calls | | |
