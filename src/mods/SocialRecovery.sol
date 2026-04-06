// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IMultisig} from "./interfaces/IMultisig.sol";

/// @dev Executor module for social recovery. Guardians propose an arbitrary
/// call (e.g. a batch that rotates owners), wait through a delay, then
/// finalize. Set as the multisig's executor to bypass owner signatures.
/// Singleton — one deployment serves all multisigs, keyed by msg.sender.
contract SocialRecovery {
    event Cancelled(address indexed multisig);
    event DelaySet(address indexed multisig, uint32 delay);
    event Finalized(address indexed multisig, bytes32 indexed hash);
    event Proposed(address indexed multisig, bytes32 indexed hash, uint256 eta);
    event GuardianSet(address indexed multisig, address indexed guardian, bool active);

    error NotReady();
    error Unauthorized();

    mapping(address multisig => mapping(address => bool)) public isGuardian;
    mapping(address multisig => uint32) public delay;
    mapping(address multisig => bytes32) public pending;
    mapping(address multisig => uint256) public eta;

    constructor() payable {}

    function setGuardian(address guardian, bool active) public {
        if (active) require(delay[msg.sender] != 0, NotReady());
        isGuardian[msg.sender][guardian] = active;
        emit GuardianSet(msg.sender, guardian, active);
    }

    function setDelay(uint32 _delay) public {
        delay[msg.sender] = _delay;
        emit DelaySet(msg.sender, _delay);
    }

    function propose(address multisig, address target, uint256 value, bytes calldata data) public {
        require(isGuardian[multisig][msg.sender], Unauthorized());
        require(pending[multisig] == bytes32(0) || block.timestamp >= eta[multisig], NotReady());
        bytes32 hash = keccak256(abi.encode(target, value, data));
        uint256 _eta;
        unchecked {
            _eta = block.timestamp + delay[multisig];
        }
        pending[multisig] = hash;
        eta[multisig] = _eta;
        emit Proposed(multisig, hash, _eta);
    }

    function finalize(address multisig, address target, uint256 value, bytes calldata data) public {
        bytes32 hash = pending[multisig];
        require(hash != bytes32(0) && block.timestamp >= eta[multisig], NotReady());
        require(keccak256(abi.encode(target, value, data)) == hash, NotReady());
        delete pending[multisig];
        delete eta[multisig];
        IMultisig(multisig).execute(target, value, data, "");
        emit Finalized(multisig, hash);
    }

    function cancel(address multisig) public {
        require(isGuardian[multisig][msg.sender], Unauthorized());
        delete pending[multisig];
        delete eta[multisig];
        emit Cancelled(multisig);
    }
}
