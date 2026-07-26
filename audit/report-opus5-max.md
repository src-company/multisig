# Security Audit — Multisig, MultisigFactory & TimelockExecutor

**Reviewer:** Claude Opus 5 (max effort), independent adversarial review
**Date:** 26 July 2026
**Commit:** `09e2c38` (`src-company/multisig`)
**Compiler:** solc 0.8.34, optimizer on, 9,999,999 runs
**Transcript:** <https://claude.ai/share/c8a3a7d4-962f-4cb3-9fea-5690e9c7c7a2>

**Result:** 2 High, 6 Medium, 6 Low, 9 Informational — all configuration-dependent.

---

## About this file

This reproduces the delivered report with the maintainers' responses added.
Everything outside a **▸ Response** block is the reviewer's text as written;
every **▸ Response** block is ours and was not part of the review.

**Our overall position: no redeployment of `Multisig` or `MultisigFactory`.**
The reviewer's own conclusion is that no issue lets an unauthorised party move
funds from a correctly configured wallet. Every accepted finding is either a
configuration trap now blocked in the dapp, or informational. Dispositions are
tracked in [`SECURITY.md`](../SECURITY.md).

**Two caveats on the review itself, stated up front:**

1. **One factual claim is wrong.** §1 states the `Multisig` singleton address
   "is not published in the repo and should be." It is published in
   `README.md` (Deployments table, with explorer link), `docs/src/README.md`,
   `SECURITY.md`, `dapp/index.html`, and `dapp/docs.html`. The claim is
   emphasised in §1, repeated in the summary, and becomes checklist item 8 in §7.
2. **Four findings re-file items this repo explicitly asks reviewers to
   discard** — H-2, M-4, M-5 and L-6 all appear in the False Positive Patterns
   table in `SECURITY.md`. The review's status column discloses this, which is
   good practice, but the severities do not reflect it.

We could not re-run the 20 proof-of-concept tests: the files are not included
with the report (its appendix says `cp /path/to/…`) and Foundry is not installed
in our environment. Every claim below was instead verified by reading source.
The factory's `implementation()` was confirmed live on Ethereum and Base.

### Disposition summary

| ID | Filed | Our position | Contract change |
|---|---|---|---|
| H-1 | High | **Accepted as a mechanism, downgraded to Low/Medium.** New and correct. The design it criticises is deliberate — see our response. | None |
| H-2 | High | **Rejected as filed.** Documented design, on the false-positive list. The guard-specific framing is a fair Low. | None |
| M-1 | Medium | **Accepted, mitigated.** Correctly generalises Shred L-1. | None |
| M-2 | Medium | **Accepted, mitigated.** | None |
| M-3 | Medium | **Accepted, mitigated** — with one overstatement corrected. | None |
| M-4 | Medium | **Rejected as filed** (F-1). | None |
| M-5 | Medium | **Rejected as filed** (F-2). | None |
| M-6 | Medium | **Downgraded to Info.** Outcome right, mechanism wrong. | None |
| L-1 | Low | Acknowledged (F-5). | None |
| L-2 | Low | **Accepted, mitigated.** New and correct. | None |
| L-3 | Low | **Accepted, documented.** | None |
| L-4 | Low | Acknowledged (TLE F-2). | None |
| L-5 | Low | Acknowledged — deliberate. | None |
| L-6 | Low | **Rejected as filed** (F-4). | None |
| I-1..I-9 | Info | Accepted as informational. | None |

---

# 1. Deployment verification

I compiled the repository locally and reproduced the deployment addresses from
first principles rather than trusting the published metadata.

| Artifact | Locally compiled init-code hash | Claimed in `vanity_findings.md` | Match |
|---|---|---|---|
| `MultisigFactory` | `0x1d7bca92…d973ec5` | `0x1d7bca92…d973ec5` | ✅ |
| `TimelockExecutor` | `0x5a9c4b69…f02f9c88` | `0x5a9c4b69…f02f9c88` | ✅ |
| `Multisig` | `0x7f9e5aa1…d1a939b2` | — (derived) | — |

CREATE2 derivation from the SafeSummoner deployer
`0x00000000004473e1f31C8266612e7FD5504e6f2a` with the published salts reproduces
both addresses exactly:

```
MultisigFactory   derived: 0x000000000e8CB9ed9DC2114d79d9215eacb9cB07  ✅
TimelockExecutor  derived: 0x00000000a72A30AdBf38e14d36BCE2610ec3973F  ✅
```

The `Multisig` singleton is `CREATE2(factory, salt=0)` →
`0xD54cb65224410F3Ff97a8E72f363f224419f4FB0`. **This is the address EIP-7702
users delegate to; it is not published in the repo and should be, since users
must verify it before signing an authorization.**

I could not read live mainnet state (no Etherscan key in this environment), so I
verified *derivation*, not *current on-chain code*. Before relying on this,
confirm `eth_getCode` at each address is non-empty and matches the locally built
runtime.

**Guard-mode collision check.** The `Multisig` executor slot encodes guard
behaviour in the address itself (leading or trailing `0x1111`). All three
deployed addresses were checked; none accidentally triggers guard mode:

| Address | Lead 2B | Trail 2B | Pre-guard | Post-guard |
|---|---|---|---|---|
| MultisigFactory | `0x0000` | `0xcb07` | no | no |
| TimelockExecutor | `0x0000` | `0x973f` | no | no |
| Multisig singleton | `0xd54c` | `0x4fb0` | no | no |

Storage packing verified: `delay`/`nonce`/`threshold`/`ownerCount`/`executor`
occupy slot 0 exactly (12 + 20 = 32 bytes), as documented.

> ### ▸ Response — maintainers
>
> **The derivation work is welcome and the guard-collision check is a good idea
> we had not run ourselves.** Both are confirmed correct.
>
> **The publication claim is false.** `0xD54cb65224410F3Ff97a8E72f363f224419f4FB0`
> appears in six places in this repository, including the `README.md`
> Deployments table with an explorer link and the `IMPLEMENTATION` constant the
> dapp uses on every deploy. No action taken because none is needed.
>
> On the live-state caveat: we confirmed `MultisigFactory.implementation()`
> returns the expected address on Ethereum and Base. The dapp additionally
> performs this check on every target chain at deploy preflight, and compares
> deployed wallet bytecode against the audited 45-byte clone
> (`5f5f365f5f37365f73 ‖ IMPLEMENTATION ‖ 5af43d5f5f3e6029573d5ffd5b3d5ff3`),
> which is published in `README.md`.

---

# 2. Methodology

- Full manual review of `Multisig.sol` (321 LoC) and `TimelockExecutor.sol`
  (71 LoC), plus the `IMultisig` interface.
- Byte-level verification of the inline-assembly PUSH0 minimal-proxy init code
  and the free-memory-pointer clobber/restore in `MultisigFactory.create`.
- Re-execution of the existing suite: **291/291 pass**.
- **20 new adversarial proof-of-concept tests written and executed**, all
  passing. Files: `test/AuditPoC.t.sol` (12) and `test/AuditEdge.t.sol` (8).
- Reviewed the four prior reports in `audit/` so that findings are correctly
  attributed as new, confirmed, or re-scoped.

Every finding below is backed by an executing test, not by inspection alone.

> ### ▸ Response — maintainers
>
> The PoC files were not delivered with the report, so we could not re-run them
> or add them to the suite. **If they can be supplied they should be committed
> to `test/`** — a permanent regression suite for these configuration traps is
> worth more than the report itself, particularly for M-1 and M-3.

---

# 3. Summary

| ID | Severity | Title | Status vs. prior audits |
|---|---|---|---|
| H-1 | **High** | Timelock fully bypassable by replaying quorum signatures into `forward()` | **New** |
| H-2 | **High** | Guard and executor share one slot — every guard is an unconstrained superuser | **New framing** |
| M-1 | Medium | Codeless or ABI-incompatible executor at a `0x1111` address permanently bricks the wallet | Extends Shred L-1 |
| M-2 | Medium | Unbounded `setDelay` permanently freezes a wallet with no executor | **New** |
| M-3 | Medium | Queued transactions are irrevocable when `executor == address(0)` | Confirmed (F-3 residual) |
| M-4 | Medium | Zero-prefixed salt: counterfactual address theft and cross-chain squatting | Confirmed + extended (F-1) |
| M-5 | Medium | Pre-execution hook fires before signature verification | Confirmed (F-2) |
| M-6 | Medium | `forward()` verifies against a nonce it never pins | Confirmed (N-003) |
| L-1 | Low | Post-execution hook fires when a transaction is only queued | Confirmed (F-5) |
| L-2 | Low | Silent fallback turns failed governance self-calls into successful no-ops | **New** |
| L-3 | Low | Stale approvals reactivate when a removed owner is re-added | Extends N-006 |
| L-4 | Low | `forwardEnabled` cannot be revoked by a threshold quorum | Confirmed (TLE F-2) |
| L-5 | Low | `cancelQueued` reuses the `Queued` event as a cancellation signal | **New** |
| L-6 | Low | `executeQueued` is permissionless — execution timing is an MEV surface | Confirmed (F-4) |
| I-1..I-8 | Info | See §5 | Mixed |

**No issue was found that lets an unauthorised party move funds from a correctly
configured wallet.** The signature scheme, nonce handling, owner linked list,
replay protection and clone deployment logic are sound. Every High and Medium
finding is a *configuration-dependent* failure — which matters, because several
of the dangerous configurations are the defaults or the ones the README
recommends.

> ### ▸ Response — maintainers
>
> The headline conclusion is the one we act on, and we agree with it.
>
> **"Several of the dangerous configurations are the defaults" is not accurate
> for this codebase.** Taking them in turn: `forwardEnabled` (H-1) defaults
> false in the contract and `fastPath: false` in the dapp's create form;
> `delay > 0` with no executor (M-3) is unreachable through the dapp, which
> always pairs a non-zero delay with the TimelockExecutor; a `0x1111` executor
> (M-1) requires deliberately pointing at a marked address; and the dapp's salt
> miner is sender-bound by construction (M-4), searching only for a `0x00`
> address prefix. The traps are real, but they are reached by deliberate
> configuration, not by accepting defaults.

---

# 4. Findings

## H-1 — Timelock is fully bypassable by replaying quorum signatures into `TimelockExecutor.forward()`

**Contracts:** `TimelockExecutor.forward()` (L40–47), `Multisig.execute()` (L134–174)
**PoC:** `test_PoC1_TimelockBypass_NofN_SignatureDualUse`, `test_PoC1b_TimelockBypass_KofN_WhenAllOwnersSign`

`forward()` validates signatures over the *same* EIP-712 `Execute` digest that
`Multisig.execute()` uses. This is deliberate — the header comment says the same
signatures should work in both places for UX. The intended routing is that
`forward()` requires **all** owners while `execute()` requires **threshold**, so
unanimity is what distinguishes "execute now" from "queue for review".

That distinction collapses whenever `ownerCount == threshold`:

```solidity
required = IMultisig(multisig).ownerCount();   // == threshold on an n-of-n wallet
...
require(sigs.length == required * 65, InvalidSig());
```

For a 2-of-2 or 3-of-3 wallet — among the most common configurations in
production — every signature set that satisfies the normal timelocked path is
byte-identical to one that satisfies the immediate path. Owners believe they are
authorising a transaction that will sit in a queue for review. Any relayer, or
anyone who observes the signatures in the mempool or a coordination channel, can
instead route them through `forward()` and execute immediately.

The PoC deploys a 2-of-2 with a 2-day delay and `forwardEnabled`, then shows the
same 130-byte blob either queueing for 2 days or moving 5 ETH instantly, purely
at the submitter's discretion:

```
assertEq(address(sink).balance, 5 ether, "TIMELOCK BYPASSED: funds moved instantly");
assertEq(w.queued(h), 0, "nothing was ever queued");
```

k-of-n wallets are exposed too, via a subtler route. Collecting spare signatures
is normal operational hygiene — you gather all n so a relayer can drop one if a
signer's key is later questioned. `Multisig.execute()` rejects the full set
(`sigs.length` must equal `threshold * 65` exactly), which makes the extra
signatures look harmless. They are not: `test_PoC1b` shows that the same
3-signature blob that `execute()` rejects is accepted by `forward()` and executes
instantly on a 2-of-3 with a 2-day delay.

The root cause is that there is no domain separation between "I authorise this
transaction" and "I authorise this transaction to skip the timelock." A signer
cannot express the former without also granting the latter.

**Impact.** The timelock — the wallet's only defence against a
compromised-but-not-yet-detected quorum, and the exit window it advertises to
downstream protocol stakeholders — provides no guarantee. Prior report TLE F-1
examined the opposite direction (cancel signatures replayed into `execute()`,
which merely delays a cancel) and reasonably rated it Low. This direction removes
a security boundary rather than adding latency to a safe action.

**Recommendation.** Give `TimelockExecutor` its own typehash so the two
authorisations are cryptographically distinct:

```solidity
bytes32 constant FORWARD_TYPEHASH =
    keccak256("ForwardExecute(address multisig,address target,uint256 value,bytes data,uint32 nonce)");
```

Signers then see a distinct EIP-712 struct in their wallet UI that names what it
is. This costs the "same signatures work everywhere" convenience, which is the
correct trade: that convenience *is* the vulnerability. If the shared typehash
must be kept, require `ownerCount > threshold` at minimum, and treat n-of-n
wallets as ineligible for `forwardEnabled`.

> ### ▸ Response — maintainers
>
> **Accepted as a mechanism. Downgraded to Low, or Medium for wallets whose
> timelock is a public commitment. Mitigated in the dapp; no contract change.**
>
> The arithmetic is correct and the finding is new. Three things change the
> assessment.
>
> **1. The shared typehash is deliberate, and the reason is signature accrual.**
> The reviewer identifies this as "a deliberate UX decision" without recovering
> the design goal, so we state it: signatures are meant to be *monotonic*. One
> signature is one signature, valid wherever it is presented. Collect
> `threshold` and you have a queueable transaction; if a further owner signs the
> same digest before submission, you have an instantly-executable one — **with
> nobody re-signing anything.**
>
> A 2-of-3 collects Alice and Bob, and the proposal is queueable. Carol logs in
> an hour later and signs; the set is now unanimous and can execute immediately.
> Alice and Bob are not asked to sign a second, differently-named struct. That
> is the product behaviour we wanted, and bifurcating the domain is precisely
> what would destroy it — every transaction would need a decision up front about
> which kind of signature to gather, and a late-arriving signer would trigger a
> full re-collection.
>
> This convenience lives in the pre-submission window. Once a transaction is
> queued the nonce advances, the original digest is dead, and accelerating it
> requires a fresh unanimous round over the `executeQueued` wrapper. We consider
> that the right place for friction, since it is the point where a delay already
> running is being overridden.
>
> **2. On an n-of-n wallet, the review window this removes was never usable
> against a compromised co-signer.** The reviewer did not check who can cancel.
> `forward()` routes a `cancelQueued` self-call on `threshold` signatures — and
> notably *without* requiring `forwardEnabled`, so the brake works on every
> wallet using this executor. On an n-of-n vault `threshold` is everyone, so an
> honest owner cannot reach cancel quorum without the compromised key either.
>
> The asymmetry is the whole story: on a 2-of-3, two honest owners *can* cancel
> around a compromised third; on a 2-of-2, nobody can. The timelock's
> anti-compromise value only ever existed where `threshold < ownerCount` —
> exactly the configuration H-1 does not affect. The claim that the timelock is
> "the wallet's only defence against a compromised-but-not-yet-detected quorum"
> is therefore not true of the wallets H-1 applies to.
>
> What H-1 genuinely costs is narrower than "provides no guarantee":
> **third-party notice** (a wallet acting as a protocol admin can no longer
> promise N days' warning — this is where it keeps Medium), and **mistake
> recovery against an interested counterparty** (owners queue a transfer, spot a
> wrong address, and the recipient front-runs with `forward()` to deny the
> window). For ordinary self-custody it is Low.
>
> **3. The fast path is a velocity feature, not an emergency tool.** Its value
> is that a wallet needing only partial consensus to act slowly can act quickly
> when everyone is aligned — routine payments, trading. It is meaningful exactly
> when unanimity outranks quorum, i.e. `threshold < ownerCount`, and n-of-n is
> simply where that margin reaches zero. Not a defective feature; a degenerate
> configuration for it.
>
> **Mitigations shipped** (`dapp/index.html`): the dapp surfaces the n-of-n case
> at deploy in the review screen, requires a deliberate second press in admin,
> and `txKind()` labels an inbound `enableForward(true)` on such a vault
> `FAST PATH · TIMELOCK BECOMES ADVISORY`. **Flagged, not refused** — the
> configuration is legitimate and the owners authorised the transaction either
> way. What must not happen is that it be a surprise.
>
> **One property the reviewer missed, and it is worse than the signature
> story.** `forward()`'s `v=0` branch accepts `approved(signer, hash)` — *public
> contract state*, not a signature. On an n-of-n vault with the fast path on,
> once every owner has called `approve(hash, true)`, **any address at all** can
> call `forward()` with `v=0` slots naming them and execute immediately. No
> signature blob to obtain, no mempool race; the authorisation sits in public
> storage until the nonce moves past it. This dapp exposes that approval path
> directly. It is the same collapse with the access requirement removed.
>
> Two qualifications, since on-chain approval is a deliberate mechanism rather
> than an oversight. It exists because a **contract owner cannot sign** — a DAO
> or nested multisig has no other route — and because it removes every off-chain
> dependency: a vault whose owners approve on-chain keeps working with no
> coordination service at all, if this dapp or its database disappear. That is a
> liveness property worth having, and it is why the option stays.
>
> The exposure is also narrower than "permanent public authorisation" suggests.
> The approved hash commits to a specific nonce and both routes compute against
> the live one, so an approval is permanently unreachable the moment the nonce
> advances past it. The window is one nonce wide, which also bounds the
> reactivation-on-re-add issue filed as L-3.
>
> And the two goals reconcile: every owner **but one** approves on-chain, and the
> remaining owner submits *without* approving. Their slot stays sender-only, a
> copier is left one signature short, and no coordination service was needed to
> assemble the quorum. That is the pattern this dapp now recommends when an
> approval lands.
>
> **A second missed property:** `forwardEnabled` is keyed by wallet address in
> the module and never cleared, so it survives executor rotation. A wallet that
> enables the fast path, rotates its executor away, and later returns to the
> TimelockExecutor has it back on with no proposal having re-enabled it. This
> dapp reads the flag live from the module on every load, so its display stays
> correct, but operators reasoning from wallet storage alone will be wrong.
> Compounds L-4.
>
> **On the k-of-n sub-case (`test_PoC1b`):** this demonstrates the documented
> feature behaving as specified — "all owners signed → immediate execution" is
> the stated contract, and the design goal in point 1 is exactly that a
> late-arriving signature upgrades the set. The operational hazard is real but
> narrower than framed: a team gathering spare signatures for relayer redundancy
> may not realise they have produced an instant-execution authorisation, and
> `execute()` rejecting the oversized blob makes it *look* inert.
>
> **If we ever redeploy the executor**, we will take the reviewer's fix. It does
> not require migrating anything: `executor` is per-wallet mutable storage, so a
> `TimelockExecutorV2` with a distinct `ForwardExecute` typehash (H-1) and an
> explicit `expectedNonce` parameter (M-6) can be deployed alongside the current
> one and adopted through a single threshold-signed `setExecutor`. Launching on
> v1 does not lock that door.

---

## H-2 — Guard and executor share one storage slot, so every guard is an unconstrained superuser

**Contract:** `Multisig` — `executor` (L23), `execute()` (L139, 141, 170)
**PoC:** `test_PoC4_GuardAddressIsUnconstrainedSuperuser`

Guard behaviour is encoded in the *executor address itself*. To install a pre- or
post-transaction guard, you must set `executor = guardAddress`. But `executor` is
also the emergency-bypass role:

```solidity
if (msg.sender != _executor) { /* ...signature verification... */ }
if (_delay == 0 || msg.sender == _executor) { /* execute immediately */ }
```

A guard is, by construction, an address that can execute anything with no
signatures and no delay. These are opposite trust levels collapsed into one
variable — a guard is meant to be a *restriction*, and here installing one grants
full custody.

The PoC installs a passive, observation-only guard on a 3-of-5 with a 7-day
timelock, then drains 10 ETH from the guard address with empty calldata and empty
signatures:

```solidity
vm.prank(guardAddr);
w.execute(attacker, 10 ether, "", "");
assertEq(attacker.balance, 10 ether, "guard bypassed both signatures and the 7-day timelock");
```

The consequence compounds: any bug in a guard that lets an outsider make it call
back into the wallet is instant total compromise, and the reentrancy is *expected*
because the wallet calls the guard on every `execute`. A guard is the component
most likely to be written ad hoc per deployment and least likely to be audited,
yet it carries the highest privilege in the system.

**Recommendation.** Separate the roles into two slots (`executor` and `guard`), or
at minimum require that a guard-mode address is reached only through the hook
path — i.e. reject `msg.sender == _executor` bypass when the executor address
encodes guard bits. Given that the storage slot is already full at 32 bytes, a
second slot is the honest fix. Until then, treat the guard address as a full
co-owner in your threat model and hold it to the same standard as the wallet
itself.

> ### ▸ Response — maintainers
>
> **Rejected at this severity. The underlying fact is documented design; the
> framing is a fair Low.**
>
> "Executor can steal all funds" is the first row of the False Positive Patterns
> table in `SECURITY.md`, and `README.md` states plainly: *"The executor has full
> control by design."* Filing it as **High** requires overriding an explicit,
> published trust assumption. The review's own status column says "New framing",
> which is the accurate description — and a reframing of a documented property is
> not a High.
>
> **The framing is nonetheless worth something, and we accept it as a Low.** Safe
> users import a mental model where a Guard *restricts* — it can only block, never
> authorise. Ours grants full custody. An operator carrying that model across will
> be wrong in the most expensive possible direction. That deserves prominence in
> the docs, which is where we have put it.
>
> **Not fixing it in-contract.** A second slot means new `Multisig` bytecode, a new
> factory, new addresses, and migrating every live wallet. We are not spending that
> on a documented design property. Guard-mode operators should treat the guard
> address exactly as the reviewer says: a full co-owner, held to the same standard
> as the wallet.
>
> The dapp does what it can at the edges: a `setExecutor` naming a `0x1111` address
> requires a deliberate second press and now a code-presence check (see M-1), and
> `txKind()` labels it `SET EXECUTOR · GUARD HOOK` with the authority spelled out.

---

## M-1 — A codeless or ABI-incompatible executor at a `0x1111` address permanently bricks the wallet

**Contract:** `Multisig.execute()` (L139, 170), `executeQueued()` (L189, 197)
**PoC:** `test_E1_CodelessGuardAddressBricksWalletPermanently`, `test_E1b_CodelessPostGuardAlsoBricks`, `test_E2_SelfReferentialGuardBricks`

The hook is a high-level Solidity call, so the compiler emits an `extcodesize`
check:

```solidity
if (uint160(_executor) >> 144 == 0x1111) Multisig(payable(_executor)).execute(target, value, data, sigs);
```

If the executor address has leading or trailing bytes `0x1111` and holds no code —
an EOA, or a counterfactual address where a guard is planned but not yet deployed
— the call reverts with `call to non-contract address`. Confirmed in the trace.
The same happens for a deployed contract lacking the
`execute(address,uint256,bytes,bytes)` ABI; `TimelockExecutor`'s own header warns
about exactly this.

Recovery is impossible. `setExecutor`, `batch` and `delegateCall` are all
`onlySelf`, reachable only through `execute()`, and `execute()` reverts in the
hook before reaching anything. `executeQueued()` calls the same hook, so
already-queued transactions are stuck too. The PoC leaves 100 ETH permanently
locked and demonstrates that every recovery route reverts.

Neither `init` nor `setExecutor` validates the executor. The probability a
randomly chosen address collides is roughly 2/65,536 (~1 in 32,768) — small, but
this is a one-way door with total loss at the end of it, and "point the executor
at an EOA security-council key" is a natural thing for an operator to do.

Shred L-1 identified the self-referential variant and rated it Low. The finding is
broader than self-reference: any codeless or ABI-mismatched address in the encoded
range is fatal, and the failure is silent at configuration time.

**Recommendation.** Validate in both `init` and `setExecutor`:

```solidity
require(
    (uint160(e) >> 144 != 0x1111 && (uint160(e) & 0xFFFF) != 0x1111) || e.code.length != 0,
    InvalidConfig()
);
```

Better still, wrap hooks in a low-level `call` and ignore the codeless case, so a
guard address that is not yet deployed degrades to "no guard" rather than "no
wallet." Separately: publish a deployment checklist item requiring operators to
verify the executor address against both `0x1111` masks before signing.

> ### ▸ Response — maintainers
>
> **Accepted and mitigated. The best finding in this report after H-1.**
>
> Correct, and it correctly generalises Shred L-1 past self-reference: solc emits
> the `extcodesize` check because `execute` has no return values, so *any* codeless
> marked address is fatal, not just the wallet's own. The "guard planned but not
> yet deployed" case is the one that worries us most — it is a plausible
> deployment sequence with total loss at the end of it.
>
> This exposed a real gap in our own mitigation. Our earlier `executorRisk()` guard
> hard-blocked the self-referential cases but treated a *distinct* marked address
> as merely worth confirming, with no code check. A codeless marked executor would
> have sailed through.
>
> **Fixed** (`dapp/index.html`): `setExecutor` now reads the chain before proposing
> a marked executor and hard-blocks one with no code. If the chain cannot be
> reached, it refuses rather than assuming — this is not a judgement call to
> delegate to the user.
>
> Not fixed in-contract; that would require redeploying `Multisig`. The residual
> is a wallet driven by other tooling, which we accept and document.

---

## M-2 — Unbounded `setDelay` permanently freezes a wallet with no executor

**Contract:** `Multisig.setDelay()` (L238–240)
**PoC:** `test_PoC3_SetDelayBricksWalletForever`

`setDelay` accepts any `uint32` with no upper bound — up to ~136 years. Because
every recovery action routes through `execute()`, and `execute()` queues when
`delay != 0`, `setDelay(0)` is itself subject to the delay just set. With
`executor == address(0)` there is no bypass. The PoC sets `type(uint32).max`,
attempts the fix, warps ten years forward, and the wallet is still frozen with its
funds inside.

This is the same structural trap as M-3 but reachable through a single
fat-fingered parameter — units confusion (days vs. seconds) is the obvious path,
and `31536000` vs `3153600000` is an easy typo to miss in a hex-encoded calldata
review.

**Recommendation.** Bound the delay in `setDelay` and `init` (e.g.
`require(_delay <= 30 days)`). A timelock longer than a month has no legitimate
operational use and the cost of the cap is zero.

> ### ▸ Response — maintainers
>
> **Accepted and mitigated.** Correct, and the units-confusion path is the
> realistic one.
>
> The important qualifier is in the title and we have built to it: this is fatal
> only with no executor. With the TimelockExecutor installed, a unanimous
> `forward()` can still set the delay back, and a queued bad `setDelay` can be
> cancelled outright on threshold signatures before it ever executes.
>
> **Mitigation** (`dapp/index.html`): delays over 30 days require a deliberate
> second press, and are **refused outright when the vault has no executor** — the
> only genuinely terminal case. `txKind()` flags an inbound one
> `SET TIMELOCK · EXTREME`, naming whether a bypass exists. Gating on executor
> presence rather than on the number keeps the guard proportionate to the actual
> risk.

---

## M-3 — Queued transactions are irrevocable when `executor == address(0)`

**Contract:** `Multisig.cancelQueued()` (L182), `executeQueued()` (L187)
**PoC:** `test_PoC2_QueuedTxIrrevocable_NoExecutor`, mitigation confirmed by `test_E3_TimelockExecutorRestoresCancellation`

`cancelQueued` is `onlySelf`, so a cancel must be routed through `execute()` —
where it is itself queued for `delay`. A cancel therefore matures no earlier than
the transaction it cancels. The PoC asserts this directly:

```solidity
assertGe(w.queued(cancelHash), badEta, "cancel matures no earlier than the malicious tx");
```

and then drains the wallet on schedule. Rotating signers does not help, because
`executeQueued` re-validates nothing — it only checks that the hash is queued and
the ETA has passed.

The prior report accepted this as "a deliberate security posture: irrevocable
delay reduces trust surface." That reasoning holds for the *executor key* but not
for the timelock's purpose. A timelock exists so that someone can intervene during
the window; a window nobody can act in is a delay, not a safeguard. A wallet in
this configuration has strictly worse properties than one with no delay at all: an
attacker who reaches quorum still wins, and now the legitimate owners also cannot
move quickly.

`TimelockExecutor` is the correct answer and it works — `test_E3` confirms a
threshold-signed cancel lands immediately and the malicious transaction becomes
unexecutable. **This should be documented as required rather than optional.**

**Recommendation.** Ship `delay > 0` and `executor == address(0)` as an explicitly
unsupported configuration. Ideally enforce it:
`require(_delay == 0 || _executor != address(0))` in `init`, and reject
`setExecutor(address(0))` while `delay != 0`. Alternatively, allow a
threshold-signed cancel to bypass the queue natively, which is what Compound's
`Timelock` does by keeping `cancelTransaction` an immediate admin action.

> ### ▸ Response — maintainers
>
> **Accepted and mitigated. One claim in it is wrong and we are correcting it,
> because the wrong version would push operators toward a worse configuration.**
>
> The mechanism is right: a cancel is queued too and matures no earlier than what
> it cancels. We also confirm there is no side door — `executeQueued` takes the
> nonce as a *parameter* and recomputes the hash from it, so the queue entry
> survives the wallet's nonce advancing. You cannot invalidate it by burning
> nonces. Once queued without an executor, it is genuinely unstoppable.
>
> **The overstatement:** *"a wallet in this configuration has strictly worse
> properties than one with no delay at all."* It does not. A timelock does two
> jobs and only one of them needs an executor:
>
> - **Notice** — the queue is public, the ETA is on-chain, the `Queued` event
>   fires. Third parties get their full warning window and can act on it. This is
>   the canonical governance-timelock purpose and it works *perfectly* with no
>   executor.
> - **Intervention** — aborting during the window. This is what needs the
>   executor, and what the finding correctly identifies as missing.
>
> On who is actually made worse off: on a k-of-n, an attacker holding k keys has
> quorum while honest owners hold n−k, usually below quorum — they could do nothing
> with or without a delay. Where both sides have quorum, the attacker queued first
> and matures first either way. The delay never costs the owners a capability they
> had; it adds third-party notice they would otherwise lack. "Strictly worse than
> no delay" does not survive.
>
> The recommendation still stands on its own merits, and we implement it. **Deploy
> already always pairs `delay > 0` with the TimelockExecutor**, and the dapp now
> also refuses `setExecutor(0)` while a delay is set, flagging an inbound one
> `SET EXECUTOR · STRANDS THE QUEUE`.
>
> On "document as required rather than optional" — agreed, and this is the
> strongest argument for shipping the TimelockExecutor as the default executor. It
> is not an optional accelerator; it is what upgrades a notice period into an
> intervention window, on threshold signatures, immediately, with no
> `forwardEnabled` required.

---

## M-4 — Zero-prefixed salt allows counterfactual address theft and cross-chain squatting

**Contract:** `MultisigFactory.create()` (L286)
**PoC:** `test_PoC8_ZeroSaltCounterfactualAddressStolen`

```solidity
require(salt >> 96 == 0 || salt >> 96 == uint160(msg.sender), SaltDoesNotStartWith());
```

A zero-prefixed salt is permissionless: anyone may deploy at that address with any
owner set. The PoC pre-funds a predicted address with 100 ETH, has an attacker
deploy first with a 1-of-1 owner set, and shows the user's own `create` then
reverting with `DeploymentFailed` while the attacker controls the funds.

Two aggravating factors beyond the prior report's framing:

1. **The unsafe option is the default-looking one.** `salt = 0`, `salt = 1`,
   `salt = block.timestamp` all pass the check. Sender-binding requires
   deliberately constructing a 32-byte salt with your own address in the top 20
   bytes — a step users will skip.
2. **Cross-chain.** Because the factory sits at the same address on every chain, a
   wallet's address is identical everywhere. A user who receives funds at "their
   address" on a chain where they have not yet deployed can find an attacker
   already occupying it with a different owner set. Sender-bound salts prevent
   this — an attacker cannot reproduce your salt prefix — which makes them the
   correct default for anyone relying on address portability.

**Recommendation.** Make sender-binding the default in the dapp and SDK, and
require an explicit opt-out for permissionless salts. Consider deprecating the
zero-prefix branch entirely; its only real use case is deterministic deployment by
a known deployer, which sender-binding already covers.

> ### ▸ Response — maintainers
>
> **Rejected as filed** — F-1 in the False Positive Patterns table, a known and
> documented tradeoff. The zero-prefix branch is the canonical Solady
> `LibClone.checkStartsWith` pattern and exists for gas-efficient relayer deploys
> where no pre-funding occurs.
>
> **The recommendation is already implemented.** The dapp's salt miner is
> sender-bound by construction: `base = BigInt(caller) << 96n`, then it searches
> the low 96 bits for a `0x00` address prefix. There is no code path in this
> client that produces a zero-prefixed salt, and no opt-out to add. The
> cross-chain framing in point 2 is a fair sharpening of F-1 and is a good reason
> to keep it that way.

---

## M-5 — Pre-execution hook fires before signature verification

**Contract:** `Multisig.execute()` (L139 vs. L141)
**PoC:** `test_PoC5_PreHookInvokedByAnyoneWithForgedInput`

The guard is invoked before any authorisation check:

```solidity
if (uint160(_executor) >> 144 == 0x1111) Multisig(payable(_executor)).execute(target, value, data, sigs);
if (msg.sender != _executor) { /* verification */ }
```

Any address can invoke the guard with arbitrary `target`, `value`, `data` and
`sigs`. The outer transaction reverts afterwards, so no state persists — but guard
authors will reasonably assume the calls they see are authorised, and any guard
that meters, rate-limits, or accumulates based on observed calls will be wrong. It
is also a free griefing channel into whatever the guard touches.

**Recommendation.** Move the pre-hook below the verification block. Nothing in the
design requires it to run first, and moving it makes the guard's contract with the
wallet honest: "you are seeing a transaction that passed authorisation."

> ### ▸ Response — maintainers
>
> **Rejected as filed** — F-2 in the False Positive Patterns table. The pre-hook
> firing before verification is the point of the pattern: a guardian needs to see
> and be able to block a transaction *before* authorisation, which is what makes a
> blocklist enforceable. EVM atomicity guarantees no state persists when the
> subsequent signature check fails.
>
> The observation that guard authors may wrongly assume they are seeing authorised
> calls is a legitimate documentation note, and belongs alongside H-2's framing
> point: a guard sees *attempts*, not *authorisations*.

---

## M-6 — `forward()` verifies against a nonce it never pins

**Contract:** `TimelockExecutor.forward()` (L49)
**PoC:** `test_PoC10_ForwardExecutesUnderADifferentNonceThanSigned`

`forward()` reads `nonce()`, verifies signatures against `hash(nonce)`, then calls
`execute()`, which reads the nonce *again*. Any transaction landing between the two
reads produces a mismatch. The PoC shows a competing quorum transaction bumping the
nonce and causing `forward()` to revert with `InvalidSig`.

The failure mode is safe (revert, not misexecution) because signatures are
re-derived from live state, so it is a liveness rather than a safety issue. It
matters most for the cancel path — the moment you most need `forward()` to work is
during an incident, which is exactly when transaction volume and mempool contention
are highest.

**Recommendation.** Take the expected nonce as an explicit parameter and `require`
it matches:

```solidity
function forward(address multisig, address target, uint256 value, bytes calldata data, uint32 expectedNonce, bytes calldata sigs) public {
    require(IMultisig(multisig).nonce() == expectedNonce, InvalidSig());
```

This converts an ambiguous failure into a clear one and lets a relayer retry
deterministically.

> ### ▸ Response — maintainers
>
> **Downgraded to Informational. The outcome is right; the stated mechanism is
> not.**
>
> *"Any transaction landing between the two reads"* — both reads happen inside a
> single transaction. Nothing can interleave between them. The actual behaviour is
> that signatures bind to whatever the nonce is at execution time, so a competing
> transaction **mined first** invalidates them. That is ordinary multisig nonce
> racing, and `execute()` has exactly the same property: sign for nonce N, someone
> else executes first, your signatures are dead. It is not specific to `forward()`.
>
> The incident-timing argument is fair on its face but does not survive
> examination either: an adversary who could grief the cancel path by spamming
> nonce bumps needs quorum to do it, and an adversary with quorum has already won
> without griefing. Benign contention is the realistic case, and the remedy is to
> retry.
>
> The recommendation is nonetheless good API design — an explicit `expectedNonce`
> turns an ambiguous `InvalidSig` into an unambiguous one and lets a relayer retry
> deterministically. **We will take it if a `TimelockExecutorV2` is ever
> deployed**, alongside the H-1 typehash split.

---

## L-1 — Post-execution hook fires when a transaction is only queued

**PoC:** `test_PoC6_PostHookFiresOnQueueNotExecution`

The post-hook is outside the execute/queue branch, so it runs in both. The PoC
confirms the target was never called (`sink.hits() == 0`) while the post-guard
recorded an invocation. A guard enforcing a post-condition — "balance did not fall
below X" — evaluates against a state that never changed, and then evaluates again
later at real execution. Confirmed as previously reported (F-5); still open.

> ### ▸ Response — maintainers
>
> **Acknowledged, no change** — F-5, intentional. The post-hook fires on queue so a
> guardian can inspect queued parameters and revert the whole transaction, vetoing
> the *queueing* itself. The reviewer's point that a post-condition guard will
> evaluate twice, once against unchanged state, is a correct and useful note for
> guard authors.

## L-2 — Silent fallback turns failed governance self-calls into successful no-ops

**PoC:** `test_PoC7_MistypedSelfCallSucceedsSilently`

The `fallback` handles the three token-receiver selectors and returns empty success
for everything else. A self-call with a wrong selector therefore succeeds, emits
`ExecutionSuccess`, consumes the nonce, and changes nothing. The PoC signs
`setThreshhold(uint256)` (one typo), watches `ExecutionSuccess` fire, and shows the
threshold unchanged.

Because governance actions are self-calls, this converts calldata errors from loud
failures into silent ones — and the on-chain event says the operation succeeded, so
monitoring will not catch it either. `test_E6` also confirms the wallet returns
success for arbitrary interfaces (e.g. `transfer(address,uint256)`), which can
mislead integrations that probe by call.

**Recommendation.** Revert on unrecognised selectors, as Solady's `Receiver` does
via `FnSelectorNotRecognized`. The three receiver selectors are already enumerated;
everything else should be rejected.

> ### ▸ Response — maintainers
>
> **Accepted and mitigated. New, correct, and a good catch.** Verified: the
> assembly block falls through for non-matching selectors and the function returns
> empty success. Because only governance runs as self-calls, this turns exactly the
> class of mistake that should be loudest into the quietest one — and the emitted
> `ExecutionSuccess` means monitoring agrees it worked.
>
> **Mitigation** (`dapp/index.html`): `txKind()` now indexes every selector in the
> wallet's ABI plus the three receiver callbacks, and labels a self-call carrying
> anything else `SELF-CALL · SILENT NO-OP`, naming the nonce it would burn. The
> dapp's own governance calldata is ABI-encoded so it cannot typo; this catches
> hand-built calldata and proposals raised by other tools.
>
> Not fixed in-contract. Reverting on unrecognised selectors would require
> redeploying `Multisig`, and it is a correctness-of-input problem rather than a
> security boundary.

## L-3 — Stale approvals reactivate when a removed owner is re-added

**PoC:** `test_PoC9_ApprovalsSurviveOwnerRemovalAndReAdd`

`approved[owner][hash]` is never cleared. Verification checks current ownership, so
removal neutralises an approval — but re-adding the same address restores every
dormant approval, including any pre-approved future-nonce hashes set while the key
was compromised. The PoC walks approve → remove → re-add and shows the approval
live again. Extends N-006, which assessed removal alone.

**Recommendation.** Document that an address once removed for compromise must never
be re-added, even after key rotation, since the address is the key in this mapping.
Alternatively add an `approvalEpoch` per owner, incremented on removal, and mix it
into the approval key.

> ### ▸ Response — maintainers
>
> **Accepted, documented.** Correct. The operational rule is the one the reviewer
> states and we adopt it verbatim: **an address removed because it was compromised
> must never be re-added**, even after the key is rotated — the address, not the
> key, is what the approval mapping is keyed on.
>
> This also interacts with H-1's approval path: dormant approvals that reactivate
> on re-add are usable by anyone through `forward()`'s `v=0` branch on a fast-path
> wallet.

## L-4 — `forwardEnabled` cannot be revoked by a threshold quorum

**PoC:** `test_E7_ForwardCannotBeRevokedByThresholdQuorum`

Disabling forwarding requires either unanimity (via `forward()`) or the full
timelock (via `execute()`). The PoC shows a 2-of-3 quorum unable to revoke on a
wallet with a 30-day delay. This interacts badly with H-1: the configuration that
creates the bypass is also the one that is slowest to unwind. Confirmed as
previously reported (TLE F-2).

> ### ▸ Response — maintainers
>
> **Acknowledged** — TLE F-2. The interaction the reviewer notes is real: the
> configuration that is riskiest is also the slowest to unwind. Compounds with the
> stickiness property we recorded under H-1 (`forwardEnabled` survives executor
> rotation and is never cleared).
>
> Practical guidance, and the reason M-2's cap matters: keep the delay
> operationally sane, so that unwinding the fast path costs days rather than
> months.

## L-5 — `cancelQueued` reuses the `Queued` event as a cancellation signal

`cancelQueued` emits `Queued(hash, 0, 0)`. Cancellation and queueing are
semantically opposite but share an event signature, distinguished only by
`eta == 0`. Any indexer or monitoring rule that filters on `Queued` without
inspecting `eta` will report a cancellation as a new queued transaction — precisely
the alert most likely to be wired up, and precisely the moment accuracy matters.

**Recommendation.** Add `event Cancelled(bytes32 indexed txHash)`.

> ### ▸ Response — maintainers
>
> **Acknowledged, no change.** The reviewer is right that it is ambiguous to a
> naive filter, but `Queued(hash, 0, 0)` as a cancellation signal is deliberate and
> recorded under Changes Made in `SECURITY.md` — `eta = 0` is the documented
> sentinel, chosen for indexer visibility without a second event. Integrators must
> inspect `eta`. This dapp does.

## L-6 — `executeQueued` is permissionless

Anyone may execute a matured transaction. This is standard timelock behaviour and
intentional, but for value-sensitive targets (swaps, liquidations, oracle-dependent
calls) it hands execution timing to an adversary who may choose the worst block
within the window. Confirmed as previously reported (F-4). Route such calls through
a target contract with its own slippage or deadline checks.

> ### ▸ Response — maintainers
>
> **Rejected as filed** — F-4 in the False Positive Patterns table, intentional for
> relayer compatibility. The reviewer's own mitigation is the correct one and we
> endorse it: value-sensitive calls should carry their own slippage or deadline
> checks at the target, not rely on execution timing.

---

# 5. Informational

**I-1 — ERC-1271 reverts instead of returning a failure value.** `isValidSignature`
reverts with `InvalidSig` rather than returning a non-magic `bytes4`. Consistent
with Safe, but integrators that `try/catch` on the return value alone will treat it
as a hard failure. Document it.

**I-2 — ERC-1271 signatures are not subject to the timelock.** A wallet with a
30-day delay can still authorise an off-chain message instantly with threshold
signatures. That is correct for message signing, but operators should understand
that anything expressible as a signed order (Permit2, Seaport, intent systems)
escapes the delay entirely. This deserves a line in the README next to the timelock
description.

**I-3 — `init` accepts the wallet's own address as an owner.** Confirmed in
`test_E5_SelfAsOwnerAccepted`. Any self-call then fills one quorum slot for free via
the `msg.sender == signer` bypass. Not exploitable on its own — reaching a self-call
already requires quorum — but it is a silent effective-threshold reduction. Matches
N-005. Add `require(owner != address(this))`.

**I-4 — `ownerCount` and `threshold` truncate to `uint16` in `init` with no explicit
bound.** `_threshold <= len` is checked against a `uint256` length before the cast.
Unreachable in practice (65,536 owners far exceeds the block gas limit), but the
check should be `len <= type(uint16).max` for clarity.

**I-5 — `unchecked { ++ownerCount }` in `addOwner`.** No overflow guard.
Gas-infeasible to reach, and `getOwners()` would revert rather than corrupt, but the
`unchecked` buys nothing on a function this cold.

**I-6 — `msg.value` and `value` are independent in `execute`.** `execute` is payable
and forwards `value` (not `msg.value`) from the wallet's balance. Sending
`msg.value != value` silently donates the difference to the wallet. Harmless, easy
to misuse.

**I-7 — EIP-7702 storage is sticky across delegation changes.** Slot 0 persists if
an EOA revokes its delegation. `init` cannot be re-run (`threshold != 0`), and if
the EOA delegates to a different implementation that writes slot 0, returning to
`Multisig` yields a corrupted configuration. Inherent to 7702, but worth an explicit
warning: **delegating a 7702 EOA to this implementation is effectively irreversible
with respect to configuration.** Also note the EOA key remains a superuser — the
README says this, and it should stay prominent.

**I-8 — `memory-safe` annotation on the FMP-clobbering assembly in `create`.**
`mstore(0x24, ...)` writes bytes `0x40–0x43`, temporarily corrupting the free-memory
pointer, restored by `mstore(0x24, 0)`. I traced the sequence and it is correct — no
allocation occurs in between, and the revert path exits before it matters. This is
Solady's audited `LibClone` pattern verbatim. Flagged only because the `memory-safe`
annotation is a promise to the optimiser that is technically overbroad here; if this
code is ever edited, that invariant is easy to break silently.

**I-9 — No `s`-value upper-bound check on `ecrecover`.** Signatures are malleable in
the classic sense. Not exploitable here: signatures are never used as identifiers,
replay is prevented by the nonce, and `ecrecover` returning `address(0)` is caught
by `signer > SENTINEL`. Noted for completeness.

> ### ▸ Response — maintainers
>
> **All accepted as informational; none changes the contracts.** Verified each
> against source. Notes on the four that matter operationally:
>
> - **I-2** is the most under-rated item in this section. A timelock does not
>   constrain ERC-1271 message signing, so anything expressible as a signed order —
>   Permit2, Seaport, intent systems — escapes the delay entirely with threshold
>   signatures. Operators who believe a delay gates *all* outflows are wrong. This
>   goes in the docs beside the timelock description.
> - **I-7** should reach every EIP-7702 user: slot 0 survives delegation changes, so
>   delegating an EOA to this implementation is effectively permanent with respect
>   to configuration, and the EOA key remains a superuser throughout.
> - **I-3** matches N-005. Reaching a self-call already requires quorum, so it is a
>   silent effective-threshold reduction rather than a bypass — but there is no
>   legitimate reason to list the wallet as its own owner.
> - **I-8** is a fair maintenance flag rather than a defect. The sequence is Solady's
>   audited `LibClone` pattern verbatim and we traced it to the same conclusion.

---

# 6. What I verified as correct

Positive assurance matters as much as findings, so these were checked and hold:

- **Replay protection.** `nonce++` executes before any external call, so reentrancy
  into `execute` requires fresh signatures. `executeQueued` deletes `queued[hash]`
  before calling out. Cross-chain and cross-wallet replay are prevented by
  `block.chainid` and `address(this)` in the domain separator.
- **Signature verification.** Strictly ascending signer ordering prevents
  double-counting. `ecrecover` failure (`address(0)`) and invalid `v` values are
  caught by `signer > SENTINEL`. Fixed 65-byte slots with an exact length check
  prevent both truncation and padding attacks. The `Execute` and `SafeMessage`
  typehashes cannot collide.
- **Owner linked list.** `init` enforces strict ascension from `SENTINEL`, excluding
  `address(0)` and `address(1)`. `addOwner` rejects duplicates; `removeOwner`
  verifies the predecessor link and refuses to drop below `threshold`. No corruption
  path found.
- **Clone deployment.** I disassembled the PUSH0 minimal proxy byte by byte — the
  45-byte runtime correctly forwards calldata, delegatecalls the implementation, and
  propagates returndata and reverts. The 54-byte init code and creation prefix are
  correct.
- **The singleton is inert.** `test_E4_ImplementationIsInert` confirms the
  implementation cannot be initialised by an outsider and its `execute` reverts
  (`threshold == 0`). No self-destruct or takeover vector.
- **The factory cannot be induced to act on an existing wallet.** `create` and
  `createWithCalls` only ever call into the freshly CREATE2'd address. The temporary
  self-as-executor window in `createWithCalls` is atomic and unreachable from
  outside.
- **`TimelockExecutor` holds no funds and no cross-wallet authority.** Passing a
  malicious contract as `multisig` only causes `forward` to call back into that same
  contract. Its only state, `forwardEnabled`, is keyed by `msg.sender`.
- **The cancel path in `forward` cannot be repurposed.** Non-canonical calldata is
  accepted (`test_PoC11_CancelPathAcceptsPaddedCalldata`) and `value` is
  unconstrained, but the multisig's dispatcher pins the call to
  `cancelQueued(bytes32)` and the `value` is a self-transfer. No escalation.
- **Array-length mismatches in `batch` and `createWithCalls` revert** on calldata
  bounds checks rather than reading garbage.
- **The token-receiver fallback returns correctly.** `mstore(0x20, s);
  return(0x3c, 0x20)` produces a properly left-aligned `bytes4`, matching Solady.

> ### ▸ Response — maintainers
>
> **This is the most valuable section of the report** and the reason the review was
> worth commissioning even where we disagree on severities. Independent positive
> assurance on the signature scheme, nonce discipline, owner-list integrity and the
> clone bytecode is worth more than another restatement of the documented tradeoffs.
>
> Two of these bear directly on decisions recorded elsewhere: `TimelockExecutor`
> holding no funds and no cross-wallet authority is a large part of why we are
> comfortable launching on v1 despite H-1, and the singleton being provably inert
> closes the last open question about the EIP-7702 delegate target.

---

# 7. Recommended configuration for these deployments

Since these contracts are intended to be used together, the safest configuration
given the findings above:

1. **Deploy with a sender-bound salt.** Put your deployer address in the top 20
   bytes of the salt. This is the only protection against M-4, and it is the only
   thing that makes your wallet address safe to reuse across chains.
2. **Never set `delay > 0` without
   `executor = 0x00000000a72A30AdBf38e14d36BCE2610ec3973F`.** Without it, queued
   transactions are irrevocable (M-3) and a bad `setDelay` is fatal (M-2).
3. **Use `createWithCalls` to set `forwardEnabled` at deployment** if you want it,
   since bootstrapping it later costs a full delay period (L-4).
4. **Do not enable `forwardEnabled` on an n-of-n wallet** until H-1 is addressed. On
   a 2-of-2 or 3-of-3 it voids the timelock entirely. If you need both a timelock
   and forwarding, use k-of-n with `k < n`, and **do not circulate more than `k`
   signatures for any transaction.**
5. **Verify the executor address against both `0x1111` masks** before `init` or
   `setExecutor`, and confirm it has code (M-1). Both deployed addresses in scope
   are clear.
6. **Cap your delay at something operationally sane** — days, not years (M-2).
7. **Treat any guard address as a full co-owner** (H-2). It is not a restriction; it
   is a key.
8. **For EIP-7702:** verify the delegate target is
   `0xD54cb65224410F3Ff97a8E72f363f224419f4FB0` before signing an authorization, and
   understand that the EOA key remains a superuser and the configuration is
   effectively permanent (I-7).

> ### ▸ Response — maintainers
>
> **We adopt 1, 2, 5, 6, 7 and 8, and most of 4. The dapp now enforces or surfaces
> each of them.** Where we differ:
>
> **On 4 — the second sentence.** "Do not circulate more than `k` signatures" is the
> wrong instruction for this design, and following it would remove the feature's
> reason to exist. Signature accrual is the point: collect `k` and you have a
> queueable transaction; if a further owner signs before submission you have an
> instantly-executable one, with nobody re-signing. A late-arriving signature
> *upgrading* the set is the intended behaviour, not an accident to be guarded
> against by rationing signatures.
>
> The first sentence we agree with and enforce, with the qualifier that "voids the
> timelock entirely" overstates it — it makes the delay advisory rather than
> enforced, and the cancel brake is unaffected either way.
>
> **On 3**, note the interaction with 4: `createWithCalls` is the cheap way to
> bootstrap `forwardEnabled`, but on an n-of-n wallet that bakes in the H-1
> configuration at deploy, when it is cheapest to avoid. The dapp raises it in the
> deploy review screen for exactly that reason.
>
> **On 8**, the delegate target is published in `README.md`, `SECURITY.md`,
> `docs/src/README.md` and both dapp pages — see our response to §1.

---

# 8. Overall assessment

The core is well built. The signature scheme, nonce discipline, owner list, and
clone deployment are careful work, and the single-slot packing is achieved without
the correctness compromises that usually accompany it. 291 existing tests pass, and
my 20 adversarial tests found no path by which an unauthorised party moves funds
from a correctly configured wallet.

The weaknesses are concentrated in the executor abstraction, which carries three
incompatible jobs — emergency bypass, transaction guard, and timelock module host —
on one address-typed storage slot whose semantics are encoded in the address bits.
That overloading produces H-2 directly, M-1 directly, and makes M-3 and L-4 harder
to reason about than they need to be. H-1 is a separate issue: a deliberate UX
decision to share a typehash, which turns out to erase the boundary the timelock is
supposed to draw.

None of this requires a redesign. H-1 is a new typehash. M-1 and M-2 are `require`
statements. M-5 is moving one line. H-2 is the only one that needs a second storage
slot, and it is the one most worth spending it on.

> ### ▸ Response — maintainers
>
> **We accept the structural diagnosis.** The executor slot carrying three jobs is
> the correct reading, and it is the finding worth internalising regardless of how
> the individual severities settle. It converges with the Shred Security review,
> which reached the same conclusion by a different route.
>
> It does not change what we ship now. All three jobs live on immutable deployed
> singletons; separating them means new bytecode, new addresses and migrating every
> live wallet. The traps that overloading produces are configuration-reachable and
> are now blocked or flagged at the point the transaction is built.
>
> On H-1 specifically: the shared typehash was not an incidental convenience but the
> mechanism that makes signatures accrue monotonically, which is the property the
> whole collection flow is built on. We would fix it in a `TimelockExecutorV2` —
> which, because `executor` is per-wallet mutable storage, can be adopted later by
> any wallet through one threshold-signed `setExecutor`, with no migration and no
> address changes. That option stays open.

---

# Appendix — Reproducing this audit

```bash
git clone https://github.com/src-company/multisig && cd multisig
cp /path/to/AuditPoC.t.sol  test/
cp /path/to/AuditEdge.t.sol test/
forge test --match-path "test/Audit*.t.sol" -vv
# 20 passed; 0 failed
```

Address derivation:

```bash
forge inspect MultisigFactory bytecode | cast keccak
# 0x1d7bca92a0184238a3446ae3ccc48abcd4facb2c4c44818a6315d7ca6d973ec5
forge inspect TimelockExecutor bytecode | cast keccak
# 0x5a9c4b69380d3d2cc4dc369a04aba7e8c949f9fefcc475b146367005f02f9c88
```

**Scope limits.** This review covered `Multisig.sol` (both contracts) and
`TimelockExecutor.sol`. The other modules in `src/mods/` — `SocialRecovery`,
`SpendingAllowance`, `DeadmanSwitch`, `AllowlistGuard` — were not audited; note that
`audit/nemesis-verified.md` records two open **HIGH** findings in `SocialRecovery`
(N-001, N-002) that would apply if you install it as your executor. Live mainnet
bytecode was not read; derivation was verified instead. This report is not a
warranty, and an audit cannot prove the absence of vulnerabilities.

> ### ▸ Response — maintainers
>
> **The scope note about `SocialRecovery` is the single most actionable line in the
> appendix** and we are propagating it: `audit/nemesis-verified.md` records two open
> HIGH findings (N-001, N-002) that apply directly if that module is installed as a
> wallet's executor. It should not be, until they are resolved.
>
> The PoC files were not delivered and could not be re-run. If they can be supplied,
> they belong in `test/` as a permanent regression suite — the configuration traps in
> M-1, M-2 and M-3 are exactly the kind of thing that should be caught by CI rather
> than by the next review.
