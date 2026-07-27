// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../src/Multisig.sol";

/// A stand-in for a Coinbase Smart Wallet: a contract account with no private
/// key. It cannot produce an ECDSA signature over anything. What it can do is
/// send transactions, which is the whole of how it participates here.
contract SmartAccount {
    function call(address to, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call(data);
        require(ok, "inner call failed");
        return ret;
    }
}

/// Does a contract owner — the shape a basename routinely resolves to — actually
/// work as a signer on this vault, and does the dapp's chosen route for it hold?
contract SmartAccountOwnerTest is Test {
    MultisigFactory factory;
    SmartAccount smart;
    uint256 constant pkEoa = 0xA11CE;
    address eoa;
    uint256 salt;

    bytes32 constant EXECUTE_TYPEHASH = keccak256("Execute(address target,uint256 value,bytes data,uint32 nonce)");

    function setUp() public {
        eoa = vm.addr(pkEoa);
        smart = new SmartAccount();
        factory = new MultisigFactory();
    }

    function _vault(uint256 threshold) internal returns (Multisig w) {
        address[] memory owners = new address[](2);
        (owners[0], owners[1]) =
            address(smart) < eoa ? (address(smart), eoa) : (eoa, address(smart));
        return Multisig(payable(factory.create(owners, 0, threshold, address(0), salt++)));
    }

    function _hash(Multisig w, address target, uint256 value, bytes memory data, uint32 nonce)
        internal view returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", w.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(EXECUTE_TYPEHASH, target, value, keccak256(data), nonce))));
    }

    /// senderSig() from the dapp: r = the owner address, s = 0, v = 0.
    function _senderSig(address who) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(uint160(who))), bytes32(0), uint8(0));
    }

    function _ecdsa(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// A contract owner authorises on-chain, and the bundle it produces executes.
    function test_smartAccountOwnerApprovesOnChainAndExecutes() public {
        Multisig w = _vault(2);
        vm.deal(address(w), 1 ether);
        address payable dest = payable(address(0xBEEF));

        bytes32 digest = _hash(w, dest, 0.5 ether, "", 0);

        // The smart account calls approve() itself — a UserOp in production.
        smart.call(address(w), abi.encodeCall(Multisig.approve, (digest, true)));
        assertTrue(w.approved(address(smart), digest), "approval not recorded");

        // The bundle the dapp assembles: sender-sig for the contract owner,
        // ECDSA for the EOA, sorted ascending by signer as the vault requires.
        bytes memory sigs = address(smart) < eoa
            ? bytes.concat(_senderSig(address(smart)), _ecdsa(pkEoa, digest))
            : bytes.concat(_ecdsa(pkEoa, digest), _senderSig(address(smart)));

        w.execute(dest, 0.5 ether, "", sigs);
        assertEq(dest.balance, 0.5 ether, "transfer did not happen");
    }

    /// Without the on-chain approval the same bundle is rejected — the sender-sig
    /// is an assertion, not an authorisation.
    function test_senderSigWithoutApprovalIsRejected() public {
        Multisig w = _vault(2);
        vm.deal(address(w), 1 ether);
        address payable dest = payable(address(0xBEEF));
        bytes32 digest = _hash(w, dest, 0.5 ether, "", 0);

        bytes memory sigs = address(smart) < eoa
            ? bytes.concat(_senderSig(address(smart)), _ecdsa(pkEoa, digest))
            : bytes.concat(_ecdsa(pkEoa, digest), _senderSig(address(smart)));

        vm.expectRevert(Multisig.InvalidSig.selector);
        w.execute(dest, 0.5 ether, "", sigs);
    }

    /// The vault has no ERC-1271 path, so a contract owner can never be reached
    /// by a signature — which is exactly why the dapp must not store one.
    function test_noErc1271PathForOwners() public {
        Multisig w = _vault(2);
        address payable dest = payable(address(0xBEEF));
        bytes32 digest = _hash(w, dest, 0, "", 0);

        // A 65-byte blob that is not an ECDSA signature by the smart account —
        // the shape an ERC-1271 wallet's signature would arrive as.
        bytes memory bogus = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(28));
        bytes memory sigs = bytes.concat(bogus, _ecdsa(pkEoa, digest));

        vm.expectRevert(Multisig.InvalidSig.selector);
        w.execute(dest, 0, "", sigs);
    }

    /// A single-owner vault owned only by a smart account still works, so a
    /// basename-owned vault is not a brick.
    function test_soleSmartAccountOwnerCanExecute() public {
        address[] memory owners = new address[](1);
        owners[0] = address(smart);
        Multisig w = Multisig(payable(factory.create(owners, 0, 1, address(0), salt++)));
        vm.deal(address(w), 1 ether);
        address payable dest = payable(address(0xCAFE));

        bytes32 digest = _hash(w, dest, 0.25 ether, "", 0);
        smart.call(address(w), abi.encodeCall(Multisig.approve, (digest, true)));
        w.execute(dest, 0.25 ether, "", _senderSig(address(smart)));
        assertEq(dest.balance, 0.25 ether);
    }
}
