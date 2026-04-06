# Multisig
[Git Source](https://github.com/z0r0z/multisig/blob/7a81a30eb63788e9eea9c0790c2db6cfb7f435dd/src/Multisig.sol)


## State Variables
### delay

```solidity
uint32 public delay
```


### nonce

```solidity
uint32 public nonce
```


### threshold

```solidity
uint16 public threshold
```


### ownerCount

```solidity
uint16 public ownerCount
```


### executor

```solidity
address public executor
```


### factory

```solidity
address immutable factory = msg.sender
```


### SENTINEL

```solidity
address constant SENTINEL = address(1)
```


### _owners

```solidity
mapping(address => address) _owners
```


### queued

```solidity
mapping(bytes32 txHash => uint256) public queued
```


### approved

```solidity
mapping(address owner => mapping(bytes32 hash => bool)) public approved
```


## Functions
### onlySelf


```solidity
modifier onlySelf() ;
```

### constructor


```solidity
constructor() payable;
```

### init


```solidity
function init(address[] calldata owners_, uint32 _delay, uint256 _threshold, address _executor) public payable;
```

### isOwner


```solidity
function isOwner(address account) public view returns (bool);
```

### getOwners


```solidity
function getOwners() public view returns (address[] memory owners);
```

### DOMAIN_SEPARATOR


```solidity
function DOMAIN_SEPARATOR() public view returns (bytes32);
```

### getTransactionHash


```solidity
function getTransactionHash(address target, uint256 value, bytes calldata data, uint32 _nonce)
    public
    view
    returns (bytes32);
```

### isValidSignature


```solidity
function isValidSignature(bytes32 hash, bytes calldata sigs) public view returns (bytes4);
```

### execute


```solidity
function execute(address target, uint256 value, bytes calldata data, bytes calldata sigs) public payable;
```

### approve


```solidity
function approve(bytes32 hash, bool ok) public payable;
```

### cancelQueued


```solidity
function cancelQueued(bytes32 hash) public payable onlySelf;
```

### executeQueued


```solidity
function executeQueued(address target, uint256 value, bytes calldata data, uint32 _nonce) public payable;
```

### delegateCall


```solidity
function delegateCall(address target, bytes calldata data) public payable onlySelf;
```

### batch


```solidity
function batch(address[] calldata targets, uint256[] calldata values, bytes[] calldata datas)
    public
    payable
    onlySelf;
```

### addOwner


```solidity
function addOwner(address _owner) public payable onlySelf;
```

### removeOwner


```solidity
function removeOwner(address prevOwner, address _owner) public payable onlySelf;
```

### setDelay


```solidity
function setDelay(uint32 _delay) public payable onlySelf;
```

### setExecutor


```solidity
function setExecutor(address _executor) public payable onlySelf;
```

### setThreshold


```solidity
function setThreshold(uint256 _threshold) public payable onlySelf;
```

### receive


```solidity
receive() external payable;
```

### fallback

Handles all ERC721 and ERC1155 token safety callbacks.
Adapted from Solady (https://github.com/Vectorized/solady/blob/main/src/accounts/Receiver.sol)


```solidity
fallback() external payable;
```

## Events
### ChangedDelay

```solidity
event ChangedDelay(uint256 delay);
```

### AddedOwner

```solidity
event AddedOwner(address indexed owner);
```

### RemovedOwner

```solidity
event RemovedOwner(address indexed owner);
```

### ChangedThreshold

```solidity
event ChangedThreshold(uint256 threshold);
```

### ChangedExecutor

```solidity
event ChangedExecutor(address indexed executor);
```

### ExecutionSuccess

```solidity
event ExecutionSuccess(bytes32 indexed txHash, uint256 nonce);
```

### Queued

```solidity
event Queued(bytes32 indexed txHash, uint256 nonce, uint256 eta);
```

### Approved

```solidity
event Approved(address indexed owner, bytes32 indexed hash, bool ok);
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

### InvalidConfig

```solidity
error InvalidConfig();
```

### NotReady

```solidity
error NotReady(uint256 eta);
```

