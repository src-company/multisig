# MultisigFactory
[Git Source](https://github.com/z0r0z/multisig/blob/7a81a30eb63788e9eea9c0790c2db6cfb7f435dd/src/Multisig.sol)


## State Variables
### implementation

```solidity
address public immutable implementation = address(new Multisig{salt: bytes32(0)}())
```


## Functions
### constructor


```solidity
constructor() payable;
```

### create

Create deterministic multisig wallet with PUSH0 and CREATE2.
Adapted from Solady (https://github.com/vectorized/solady/blob/main/src/utils/LibClone.sol).
The salt must start with the zero address, or the caller, for front-running protection.


```solidity
function create(address[] calldata _owners, uint32 _delay, uint256 _threshold, address _executor, uint256 salt)
    public
    payable
    returns (address wallet);
```

### createWithCalls

Create with post-init calls. Deploys with the factory as temporary
executor so calls bypass signatures, then sets the real executor last.
Use to configure singleton modules at the wallet's CREATE2 address.


```solidity
function createWithCalls(
    address[] calldata _owners,
    uint32 _delay,
    uint256 _threshold,
    address _executor,
    uint256 salt,
    address[] calldata targets,
    uint256[] calldata values,
    bytes[] calldata datas
) public payable returns (address wallet);
```

## Events
### Created

```solidity
event Created(address indexed wallet);
```

## Errors
### DeploymentFailed

```solidity
error DeploymentFailed();
```

### SaltDoesNotStartWith

```solidity
error SaltDoesNotStartWith();
```

