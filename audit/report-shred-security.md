# Multisig — Security Audit Report

**Prepared by:** Shred Security
**Security Researchers:** kenzo · yashar
**Date:** 11 Jul 2026
**Status on the cover page: `DRAFT`.**

---

## About this file

This is a faithful reproduction of the Shred Security report, with the
maintainers' responses added. The delivered PDF is the authoritative source and
is byte-identical in all three places it is published:

| Where | |
|---|---|
| In this repo | [`Multisig-Shred-Audit-07-2026.pdf`](Multisig-Shred-Audit-07-2026.pdf) |
| Hosted | <https://audit.multisig.wei.limo> |
| IPFS | `bafybeiasw6shnkhfiux4seg35mvc7p7mbwk2bjpxglivikso6e3r3szmuq` |

    sha256  9346de4bdca6e0d00b6dc3715daaf869ed29b7a2870721b2a6c018e5e91104fe
    bytes   4176364

Everything outside a **▸ Response** block is the auditor's text, reproduced as
written. Every **▸ Response** block is ours and was not part of the delivered
report. Layout-only elements (page furniture, table of contents) are omitted;
all prose, tables, code blocks, figures and section structure are preserved. The
cover page is a raster image and does not extract as text — the four facts it
carries are transcribed in the header above, including the `DRAFT` stamp.

**Our overall position: no redeployment.** The factory, the `Multisig`
implementation and the `TimelockExecutor` are immutable singletons already
deployed at mined addresses across every supported chain, with live wallets
holding funds. Nothing in this report is severe enough to justify redeploying
them and migrating those wallets, and none of the four findings can be reached
without a client building the transaction that triggers it. All four are
addressed in the dapp and in documentation instead. Dispositions are tracked in
[`SECURITY.md`](../SECURITY.md).

| ID | Severity | Auditor status | Our disposition | Contract change |
|---|---|---|---|---|
| L-1 | Low | Open | Acknowledged — mitigated dapp-side + documented | None |
| L-2 | Low | Open | Acknowledged — mitigated dapp-side + documented | None |
| I-1 | Informational | Open | Acknowledged — mitigated dapp-side | None |
| I-2 | Informational | Open | Accepted as intended design | None |
| Appendix A | — | Partial compliance | Client-reachable gaps closed; operational gaps remain open | None |
| Appendix B | — | 0 bugs found | Noted; scope exclusions recorded | None |

---

## About Shred Security

Shred Security provides high quality security audits for blockchain and DeFi
protocols across different chains. Our audits consistently uncover high-impact
vulnerabilities missed by others, backed by a proven track record of top
competition placements and security partnerships with leading protocols.

We also develop open security resources for the broader ecosystem. Our Protocol
Deployment Checklist defines baseline deployment-readiness requirements for
smart contract protocols, and our Incident Response Checklist provides a
structured framework for protocol incident response from alert to safe harbor.
HackViz is an interactive platform to learn from, simulate, and visualize past
exploits, helping teams build stronger intuition for real-world attack patterns.

Shred Security's mission is to raise the standard of on-chain security through
rigorous audits and practical, openly shared security tooling.

Learn more about us: shredsec.xyz

---

## Protocol Executive Summary

Multisig is a minimalist, gas-optimized multisignature wallet protocol for EVM
chains. It lets a configurable set of owners collectively authorize transactions
through an m-of-n threshold scheme, with authorization proven on-chain via
EIP-712 typed ECDSA signatures, pre-registered on-chain approvals, or a sender
bypass in which an owner submitting the transaction fills one signature slot
with their own `msg.sender`. The wallet additionally implements EIP-1271
(`isValidSignature`) so it can act as a smart-contract signer for external
protocols. Owners are stored as a sorted linked list, and every configuration
change — adding or removing owners, changing the threshold, delay, or executor,
and performing delegatecalls or batched calls — is gated to self-calls, so each
change must itself pass through the wallet's own signature flow.

Beyond simple execution, the wallet supports an optional timelock: when a
non-zero delay is configured, transactions are queued with an ETA and can only
be executed once the delay elapses (or cancelled by the wallet itself). An
optional executor address can bypass signature checks or chain execution across
nested wallets, enabling hierarchical multisig setups. Wallets are deployed
deterministically through the `MultisigFactory` using CREATE2 with minimal-proxy
(clone) bytecode. The CREATE2 salt must begin with either the zero address
(permissionless / relayer deploys) or the caller's address; only the
caller-bound form provides front-running protection, while the zero-prefix path
is an intentional open-deploy option that is not front-running protected. The
factory's `createWithCalls` path deploys with the factory as a temporary
executor to run post-deployment configuration calls that bypass signatures, then
hands off to the real executor as the final step. The contract also implements
the ERC-721 and ERC-1155 safe-transfer receiver callbacks so wallets can custody
NFTs.

---

## Disclaimer

A smart contract security review cannot guarantee the complete elimination of
vulnerabilities. The process is limited by time, available resources, and human
expertise, and is intended to identify as many potential issues as reasonably
possible. As such, no assurance can be given that all vulnerabilities will be
discovered, or that the reviewed smart contracts are entirely secure. To
strengthen security over time, follow-up audits, bug bounty programs, and
continuous on-chain monitoring are strongly recommended.

---

## Risk Classification

| Likelihood \ Impact | High | Medium | Low |
|---|---|---|---|
| **High** | High | High/Medium | Medium |
| **Medium** | High/Medium | Medium | Medium/Low |
| **Low** | Medium | Medium/Low | Low |

---

## Executive Summary

The shred security team has conducted the review for 4 days in total. In this
period of time, a total of 4 issues were found: 2 low and 2 informational. No
medium- or high-severity issues were identified.

### About the Project

| | |
|---|---|
| Project Name | Multisig Protocol |
| Repository | https://github.com/z0r0z/multisig |
| Contracts | `Multisig.sol` |
| Commit/PR | `2329339` |
| Type of Project | Multisignature Wallet |
| Lines of Code | ~300 |

### Audit Timeline

| | |
|---|---|
| Audit Start | 07/07/2026 |
| Audit End | 11/07/2026 |
| Report Published | *(blank in the delivered report)* |

### Vulnerability Summary

| Severity | Count | Fixed | Acknowledged |
|---|---|---|---|
| High Risk | 0 | 0 | 0 |
| Medium Risk | 0 | 0 | 0 |
| Low Risk | 2 | 0 | 0 |
| Informational | 2 | 0 | 0 |
| **Total** | **4** | **0** | **0** |

> **▸ Response — maintainers.** The `Fixed 0 / Acknowledged 0` column reflects
> the state at delivery, before we had responded. Our position now is: **0
> fixed in-contract, 4 acknowledged.** L-1, L-2 and I-1 are mitigated in the
> dapp and documented; I-2 is accepted as intended design. No contract was
> changed and none will be redeployed for these findings.

---

## Findings Summary

| Issue ID | Description | Severity | Status |
|---|---|---|---|
| L-1 | Self-referential executor at vanity address causes permanent DoS | Low | Open |
| L-2 | Constructors payable with no ETH recovery | Low | Open |
| I-1 | `NotReady(0)` conflates "not queued" and "too early" | Informational | Open |
| I-2 | `execute` re-computes `DOMAIN_SEPARATOR` on every call | Informational | Open |

---

# Findings

## Low

### [L-1] Self-Referential Executor at Vanity Address Causes Permanent DoS

**Severity:** Low
**Affected Contracts:** `Multisig`
**Affected Functions:** `execute()`, `executeQueued()`, `setExecutor()`

#### Summary

If a wallet is deployed at a vanity address matching the guard bit pattern
(`0x1111` prefix or suffix) and owners later set `executor = address(this)`,
every `execute` and `executeQueued` call recurses through the guard hook into
itself until the transaction reverts. The wallet becomes permanently unusable.

#### Technical Details

Guard hooks invoke `Multisig(payable(_executor)).execute(...)` when vanity bits
match:

```solidity
if (uint160(_executor) >> 144 == 0x1111)
    Multisig(payable(_executor)).execute(target, value, data, sigs);
// ...
if ((uint160(_executor) & 0xFFFF) == 0x1111) {
    Multisig(payable(_executor)).execute(target, value, data, sigs);
}
```

When `executor == address(this)` and the wallet address satisfies either
pattern, each `execute` re-enters itself via the pre- or post-hook. Recovery via
`setExecutor` is also blocked, since that path requires a successful `execute`.

#### Impact

Permanent denial of service for the affected wallet. Funds already deposited
remain locked (no theft). Requires deliberate misconfiguration: vanity
CREATE2/EIP-7702 address plus a signed `setExecutor(address(this))`. Clone
wallets cannot recover; EIP-7702 deployments may recover by revoking delegation.

#### Recommendation

Reject self-referential executors in `setExecutor`:

```solidity
function setExecutor(address _executor) public payable onlySelf {
    require(_executor != address(this), InvalidConfig());
    emit ChangedExecutor(executor = _executor);
}
```

Alternatively, skip guard hooks when `_executor == address(this)`.

> #### ▸ Response — maintainers
>
> **Acknowledged. Not fixed in-contract; mitigated in the dapp and documented.**
>
> We accept the finding as written, including the severity. We are not
> redeploying for it: the report itself notes the DoS "requires deliberate
> misconfiguration", and the two ingredients — a wallet at a `0x1111`-marked
> address, and a threshold-signed `setExecutor(address(this))` — both have to be
> produced by a client. That makes it reachable only through a wallet
> interface, which is where we have put the guard.
>
> **Why it is largely unreachable from our own client.** The dapp's CREATE2 salt
> miner (`mineVanitySalt`) searches for a `0x00` address prefix and returns only
> on a match, so a wallet deployed from the dapp can never carry the `0x1111`
> marker in its high bits. The exposed population is wallets imported by address
> and EIP-7702 delegations — and the report already notes EIP-7702 can recover
> by revoking delegation.
>
> **Mitigations shipped** (`dapp/index.html`):
>
> 1. `executorRisk(next, vault)` classifies a proposed executor as `lock` (the
>    vault itself, at a marked address — the exact finding), `self` (the vault
>    itself, unmarked), or `hook` (a distinct address carrying the marker).
> 2. `prodAdminPropose('setExecutor')` **refuses to raise the proposal at all**
>    for `lock` and `self`. This implements the auditor's recommended
>    `require(_executor != address(this))` at the only layer we control. A
>    co-signer is never shown this proposal, because by the time it executed
>    nothing could undo it.
> 3. `txKind()` — the proposal classifier — independently re-derives the verdict
>    **from the calldata**, not from anything the dapp recorded. A `lock`
>    proposal renders as `SET EXECUTOR · LOCKS VAULT` in danger tone, opening
>    with "DO NOT SIGN". This is the layer that matters: it catches a proposal
>    raised by any other tool and brought to one of our users for a second
>    signature.
> 4. A distinct guard-hook executor (`hook`) is a legitimate pattern — it is the
>    blocklist/veto design documented in `README.md` — so it is permitted, but
>    requires a second confirming press and is labelled
>    `SET EXECUTOR · GUARD HOOK`.
>
> **Documented** in `README.md` (beside the existing guard-mode bricking
> warning) and `SECURITY.md`.
>
> **Residual risk we accept.** An owner set that signs
> `setExecutor(address(this))` at a marked address using tooling other than this
> dapp still bricks its wallet. That is unreachable from our client and
> unfixable without a redeployment. If `Multisig.sol` is ever redeployed for
> unrelated reasons, we will apply the auditor's fix verbatim.

### [L-2] Constructors Payable With No ETH Recovery

**Severity:** Low
**Affected Contracts:** `Multisig`, `MultisigFactory`
**Affected Functions:** `constructor()`

#### Summary

Both `Multisig` and `MultisigFactory` constructors are declared `payable` but
neither contract exposes a withdrawal path for ETH sent during deployment.

#### Technical Details

```solidity
constructor() payable {} // Multisig (implementation)
constructor() payable {} // MultisigFactory
```

The factory implementation is never initialized and holds no owner-controlled
recovery function. ETH sent to either constructor address is permanently locked.

#### Impact

No exploit on normal deployments. Accidental ETH sent to the factory or
unreachable implementation contract is unrecoverable. `payable` saves roughly 24
gas at deploy time.

#### Recommendation

Remove `payable` from constructors if deployment scripts do not require it.
Otherwise document that ETH sent to the factory or implementation is permanently
locked.

> #### ▸ Response — maintainers
>
> **Acknowledged. We take the second half of the recommendation: `payable`
> stays, and the consequence is now documented — plus enforced client-side.**
>
> Removing `payable` would require redeploying both singletons and would
> invalidate every mined vanity address, every documented deployment address,
> and the CREATE2 address of every existing wallet. That is not a trade we will
> make for ~24 gas and an accident-only failure mode. The auditor's alternative
> is explicit, and we have done it — in three places rather than one.
>
> **Documented** as a warning block in `README.md` (§ Deployments), in
> `SECURITY.md`, and in the dapp's in-app docs page:
>
> > ETH or tokens sent directly to `MultisigFactory`
> > (`0x000000000e8CB9ed9DC2114d79d9215eacb9cB07`) or to the `Multisig`
> > implementation (`0xD54cb65224410F3Ff97a8E72f363f224419f4FB0`) are
> > unrecoverable by anyone, including the deployer.
>
> We also state the boundary explicitly, because it is easy to misread the
> finding as covering deployment value: ETH passed to `create()` /
> `createWithCalls()` is **not** affected — the factory forwards `callvalue()`
> into the CREATE2 as the new wallet's opening balance.
>
> **Mitigation beyond documentation** (`dapp/index.html`): `lockedDest()` treats
> the factory, the implementation, `address(0)` and the owner-list sentinel
> (`address(1)`) as destinations with no withdrawal path. The dapp **refuses to
> build** any transaction sending value to one — checked in the transfer flow
> (which covers ERC-20 recipients too, since the factory cannot move a token
> balance either), the custom-call builder, and every leg of a batch. An inbound
> proposal doing the same is classified `UNRECOVERABLE` in danger tone by
> `txKind()`.
>
> We extended the address set past the two the finding names because the failure
> mode is identical and the marginal cost was zero. The two audited addresses
> are the realistic paste targets: both are printed in our UI and on every
> deploy receipt.

---

## Informational

### [I-1] `NotReady(0)` Conflates "Not Queued" and "Too Early"

**Severity:** Informational
**Affected Contracts:** `Multisig`
**Affected Functions:** `executeQueued()`

#### Summary

`executeQueued` uses a single `NotReady(eta)` error for both "hash was never
queued" and "hash is queued but timelock has not elapsed," making it impossible
for callers to distinguish failure modes from revert data alone.

#### Technical Details

```solidity
uint256 eta = queued[hash];
require(eta != 0 && (msg.sender == address(this) || block.timestamp >= eta), NotReady(eta));
```

When `queued[hash] == 0` (unknown hash, wrong nonce, or cancelled entry), the
revert carries `NotReady(0)`. When the hash is queued but
`block.timestamp < eta`, the revert carries `NotReady(futureEta)`. Both cases
share the same error selector.

#### Impact

UX and integrator ergonomics only. Frontends and relayers cannot produce
accurate error messages without additional off-chain state lookups. No fund loss
or authorization bypass.

#### Recommendation

Split into distinct errors:

```solidity
error NotQueued();
error NotReady(uint256 eta);

if (eta == 0) revert NotQueued();
if (msg.sender != address(this) && block.timestamp < eta) revert NotReady(eta);
```

> #### ▸ Response — maintainers
>
> **Acknowledged. Not fixed in-contract; resolved entirely in the frontend,
> which is where the finding's stated impact lands.**
>
> The finding scopes its own impact to "frontends and relayers cannot produce
> accurate error messages without additional off-chain state lookups." We agree
> — and note that no off-chain lookup is actually required, because the contract
> already distinguishes the two cases **in the revert data**: the `eta` argument
> is `0` in one case and a future timestamp in the other. The information is
> present; only the decoding was missing. That makes this fixable client-side
> with no contract change.
>
> **Mitigation shipped** (`dapp/index.html`): the four custom errors
> (`InvalidSig`, `Unauthorized`, `InvalidConfig`, `NotReady`) are now carried in
> `MULTISIG_ABI`, and `decodeMultisigError()` splits the two cases:
>
> | Revert data | Message shown |
> |---|---|
> | `NotReady(0)` | `NOT QUEUED — NO SUCH ENTRY IN THE VAULT'S QUEUE. IT WAS CANCELLED, ALREADY EXECUTED, OR CARRIES A DIFFERENT NONCE.` |
> | `NotReady(eta)` | `TIMELOCK NOT ELAPSED — <remaining> LEFT` |
>
> It is wired through every path that can surface the error — execute, fast
> execute, accelerate, submit, cancel, reject, approve, revoke — and through
> `_revertReason()`, so the transaction simulation panel reports it too rather
> than showing a bare "execution reverted". `Unauthorized`, `InvalidSig` and
> `InvalidConfig` are decoded alongside it, since the same undecoded-blob
> problem applied to all four.
>
> **Verified** by round-tripping both cases through `encodeErrorResult`,
> including the nested `data` shapes that different providers use.
>
> If `Multisig.sol` is ever redeployed, we will adopt the auditor's `NotQueued()`
> split — it is strictly better on-chain, and it would let integrators who are
> not using our client distinguish the cases without carrying our ABI.

### [I-2] `execute` Re-Computes `DOMAIN_SEPARATOR` on Every Call

**Severity:** Informational
**Affected Contracts:** `Multisig`
**Affected Functions:** `DOMAIN_SEPARATOR()`, `getTransactionHash()`,
`execute()`, `isValidSignature()`, `executeQueued()`

#### Summary

The EIP-712 domain separator is recomputed via `keccak256(abi.encode(...))` on
every call rather than cached at initialization, adding unnecessary gas on the
hot execution path.

#### Technical Details

```solidity
function DOMAIN_SEPARATOR() public view returns (bytes32) {
    return keccak256(
        abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Multisig"),
            keccak256("1"),
            block.chainid,
            address(this)
        )
    );
}
```

`getTransactionHash()` calls `DOMAIN_SEPARATOR()` on every `execute` and
`executeQueued`. For a static wallet where `chainId` and `address(this)` are
fixed, this is redundant work (~500–800 gas per call). OpenZeppelin's `EIP712`
caches the separator in immutables; that pattern is not a drop-in fit for
CREATE2 clones initialized via `init()`.

#### Impact

Gas cost only. Correctness is unaffected — the live `block.chainid` read is
fork-safe. `view` calls (`eth_call` for signing) do not cost the caller on-chain
gas.

#### Recommendation

Cache the domain separator in `init()` with fork-aware logic (recompute when
`block.chainid` changes), or document the tradeoff as an intentional
minimal-design.

> #### ▸ Response — maintainers
>
> **Acknowledged. We take the second option: this is intentional minimal design,
> and it is now documented as such.**
>
> This is the one finding where we think the current code is not merely
> acceptable but preferable. The auditor's own impact statement notes the live
> `block.chainid` read "is fork-safe" — that is not an incidental property, it is
> the point. Recomputing from `block.chainid` on every call makes fork safety
> structural: there is no cached value that can go stale, and therefore no
> fork-awareness branch that can be wrong.
>
> The alternative costs a clone storage slot plus a comparison on every call to
> save ~500–800 gas, and — as the auditor notes — the OpenZeppelin immutable
> pattern "is not a drop-in fit for CREATE2 clones initialized via `init()`",
> since immutables are fixed in the implementation's bytecode and shared by every
> clone. The fork-aware variant would have to reimplement that logic in storage,
> which is more code on the most security-sensitive path in the contract.
>
> `view` calls used for signing cost the caller nothing, so the entire cost is
> the on-chain execution path.
>
> **Recorded** in `SECURITY.md` under the disposition table. No contract change,
> no dapp change — there is nothing for a client to mitigate.

---

# Appendix

## Appendix A: Deployment Checklist Compliance

We compare every protocol's deployment against our published Protocol Deployment
Checklist.

**Verdict: Partially followed — not fully compliant end-to-end.**

The project meets most design, audit, and on-chain requirements, but several
deployment-process and operational checklist items are missing or only partially
done. It is not safe to call the checklist "fully followed" as written.

### What is followed

**Pre-deployment (strong)**

- **Audits:** Independent audits exist (`audit/report-multisig.md`,
  `audit/report-mods.md`, etc.) — BLOCKER met.
- **Threat model:** `SECURITY.md` covers deployment risks, trust assumptions,
  invariants — BLOCKER met.
- **Initialization:** One-shot `init()`, double-init tests, factory-only init —
  BLOCKER met.
- **CREATE2 / deterministic deploy:** Salts in `vanity_findings.md`,
  `VanityMiner`, dapp salt mining — BLOCKER met.
- **Multi-chain consistency:** Same addresses across supported chains via
  SafeSummoner — BLOCKER met.
- **MEV / frontrunning:** Documented (F-1); sender-bound salt mitigation exists —
  BLOCKER met (with documented tradeoff).
- **Privileged roles:** Owners, executor, EIP-7702 superuser documented —
  WARNING met.
- **No upgradeable proxy admin:** Correctly N/A for this architecture (immutable
  clones).

**Deployment tooling (adequate for singletons)**

- Vanity mining, browser deploy (`script/deploy.html`), dapp wallet deploy flow.
- Documented deployed addresses in `README.md`.
- `create()` / `createWithCalls()` atomically deploy + init.

**Testing (strong for unit/integration)**

- 280 Foundry tests (201 unit/integration + 33 module + 46 gas benchmarks, plus
  EIP-7702) covering init, factory, timelock, modules, EIP-7702, and fuzz.
- No CI workflow is present in the repository (`.github/workflows/` is absent);
  `forge test` is run manually.

### What is NOT followed (or only partial)

**BLOCKER gaps**

| Item | Status |
|---|---|
| Explorer verification on all chains | Not systematically evidenced in-repo (no per-chain verification log) |
| Bytecode matches audited build | No automated/reproducible verification step documented |
| Post-deploy on-chain validation | No on-chain validation scripts present in the repo |

**WARNING gaps (material)**

| Item | Status |
|---|---|
| Fork-based mainnet tests | No — only `vm.chainId()` simulation, no real fork tests |
| MEV deployment simulation | Partial — documented, not simulated |
| Deployment txs simulated in Tenderly/Foundry fork | No formal fork-based deploy simulation |
| State verified across multiple RPCs | Not automated |
| Monitoring / alerting for role changes | Not set up in repo (operator responsibility) |
| Secure backups / incident comms | Not documented as protocol-owned process |

**INFO / process gaps**

| Item | Status |
|---|---|
| Formal checklist with Yes/No/Evidence per item | Missing; compliance is implicit, not tracked |
| Deployment runbook | Deploy knowledge scattered across README, dapp, and vanity tooling — no single normative runbook |
| Emergency drills | Not scheduled |
| Stale docs (`CancelTx` in mdBook) | Minor hygiene gap |

### Section-by-section score

| Section | Followed? |
|---|---|
| 1.1 Architecture & upgradeability | Yes (with correct N/A for non-upgradeable design) |
| 1.2 Threat model & deployment risks | Mostly — recovery plan informal; MEV sim missing |
| 1.3 Audits & testing | Mostly — fork tests missing |
| 1.4 External assets | N/A (token-agnostic core) |
| 2.1 Deployment script sanity | Mostly — no single Foundry `Deploy.s.sol` |
| 2.2 Init controls | Yes |
| 2.3 Explorer verification | Partial — addresses listed, no per-chain evidence trail |
| 2.4 Admin & key management | Mostly — operator-side items not enforceable |
| 3.1 Post-deploy sanity | Partial — depends on manual `cast` checks |
| 3.2 Smoke tests | Manual — not scripted in original repo |
| 3.3 Monitoring | No |
| 3.4 Incident response | Partial — recovery logic in code/docs, no formal runbook |

### Bottom line

**For already-deployed singleton contracts (factory, implementation,
TimelockExecutor):** the technical and security foundations are solid — audited,
tested, deterministic, correctly initialized.

**For the checklist as a complete deployment discipline:** not fully followed.
The main gaps are:

1. No fork-based mainnet tests
2. No systematic post-deploy verification trail
3. No monitoring/alerting setup
4. No formal checklist tracking with evidence per item
5. Operational items (backups, incident comms, multi-RPC verification) left to
   operators

**Practical rating: ~70–75% compliant** — strong on smart-contract readiness,
weak on operational deployment governance.

> ### ▸ Response — maintainers
>
> **Accepted without dispute.** We agree with the verdict and the rating. The
> singletons are deployed and immutable, so nothing here is a redeployment
> question; it is a question of what a client and a repository can prove.
>
> We split the gaps into the ones a wallet client can close and the ones it
> cannot, and closed the first set.
>
> **Closed — all three BLOCKER gaps, at the client layer** (`dapp/index.html`):
>
> | Gap | What now happens |
> |---|---|
> | Bytecode matches audited build | Every wallet the factory produces is the same 45-byte clone delegating to `IMPLEMENTATION`. `expectedCloneCode()` derives that runtime exactly (the initcode minus its 9-byte deploy prefix; the `0x2d` length byte in the factory's own assembly confirms 45 bytes), and `classifyVaultCode()` compares the on-chain code against it, returning `clone`, `7702`, `foreign`, `empty`, or `null` when the chain will not answer. |
> | Post-deploy on-chain validation | `deployOnChain` no longer treats a mined receipt as a deployment. It reads the code back and rejects `empty` ("NO CODE AT ADDRESS") and `foreign` ("CODE AT ADDRESS IS NOT THE AUDITED BUILD"), then reads the wallet's owners, threshold, delay and executor back via `vaultMatchesCtx` and rejects a mismatch. A chain that will not answer is reported `DEPLOYED · UNVERIFIED` rather than being counted as verified. |
> | Explorer verification on all chains | Not a per-chain log, but the substantive check it stands for now runs automatically: deploy preflight calls `MultisigFactory.implementation()` on **every target chain** and refuses to treat an address holding other code as the factory (`UNKNOWN FACTORY`). Code-presence alone proved nothing. |
>
> We also applied the bytecode check beyond deployment: **every wallet load**
> runs `classifyVaultCode()` and badges anything that is not the audited build as
> `UNVERIFIED CODE`. This matters because a wallet can arrive from a pasted
> address, where answering `threshold()` and `getOwners()` proves only that
> something implements the shape.
>
> The audited runtime is published in `README.md` so anyone can check an address
> without our client:
>
> ```
> 0x5f5f365f5f37365f73D54cb65224410F3Ff97a8E72f363f224419f4FB05af43d5f5f3e6029573d5ffd5b3d5ff3
> ```
>
> **Partially addressed:** "State verified across multiple RPCs" — the dapp's
> salt miner already dedup-checks a candidate address against every chain a
> deploy targets, and `makeProvider` rotates across multiple RPC endpoints per
> chain. This is not the systematic multi-RPC state verification the checklist
> asks for, and we do not claim it as closed.
>
> **Open, and acknowledged as open:** fork-based mainnet tests, MEV deployment
> simulation, fork-based deploy simulation, CI (`.github/workflows/` is still
> absent), monitoring and alerting for role changes, secure backups and incident
> comms, formal checklist tracking with per-item evidence, a normative deployment
> runbook, and emergency drills. These are repository and operational
> commitments, not client-reachable, and we have not done them. They are recorded
> as still-open in `SECURITY.md` rather than presented as resolved.

## Appendix B: Stateful Invariant Fuzzing Report

### Objective

Complement the existing unit/integration suite with stateful invariant fuzzing
to stress the core multisig state machine under random sequences of owner
management, execution, approvals, and timelock operations.

### Methodology

A `MultisigHandler` contract drives random call sequences against a deployed
wallet (3 owners, threshold 2, no executor). The fuzzer selects from 12 handler
actions per run. After every call, 10 global invariants are checked against
on-chain state.

Configuration (`foundry.toml`):

| Parameter | Value |
|---|---|
| `runs` | 512 |
| `depth` | 64 |
| `fail_on_revert` | false |

Effective coverage per invariant: ~32,768 handler calls (512 × 64).

### Invariants Tested

Mapped to the Key Invariants in `SECURITY.md`:

| ID | Invariant | Description |
|---|---|---|
| INV-1 | Init one-shot | `threshold > 0` at all times |
| INV-2 | Owner linked list | `ownerCount == getOwners().length`; no duplicates; no SENTINEL owner |
| INV-3 | Nonce monotonicity | `nonce` never decreases |
| INV-4 | Queued hash latch | Handler-tracked pending hashes remain latched in `queued[hash]` |
| INV-5 | Threshold bounds | `0 < threshold <= ownerCount` |
| INV-6 | Immutable implementation | Factory implementation address unchanged |
| INV-7 | Storage packing | Packed fields (`delay`, `nonce`, `threshold`, `ownerCount`) internally consistent |
| INV-8 | `isOwner` consistency | Every `getOwners()` entry passes `isOwner()` |
| INV-9 | Cleared latch hygiene | Ghost-cleared hashes have `queued[h] == 0` |
| INV-10 | Balance sanity | Wallet balance stays bounded |

### Handler Actions

| Action | Exercises |
|---|---|
| `executeTransfer` | Signed ETH transfer (immediate execution) |
| `fundWallet` | Refill wallet balance |
| `addOwner` | Self-call via `execute` |
| `removeOwner` | Self-call with correct `prevOwner` |
| `setThreshold` | Threshold change within bounds |
| `setDelay` | Timelock enable/adjust |
| `approveHash` | On-chain approval by random owner |
| `executeWithApprovals` | `v=0` approval slots |
| `queueTransfer` | Timelock queue path |
| `warpExecuteQueued` | ETA expiry + `executeQueued` |
| `cancelQueued` | Self-call `cancelQueued` |
| `executeQueuedViaSelf` | Self-call wrapped `executeQueued` |

### Results

| Metric | Result |
|---|---|
| Invariant tests | 10 / 10 passed |
| Fuzz runs per invariant | 512 |
| Calls per invariant | 32,768 |
| Handler reverts (expected) | ~3,700–4,500 per invariant (invalid action preconditions) |
| Contract bugs found | 0 |

All invariants held across the full fuzz campaign. No violations of owner-list
integrity, nonce monotonicity, threshold bounds, or queued-hash latch semantics
were observed.

### Handler note

During setup, `invariant_queuedLatchConsistent` failed once due to stale
pending-entry tracking in the handler after nested timelock paths (`setDelay` →
`queueTransfer` → `executeQueuedViaSelf` → `warpExecuteQueued`). This was
corrected by adding `_prunePending()` to the handler. **This was a test-harness
issue, not a contract defect.**

### Out of Scope

The following were intentionally excluded from the handler and should not be
inferred as tested:

- Invalid or malformed signatures (handler only submits valid signatures)
- Executor bypass and guardian hooks (`0x1111` vanity address pattern)
- EIP-7702 EOA delegation and EOA superuser semantics
- Module contracts (`AllowlistGuard`, `TimelockExecutor`, etc.)
- `MultisigFactory` / `createWithCalls` deployment paths
- Reentrancy via malicious call targets
- Cross-chain or cross-wallet replay

These areas remain covered by the existing unit/integration suite and prior
manual review passes.

### Conclusion

Stateful invariant fuzzing found no issues in the core `Multisig` state machine
under the tested operation sequences. The contract maintains its documented
invariants across random interleavings of owner management, signed execution,
on-chain approvals, and timelock queue/execute/cancel flows.

> ### ▸ Response — maintainers
>
> **Noted; no action required.** 10/10 invariants held across ~327,680 handler
> calls with 0 contract bugs, and the one failure encountered was traced to the
> test harness and fixed there.
>
> We record the scope exclusions rather than let the clean result be read as
> broader than it is. Two of them intersect directly with findings in this same
> report and were therefore **not** covered by the fuzzing:
>
> - **Executor bypass and guardian hooks (`0x1111` pattern)** — excluded, and
>   this is precisely the mechanism behind L-1. The clean fuzzing result says
>   nothing about that path.
> - **`MultisigFactory` / `createWithCalls` deployment paths** — excluded, and
>   the factory is one of the two contracts in L-2.
>
> Also uncovered here: malformed signatures, EIP-7702 semantics, the module
> contracts, reentrancy via malicious targets, and cross-chain replay. Per the
> auditor, these remain covered by the existing 280-test Foundry suite and prior
> manual review (`audit/report-multisig.md`, `audit/report-mods.md`,
> `audit/report-timelock-executor.md`, `audit/nemesis-verified.md`).
>
> This exclusion list is also our reason for treating L-1's mitigation as a
> client-layer obligation rather than something the test suite already covers.
