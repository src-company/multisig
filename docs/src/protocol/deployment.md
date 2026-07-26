# Deployment

There are two ways to get a wallet, and they answer different questions. A
factory clone is **custody**: a new address with no superuser, which is what a
treasury needs. An EIP-7702 delegation is **capability**: the address you already
have, plus batching, contract signatures, an optional delay and optional
co-signers — with the original key still able to do anything. Many accounts want
the second long before they need the first.

## Factory clones

```solidity
MultisigFactory.create(
    address[] calldata owners,   // strictly ascending
    uint32 delay,                // seconds; 0 = no timelock
    uint256 threshold,           // 1..owners.length
    address executor,            // address(0) for none
    uint256 salt
) returns (address wallet)
```

`create` deploys a deterministic CREATE2 clone and calls `init` on it. The clone
is a 45-byte PUSH0 minimal proxy, adapted from Solady's `LibClone`:

```
0x5f5f365f5f37365f73 <20-byte implementation> 5af43d5f5f3e6029573d5ffd5b3d5ff3
```

Because the runtime code is fixed and the implementation address is a constant,
**every wallet's code is byte-identical and can be checked against the audited
build directly** — see [Security](security.md#verifying-a-deployment).

### The salt rule

```solidity
require(salt >> 96 == 0 || salt >> 96 == uint160(msg.sender), SaltDoesNotStartWith());
```

The top 20 bytes of the salt must be either the zero address or the caller's own
address. The caller-bound form is the one with a security property: it makes the
counterfactual address unclaimable by anyone else, which is what lets an address
be funded *before* it is deployed. The zero-prefix form is open — anyone can
deploy to a zero-prefixed candidate, so a pre-funded one can be taken. This is an
accepted design tradeoff (F-1), and the [interface mines sender-bound salts
exclusively](../dapp/guardrails.md).

Because the factory address, the implementation address and the salt are all
chain-independent, the same `(deployer, salt)` produces the same wallet address on
every chain the factory is deployed to.

### Deploying with module setup

```solidity
MultisigFactory.createWithCalls(owners, delay, threshold, executor, salt, targets, values, datas)
```

This is how a wallet gets configured at the moment it is born, at its own CREATE2
address, without a signature round. The mechanism is a deliberate temporary
privilege:

1. `create` runs with **the factory itself** as the executor — so the factory can
   call `execute` and skip signature verification.
2. Each `(target, value, data)` triple is executed in order, as the wallet.
3. A final `execute` self-call sets the *real* executor, ending the privilege.

Two consequences worth planning around. Every call the factory makes goes through
`execute`, so **the wallet's nonce starts at `targets.length + 1`**, not zero.
And every call is made *by the wallet*, which is what makes this the right place
to claim an on-chain name or register with a singleton module — the resulting
ownership sits with the wallet, not the deployer.

The post-init calls are one list, not one call, so independent options compose:

```solidity
// Deploy a 2-of-n wallet with AllowlistGuard configured as its executor
address[] memory targets = new address[](1);
uint256[] memory values  = new uint256[](1);
bytes[]   memory datas   = new bytes[](1);
targets[0] = guard;
datas[0] = abi.encodeCall(AllowlistGuard.set, (usdc, IERC20.transfer.selector, true));
factory.createWithCalls(owners, 0, 2, guard, salt, targets, values, datas);
```

Any of these calls reverting takes the whole deployment down with it, including
the mined salt and the gas. Treat the call list as part of the transaction's risk,
not as a set of independent best-effort steps.

## EIP-7702 delegation

An existing EOA can point its code at the implementation instead of deploying
beside it:

1. Submit a `SET_CODE_TX` authorising the Multisig implementation, and call
   `init(owners, delay, threshold, executor)` in the same transaction. `init`
   accepts `msg.sender == address(this)`, which is the whole of what makes this
   path work.
2. The account now answers `execute`, `batch`, `delegateCall`, ERC-1271
   `isValidSignature` and the ERC-721/1155 receive callbacks.
3. Configuration is reachable through the normal setters — and the delegating key
   satisfies `onlySelf` directly, so it can call them without a signature round.

Nothing is deployed and nothing is transferred. The address, its history, its
holdings and its name stay where they are.

### The key remains a superuser

This is the property that decides whether the path is appropriate. The delegating
EOA never stops being an EOA:

- It can send ordinary transactions that touch none of this logic.
- It satisfies every `onlySelf` function directly — `setThreshold`, `addOwner`,
  `setDelay`, `setExecutor`, `batch`, `delegateCall`.
- It can revoke the delegation at any time.

So the threshold is a floor for everyone **except** that key, and the delay
constrains the quorum route rather than the account. That is exactly right for
granting capability to a co-signer or an agent, and exactly wrong for a treasury
where no single key should be able to move funds. For that, deploy a clone — a
clone has no superuser.

The useful shape this enables is a 2-of-2 where the owners are the account itself
plus one other key. The account's own slot is filled by the [sender
bypass](signatures.md#the-sender-bypass), so exactly one signature is ever
collected and pressing send *is* half the quorum. Pointed at an agent's key as the
second owner, the agent can prepare, sign and submit whatever it likes and can
complete nothing alone. The direction matters: **you** must hold the delegating
key, because inverted, the quorum protects nothing.

### Configuration is effectively permanent

Revoking a delegation does not clear the storage it wrote. The owners, threshold
and nonce survive, and `init` refuses to run twice, so a delegated account cannot
be re-initialised from scratch. Ordinary reconfiguration still works — the setters
remain reachable — but the reset does not. The same slot written by some *other*
delegate is the same hazard in reverse: this implementation should not be pointed
at an account that has previously carried a different one.

Authorisation and `init` are both per chain. The same EOA elsewhere is a plain EOA
until delegated and initialised there, with its own independent owner set and
nonce. Since the EIP-712 domain binds the account address and the live chain id,
signatures collected for a delegated account cannot be aimed at a clone, at
another account, or at the same account on another chain.

## Live addresses

| Contract                   | Address                                                                                                                        |
|----------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| `MultisigFactory`          | [`0x000000000e8CB9ed9DC2114d79d9215eacb9cB07`](https://contractscan.xyz/contract/0x000000000e8CB9ed9DC2114d79d9215eacb9cB07)    |
| `Multisig` (implementation) | [`0xD54cb65224410F3Ff97a8E72f363f224419f4FB0`](https://contractscan.xyz/contract/0xD54cb65224410F3Ff97a8E72f363f224419f4FB0)    |
| `TimelockExecutor`         | [`0x00000000a72A30AdBf38e14d36BCE2610ec3973F`](https://contractscan.xyz/contract/0x00000000a72A30AdBf38e14d36BCE2610ec3973F)    |

Deployed via
[SafeSummoner](https://contractscan.xyz/contract/0x00000000004473e1f31C8266612e7FD5504e6f2a)
on Ethereum, Base, Arbitrum, Optimism, Sepolia and Base Sepolia. The interface
additionally targets MegaETH; see [the dapp's chain list](../dapp/overview.md#chains).

> **Warning:** none of these three singletons has a withdrawal path, and the
> implementation is never initialised, so it has no owners who could authorise
> one. **ETH or tokens sent directly to any of them are unrecoverable by anyone,
> permanently.** Value passed to `create()` / `createWithCalls()` is unaffected —
> the factory forwards it into the CREATE2 as the new wallet's opening balance.
> (Shred Security L-2, GPT-5.6 L-04.)
