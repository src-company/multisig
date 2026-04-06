# TimelockExecutor
[Git Source](https://github.com/z0r0z/multisig/blob/7a81a30eb63788e9eea9c0790c2db6cfb7f435dd/src/mods/TimelockExecutor.sol)

Executor module for timelock management via off-chain signatures.
Uses the multisig's own EIP-712 Execute typehash — the same signatures
collected for normal execute work here. The UI routes based on count:
- All owners signed -> forward() for immediate execution (opt-in)
- Threshold signed + cancel selector -> forward() for immediate cancel
- Threshold signed otherwise -> Multisig.execute() (queues with timelock)
Already-queued txs can be accelerated by forwarding a self-call to
executeQueued — the multisig skips the ETA check for self-calls.
Singleton — one deployment serves all multisigs.
WARNING: Do NOT deploy at a vanity `0x1111` address (pre/post guard).
The Multisig hook call would hit this contract and revert.


## State Variables
### forwardEnabled

```solidity
mapping(address multisig => bool) public forwardEnabled
```


## Functions
### constructor


```solidity
constructor() payable;
```

### enableForward


```solidity
function enableForward(bool enabled) public;
```

### forward

Verify owner signatures and execute immediately via executor bypass.
Cancel (target=multisig, selector=cancelQueued) requires threshold sigs
and is always available. All other calls require all-owner sigs (unanimous)
and forwardEnabled — the timelock is a security boundary that should only
be bypassable when the multisig explicitly opts in.
Supports both ECDSA (v>0) and onchain approvals (v=0, sender or pre-approved).


```solidity
function forward(address multisig, address target, uint256 value, bytes calldata data, bytes calldata sigs) public;
```

## Events
### ForwardEnabled

```solidity
event ForwardEnabled(address indexed multisig, bool enabled);
```

### Forwarded

```solidity
event Forwarded(address indexed multisig, bytes32 indexed hash);
```

## Errors
### InvalidSig

```solidity
error InvalidSig();
```

### Unauthorized

```solidity
error Unauthorized();
```

