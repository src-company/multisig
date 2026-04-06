# SpendingAllowance
[Git Source](https://github.com/z0r0z/multisig/blob/7a81a30eb63788e9eea9c0790c2db6cfb7f435dd/src/mods/SpendingAllowance.sol)

Executor module that grants a spender a periodic ETH allowance.
Set as the multisig's executor. The spender calls spend() to transfer
ETH without owner signatures, up to the configured limit per period.
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

### configure


```solidity
function configure(address _spender, uint128 _allowance, uint32 _period) public;
```

### spend


```solidity
function spend(address multisig, address to, uint128 amount) public;
```

## Events
### Spent

```solidity
event Spent(address indexed multisig, address indexed to, uint128 amount);
```

### Configured

```solidity
event Configured(address indexed multisig, address indexed spender, uint128 allowance, uint32 period);
```

## Errors
### OverLimit

```solidity
error OverLimit();
```

### Unauthorized

```solidity
error Unauthorized();
```

## Structs
### Config

```solidity
struct Config {
    address spender;
    uint128 allowance;
    uint128 spent;
    uint32 period;
    uint32 lastReset;
}
```

