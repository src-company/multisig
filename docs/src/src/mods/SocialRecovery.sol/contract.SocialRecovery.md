# SocialRecovery
[Git Source](https://github.com/z0r0z/multisig/blob/7a81a30eb63788e9eea9c0790c2db6cfb7f435dd/src/mods/SocialRecovery.sol)

Executor module for social recovery. Guardians propose an arbitrary
call (e.g. a batch that rotates owners), wait through a delay, then
finalize. Set as the multisig's executor to bypass owner signatures.
Singleton — one deployment serves all multisigs, keyed by msg.sender.


## State Variables
### isGuardian

```solidity
mapping(address multisig => mapping(address => bool)) public isGuardian
```


### delay

```solidity
mapping(address multisig => uint32) public delay
```


### pending

```solidity
mapping(address multisig => bytes32) public pending
```


### eta

```solidity
mapping(address multisig => uint256) public eta
```


## Functions
### constructor


```solidity
constructor() payable;
```

### setGuardian


```solidity
function setGuardian(address guardian, bool active) public;
```

### setDelay


```solidity
function setDelay(uint32 _delay) public;
```

### propose


```solidity
function propose(address multisig, address target, uint256 value, bytes calldata data) public;
```

### finalize


```solidity
function finalize(address multisig, address target, uint256 value, bytes calldata data) public;
```

### cancel


```solidity
function cancel(address multisig) public;
```

## Events
### Cancelled

```solidity
event Cancelled(address indexed multisig);
```

### DelaySet

```solidity
event DelaySet(address indexed multisig, uint32 delay);
```

### Finalized

```solidity
event Finalized(address indexed multisig, bytes32 indexed hash);
```

### Proposed

```solidity
event Proposed(address indexed multisig, bytes32 indexed hash, uint256 eta);
```

### GuardianSet

```solidity
event GuardianSet(address indexed multisig, address indexed guardian, bool active);
```

## Errors
### NotReady

```solidity
error NotReady();
```

### Unauthorized

```solidity
error Unauthorized();
```

