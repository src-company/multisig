# Security Audit Report — MultisigFactory / Multisig / TimelockExecutor

**Auditor:** leftclaw automated audit (two-phase-audit-v2), commissioned via One Dollar Audit
**Date:** 2026-07-25
**Chain:** Ethereum mainnet (chain ID 1)
**Scope:** ~408 LOC — `Multisig.sol` (322), `TimelockExecutor.sol` (71), `IMultisig.sol` (17)

| | |
|---|---|
| Result page | <https://leftclaw.services/result/500.html> |
| One Dollar Audit | <https://www.onedollaraudit.com/audit/500> |
| Canonical report (IPFS) | `bafkreibwievvhfo56qusfpjpgocih456azb5cjdtecjoq77zs27kxe57e4` |

**Result as delivered:** 1 Critical, 2 High, 4 Medium, 5 Low.

---

## About this file

This reproduces the delivered report with the maintainers' responses added.
Everything outside a **▸ Response** block is the reviewer's text as written;
every **▸ Response** block is ours.

This is the fourth independent review of these contracts. It is the only one to
have run a **multi-agent pipeline with an explicit reconciliation and rejection
pass**, and that discipline shows: it carries a *Rejected Claims* section
documenting a false finding it threw out, and a *Leads* section for items below
its confidence floor. Two of its Leads correctly identify as impractical the
very things two earlier reviews filed as findings.

**Two verifications settled disagreements between auditors.** We downloaded solc
`0.8.34+commit.80d5c536` — the exact compiler the deployed contracts were built
with — to settle both. Details in the responses to H-2 and L-5.

### Disposition summary

| ID | Filed | Our position | Contract change |
|---|---|---|---|
| C-1 | **Critical** | **Rejected.** The proof-of-concept misreads which address the hook pattern applies to. Under the correct reading the preconditions require mutual executor designation — i.e. the documented total-trust relationship — and the hook grants nothing the executor role does not already grant. | None |
| H-1 | High | **Already mitigated** (Shred L-1, Opus M-1). Their revert analysis is right, and contradicts their own L-5. | None |
| H-2 | High | **Accepted, new, and correct — the most valuable finding in this report.** It corrects two prior audits that quoted a break point 65× too high. Now guarded in the dapp. | None |
| M-1 | Medium | **Accepted.** Real double-execution path. Our acceleration flow already uses the wrapper they recommend. | None |
| M-2 | Medium | **Confirmed** — independently reaches GPT-5.6's H-01. Already mitigated. | None |
| M-3 | Medium | **Confirmed** — independently reaches Opus 5's H-1. Already surfaced. | None |
| M-4 | Medium | **Rejected as filed** (F-1); recommendation already implemented. | None |
| L-1 | Low | Accepted as informational. | None |
| L-2 | Low | Already mitigated (Opus M-2). | None |
| L-3 | Low | Accepted (= GPT I-02). | None |
| L-4 | Low | Accepted as a real, minor griefing surface. | None |
| L-5 | Low | **Rejected — factually wrong, and contradicts this report's own H-1.** Settled empirically. | None |

**No redeployment of `Multisig` or `MultisigFactory` is indicated by this
report.** The one new accepted finding (H-2) is a self-inflicted configuration
ceiling, now blocked client-side.

---

# Findings

## [C-1] Chained-executor hooks let one wallet's routine transaction drain funds from, or seize full governance of, any other wallet that names it as executor

**Severity:** Critical
**Location:** `Multisig.execute()` L139, L170; `Multisig.executeQueued()` L189, L197 — combined with the executor-bypass at L141, L160

`execute()` and `executeQueued()` each carry two unconditional, undocumented
"chained executor" hooks:

```solidity
// execute() L139 (pre-hook, fires before ANY local check):
if (uint160(_executor) >> 144 == 0x1111) Multisig(payable(_executor)).execute(target, value, data, sigs);
// execute() L170 (post-hook):
if ((uint160(_executor) & 0xFFFF) == 0x1111) {
    Multisig(payable(_executor)).execute(target, value, data, sigs);
}
```

These fire whenever the wallet's own `executor` address happens to start
(`>>144==0x1111`) or end (`&0xFFFF==0x1111`) with the hex pattern `1111` — a
16-bit CREATE2-vanity search, free and trivial off-chain. There is no comment
anywhere in `Multisig.sol` explaining this mechanism's intent, no interface check
on the target, and no reentrancy guard anywhere in the contract.

The forwarded call reuses the *original* `target`/`value`/`data` (and, in
`execute()`, the original `sigs`) verbatim and executes it against `_executor`,
cast as another `Multisig`. If that target wallet (call it **B**) has separately,
and through entirely ordinary governance, set `B.executor` equal to the
forwarding wallet (**A**)'s address, then inside B's nested `execute()` call,
`msg.sender == B.executor` is true — so B's entire signature-verification block
is skipped and B's delay is bypassed.

Because `target`/`data` are unscoped, they can point at B **itself**: a forwarded
self-call satisfies B's `onlySelf` modifier, letting A's ordinary threshold
signers run `addOwner`, `setExecutor`, or `delegateCall` on B — full governance
takeover — with **zero signatures from B's own owners**.

Critically, `executeQueued()`'s hooks re-read `executor` **live** at execution
time, not at the time the transaction was originally queued and signed, so a
wallet's later, perfectly ordinary `setExecutor` rotation can retroactively
hijack an already-signed, already-queued transaction.

**Proof of Concept** (traced independently by 6+ agents across both phases):

1. Wallet B: `threshold=5`, `ownerCount=7`, `delay=30 days`, holds a large
   balance. B's owners legitimately configure `B.executor = A`.
2. Wallet A is deployed at a CREATE2 salt grinded so that
   `uint160(A) & 0xFFFF == 0x1111`. A can be *any* wallet, even a 1-of-1.
3. A's owners sign a mundane A-transaction:
   `A.execute(USDC, 0, approve(attacker, max), validASigs)`.
4. Inside A's `execute()` (L170, since A's address matches the suffix pattern):
   `Multisig(B).execute(USDC, 0, approve(attacker,max), validASigs)` fires, with
   `msg.sender` (to B) `== A`.
5. Inside B: `msg.sender(A) == B.executor(A)` → signature block skipped →
   B immediately executes `USDC.approve(attacker, max)` **as B**.
6. Attacker drains B via `transferFrom`. B's 5-of-7 owners never signed this.

**Recommendation:** Remove the address-bit-pattern auto-forwarding entirely, or
(a) never let a forwarded call satisfy the receiving wallet's
`msg.sender==executor` bypass; (b) scope forwarded `target`/`data` to exclude
the target calling itself; (c) bind the hook to the specific authorized action.

> ## ▸ Response — maintainers
>
> **Rejected. The proof-of-concept misreads the code, and under the correct
> reading the finding collapses into the documented executor trust model.**
>
> The hook tests and calls the wallet's **own executor**, not itself:
>
> ```solidity
> (uint32 _delay, uint32 _nonce, uint16 _threshold, address _executor)
>     = (delay, nonce++, threshold, executor);   // _executor := this wallet's executor
> ...
> if (uint160(_executor) >> 144 == 0x1111) Multisig(payable(_executor)).execute(...);
> ```
>
> The pattern is checked on `_executor`, and the call goes **to** `_executor`.
> PoC steps 2 and 4 say the hook fires because *A's own address* carries the
> suffix pattern, forwarding to B. That is not what the code does. For A's hook
> to reach B you need `A.executor == B`, which means **B** must carry the
> pattern, not A.
>
> Restating the preconditions correctly:
>
> 1. `A.executor == B` (so A's hook targets B), **and**
> 2. B's address carries the `0x1111` pattern, **and**
> 3. `B.executor == A` (so B skips signatures for a call whose `msg.sender` is A).
>
> That is **mutual executor designation**. And condition 3 alone — `B.executor ==
> A` — already gives whoever controls A unconditional authority over B: they can
> call `B.execute(target, value, data, "")` directly, where `msg.sender ==
> executor` skips both the signature block and the delay. **The hook adds
> nothing.** The claimed drain is available without it.
>
> So C-1 reduces to "the executor can drain the wallet," which is the first row
> of the False Positive Patterns table in `SECURITY.md` and is stated in
> `README.md` as *"The executor has full control by design."*
>
> The 6-agent independent confirmation is worth noting as a caution: cross-agent
> corroboration propagated a shared misreading rather than catching it. The two
> other AI reviews of these contracts both read this hook correctly.
>
> **What does survive, and we credit it:** the observation that `executeQueued()`
> re-reads `executor` **live** at execution time rather than binding it at
> queue time is correct and was not made by any other reviewer. Combined with
> GPT-5.6's L-01 (queued entries never expire and survive configuration changes),
> it means a transaction signed and queued under one executor configuration
> executes its hooks against whatever executor exists later. That is a genuine
> composition property worth documenting, even though the drain conclusion does
> not follow from it.
>
> **On "undocumented":** the mechanism is documented — `README.md` has a *Guard
> Mode* section with a bit-pattern table and a bricking warning, and
> `SECURITY.md` carries it as acknowledged findings F-2, F-5 and F-6. It is fair
> to say `Multisig.sol` itself carries no comment at the hook sites, and that is
> a legitimate criticism of the source.

---

## [H-1] Setting `executor` to a non-cooperating `0x1111`-shaped address permanently bricks the wallet, with no recovery path

**Severity:** High
**Location:** `Multisig.setExecutor()` L242-244, `Multisig.init()` L44

The four hook call sites have no `try`/`catch` and no interface/code check before
calling. If `executor` matches the `0x1111` bit-pattern but the target does not
implement a compatible `execute(address,uint256,bytes,bytes)` that succeeds, the
hook call reverts, unwinding the **entire** outer call.

Because the pre-hook runs unconditionally at the top of both functions — before
any signature verification — this affects every future call regardless of how
valid the caller's signatures are. Since `setExecutor()` is `onlySelf` and
reachable only via `execute()`/`executeQueued()` (both now permanently
reverting), there is **no path to ever fix the misconfiguration**. All ETH and
tokens are permanently locked.

This requires only a normal threshold-authorized `setExecutor` call — it could
happen by honest mistake (a random address has a `1/65536` chance of matching per
16-bit slice) or via a proposer who grinds a plausible-looking "module" address
and gets it approved by co-signers with no way to know the bit-pattern is
meaningful.

**Recommendation:** Validate `_executor` in both `setExecutor()` and `init()`, or
wrap the hook calls in a bounded-gas low-level call that swallows failure.

> ## ▸ Response — maintainers
>
> **Correct, and already mitigated.** This is the same vector as Shred Security's
> L-1 (self-referential form) and Opus 5's M-1 (generalised form). The dapp
> refuses a self-referential executor outright, and hard-blocks a `0x1111`-marked
> address with no code after **reading the chain** — if the RPC cannot be reached
> it refuses rather than assuming.
>
> Their revert analysis is right, and it is worth noting that **it contradicts
> this same report's L-5**, which claims the codeless case is a silent no-op.
> Both cannot be true. We settled it empirically — see our response to L-5.
> H-1 is the correct one.
>
> The point that co-signers have no way to know the bit-pattern is meaningful is
> the strongest argument in this finding, and it is why our mitigation reads the
> chain and blocks rather than merely warning.

---

## [H-2] `uint16` truncation in `execute()`'s signature-length check permanently bricks the signature path once `threshold >= 1009`

**Severity:** High
**Location:** `Multisig.execute()` L136, L145, inside the `unchecked{}` block spanning L135-173

```solidity
(uint32 _delay, uint32 _nonce, uint16 _threshold, address _executor) = (delay, nonce++, threshold, executor);
...
require(_threshold != 0 && sigs.length == _threshold * 65, InvalidSig());
```

`_threshold` is declared `uint16`. The multiplication `_threshold * 65` is
therefore performed in `uint16` arithmetic — and because the entire function body
sits inside `unchecked { ... }`, it silently **wraps modulo 65536** once
`_threshold >= 1009` (`1009 * 65 = 65,585`, which wraps to `49`).

**Empirically verified** via a standalone `forge test`: `threshold=1008` →
`65,520` (correct); `threshold=1009` → wraps to `49`.

Once wrapped, the length check demands a 49-byte `sigs` blob, but the
verification loop — bounded by the **unwrapped** `_threshold=1009` — attempts to
read up to byte index `65,584`. **No single `sigs` value can satisfy both**;
`execute()`'s signature path becomes permanently unusable.

Contrast: `isValidSignature()` (`uint256 _threshold`) and
`TimelockExecutor.forward()` (`uint256 required`) both correctly widen before the
equivalent multiplication and do **not** share this bug.

**Reachability:** Deploying a wallet with 1,009 owners costs roughly 1,009 cold
`SSTORE`s (~22.3M gas) — comfortably within a single Ethereum mainnet block.

**Escalation:** With `threshold>=1009` and `executor==address(0)` the wallet can
never execute again. If `executor` is attacker-controlled, the
`msg.sender==_executor` bypass skips the broken check entirely — the attacker can
drain at will while the owners' corrective `setExecutor` can never execute. This
turns a normally one-step-revocable role into a **permanent, unremovable
backdoor**.

**Recommendation:** Widen to `uint256(_threshold) * 65`, matching
`isValidSignature()`. Cap `threshold`/`ownerCount` well below 1008.

> ## ▸ Response — maintainers
>
> **Accepted. Correct, new, and the most valuable finding in this report — it
> corrects two prior audits.**
>
> We verified this independently rather than trusting either the finding or the
> earlier reviews, by downloading solc `0.8.34+commit.80d5c536` (the exact
> compiler of record) and inspecting the generated IR:
>
> ```
> function wrapping_mul_t_uint16(x, y) -> product {
>     product := cleanup_t_uint16(mul(x, y))     // cleaned := and(value, 0xffff)
> }
> ```
>
> The multiplication is uint16-typed and masked to 16 bits inside `unchecked`.
> The arithmetic follows exactly as filed: 1008 → 65,520 (fine); **1009 → 49**
> while the loop reads to offset 65,584.
>
> **Why this matters beyond the finding itself.** Both prior reviews saw this
> region and mis-sized it. Opus 5's I-4 called it "unreachable in practice
> (65,536 owners far exceeds the block gas limit)"; GPT-5.6's I-01 likewise
> anchored on 65,536. The real break point is **1,009 — 65× lower**, and as this
> reviewer notes, ~22M gas fits in a mainnet block. Both earlier reviews reached
> the right conclusion (*don't worry about it*) from the wrong number. This one
> did the arithmetic.
>
> The asymmetry they identify is also correct and is what makes the escalation
> real: `isValidSignature()` and `forward()` widen to `uint256` first, so ERC-1271
> and the executor path keep working while the owners' path is dead. That is an
> owner-lockout, not a full brick — which is precisely why an attacker-held
> executor would become unremovable.
>
> **Severity in practice:** we assess this Low rather than High, because it is
> reachable only by deliberately configuring a wallet with 1,009+ owners, which no
> real deployment does and which our client would never produce. But the finding
> is correct as written, and "no realistic user does this" is not a reason to
> leave a one-way door unguarded.
>
> **Mitigated** (`dapp/index.html`): `MAX_SAFE_THRESHOLD = 1008`. The create flow
> refuses an owner set above it — the ceiling has to sit on the owner count, since
> the threshold can never exceed it — and `setThreshold` refuses any value above
> it, naming the overflow as the reason.
>
> Not fixed in-contract; the widening would require redeploying `Multisig`. If it
> is ever redeployed we take the reviewer's fix verbatim, and it is now recorded
> as a must-fix for any future implementation.

---

## [M-1] `TimelockExecutor.forward()`'s general path does not clear a pre-existing `queued[hash]` entry — enables double execution

**Severity:** Medium

`execute()` assigns a fresh nonce to every call. `forward()`'s general path
computes its hash from the wallet's **current live** nonce and calls
`multisig.execute(...)` directly, creating a nonce-distinct execution that does
**not** touch any pre-existing `queued[hash]` entry for the same
`(target, value, data)` at an earlier nonce.

**PoC:** owners queue a payment at `nonceA`; owners then "expedite" it by signing
a direct `forward()` on the same `target`/`value`/`data`, which executes
immediately at `nonceB`; `queued[hash1]` is never touched; once the ETA passes,
anyone permissionlessly calls `executeQueued(target,value,data,nonceA)` and the
identical call executes a **second time** — full double payment.

The code's own header comment describes the *correct* mitigation as an
easy-to-miss alternative: "Already-queued txs can be accelerated by forwarding
**a self-call to executeQueued**" — nothing on-chain enforces it.

**Recommendation:** Have the general `forward()` path consume the original
queuing nonce and atomically clear the entry; or restrict it to transactions not
already queued; or enforce on-chain that acceleration goes through the wrapper.

> ## ▸ Response — maintainers
>
> **Accepted as a real path, and their recommended mitigation is what this client
> already does.**
>
> The mechanism is right: the queued hash commits to the nonce it was queued at,
> so executing the same `(target, value, data)` at a later nonce leaves the
> earlier entry live and independently executable.
>
> Our acceleration flow uses the self-call wrapper they identify as correct: it
> submits `forward(wallet, wallet, 0, executeQueued(target, value, data,
> originalNonce), sigs)`, so the wallet self-calls `executeQueued`, which deletes
> the queued entry before executing. There is no path in this client that
> "accelerates" by re-signing the same transaction at a fresh nonce.
>
> The residual is for anyone hand-rolling acceleration against the module
> directly, and the reviewer is right that only a comment steers them to the
> wrapper. We are documenting it: **to accelerate an already-queued transaction,
> forward a self-call to `executeQueued`, never a fresh `forward()` of the same
> payload.**
>
> The broader shape — the same logical action executing twice because it was
> authorised at two nonces — is worth operators understanding generally, since a
> re-signed transaction never invalidates an older queued one.

---

## [M-2] `forward()` signatures can be front-run and replayed via direct `execute()`, forcing an intended immediate action into the timelock queue

**Severity:** Medium

Signatures collected for `forward()` are caller-agnostic, and `forward()`'s hash
and `execute()`'s hash are computed identically. An attacker watching a pending
`forward()` in the public mempool can extract its `sigs`, truncate to
`threshold*65` bytes, and front-run with `multisig.execute(...)` directly —
consuming the nonce and **queuing** the action instead of executing it.

Most damaging against the emergency-cancel fast path: the cancellation itself is
forced into the queue with its own `eta = now+delay`. If the malicious queued
transaction's ETA arrives first, anyone can execute it before the delayed
cancellation goes through.

**Recommendation:** Bind the intended execution path into the signed payload via
a distinct EIP-712 typehash/domain tag.

> ## ▸ Response — maintainers
>
> **Confirmed — this independently reaches GPT-5.6 Sol's H-01**, found by a
> different reviewer on the same day, and the two descriptions agree in every
> mechanical detail including the cancel-path consequence. Independent
> convergence raised our confidence considerably.
>
> **Already mitigated.** Every `forward()` bundle this client builds spends one
> slot on a `v=0` sender slot naming the submitting owner, which the contract
> accepts only when `msg.sender` is that owner. A copier is neither that owner nor
> pre-approved, so the bundle is inert in their hands on either route.
>
> The cancel path is fully closed — that route takes exactly `threshold` slots, so
> binding one leaves a copier one signature short of what `execute()` demands.
> The unanimous paths are reduced but not closed, since `n-1 ≥ k` signatures
> remain copyable whenever `k < n`; there the impact is delay and forced
> re-signing rather than a neutralised brake, and protected submission is the
> remaining mitigation.
>
> That residual is narrower than it first reads. A griefed transaction still
> executes after the delay — it cannot be blocked, and the grief cannot be
> repeated once the entry is queued. It can be recovered by forwarding a
> self-call to `executeQueued`, which skips the ETA because `msg.sender` is the
> wallet itself. And the two cases where timing genuinely matters each have a
> path that cannot be griefed at all: cancellation, closed by the binding, and
> guaranteed emergency action via the README's security-council executor, which
> has no signature bundle for an observer to replay. See the disposition in
> `SECURITY.md` for the full narrowing.
>
> One detail this report adds that GPT-5.6's did not: the explicit note that
> **truncating** an oversized bundle to `threshold*65` is what makes the direct
> call valid. That is why our binding also trims bundles to exactly the required
> length rather than passing everything collected.
>
> Their recommended structural fix — a distinct typehash — is the same one two
> other reviews proposed and is deferred to a possible `TimelockExecutorV2`,
> adoptable per-wallet through one `setExecutor` with no migration.

---

## [M-3] Same `Execute` signature authorizes both the delayed queue and the immediate bypass — total loss of timelock protection for N-of-N wallets

**Severity:** Medium

Both paths authorize against the identical digest and consult the same
`approved[owner][hash]` mapping. The signed payload carries no indication of
which execution path the signer intends.

Especially acute where `threshold==ownerCount`: once `forwardEnabled=true`, a
normal threshold-signed submission is *by definition* also a valid "all owners
signed" set for `forward()`'s unanimous path. Every ordinary transaction the
owners sign can instead be submitted by anyone holding those signatures to
execute immediately. For N-of-N wallets it silently disables the timelock for
*every* transaction.

**Recommendation:** Add a discriminator to the signed payload. At minimum
document — and ideally enforce, e.g. `require(ownerCount>threshold)` before
`enableForward(true)` — that `forwardEnabled` is unsafe for N-of-N wallets.

> ## ▸ Response — maintainers
>
> **Confirmed — this independently reaches Opus 5's H-1.** Two reviewers arriving
> at it separately is why we treat the n-of-n case as a real configuration hazard
> rather than a theoretical one.
>
> **Already surfaced.** The dapp raises it in the deploy review screen, requires a
> deliberate second press in admin, and labels an inbound `enableForward(true)` on
> such a vault `FAST PATH · TIMELOCK BECOMES ADVISORY`. Flagged rather than
> refused, because the configuration is legitimate — what must not happen is that
> it be a surprise.
>
> Two qualifications we have recorded elsewhere and restate here. First, "total
> loss of timelock protection" overstates it: on an n-of-n wallet the cancel path
> also requires unanimity, so the review window this gives up could only ever have
> been used by unanimous agreement. It was mistake-recovery and third-party
> notice, never a defence against a compromised co-signer. Second, the shared
> typehash is deliberate — it exists so signatures accrue monotonically, letting a
> late-arriving signer upgrade a queueable set into an executable one without
> anybody re-signing. Bifurcating the domain is exactly what would destroy that.
>
> Their suggested on-chain guard (`require(ownerCount>threshold)` before
> `enableForward(true)`) is a clean idea and would belong in a V2 module.

---

## [M-4] `MultisigFactory.create()`'s zero-prefixed CREATE2 salt is fully public, enabling address-squatting of pre-funded counterfactual wallets

**Severity:** Medium

The wallet's CREATE2 address depends only on `(factory, salt, initcode)`; owners,
threshold, delay and executor are applied afterward via `init()` and play no role
in address derivation. For the `salt>>96==0` lane the salt is unrestricted —
anyone can reuse it with different owners. The NatSpec misleadingly frames both
options as protective; the zero-prefix option provides none.

**Recommendation:** Remove the zero-prefix lane, or bind `init()` parameters into
the salt/initcode, or document that it must never be used with pre-funded
addresses.

> ## ▸ Response — maintainers
>
> **Rejected as filed** — F-1 in the False Positive Patterns table, a documented
> tradeoff. The zero-prefix branch is the canonical Solady
> `LibClone.checkStartsWith` pattern, kept for gas-efficient relayer deploys where
> no pre-funding occurs.
>
> **The recommendation is already implemented.** This client's salt miner is
> sender-bound by construction — `base = BigInt(caller) << 96n`, searching only
> the low 96 bits — so there is no code path here that emits a zero-prefixed salt.
>
> Their observation that the NatSpec ("The salt must start with the zero address,
> or the caller, for front-running protection") reads as though both options are
> protective is fair and is the sharpest version of this we have received. The
> comma makes the protective clause look like it covers both. Worth rewording if
> the source is ever touched.

---

## [L-1] `TimelockExecutor.forward()`'s `multisig` parameter is unvalidated — allows spoofed events and fake `forwardEnabled` state

**Severity:** Low

Every check in `forward()` is an external call into the caller-supplied
`multisig` address, with no check that it is a genuine factory-deployed clone. An
attacker can deploy a fake `IMultisig` returning `ownerCount()→0` so `required=0`
and the signature loop never runs, then emit an authoritative-looking
`Forwarded` event with zero real verification. **The executed call always lands
on code the attacker supplies** — no path reaches a genuine clone's funds — so
impact is confined to deceiving indexers, monitoring bots or UIs that trust the
module's events without verifying provenance.

**Recommendation:** Verify `multisig.codehash` against the known clone runtime,
or have the factory expose an `isMultisig(address)` mapping.

> ## ▸ Response — maintainers
>
> **Accepted as informational.** The scoping is honest and correct — the impact is
> event/indexer integrity, not fund extraction.
>
> Relevant to us because this client *does* read module state: it queries
> `forwardEnabled(wallet)` live on every vault load. That read is keyed by our own
> vault address, which we independently verify is a genuine clone by comparing its
> runtime bytecode against the audited 45-byte template on load, so a spoofed
> entry for someone else's fake contract cannot affect what we display.
>
> Anyone indexing `Forwarded` events across all wallets should apply the
> reviewer's `codehash` check. The audited clone runtime is published in
> `README.md` for exactly this purpose.

---

## [L-2] `setDelay()` has no upper bound

**Severity:** Low

`delay` is `uint32` (max ~136 years) and `setDelay()` performs no bounds check.
Because it is `onlySelf` and subject to the current delay when resubmitted, a
corrective call must wait out the bad delay first — absent a working executor,
a near-permanent self-lock.

> ## ▸ Response — maintainers
>
> **Already mitigated** (= Opus 5's M-2). Delays over 30 days require a deliberate
> second press and are refused outright when the vault has no executor — the only
> genuinely terminal case, since with an executor a unanimous `forward()` can
> still undo it and a queued bad `setDelay` can be cancelled before it executes.

---

## [L-3] Execute signatures/approvals carry no expiration

**Severity:** Low

Neither the `Execute` nor `SafeMessage` struct includes a deadline. Nonce-based
replay protection prevents re-executing a given nonce, but a validly-signed
transaction remains executable indefinitely, so stale intent can execute long
after signers assumed it abandoned.

> ## ▸ Response — maintainers
>
> **Accepted** (= GPT-5.6's I-02, independently reached). A signature stays live
> until some transaction consumes its nonce, with no expiry of its own. The
> `deadline` field belongs in any future `Execute` struct, and GPT-5.6's proposed
> V2 forward struct includes one.
>
> Operationally: a proposal that has sat unsigned or unsubmitted for a long time
> should be superseded by consuming its nonce, not simply abandoned.

---

## [L-4] Unbounded returndata copy on all low-level calls — gas-griefing

**Severity:** Low

Every low-level call site uses plain `(bool ok, bytes memory ret) =
target.call(...)` with no returndata size cap. A malicious target returning large
data imposes disproportionate gas cost on whoever submits — notably third-party
relayers calling the permissionless `executeQueued()` on a target the *owners*,
not the caller, chose.

**Recommendation:** Cap returndata using an `excessivelySafeCall`-style pattern.

> ## ▸ Response — maintainers
>
> **Accepted as a real, minor griefing surface, and it is new** — no prior review
> raised it. The asymmetry the reviewer identifies is the interesting part: on the
> permissionless `executeQueued()` path, the target is chosen by the owners while
> the gas is paid by whoever relays, so the cost falls on someone who had no say
> in it.
>
> Not exploitable for extraction and not fixable without redeploying. Relayers
> should simulate before submitting, which this client does for every proposal.

---

## [L-5] Silent no-op if a chained-executor address matches the `0x1111` pattern but has no deployed code

**Severity:** Low

A call to an address with no deployed code trivially "succeeds" per EVM
semantics. If `executor` is `0x1111`-shaped but code-less, the hook silently does
nothing with no on-chain signal.

**Recommendation:** Check `_executor.code.length != 0` before invoking the hook.

> ## ▸ Response — maintainers
>
> **Rejected — factually incorrect, and it contradicts this report's own H-1**,
> which states the same hook *reverts* against a non-cooperating target and bricks
> the wallet. Both cannot be true.
>
> The claim describes raw EVM `CALL` semantics, not what Solidity compiles. For a
> **high-level** call to a function with no return values, the compiler inserts an
> `extcodesize` guard, because there is no return data whose decoding would
> otherwise catch a non-existent contract.
>
> We settled it empirically with solc `0.8.34+commit.80d5c536`, compiling three
> minimal probes and counting compiler-inserted `extcodesize` guards:
>
> | Call shape | `extcodesize` guard |
> |---|---|
> | High-level call to a void function (`execute(...)`) | **1** |
> | High-level call to a value-returning function | 0 |
> | Raw `address.call(...)` | 0 |
>
> `Multisig.execute(address,uint256,bytes,bytes)` returns nothing, so it is the
> first case: **the hook reverts against a codeless address.** Compiling
> `Multisig.sol` itself yields 11 compiler-inserted `extcodesize` guards with zero
> occurrences in the source.
>
> This matters beyond bookkeeping. Had we accepted L-5, the codeless-executor case
> would look like a harmless silent no-op rather than a permanent brick, and the
> dapp guard we ship for it would look unnecessary. H-1 and Opus 5's M-1 are
> correct; L-5 is not. Our guard reads the chain and blocks.

---

# Leads (confidence < 50) and Rejected Claims

The report lists five sub-threshold leads — `forward()` gas scaling with owner
count, `addOwner`'s `unchecked ++ownerCount` wrap at 65,535, `init()`'s
`uint16` downcast truncation, `createWithCalls` deployer-trust, and ETH stuck in
the permanently-uninitialized implementation — and one **rejected claim**: a
Phase-2 agent's assertion that `createWithCalls()` fails to forward `msg.value`
to the inner `create()`, rejected because the internal call compiles to a `JUMP`
and `CALLVALUE` is a property of the outer transaction.

> ## ▸ Response — maintainers
>
> **The Leads and Rejected Claims sections are the best methodological feature of
> this report** and we would like to see them in every review.
>
> Two of the leads are items earlier reviews filed as findings, and this reviewer
> correctly demoted both as impractical: the `addOwner` `ownerCount` wrap (filed
> as GPT-5.6's I-01) and the `init()` downcast truncation (filed as Opus 5's I-4).
> Having correctly sized the *reachable* arithmetic bug in H-2, it also correctly
> declined to inflate the unreachable ones. That is exactly the discrimination we
> want from a reviewer.
>
> The rejected `createWithCalls` claim is right to reject, for the reason given.
>
> The ETH-stuck-in-implementation lead is already documented (Shred L-2) and
> mitigated: this client refuses to build any transfer to the factory, the
> implementation or the TimelockExecutor.

---

# Verification note (maintainers)

Two findings in this report contradicted earlier reviews, so we resolved both
against the actual compiler rather than by argument. We downloaded solc
`0.8.34+commit.80d5c536` — the version of record for the deployed contracts —
and used it to establish:

1. **H-2 is real.** The IR shows `wrapping_mul_t_uint16(x, y) := cleanup_t_uint16(mul(x, y))`
   with `cleaned := and(value, 0xffff)`, confirming uint16-typed multiplication
   masked inside `unchecked`. Break point 1,009, not the 65,536 two earlier
   reviews assumed.
2. **L-5 is wrong.** Void-returning high-level calls receive a compiler-inserted
   `extcodesize` guard; value-returning and raw calls do not. A codeless
   `0x1111` executor therefore reverts rather than silently no-opping.

Neither could be settled by reading alone, and the two prior reviews disagreed on
the second. Where reviewers conflict on a compiler-level fact, compile it.

---

*Original report: "This review was performed by an automated multi-agent audit
pipeline (leftclaw.services). AI analysis cannot verify the complete absence of
vulnerabilities and no guarantee of security is given. A human security review,
and staged/monitored deployment, are strongly recommended before this system
manages material value — particularly given Finding C-1's severity and its direct
connection to a documented, presumably-intended 'chained executor' feature."*
