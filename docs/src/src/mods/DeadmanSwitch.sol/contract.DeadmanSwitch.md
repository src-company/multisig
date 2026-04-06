# DeadmanSwitch
[Git Source](https://github.com/z0r0z/multisig/blob/7a81a30eb63788e9eea9c0790c2db6cfb7f435dd/src/mods/DeadmanSwitch.sol)

Post-guard and executor that enables a beneficiary to sweep funds
after a period of inactivity. Deploy at a vanity address with trailing
0x1111 so each multisig execution resets the heartbeat via post-guard.
Singleton — one deployment serves all multisigs, keyed by msg.sender.


## State Variables
### configs

```solidity
mapping(address multisig => Config) public configs
```


## Functions
### constructor


```solidity
constructor() payable;
```

### execute

Called as post-guard after every multisig execution. Resets heartbeat.


```solidity
function execute(address, uint256, bytes calldata, bytes calldata) public payable;
```

### configure


```solidity
function configure(address _beneficiary, uint256 _timeout) public;
```

### claim


```solidity
function claim(address multisig) public;
```

## Events
### Claimed

```solidity
event Claimed(address indexed multisig, address indexed beneficiary, uint256 amount);
```

### Configured

```solidity
event Configured(address indexed multisig, address indexed beneficiary, uint256 timeout);
```

## Errors
### StillAlive

```solidity
error StillAlive();
```

### Unauthorized

```solidity
error Unauthorized();
```

### InvalidConfig

```solidity
error InvalidConfig();
```

## Structs
### Config

```solidity
struct Config {
    address beneficiary;
    uint256 timeout;
    uint256 lastActivity;
}
```

