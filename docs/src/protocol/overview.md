# Protocol Overview

`src/Multisig.sol` is one file, 321 lines, holding two contracts: `Multisig`, the
wallet, and `MultisigFactory`, which clones it. There is no library, no proxy
admin, no fallback handler registry and no module list. Every feature the wallet
has — timelock, executor role, pre/post guards, batching, delegatecall, on-chain
approvals, ERC-1271 — is a function or a branch in that one file.

## The single storage slot

All mutable configuration lives in slot 0, and it fills the slot exactly:

| Field        | Type      | Bytes | Meaning                                             |
|--------------|-----------|-------|-----------------------------------------------------|
| `delay`      | `uint32`  | 4     | Timelock in seconds. `0` means execute immediately. |
| `nonce`      | `uint32`  | 4     | Sequential; incremented by every `execute` call.    |
| `threshold`  | `uint16`  | 2     | Signatures required.                                |
| `ownerCount` | `uint16`  | 2     | Current number of owners.                           |
| `executor`   | `address` | 20    | Optional bypass role. `address(0)` disables it.     |

That is 32 bytes, so the hot path reads the wallet's entire configuration with
one `SLOAD` and writes the nonce back with one `SSTORE`. It is the single
decision most of the [gas advantage](comparison.md) rests on.

Two values that look like state are not: `factory` is an immutable baked into the
bytecode at construction, and `SENTINEL` is the constant `address(1)`.

Three mappings sit outside the packed slot:

```solidity
mapping(address => address) _owners;                              // linked list
mapping(bytes32 txHash => uint256) public queued;                // hash -> ETA
mapping(address owner => mapping(bytes32 hash => bool)) approved; // on-chain approvals
```

## Owners as a linked list

`_owners` is a circular singly-linked list anchored at `SENTINEL`. Membership is
one `SLOAD`: an address is an owner when `_owners[account] != address(0)` and the
account is not the sentinel itself. `getOwners()` walks from the sentinel back
around to it.

`init` requires the owner array to be **strictly ascending**, which both rejects
duplicates and lets the list be built with one storage write per owner. After
initialisation the ordering is no longer maintained: `addOwner` splices the new
owner in directly after the sentinel, so the list is in insertion order from then
on. Sorting is only ever required in two places — the `init` array, and the
signature bundle passed to `execute` — and those two requirements are unrelated.

`removeOwner(prevOwner, owner)` takes the predecessor pointer, so the caller has
to supply the list position; it refuses to drop the count below `threshold`.

## Two deployment paths, one implementation

The same implementation bytecode serves both paths, and `init` is what makes that
work — it accepts a call from the factory **or** from the account itself:

```solidity
require(msg.sender == factory || msg.sender == address(this), Unauthorized());
```

The first branch is the factory clone; the second is an EOA that has delegated to
the implementation under EIP-7702 and is calling `init` on itself. See
[Deployment](deployment.md).

`init` is one-shot in either case: it requires `threshold == 0`, which is only
true before the first successful call.

## Execution paths

There are four ways a call leaves the wallet, and it is worth being precise about
which checks each one applies:

| Entry point                | Signatures                | Timelock                              | Notes                                                    |
|----------------------------|---------------------------|---------------------------------------|----------------------------------------------------------|
| `execute`, owner-signed    | `threshold` slots checked | Queues when `delay != 0`              | Increments the nonce whether it executes or queues       |
| `execute`, `msg.sender` is the executor | Skipped entirely | Skipped entirely           | Increments the nonce                                     |
| `executeQueued`            | None — the entry was already authorised | Enforced, except on self-calls | Permissionless once the ETA passes       |
| `delegateCall` / `batch`   | `onlySelf`                | Inherited from the outer `execute`    | Reachable only as `execute(address(this), ...)`          |

`batch` and `delegateCall` being `onlySelf` is what makes them composable: to
batch, the wallet proposes a transaction *to itself* carrying `batch` calldata,
and the whole batch inherits whatever authorisation and delay the outer `execute`
applied.

## Events and errors

Eight events cover every state change — `ChangedDelay`, `AddedOwner`,
`RemovedOwner`, `ChangedThreshold`, `ChangedExecutor`, `ExecutionSuccess`,
`Queued`, `Approved` — and four custom errors cover every revert: `InvalidSig`,
`Unauthorized`, `InvalidConfig`, `NotReady(eta)`.

Two encoding details matter to anything reading the chain:

- A cancellation is reported as `Queued(hash, 0, 0)`. There is no separate
  `Cancelled` event; an ETA of zero is the cancellation.
- `NotReady(eta)` carries the ETA, which is how a caller distinguishes "nothing
  is queued under this hash" (`eta == 0`) from "queued, but not yet mature"
  (`eta > block.timestamp`). The wallet uses one error for both; the payload is
  what separates them.

## Token callbacks

The fallback returns the expected magic value for `onERC721Received`,
`onERC1155Received` and `onERC1155BatchReceived`, so the wallet can hold NFTs
without any of those being real functions. `receive()` accepts plain ETH.

The same fallback returns success — not a revert — for every other unknown
selector. A self-call carrying a mistyped governance selector therefore burns a
nonce, emits `ExecutionSuccess`, and changes nothing. That is a real trap for
tooling and is [handled in the interface](../dapp/guardrails.md).
