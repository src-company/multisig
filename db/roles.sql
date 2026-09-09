-- MULTISIG.software — PostgREST roles & grants
-- Run AFTER schema.sql, as the database owner, on your Render Postgres.
--
-- PostgREST uses authenticator, anon, and the restricted proposal_writer.
-- New proposals require verification by api/proposals.cjs. Other coordination
-- writes retain their existing anonymous RPC checks; they are not authenticated.

-- ── ROLES ────────────────────────────────────────────────────────

-- The login role PostgREST authenticates as. It holds no privileges of its
-- own; it switches into `anon` or the verified proposal service role per
-- request. NOINHERIT is required so privileges apply only after SET ROLE.
DO $$ BEGIN
  CREATE ROLE authenticator LOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- This role is used only by api/proposals.cjs after cryptographic verification.
DO $$ BEGIN
  CREATE ROLE proposal_writer NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT proposal_writer TO authenticator;
GRANT USAGE ON SCHEMA public TO proposal_writer;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM proposal_writer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM proposal_writer;
GRANT EXECUTE ON FUNCTION propose_tx(uuid, int, int, text, numeric, text, text, smallint, text, text, text, sig_type) TO proposal_writer;
REVOKE ALL ON FUNCTION propose_tx(uuid, int, int, text, numeric, text, text, smallint, text, text, text, sig_type) FROM PUBLIC;

-- Also used only by api/proposals.cjs, and only after it has recovered an
-- EIP-712 signature and confirmed isOwner() against the vault. Separate from
-- proposal_writer so a token minted for one cannot write the other: the two
-- reach different functions and are checked for different claims.
DO $$ BEGIN
  CREATE ROLE metadata_writer NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT metadata_writer TO authenticator;
GRANT USAGE ON SCHEMA public TO metadata_writer;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM metadata_writer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM metadata_writer;
GRANT EXECUTE ON FUNCTION set_wallet_name(uuid, text) TO metadata_writer;
GRANT EXECUTE ON FUNCTION set_owner_label(uuid, text, text) TO metadata_writer;
REVOKE ALL ON FUNCTION set_wallet_name(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_owner_label(uuid, text, text) FROM PUBLIC;

-- Retracting a signature. Separate again from the two above, so a token minted
-- to rename a vault cannot delete a signature: these roles exist to bound what
-- a stolen or mis-issued token can reach, and that only works if each holds one
-- kind of write.
DO $$ BEGIN
  CREATE ROLE action_writer NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT action_writer TO authenticator;
GRANT USAGE ON SCHEMA public TO action_writer;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM action_writer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM action_writer;
GRANT EXECUTE ON FUNCTION signed_remove_signature(uuid, text) TO action_writer;
GRANT EXECUTE ON FUNCTION signed_add_signature(uuid, text, text, sig_type) TO action_writer;
GRANT EXECUTE ON FUNCTION reconcile_tx(uuid, text) TO action_writer;
REVOKE ALL ON FUNCTION signed_remove_signature(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION signed_add_signature(uuid, text, text, sig_type) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_tx(uuid, text) FROM PUBLIC;

-- Recording a vault. Its own role again: registration writes rows nothing else
-- writes, and a token minted to register a vault must not reach a signature or
-- a name. api/proposals.cjs reads the vault's whole configuration from the
-- contract before calling, so an address with no code cannot be recorded.
DO $$ BEGIN
  CREATE ROLE registry_writer NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT registry_writer TO authenticator;
GRANT USAGE ON SCHEMA public TO registry_writer;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM registry_writer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM registry_writer;
GRANT EXECUTE ON FUNCTION register_wallet(int, text, text, numeric, text[], smallint, int, text, bigint, text, text, text[], int) TO registry_writer;
REVOKE ALL ON FUNCTION register_wallet(int, text, text, numeric, text[], smallint, int, text, bigint, text, text, text[], int) FROM PUBLIC;

-- Set / rotate the password out of band (keep it OUT of version control):
--   ALTER ROLE authenticator WITH PASSWORD '<strong-random-password>';
-- Then point PGRST_DB_URI at:
--   postgres://authenticator:<password>@<host>:<port>/<db>

-- The anonymous role every unauthenticated request runs as
-- (PGRST_DB_ANON_ROLE=anon).
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- authenticator is allowed to become anon.
GRANT anon TO authenticator;

-- ── SCHEMA ACCESS ────────────────────────────────────────────────

GRANT USAGE ON SCHEMA public TO anon;

-- ── READS (RLS still applies) ────────────────────────────────────
-- The read-only SELECT policies in schema.sql do the real gating; these
-- grants only make the tables/views visible to PostgREST. Views run as
-- their owner (security_invoker off), so granting the view is sufficient.

-- `approvals` and `config_log` are deliberately NOT here. Both are written by
-- the RPCs above and neither is ever read by the dapp — it re-reads approvals
-- from the vault itself (see chainCheckQueue) and does not surface the config
-- journal at all — so granting them only widened what an anonymous scrape
-- returns: config_log carries every owner addition and removal by address.
-- Revoked explicitly as well as omitted, because this file is applied to
-- databases that were set up when they were granted.
GRANT SELECT ON
  wallets, owners, transactions, signatures
TO anon;

REVOKE SELECT ON approvals, config_log FROM anon;

GRANT SELECT ON
  my_wallets, tx_summary, tx_history
TO anon;

-- Everything reachable above is world-readable, and that is a property of
-- running with no authentication rather than a decision about any one table:
-- with every request arriving as the same anonymous role there is no identity
-- to scope a row to, so the RLS policies can only say `true`. Vault addresses,
-- owner sets, proposal targets and amounts are public on chain anyway — but
-- owner LABELS, vault names, proposal descriptions and the collected signatures
-- are not, and they are readable here by anyone who knows the URL. SECURITY.md
-- already scopes the replay residual to "anyone reading the signature store";
-- that reader is the public. Scoping reads per-owner needs authenticated
-- requests (see the note at the end of this file).

-- Proposal insertion is separate: only proposal_writer can call propose_tx.
-- ── WRITES (SECURITY DEFINER functions only) ─────────────────────
-- Lock everything down first: no function is callable by default. Then
-- expose exactly the RPC surface the dapp uses. anon has NO direct
-- INSERT/UPDATE/DELETE — every mutation flows through these functions,
-- which run as their owner and enforce is_wallet_owner() checks.
-- (is_wallet_owner, is_wallet_writer, rate_gate, rate_sweep and client_ip are
-- intentionally NOT granted, so none of them is reachable as an /rpc/ endpoint;
-- the definer functions still call them internally as the owner. rate_gate in
-- particular must stay unreachable — a caller who could invoke it directly
-- could burn another vault's budget, turning the limiter into the DoS it
-- exists to prevent.)

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  mark_executed(uuid, bigint, text, text),
  -- Five arguments, matching schema.sql. This read `mark_queued(uuid, bigint,
  -- bigint, text)` — the signature schema.sql drops — so on a fresh database
  -- this single GRANT statement aborted on that line and NONE of the write
  -- functions below or above it were granted to anon. The dapp could read
  -- everything and write nothing.
  mark_queued(uuid, bigint, bigint, text, text),
  record_approval(uuid, int, text, text, boolean, bigint, text),
  sync_wallet_state(uuid, text, smallint, smallint, int, text, int, text[]),
  -- Read-only, and the one call that can tell an operator this file was never
  -- applied. It reports its own absence by 404ing, so it has to be reachable
  -- by exactly the role a browser arrives as.
  deployment_status()
TO anon;

-- update_wallet_name and update_owner_label are deliberately not in that list.
-- Both take the caller's address as an argument and check it against an owner
-- set that is public on chain, so as anon RPCs they are open to anyone willing
-- to name a real owner. Every other write in the list is re-derived from chain
-- on the next load and repairs itself; these two are not. A vault name and an
-- owner label exist only here, so an overwrite is the one kind of damage this
-- schema cannot undo, and that makes them the wrong pair to leave unauthenticated.
--
-- They stay revoked until they read the caller from a verified claim rather
-- than an argument — the JWT route the end of this file describes, which
-- api/proposals.cjs already implements for proposal admission. Re-granting them
-- to anon restores the hole; extend the verifier instead.
REVOKE EXECUTE ON FUNCTION
  update_wallet_name(uuid, text, text),
  update_owner_label(uuid, text, text, text)
FROM anon, PUBLIC;

-- remove_signature leaves the list for the same reason, one step behind. It
-- deletes a signature from a live proposal on the strength of a named owner, so
-- an anonymous caller could hold a vault below quorum indefinitely. Its
-- replacement, signed_remove_signature, removes only the signature belonging to
-- the address that signed the request.
REVOKE EXECUTE ON FUNCTION remove_signature(uuid, text) FROM anon, PUBLIC;

-- add_signature goes with it. It filed a signature against any owner's name
-- without that owner having signed anything — never a way to fake a quorum,
-- since the client recovers every signature against the chain's owner set
-- before counting it, but a way to put words in an owner's mouth in the record
-- the co-signers read. signed_add_signature verifies the signature it is given.
REVOKE EXECUTE ON FUNCTION add_signature(uuid, text, text, sig_type) FROM anon, PUBLIC;

-- cancel_tx and prune_tx go too. Both retired a live proposal on the strength of
-- a named owner, which is the plainest griefing this schema offered: the
-- co-signers lose the row they were collecting signatures on. Their replacement,
-- reconcile_tx, is reached only after the verifier has read the vault's nonce
-- and found the proposal strictly behind it — one that can never execute again,
-- so retiring it takes nothing from anyone.
REVOKE EXECUTE ON FUNCTION cancel_tx(uuid, text), prune_tx(uuid, text) FROM anon, PUBLIC;

-- register_wallet leaves too, and for a different reason from the rest: it never
-- could be signature-gated, since a vault is registered by whoever opens it and
-- that person may be reading rather than signing. Anonymous, it was a row-
-- creating endpoint with no ceiling on how many vaults may exist — storage
-- exhaustion with a rate limit in front of it rather than a defence. The
-- verifier now reads the vault's configuration from the contract, so only
-- genuinely deployed multisigs can be recorded, and those cost gas to create.
REVOKE EXECUTE ON FUNCTION
  register_wallet(int, text, text, numeric, text[], smallint, int, text, bigint, text, text, text[], int)
FROM anon, PUBLIC;

-- ── DEFAULTS ─────────────────────────────────────────────────────
-- Keep future objects from leaking to anon unless granted explicitly.
--
-- The FUNCTIONS line does not do this, and the belief that it did is what let
-- rate_gate ship as an anon-callable endpoint. Tested directly: after running
-- it, pg_default_acl holds no row for this role, and a function created
-- immediately afterwards is still EXECUTE-able by anon — a new function keeps
-- PostgreSQL's built-in PUBLIC=X, and REVOKE here does not displace it. Left in
-- place because it is harmless and because TABLES behaves as written; the
-- function surface is actually held by the revoke loop at the end of
-- schema.sql, which runs in the same pass that creates them.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- ── THE RESIDUAL: WRITES ARE NOT AUTHENTICATED ───────────────────
-- Everything above is containment, not authentication, and the difference
-- matters enough to write down where the grants are.
--
-- Every function in the write list takes the caller's own address as an
-- ARGUMENT and checks it against an owner list that is public on chain and
-- readable here. That is a claim, not a credential. Anyone can pass a real
-- owner's address and every check in schema.sql will accept it. What the
-- hardening buys is bounded, recoverable damage rather than none:
--
--   * Nothing can be stolen. The vault is the authority; the client re-derives
--     every EIP-712 digest from the row's own fields and recovers every
--     signature against the chain's owner set, so a forged row cannot be
--     signed into existence or shown as signed.
--   * Nothing is permanent. The write gate gained is_wallet_writer, so an
--     anonymous owner-set rewrite no longer locks the real owners out — the
--     next page load re-syncs from chain and repairs it.
--   * Nothing is unbounded. Shapes and lengths are constrained, per-vault row
--     counts are capped, and every write passes a rate gate.
--
-- What remains open: an anonymous caller can still add noise to a vault's
-- coordination rows — cancel a live proposal, strip a signature, rename a
-- vault — and the owners' recourse is to act again and let the client's
-- chain re-check overwrite it. This remains a coordination integrity and
-- availability risk; proposal admission alone does not close it.
--
-- Closing it needs the caller to PROVE the address instead of naming it:
--   1. Client signs a SIWE-style challenge with the wallet it already has.
--   2. A verifier checks the signature and mints a JWT whose claim is the
--      address (PGRST_JWT_SECRET is already provisioned for this).
--   3. These functions drop their p_caller/p_signer arguments and read
--      `current_setting('request.jwt.claims')::json->>'address'` instead, and
--      the RLS policies stop saying `true` and start scoping to that address.
--
-- api/proposals.cjs now verifies signatures for proposal admission only.
-- Extending authentication to the remaining writes still needs a session or
-- action-signature protocol and per-action authorization. Its service JWT is
-- never a browser session token and must never be sent to a client.
