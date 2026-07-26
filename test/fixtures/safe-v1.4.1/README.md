# Safe v1.4.1 bytecode fixtures

Runtime bytecode of the canonical Safe v1.4.1 deployments, fetched from Ethereum mainnet
with `eth_getCode` and used by [`SafeComparison.t.sol`](../../SafeComparison.t.sol) via
`vm.etch`.

Using the deployed bytecode rather than a local recompile means the gas comparison
measures the Safe that people actually use, with no compiler-version or optimizer-setting
difference between the two sides.

| File | Contract | Address | Bytes |
|---|---|---|---|
| `singleton.hex` | `Safe` | `0x41675C099F32341bf84BFc5382aF534df5C7461a` | 23,579 |
| `factory.hex` | `SafeProxyFactory` | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | 3,054 |
| `fallback.hex` | `CompatibilityFallbackHandler` | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | 5,637 |
| `multisend.hex` | `MultiSendCallOnly` | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | 410 |

Addresses are from the `@safe-global/safe-deployments` registry and are the same on every
supported chain. The test asserts the singleton's codehash equals

```
0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4
```

which is the `canonical` codehash that registry records for v1.4.1, so a corrupted or
substituted fixture fails the suite rather than silently changing the benchmark.

## Refreshing

```sh
curl -s -X POST "$ETH_RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["<address>","latest"]}' \
  | jq -r .result > <file>.hex
```

Write the hex string with no trailing newline — `vm.parseBytes` rejects one.
