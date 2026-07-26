# Using the Interface

Four screens — dashboard, transaction builder, admin, create — plus the signing
flow that runs through all of them.

## Dashboard

Wallet selector tabs across the top, each with a status dot: green and pulsing when
something is executable, yellow when something needs *your* signature. Above the
tabs, a counter aggregates pending work across every wallet loaded — signatures
needed, ready to execute, ready to submit — so a wallet that needs attention does
not have to be found by clicking through.

The metadata line under the balance reads the packed slot: threshold ratio, timelock
duration (or **UNLOCKED** in yellow when `delay == 0`), chain, and a **FAST PATH**
marker when `forwardEnabled` is set.

With no wallets loaded, the empty state offers **CREATE VAULT** or loading an
existing wallet by address or by `.eth` / `.wei` / `.gwei` name. Owner addresses
reverse-resolve the same way: WNS (`.wei`) first, GNS (`.gwei`) as fallback, then
ENS.

### A delegated EOA loads like any wallet

An EOA [delegated under EIP-7702](../protocol/deployment.md#eip-7702-delegation)
answers the same ABI, so it loads by address and drives from the same screens:
proposals, signing, timelock, admin. It is badged **EIP-7702** rather than counted
as a clone — the code read back is `0xef0100` followed by the implementation
address, not the 45-byte clone — and the badge is there because the key behind it
can revoke the delegation at any time. A co-signer should read that before signing,
not after.

The app *operates* a delegated account; it does not create the delegation. The
`SET_CODE_TX` has to come from a wallet that supports EIP-7702 authorisations.

## Signing

Two ways to authorise, both counting toward threshold:

- **SIGN** (filled button) — off-chain EIP-712. Free, private, and it keeps the
  submitter binding that defends against
  [route substitution](../protocol/security.md#route-substitution).
- **APPROVE** (outline button) — an on-chain `approve(hash, true)`. Costs gas and is
  world-readable, but it is the only route open to a contract owner and the only one
  that needs no coordination service.

**UNSIGN** calls `approve(hash, false)`. Filled means primary action; outline means
secondary, or already done.

## Transaction lifecycle

```text
STANDARD PATH (delay > 0)
  NEEDS SIGS → SUBMIT → ETA countdown → READY → EXECUTE

CANCEL PATH (threshold sigs, via executor)
  QUEUED TX → CANCEL creates a new proposal → collect sigs → EXECUTE CANCEL

FAST PATH (all-owner sigs, opt-in, via executor)
  NEEDS SIGS → INSTANT EXECUTE  (or QUEUE WITH TIMELOCK)

UNLOCKED (delay = 0)
  NEEDS SIGS → EXECUTE
```

Cancel is a *new proposal* at the next nonce targeting `cancelQueued`, because
[cancellation is `onlySelf`](../protocol/timelock.md#cancellation). It needs
threshold signatures, executes immediately through the executor, and is marked
**VIA EXECUTOR** — it is never blocked by the sequential queue, since it takes the
parallel route.

The fast path appears only when every owner has signed *and* `enableForward` is
active, and it offers both **INSTANT EXECUTE** and **QUEUE WITH TIMELOCK** so the
submitter still chooses. Outbound unlock countdowns tick live.

## TX builder

Four modes.

**TRANSFER** — token selector scoped to the connected chain, with decimals handled
explicitly and a live preview of the raw units the transaction will actually carry.
For ERC-20s it states the encoding in words: `transfer(recipient, amount)` on the
token contract, not a value-bearing call to the recipient.

**NAME** — Ethereum mainnet only. Claims a free `<label>.id.wei` subdomain for the
wallet and points reverse resolution at it. Two calls:
`register(namehash('id.wei'), label)` on the `id.wei` registrar, which mints the
name to the caller so the name resolves *to* the wallet, and `setPrimaryName(id)` on
WNS, which makes the wallet answer *with* the name — the direction wallets and
explorers read. Both are made by the wallet, so the name is an NFT the wallet holds;
only a proposal reaching quorum can move it, and holding it grants nobody any power
over the wallet.

Where both calls are needed they are wrapped in the wallet's own `batch()`, so the
mint and the reverse record either both land or neither does. Availability is
checked by static-calling the exact `register()` that will run, *as the wallet* —
the registrar uses `_safeMint`, so that probe also answers whether this wallet's
code can receive the name at all. A name the wallet already holds drops the proposal
to `setPrimaryName` alone, since a second `register()` would revert and consume the
nonce doing it. Labels are restricted to Latin letters, digits, hyphen and
underscore, which is narrower than the registrar allows: the registrar accepts
zero-width and non-breaking spaces and mixed scripts, and a name whose whole purpose
is to be read before signing must not be able to look like a different name.

**CUSTOM** — raw target, ETH value with a live wei preview, and a calldata field.

**BATCH** — several calls, each with target, value and calldata, added and removed
dynamically, encoded as a single `batch()` self-call.

## Simulation

Every live proposal, and every transaction the builder is about to propose, can be
dry-run before anyone signs it. **SIMULATE** replays the call against the latest
block with `from` set to the wallet.

That `from` is the whole idea. A proposal's on-chain effect is
`target.call{value}(data)` with `msg.sender` the wallet — see
[`execute`](../protocol/overview.md) — so setting the sender to the wallet
reproduces the real call rather than approximating it. The wallet is already a
contract, so no code has to be injected to make it executable and no signatures have
to be forged: its own `batch()` and `isValidSignature` run as they will on the day.
A BATCH proposal simulates as the single `batch()` self-call it will be, in one EVM
frame, so state carries between its calls exactly as it will on-chain.

Nothing is signed and nothing is sent.

### What it reports

Pass or revert; the decoded revert reason, including the wallet's own custom errors,
which a bare provider would hand back as an undecoded blob; gas for the inner call;
and a ledger of everything that moves in or out of the wallet.

The ledger is built from the transaction's logs, and it covers ERC-20 amounts,
individual ERC-721 token ids, ERC-1155 ids from both `TransferSingle` and
`TransferBatch`, and native ETH. Each row is netted, so an asset that leaves and
returns within the same transaction is not reported as movement. Token ids are
listed individually rather than counted, because *which* NFT leaves a treasury is
the entire question.

### Guards are replayed

A wallet whose executor address carries the `0x1111` marker calls that executor
before execution, after it, or both, depending on which end of the address carries
the marker — see [Modules](../protocol/modules.md). A pre-guard that refuses stops
the transaction dead, and
[`AllowlistGuard`](../src/mods/AllowlistGuard.sol/contract.AllowlistGuard.md) on a
target nobody allowlisted is the shipped case.

Replaying only the inner call would therefore report PASS on a proposal the wallet
will refuse to run, so the hook calls go into the same simulated frame, in the order
the wallet makes them. A blocked proposal reads **BLOCKED BY GUARD** with the guard's
own reason, and names which end refused, so the reader looks at the allowlist rather
than at their balance. A passing simulation on such a wallet is tagged **GUARD OK**,
because a check worth running is worth showing when it succeeds.

One limit is inherent: the wallet forwards the real signature bundle to the hook as
its fourth argument, and at dry-run time that bundle does not exist yet, so empty
bytes are passed. Both shipped guards ignore the argument. A custom guard that
inspects signatures is the one case this can misjudge.

### What it cannot tell you

A simulation is one block's snapshot, and the panel stamps each result with the time
it was produced so a stale one never reads as fresher than it is.

- **State moves.** A proposal that passes now can revert when it is executed days
  later — the ordinary case for anything sitting in a timelocked queue. Re-run it
  before executing.
- **The gas figure is the inner call only.** The signature checks and the nonce
  write that `execute()` wraps around it are on top, and the panel labels the number
  accordingly rather than presenting it as the cost of the transaction.
- **An unfunded wallet reports a revert that is true today.** No balance overrides
  are applied. For a wallet that will be funded before its ETA, that revert is a
  timing artefact; for one that will not, it is the answer.
- **Not every RPC supports `eth_simulateV1`.** Without it the app falls back to
  `eth_call` plus `estimateGas`, which answers whether the call reverts but traces
  no assets. That result is labelled **REVERT-CHECK ONLY**, and the "nothing enters
  or leaves" wording is withheld, because a check that did not look for movement
  must not be read as having found none.

A simulation that reverts blocks nothing. The proposal can still be created, signed
and submitted; the panel exists to be read before signing, not to decide.

## Admin

Three sub-tabs. Every change here is `onlySelf`, so nothing applies directly —
each one is *proposed* as a transaction targeting the wallet's own address, and the
UI flashes PROPOSE rather than implying it took effect.

**POLICY** — threshold selector with a live CHANGED marker; delay in hours with a
diff preview; the executor address, labelled **TIMELOCK EXECUTOR (DEFAULT)** when it
is the canonical one. With a delay set and an executor installed, an
**EXECUTOR · INSTANT PATH** section exposes the `enableForward` toggle along with
what each route will then cost — `N/N` for instant, `threshold/N` for cancel.

**OWNERS** — the owner list with REMOVE buttons (never on your own row), and an add
form. `removeOwner` requires `ownerCount > threshold`, and the UI supplies the
linked-list predecessor pointer for you.

**HISTORY** — executed transactions with nonce, action type, decoded details and
time.

## Create

Owner addresses can be entered in any order; the app sorts them ascending before
submission, carrying each label with its address so labels cannot end up filed
against the wrong signer. Threshold auto-clamps to the owner count. Delay is entered
in hours, and setting it to zero shows an UNLOCKED warning and hides the fast-path
toggle, since there is no delay to bypass.

**Owner names resolve in the form.** An owner may be given as `.eth` / `.wei` /
`.gwei`, and the row then shows the address it resolves to, linked to the explorer of
the chain being deployed to. The owner set is the one part of a wallet that cannot be
corrected afterwards without a full multisig round, so it is not signed for while any
of it is still an unresolved string: DEPLOY stays disabled while a lookup is in
flight, and refuses a name that does not resolve, resolves to `0x0`/`0x1` (the
[sentinels](../protocol/overview.md#owners-as-a-linked-list)), or lands on an address
another row already holds. That last check is why resolution happens in the form
rather than at submission — two names, or a name and the address it points at, are
the same owner, and `init()` reverts on a repeat *after* the salt has been mined and
the gas paid. What the form resolved is what gets deployed: if a name repoints
between being reviewed and being signed for, the deploy stops rather than installing a
signer nobody saw.

**One wallet, many chains.** CLONE TO OTHER CHAINS deploys the same wallet to the
same address on every chain picked. Since the CREATE2 inputs are all
chain-independent, the candidate address is checked for existing code on *every*
selected chain before it is accepted — an address free here but taken on a clone
target would otherwise hand back a stranger's wallet as though the clone had
succeeded. Mixing mainnets and testnets in one go is allowed, and flagged.

**Review before any signature.** DEPLOY runs a read-only preflight: per chain, is the
factory there, does the factory name the audited implementation, does the connected
wallet hold gas, and — with instant execution on — is the `TimelockExecutor` there. A
chain that will not answer is reported as unchecked rather than ready. Every deploy
stops on this screen, clean preflights included, listing each owner at its resolved
address, the threshold, the timelock, whether instant execution is on and what that
grants, which factory call will be made, and the mined wallet address, so the address
funds will be sent to can be read before anything is signed. Deploys then run one
chain at a time, each needing a network switch and a signature. CANCEL returns to the
form intact; nothing is signed until PROCEED.

**Deploys are read back, not assumed.** Each chain is re-read after its transaction:
code present, code is the audited build, and the live wallet reports the owners,
threshold, delay and executor that were ordered. A chain that deploys but cannot be
read back is labelled **DEPLOYED · UNVERIFIED** rather than borrowing the word the
checked ones earned, and a chain that fails can be retried on its own without
redoing the ones that landed.

**A free on-chain name, if the wallet is named.** Typing a wallet name folds it into
a candidate `.id.wei` label and offers to claim it in the same transaction that
deploys the wallet. It is a checkbox and stays one — it costs nothing and grants
nobody anything. Availability is read live from the registrar, again in the preflight,
and once more immediately before the wallet prompt, because a `register` that reverts
takes the whole `createWithCalls()` down with it. If the name is gone by then, or
mainnet will not confirm it is free, the name is dropped and the wallet deploys
without it, reported rather than left silent. After the transaction lands the claim is
read back off WNS instead of inferred from the receipt. WNS is a mainnet contract, so
ticking the box adds Ethereum to the deploy — stated on the line before the tick, and
shown by Ethereum appearing ticked in the network panel, where unticking it cancels
the claim. Clones on other chains share the wallet's address, not its name.

**Clone a Safe.** The Safe mark beside OWNERS opens a one-field migration tool: give
it a Gnosis Safe by address or name and it copies that Safe's owners and threshold
into the form, labelling each signer with whatever name it reverse-resolves to. It is
read-only — `getOwners()` and `getThreshold()`, nothing written, no funds moved — and
the new wallet is a fresh deployment, so assets are transferred afterwards. Timelock,
instant execution and chain selections stay whatever you set. The Safe is read on the
network the form is deploying to; if it is not there, the tool reports which supported
chains it did find it on, and loading one of those switches the deploy to that chain.
A banner records the source Safe and undoes the clone in one click.

When `delay > 0`, an INSTANT EXECUTION toggle enables the fast path at deploy time,
which routes the deployment through
[`createWithCalls()`](../protocol/deployment.md#deploying-with-module-setup) to call
`enableForward(true)` on the `TimelockExecutor` as a post-init step.
