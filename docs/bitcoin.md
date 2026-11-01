# Bitcoin vaults

How Bitcoin fits beside the EVM vaults, what was taken from Tacit, and what a timelock can and cannot mean without a contract.

## The model

| | EVM vault | Bitcoin vault |
|---|---|---|
| The vault is | a contract at an address | a descriptor; each address is a hash of one derivation of it |
| Owners are read from | the chain | the descriptor. The chain says nothing until the first spend |
| Changing owners | a transaction | a new address, and a sweep to it |
| Replay protection | a nonce | a signature names the coins it spends |
| A proposal is | a row in Postgres plus EIP-712 signatures | a PSBT, in a Postgres queue found by a hash of the descriptor |
| A proposal closes when | it executes or is cancelled | any of its coins is spent |
| Losing the record | re-read it from the chain | **the coins are stuck, even with every key** |

The descriptor is `tr(NUMS/<0;1>/*,multi_a(k,[fp/path]xpub/<0;1>/*,…))`. `NUMS` is the BIP-341 point `H` written as an extended key with an all-zero chain code, because BIP-388 cannot express a bare point; every child is `H` plus a public tweak, so it stays provably unspendable. Every spend therefore reveals its leaf and shows k signatures. It costs more than a key-path spend and reveals the owners when it spends, as an EVM vault always does. In exchange each owner signs alone, offline, in any order. MuSig2 and FROST would hide the policy, but both need signers online together for nonces.

Keys are sorted by xpub, so the same owners in any order are the same vault. `multi_a` is used rather than `sortedmulti_a` because miniscript, which the delayed leaf needs, has only the former.

Receive and change walk separate chains and a scan stops after 20 unused addresses. A key on both leaves walks `<2;3>` on the second, as BIP-388 requires. The embedded key lives at `m/87'/coin'/0'`.

Why extended keys: a hardware wallet finds its key by fingerprint and path, and refuses change it cannot prove is its own. Static keys could not offer either.

**An owner needs no embedded key.** Anyone holding `[fingerprint/path]xpub` can be an owner: copy the PSBT, sign it in any wallet that handles Taproot script paths, and paste the result back. The page also exports the BIP-388 wallet policy that Ledger registers.

## The queue

Proposals are shared as on Ethereum, and the rule is the same. They are readable by anyone who can compute the vault, which for a mirrored vault is anyone, since its owners and their handles are public. They are also signed-transaction drafts, so assume amounts and payees are public. The rule: `POST /btc-proposal` admits a PSBT only with a valid owner signature for that descriptor, and merges it with the stored copy. Links and pasted PSBTs still work, so a hardware wallet owner needs no connection and the queue being down loses nothing.

Nothing in the table is believed. Each client re-reads every PSBT against its own policy. There is no status column, because spent coins are what end a proposal, and the chain says that. Dismiss only hides a proposal in one browser: on Bitcoin a signed proposal stays valid until its coins move, so cancelling for everyone means spending them.

## The same owners as an Ethereum vault

The deployment wizard offers Bitcoin beside the other chains, and every vault's dashboard links to its Bitcoin twin once all its owners are ready. Nothing is deployed there and nothing needs remembering at deploy time, because the twin is a function of the owners and threshold.

A Bitcoin vault can be derived from an Ethereum vault. `getOwners()` and `threshold()` come from the contract, and each owner supplies a signed handle. Owners are sorted, so everyone holding the same handles reaches the same descriptor, and no one has to create it.

Each owner must take part once. A Bitcoin owner key comes from that owner's signature, so it cannot be computed from an address. An Ethereum public key could be recovered from a past transaction, but no Ethereum wallet can produce the signature a Bitcoin script needs, so coins sent to it could never move.

The handle has to carry proof. It holds the Ethereum address's signature over the Bitcoin key, in a message separate from the one that derives the key: the first is published, the second must never leave the page. Without proof, anyone could put an owner's address beside their own key and take that seat.

Limits:

- It is a snapshot. The dashboard link is worked out from the current owners, so changing owners or the threshold on Ethereum moves it to a new Bitcoin vault, while coins stay in the old one and removed owners keep their seat there. The dashboard says so if it saw the earlier one. Sweep the coins across. Any Ethereum vaults with the same owners and threshold share one Bitcoin twin.
- The EVM timelock does not carry over, for the reasons under Timelocks.
- Contract owners, such as a Safe, cannot take part, because they cannot make a repeatable signature.
- The owner list comes from one RPC. A lying RPC could name different owners, so the page shows them before creating anything.
- The first handle for an address stays: a later one is ignored, so a twin's address cannot be moved or rolled back by republishing. Handles do not prove the publisher holds the Bitcoin key, so an owner can burn their own seat. Handles are published to `btc_owner_handles` by `POST /handle`, which checks the signature with the same code the dapp runs. Every client checks them again on reading, so the table can lose a handle but cannot forge one.

## What came from Tacit

Tacit's `tacit1` address is bech32m over `[version][flags][lanes]`, and its embedded key is a hash of a wallet signature over a fixed message. `src-company/tacit` and `z0r0z/tacit` are identical in these modules.

- **Taken: the lane encoding.** An owner handle is `msig1…` (`tmsig1…` on signet): a required Bitcoin lane (fingerprint, path, chain code, key) and an optional Ethereum address lane, a lane proving that address signed the key, and unknown lanes skipped by old readers. The HRP differs per network, so a key from the wrong network is refused at the paste. The Ethereum lane alone is a label; only the proof lane makes it a fact.
- **Taken: signature-derived keys,** including asking twice and refusing a wallet that does not repeat itself. This is how an Ethereum wallet becomes a Bitcoin owner, since no Ethereum wallet can sign a BIP-341 sighash.
- **Not taken: the `tacit1` address itself.** It has scan and pool lanes a vault has no use for, and spending from it would mean asking for Tacit's identity message here. That signature controls all of a person's Tacit funds, so this app must never request it. The message here is its own, so the two keys are unrelated.
- **Not taken: hand-written transaction code.** `dapp/btc.min.js` is `@scure/btc-signer`. Only the witness for a multi_a leaf is assembled here, because the library's finalizer does not cover a delayed one.

**The cost of the embedded key.** It sits in page memory while signing. A hardware wallet protects the derivation, not each Bitcoin spend, and any site that gets an owner to sign the same text has that key. For a multisig this is a real step down from the EVM side, where a Ledger confirms every signature. It is acceptable for one key of several. An owner who wants the hardware guarantee uses the PSBT route instead, which never touches this key.

## Timelocks

The EVM timelock has four properties: k owners **queue** a transaction; the delay runs **from the proposal**; anyone can see it and owners can **cancel**; unanimity skips the delay.

Bitcoin has two relevant opcodes. `OP_CHECKSEQUENCEVERIFY` counts from when a coin confirmed. `OP_CHECKLOCKTIMEVERIFY` compares to a fixed height. Neither knows about proposals, and without a covenant no script can restrict where a coin goes, so a queue step cannot be forced: keys able to move a coin into the queue can move it anywhere.

| Approach | Delay from proposal | Cancel | Trustless | Interaction | Status |
|---|---|---|---|---|---|
| **Recovery path:** k-of-n now, r-of-m after `d` | n/a | n/a | yes | none | **built** |
| **Hold:** all owners now, k-of-n on coins older than `d` | no, from arrival | no | yes | none | **built** |
| Co-signer: k-of-n + service key, with a slow escape leaf | yes | yes | no, but the service alone cannot spend | online service | not built |
| Presigned unvault (Revault shape) | yes | yes, presigned | yes | **all n owners, per coin** | not built |
| CTV or OP_VAULT | yes | yes | yes | none | not active on mainnet |

- **Recovery** is exact: it is `DeadmanSwitch` and `SocialRecovery`, enforced by consensus. The price is that a coin left idle past `d` opens the second path, so an idle vault must move coins to itself to reset the clock.
- **Hold** has the same routing as `TimelockExecutor` and much weaker protection. A coin older than `d` has no delay left, so it suits lock-ups and not a treasury at rest. The page says this before anyone picks it.
- **Co-signer** is the shortest route to the EVM experience: the service signs only `d` after a proposal, and refuses once cancelled. It adds a trust assumption this project has so far avoided: if the service and k owners collude, the delay is gone.
- **Presigned** is the only trustless route today. All owners presign an unvault and a cancel for every coin, one offline owner stops new deposits being spendable, and presigned fees need anchors. It is not simple, and it is a separate piece of work.
- **Covenants.** CTV had a 2026 activation client, and miner signalling was reported at 0% in May 2026. Nothing should be built on it yet. A vault cannot gain a leaf later, so adopting one would be a sweep to a new address.

## Threat notes

- A proposal comes from someone else. `inspect` derives everything shown from the PSBT and refuses inputs outside this vault, unknown paths, non-default sighashes, any locktime, any version but 2, any sequence but the path's own, repeated coins, finalized inputs, and signatures that do not verify.
- The address shown is the bytes signed: an output whose script does not re-encode exactly is refused. A non-minimal push would otherwise read as the payee and be spendable by anyone.
- Signing happens on a transaction rebuilt from the reviewed fields, with one leaf and this key's seat found by xpub. A descriptor's fingerprint and path are unverifiable text, so altering them cannot stop an embedded owner signing.
- A vault address past the scan gap is refused rather than called change.
- A vault opened from a link or a pasted descriptor is not saved and shows no receive address until the owner has compared every full key, per path, because the sender chose those keys.
- A key is derived from a canonical signature, so v as 0/1, v as 27/28 and the 64-byte form give one key.
- A PSBT's derivations only say where to look. Change is re-derived from the policy, so a stranger's address cannot pose as change.
- Merging takes signatures only. Another owner's file cannot change what a proposal says, and a signer that rewrites metadata (Bitcoin Core adds every leaf and reorders the tree) does no harm. Only signatures for the leaf being spent count.
- Amounts in a PSBT are claims, but BIP-341 signs every input's amount, so understating one to hide a fee gives signatures the network rejects.
- An Esplora server can lie about coins and fee estimates. It can make a proposal that cannot confirm, suggest a fee up to the 1000 sat/vB ceiling (review warns above 200), or steer an address to be reused. A scan that puts a vault past the 20-address gap must be confirmed by the second operator, so one explorer alone cannot steer change out of reach, but two colluding could; such coins are found by a wide rescan in a descriptor wallet. Broadcast compares the returned txid to one computed here. It cannot make anyone sign outputs the review does not show.
- Two proposals over one coin cannot both land. The page checks before broadcast and calls the loser void.
- `bitcoin.html` has its own CSP: scripts from `'self'` only, and connections only to `mempool.space`, `blockstream.info`, the Ethereum RPCs, our API, the WalletConnect relay and `api.tacit.finance`. Those hosts accept data, so the CSP narrows a theft and does not prevent one. Google Fonts' stylesheet is the one third-party file on this page.
- `@scure/btc-signer` was audited by cure53 at 0.3.0 (2023) and self-audited at 2.2.0 (April 2026). This page runs 2.4.1, which neither audit covers, and its UTXO module is unaudited (it is not used here).

## Tacit assets

Vaults hold sats. Anyone can send a Tacit note to a vault address, and a vault can neither read it nor publish an opening, because a note's blinding comes from a private key a vault does not have. It is still spendable on Bitcoin, and spending it as sats burns the asset, so the danger is losing it, not being unable to move it. So: never send Tacit assets to a vault, and anything that arrives is set aside.

Every coin's creating transaction is checked for a Tacit envelope, which works from any explorer and misses nothing. Coins that trip it go to `POST api.tacit.finance/outpoints/classify`, which clears false alarms and names the asset. Only `plain` releases a coin: `asset`, `unverified`, a missing entry or any failure leaves it set aside and retries. The check runs again on a proposal's inputs before signing. The full contract is `docs/VAULT-INTEGRATION.md` in the Tacit repo. Holding notes in a vault would be its own design.

## Not done

- **Mainnet opened before these were done.** It is open by the owner's decision, with a warning on the page. `MAINNET` in `bitcoin-app.js` is the switch.
- **A real device.** Interoperability is proven with Bitcoin Core as the outside signer, on regtest. No Ledger, Coldcard, Trezor or Sparrow has signed one of these PSBTs, and whether each accepts a `multi_a` Taproot policy with an xpub internal key has to be tried per device. Ledger registration from this page (WebHID) is not built; the policy export is untested on a device.
- A real signet spend. The page has read live signet, but the funded flow has only run against a mocked explorer.
- Bitcoin wallets signing vault spends directly. UniSat, Xverse and Leather derive a key held in the page; only UniSat's shape is tested, against a simulated wallet.
- The passkey signer Tacit has. A passkey is bound to its domain, so the same passkey on `multisig.software` and the IPFS gateway gives different keys.
- Independent review. Do this before mainnet use at any size.
