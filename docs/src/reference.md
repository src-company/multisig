# Contract Reference

The pages in this section are generated from the NatSpec and signatures in `src/`
by `forge doc`, so they always describe the code at the commit they were generated
from — every page links back to its exact source. They are API listings; the
reasoning behind the API is in the [protocol chapters](protocol/overview.md).

Regenerate them with `docs/regen.sh`; see `docs/README.md`.

## Wallet

| Contract | Source | Description |
|---|---|---|
| [`Multisig`](src/Multisig.sol/contract.Multisig.md) | `src/Multisig.sol` | The wallet: owners, threshold, timelock, executor, execution and signature verification |
| [`MultisigFactory`](src/Multisig.sol/contract.MultisigFactory.md) | `src/Multisig.sol` | CREATE2 clone factory, with and without post-init calls |

## Modules

| Contract | Source | Role |
|---|---|---|
| [`TimelockExecutor`](src/mods/TimelockExecutor.sol/contract.TimelockExecutor.md) | `src/mods/TimelockExecutor.sol` | Executor — cancel at threshold, forward and accelerate at unanimous |
| [`AllowlistGuard`](src/mods/AllowlistGuard.sol/contract.AllowlistGuard.md) | `src/mods/AllowlistGuard.sol` | Pre-guard over `(target, selector)` pairs |
| [`SpendingAllowance`](src/mods/SpendingAllowance.sol/contract.SpendingAllowance.md) | `src/mods/SpendingAllowance.sol` | Executor — periodic ETH allowance for one spender |
| [`SocialRecovery`](src/mods/SocialRecovery.sol/contract.SocialRecovery.md) | `src/mods/SocialRecovery.sol` | Executor — guardian propose/finalize with its own delay |
| [`DeadmanSwitch`](src/mods/DeadmanSwitch.sol/contract.DeadmanSwitch.md) | `src/mods/DeadmanSwitch.sol` | Post-guard + executor — beneficiary sweep after inactivity |

## Interfaces

| Interface | Source | Description |
|---|---|---|
| [`IMultisig`](src/mods/interfaces/IMultisig.sol/interface.IMultisig.md) | `src/mods/interfaces/IMultisig.sol` | The subset of the wallet that modules call |
