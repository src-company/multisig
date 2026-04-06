// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "forge-std/Test.sol";
import "../src/Multisig.sol";
import "../src/mods/AllowlistGuard.sol";
import "../src/mods/SpendingAllowance.sol";
import "../src/mods/SocialRecovery.sol";
import "../src/mods/DeadmanSwitch.sol";
import "../src/mods/TimelockExecutor.sol";

contract Sink {
    fallback() external payable {}
}

contract ModsTest is Test {
    MultisigFactory factory;

    uint256 pk1 = 0xA1;
    uint256 pk2 = 0xB2;
    uint256 pk3 = 0xC3;

    address owner1;
    address owner2;
    address owner3;

    // Vanity addresses for guard activation
    address constant PRE_GUARD = address(uint160(0x1111) << 144);
    address constant POST_GUARD = address(0x1111);

    SpendingAllowance spending;
    SocialRecovery recovery;
    TimelockExecutor cancelMod;

    Sink sink;
    address spender = address(0x5555);
    address guardian = address(0x6666);
    address beneficiary = address(0x7777);

    bytes32 constant EXECUTE_TYPEHASH = keccak256("Execute(address target,uint256 value,bytes data,uint32 nonce)");

    uint256 nextSalt;

    function setUp() public {
        owner1 = vm.addr(pk1);
        owner2 = vm.addr(pk2);
        owner3 = vm.addr(pk3);

        factory = new MultisigFactory();
        sink = new Sink();

        spending = new SpendingAllowance();
        recovery = new SocialRecovery();
        cancelMod = new TimelockExecutor();

        vm.etch(PRE_GUARD, address(new AllowlistGuard()).code);
        vm.etch(POST_GUARD, address(new DeadmanSwitch()).code);
    }

    // ───────── Helpers ─────────

    function _sortedOwners() internal view returns (address[] memory) {
        address[] memory arr = new address[](3);
        arr[0] = owner1;
        arr[1] = owner2;
        arr[2] = owner3;
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (arr[i] > arr[j]) (arr[i], arr[j]) = (arr[j], arr[i]);
            }
        }
        return arr;
    }

    function _deploy(uint128 threshold) internal returns (Multisig) {
        return Multisig(payable(factory.create(_sortedOwners(), 0, threshold, address(0), nextSalt++)));
    }

    function _deployFunded(uint128 threshold, uint256 amount) internal returns (Multisig) {
        vm.deal(address(this), amount);
        return Multisig(payable(factory.create{value: amount}(_sortedOwners(), 0, threshold, address(0), nextSalt++)));
    }

    function _digest(Multisig w, address to, uint256 value, bytes memory data) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                w.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(EXECUTE_TYPEHASH, to, value, keccak256(data), w.nonce()))
            )
        );
    }

    function _sign(Multisig w, address to, uint256 value, bytes memory data, uint256[] memory pks)
        internal
        view
        returns (bytes memory sigs)
    {
        bytes32 hash = _digest(w, to, value, data);
        sigs = new bytes(pks.length * 65);
        for (uint256 i; i < pks.length; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], hash);
            uint256 o = i * 65;
            assembly {
                let ptr := add(add(sigs, 0x20), o)
                mstore(ptr, r)
                mstore(add(ptr, 0x20), s)
                mstore8(add(ptr, 0x40), v)
            }
        }
    }

    function _sortedPKs(uint256[] memory pks) internal pure returns (uint256[] memory) {
        for (uint256 i; i < pks.length; ++i) {
            for (uint256 j = i + 1; j < pks.length; ++j) {
                if (vm.addr(pks[i]) > vm.addr(pks[j])) (pks[i], pks[j]) = (pks[j], pks[i]);
            }
        }
        return pks;
    }

    function _pks2() internal view returns (uint256[] memory) {
        uint256[] memory pks = new uint256[](2);
        pks[0] = pk1;
        pks[1] = pk2;
        return _sortedPKs(pks);
    }

    /// @dev Sign and execute in one call (threshold-2 wallet).
    function _exec(Multisig w, address to, uint256 value, bytes memory data) internal {
        w.execute(to, value, data, _sign(w, to, value, data, _pks2()));
    }

    /// @dev Build single-element call arrays for createWithCalls.
    function _callArrays(address target, bytes memory data)
        internal
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory datas)
    {
        targets = new address[](1);
        values = new uint256[](1);
        datas = new bytes[](1);
        targets[0] = target;
        datas[0] = data;
    }

    /// @dev Build two-element call arrays for createWithCalls.
    function _callArrays2(address t0, bytes memory d0, address t1, bytes memory d1)
        internal
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory datas)
    {
        targets = new address[](2);
        values = new uint256[](2);
        datas = new bytes[](2);
        targets[0] = t0;
        datas[0] = d0;
        targets[1] = t1;
        datas[1] = d1;
    }

    // ═══════════════════════════════════════════
    //           ALLOWLIST GUARD TESTS
    // ═══════════════════════════════════════════

    function test_allowlist_createWithCalls() public {
        (address[] memory t, uint256[] memory v, bytes[] memory d) =
            _callArrays(PRE_GUARD, abi.encodeCall(AllowlistGuard.set, (address(sink), bytes4(0), true)));

        vm.deal(address(this), 2 ether);
        Multisig w = Multisig(
            payable(factory.createWithCalls{value: 2 ether}(_sortedOwners(), 0, 2, PRE_GUARD, nextSalt++, t, v, d))
        );

        // Allowed call succeeds
        w.execute(address(sink), 1 ether, "", _sign(w, address(sink), 1 ether, "", _pks2()));
        assertEq(address(sink).balance, 1 ether);

        // Unlisted target reverts (sign before expectRevert to avoid consuming view calls)
        bytes memory sigs = _sign(w, spender, 1 ether, "", _pks2());
        vm.expectRevert(AllowlistGuard.NotAllowed.selector);
        w.execute(spender, 1 ether, "", sigs);
    }

    function test_allowlist_addedLater() public {
        Multisig w = _deployFunded(2, 2 ether);

        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (PRE_GUARD)));
        _exec(w, PRE_GUARD, 0, abi.encodeCall(AllowlistGuard.set, (address(sink), bytes4(0), true)));

        // Allowed
        w.execute(address(sink), 1 ether, "", _sign(w, address(sink), 1 ether, "", _pks2()));
        assertEq(address(sink).balance, 1 ether);

        // Unlisted
        bytes memory sigs = _sign(w, spender, 1 ether, "", _pks2());
        vm.expectRevert(AllowlistGuard.NotAllowed.selector);
        w.execute(spender, 1 ether, "", sigs);
    }

    function test_allowlist_blocksUnlistedSelector() public {
        Multisig w = _deployFunded(2, 1 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (PRE_GUARD)));
        _exec(w, PRE_GUARD, 0, abi.encodeCall(AllowlistGuard.set, (address(w), Multisig.setThreshold.selector, true)));

        // Allowed selector
        bytes memory ok = abi.encodeCall(Multisig.setThreshold, (2));
        w.execute(address(w), 0, ok, _sign(w, address(w), 0, ok, _pks2()));

        // Unlisted selector
        bytes memory bad = abi.encodeCall(Multisig.addOwner, (address(0x9999)));
        bytes memory sigs = _sign(w, address(w), 0, bad, _pks2());
        vm.expectRevert(AllowlistGuard.NotAllowed.selector);
        w.execute(address(w), 0, bad, sigs);
    }

    function test_allowlist_allowsSelfConfig() public {
        Multisig w = _deployFunded(2, 1 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (PRE_GUARD)));

        // Calls targeting the guard itself bypass the allowlist
        _exec(w, PRE_GUARD, 0, abi.encodeCall(AllowlistGuard.set, (address(sink), bytes4(0), true)));
        assertTrue(AllowlistGuard(PRE_GUARD).allowed(address(w), address(sink), bytes4(0)));
    }

    function test_allowlist_emitsEvent() public {
        Multisig w = _deployFunded(2, 1 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (PRE_GUARD)));

        vm.expectEmit(true, true, false, true, PRE_GUARD);
        emit AllowlistGuard.AllowlistSet(address(w), address(sink), bytes4(0), true);
        _exec(w, PRE_GUARD, 0, abi.encodeCall(AllowlistGuard.set, (address(sink), bytes4(0), true)));
    }

    // ═══════════════════════════════════════════
    //        SPENDING ALLOWANCE TESTS
    // ═══════════════════════════════════════════

    function test_spending_exactBoundary() public {
        Multisig w = _deployFunded(2, 5 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(spending))));
        _exec(w, address(spending), 0, abi.encodeCall(SpendingAllowance.configure, (spender, 1 ether, 1 days)));

        // Spending exactly the allowance succeeds
        vm.prank(spender);
        spending.spend(address(w), address(sink), 1 ether);
        assertEq(address(sink).balance, 1 ether);

        // One wei over fails
        vm.prank(spender);
        vm.expectRevert(SpendingAllowance.OverLimit.selector);
        spending.spend(address(w), address(sink), 1);
    }

    function test_spending_reconfigureResetsSpent() public {
        Multisig w = _deployFunded(2, 5 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(spending))));
        _exec(w, address(spending), 0, abi.encodeCall(SpendingAllowance.configure, (spender, 1 ether, 1 days)));

        vm.prank(spender);
        spending.spend(address(w), address(sink), 1 ether);

        // Reconfigure resets spent to 0
        _exec(w, address(spending), 0, abi.encodeCall(SpendingAllowance.configure, (spender, 1 ether, 1 days)));

        vm.prank(spender);
        spending.spend(address(w), address(sink), 1 ether);
        assertEq(address(sink).balance, 2 ether);
    }

    function test_spending_createWithCalls() public {
        (address[] memory t, uint256[] memory v, bytes[] memory d) =
            _callArrays(address(spending), abi.encodeCall(SpendingAllowance.configure, (spender, 1 ether, 1 days)));

        vm.deal(address(this), 5 ether);
        Multisig w = Multisig(
            payable(factory.createWithCalls{value: 5 ether}(
                    _sortedOwners(), 0, 2, address(spending), nextSalt++, t, v, d
                ))
        );

        vm.prank(spender);
        spending.spend(address(w), address(sink), 1 ether);
        assertEq(address(sink).balance, 1 ether);
    }

    function test_spending_addedLater() public {
        Multisig w = _deployFunded(2, 5 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(spending))));
        _exec(w, address(spending), 0, abi.encodeCall(SpendingAllowance.configure, (spender, 1 ether, 1 days)));

        vm.prank(spender);
        spending.spend(address(w), address(sink), 0.5 ether);
        assertEq(address(sink).balance, 0.5 ether);
    }

    function test_spending_overLimit() public {
        Multisig w = _deployFunded(2, 5 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(spending))));
        _exec(w, address(spending), 0, abi.encodeCall(SpendingAllowance.configure, (spender, 1 ether, 1 days)));

        vm.prank(spender);
        vm.expectRevert(SpendingAllowance.OverLimit.selector);
        spending.spend(address(w), address(sink), 2 ether);
    }

    function test_spending_periodReset() public {
        Multisig w = _deployFunded(2, 5 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(spending))));
        _exec(w, address(spending), 0, abi.encodeCall(SpendingAllowance.configure, (spender, 1 ether, 1 days)));

        // Exhaust allowance
        vm.prank(spender);
        spending.spend(address(w), address(sink), 1 ether);

        vm.prank(spender);
        vm.expectRevert(SpendingAllowance.OverLimit.selector);
        spending.spend(address(w), address(sink), 0.5 ether);

        // Warp past period — allowance resets
        vm.warp(block.timestamp + 1 days);
        vm.prank(spender);
        spending.spend(address(w), address(sink), 1 ether);
        assertEq(address(sink).balance, 2 ether);
    }

    function test_spending_revertUnauthorized() public {
        Multisig w = _deployFunded(2, 5 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(spending))));
        _exec(w, address(spending), 0, abi.encodeCall(SpendingAllowance.configure, (spender, 1 ether, 1 days)));

        vm.prank(address(0xBAD));
        vm.expectRevert(SpendingAllowance.Unauthorized.selector);
        spending.spend(address(w), address(sink), 0.5 ether);
    }

    // ═══════════════════════════════════════════
    //          RECOVERY MODULE TESTS
    // ═══════════════════════════════════════════

    function test_recovery_createWithCalls() public {
        (address[] memory t, uint256[] memory v, bytes[] memory d) = _callArrays2(
            address(recovery),
            abi.encodeCall(SocialRecovery.setDelay, (1 days)),
            address(recovery),
            abi.encodeCall(SocialRecovery.setGuardian, (guardian, true))
        );

        Multisig w =
            Multisig(payable(factory.createWithCalls(_sortedOwners(), 0, 2, address(recovery), nextSalt++, t, v, d)));

        assertTrue(recovery.isGuardian(address(w), guardian));
        assertEq(recovery.delay(address(w)), 1 days);

        // Guardian proposes adding a new owner
        address newOwner = vm.addr(0xD4);
        bytes memory data = abi.encodeCall(Multisig.addOwner, (newOwner));
        vm.prank(guardian);
        recovery.propose(address(w), address(w), 0, data);

        vm.warp(block.timestamp + 1 days);
        recovery.finalize(address(w), address(w), 0, data);
        assertTrue(w.isOwner(newOwner));
    }

    function test_recovery_addedLater() public {
        Multisig w = _deploy(2);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(recovery))));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setDelay, (1 days)));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setGuardian, (guardian, true)));

        address newOwner = vm.addr(0xD4);
        bytes memory data = abi.encodeCall(Multisig.addOwner, (newOwner));
        vm.prank(guardian);
        recovery.propose(address(w), address(w), 0, data);

        vm.warp(block.timestamp + 1 days);
        recovery.finalize(address(w), address(w), 0, data);
        assertTrue(w.isOwner(newOwner));
    }

    function test_recovery_revertBeforeDelay() public {
        Multisig w = _deploy(2);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(recovery))));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setDelay, (1 days)));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setGuardian, (guardian, true)));

        bytes memory data = abi.encodeCall(Multisig.addOwner, (vm.addr(0xD4)));
        vm.prank(guardian);
        recovery.propose(address(w), address(w), 0, data);

        vm.expectRevert(SocialRecovery.NotReady.selector);
        recovery.finalize(address(w), address(w), 0, data);
    }

    function test_recovery_cancel() public {
        Multisig w = _deploy(2);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(recovery))));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setDelay, (1 days)));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setGuardian, (guardian, true)));

        bytes memory data = abi.encodeCall(Multisig.addOwner, (vm.addr(0xD4)));
        vm.prank(guardian);
        recovery.propose(address(w), address(w), 0, data);

        vm.prank(guardian);
        recovery.cancel(address(w));

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(SocialRecovery.NotReady.selector);
        recovery.finalize(address(w), address(w), 0, data);
    }

    function test_recovery_revertUnauthorizedPropose() public {
        Multisig w = _deploy(2);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(recovery))));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setDelay, (1 days)));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setGuardian, (guardian, true)));

        vm.prank(address(0xBAD));
        vm.expectRevert(SocialRecovery.Unauthorized.selector);
        recovery.propose(address(w), address(w), 0, abi.encodeCall(Multisig.addOwner, (vm.addr(0xD4))));
    }

    function test_recovery_revertUnauthorizedCancel() public {
        Multisig w = _deploy(2);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(recovery))));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setDelay, (1 days)));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setGuardian, (guardian, true)));

        bytes memory data = abi.encodeCall(Multisig.addOwner, (vm.addr(0xD4)));
        vm.prank(guardian);
        recovery.propose(address(w), address(w), 0, data);

        vm.prank(address(0xBAD));
        vm.expectRevert(SocialRecovery.Unauthorized.selector);
        recovery.cancel(address(w));
    }

    function test_recovery_finalizeWrongParams() public {
        Multisig w = _deploy(2);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(recovery))));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setDelay, (1 days)));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setGuardian, (guardian, true)));

        bytes memory data = abi.encodeCall(Multisig.addOwner, (vm.addr(0xD4)));
        vm.prank(guardian);
        recovery.propose(address(w), address(w), 0, data);

        vm.warp(block.timestamp + 1 days);

        // Wrong target
        vm.expectRevert(SocialRecovery.NotReady.selector);
        recovery.finalize(address(w), address(0xBEEF), 0, data);
    }

    function test_recovery_revertProposeWhileActive() public {
        Multisig w = _deploy(2);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(recovery))));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setDelay, (1 days)));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setGuardian, (guardian, true)));

        vm.prank(guardian);
        recovery.propose(address(w), address(w), 0, abi.encodeCall(Multisig.addOwner, (vm.addr(0xD4))));

        // Second proposal while first is still active reverts
        vm.prank(guardian);
        vm.expectRevert(SocialRecovery.NotReady.selector);
        recovery.propose(address(w), address(w), 0, abi.encodeCall(Multisig.addOwner, (vm.addr(0xE5))));
    }

    function test_recovery_overwriteExpiredProposal() public {
        Multisig w = _deploy(2);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(recovery))));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setDelay, (1 days)));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setGuardian, (guardian, true)));

        // First proposal
        bytes memory data1 = abi.encodeCall(Multisig.addOwner, (vm.addr(0xD4)));
        vm.prank(guardian);
        recovery.propose(address(w), address(w), 0, data1);

        // Warp past eta — proposal expires unfinalised
        vm.warp(block.timestamp + 1 days);

        // New proposal overwrites
        address newOwner = vm.addr(0xE5);
        bytes memory data2 = abi.encodeCall(Multisig.addOwner, (newOwner));
        vm.prank(guardian);
        recovery.propose(address(w), address(w), 0, data2);

        // Old proposal can no longer be finalised
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(SocialRecovery.NotReady.selector);
        recovery.finalize(address(w), address(w), 0, data1);

        // New one can
        recovery.finalize(address(w), address(w), 0, data2);
        assertTrue(w.isOwner(newOwner));
    }

    function test_recovery_finalizePermissionless() public {
        Multisig w = _deploy(2);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(recovery))));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setDelay, (1 days)));
        _exec(w, address(recovery), 0, abi.encodeCall(SocialRecovery.setGuardian, (guardian, true)));

        address newOwner = vm.addr(0xD4);
        bytes memory data = abi.encodeCall(Multisig.addOwner, (newOwner));
        vm.prank(guardian);
        recovery.propose(address(w), address(w), 0, data);

        vm.warp(block.timestamp + 1 days);

        // Anyone can finalize
        vm.prank(address(0xCAFE));
        recovery.finalize(address(w), address(w), 0, data);
        assertTrue(w.isOwner(newOwner));
    }

    // ═══════════════════════════════════════════
    //          DEADMAN SWITCH TESTS
    // ═══════════════════════════════════════════

    function test_deadman_createWithCalls() public {
        (address[] memory t, uint256[] memory v, bytes[] memory d) =
            _callArrays(POST_GUARD, abi.encodeCall(DeadmanSwitch.configure, (beneficiary, 30 days)));

        vm.deal(address(this), 5 ether);
        Multisig w = Multisig(
            payable(factory.createWithCalls{value: 5 ether}(_sortedOwners(), 0, 2, POST_GUARD, nextSalt++, t, v, d))
        );

        (address ben, uint256 timeout,) = DeadmanSwitch(POST_GUARD).configs(address(w));
        assertEq(ben, beneficiary);
        assertEq(timeout, 30 days);
    }

    function test_deadman_addedLater() public {
        Multisig w = _deployFunded(2, 5 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (POST_GUARD)));
        _exec(w, POST_GUARD, 0, abi.encodeCall(DeadmanSwitch.configure, (beneficiary, 30 days)));

        (address ben, uint256 timeout,) = DeadmanSwitch(POST_GUARD).configs(address(w));
        assertEq(ben, beneficiary);
        assertEq(timeout, 30 days);
    }

    function test_deadman_heartbeatResets() public {
        Multisig w = _deployFunded(2, 5 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (POST_GUARD)));
        _exec(w, POST_GUARD, 0, abi.encodeCall(DeadmanSwitch.configure, (beneficiary, 30 days)));

        vm.warp(block.timestamp + 20 days);

        // Any owner-signed execution resets the heartbeat via post-guard
        _exec(w, address(sink), 0, "");

        (,, uint256 last) = DeadmanSwitch(POST_GUARD).configs(address(w));
        assertEq(last, block.timestamp);
    }

    function test_deadman_claim() public {
        Multisig w = _deployFunded(2, 5 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (POST_GUARD)));
        _exec(w, POST_GUARD, 0, abi.encodeCall(DeadmanSwitch.configure, (beneficiary, 30 days)));

        vm.warp(block.timestamp + 30 days);

        vm.prank(beneficiary);
        DeadmanSwitch(POST_GUARD).claim(address(w));
        assertEq(beneficiary.balance, 5 ether);
    }

    function test_deadman_revertStillAlive() public {
        Multisig w = _deployFunded(2, 5 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (POST_GUARD)));
        _exec(w, POST_GUARD, 0, abi.encodeCall(DeadmanSwitch.configure, (beneficiary, 30 days)));

        vm.warp(block.timestamp + 15 days);

        vm.prank(beneficiary);
        vm.expectRevert(DeadmanSwitch.StillAlive.selector);
        DeadmanSwitch(POST_GUARD).claim(address(w));
    }

    function test_deadman_revertUnauthorizedClaim() public {
        Multisig w = _deployFunded(2, 5 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (POST_GUARD)));
        _exec(w, POST_GUARD, 0, abi.encodeCall(DeadmanSwitch.configure, (beneficiary, 30 days)));

        vm.warp(block.timestamp + 30 days);

        vm.prank(address(0xBAD));
        vm.expectRevert(DeadmanSwitch.Unauthorized.selector);
        DeadmanSwitch(POST_GUARD).claim(address(w));
    }

    function test_deadman_revertClaimZeroBalance() public {
        Multisig w = _deploy(2);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (POST_GUARD)));
        _exec(w, POST_GUARD, 0, abi.encodeCall(DeadmanSwitch.configure, (beneficiary, 30 days)));

        vm.warp(block.timestamp + 30 days);

        // Multisig has no ETH
        vm.prank(beneficiary);
        vm.expectRevert(DeadmanSwitch.StillAlive.selector);
        DeadmanSwitch(POST_GUARD).claim(address(w));
    }

    function test_deadman_revertConfigureNonVanity() public {
        DeadmanSwitch ds = new DeadmanSwitch();
        // ds is at a regular address, not trailing 0x1111
        vm.expectRevert(DeadmanSwitch.InvalidConfig.selector);
        ds.configure(beneficiary, 30 days);
    }

    // ═══════════════════════════════════════════
    //         CREATE WITH CALLS TESTS
    // ═══════════════════════════════════════════

    function test_createWithCalls_setsExecutor() public {
        (address[] memory t, uint256[] memory v, bytes[] memory d) =
            _callArrays(address(spending), abi.encodeCall(SpendingAllowance.configure, (spender, 1 ether, 1 days)));

        Multisig w =
            Multisig(payable(factory.createWithCalls(_sortedOwners(), 0, 2, address(spending), nextSalt++, t, v, d)));

        assertEq(w.executor(), address(spending));
    }

    function test_createWithCalls_advancesNonce() public {
        (address[] memory t, uint256[] memory v, bytes[] memory d) = _callArrays2(
            address(recovery),
            abi.encodeCall(SocialRecovery.setDelay, (1 days)),
            address(recovery),
            abi.encodeCall(SocialRecovery.setGuardian, (guardian, true))
        );

        Multisig w =
            Multisig(payable(factory.createWithCalls(_sortedOwners(), 0, 2, address(recovery), nextSalt++, t, v, d)));

        // 2 config calls + 1 setExecutor call = nonce 3
        assertEq(w.nonce(), 3);
    }

    function test_createWithCalls_emptyCalls() public {
        address[] memory t = new address[](0);
        uint256[] memory v = new uint256[](0);
        bytes[] memory d = new bytes[](0);

        Multisig w = Multisig(payable(factory.createWithCalls(_sortedOwners(), 0, 2, address(0), nextSalt++, t, v, d)));

        // Only setExecutor call = nonce 1
        assertEq(w.nonce(), 1);
        assertEq(w.executor(), address(0));
        assertEq(w.threshold(), 2);
    }

    // ═══════════════════════════════════════════
    //          CANCEL MODULE TESTS
    // ═══════════════════════════════════════════

    function _deployTimelocked(uint128 threshold, uint32 _delay) internal returns (Multisig) {
        address[] memory sorted = _sortedOwners();
        return Multisig(payable(factory.create(sorted, _delay, threshold, address(cancelMod), nextSalt++)));
    }

    function _pks3() internal view returns (uint256[] memory) {
        uint256[] memory pks = new uint256[](3);
        pks[0] = pk1;
        pks[1] = pk2;
        pks[2] = pk3;
        return _sortedPKs(pks);
    }

    /// @dev Sign a forward action — same Execute typehash as the multisig itself.
    function _signForward(Multisig w, address target, uint256 value, bytes memory data, uint256[] memory pks)
        internal
        view
        returns (bytes memory sigs)
    {
        bytes32 hash = w.getTransactionHash(target, value, data, w.nonce());
        sigs = new bytes(pks.length * 65);
        for (uint256 i; i < pks.length; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], hash);
            uint256 o = i * 65;
            assembly {
                let ptr := add(add(sigs, 0x20), o)
                mstore(ptr, r)
                mstore(add(ptr, 0x20), s)
                mstore8(add(ptr, 0x40), v)
            }
        }
    }

    function test_cancel_thresholdCancels() public {
        Multisig w = _deployTimelocked(2, 1 days);
        vm.deal(address(w), 5 ether);

        // Queue a tx
        w.execute(address(sink), 1 ether, "", _sign(w, address(sink), 1 ether, "", _pks2()));
        bytes32 queuedHash = w.getTransactionHash(address(sink), 1 ether, "", 0);
        assertTrue(w.queued(queuedHash) != 0);

        // Cancel with threshold sigs (2 of 3)
        bytes memory cancelData = abi.encodeCall(Multisig.cancelQueued, (queuedHash));
        bytes memory sigs = _signForward(w, address(w), 0, cancelData, _pks2());
        cancelMod.forward(address(w), address(w), 0, cancelData, sigs);
        assertEq(w.queued(queuedHash), 0);
    }

    function test_cancel_createWithCalls() public {
        (address[] memory t, uint256[] memory v, bytes[] memory d) = _callArrays(address(sink), "");
        Multisig w = Multisig(
            payable(factory.createWithCalls(_sortedOwners(), 1 days, 2, address(cancelMod), nextSalt++, t, v, d))
        );
        assertEq(w.executor(), address(cancelMod));

        vm.deal(address(w), 5 ether);
        w.execute(address(sink), 1 ether, "", _sign(w, address(sink), 1 ether, "", _pks2()));
        bytes32 queuedHash = w.getTransactionHash(address(sink), 1 ether, "", uint32(w.nonce() - 1));

        bytes memory cancelData = abi.encodeCall(Multisig.cancelQueued, (queuedHash));
        cancelMod.forward(address(w), address(w), 0, cancelData, _signForward(w, address(w), 0, cancelData, _pks2()));
        assertEq(w.queued(queuedHash), 0);
    }

    function test_cancel_revertInvalidSig() public {
        Multisig w = _deployTimelocked(2, 1 days);
        bytes memory cancelData = abi.encodeCall(Multisig.cancelQueued, (bytes32(uint256(1))));

        // Only 1 sig when threshold=2
        uint256[] memory onePk = new uint256[](1);
        onePk[0] = pk1;
        onePk = _sortedPKs(onePk);
        bytes memory sigs = _signForward(w, address(w), 0, cancelData, onePk);

        vm.expectRevert(TimelockExecutor.InvalidSig.selector);
        cancelMod.forward(address(w), address(w), 0, cancelData, sigs);
    }

    function test_cancel_timelockStillWorks() public {
        Multisig w = _deployTimelocked(2, 1 days);
        vm.deal(address(w), 5 ether);

        w.execute(address(sink), 1 ether, "", _sign(w, address(sink), 1 ether, "", _pks2()));
        assertTrue(w.queued(w.getTransactionHash(address(sink), 1 ether, "", 0)) != 0);

        vm.warp(block.timestamp + 1 days);
        w.executeQueued(address(sink), 1 ether, "", 0);
        assertEq(address(sink).balance, 1 ether);
    }

    function test_cancel_revertInsufficientSigs() public {
        Multisig w = _deployTimelocked(2, 1 days);
        bytes memory cancelData = abi.encodeCall(Multisig.cancelQueued, (bytes32(uint256(1))));

        // 1 sig when threshold=2
        uint256[] memory onePk = new uint256[](1);
        onePk[0] = pk1;
        onePk = _sortedPKs(onePk);
        bytes memory sigs = _signForward(w, address(w), 0, cancelData, onePk);
        vm.expectRevert(TimelockExecutor.InvalidSig.selector);
        cancelMod.forward(address(w), address(w), 0, cancelData, sigs);
    }

    function test_forward_allOwnersExecute() public {
        Multisig w = _deployTimelockedWithForward();

        // All-owner sigs bypass timelock
        bytes memory sigs = _signForward(w, address(sink), 1 ether, "", _pks3());
        cancelMod.forward(address(w), address(sink), 1 ether, "", sigs);
        assertEq(address(sink).balance, 1 ether);
    }

    function test_forward_revertInsufficientSigs() public {
        Multisig w = _deployTimelockedWithForward();

        // Only 2 of 3 sigs for forward (needs all)
        bytes memory sigs = _signForward(w, address(sink), 1 ether, "", _pks2());
        vm.expectRevert(TimelockExecutor.InvalidSig.selector);
        cancelMod.forward(address(w), address(sink), 1 ether, "", sigs);
    }

    function test_forward_revertInvalidSigner() public {
        Multisig w = _deployTimelockedWithForward();

        // Sign with non-owner key
        uint256[] memory badPks = new uint256[](3);
        badPks[0] = pk1;
        badPks[1] = pk2;
        badPks[2] = 0xDEAD;
        badPks = _sortedPKs(badPks);
        bytes memory sigs = _signForward(w, address(sink), 1 ether, "", badPks);

        vm.expectRevert(TimelockExecutor.InvalidSig.selector);
        cancelMod.forward(address(w), address(sink), 1 ether, "", sigs);
    }

    function test_forward_nonceConsumed() public {
        Multisig w = _deployTimelockedWithForward();

        uint32 nonceBefore = w.nonce();
        cancelMod.forward(address(w), address(sink), 1 ether, "", _signForward(w, address(sink), 1 ether, "", _pks3()));
        assertEq(w.nonce(), nonceBefore + 1);
    }

    function test_forward_revertReplaySameNonce() public {
        Multisig w = _deployTimelockedWithForward();

        bytes memory sigs = _signForward(w, address(sink), 1 ether, "", _pks3());
        cancelMod.forward(address(w), address(sink), 1 ether, "", sigs);

        // Same sigs, nonce consumed — should fail
        vm.expectRevert(TimelockExecutor.InvalidSig.selector);
        cancelMod.forward(address(w), address(sink), 1 ether, "", sigs);
    }

    function test_forward_sameCallTwice() public {
        Multisig w = _deployTimelockedWithForward();

        // First forward
        cancelMod.forward(address(w), address(sink), 1 ether, "", _signForward(w, address(sink), 1 ether, "", _pks3()));
        assertEq(address(sink).balance, 1 ether);

        // Second forward — new nonce, fresh sigs
        cancelMod.forward(address(w), address(sink), 1 ether, "", _signForward(w, address(sink), 1 ether, "", _pks3()));
        assertEq(address(sink).balance, 2 ether);
    }

    function test_forward_revertNotEnabled() public {
        Multisig w = _deployTimelocked(2, 1 days);
        vm.deal(address(w), 5 ether);

        bytes memory sigs = _signForward(w, address(sink), 1 ether, "", _pks3());
        vm.expectRevert(TimelockExecutor.Unauthorized.selector);
        cancelMod.forward(address(w), address(sink), 1 ether, "", sigs);
    }

    function test_cancel_worksWithoutForwardEnabled() public {
        Multisig w = _deployTimelocked(2, 1 days);
        vm.deal(address(w), 5 ether);
        assertFalse(cancelMod.forwardEnabled(address(w)));

        w.execute(address(sink), 1 ether, "", _sign(w, address(sink), 1 ether, "", _pks2()));
        bytes32 queuedHash = w.getTransactionHash(address(sink), 1 ether, "", 0);

        bytes memory cancelData = abi.encodeCall(Multisig.cancelQueued, (queuedHash));
        cancelMod.forward(address(w), address(w), 0, cancelData, _signForward(w, address(w), 0, cancelData, _pks2()));
        assertEq(w.queued(queuedHash), 0);
    }

    function test_enableForward_emitsEvent() public {
        Multisig w = _deployFunded(2, 5 ether);
        _exec(w, address(w), 0, abi.encodeCall(Multisig.setExecutor, (address(cancelMod))));

        vm.expectEmit(true, true, true, true);
        emit TimelockExecutor.ForwardEnabled(address(w), true);
        _exec(w, address(cancelMod), 0, abi.encodeCall(TimelockExecutor.enableForward, (true)));
    }

    function test_forward_onchainApproval() public {
        Multisig w = _deployTimelockedWithForward();

        // Build the hash that will be verified
        bytes32 hash = w.getTransactionHash(address(sink), 1 ether, "", w.nonce());

        // Owner1 approves onchain instead of signing
        address[] memory sorted = _sortedOwners();
        vm.prank(sorted[0]);
        w.approve(hash, true);

        // Build sigs: v=0 for owner1 (onchain), ECDSA for owner2 and owner3
        uint256[] memory pks = _pks3();
        bytes memory ecdsaSigs = _signForward(w, address(sink), 1 ether, "", pks);

        // Replace the slot for sorted[0] with v=0 approval
        // Need to figure out which position sorted[0] occupies in the sorted pk order
        bytes memory mixedSigs = new bytes(3 * 65);
        uint256 approverIdx;
        for (uint256 i; i < 3; ++i) {
            if (vm.addr(pks[i]) == sorted[0]) {
                approverIdx = i;
                break;
            }
        }
        // Copy all ECDSA sigs, then overwrite the approver slot with v=0
        for (uint256 i; i < 3; ++i) {
            uint256 o = i * 65;
            if (i == approverIdx) {
                // v=0 approval: address left-padded in first 32 bytes, zero r, v=0
                assembly {
                    let ptr := add(add(mixedSigs, 0x20), o)
                    mstore(ptr, shl(96, sload(add(sorted, 0x20)))) // sorted[0] left-padded...
                }
                // Simpler: just encode the address as bytes32
                bytes32 addrBytes = bytes32(uint256(uint160(sorted[0])));
                assembly {
                    let ptr := add(add(mixedSigs, 0x20), o)
                    mstore(ptr, addrBytes)
                    mstore(add(ptr, 0x20), 0) // s = 0
                    mstore8(add(ptr, 0x40), 0) // v = 0
                }
            } else {
                // Copy ECDSA sig from ecdsaSigs
                for (uint256 j; j < 65; ++j) {
                    mixedSigs[o + j] = ecdsaSigs[i * 65 + j];
                }
            }
        }

        cancelMod.forward(address(w), address(sink), 1 ether, "", mixedSigs);
        assertEq(address(sink).balance, 1 ether);
    }

    function test_forward_accelerateQueuedTx() public {
        Multisig w = _deployTimelockedWithForward();

        // Queue a tx via normal threshold-signed execute
        w.execute(address(sink), 1 ether, "", _sign(w, address(sink), 1 ether, "", _pks2()));
        uint32 queuedNonce = w.nonce() - 1;
        bytes32 queuedHash = w.getTransactionHash(address(sink), 1 ether, "", queuedNonce);
        assertTrue(w.queued(queuedHash) != 0);

        // Accelerate: all owners sign a forward of executeQueued self-call
        bytes memory eqData = abi.encodeCall(Multisig.executeQueued, (address(sink), 1 ether, "", queuedNonce));
        bytes memory sigs = _signForward(w, address(w), 0, eqData, _pks3());
        cancelMod.forward(address(w), address(w), 0, eqData, sigs);

        // Queued entry consumed, tx executed
        assertEq(w.queued(queuedHash), 0);
        assertEq(address(sink).balance, 1 ether);
    }

    function test_forward_emitsForwardedEvent() public {
        Multisig w = _deployTimelockedWithForward();

        bytes32 expectedHash = w.getTransactionHash(address(sink), 1 ether, "", w.nonce());
        vm.expectEmit(true, true, true, true);
        emit TimelockExecutor.Forwarded(address(w), expectedHash);
        cancelMod.forward(address(w), address(sink), 1 ether, "", _signForward(w, address(sink), 1 ether, "", _pks3()));
    }

    // ═══════════════════════════════════════════
    //     CROSS-MULTISIG ATTACK TESTS
    // ═══════════════════════════════════════════

    function test_forward_revertCrossMultisigAttack() public {
        // Deploy two multisigs, both using the same TimelockExecutor singleton
        Multisig victim = _deployTimelockedWithForward();
        assertEq(victim.executor(), address(cancelMod));

        // Attacker multisig with different owners
        uint256 atkPk = 0xDEAD;
        address atkOwner = vm.addr(atkPk);
        address[] memory atkOwners = new address[](1);
        atkOwners[0] = atkOwner;
        factory.create(atkOwners, 0, 1, address(cancelMod), nextSalt++);

        // Attacker signs over the VICTIM's domain trying to drain it
        // This should fail because atkOwner is not an owner of victim
        bytes32 hash = victim.getTransactionHash(atkOwner, 5 ether, "", victim.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(atkPk, hash);
        bytes memory sigs = abi.encodePacked(r, s, v);

        vm.expectRevert(TimelockExecutor.InvalidSig.selector);
        cancelMod.forward(address(victim), atkOwner, 5 ether, "", sigs);

        // Victim funds untouched
        assertEq(address(victim).balance, 5 ether);
    }

    function test_forward_revertAttackerSignsOwnDomain() public {
        // Attacker creates sigs over their own multisig's domain, passes victim's address
        Multisig victim = _deployTimelockedWithForward();

        uint256 atkPk = 0xDEAD;
        address atkOwner = vm.addr(atkPk);
        address[] memory atkOwners = new address[](1);
        atkOwners[0] = atkOwner;
        Multisig atkWallet = Multisig(payable(factory.create(atkOwners, 0, 1, address(cancelMod), nextSalt++)));

        // Sign over attacker's domain (wrong domain for victim)
        bytes32 wrongHash = atkWallet.getTransactionHash(atkOwner, 5 ether, "", victim.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(atkPk, wrongHash);
        bytes memory sigs = abi.encodePacked(r, s, v);

        // forward() uses victim's getTransactionHash → different hash → ecrecover yields wrong address
        vm.expectRevert(TimelockExecutor.InvalidSig.selector);
        cancelMod.forward(address(victim), atkOwner, 5 ether, "", sigs);

        assertEq(address(victim).balance, 5 ether);
    }

    function test_forward_cannotCancelOtherMultisig() public {
        // Attacker tries to cancel a victim's queued tx using their own sigs
        Multisig victim = _deployTimelockedWithForward();

        // Queue a tx on victim
        uint32 n = victim.nonce();
        victim.execute(address(sink), 1 ether, "", _sign(victim, address(sink), 1 ether, "", _pks2()));
        bytes32 queuedHash = victim.getTransactionHash(address(sink), 1 ether, "", n);
        assertTrue(victim.queued(queuedHash) != 0);

        // Attacker with different owner tries to cancel
        uint256 atkPk = 0xDEAD;
        bytes memory cancelData = abi.encodeCall(Multisig.cancelQueued, (queuedHash));
        bytes32 hash = victim.getTransactionHash(address(victim), 0, cancelData, victim.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(atkPk, hash);
        bytes memory sigs = abi.encodePacked(r, s, v);

        vm.expectRevert(TimelockExecutor.InvalidSig.selector);
        cancelMod.forward(address(victim), address(victim), 0, cancelData, sigs);

        // Still queued
        assertTrue(victim.queued(queuedHash) != 0);
    }

    // ═══════════════════════════════════════════
    //     GUARD HOOKS ON EXECUTEQUEUED TESTS
    // ═══════════════════════════════════════════

    function test_preGuard_allowsExecuteQueued() public {
        // Deploy with delay + pre-guard, allowlist sink via createWithCalls
        (address[] memory t, uint256[] memory v, bytes[] memory d) =
            _callArrays(PRE_GUARD, abi.encodeCall(AllowlistGuard.set, (address(sink), bytes4(0), true)));
        vm.deal(address(this), 5 ether);
        Multisig w = Multisig(
            payable(factory.createWithCalls{value: 5 ether}(_sortedOwners(), 1 days, 2, PRE_GUARD, nextSalt++, t, v, d))
        );

        // Queue tx to sink (passes pre-guard, queued due to delay)
        w.execute(address(sink), 1 ether, "", _sign(w, address(sink), 1 ether, "", _pks2()));
        uint32 n = w.nonce() - 1;

        vm.warp(block.timestamp + 1 days);
        w.executeQueued(address(sink), 1 ether, "", n);
        assertEq(address(sink).balance, 1 ether);
    }

    function test_preGuard_blocksExecuteQueued() public {
        // Deploy with delay + pre-guard, allowlist sink via createWithCalls
        (address[] memory t, uint256[] memory v, bytes[] memory d) =
            _callArrays(PRE_GUARD, abi.encodeCall(AllowlistGuard.set, (address(sink), bytes4(0), true)));
        vm.deal(address(this), 5 ether);
        Multisig w = Multisig(
            payable(factory.createWithCalls{value: 5 ether}(_sortedOwners(), 1 days, 2, PRE_GUARD, nextSalt++, t, v, d))
        );

        // Queue tx to sink (passes pre-guard)
        w.execute(address(sink), 1 ether, "", _sign(w, address(sink), 1 ether, "", _pks2()));
        uint32 n1 = w.nonce() - 1;

        // Queue removal of sink from allowlist (target=PRE_GUARD, always allowed by guard)
        bytes memory removeData = abi.encodeCall(AllowlistGuard.set, (address(sink), bytes4(0), false));
        w.execute(PRE_GUARD, 0, removeData, _sign(w, PRE_GUARD, 0, removeData, _pks2()));
        uint32 n2 = w.nonce() - 1;

        vm.warp(block.timestamp + 1 days);

        // Execute the removal first
        w.executeQueued(PRE_GUARD, 0, removeData, n2);

        // Now executeQueued for sink should revert — pre-guard re-checks
        vm.expectRevert(AllowlistGuard.NotAllowed.selector);
        w.executeQueued(address(sink), 1 ether, "", n1);
    }

    function test_postGuard_resetsHeartbeatOnExecuteQueued() public {
        // Deploy with delay + post-guard, configure deadman via createWithCalls
        (address[] memory t, uint256[] memory v, bytes[] memory d) =
            _callArrays(POST_GUARD, abi.encodeCall(DeadmanSwitch.configure, (beneficiary, 30 days)));
        vm.deal(address(this), 5 ether);
        Multisig w = Multisig(
            payable(factory.createWithCalls{value: 5 ether}(
                    _sortedOwners(), 1 days, 2, POST_GUARD, nextSalt++, t, v, d
                ))
        );

        // Queue a tx
        w.execute(address(sink), 1 ether, "", _sign(w, address(sink), 1 ether, "", _pks2()));
        uint32 n = w.nonce() - 1;

        // Warp past delay but within deadman timeout
        vm.warp(block.timestamp + 1 days);
        w.executeQueued(address(sink), 1 ether, "", n);

        // Heartbeat should be reset to current timestamp
        (,, uint256 last) = DeadmanSwitch(POST_GUARD).configs(address(w));
        assertEq(last, block.timestamp);
    }

    // ═══════════════════════════════════════════
    //          FAST FORWARD TESTS
    // ═══════════════════════════════════════════

    function _deployTimelockedWithForward() internal returns (Multisig) {
        (address[] memory t, uint256[] memory v, bytes[] memory d) =
            _callArrays(address(cancelMod), abi.encodeCall(TimelockExecutor.enableForward, (true)));
        vm.deal(address(this), 5 ether);
        return Multisig(
            payable(factory.createWithCalls{value: 5 ether}(
                    _sortedOwners(), 1 days, 2, address(cancelMod), nextSalt++, t, v, d
                ))
        );
    }
}
