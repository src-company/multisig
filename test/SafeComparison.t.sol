// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "forge-std/Test.sol";
import "../src/Multisig.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
}

interface ISafe {
    function setup(
        address[] calldata _owners,
        uint256 _threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);

    function execTransactionFromModule(address to, uint256 value, bytes memory data, uint8 operation)
        external
        returns (bool);

    function enableModule(address module) external;
    function domainSeparator() external view returns (bytes32);
    function nonce() external view returns (uint256);
}

interface IMultiSend {
    function multiSend(bytes memory transactions) external payable;
}

contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Apples-to-apples gas comparison against canonical Safe v1.4.1.
///
/// Run: forge test --mc SafeComparisonTest -vv
///
/// Safe's own `npm run benchmark` reports `receipt.gasUsed` — full transaction gas.
/// `Gas.t.sol` in this repo reports `gasleft()` deltas — execution only, warm storage,
/// unfunded recipient. Those two numbers are not comparable, so this suite measures
/// both wallets itself, under identical conditions:
///
///   - Safe runs as the exact canonical mainnet bytecode, codehash-verified against the
///     safe-deployments registry, so there is no compiler or optimizer confound.
///   - Cold storage, with the transaction's `to` account pre-warmed, as EIP-2929
///     specifies for a real top-level transaction.
///   - The delegatecall target behind the wallet (our implementation, Safe's singleton)
///     is cold on both sides. So is the ETH recipient.
///   - The recipient already exists and holds a balance, so neither side pays the
///     25,000 gas new-account cost. This mirrors Safe's own benchmark, which pre-funds
///     its target for the same reason.
///   - Transfers are measured in *steady state*, after one warm-up transaction. Safe
///     stores `nonce` in a dedicated slot, so its very first transaction pays a 20,000
///     gas zero-to-nonzero SSTORE that no later transaction pays. This multisig packs
///     `nonce` alongside `threshold`/`ownerCount`/`delay` in an already-nonzero slot and
///     never pays it. Measuring only the first transaction would overstate our advantage
///     by ~17,000 gas, so both first-transaction and steady-state costs are reported.
///   - Full transaction gas adds 21,000 intrinsic plus EIP-7623 calldata cost, computed
///     from the identical calldata each wallet would receive on-chain.
///
/// Residual bias: the measured call is made from this contract rather than as a true
/// top-level transaction, so both sides carry the outer CALL's memory-copy cost. That
/// is under 100 gas, and slightly larger for Safe, whose calldata is larger.
contract SafeComparisonTest is Test {
    // Canonical Safe v1.4.1 deployments (same address on every supported chain).
    address constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_FALLBACK = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    address constant SAFE_MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;

    bytes32 constant SAFE_CODEHASH = 0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4;

    bytes32 constant SAFE_TX_TYPEHASH = keccak256(
        "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
    );
    bytes32 constant EXECUTE_TYPEHASH = keccak256("Execute(address target,uint256 value,bytes data,uint32 nonce)");

    uint256 constant TRANSFER_VALUE = 0.01 ether;

    MultisigFactory factory;
    MockERC20 token;

    address recipient = address(0xBEEF);
    address[] batchRecipients;
    address module = address(0x1234);

    uint256[] pks;
    uint256 saltCounter;
    uint256 sink;

    function setUp() public {
        vm.etch(SAFE_SINGLETON, vm.parseBytes(vm.readFile("test/fixtures/safe-v1.4.1/singleton.hex")));
        vm.etch(SAFE_FACTORY, vm.parseBytes(vm.readFile("test/fixtures/safe-v1.4.1/factory.hex")));
        vm.etch(SAFE_FALLBACK, vm.parseBytes(vm.readFile("test/fixtures/safe-v1.4.1/fallback.hex")));
        vm.etch(SAFE_MULTISEND_CALL_ONLY, vm.parseBytes(vm.readFile("test/fixtures/safe-v1.4.1/multisend.hex")));

        // Fail loudly if the fixture is not the audited mainnet Safe.
        assertEq(SAFE_SINGLETON.codehash, SAFE_CODEHASH, "Safe singleton fixture is not canonical v1.4.1");

        factory = new MultisigFactory();
        token = new MockERC20();

        uint256[] memory raw = new uint256[](5);
        raw[0] = 0xA1;
        raw[1] = 0xB2;
        raw[2] = 0xC3;
        raw[3] = 0xD4;
        raw[4] = 0xE5;
        for (uint256 i; i < 5; ++i) {
            for (uint256 j = i + 1; j < 5; ++j) {
                if (vm.addr(raw[i]) > vm.addr(raw[j])) (raw[i], raw[j]) = (raw[j], raw[i]);
            }
        }
        for (uint256 i; i < 5; ++i) {
            pks.push(raw[i]);
        }

        vm.deal(recipient, 1 ether);
        token.mint(recipient, 1e18);
        for (uint256 i; i < 3; ++i) {
            address r = address(uint160(0xB00B00 + i));
            batchRecipients.push(r);
            vm.deal(r, 1 ether);
        }
        vm.deal(address(this), 10_000 ether);
    }

    // ───────── intrinsic + calldata accounting (EIP-7623) ─────────

    function _txGas(bytes memory data, uint256 execGas) internal pure returns (uint256) {
        uint256 zeros;
        uint256 nonzeros;
        for (uint256 i; i < data.length; ++i) {
            if (data[i] == 0) ++zeros;
            else ++nonzeros;
        }
        uint256 standard = 21_000 + zeros * 4 + nonzeros * 16 + execGas;
        uint256 floor = 21_000 + (zeros + nonzeros * 4) * 10;
        return standard > floor ? standard : floor;
    }

    // ───────── measurement ─────────

    /// @dev Reproduces a real top-level transaction's access-list state, then measures
    ///      execution gas. `target` is the transaction's `to`: EIP-2929 pre-warms the
    ///      account but not its storage, so it is cooled and then re-warmed with a
    ///      BALANCE read. Everything in `cold` stays cold, as it would on-chain.
    function _measure(address caller, address target, bytes memory data, address[] memory cold)
        internal
        returns (uint256 execGas)
    {
        vm.cool(target);
        for (uint256 i; i < cold.length; ++i) {
            vm.cool(cold[i]);
        }

        sink += target.balance; // re-warm the tx `to` account, leaving its storage cold

        vm.prank(caller, caller);
        uint256 g = gasleft();
        (bool ok,) = target.call(data);
        execGas = g - gasleft();
        require(ok, "measured call reverted");
    }

    function _cold(address a) internal pure returns (address[] memory c) {
        c = new address[](1);
        c[0] = a;
    }

    function _cold(address a, address b) internal pure returns (address[] memory c) {
        c = new address[](2);
        c[0] = a;
        c[1] = b;
    }

    function _report(string memory label, bytes memory oursData, uint256 oursExec, bytes memory safeData, uint256 safeExec)
        internal
    {
        emit log_string(label);
        emit log_named_uint("  ours exec ", oursExec);
        emit log_named_uint("  safe exec ", safeExec);
        emit log_named_uint("  ours TXGAS", _txGas(oursData, oursExec));
        emit log_named_uint("  safe TXGAS", _txGas(safeData, safeExec));
    }

    // ───────── wallet construction ─────────

    function _owners(uint256 n) internal view returns (address[] memory o) {
        o = new address[](n);
        for (uint256 i; i < n; ++i) {
            o[i] = vm.addr(pks[i]);
        }
    }

    function _deployOurs(uint256 n, uint256 threshold) internal returns (Multisig w) {
        w = Multisig(payable(factory.create{value: 10 ether}(_owners(n), 0, threshold, address(0), saltCounter++)));
        token.mint(address(w), 1e24);
    }

    function _safeInitializer(uint256 n, uint256 threshold) internal view returns (bytes memory) {
        return abi.encodeCall(
            ISafe.setup, (_owners(n), threshold, address(0), "", SAFE_FALLBACK, address(0), 0, payable(address(0)))
        );
    }

    function _deploySafe(uint256 n, uint256 threshold) internal returns (address s) {
        s = ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(
            SAFE_SINGLETON, _safeInitializer(n, threshold), saltCounter++
        );
        vm.deal(s, 10 ether);
        token.mint(s, 1e24);
    }

    // ───────── signing ─────────

    function _signOurs(Multisig w, address to, uint256 value, bytes memory data, uint256 k)
        internal
        view
        returns (bytes memory sigs)
    {
        bytes32 h = keccak256(
            abi.encodePacked(
                "\x19\x01",
                w.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(EXECUTE_TYPEHASH, to, value, keccak256(data), w.nonce()))
            )
        );
        return _pack(h, k);
    }

    function _safeStructHash(address safe, address to, uint256 value, bytes memory data, uint8 operation)
        internal
        view
        returns (bytes32)
    {
        bytes memory tail = abi.encode(
            operation, uint256(0), uint256(0), uint256(0), address(0), address(0), ISafe(safe).nonce()
        );
        return keccak256(abi.encodePacked(abi.encode(SAFE_TX_TYPEHASH, to, value, keccak256(data)), tail));
    }

    function _signSafe(address safe, address to, uint256 value, bytes memory data, uint8 operation, uint256 k)
        internal
        view
        returns (bytes memory sigs)
    {
        bytes32 h = keccak256(
            abi.encodePacked("\x19\x01", ISafe(safe).domainSeparator(), _safeStructHash(safe, to, value, data, operation))
        );
        return _pack(h, k);
    }

    function _pack(bytes32 h, uint256 k) internal view returns (bytes memory sigs) {
        sigs = new bytes(k * 65);
        for (uint256 i; i < k; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], h);
            uint256 off = i * 65;
            assembly {
                let p := add(add(sigs, 0x20), off)
                mstore(p, r)
                mstore(add(p, 0x20), s)
                mstore8(add(p, 0x40), v)
            }
        }
    }

    // ───────── calldata builders ─────────

    function _oursCall(Multisig w, address to, uint256 value, bytes memory data, uint256 k)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodeCall(Multisig.execute, (to, value, data, _signOurs(w, to, value, data, k)));
    }

    function _safeCall(address s, address to, uint256 value, bytes memory data, uint8 op, uint256 k)
        internal
        view
        returns (bytes memory)
    {
        bytes memory sigs = _signSafe(s, to, value, data, op, k);
        return _encodeExecTransaction(to, value, data, op, sigs);
    }

    function _encodeExecTransaction(address to, uint256 value, bytes memory data, uint8 op, bytes memory sigs)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            ISafe.execTransaction, (to, value, data, op, 0, 0, 0, address(0), payable(address(0)), sigs)
        );
    }

    /// @dev Sends one unmeasured transaction so the following one is measured in the
    ///      steady state a wallet actually operates in (nonce already nonzero).
    function _warmUp(Multisig w, address s, uint256 k) internal {
        address caller = vm.addr(pks[0]);
        vm.prank(caller);
        (bool a,) = address(w).call(_oursCall(w, recipient, 1 wei, "", k));
        require(a, "ours warm-up failed");
        vm.prank(caller);
        (bool b,) = s.call(_safeCall(s, recipient, 1 wei, "", 0, k));
        require(b, "safe warm-up failed");
    }

    // ───────── ETH transfer ─────────

    function _runTransfer(uint256 n, uint256 k, bool steadyState, string memory label) internal {
        Multisig w = _deployOurs(n, k);
        address s = _deploySafe(n, k);
        if (steadyState) _warmUp(w, s, k);

        address caller = vm.addr(pks[0]);
        bytes memory oursData = _oursCall(w, recipient, TRANSFER_VALUE, "", k);
        uint256 oursExec = _measure(caller, address(w), oursData, _cold(factory.implementation(), recipient));

        bytes memory safeData = _safeCall(s, recipient, TRANSFER_VALUE, "", 0, k);
        uint256 safeExec = _measure(caller, s, safeData, _cold(SAFE_SINGLETON, recipient));

        _report(label, oursData, oursExec, safeData, safeExec);
    }

    function test_transfer_1of1() public {
        _runTransfer(1, 1, true, "ETH transfer 1-of-1 (steady state)");
    }

    function test_transfer_2of2() public {
        _runTransfer(2, 2, true, "ETH transfer 2-of-2 (steady state)");
    }

    function test_transfer_2of3() public {
        _runTransfer(3, 2, true, "ETH transfer 2-of-3 (steady state)");
    }

    function test_transfer_3of3() public {
        _runTransfer(3, 3, true, "ETH transfer 3-of-3 (steady state)");
    }

    function test_transfer_3of5() public {
        _runTransfer(5, 3, true, "ETH transfer 3-of-5 (steady state)");
    }

    function test_transfer_2of3_firstTransaction() public {
        _runTransfer(3, 2, false, "ETH transfer 2-of-3 (first transaction, Safe pays nonce 0->1)");
    }

    // ───────── ERC20 transfer ─────────

    function test_erc20Transfer_2of3() public {
        Multisig w = _deployOurs(3, 2);
        address s = _deploySafe(3, 2);
        _warmUp(w, s, 2);

        address caller = vm.addr(pks[0]);
        bytes memory inner = abi.encodeCall(MockERC20.transfer, (recipient, 1e18));

        bytes memory oursData = _oursCall(w, address(token), 0, inner, 2);
        uint256 oursExec = _measure(caller, address(w), oursData, _cold(factory.implementation(), address(token)));

        bytes memory safeData = _safeCall(s, address(token), 0, inner, 0, 2);
        uint256 safeExec = _measure(caller, s, safeData, _cold(SAFE_SINGLETON, address(token)));

        _report("ERC20 transfer 2-of-3 (steady state)", oursData, oursExec, safeData, safeExec);
    }

    // ───────── batch: built-in `batch` vs MultiSendCallOnly ─────────

    function test_batch3_2of3() public {
        Multisig w = _deployOurs(3, 2);
        address s = _deploySafe(3, 2);
        _warmUp(w, s, 2);

        address caller = vm.addr(pks[0]);

        address[] memory targets = new address[](3);
        uint256[] memory values = new uint256[](3);
        bytes[] memory datas = new bytes[](3);
        bytes memory packed;
        for (uint256 i; i < 3; ++i) {
            targets[i] = batchRecipients[i];
            values[i] = TRANSFER_VALUE;
            datas[i] = "";
            packed = abi.encodePacked(packed, uint8(0), batchRecipients[i], TRANSFER_VALUE, uint256(0));
        }

        bytes memory inner = abi.encodeCall(Multisig.batch, (targets, values, datas));
        bytes memory oursData = _oursCall(w, address(w), 0, inner, 2);

        address[] memory coldOurs = new address[](4);
        coldOurs[0] = factory.implementation();
        for (uint256 i; i < 3; ++i) {
            coldOurs[i + 1] = batchRecipients[i];
        }
        uint256 oursExec = _measure(caller, address(w), oursData, coldOurs);

        bytes memory ms = abi.encodeCall(IMultiSend.multiSend, (packed));
        bytes memory safeData = _safeCall(s, SAFE_MULTISEND_CALL_ONLY, 0, ms, 1, 2);

        address[] memory coldSafe = new address[](5);
        coldSafe[0] = SAFE_SINGLETON;
        coldSafe[1] = SAFE_MULTISEND_CALL_ONLY;
        for (uint256 i; i < 3; ++i) {
            coldSafe[i + 2] = batchRecipients[i];
        }
        uint256 safeExec = _measure(caller, s, safeData, coldSafe);

        _report("Batch 3 ETH transfers 2-of-3 (ours: batch / Safe: MultiSendCallOnly)", oursData, oursExec, safeData, safeExec);
    }

    // ───────── module path: executor vs execTransactionFromModule ─────────

    function test_modulePath() public {
        // ours: executor set at deployment, calls need no signatures
        Multisig w = Multisig(
            payable(factory.create{value: 10 ether}(_owners(3), 0, 2, module, saltCounter++))
        );

        // safe: module enabled through a normal owner transaction, then warmed up
        address s = _deploySafe(3, 2);
        address caller = vm.addr(pks[0]);
        bytes memory enable = abi.encodeCall(ISafe.enableModule, (module));
        vm.prank(caller);
        (bool ok,) = s.call(_safeCall(s, s, 0, enable, 0, 2));
        require(ok, "enableModule failed");

        // both wallets have now executed one transaction
        vm.prank(module);
        (bool a,) = address(w).call(abi.encodeCall(Multisig.execute, (recipient, 1 wei, "", "")));
        require(a, "ours module warm-up failed");
        vm.prank(module);
        (bool b,) = s.call(abi.encodeCall(ISafe.execTransactionFromModule, (recipient, 1 wei, "", 0)));
        require(b, "safe module warm-up failed");

        bytes memory oursData = abi.encodeCall(Multisig.execute, (recipient, TRANSFER_VALUE, "", ""));
        uint256 oursExec = _measure(module, address(w), oursData, _cold(factory.implementation(), recipient));

        bytes memory safeData = abi.encodeCall(ISafe.execTransactionFromModule, (recipient, TRANSFER_VALUE, "", 0));
        uint256 safeExec = _measure(module, s, safeData, _cold(SAFE_SINGLETON, recipient));

        _report("Module/executor ETH transfer (steady state, no signatures)", oursData, oursExec, safeData, safeExec);
    }

    // ───────── timelock (no Safe equivalent without the Zodiac Delay Modifier) ─────────

    function test_timelock_2of3() public {
        Multisig w = Multisig(
            payable(factory.create{value: 10 ether}(_owners(3), 1 days, 2, address(0), saltCounter++))
        );
        address caller = vm.addr(pks[0]);

        // warm-up so the queue measurement is in steady state, like the transfer rows
        vm.prank(caller);
        (bool ok,) = address(w).call(_oursCall(w, recipient, 1 wei, "", 2));
        require(ok, "warm-up failed");

        bytes memory queueData = _oursCall(w, recipient, TRANSFER_VALUE, "", 2);
        uint32 queuedNonce = w.nonce();
        uint256 queueExec = _measure(caller, address(w), queueData, _cold(factory.implementation(), recipient));

        vm.warp(block.timestamp + 1 days);

        bytes memory execData =
            abi.encodeCall(Multisig.executeQueued, (recipient, TRANSFER_VALUE, "", queuedNonce));
        uint256 execExec = _measure(caller, address(w), execData, _cold(factory.implementation(), recipient));

        emit log_string("Timelock 2-of-3 (built in; Safe needs the Zodiac Delay Modifier)");
        emit log_named_uint("  queue        exec ", queueExec);
        emit log_named_uint("  queue        TXGAS", _txGas(queueData, queueExec));
        emit log_named_uint("  executeQueued exec ", execExec);
        emit log_named_uint("  executeQueued TXGAS", _txGas(execData, execExec));
    }

    // ───────── deployment ─────────

    function _runDeploy(uint256 n, uint256 k, string memory label) internal {
        address caller = vm.addr(pks[0]);

        bytes memory oursData = abi.encodeCall(MultisigFactory.create, (_owners(n), 0, k, address(0), saltCounter++));
        uint256 oursExec = _measure(caller, address(factory), oursData, _cold(factory.implementation()));

        bytes memory safeData = abi.encodeCall(
            ISafeProxyFactory.createProxyWithNonce, (SAFE_SINGLETON, _safeInitializer(n, k), saltCounter++)
        );
        uint256 safeExec = _measure(caller, SAFE_FACTORY, safeData, _cold(SAFE_SINGLETON, SAFE_FALLBACK));

        _report(label, oursData, oursExec, safeData, safeExec);
    }

    function test_deploy_1of1() public {
        _runDeploy(1, 1, "Deploy 1-of-1");
    }

    function test_deploy_2of2() public {
        _runDeploy(2, 2, "Deploy 2-of-2");
    }

    function test_deploy_2of3() public {
        _runDeploy(3, 2, "Deploy 2-of-3");
    }

    function test_deploy_3of5() public {
        _runDeploy(5, 3, "Deploy 3-of-5");
    }

    /// @dev Safe without a fallback handler loses EIP-1271 signature validation and the
    ///      ERC-721/1155 receiver hooks, which this multisig has built in. Recorded so
    ///      the deployment comparison cannot be dismissed as fallback-handler overhead.
    function test_deploy_2of3_safeWithoutFallbackHandler() public {
        address caller = vm.addr(pks[0]);
        bytes memory init = abi.encodeCall(
            ISafe.setup, (_owners(3), 2, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
        bytes memory safeData =
            abi.encodeCall(ISafeProxyFactory.createProxyWithNonce, (SAFE_SINGLETON, init, saltCounter++));
        uint256 exec = _measure(caller, SAFE_FACTORY, safeData, _cold(SAFE_SINGLETON));

        emit log_string("Deploy 2-of-3, Safe with no fallback handler");
        emit log_named_uint("  safe exec ", exec);
        emit log_named_uint("  safe TXGAS", _txGas(safeData, exec));
    }

    // ───────── code size ─────────

    function test_codeSize() public {
        emit log_named_uint("ours  implementation runtime bytes", factory.implementation().code.length);
        emit log_named_uint("ours  factory        runtime bytes", address(factory).code.length);
        emit log_named_uint("safe  singleton      runtime bytes", SAFE_SINGLETON.code.length);
        emit log_named_uint("safe  proxy factory  runtime bytes", SAFE_FACTORY.code.length);
        emit log_named_uint("safe  fallback hdlr  runtime bytes", SAFE_FALLBACK.code.length);
        emit log_named_uint("safe  multisend      runtime bytes", SAFE_MULTISEND_CALL_ONLY.code.length);
    }
}
