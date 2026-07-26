# Comprehensive Security Audit — Multisig, MultisigFactory & TimelockExecutor

**Reviewer:** GPT-5.6 Sol (Pro), independent review
**Date:** 26 July 2026
**Target network:** Ethereum mainnet
**Transcript:** <https://chatgpt.com/share/6a650af3-f6bc-83ea-b5f3-f83452e9c744>

**Verdict as delivered:** NO-GO for unrestricted high-value production use with
the existing TimelockExecutor. 1 High, 1 Medium, 4 Low, 5 Informational.

---

## About this file

This reproduces the delivered report with the maintainers' responses added.
Everything outside a **▸ Response** block is the reviewer's text as written;
every **▸ Response** block is ours.

**This review found the most important issue raised across all three audits.**
H-01 is a genuine High that the two prior reviews missed, and it invalidated a
claim we had made in response to one of them. It required no contract change to
fix, but it did require correcting our own guidance.

### Disposition summary

| ID | Filed | Our position | Contract change |
|---|---|---|---|
| H-01 | **High** | **Accepted in full at High.** New, correct, and the most consequential finding to date. Mitigated dapp-side using the reviewer's own proposed technique. | None |
| M-01 | Medium | **Rejected as filed** (F-1) — but the recommendation was already implemented. | None |
| L-01 | Low | **Accepted.** Pre-answered as L16, but the no-expiry framing is new and interacts badly with H-01. | None |
| L-02 | Low | Acknowledged (N-005 / Opus I-3). | None |
| L-03 | Low | Already mitigated (Shred L-1, Opus M-1). | None |
| L-04 | Low | **Accepted, mitigated.** Correctly extends the unrecoverable-destination set to the executor, which we had missed. | None |
| I-01 | Info | Accepted as informational. | None |
| I-02 | Info | Accepted. | None |
| I-03 | Info | **Independently confirms** a property we found during the Opus 5 review. | None |
| I-04 | Info | Accepted — tooling notes, all already handled. | None |
| I-05 | Info | **Accepted.** The missing regression test is the right ask. | None |

### On the NO-GO verdict

We read it as narrower than stated. The reviewer's own mitigation for H-01 —
binding one signature slot to the submitting owner — is a client-side change
requiring no new bytecode, and it is now shipped. What the verdict correctly
establishes is that **the existing TimelockExecutor cannot be relied on for
adversarial emergency cancellation without that binding**, and that the
structural fix is a route-specific replacement executor.

That replacement remains cheap: `executor` is per-wallet mutable storage, so a
V2 can be deployed alongside and adopted through one threshold-signed
`setExecutor`, with no migration, no address changes and no funds moving. H-01
strengthens the case for it considerably, because unlike the previously
identified issues it lives on the **cancel** path rather than on an opt-in
feature.

---

# Executive verdict

### **Overall: NO-GO for unrestricted high-value production use with the existing TimelockExecutor**

| Component | Verdict |
|---|---|
| `Multisig` core | **Conditionally acceptable** |
| `MultisigFactory` | **Acceptable only with sender-bound salts and post-deployment verification** |
| Existing `TimelockExecutor` composition | **Not approved for unrestricted production use** |
| Entire proposed combination | **NO-GO until H-01 is structurally fixed or tightly mitigated** |

I found **no direct arbitrary threshold bypass in the core Multisig**. An
outsider cannot simply call the wallet and drain it without valid owner
authorization or control of the configured executor.

I did, however, confirm a **High-severity composition defect**: the same
signatures are deliberately valid both for ordinary timelocked `Multisig.execute`
and for immediate `TimelockExecutor.forward`. An adversary can select the
less-protective route, consume the nonce, and defeat an emergency cancellation,
acceleration, or urgent unanimous action.

This does **not** mean every currently deployed wallet is immediately
compromised. The High finding requires an observable or otherwise copyable
authorization bundle and a transaction-ordering race. But those conditions are
realistic on Ethereum, especially with public mempool submission, public on-chain
approvals, or an untrusted signature aggregator.

---

# H-01 — Route-unbound signatures defeat immediate cancellation and forwarding

**Severity: High**
**Affected contracts:** `Multisig`, `TimelockExecutor`

## Root cause

`TimelockExecutor` verifies the wallet's ordinary EIP-712
`Execute(address target,uint256 value,bytes data,uint32 nonce)` hash. It then
calls the wallet as its executor, causing immediate execution without signatures
or delay.

The exact same digest is also accepted by `Multisig.execute` when called
directly. The signatures do not commit to:

* whether they are intended for `Multisig.execute` or `TimelockExecutor.forward`;
* whether the desired mode is queue, cancel, immediate forward, or acceleration;
* the TimelockExecutor address;
* a deadline.

## Emergency-cancellation attack

Suppose a dangerous transaction `Q` has already been queued at
`ETA_Q = t0 + D`, where `D` is the wallet delay.

The honest owners prepare threshold signatures over:

```solidity
Execute(
    address(wallet),
    0,
    abi.encodeCall(Multisig.cancelQueued, (queuedHashQ)),
    currentNonce
)
```

intending to submit `timelockExecutor.forward(...)`, which would immediately call
the wallet as executor and cancel `Q`.

An adversary copies the signatures and front-runs with:

```solidity
wallet.execute(address(wallet), 0, cancelData, cancelSignatures);
```

Because the adversary is not the executor, the wallet accepts the signatures but
**queues the cancellation itself** at `ETA_C = t1 + D`, with `t1 > t0`. The
direct call also consumes the nonce, so the intended `forward` transaction
subsequently fails signature validation.

The original dangerous transaction becomes executable at `ETA_Q`, which is
normally earlier than `ETA_C`. Anyone can permissionlessly execute `Q` during
that gap. When the queued cancellation eventually executes, `Q` has already run
and `cancelQueued` merely deletes an already-empty entry.

## Why the earlier Low assessment is insufficient

The prior TimelockExecutor report correctly identified that cancellation
signatures were dual-use, but concluded that the worst result was merely a
delayed—but still safe—cancellation. That conclusion overlooks the relative
ordering of the two ETAs: because the original transaction was queued first, it
normally matures first. The later cancellation is therefore not simply delayed;
it can become a no-op after the original transaction has executed.

## Other manifestations

**Urgent unanimous actions can be delayed.** For an `n`-owner wallet with
threshold `k < n`, an all-owner forward bundle contains `n` signatures, while
direct `Multisig.execute` requires exactly `k`. An adversary can extract any
sorted, copyable `k`-signature subset and submit it directly. That queues the
urgent transaction and consumes the nonce, preventing the intended immediate
execution — suppressing an emergency pause, exploit mitigation, asset rescue,
executor rotation, or execution of an already-queued protective action.

At most one signature slot can depend solely on the actual submitting owner
through the unapproved `v=0` sender bypass. When `k < n`, the other `n-1`
signatures contain at least `k` ECDSA or preapproved slots, so a threshold-sized
copyable subset normally remains available.

**Acceleration can be suppressed.** An all-owner bundle intended to accelerate an
existing queued transaction can instead be routed through direct `execute`,
queuing the acceleration request behind the same delay and consuming its nonce.

**Timelocks can unexpectedly become immediate.** When `forwardEnabled` is true,
any all-owner-signed action is effectively immediate-capable regardless of the
route the signer expected. This is especially significant when
`threshold == ownerCount`.

## Exploit preconditions

1. `delay > 0`;
2. a dangerous or unwanted queued transaction;
3. copyable cancellation authorization — all ECDSA signatures, on-chain
   approvals, or signatures visible to a malicious aggregator;
4. adversarial ordering before the intended module call.

## Required structural fix

Replace the deployed TimelockExecutor with a new executor whose signatures use a
separate EIP-712 domain and type, for example:

```solidity
Forward(
    address multisig,
    uint8 mode,
    address target,
    uint256 value,
    bytes32 dataHash,
    uint32 walletNonce,
    uint48 deadline
)
```

A module-specific digest cannot be replayed through `Multisig.execute`, because
the wallet expects its own `Execute` digest. The new module must not be deployed
at an address with the `0x1111` prefix or suffix.

## Mitigation for existing wallets

* **Emergency cancellation must include one unapproved `v=0` sender slot.** The
  corresponding owner must submit the `TimelockExecutor.forward` transaction
  directly. A copier cannot use that slot because `msg.sender` will differ.
* Do not use only public on-chain approvals for cancellation.
* Do not release the entire signature bundle to an untrusted coordinator.
* Use protected/private submission, with signature confidentiality maintained
  through inclusion.
* Leave `forwardEnabled` false unless immediate unanimous execution is
  deliberately required.
* Avoid relying on acceleration or unanimous forward as a guaranteed emergency
  mechanism when `threshold < ownerCount`.

> ## ▸ Response — maintainers
>
> **Accepted in full, at High. This is the most consequential finding across all
> three reviews, and it corrected a claim we had made publicly.**
>
> Every step verified against source. `cancelQueued` performs
> `delete queued[hash]` with no existence check and does not revert on an absent
> entry, so a late cancellation is a silent no-op. `executeQueued` is
> permissionless once the ETA passes. A non-executor `execute()` call queues at
> `block.timestamp + delay` and increments the nonce, invalidating the pending
> `forward()`. The attack is real.
>
> **What makes this different from the two prior reviews, and why it matters
> more:** the cancel branch of `forward()` requires only `threshold` signatures
> and — critically — **does not check `forwardEnabled`**. Every previously
> identified route-substitution issue lived behind that opt-in flag. This one
> does not. It therefore applies to **every wallet with `delay > 0` and this
> executor installed**, including configurations we had described as unexposed.
>
> **We had it wrong.** In responding to the Opus 5 review we stated that a wallet
> which never enables `forwardEnabled` has "zero exposure — structurally absent,
> not mitigated," and that the cancel path "carries none of the findings." That
> is true of the *bypass* direction and false of this one. Since the cancel brake
> is the principal reason we recommend installing this executor at all, the error
> was load-bearing. It is corrected here and in `SECURITY.md`.
>
> **It also suppresses a documented mitigation.** The False Positive Patterns
> table answers "executeQueued doesn't re-check signers" with "the delay window +
> `cancelQueued` is the intended mitigation." H-01 shows that mitigation can be
> neutralised by an adversary who can order one transaction ahead of another.
> Combined with L-01 below, this is the sharpest composite issue in the report.
>
> ### Mitigation shipped
>
> We implement the reviewer's own recommendation, in code rather than as
> operational guidance. Every `forward()` bundle the dapp builds now spends one
> slot on a **v=0 sender slot** for the submitting owner — 32 bytes naming the
> owner, 32 unused, `v = 0` — which the contract accepts only when `msg.sender`
> is that owner or they hold an on-chain approval for the hash. A copier is
> neither, so the bundle is inert in their hands on **either** route.
>
> Applied at all four `forward()` call sites: cancel, cancel-as-proposal,
> accelerate, and unanimous instant execute. It costs nothing — the slot replaces
> that owner's own signature, and they are the one submitting. Where the binding
> cannot be applied (the submitter is not among the signers, or holds an on-chain
> approval for that hash, which we read from the chain rather than assume) the
> dapp proceeds but says so explicitly rather than implying protection it did not
> obtain.
>
> Verified end-to-end against real signatures: 65-byte slot, correct `v=0`
> decode to the owner address, 195-byte three-slot bundle, and strictly ascending
> signer order preserved — the sender slot decodes to the same address the ECDSA
> slot would have, so the contract's `signer > prev` walk is unaffected.
>
> ### How complete the mitigation is — stated precisely
>
> **The cancel path is fully closed.** That route requires exactly `threshold`
> slots. With one bound to the submitter, only `threshold - 1` usable ECDSA
> signatures remain in the bundle — one short of what `execute()` demands. A
> copier cannot assemble a valid direct call at all.
>
> Doing this correctly also required fixing a latent bug: the cancel path was
> passing every collected signature to `forward()`, which requires *exactly*
> `required * 65` bytes. With more than `threshold` owners signing a cancel, that
> reverts. Bundles are now trimmed to exactly `threshold`, keeping the
> submitter's slot, which is both the correctness fix and what makes the binding
> airtight.
>
> **The unanimous paths are reduced, not closed.** For accelerate and instant
> execute on a k-of-n wallet, the bundle carries `n` slots. Binding one leaves
> `n - 1` copyable ECDSA signatures, and `n - 1 ≥ k` whenever `k < n` — so an
> adversary can still extract a threshold subset and burn the nonce. The
> reviewer's own analysis says exactly this, and we do not claim otherwise. The
> impact there is delay and forced re-signing at the new nonce rather than a
> neutralised brake, and the remaining mitigation is operational: protected or
> private submission so the bundle is never public before inclusion.
>
> **How much that residual actually matters.** Less than the mechanism suggests,
> for three reasons we want on the record rather than discovered later:
>
> 1. **The griefed transaction still executes.** It lands in the queue and runs
>    after the delay. It cannot be blocked, and the grief cannot be repeated —
>    once queued, it is queued. The worst outcome is experiencing the timelock
>    the owners configured.
> 2. **Acceleration recovers it.** `forward()` a self-call to
>    `executeQueued(target, value, data, originalNonce)`; the wallet answers with
>    `msg.sender == address(this)`, the ETA check is skipped, and the transaction
>    runs immediately with the queued entry cleared first. The accelerate bundle
>    is griefable by the same route, so this is a recovery rather than a
>    guarantee — but private submission prevents the original grief entirely,
>    since the attack requires the bundle to be public before it lands.
> 3. **Both timing-critical needs have an ungriefable path.** Cancellation is
>    closed by the binding. And guaranteed emergency *action* should not use the
>    fast path at all — the README's security-council pattern installs a separate
>    multisig as `executor`, which calls `wallet.execute(target, value, data, "")`
>    directly. Its signatures are over the *council's* digest, not the wallet's,
>    so there is no bundle an observer can replay against the wallet; with the
>    council at `delay = 0` there is no queue branch to force it into either.
>
> The residual therefore bites exactly the case whose consequence is mild — a
> convenience speed-up degrading to the configured delay — while the two cases
> where timing is critical are each covered by a path that cannot be griefed.
> Guidance follows from that: **if you need guaranteed emergency response, install
> a council executor rather than enabling the fast path.**
>
> ### Structural fix
>
> We agree the replacement executor is the right end state, and the reviewer's
> proposed `Forward(multisig, mode, target, value, dataHash, walletNonce,
> deadline)` struct is a better design than the minimal typehash split proposed
> by the Opus 5 review — binding the mode and a deadline closes more than binding
> the route alone.
>
> A V2 is adoptable per-wallet through one threshold-signed `setExecutor`, with
> no migration. We are not shipping it before launch, but H-01 moves it from
> "worth doing eventually" to the first item on the post-launch list.

---

# M-01 — Open CREATE2 salts permit deterministic-wallet capture

**Severity: Medium**
**Affected contract:** `MultisigFactory`

The factory permits either `salt >> 96 == 0` or
`salt >> 96 == uint160(msg.sender)`. The clone's CREATE2 initialization code
contains the implementation address but not the owners, threshold, delay, or
executor. Consequently the wallet address depends on the factory, fixed clone
code, and salt — but not the intended wallet configuration.

For a zero-prefix salt, anyone can observe a pending deployment and call the
factory first with the same salt and attacker-controlled owners. The attacker
receives the expected wallet address, and the victim's deployment fails because
code already exists there.

Address capture becomes theft rather than denial of service when the future
address has already received ETH, tokens, allowances, NFTs, protocol admin roles,
ownership, governance privileges, or expected CREATE2 deployment rights.

**Required use pattern.** For any economically meaningful wallet, use
`salt = (uint256(uint160(actualFactoryCaller)) << 96) | uint96(entropy)`. The
**actual factory caller** matters: when deployment is routed through a shared
relayer or contract, the salt is bound to that relayer or contract — not
automatically to the ultimate user. Never pre-fund, approve, or grant roles to a
zero-prefix deterministic address before deployment.

> ## ▸ Response — maintainers
>
> **Rejected as filed** — F-1 in the False Positive Patterns table, a documented
> tradeoff. The zero-prefix branch is the canonical Solady
> `LibClone.checkStartsWith` pattern, kept for gas-efficient relayer deploys where
> no pre-funding occurs.
>
> **The recommendation is already implemented.** The dapp's salt miner is
> sender-bound by construction — `base = BigInt(caller) << 96n`, searching only
> the low 96 bits for a `0x00` address prefix. There is no code path in this
> client that emits a zero-prefixed salt.
>
> **The "actual factory caller" warning is the sharpest version of this we have
> seen** and is worth keeping. Our client calls the factory directly from the
> connected EOA, so caller and user coincide; anyone integrating through a relayer
> or a contract wrapper must bind to that intermediary and understand the salt
> protects the intermediary, not the end user.

---

# L-01 — Queued actions never expire and survive configuration changes

A queued entry contains only its transaction hash and ETA. `executeQueued` does
not revalidate the owner set, threshold, delay, executor, or a configuration
epoch. There is also no expiration after which an old queued transaction becomes
invalid.

An action authorized under an old security configuration may remain executable
after owner rotation, threshold change, executor replacement, delay change, long
inactivity, or later deposits that make a previously failing transfer executable.
A reverting queued action remains queued because the deletion rolls back with the
target-call revert.

**Mitigation:** maintain a complete queue index from events; review and cancel
every pending operation before owner/configuration changes or major new funding.
A future wallet should include a configuration epoch in signed and queued hashes
and preferably a bounded execution window.

> ## ▸ Response — maintainers
>
> **Accepted.** The re-validation half is pre-answered as L16 in the False
> Positive Patterns table, but **the no-expiry framing is new and the interaction
> with H-01 is the important part**: L16's stated mitigation is "the delay window
> + `cancelQueued`", and H-01 demonstrates that cancellation can be suppressed by
> an adversary who can order one transaction first. Together they are sharper than
> either alone — an entry queued under a compromised configuration survives
> rotation indefinitely, and the tool for clearing it can be neutralised.
>
> The operational recommendation is adopted: **review and clear the queue before
> any owner, threshold, delay or executor change, and before a major deposit.**
> The dapp surfaces the full pending queue with per-entry ETAs and a cancel action,
> which is the index the reviewer asks for.
>
> A configuration epoch mixed into the signed hash is the right contract-level fix
> and is noted for any future implementation. It cannot be retrofitted.

---

# L-02 — The wallet may be installed as its own owner

Neither `init` nor `addOwner` rejects `address(this)`. A one-owner wallet
configured with itself as sole owner and no independent executor cannot produce an
ECDSA signature or initiate the sender-bypass route. A configuration such as
`[wallet, Alice]` with threshold two can similarly become circular and unusable.

**Mitigation:** deployment and owner-management tooling must reject
`owner == address(wallet)`.

> ## ▸ Response — maintainers
>
> **Acknowledged** — matches N-005 and the Opus 5 review's I-3. This reviewer adds
> the *unusable-wallet* angle, where the prior reports framed it as a silent
> effective-threshold reduction; both are correct and the second is a stronger
> argument for the same guard.
>
> The dapp's create flow cannot produce it: owner addresses are collected before
> the CREATE2 address is mined, so the wallet's own address is not yet known and
> cannot be entered. The `addOwner` path is the reachable one and rejects
> `address(0)` and the sentinel today; adding the self check is a small
> improvement we will take.

---

# L-03 — Self-referential or invalid `0x1111` executors can brick a wallet

The core treats an executor address with a leading `0x1111` as a pre-hook and a
trailing `0x1111` as a post-hook, invoked from both `execute` and `executeQueued`.
If a marked wallet sets itself as executor, execution recursively calls itself
until out of gas; because `setExecutor` is reachable only through wallet
execution, the configuration is unrecoverable. A marked external guard that
permanently reverts creates the same practical lock.

The specified TimelockExecutor address starts with `0x0000` and ends with
`0x973F`, so it does **not** activate these hooks.

> ## ▸ Response — maintainers
>
> **Already mitigated** — Shred L-1 and Opus 5 M-1 cover the same ground, and the
> dapp refuses a self-referential executor outright and hard-blocks a marked
> address with no code (read from the chain, not assumed). The independent
> confirmation that the deployed executor address clears both masks is useful.

---

# L-04 — Assets sent directly to singletons may be unrecoverable

The factory and implementation contain no usable recovery path; the implementation
is intentionally uninitialized, so it has no owner quorum capable of withdrawing
assets. TimelockExecutor likewise has no token-recovery or arbitrary-execution
function for assets belonging to the module itself. Ordinary ETH transfers may
revert, but forced ETH, ERC-20 transfers, and unsafe NFT transfers can remain
permanently trapped.

**Mitigation:** label and block all three singleton addresses as asset
destinations. The warning should include TimelockExecutor, not only the factory
and implementation.

> ## ▸ Response — maintainers
>
> **Accepted and mitigated. A real gap on our side.** Our unrecoverable-destination
> list covered the factory, the implementation, `address(0)` and the owner-list
> sentinel — but not the executor. Verified: `TimelockExecutor` declares only
> `constructor() payable {}`, with no `receive` and no fallback, so plain ETH
> reverts, but an ERC-20 transfer succeeds and is stuck permanently.
>
> The executor is now in the list, so the dapp refuses to build any transfer,
> custom call or batch leg sending value or tokens to it, and flags an inbound
> proposal doing the same as `UNRECOVERABLE`. Documentation updated to name all
> three singletons rather than two.

---

# Informational

**I-01 — `ownerCount` can theoretically wrap to zero.** `ownerCount` is a `uint16`
incremented inside `unchecked`. TimelockExecutor uses `ownerCount()` as the
required signature count for non-cancellation forwards. After enough authorized
owner additions it could wrap to zero, and with `forwardEnabled == true` the
module would accept an empty signature bundle and call the wallet as executor.
Requires roughly 65,536 authorized owner additions, but the fail-open result is
undesirable.

**I-02 — Nonce and signature lifecycle require strict coordination.** One global
`uint32` nonce for all transactions: parallel proposals invalidate one another,
every cancellation consumes a nonce, a route-substitution transaction consumes the
same nonce as the intended module call, and signatures have no deadline.

**I-03 — `forwardEnabled` persists across executor changes.** Stored in
TimelockExecutor keyed by wallet address. Removing the module as executor does not
clear the flag; reinstalling it later silently restores the previous setting.

**I-04 — Tooling must handle nonstandard account behavior.** `batch` iterates by
`targets.length`, so shorter `values`/`datas` revert while extra elements are
ignored. Unknown fallback selectors return success with empty data. ERC-1271
wraps the supplied hash in `SafeMessage(bytes32 hash)` rather than validating the
raw digest. Signatures must be ordered by ascending signer address. `getOwners`
order after `addOwner` is not necessarily ascending.

**I-05 — Documentation and testing gap.** No regression test submits the same
authorization through the wrong route and verifies that the original queued action
becomes executable before the delayed cancellation. The security document also
contains older descriptions of `cancelQueued` as executor-only, while the current
source makes it `onlySelf`.

> ## ▸ Response — maintainers
>
> **I-01** — accepted as informational. The fail-open direction is the
> uncomfortable part: `required = 0` makes `sigs.length == 0` valid and the
> verification loop body never runs, so `forward()` would call the wallet as
> executor on an empty bundle. 65,536 authorized `addOwner` calls is not a
> practical attack, but a `require(required != 0)` in any future module costs
> nothing.
>
> **I-02** — accepted, and the deadline omission is the part worth carrying
> forward: a signature stays valid until some transaction consumes its nonce,
> with no expiry of its own. The reviewer's proposed V2 struct includes a
> `deadline`, which is the right answer.
>
> **I-03** — **independently confirms** a property we identified while responding
> to the Opus 5 review. Two reviewers reaching it separately raises our confidence
> that it deserves explicit procedure: set the intended flag explicitly on both
> installation and removal, never assume rotation cleared it. The dapp reads
> `forwardEnabled` live from the module on every load, so its display cannot go
> stale, but operators reasoning from wallet storage alone will be wrong.
>
> **I-04** — accepted; all four are already handled in this client. Batch arrays
> are built from one source so lengths cannot diverge; the unknown-selector
> behaviour is surfaced as `SELF-CALL · SILENT NO-OP` for self-calls; ERC-1271
> wrapping is the documented Safe-inspired pattern; and signature slots are sorted
> by signer address independently of `getOwners` order, with the linked-list
> predecessor resolved separately for `removeOwner`.
>
> **I-05** — **accepted, and the missing test is the right ask.** A regression test
> that submits a cancellation bundle down the `execute()` route and asserts the
> original queued transaction becomes executable first is exactly what should have
> caught this. It is the single most valuable test anyone could add to this
> repository, and it belongs in `test/` alongside the H-01 mitigation. The stale
> `cancelQueued` description has been corrected.

---

# Security properties that held under review

I did not identify a viable attack against: signature uniqueness and threshold
enforcement (exact byte length, strictly ascending owners, invalid `ecrecover`
results rejected); cross-wallet and ordinary cross-chain replay protection
(`address(this)` and live chain ID in the domain); initialization safety
(factory-or-self only, `threshold == 0` guard, atomic with CREATE2); configuration
access control (all `onlySelf`); queued transaction replay protection (nonce in the
hash, entry deleted before the external call, restored atomically on revert);
ordinary reentrancy resistance (nonce advanced before guards and target calls); and
atomic factory setup (`createWithCalls` reverts wholly on any intermediate
failure).

> ## ▸ Response — maintainers
>
> Noted with thanks. This is the third independent confirmation of the core
> properties, reached by a reviewer that also found the most serious composition
> defect — which makes the positive findings more credible, not less.

---

# Coverage and limitations

This review included line-by-line manual review of `Multisig.sol` and
`TimelockExecutor.sol`, factory and clone initialization, EIP-712 and ERC-1271
paths, ECDSA/sender-bypass/on-chain approval handling, nonce and replay behavior,
queue state transitions, executor and `0x1111` guard composition, CREATE2 salt
behavior, malicious-target and reentrancy reasoning, and review of the test suite
and previous audit reports.

I was not able to independently retrieve Ethereum runtime bytecode through an RPC
endpoint in this environment or reproduce the exact build locally with
Forge/solc. Therefore, **the assertion that the Ethereum addresses contain
bytecode identical to the reviewed source remains an open pre-funding
verification gate**.

The prior invariant campaign expressly excluded or did not directly cover the
executor bypass, factory deployment paths, module contracts, malicious-target
reentrancy, malformed signatures, and cross-wallet/cross-chain cases. Those prior
results therefore do not close the composition issue found here.

> ## ▸ Response — maintainers
>
> **The point about the prior invariant campaign is correct and important.** Shred
> Security's Appendix B reports 10/10 invariants holding across ~327,680 handler
> calls with zero contract bugs — but its own out-of-scope list excludes executor
> bypass and guardian hooks, the factory paths, malformed signatures, and
> cross-wallet replay. A clean fuzzing result over a scope that excludes the
> executor says nothing about a composition defect in the executor. We record this
> in `SECURITY.md` so the number is not cited as broader assurance than it is.
>
> On the bytecode gate: `MultisigFactory.implementation()` was confirmed to return
> the expected address live on Ethereum and Base. The dapp additionally checks it
> on every target chain at deploy preflight and compares each deployed wallet's
> runtime against the audited 45-byte clone, published in `README.md`. Independent
> verification with `cast code` remains the right pre-funding step for anyone not
> using this client.

---

# Final approval status

**The Multisig core does not show an arbitrary outsider-drain vulnerability and
may remain the wallet implementation. The factory may be used with sender-bound
salts. The current TimelockExecutor should not receive an unconditional production
greenlight.**

For a high-value Ethereum treasury or DeFi administrator, the correct production
posture is:

> **Retain the factory and Multisig core, deploy a route-specific replacement
> executor, install it through `setExecutor`, and do not rely on the existing
> same-digest TimelockExecutor for adversarial emergency cancellation or urgent
> execution.**

> ## ▸ Response — maintainers
>
> **We accept the substance and qualify the scope.**
>
> Accepted: the core and factory stand; the sender-bound salt requirement is
> already enforced by this client; a route-specific replacement executor is the
> correct end state and is now first on the post-launch list.
>
> Qualified: "do not rely on the existing TimelockExecutor for adversarial
> emergency cancellation" is true of an *unbound* bundle and no longer true of one
> built by this dapp. With one slot bound to the submitting owner, a cancellation
> bundle cannot be replayed down the `execute()` route by anyone — the copier is
> one signature short. That is the reviewer's own mitigation, moved from operator
> discipline into code, and it closes the cancel path specifically.
>
> What remains open, and what we state plainly rather than paper over: the
> unanimous accelerate and instant-execute paths on a k-of-n wallet can still be
> downgraded by extracting a threshold subset, because binding one slot leaves
> `n - 1 ≥ k` copyable signatures. The impact is delay and forced re-signing rather
> than a neutralised brake, and protected submission is the remaining mitigation
> until a V2 executor ships.
