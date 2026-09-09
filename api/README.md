# Signed proposal and metadata admission

New proposals must carry an EIP-712 transaction signature from a current vault
owner. `proposals.cjs` recomputes the digest from the exact submitted transaction
and the registered vault's chain/address, recovers the proposer, and checks
ownership using a server-configured RPC. It never trusts the database owner list.
Smart-account owners may instead use the existing on-chain approval route: the
service checks both current ownership and `approved(owner, digest)` at the same
block before accepting the canonical approval slot.

The service calls PostgREST with a short-lived, server-only JWT for the restricted
`proposal_writer` role. That role can execute only `propose_tx`; it has no direct
table privileges. The RPC stores the proposal and first signature atomically.
Anonymous direct calls and the legacy unsigned RPC are disabled. There is no
SIWE login and no additional wallet prompt for ordinary proposals: the dapp
already signs these transactions.

## Signed metadata writes

A vault name and an owner label are the only two things the coordination
database holds that no later read of the chain can reconstruct. Every other
column is a cache that the next page load re-derives and repairs, so an
anonymous overwrite of one is noise; an overwrite of these two is permanent.

`POST /metadata` takes `{ wallet_id, kind, subject, value, issued_at, signature }`,
where `kind` is `name` or `label` and `subject` is the owner a label belongs to
(the zero address for a name). The service recovers the signer from an EIP-712
`Metadata` signature over the vault's own domain, confirms `isOwner()` against
the vault at the current block, and only then calls `set_wallet_name` or
`set_owner_label` with a `metadata_writer` token. Neither RPC takes a caller
argument; the function name is chosen by the verifier, never by the request.

`Metadata` is a distinct primary type from `Execute`, so a transaction signature
cannot be presented as a rename, or a rename as a transaction. `issued_at` is
bounded to five minutes either side of service time, so a captured signature is
not a standing permission to rewrite a label. A replay inside that window
rewrites the same field with the same value. This costs one wallet prompt per
rename or relabel, which is new: these edits used to be unauthenticated.

## Signed unsign

`POST /action` takes `{ tx_id, action: "unsign", issued_at, signature }` and
retracts the caller's own signature from a live proposal. The vault and the
digest are read from the stored proposal, never taken from the request, so a
signature cannot be aimed at a vault it does not name. The service recovers the
signer from an EIP-712 `Action` signature, confirms `isOwner()` on chain, and
calls `signed_remove_signature` with an `action_writer` token.

`Action` is a third primary type alongside `Execute` and `Metadata`, so none of
the three can be replayed as another, and `issued_at` is bounded the same five
minutes either side of service time.

This is stricter than the `remove_signature` it replaces, not merely
authenticated: the row deleted is the recovered signer's own, so no caller can
strip a co-signer's signature. The old RPC allowed exactly that on the strength
of a named owner, which was enough to hold a vault below quorum indefinitely
without ever touching the chain. It is off the anonymous grant list.

## Deployment

1. Deploy `multisig-proposals` from `render.yaml`, keeping the existing dapp until
   the database migration is ready. The service needs Node 22, `PGRST_URL`, the
   same `PGRST_JWT_SECRET` as PostgREST, `PROPOSAL_RPC_URLS` (a JSON map from chain
   IDs to trusted HTTPS RPC URLs), and `PROPOSAL_ORIGINS` (comma-separated dapp
   origins). The Blueprint shares the secret between backend services only.
2. Apply `db/schema.sql`, then `db/roles.sql`, as the database owner. **Both, in
   that order, every time.** `roles.sql` creates `proposal_writer` and
   `metadata_writer` and is what moves the unauthenticated writes off `anon`;
   a database with a current schema and no roles file applied is one where the
   verifier cannot write and the anonymous RPCs still can.

   Apply the whole file. Do not lift individual functions out of it, however
   contained the change looks. The functions are not self-contained: several
   upsert `ON CONFLICT` onto expression indexes defined hundreds of lines above
   them, and PostgreSQL accepts an `ON CONFLICT` whose target index does not
   exist at the time the function is created — it raises `42P10` later, on the
   first row that reaches it. A function installed without its index therefore
   deploys clean and fails on live traffic, and the same trap runs the other
   way: dropping a superseded constraint without installing the function that
   stopped using it breaks a function that was working. `schema.sql` is written
   to be re-applied in full, and re-applying it is cheaper than either.
3. Reload the PostgREST schema cache with `NOTIFY pgrst, 'reload schema';`.
   PostgREST resolves RPCs against a cache built at connection time, so a
   function whose signature changed is invisible — and reported as a missing
   function — until this runs. Adding or replacing a function without it is the
   failure that looks like the service being broken.
4. Deploy the updated dapp promptly. If the service hostname differs, update
   `PROPOSAL_API_URL` and the dapp's CSP `connect-src` before building.
5. Verify an unsigned direct PostgREST proposal is denied, a non-owner signature
   is denied, and an owner-signed proposal appears with its first signature.
   Then verify `rpc/set_owner_label` and `rpc/set_wallet_name` are denied to
   `anon`, and that `rpc/deployment_status` reports `roles_applied` and
   `writes_verified` true with a `schema_version` at or above the
   `REQUIRED_SCHEMA_VERSION` the dapp carries.

This rollout can briefly interrupt proposals between steps 2 and 3; it fails
closed. Rollbacks should keep the restricted grants in place. Re-enabling the
old anonymous proposal endpoint restores the vulnerability.

`GET /health` is a process liveness check, not a database or RPC readiness check.
Requests are bounded to 72 KiB, 32 simultaneous requests per instance, and timed
backend calls. Existing SQL proposal rate and storage limits still apply.

## Verification and limits

Run `node --test test/proposals.test.js test/pgquery.test.js`, then the full
`node --test` and `node build.js`. Run real database coverage with
`MULTISIG_TEST_PG=1 node --test test/schema.test.js` against a local scratch
PostgreSQL server (see that harness for connection settings).

The RPC provider is trusted for chain identity, ownership, and approval reads;
RPC failures reject admission. Ownership can change after verification, so the
dapp and contract must continue checking current ownership at use/execution.
An existing valid signature can be relayed for its exact transaction; this is
intentional and does not let the relayer forge a different transaction.
Descriptions are unsigned metadata and are not proof of transaction intent.
Legacy rows are not retrospectively authenticated by this migration.

Everything that destroys or attributes is verified: proposal insertion, both
metadata writes, adding a signature, retracting one, and retiring a proposal.
Two verification styles, chosen by what the write actually claims.

**Signature-verified** — the claim is about identity, so a signature settles it.
`propose_tx`, `set_wallet_name`, `set_owner_label`, `signed_remove_signature`
and `signed_add_signature`. Adding a signature costs no extra prompt: the
signature is the credential and is already in the request.

**Chain-verified** — the claim is about the chain, so the chain settles it and no
signature is needed. `reconcile_tx` retires a proposal only when the vault's
nonce is strictly past it, which makes the proposal unexecutable by anyone. This
is what `cancel_tx` and `prune_tx` became: both were called from reconciliation,
where the client writes back what it just read and `loadVaultQueue` prunes
superseded rows in a loop, so a wallet prompt would have fired on ordinary page
loads. A proposal at the current nonce is refused with 409 however it is
described.

Still anonymous, and not yet migrated: `mark_executed`, `mark_queued`,
`record_approval`, `sync_wallet_state` and `register_wallet`. Do not describe the
whole database as authenticated. The first two are chain-verifiable on the same
pattern as `reconcile_tx` and are the obvious next step. `register_wallet` cannot
require ownership at all — a vault is registered by whoever opens it, who may be
looking rather than signing — so its exposure is bounded by refusing to write
metadata onto a vault that already exists, and by the dashboard keeping only
vaults whose on-chain owner set contains the viewer.

What makes that a bounded problem rather than the same one is that every column
those RPCs touch is re-derived from chain on the next load, so the damage is
noise and delay rather than anything permanent — which is exactly the property
names and labels lacked, and why they were moved first. `register_wallet` fills
an absent name or label and never replaces a stored one, so re-registration is
not a way back around this. Keep client signature validation and chain
reconciliation enabled; they are what makes the residual recoverable.

References: [PostgREST 12 authentication](https://docs.postgrest.org/en/v12/references/auth.html),
[Render Blueprint configuration](https://render.com/docs/blueprint-spec).
