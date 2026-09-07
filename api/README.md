# Signed proposal admission

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

## Deployment

1. Deploy `multisig-proposals` from `render.yaml`, keeping the existing dapp until
   the database migration is ready. The service needs Node 22, `PGRST_URL`, the
   same `PGRST_JWT_SECRET` as PostgREST, `PROPOSAL_RPC_URLS` (a JSON map from chain
   IDs to trusted HTTPS RPC URLs), and `PROPOSAL_ORIGINS` (comma-separated dapp
   origins). The Blueprint shares the secret between backend services only.
2. Apply `db/schema.sql`, then `db/roles.sql`, as the database owner. Reload the
   PostgREST schema cache with `NOTIFY pgrst, 'reload schema';`. This immediately
   disables unsigned proposal insertion. Old dapp versions will fail to propose.
3. Deploy the updated dapp promptly. If the service hostname differs, update
   `PROPOSAL_API_URL` and the dapp's CSP `connect-src` before building.
4. Verify an unsigned direct PostgREST proposal is denied, a non-owner signature
   is denied, and an owner-signed proposal appears with its first signature.

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

This change secures proposal insertion only. Other existing anonymous RPCs can
still rename coordination records, change statuses, or remove/overwrite stored
signatures. Do not describe the whole database as authenticated. Keep client
signature validation and chain reconciliation enabled.

References: [PostgREST 12 authentication](https://docs.postgrest.org/en/v12/references/auth.html),
[Render Blueprint configuration](https://render.com/docs/blueprint-spec).
