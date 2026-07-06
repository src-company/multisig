-- MULTISIG.software — PostgREST roles & grants
-- Run AFTER schema.sql, as the database owner, on your Render Postgres.
--
-- This recreates the two roles Supabase provisioned automatically
-- (`authenticator` + `anon`) so a self-hosted PostgREST enforces the same
-- security model: anonymous browsers can READ (gated by the RLS SELECT
-- policies in schema.sql) and can only WRITE through the SECURITY DEFINER
-- functions, which run their own owner checks.

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

GRANT SELECT ON
  wallets, owners, transactions, signatures, approvals, config_log
TO anon;

GRANT SELECT ON
  my_wallets, tx_summary, tx_history
TO anon;

-- ── WRITES (SECURITY DEFINER functions only) ─────────────────────
-- Lock everything down first: no function is callable by default. Then
-- expose exactly the RPC surface the dapp uses. anon has NO direct
-- INSERT/UPDATE/DELETE — every mutation flows through these functions,
-- which run as their owner and enforce is_wallet_owner() checks.
-- (is_wallet_owner itself is intentionally NOT granted, so it is not
-- reachable as /rpc/is_wallet_owner; the definer functions still call it
-- internally as the owner.)

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  register_wallet(int, text, text, numeric, text[], smallint, int, text, bigint, text, text, text[], int),
  propose_tx(uuid, int, int, text, numeric, text, text, smallint, text, text),
  add_signature(uuid, text, text, sig_type),
  mark_executed(uuid, bigint, text, text),
  mark_queued(uuid, bigint, bigint, text),
  cancel_tx(uuid, text),
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
