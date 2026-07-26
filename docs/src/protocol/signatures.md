# Signatures

## The digest

Authorisation is an EIP-712 typed-data signature over one struct:

```solidity
Execute(address target,uint256 value,bytes data,uint32 nonce)
```

in a domain of:

```solidity
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
//   name = "Multisig", version = "1", verifyingContract = the wallet
```

`getTransactionHash(target, value, data, nonce)` returns exactly that digest, and
is the function to call for anything that needs to sign, pre-approve or verify.
Because the domain carries the live `chainId` and the wallet's own address,
a bundle collected for one wallet is worthless against any other wallet, and
worthless on any other chain.

The `nonce` is a `uint32` read from the packed slot and consumed by every
`execute` call, whether that call executes or merely queues. It is strictly
sequential: there is no per-proposal identifier, so exactly one proposal can be
outstanding at each nonce and signatures for nonce *n* die the moment the wallet
moves past *n*.

## The bundle format

`sigs` is a flat byte string of fixed 65-byte slots — `r[32] || s[32] || v[1]` —
one per required signature, **sorted ascending by signer address**. The wallet
requires the length to be exactly `threshold * 65`; a bundle with a spare slot is
rejected, not truncated. Ascending order is what makes duplicate-signature attacks
impossible without a set: each recovered signer must be strictly greater than the
last.

Three ways to fill a slot:

| `v`      | Type                 | How the slot is satisfied                                                          |
|----------|----------------------|------------------------------------------------------------------------------------|
| `27`/`28` | **ECDSA**           | `ecrecover` over the digest recovers the signer.                                   |
| `0`      | **On-chain approval** | `r` holds the signer's address, left-padded. The owner called `approve(hash, true)` beforehand. |
| `0`      | **Sender bypass**     | `r` holds the signer's address. Satisfied because `msg.sender` *is* that owner — no prior `approve`. |

The two `v = 0` forms are the same branch in the code:

```solidity
require(msg.sender == signer || approved[signer][hash], InvalidSig());
```

Any non-zero `v` takes the `ecrecover` branch, so values other than 27/28 do not
error early — they recover to `address(0)` or to garbage and are then rejected by
the owner check. The effective rule is: `v = 0` means "this slot is an address",
anything else means "this slot is a signature".

## The sender bypass

Because the submitter's own slot needs no signature, a k-of-n wallet only ever
collects **k − 1** off-chain signatures: the last owner submits, and their
`msg.sender` fills the final slot. A 2-of-2 needs exactly one signature.

This has a second, less obvious use. A sender slot is the only slot in a bundle
that a third party cannot fill, so spending one slot on the submitter **binds the
whole bundle to that submitter** — a copy of it is inert in anyone else's hands.
That is the mitigation for route substitution; see
[Security](security.md#route-substitution).

## On-chain approval

```solidity
approve(bytes32 hash, bool ok)   // owners only
```

`approve` registers authorisation in the wallet's own storage instead of producing
a signature. It costs gas and is world-readable, and both of those are the point
in some cases and the problem in others:

- It is the **only** route available to an owner that cannot produce an ECDSA
  signature — a DAO, a contract, another multisig.
- It is the only route that needs **no coordination service at all**. A wallet
  whose owners approve on-chain keeps working if the interface, its database and
  its operator all disappear.
- But being world-readable means the slot it fills can be assembled by anyone,
  which gives up the submitter binding above.

The two properties are not mutually exclusive: have every owner *but one* approve
on-chain, and let the remaining owner submit without approving. Their slot stays
sender-only, so a copier is left one signature short, and no coordination service
was needed to get there.

`approve(hash, false)` revokes. Since an approved hash commits to a specific nonce
and both execution routes compute against the live one, **an approval becomes
permanently unreachable the moment the nonce passes it**. Stale approvals for
consumed nonces are inert; only approvals made for a nonce the wallet has not yet
reached are worth revoking.

One accepted sharp edge: approvals are keyed by address and are never cleared, so
removing an owner neutralises their approvals but **re-adding the same address
restores them**. An address removed because it was compromised must never be
re-added, even after rotating the key behind it.

## ERC-1271 contract signatures

```solidity
isValidSignature(bytes32 hash, bytes calldata sigs) returns (bytes4)
```

This lets the wallet act as a smart account wherever a signed order is accepted —
Permit2, Seaport, intent systems. It wraps the caller's hash in a distinct
typehash before verifying:

```solidity
SafeMessage(bytes32 hash)
```

so a message signature can never be replayed as a transaction, or the reverse.

Two differences from `execute` that matter in practice:

- **No sender bypass.** `isValidSignature` is a `view` function called by a third
  party, so `msg.sender` is not an owner. Only ECDSA signatures and pre-registered
  approvals count.
- **On-chain approval targets the wrapped digest.** An owner approving a message
  for ERC-1271 must approve the `SafeMessage` digest, not the raw hash they were
  handed.

Note also that **message signing is not subject to the timelock.** A delay
constrains `execute`; it does not constrain `isValidSignature`. Anything
expressible as a signed order is authorised instantly with threshold signatures on
any wallet, however long the delay. That is worth knowing before assuming the
delay gates every outflow.
