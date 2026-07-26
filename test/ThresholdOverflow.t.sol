// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "forge-std/Test.sol";
import "../src/Multisig.sol";

/// @dev Regression test for the leftclaw review's H-2.
///
/// `execute()` reads `threshold` into a `uint16` local and then computes
/// `_threshold * 65` — uint16 arithmetic, inside the function-wide `unchecked`
/// block, so the product wraps modulo 65536. At threshold 1009 the length check
/// demands 49 bytes while the verification loop still walks 1009 slots, reading
/// to offset 65,584. No `sigs` value satisfies both, so the owner-signed path is
/// permanently unusable.
///
/// `isValidSignature()` and `TimelockExecutor.forward()` widen to `uint256`
/// before the same multiplication and are unaffected — which is what makes this
/// an owner lockout rather than a full brick, and why an attacker-held executor
/// would become unremovable.
///
/// Two prior reviews looked at this region and put the break point at 65,536
/// owners, dismissing it as beyond the block gas limit. The real figure is 65x
/// lower and fits in a mainnet block, which is what these tests pin down.
contract ThresholdOverflowTest is Test {
    MultisigFactory factory;
    uint256 nextSalt;

    function setUp() public {
        factory = new MultisigFactory();
    }

    function _owners(uint256 n) internal pure returns (address[] memory arr) {
        arr = new address[](n);
        for (uint256 i; i < n; ++i) {
            arr[i] = address(uint160(i + 2)); // ascending, all above SENTINEL
        }
    }

    function _deploy(uint256 n, uint256 threshold) internal returns (Multisig) {
        return Multisig(payable(factory.create(_owners(n), 0, threshold, address(0), nextSalt++)));
    }

    /// The arithmetic itself, in the exact shape `execute()` uses it.
    function test_H2_Uint16MultiplyWraps() public pure {
        unchecked {
            uint16 ok = 1008;
            uint16 wrapped = 1009;
            assertEq(uint256(ok * 65), 65_520, "1008 is the last safe threshold");
            assertEq(uint256(wrapped * 65), 49, "1009 wraps to 49 instead of 65,585");
            assertEq(uint256(uint16(1010) * 65), 114, "and keeps wrapping above that");
            // Widening first — what isValidSignature() and forward() do — is correct.
            assertEq(uint256(wrapped) * 65, 65_585, "uint256 math gives the true product");
        }
    }

    /// At 1008 the signature path still behaves normally: a wrong-length blob is
    /// rejected against the true, unwrapped requirement.
    function test_H2_ThresholdAtBoundaryStillSane() public {
        Multisig w = _deploy(1008, 1008);
        assertEq(w.threshold(), 1008);
        // 49 bytes is meaningless here; the check wants 65,520.
        vm.expectRevert(Multisig.InvalidSig.selector);
        w.execute(address(0xBEEF), 0, "", new bytes(49));
    }

    /// At 1009 no signature blob can satisfy both the wrapped length check and
    /// the unwrapped loop bound. Both candidate lengths fail.
    function test_H2_ThresholdAboveBoundaryIsUnsatisfiable() public {
        Multisig w = _deploy(1009, 1009);
        assertEq(w.threshold(), 1009);

        // The true requirement, 1009 * 65, fails the wrapped check.
        vm.expectRevert(Multisig.InvalidSig.selector);
        w.execute(address(0xBEEF), 0, "", new bytes(65_585));

        // The wrapped requirement passes the check, then the loop reads past the
        // end of the 49-byte blob and reverts on the calldata slice.
        vm.expectRevert();
        w.execute(address(0xBEEF), 0, "", new bytes(49));

        // Nothing in between works either.
        vm.expectRevert(Multisig.InvalidSig.selector);
        w.execute(address(0xBEEF), 0, "", new bytes(65 * 100));
    }

    /// The asymmetry that makes this an owner lockout rather than a full brick:
    /// ERC-1271 widens correctly, so it still enforces the true length.
    function test_H2_IsValidSignatureUnaffected() public {
        Multisig w = _deploy(1009, 1009);
        // Rejected for being the wrong length against 65,585 — not against 49.
        vm.expectRevert(Multisig.InvalidSig.selector);
        w.isValidSignature(keccak256("x"), new bytes(49));
    }

    /// And the executor bypass skips the broken check entirely, which is why an
    /// attacker-held executor on such a wallet could never be removed.
    function test_H2_ExecutorBypassStillWorks() public {
        address exec = address(0xE0E0);
        Multisig w = Multisig(payable(factory.create(_owners(1009), 0, 1009, exec, nextSalt++)));
        vm.deal(address(w), 1 ether);

        address sink = address(0x5117);
        vm.prank(exec);
        w.execute(sink, 1 ether, "", "");
        assertEq(sink.balance, 1 ether, "executor moves funds while owners cannot act at all");
    }
}
