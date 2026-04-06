// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IMultisig} from "./interfaces/IMultisig.sol";

/// @dev Executor module that grants a spender a periodic ETH allowance.
/// Set as the multisig's executor. The spender calls spend() to transfer
/// ETH without owner signatures, up to the configured limit per period.
/// Singleton — one deployment serves all multisigs, keyed by msg.sender.
contract SpendingAllowance {
    event Spent(address indexed multisig, address indexed to, uint128 amount);
    event Configured(address indexed multisig, address indexed spender, uint128 allowance, uint32 period);

    error OverLimit();
    error Unauthorized();

    struct Config {
        address spender;
        uint128 allowance;
        uint128 spent;
        uint32 period;
        uint32 lastReset;
    }

    mapping(address multisig => Config) public configs;

    constructor() payable {}

    function configure(address _spender, uint128 _allowance, uint32 _period) public {
        require(_period != 0, OverLimit());
        configs[msg.sender] = Config(_spender, _allowance, 0, _period, uint32(block.timestamp));
        emit Configured(msg.sender, _spender, _allowance, _period);
    }

    function spend(address multisig, address to, uint128 amount) public {
        Config storage c = configs[multisig];
        require(msg.sender == c.spender, Unauthorized());
        unchecked {
            if (block.timestamp >= uint256(c.lastReset) + c.period) {
                c.spent = 0;
                c.lastReset = uint32(block.timestamp);
            }
        }
        require(c.spent + amount <= c.allowance, OverLimit());
        unchecked {
            c.spent += amount;
        }
        IMultisig(multisig).execute(to, amount, "", "");
        emit Spent(multisig, to, amount);
    }
}
