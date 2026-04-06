# NEMESIS Audit -- Verified Findings

**Target:** router/multisig (Multisig.sol, modules, dapp)
**Date:** 2026-04-06
**Methodology:** Feynman first-principles + State Inconsistency cross-check

---

## Verification Summary

| ID | Title | Pass | Original Sev | Verdict | Final Sev |
|----|-------|------|-------------|---------|-----------|
| N-001 | SocialRecovery delay=0 instant takeover | Feynman | HIGH | TRUE POSITIVE | **HIGH** |
| N-002 | Single guardian overrides all proposals | Feynman | HIGH | TRUE POSITIVE | **HIGH** |
| N-003 | TimelockExecutor nonce race (same-block) | Cross-feed F->S | HIGH | TRUE POSITIVE (limited) | **MEDIUM** |
| N-004 | SpendingAllowance period=0 voids limits | Feynman | MEDIUM | TRUE POSITIVE | **MEDIUM** |
| N-005 | init() allows address(this) as owner | Feynman | MEDIUM | TRUE POSITIVE (low risk) | **LOW** |
| N-006 | Stale approvals after removeOwner | State | LOW | TRUE POSITIVE (no exploit) | **LOW** |
| N-007 | delegateCall can break any invariant | State | LOW | BY DESIGN | **INFORMATIONAL** |
| N-008 | Module execute() consumes nonces | State | LOW | BY DESIGN | **INFORMATIONAL** |

**Final: 0 CRITICAL | 2 HIGH | 2 MEDIUM | 2 LOW | 2 INFORMATIONAL**

---

## Verified Findings

### N-001: SocialRecovery delay=0 allows instant guardian takeover

**Severity:** HIGH
**Discovery:** Feynman-only (Pass 1)
**File:** `src/mods/SocialRecovery.sol:42-43`

**Coupled Pair:** `delay[multisig]` <-> security window for recovery

**Issue:** `delay[multisig]` defaults to 0. If a multisig sets SocialRecovery as executor and configures guardians but neglects `setDelay()`, any guardian can `propose()` + `finalize()` in a single transaction. Since the module is the executor, `Multisig.execute()` bypasses signature verification entirely.

**Trigger Sequence:**
1. Multisig calls `setGuardian(guardianAddr, true)` but omits `setDelay()`
2. Guardian calls `propose(multisig, multisig, 0, batchData)` where `batchData` rotates all owners
3. Guardian calls `finalize()` in the same transaction (ETA = block.timestamp, immediately ready)
4. All owners replaced -- full takeover

**Fix:**
```solidity
function setGuardian(address guardian, bool active) public {
    require(delay[msg.sender] != 0, "delay must be set first");
    // ...
}
```
Or enforce a minimum delay in `setDelay()`.

---

### N-002: Single guardian can block/override all recovery proposals

**Severity:** HIGH
**Discovery:** Feynman-only (Pass 1)
**File:** `src/mods/SocialRecovery.sol:39`

**Issue:** Once an ETA passes without finalization, any guardian can call `propose()` to overwrite `pending[multisig]` with a new hash, resetting the clock. A single compromised guardian can indefinitely prevent legitimate recovery by overwriting the pending proposal whenever ETA expires.

**Trigger Sequence:**
1. Guardian A proposes legitimate recovery with delay=7 days
2. After 7 days, before anyone calls `finalize()`, compromised Guardian B calls `propose()` with junk data
3. Previous proposal is overwritten, new 7-day clock starts
4. Repeat indefinitely

**Fix:** Consider multi-guardian quorum for proposals, or per-guardian proposal slots, or a finalization window.

---

### N-003: TimelockExecutor nonce race on same-block execution

**Severity:** MEDIUM
**Discovery:** Cross-feed Feynman -> State (Pass 1 -> Pass 2)
**File:** `src/mods/TimelockExecutor.sol:49` + `src/Multisig.sol:136`

**Coupled Pair:** `forward()` nonce read <-> `execute()` nonce increment

**Issue:** `forward()` reads `IMultisig(multisig).nonce()` (= N), verifies signatures for hash(N), then calls `execute()`. If a separate `execute()` call front-runs in the same block, nonce increments to N+1. The `forward()` call's `execute()` then uses nonce N+1, storing `queued[hash(N+1)]` while signatures were for hash(N). The queued transaction becomes difficult to execute via `executeQueued()` since the dapp tracked nonce N.

**Mitigation:** Within a single transaction, this is atomic and safe. The issue only arises from same-block transaction ordering (front-running). Practical exploitation requires monitoring the mempool and submitting a competing transaction.

---

### N-004: SpendingAllowance period=0 voids spending limits

**Severity:** MEDIUM
**Discovery:** Feynman-only (Pass 1)
**File:** `src/mods/SpendingAllowance.sol:38`

**Issue:** If `period` is configured as 0, the condition `block.timestamp >= uint256(c.lastReset) + 0` is always true, resetting `spent` to 0 on every call. The spending limit becomes meaningless.

**Fix:**
```solidity
function configure(address _spender, uint128 _allowance, uint32 _period) public {
    require(_period != 0, "period must be nonzero");
    // ...
}
```

---

### N-005: init() allows address(this) as owner

**Severity:** LOW
**File:** `src/Multisig.sol:50-53`

The owner validation only checks `owner > prev` (starting from SENTINEL=address(1)). The multisig's own address could be included as an owner, enabling self-approval via the `approved` mapping. Requires intentional misconfiguration at deployment.

---

### N-006: Stale approvals persist after owner removal

**Severity:** LOW
**File:** `src/Multisig.sol:226-235`

`removeOwner()` does not clear `approved[removedOwner][...]`. Not exploitable because `execute()` checks `_owners[signer] != address(0)` which fails for removed owners. Storage waste only.

---

## Coupled State Dependency Map (Verified Correct)

| Coupled Pair | Invariant | All Paths Verified |
|---|---|---|
| `_owners` linked list <-> `ownerCount` | ownerCount == linked list length | init, addOwner, removeOwner |
| `threshold` <-> `ownerCount` | threshold <= ownerCount | init, removeOwner (checks), setThreshold (checks) |
| `nonce` <-> tx execution | +1 per execute() call | execute() only (not executeQueued) |
| `queued[hash]` <-> execution | set on queue, deleted on exec/cancel | execute, executeQueued, cancelQueued |
| SocialRecovery `pending` <-> `eta` | set/deleted together | propose, finalize, cancel |
| SpendingAllowance `spent` <-> `lastReset` | atomic reset when period elapses | spend() |
| DeadmanSwitch `lastActivity` <-> execution | post-guard updates on every exec | execute() + executeQueued() hooks |

---

## Core Contract Assessment

The **Multisig.sol** core contract and **TimelockExecutor** are well-engineered:
- Nonce management, EIP-712 hashing, and signature verification are correct
- Owner linked list invariants are maintained across all mutation paths
- The pre/post guard hook system (0x1111 vanity address pattern) is sound
- The `onlySelf` modifier correctly protects admin functions
- `createWithCalls` factory pattern properly sets and clears the temporary executor

The primary risk surface is in the **SocialRecovery module**, where configuration errors (missing delay, single-guardian trust) can be exploited. The **SpendingAllowance** module has a minor input validation gap.
