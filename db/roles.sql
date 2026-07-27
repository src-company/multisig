-- MULTISIG.software — PostgREST roles & grants
-- Run AFTER schema.sql, as the database owner, on your Render Postgres.
--
-- This defines the two roles PostgREST needs (`authenticator` + `anon`) so
-- anonymous browsers can READ (gated by the RLS SELECT policies in
-- schema.sql) and can only WRITE through the SECURITY DEFINER functions,
-- which run their own owner checks.

-- ── ROLES ────────────────────────────────────────────────────────

-- The login role PostgREST authenticates as. It holds no privileges of its
-- own; it only switches into `anon` (or, later, an authenticated role) per
-- request. NOINHERIT is required so privileges apply only after SET ROLE.
DO $$ BEGIN
  CREATE ROLE authenticator LOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

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
  register_wallet(int, text, text, numeric, text[], smallint, int, text, bigint, text, text, text[], int),
  propose_tx(uuid, int, int, text, numeric, text, text, smallint, text, text),
  add_signature(uuid, text, text, sig_type),
  mark_executed(uuid, bigint, text, text),
  -- Five arguments, matching schema.sql. This read `mark_queued(uuid, bigint,
  -- bigint, text)` — the signature schema.sql drops — so on a fresh database
  -- this single GRANT statement aborted on that line and NONE of the write
  -- functions below or above it were granted to anon. The dapp could read
  -- everything and write nothing.
  mark_queued(uuid, bigint, bigint, text, text),
  cancel_tx(uuid, text),
  prune_tx(uuid, text),
  remove_signature(uuid, text),
  update_wallet_name(uuid, text, text),
  update_owner_label(uuid, text, text, text),
  record_approval(uuid, int, text, text, boolean, bigint, text),
  sync_wallet_state(uuid, text, smallint, smallint, int, text, int, text[])
TO anon;

-- ── DEFAULTS ─────────────────────────────────────────────────────
-- Keep future objects from leaking to anon unless granted explicitly.
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
-- chain re-check overwrite it. That is a nuisance, and it is bounded, but it
-- is not closed, and it cannot be closed here.
--
-- Closing it needs the caller to PROVE the address instead of naming it:
--   1. Client signs a SIWE-style challenge with the wallet it already has.
--   2. A verifier checks the signature and mints a JWT whose claim is the
--      address (PGRST_JWT_SECRET is already provisioned for this).
--   3. These functions drop their p_caller/p_signer arguments and read
--      `current_setting('request.jwt.claims')::json->>'address'` instead, and
--      the RLS policies stop saying `true` and start scoping to that address.
--
-- Step 2 is the reason this is not done yet: Postgres cannot verify a secp256k1
-- signature — pgcrypto has no ecrecover and Render's managed Postgres will not
-- load an extension that does — so it needs a small verifier service alongside
-- PostgREST, which is a change to the deployment topology and not just to SQL.
