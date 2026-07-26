// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "forge-std/Test.sol";
import "../src/Multisig.sol";

/// @dev The route-substitution residual (GPT-5.6 H-01 / leftclaw M-2) survives
/// every client-side mitigation for one reason: `TimelockExecutor` authorises
/// against the *wallet's* own `Execute` digest, so the bundle it needs is also a
/// valid bundle for `Multisig.execute()`. Anyone holding it picks the route.
///
/// The executor bypass needs no bundle at all — `msg.sender == executor` skips
/// the signature block outright. So an executor that authorises against its
/// *own* digest leaves nothing in existence that can be replayed against the
/// wallet. A second `Multisig`, deployed from the same factory, is exactly that.
///
/// These tests pin the pattern down with contracts that are already live:
///
///   W = 2-of-3, delay 2 days, executor = C   (ordinary vault)
///   C = 3-of-3, delay 0, no executor         (unanimity council, same owners)
///
/// The result is unanimity-bypasses-timelock semantics — the same thing
/// `forwardEnabled` offers — but ungriefable, because C's signatures live in C's
/// EIP-712 domain and W will never accept them.
contract CouncilExecutorTest is Test {
    MultisigFactory factory;
    Multisig W; // the vault
    Multisig C; // the council, installed as W's executor

    uint256 pk1 = 0xA1;
    uint256 pk2 = 0xB2;
    uint256 pk3 = 0xC3;
    address owner1;
    address owner2;
    address owner3;

    address attacker = address(0xBAD);
    address payee = address(0xF00D);

    bytes32 constant EXECUTE_TYPEHASH = keccak256("Execute(address target,uint256 value,bytes data,uint32 nonce)");
    uint32 constant DELAY = 2 days;
    uint256 nextSalt;

    function setUp() public {
        owner1 = vm.addr(pk1);
        owner2 = vm.addr(pk2);
        owner3 = vm.addr(pk3);
        factory = new MultisigFactory();

        // Council first — the vault needs its address at init.
        C = Multisig(payable(factory.create(_owners(), 0, 3, address(0), nextSalt++)));
        vm.deal(address(this), 100 ether);
        W = Multisig(payable(factory.create{value: 100 ether}(_owners(), DELAY, 2, address(C), nextSalt++)));
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

    function _pks(uint256 n) internal view returns (uint256[] memory out) {
        uint256[] memory all = new uint256[](3);
        (all[0], all[1], all[2]) = (pk1, pk2, pk3);
        all = _sortedPKs(all);
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = all[i];
        }
    }

    /// Sign against `w`'s own domain — the point of the pattern is that W and C
    /// produce different digests for identical parameters.
    function _sign(Multisig w, address to, uint256 value, bytes memory data, uint256[] memory pks)
        internal
        view
        returns (bytes memory sigs)
    {
        bytes32 hash = keccak256(
            abi.encodePacked(
                "\x19\x01",
                w.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(EXECUTE_TYPEHASH, to, value, keccak256(data), w.nonce()))
            )
        );
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

    /// What the council submits: C executes a call to W.execute(...), and W sees
    /// its own executor calling, so it skips signatures and the delay.
    function _viaCouncil(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(Multisig.execute, (target, value, data, ""));
    }

    // ───────── The timelock still works ─────────

    /// Installing the council does not weaken ordinary operation: a normal
    /// 2-of-3 proposal still queues for the full delay.
    function test_Council_OrdinaryProposalStillQueues() public {
        bytes memory sigs = _sign(W, payee, 1 ether, "", _pks(2));
        W.execute(payee, 1 ether, "", sigs);
        assertEq(payee.balance, 0, "did not execute immediately");
        assertGt(W.queued(_hash(W, payee, 1 ether, "", 0)), 0, "queued for the delay");
    }

    // ───────── Emergency action, ungriefable ─────────

    /// Unanimous council signatures move W immediately, with no wallet-digest
    /// bundle existing anywhere.
    function test_Council_UnanimousEmergencyActionIsImmediate() public {
        bytes memory inner = _viaCouncil(payee, 5 ether, "");
        bytes memory cSigs = _sign(C, address(W), 0, inner, _pks(3));

        C.execute(address(W), 0, inner, cSigs);
        assertEq(payee.balance, 5 ether, "vault moved funds immediately via its executor");
    }

    /// The core property. Council signatures are bound to C's EIP-712 domain, so
    /// there is no route that lets them touch W directly — the substitution the
    /// TimelockExecutor design permits simply has no analogue here.
    function test_Council_SignaturesCannotBeReplayedAgainstTheVault() public {
        bytes memory inner = _viaCouncil(payee, 5 ether, "");
        bytes memory cSigs = _sign(C, address(W), 0, inner, _pks(3));

        // Same bytes, aimed at the vault: W computes a different digest, so the
        // recovered signers are not its owners.
        vm.prank(attacker);
        vm.expectRevert(Multisig.InvalidSig.selector);
        W.execute(address(W), 0, inner, cSigs);

        // And a threshold-sized truncation fares no better.
        bytes memory two = new bytes(2 * 65);
        for (uint256 i; i < 2 * 65; ++i) {
            two[i] = cSigs[i];
        }
        vm.prank(attacker);
        vm.expectRevert(Multisig.InvalidSig.selector);
        W.execute(address(W), 0, inner, two);
    }

    /// Front-running the council bundle is not a grief: C has no delay, so the
    /// only thing a copier can do with it is perform the action the owners
    /// already authorised, at their own gas cost.
    function test_Council_FrontRunningIsHarmless() public {
        bytes memory inner = _viaCouncil(payee, 5 ether, "");
        bytes memory cSigs = _sign(C, address(W), 0, inner, _pks(3));

        vm.prank(attacker);
        C.execute(address(W), 0, inner, cSigs);

        assertEq(payee.balance, 5 ether, "executed as intended, not queued");
        assertEq(W.queued(_hash(W, payee, 5 ether, "", 0)), 0, "nothing was forced into the queue");
    }

    // ───────── Cancellation, ungriefable ─────────

    /// A cancellation routed through the council cannot be pushed into the queue
    /// by anyone, because there is no wallet-digest bundle to replay.
    function test_Council_CancelCannotBeSuppressed() public {
        // A bad transfer reaches quorum and queues.
        bytes memory sigsBad = _sign(W, attacker, 50 ether, "", _pks(2));
        W.execute(attacker, 50 ether, "", sigsBad);
        bytes32 badHash = _hash(W, attacker, 50 ether, "", 0);
        assertGt(W.queued(badHash), 0, "malicious tx queued");

        // The council cancels it.
        bytes memory inner = _viaCouncil(address(W), 0, abi.encodeCall(Multisig.cancelQueued, (badHash)));
        bytes memory cSigs = _sign(C, address(W), 0, inner, _pks(3));

        // An attacker front-running with the same bytes just performs the cancel.
        vm.prank(attacker);
        C.execute(address(W), 0, inner, cSigs);

        assertEq(W.queued(badHash), 0, "cancelled before its ETA, with no route to delay it");
    }

    // ───────── The tradeoff, recorded ─────────

    /// The council's threshold governs both bypass and cancellation, so it is one
    /// dial rather than two: at 3-of-3 a bare 2-of-3 quorum cannot use the
    /// council for anything, which is what keeps W's timelock meaningful.
    function test_Council_ThresholdQuorumCannotUseTheCouncil() public {
        bytes memory inner = _viaCouncil(payee, 5 ether, "");
        bytes memory cSigs = _sign(C, address(W), 0, inner, _pks(2));

        vm.expectRevert(Multisig.InvalidSig.selector);
        C.execute(address(W), 0, inner, cSigs);
        assertEq(payee.balance, 0, "two of three cannot bypass the delay");
    }

    function _hash(Multisig w, address to, uint256 value, bytes memory data, uint32 nonce)
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
}
