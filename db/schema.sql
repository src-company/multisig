-- MULTISIG.software — Database Schema (self-hosted Postgres + PostgREST)
-- Single canonical file. Safe to run on fresh or existing DB.

-- ── TABLES ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id      int NOT NULL,
  address       text NOT NULL,
  deployer      text NOT NULL,
  salt          numeric NOT NULL,
  name          text,
  threshold     smallint NOT NULL,
  owner_count   smallint NOT NULL,
  delay         int NOT NULL DEFAULT 0,
  executor      text NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  nonce         int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_block bigint,
  created_tx    text,
  UNIQUE (chain_id, address)
);

-- Add columns if migrating from older schema
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS name text;

-- One vault is one row, however the address is cased.
--
-- The UNIQUE above is on the address as a *string*, and an Ethereum address has
-- no canonical case — EIP-55 checksums are a mixed-case spelling of the same
-- twenty bytes, and clients disagree about whether to store the checksummed or
-- the lowercased form. So the constraint let the same vault be registered twice,
-- once per spelling, each row with its own id, its own queue and its own
-- signatures. Two owners of one vault could then be coordinating in different
-- places, each seeing a queue the other did not.
--
-- Everything that looks a vault up already compares case-insensitively
-- (dbFindWallet's ilike, register_wallet's lower(), is_wallet_owner) precisely
-- because this constraint could not be relied on. This makes the storage agree
-- with the lookups, and the case-sensitive constraint is dropped rather than
-- left alongside: keeping both would enforce the weaker one for no benefit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_chain_addr_ci ON wallets (chain_id, lower(address));
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_chain_id_address_key;

CREATE INDEX IF NOT EXISTS idx_wallets_chain ON wallets (chain_id);

CREATE TABLE IF NOT EXISTS owners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id     uuid NOT NULL REFERENCES wallets ON DELETE CASCADE,
  address       text NOT NULL,
  label         text,
  position      smallint NOT NULL DEFAULT 0,
  is_current    boolean NOT NULL DEFAULT true,
  added_at      timestamptz NOT NULL DEFAULT now(),
  added_block   bigint,
  removed_at    timestamptz,
  removed_block bigint
);

ALTER TABLE owners ADD COLUMN IF NOT EXISTS label text;

CREATE INDEX IF NOT EXISTS idx_owners_wallet ON owners (wallet_id) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_owners_address ON owners (address, is_current) WHERE is_current = true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_owners_unique ON owners (wallet_id, address) WHERE is_current = true;

DO $$ BEGIN
  CREATE TYPE tx_status AS ENUM ('proposed', 'executing', 'queued', 'executed', 'cancelled', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 'stale' is a proposal that never happened: its nonce was consumed by
-- something else, or it left the on-chain queue by a route this client did not
-- observe. It used to be recorded as 'executed' with block 0, which put a row
-- that never ran into the history ledger under a green tick. Terminal, and
-- excluded from both the pending queue and the history view.
-- Run as its own statement: a new enum label cannot be USED in the transaction
-- that adds it, so nothing below may reference 'stale' at parse time (see the
-- tx_history view, which is written as a NOT IN for exactly that reason).
ALTER TYPE tx_status ADD VALUE IF NOT EXISTS 'stale';

CREATE TABLE IF NOT EXISTS transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id       uuid NOT NULL REFERENCES wallets ON DELETE CASCADE,
  chain_id        int NOT NULL,
  nonce           int NOT NULL,
  target          text NOT NULL,
  value           numeric NOT NULL DEFAULT 0,
  call_data       text NOT NULL DEFAULT '0x',
  tx_hash         text NOT NULL,
  status          tx_status NOT NULL DEFAULT 'proposed',
  threshold       smallint NOT NULL,
  description     text,
  proposed_by     text,
  proposed_at     timestamptz NOT NULL DEFAULT now(),
  eta             bigint,
  queued_at       timestamptz,
  queued_block    bigint,
  queue_tx        text,
  executed_at     timestamptz,
  executed_block  bigint,
  execution_tx    text,
  cancelled_at    timestamptz,
  cancelled_by    text,
  -- Identity is the EIP-712 digest, and ONLY the digest. There is deliberately
  -- no UNIQUE (wallet_id, nonce): a nonce is contested, not owned. Several
  -- proposals can legitimately be built against the same nonce — two owners
  -- racing, and every cancel/reject/accelerate companion, which must be signed
  -- over the LIVE nonce and so lands on top of whatever ordinary proposal is
  -- already sitting there. While that constraint existed, propose_tx returned
  -- NULL for the second of them and the caller's signature was dropped on the
  -- floor: REJECT could never be raised at all (it is always built at the nonce
  -- of the very proposal it skips), and CANCEL failed whenever the queue held
  -- an unqueued proposal — that is, exactly when the brake is needed.
  -- Only one of a contested set can ever execute; the losers are pruned to
  -- 'stale' once the chain moves past them.
  UNIQUE (chain_id, tx_hash)
);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS queue_tx text;
-- Migration for databases created before the constraint was dropped.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_wallet_id_nonce_key;

-- A digest identifies a proposal WITHIN its vault and nonce, not globally.
-- See propose_tx for why the global version was a denial of service: it let one
-- anonymous request take a (chain_id, tx_hash) pair and make a specific
-- proposal — a cancel companion, say — permanently unrecordable by its real
-- owners. Created before the old constraint is dropped so the table is never
-- momentarily unprotected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_identity ON transactions (chain_id, wallet_id, nonce, tx_hash);
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_chain_id_tx_hash_key;

CREATE INDEX IF NOT EXISTS idx_tx_wallet_status ON transactions (wallet_id, status);
-- Was served by the dropped UNIQUE; the queue and the prune both filter on it.
CREATE INDEX IF NOT EXISTS idx_tx_wallet_nonce ON transactions (wallet_id, nonce);
CREATE INDEX IF NOT EXISTS idx_tx_chain ON transactions (chain_id);
CREATE INDEX IF NOT EXISTS idx_tx_proposed_by ON transactions (proposed_by);

DO $$ BEGIN
  CREATE TYPE sig_type AS ENUM ('ecdsa', 'approval', 'sender');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS signatures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id       uuid NOT NULL REFERENCES transactions ON DELETE CASCADE,
  signer      text NOT NULL,
  sig_type    sig_type NOT NULL DEFAULT 'ecdsa',
  signature   text NOT NULL,
  signed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tx_id, signer)
);

CREATE INDEX IF NOT EXISTS idx_sigs_tx ON signatures (tx_id);

CREATE TABLE IF NOT EXISTS approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id     uuid NOT NULL REFERENCES wallets ON DELETE CASCADE,
  chain_id      int NOT NULL,
  owner         text NOT NULL,
  tx_hash       text NOT NULL,
  approved      boolean NOT NULL DEFAULT true,
  block_number  bigint,
  approval_tx   text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, owner, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_approvals_hash ON approvals (tx_hash) WHERE approved = true;

DO $$ BEGIN
  CREATE TYPE config_event AS ENUM (
    'init', 'threshold_changed', 'delay_changed',
    'executor_changed', 'owner_added', 'owner_removed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS config_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id     uuid NOT NULL REFERENCES wallets ON DELETE CASCADE,
  event         config_event NOT NULL,
  block_number  bigint,
  tx_hash       text,
  threshold     smallint,
  delay         int,
  executor      text,
  owner_count   smallint,
  subject       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_config_wallet ON config_log (wallet_id, created_at);

-- ── INPUT VALIDATION ─────────────────────────────────────────────
-- Every write below arrives through a SECURITY DEFINER function that any
-- anonymous browser can call, and until these existed the arguments were taken
-- entirely on trust: a 1MB description, a `target` of 'not-an-address-at-all',
-- a negative `value`, calldata that is not hex. None of it can make the vault
-- do anything — the chain is the authority and the client re-derives every
-- digest — but all of it lands in this database and stays there, and on a
-- 256mb instance a loop that writes megabyte descriptions is the whole attack.
--
-- Shapes, not semantics: an address is 20 hex bytes, a digest is 32, a wei
-- amount is a non-negative integer, and free text has a ceiling. Anything that
-- fails these could not have come from this app and could not correspond to
-- anything on chain.
--
-- Added NOT VALID deliberately. That does NOT mean unenforced — it enforces on
-- every INSERT and UPDATE from here on; it only skips the retroactive scan of
-- rows a previous schema already accepted. That matters because this file is
-- applied by hand to a live database which may well be holding junk that
-- predates the constraint, and a migration that fails is a migration that never
-- ran (see the tx_history note above). The consequence, stated so it is not a
-- surprise: a legacy row that violates one of these is frozen — Postgres
-- re-checks every constraint on a row when any column of it is updated — so it
-- can still be read, but not modified, until it is cleaned up by hand.
--
-- Wrapped in DO/EXCEPTION rather than IF NOT EXISTS because ADD CONSTRAINT has
-- no such clause, and this file must apply twice in a row without error.
--
-- Which has a consequence worth stating plainly, because it is the opposite of
-- what re-applying this file looks like it does: the loop swallows
-- duplicate_object, so a constraint that ALREADY EXISTS IS LEFT EXACTLY AS IT
-- WAS. Editing an expression above and re-running this file changes nothing.
-- Any constraint whose expression is revised has to be dropped first, here,
-- where the two other migrations of this kind already sit.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS tx_calldata_fmt;  -- 16384 -> 65536 chars

DO $$
DECLARE
  ADDR  CONSTANT text := '^0x[0-9a-fA-F]{40}$';
  HASH  CONSTANT text := '^0x[0-9a-fA-F]{64}$';
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    -- wallets
    ('wallets','wallets_address_fmt',  format('address ~ %L', ADDR)),
    ('wallets','wallets_deployer_fmt', format('deployer ~ %L', ADDR)),
    ('wallets','wallets_executor_fmt', format('executor ~ %L', ADDR)),
    -- created_tx is written as '' by the auto-register path (a vault reached by
    -- address was not deployed by this client, so there is no deploy tx).
    ('wallets','wallets_created_tx_fmt', format('created_tx IS NULL OR created_tx = '''' OR created_tx ~ %L', HASH)),
    ('wallets','wallets_salt_int',     'salt >= 0 AND salt = trunc(salt)'),
    ('wallets','wallets_chain_pos',    'chain_id > 0'),
    ('wallets','wallets_counts_sane',  'threshold >= 0 AND owner_count >= 0 AND delay >= 0 AND nonce >= 0'),
    ('wallets','wallets_name_len',     'name IS NULL OR length(name) <= 128'),
    -- owners
    ('owners','owners_address_fmt',    format('address ~ %L', ADDR)),
    ('owners','owners_label_len',      'label IS NULL OR length(label) <= 64'),
    ('owners','owners_position_sane',  'position >= 0'),
    -- transactions
    ('transactions','tx_chain_pos',    'chain_id > 0'),
    ('transactions','tx_nonce_sane',   'nonce >= 0'),
    ('transactions','tx_target_fmt',   format('target ~ %L', ADDR)),
    ('transactions','tx_value_int',    'value >= 0 AND value = trunc(value)'),
    -- Even-length hex, with a ceiling that stops the column being used as free
    -- storage. The ceiling counts CHARACTERS, because that is what a text column
    -- stores: two per byte, plus the leading 0x. The previous 16384 was written
    -- as "16KB of calldata" and was in fact 8KB of it, and 8KB is not the
    -- comfortable headroom that reasoning assumed — a single self-call batch
    -- registering six tokens, each leg carrying an inline SVG, encodes to 9.9KB
    -- and was refused. 65536 characters is 32KB of calldata, which is the number
    -- the original note meant to leave room for, doubled.
    --
    -- What actually bounds storage is not this: propose_tx caps a vault at
    -- 20,000 rows outright, and the rate limit is keyed on vault AND client_ip.
    -- This is the per-row shape check, and a shape check set below what the app
    -- legitimately builds is a bug rather than a defence.
    ('transactions','tx_calldata_fmt', 'call_data ~ ''^0x([0-9a-fA-F]{2})*$'' AND length(call_data) <= 65536'),
    ('transactions','tx_hash_fmt',     format('tx_hash ~ %L', HASH)),
    ('transactions','tx_threshold_sane','threshold >= 0'),
    ('transactions','tx_desc_len',     'description IS NULL OR length(description) <= 512'),
    ('transactions','tx_proposed_by_fmt', format('proposed_by IS NULL OR proposed_by ~ %L', ADDR)),
    ('transactions','tx_cancelled_by_fmt',format('cancelled_by IS NULL OR cancelled_by ~ %L', ADDR)),
    ('transactions','tx_exec_tx_fmt',  format('execution_tx IS NULL OR execution_tx = '''' OR execution_tx ~ %L', HASH)),
    ('transactions','tx_queue_tx_fmt', format('queue_tx IS NULL OR queue_tx = '''' OR queue_tx ~ %L', HASH)),
    ('transactions','tx_eta_sane',     'eta IS NULL OR eta >= 0'),
    -- signatures: one ECDSA sig is 0x + 130 hex; the sender-slot encoding is the
    -- same width. The ceiling is generous and still finite.
    ('signatures','sigs_signer_fmt',   format('signer ~ %L', ADDR)),
    ('signatures','sigs_sig_fmt',      'signature ~ ''^0x[0-9a-fA-F]*$'' AND length(signature) <= 512'),
    -- approvals
    ('approvals','appr_owner_fmt',     format('owner ~ %L', ADDR)),
    ('approvals','appr_hash_fmt',      format('tx_hash ~ %L', HASH)),
    ('approvals','appr_tx_fmt',        format('approval_tx IS NULL OR approval_tx = '''' OR approval_tx ~ %L', HASH)),
    ('approvals','appr_chain_pos',     'chain_id > 0'),
    -- config_log
    ('config_log','cfg_subject_fmt',   format('subject IS NULL OR subject ~ %L', ADDR)),
    ('config_log','cfg_tx_fmt',        format('tx_hash IS NULL OR tx_hash = '''' OR tx_hash ~ %L', HASH))
  ) AS t(tbl, name, expr)
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', c.tbl, c.name, c.expr);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END;
  END LOOP;
END $$;

-- ── RATE LIMITING ────────────────────────────────────────────────
-- Shapes and ceilings bound how big one write can be. They do nothing about how
-- MANY, and every write function here is reachable without credentials, so the
-- remaining lever is a counter.
--
-- Not granted to anon in any form: the table has no grant, and rate_gate is
-- called only from inside the SECURITY DEFINER functions, which run as the
-- owner. A caller cannot read its own budget, reset it, or call the gate
-- directly.
CREATE TABLE IF NOT EXISTS write_rate (
  bucket       text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  n            int NOT NULL DEFAULT 0
);
ALTER TABLE write_rate ENABLE ROW LEVEL SECURITY; -- no policy: nothing may read it

-- The client address, taken from the RIGHTMOST entry of X-Forwarded-For.
-- Deliberately not the leftmost: a client can send its own XFF header and the
-- proxy appends rather than replaces, so the left of that list is attacker
-- text and only the last hop — the one Render itself wrote — is evidence.
-- Returns 'unknown' when there is no header at all, which buckets every such
-- caller together rather than giving each an unlimited private budget.
CREATE OR REPLACE FUNCTION client_ip() RETURNS text AS $$
  SELECT COALESCE(
    NULLIF(btrim(split_part(
      current_setting('request.headers', true)::json->>'x-forwarded-for',
      ',',
      array_length(string_to_array(
        current_setting('request.headers', true)::json->>'x-forwarded-for', ','), 1)
    )), ''),
    'unknown');
$$ LANGUAGE sql STABLE;

-- Every bucket is keyed on the vault AND the caller, never on the vault alone.
--
-- Keyed on the vault alone, this limiter was a weapon rather than a shield. The
-- write functions are anon-callable and authenticate by a claimed address, and
-- owner addresses are public — so a stranger could POST propose_tx sixty times
-- in a minute for a vault they have nothing to do with, and the vault's real
-- owners got 'Rate limit exceeded' for the rest of that minute. Nothing was
-- forged and nothing had to be: the budget was shared, so spending it was
-- enough.
--
-- It is the one forgery the client cannot absorb. A planted proposal is hidden,
-- a buried one is restored from the chain, a forged approval is not counted —
-- all of that happens on read, where there is something to inspect. A write
-- that was refused left nothing to inspect, and the owners simply could not act.
-- Worst against the cancel path, where the minutes are the point.
--
-- Adding the caller costs nothing a real client will notice — owners are on
-- different connections, and one owner's own burst (loadVaultQueue prunes up to
-- TERMINAL_RECHECK rows in a loop) sits well inside its own budget. An attacker
-- now spends only their own, and buying more means buying addresses.
--
-- The per-vault ceiling this replaces was never what bounded storage: propose_tx
-- caps a vault at 20,000 rows outright, which is the check that actually holds
-- the disk, and it is untouched by any of this.
--
-- client_ip() reads the rightmost X-Forwarded-For entry — the hop Render itself
-- wrote — so it cannot be spoofed by a client appending its own header. Callers
-- arriving with no header at all share the 'unknown' bucket, which is the
-- conservative direction: they are limited together rather than each handed a
-- private, unlimited budget.

-- Raises once the bucket is over budget for the window.
--
-- The RAISE aborts the transaction, which rolls back this call's own increment
-- — so a bucket at its ceiling stops advancing rather than climbing. That is
-- the intended behaviour and not a leak: every call past the ceiling still
-- re-reaches it and still raises, for as long as the window holds.
CREATE OR REPLACE FUNCTION rate_gate(p_bucket text, p_max int, p_window interval)
RETURNS void AS $$
DECLARE cur int;
BEGIN
  INSERT INTO write_rate AS w (bucket, window_start, n)
  VALUES (p_bucket, now(), 1)
  ON CONFLICT (bucket) DO UPDATE SET
    window_start = CASE WHEN w.window_start < now() - p_window THEN now() ELSE w.window_start END,
    n            = CASE WHEN w.window_start < now() - p_window THEN 1    ELSE w.n + 1      END
  RETURNING w.n INTO cur;

  IF cur > p_max THEN
    RAISE EXCEPTION 'Rate limit exceeded for % — slow down', p_bucket
      USING ERRCODE = 'too_many_connections';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Rows accumulate one per bucket and are only useful inside their window.
-- Swept opportunistically by register_wallet so nothing external has to run.
CREATE OR REPLACE FUNCTION rate_sweep() RETURNS void AS $$
  DELETE FROM write_rate WHERE window_start < now() - interval '1 hour';
$$ LANGUAGE sql SECURITY DEFINER;

-- ── VIEWS ────────────────────────────────────────────────────────

-- Dropped, not replaced. CREATE OR REPLACE VIEW only accepts a new definition
-- whose column list *starts with* the existing one — same names, same order,
-- same types, new columns appended at the end. Anything else is an error.
--
-- tx_history was missing from this block, and its column list had changed:
-- queue_tx was inserted between execution_tx and cancelled_at, and sort_ts added.
-- So on any database that already had the old view, that one statement failed —
-- and because this file is applied as a single transaction, it took the whole
-- migration with it. Everything below this point silently never ran: the RLS
-- policies, and every function. The database went on serving the previous
-- schema's propose_tx (a bare ON CONFLICT DO NOTHING that returns NULL instead
-- of resolving or raising), a four-argument mark_queued the client no longer
-- calls, no prune_tx at all, and a transactions table still carrying the
-- UNIQUE (wallet_id, nonce) the ALTER above exists to remove.
--
-- What that looked like from the app: every proposal raised at a nonce that
-- already held a companion row — which is every REJECT, and every CANCEL or
-- ACCELERATE with an ordinary proposal beside it — came back "NONCE IN USE",
-- because the old propose_tx swallowed the unique violation and returned
-- nothing. The brake could not be pulled at the moment it was needed.
--
-- So: every view is dropped before it is created. A view's shape is not stable
-- across releases and CREATE OR REPLACE is not a migration.
DROP VIEW IF EXISTS pending_txs; -- legacy, removed
DROP VIEW IF EXISTS tx_summary;
DROP VIEW IF EXISTS my_wallets;
DROP VIEW IF EXISTS tx_history;

CREATE OR REPLACE VIEW my_wallets AS
  SELECT
    w.id, w.chain_id, w.address, w.name, w.threshold, w.owner_count,
    w.delay, w.executor, w.nonce,
    o.address AS owner
  FROM wallets w
  JOIN owners o ON o.wallet_id = w.id AND o.is_current = true;

-- Only signatures from CURRENT owners count toward quorum. A signer removed
-- after signing leaves a stale row that would otherwise inflate sig_count and
-- falsely mark a tx "ready" (the on-chain execute would then revert). The
-- LEFT JOIN to owners lets us FILTER those out while still returning txs with
-- zero valid sigs.
CREATE OR REPLACE VIEW tx_summary AS
  SELECT
    t.*,
    count(s.id) FILTER (WHERE o.id IS NOT NULL) AS sig_count,
    t.threshold AS sigs_needed,
    count(s.id) FILTER (WHERE o.id IS NOT NULL) >= t.threshold AS ready,
    CASE
      WHEN t.status = 'queued' AND t.eta IS NOT NULL
        THEN t.eta <= extract(epoch FROM now())
      ELSE false
    END AS queue_ready
  FROM transactions t
  LEFT JOIN signatures s ON s.tx_id = t.id
  LEFT JOIN owners o
    ON o.wallet_id = t.wallet_id
   AND lower(o.address) = lower(s.signer)
   AND o.is_current = true
  GROUP BY t.id;

CREATE OR REPLACE VIEW tx_history AS
  SELECT
    t.id, t.wallet_id, t.nonce, t.target, t.value, t.call_data,
    t.tx_hash, t.status, t.description, t.proposed_by,
    t.proposed_at, t.eta, t.executed_at, t.executed_block,
    t.execution_tx, t.queue_tx, t.cancelled_at, t.cancelled_by,
    -- Single sortable timestamp so clients can order deterministically.
    -- PostgREST does not preserve a view's internal ORDER BY, so callers
    -- must order explicitly on this column (see dbGetHistory).
    COALESCE(t.executed_at, t.cancelled_at) AS sort_ts
  FROM transactions t
  -- Everything terminal, stated as the complement of the live states so this
  -- view carries no literal of the 'stale' label — which cannot be referenced
  -- in the transaction that adds it to the enum above.
  WHERE t.status NOT IN ('proposed', 'executing', 'queued')
  ORDER BY COALESCE(t.executed_at, t.cancelled_at) DESC;

-- ── RLS ──────────────────────────────────────────────────────────

ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wallets_all ON wallets;
DROP POLICY IF EXISTS owners_all ON owners;
DROP POLICY IF EXISTS tx_all ON transactions;
DROP POLICY IF EXISTS sigs_all ON signatures;
DROP POLICY IF EXISTS approvals_all ON approvals;
DROP POLICY IF EXISTS config_all ON config_log;
DROP POLICY IF EXISTS wallets_read ON wallets;
DROP POLICY IF EXISTS owners_read ON owners;
DROP POLICY IF EXISTS tx_read ON transactions;
DROP POLICY IF EXISTS sigs_read ON signatures;
DROP POLICY IF EXISTS approvals_read ON approvals;
DROP POLICY IF EXISTS config_read ON config_log;

-- Read-only for anon role. All writes go through SECURITY DEFINER functions.
CREATE POLICY wallets_read ON wallets FOR SELECT USING (true);
CREATE POLICY owners_read ON owners FOR SELECT USING (true);
CREATE POLICY tx_read ON transactions FOR SELECT USING (true);
CREATE POLICY sigs_read ON signatures FOR SELECT USING (true);
CREATE POLICY approvals_read ON approvals FOR SELECT USING (true);
CREATE POLICY config_read ON config_log FOR SELECT USING (true);

-- ── HELPERS ──────────────────────────────────────────────────────

-- Is this address a CURRENT owner? Used where currency is the question being
-- asked — which row to label, which set to show — and NOT as the write gate.
-- See is_wallet_writer below for why those are two different questions.
CREATE OR REPLACE FUNCTION is_wallet_owner(p_wallet_id uuid, p_address text)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM owners
    WHERE wallet_id = p_wallet_id
      AND lower(address) = lower(p_address)
      AND is_current = true
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- The write gate. Deliberately WITHOUT `is_current`, and that is the whole
-- point of it.
--
-- Every function here authenticates by an address the caller supplies, against
-- an owner list that is public on chain and readable here. That is a claim, not
-- a credential, and it cannot be made into one without a signature — so none of
-- these checks stop a determined forger, and the client is written on that
-- assumption: it re-derives every digest and recovers every signature against
-- the chain's own owner set.
--
-- What the gate CAN do is decide whether the damage is recoverable, and while
-- it read `is_current` the answer was no. sync_wallet_state takes the new owner
-- set as an argument and rewrites the table with it, so one anonymous request
-- naming any real owner as its caller retired every one of them and installed
-- the sender instead. The victims then failed this check — they could not
-- propose, sign, or cancel; the vault left their dashboard (my_wallets joins on
-- is_current); and, worst of all, they could not put it back, because the
-- repair path is sync_wallet_state and register_wallet, and both asked the
-- table the attacker had just rewritten. Verified: a locked-out owner could
-- reach the vault by neither route. Recovery meant hand-editing the database.
--
-- Authorising on ever-having-been-an-owner breaks that loop. A retired owner
-- keeps write access, so the next ordinary page load repairs the record all by
-- itself — reloadVault calls dbSyncWalletState with the owner set it just read
-- from the chain, which restores the real owners and retires the impostor. The
-- attack degrades from permanent seizure to a defacement that heals on refresh.
--
-- The cost, stated plainly: an owner legitimately removed from a vault keeps
-- the ability to write to its coordination rows. That is not a new exposure —
-- anyone at all already has it, by naming a current owner — and it buys the
-- property that no anonymous request can ever take a vault away from the people
-- who own it. When these writes are properly authenticated, this should become
-- a check on the authenticated identity and the currency question moves here.
CREATE OR REPLACE FUNCTION is_wallet_writer(p_wallet_id uuid, p_address text)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM owners
    WHERE wallet_id = p_wallet_id
      AND lower(address) = lower(p_address)
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ── FUNCTIONS ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION register_wallet(
  p_chain_id int, p_address text, p_deployer text, p_salt numeric,
  p_owners text[], p_threshold smallint, p_delay int, p_executor text,
  p_block bigint, p_tx text,
  p_name text DEFAULT NULL, p_labels text[] DEFAULT NULL,
  p_nonce int DEFAULT 0
) RETURNS uuid AS $$
DECLARE
  w_id uuid;
  i int;
  existed boolean;
BEGIN
  -- Bucketed on the caller rather than the vault: this is the one write that
  -- CREATES vaults, so a per-vault budget would be a fresh budget every time
  -- and no limit at all. Registration is a once-per-vault event (a deploy, or
  -- the first time one is opened by address), so a real client never approaches
  -- this.
  PERFORM rate_gate('reg:' || client_ip(), 60, interval '1 minute');
  PERFORM rate_sweep();

  IF p_owners IS NULL OR array_length(p_owners, 1) IS NULL THEN
    RAISE EXCEPTION 'Owner list must not be empty';
  END IF;
  IF array_length(p_owners, 1) > 100 THEN
    RAISE EXCEPTION 'Owner list too long';
  END IF;

  -- Deployer must be in the owner list (case-insensitive)
  IF NOT (SELECT lower(p_deployer) = ANY(SELECT lower(unnest(p_owners)))) THEN
    RAISE EXCEPTION 'Deployer must be an owner';
  END IF;

  -- Is this a registration or a re-registration? Asked before the upsert,
  -- because the answer decides whether the owner set below may be rewritten.
  -- Case-insensitive and oldest-first, matching how the client looks a wallet up
  -- (dbFindWallet): the uniqueness constraint is on the address as a *string*, so
  -- a database that collected a differently-cased pair before that was fixed must
  -- still resolve every caller to the same one of them.
  SELECT id INTO w_id FROM wallets
  WHERE chain_id = p_chain_id AND lower(address) = lower(p_address)
  ORDER BY created_at ASC LIMIT 1;
  existed := w_id IS NOT NULL;

  -- A vault that is already registered does not get its owner set replaced by
  -- whoever asks. This function is anon-callable and the owner list is one of
  -- its arguments, so ON CONFLICT DO UPDATE followed by an unconditional
  -- rewrite meant one HTTP request could retire every real owner of any vault
  -- in this database (is_current = false) and install the caller in their
  -- place. That is not a cosmetic edit: is_wallet_owner() is what gates every
  -- write function here, and my_wallets is what lists a vault on its owners'
  -- dashboards — so the real owners lost both their vault and their ability to
  -- propose, sign or cancel anything in it, while the caller gained all three.
  --
  -- Re-registration by someone who is already a current owner is the ordinary
  -- case (a re-deploy, a vault reached by address, a client resyncing) and is
  -- still allowed. For anyone else this degrades to a lookup: they get the
  -- wallet id, which is all a viewer needs, and change nothing.
  -- The owner-set test is skipped for a row that has no owner rows at all,
  -- which is not reachable through this file but would otherwise be a wallet
  -- nobody could ever re-register or write to again.
  -- is_wallet_writer, not is_wallet_owner: a caller the last owner-set rewrite
  -- retired is exactly who needs this path to work, because re-registering is
  -- one of the two ways a defaced vault gets put back.
  IF existed
     AND EXISTS (SELECT 1 FROM owners WHERE wallet_id = w_id)
     AND NOT is_wallet_writer(w_id, p_deployer) THEN
    RETURN w_id;
  END IF;

  INSERT INTO wallets (chain_id, address, deployer, salt, name, threshold, owner_count, delay, executor, nonce, created_block, created_tx)
  VALUES (p_chain_id, p_address, p_deployer, p_salt, p_name, p_threshold, array_length(p_owners, 1), p_delay, p_executor, p_nonce, p_block, p_tx)
  -- Inferred from idx_wallets_chain_addr_ci, matching the case-insensitive
  -- lookup a dozen lines above. Targeting (chain_id, address) instead would
  -- miss whenever the caller's spelling differed from the stored one — the
  -- SELECT would find the row, the upsert would not, and the INSERT would hit
  -- the case-insensitive index as a raw unique violation rather than an update.
  ON CONFLICT (chain_id, lower(address)) DO UPDATE SET
    threshold = EXCLUDED.threshold, delay = EXCLUDED.delay, executor = EXCLUDED.executor,
    owner_count = EXCLUDED.owner_count, nonce = GREATEST(wallets.nonce, EXCLUDED.nonce),
    name = COALESCE(EXCLUDED.name, wallets.name)
  RETURNING id INTO w_id;

  UPDATE owners SET is_current = false, removed_at = now()
  WHERE wallet_id = w_id AND is_current = true;

  FOR i IN 1..array_length(p_owners, 1) LOOP
    INSERT INTO owners (wallet_id, address, label, position, is_current, added_block)
    VALUES (w_id, p_owners[i],
            CASE WHEN p_labels IS NOT NULL AND i <= array_length(p_labels, 1) THEN NULLIF(p_labels[i], '') ELSE NULL END,
            i - 1, true, p_block);
  END LOOP;

  INSERT INTO config_log (wallet_id, event, block_number, tx_hash, threshold, delay, executor, owner_count)
  VALUES (w_id, 'init', p_block, p_tx, p_threshold, p_delay, p_executor, array_length(p_owners, 1))
  ON CONFLICT DO NOTHING;

  RETURN w_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION propose_tx(
  p_wallet_id uuid, p_chain_id int, p_nonce int,
  p_target text, p_value numeric, p_call_data text,
  p_tx_hash text, p_threshold smallint, p_proposed_by text,
  p_description text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  t_id uuid;
BEGIN
  IF NOT is_wallet_writer(p_wallet_id, p_proposed_by) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
  PERFORM rate_gate('propose:' || p_wallet_id::text || ':' || client_ip(), 60, interval '1 minute');

  -- A ceiling on how much of this database one vault can occupy. Proposals are
  -- never deleted — they go terminal and stay as history — so without this the
  -- row count for a single vault is bounded only by how long someone is willing
  -- to keep POSTing. Two orders of magnitude above any real vault's lifetime
  -- traffic, and it is the count that is capped rather than the rate, because a
  -- rate limit alone just makes filling the disk take longer.
  IF (SELECT count(*) FROM transactions WHERE wallet_id = p_wallet_id) >= 20000 THEN
    RAISE EXCEPTION 'Too many transactions recorded for this vault';
  END IF;

  INSERT INTO transactions (wallet_id, chain_id, nonce, target, value, call_data, tx_hash, threshold, proposed_by, description)
  VALUES (p_wallet_id, p_chain_id, p_nonce, p_target, p_value, p_call_data, p_tx_hash, p_threshold, p_proposed_by, p_description)
  ON CONFLICT (chain_id, wallet_id, nonce, tx_hash) DO NOTHING
  RETURNING id INTO t_id;

  -- The only conflict left is the digest under this vault and nonce, which IS
  -- this proposal's identity — so the existing row is this proposal and the
  -- caller may sign it. Targeted at that constraint rather than left bare: a
  -- bare ON CONFLICT would swallow any future constraint too, and hand back
  -- whatever the fallback happened to find.
  --
  -- The conflict target is (chain_id, wallet_id, nonce, tx_hash) and not
  -- (chain_id, tx_hash), because the narrow version was globally exclusive
  -- across every vault on a chain and this function is anon-callable. Owner
  -- addresses are readable by anon, so anyone could name a real owner of any
  -- registered vault, POST a row carrying the digest of a proposal somebody
  -- else was about to raise, and take that (chain_id, tx_hash) pair. The
  -- victim's propose_tx then conflicted, failed the wallet+nonce re-match
  -- below, and raised — permanently, because the digest is deterministic. Their
  -- proposal could never be coordinated through this database at all.
  --
  -- Worth spelling out what that was worth attacking: a cancel companion's
  -- digest is entirely predictable (the vault as target, zero value,
  -- cancelQueued(hash) as calldata, the live nonce), so whoever queued a
  -- dangerous proposal could pre-squat the digest of the brake meant to stop
  -- it. The on-chain approve() path was unaffected, but the in-app cancel was
  -- dead before anyone reached for it.
  --
  -- Nothing is lost by narrowing. An EIP-712 digest already commits to the
  -- verifying contract and the nonce, so one digest cannot legitimately belong
  -- to two vaults or two nonces; and the client never reads tx_hash anyway — it
  -- re-derives every digest from the row's own fields (see proposalDigest), so
  -- a row lying about its hash was already inert.
  IF t_id IS NULL THEN
    -- Kept as the belt to the constraint's braces. With the wider constraint
    -- this can only find the row the conflict just hit, but the lookup states
    -- the invariant the RAISE below depends on rather than assuming it.
    SELECT id INTO t_id FROM transactions
    WHERE chain_id = p_chain_id AND tx_hash = p_tx_hash
      AND wallet_id = p_wallet_id AND nonce = p_nonce
    LIMIT 1;
    IF t_id IS NULL THEN
      RAISE EXCEPTION 'Transaction hash already registered against a different proposal';
    END IF;
    -- Terminal rows are not revivable: an identical digest means an identical
    -- nonce, and a nonce that reached a terminal state has been consumed on
    -- chain. Reviving would show a proposal that can only ever revert.
    IF (SELECT status FROM transactions WHERE id = t_id) NOT IN ('proposed', 'executing') THEN
      RAISE EXCEPTION 'That proposal is already executed, cancelled or superseded';
    END IF;
  END IF;

  RETURN t_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION add_signature(
  p_tx_id uuid, p_signer text, p_signature text,
  p_sig_type sig_type DEFAULT 'ecdsa'
) RETURNS int AS $$
DECLARE
  cnt int;
  w_id uuid;
BEGIN
  SELECT wallet_id INTO w_id FROM transactions WHERE id = p_tx_id;
  IF w_id IS NULL THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;
  IF NOT is_wallet_writer(w_id, p_signer) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
  PERFORM rate_gate('sig:' || w_id::text || ':' || client_ip(), 120, interval '1 minute');

  INSERT INTO signatures (tx_id, signer, sig_type, signature)
  VALUES (p_tx_id, p_signer, p_sig_type, p_signature)
  ON CONFLICT (tx_id, signer) DO UPDATE SET
    signature = EXCLUDED.signature, sig_type = EXCLUDED.sig_type, signed_at = now();

  SELECT count(*) INTO cnt FROM signatures WHERE tx_id = p_tx_id;
  RETURN cnt;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- p_caller is REQUIRED. It used to default to NULL, and the check was written
-- `IF p_caller IS NOT NULL AND NOT is_wallet_owner(...)` — so any caller that
-- simply omitted the argument skipped the check entirely. PostgREST fills
-- omitted named arguments from their defaults, which made this reachable from
-- an anonymous HTTP request: flip any proposal to executed and it leaves every
-- owner's queue while remaining live on chain. The same held for mark_queued.
--
-- Dropped first, because removing that default is exactly what CREATE OR REPLACE
-- will not do: "cannot remove parameter defaults from existing function". The
-- argument types are unchanged, so nothing here hinted that a replace would fail
-- — and on the database this was written for, it did, taking the rest of the
-- file down with it. The rule, for anything added below: a function needs an
-- explicit DROP whenever this release changes its arity, its argument types, its
-- return type, or its defaults. mark_queued has one for the same reason.
DROP FUNCTION IF EXISTS mark_executed(uuid, bigint, text, text);
CREATE OR REPLACE FUNCTION mark_executed(
  p_tx_id uuid, p_block bigint, p_execution_tx text,
  p_caller text
) RETURNS void AS $$
DECLARE
  w_id uuid;
  prev_status tx_status;
  moved int;
BEGIN
  SELECT wallet_id, status INTO w_id, prev_status FROM transactions WHERE id = p_tx_id;
  IF w_id IS NULL THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;
  IF NOT is_wallet_writer(w_id, p_caller) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
  PERFORM rate_gate('mark:' || w_id::text || ':' || client_ip(), 240, interval '1 minute');

  -- Only a LIVE proposal can become executed. Without this guard the update was
  -- unconditional, so a terminal row could be flipped back: a cancelled
  -- proposal — one an owner pulled the brake on — reappeared in the history
  -- ledger under a green tick with whatever block number the caller chose.
  -- Terminal is terminal; the chain has already spoken about that nonce.
  UPDATE transactions
  SET status = 'executed', executed_at = now(), executed_block = p_block, execution_tx = p_execution_tx
  WHERE id = p_tx_id AND status IN ('proposed', 'executing', 'queued');
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved = 0 THEN
    RETURN;
  END IF;

  -- Increment nonce for real executions only:
  -- Skip if queued (already incremented at queue time) or if block=0 (stale tx cleanup).
  -- Gated on the row having actually moved, which is what `moved` above buys:
  -- the update used to be unconditional, so calling this twice on the same row
  -- — a retry, or a loop — advanced the recorded nonce once per call for a
  -- single execution, and the record drifted arbitrarily far from the chain.
  IF prev_status != 'queued' AND p_block > 0 THEN
    UPDATE wallets SET nonce = nonce + 1 WHERE id = w_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Retire a proposal that never ran: its nonce was consumed by something else,
-- or it left the on-chain queue by a route this client did not see. Separate
-- from mark_executed, which the queue loader used to call with block 0 for this
-- — that wrote status 'executed' and put a proposal that never happened into
-- the history ledger under a tick, indistinguishable from one that did.
-- cancelled_at doubles as "observed superseded at" for a stale row; cancelled_by
-- stays NULL, because nobody cancelled it.
CREATE OR REPLACE FUNCTION prune_tx(
  p_tx_id uuid, p_caller text
) RETURNS void AS $$
DECLARE
  w_id uuid;
BEGIN
  SELECT wallet_id INTO w_id FROM transactions WHERE id = p_tx_id;
  IF w_id IS NULL THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;
  IF NOT is_wallet_writer(w_id, p_caller) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
  -- Roomier than the others: loadVaultQueue prunes superseded rows in a loop,
  -- up to TERMINAL_RECHECK of them, and that burst is legitimate.
  PERFORM rate_gate('mark:' || w_id::text || ':' || client_ip(), 240, interval '1 minute');

  UPDATE transactions
  SET status = 'stale', cancelled_at = now()
  WHERE id = p_tx_id AND status IN ('proposed', 'executing', 'queued');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop the pre-queue_tx signature so no stale overload lingers on existing DBs.
DROP FUNCTION IF EXISTS mark_queued(uuid, bigint, bigint, text);
-- p_caller and p_queue_tx are both REQUIRED — see mark_executed above for why
-- the defaults had to go. (Postgres will not take a mandatory parameter after
-- an optional one, and the client has always passed both.)
CREATE OR REPLACE FUNCTION mark_queued(
  p_tx_id uuid, p_eta bigint, p_block bigint,
  p_queue_tx text,
  p_caller text
) RETURNS void AS $$
DECLARE
  w_id uuid;
  prev_status tx_status;
  moved int;
BEGIN
  SELECT wallet_id, status INTO w_id, prev_status FROM transactions WHERE id = p_tx_id;
  IF w_id IS NULL THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;
  IF NOT is_wallet_writer(w_id, p_caller) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
  PERFORM rate_gate('mark:' || w_id::text || ':' || client_ip(), 240, interval '1 minute');

  UPDATE transactions
  SET status = 'queued', eta = p_eta, queued_at = now(), queued_block = p_block, queue_tx = p_queue_tx
  WHERE id = p_tx_id AND status IN ('proposed', 'executing');

  -- On-chain nonce increments at queue time (execute() is called to queue).
  -- Guarded on the row having actually moved: a retried write — this call goes
  -- through the client's retry path — would otherwise advance the recorded
  -- nonce a second time for one on-chain queueing.
  -- ROW_COUNT rather than the status read above, because two concurrent calls
  -- both read 'proposed' before either updates: only one of them changes a row,
  -- and only that one may move the nonce.
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved > 0 AND prev_status IN ('proposed', 'executing') THEN
    UPDATE wallets SET nonce = nonce + 1 WHERE id = w_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION cancel_tx(
  p_tx_id uuid, p_cancelled_by text
) RETURNS void AS $$
DECLARE
  w_id uuid;
BEGIN
  SELECT wallet_id INTO w_id FROM transactions WHERE id = p_tx_id;
  IF w_id IS NULL THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;
  IF NOT is_wallet_writer(w_id, p_cancelled_by) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
  PERFORM rate_gate('mark:' || w_id::text || ':' || client_ip(), 240, interval '1 minute');

  -- Any live proposal, not just a queued one. The old `status = 'queued'` guard
  -- made this a silent no-op for a proposal still collecting signatures — which
  -- is exactly what the reject flow calls it for when it retires the proposal
  -- whose nonce it just skipped. Nothing happened, no error was raised, and the
  -- row sat there until the queue loader swept it up as stale.
  UPDATE transactions
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = p_cancelled_by
  WHERE id = p_tx_id AND status IN ('proposed', 'executing', 'queued');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION remove_signature(
  p_tx_id uuid, p_signer text
) RETURNS void AS $$
DECLARE
  w_id uuid;
BEGIN
  SELECT wallet_id INTO w_id FROM transactions WHERE id = p_tx_id;
  IF w_id IS NULL THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;
  IF NOT is_wallet_writer(w_id, p_signer) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
  PERFORM rate_gate('sig:' || w_id::text || ':' || client_ip(), 120, interval '1 minute');

  -- Only from a live proposal. A terminal row's signatures are the record of
  -- what was collected before it went terminal, and nothing legitimate unsigns
  -- an executed or cancelled proposal — so allowing it only let the history be
  -- quietly edited after the fact.
  -- Case-insensitive, like every other address comparison in this file: the
  -- lookup that authorised this call folds case, so a signer whose stored row
  -- is cased differently from the argument passed the check and then deleted
  -- nothing, and the caller was told it worked.
  DELETE FROM signatures s
  USING transactions t
  WHERE s.tx_id = p_tx_id
    AND t.id = s.tx_id
    AND lower(s.signer) = lower(p_signer)
    AND t.status IN ('proposed', 'executing', 'queued');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION update_wallet_name(
  p_wallet_id uuid, p_name text, p_caller text
) RETURNS void AS $$
BEGIN
  IF NOT is_wallet_writer(p_wallet_id, p_caller) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
  PERFORM rate_gate('meta:' || p_wallet_id::text || ':' || client_ip(), 60, interval '1 minute');
  UPDATE wallets SET name = p_name WHERE id = p_wallet_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION update_owner_label(
  p_wallet_id uuid, p_address text, p_label text, p_caller text
) RETURNS void AS $$
BEGIN
  IF NOT is_wallet_writer(p_wallet_id, p_caller) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
  PERFORM rate_gate('meta:' || p_wallet_id::text || ':' || client_ip(), 60, interval '1 minute');
  -- Case-insensitive, like every other address comparison in this file. It was
  -- the one that was not, so a label set against an address in a different case
  -- than the stored row updated nothing and reported success.
  UPDATE owners SET label = p_label
  WHERE wallet_id = p_wallet_id AND lower(address) = lower(p_address) AND is_current = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION record_approval(
  p_wallet_id uuid, p_chain_id int, p_owner text, p_tx_hash text,
  p_approved boolean, p_block_number bigint DEFAULT NULL,
  p_approval_tx text DEFAULT NULL
) RETURNS void AS $$
BEGIN
  IF NOT is_wallet_writer(p_wallet_id, p_owner) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
  PERFORM rate_gate('appr:' || p_wallet_id::text || ':' || client_ip(), 60, interval '1 minute');
  INSERT INTO approvals (wallet_id, chain_id, owner, tx_hash, approved, block_number, approval_tx, updated_at)
  VALUES (p_wallet_id, p_chain_id, p_owner, p_tx_hash, p_approved, p_block_number, p_approval_tx, now())
  ON CONFLICT (wallet_id, owner, tx_hash) DO UPDATE SET
    approved = EXCLUDED.approved, block_number = EXCLUDED.block_number,
    approval_tx = EXCLUDED.approval_tx, updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION sync_wallet_state(
  p_wallet_id uuid, p_caller text,
  p_threshold smallint, p_owner_count smallint, p_delay int,
  p_executor text, p_nonce int,
  p_owners text[]
) RETURNS void AS $$
DECLARE
  i int;
  existing text[];
  old_threshold smallint;
  old_delay int;
  old_executor text;
BEGIN
  IF NOT is_wallet_writer(p_wallet_id, p_caller) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
  PERFORM rate_gate('sync:' || p_wallet_id::text || ':' || client_ip(), 60, interval '1 minute');

  -- This function's whole job is to replace the owner set with the one the
  -- caller passes, which makes it the most destructive thing anon can reach.
  -- An empty or absent array is not a legitimate sync — a live vault always has
  -- at least one owner on chain — and honouring it would retire every owner and
  -- leave a vault with no owner rows at all: nothing to display, and, before
  -- the write gate stopped reading is_current, nobody who could ever write to
  -- it again. Refuse rather than interpret.
  IF p_owners IS NULL OR array_length(p_owners, 1) IS NULL THEN
    RAISE EXCEPTION 'Owner list must not be empty';
  END IF;
  IF array_length(p_owners, 1) > 100 THEN
    RAISE EXCEPTION 'Owner list too long';
  END IF;

  -- Capture prior state so we can journal what actually changed. This is the
  -- only place config drift (threshold/delay/executor/ownership) is observed
  -- off-chain, so we append config_log rows — otherwise config history would
  -- never contain anything but the original 'init' event.
  SELECT threshold, delay, executor INTO old_threshold, old_delay, old_executor
  FROM wallets WHERE id = p_wallet_id;

  UPDATE wallets SET
    threshold = p_threshold, owner_count = p_owner_count,
    delay = p_delay, executor = p_executor, nonce = p_nonce
  WHERE id = p_wallet_id;

  IF old_threshold IS DISTINCT FROM p_threshold THEN
    INSERT INTO config_log (wallet_id, event, threshold, owner_count)
    VALUES (p_wallet_id, 'threshold_changed', p_threshold, p_owner_count);
  END IF;
  IF old_delay IS DISTINCT FROM p_delay THEN
    INSERT INTO config_log (wallet_id, event, delay)
    VALUES (p_wallet_id, 'delay_changed', p_delay);
  END IF;
  IF lower(coalesce(old_executor, '')) IS DISTINCT FROM lower(coalesce(p_executor, '')) THEN
    INSERT INTO config_log (wallet_id, event, executor)
    VALUES (p_wallet_id, 'executor_changed', p_executor);
  END IF;

  -- Mark removed owners (and journal each removal)
  SELECT array_agg(address) INTO existing
  FROM owners WHERE wallet_id = p_wallet_id AND is_current = true;

  IF existing IS NOT NULL THEN
    FOR i IN 1..array_length(existing, 1) LOOP
      IF NOT (SELECT lower(existing[i]) = ANY(SELECT lower(unnest(p_owners)))) THEN
        UPDATE owners SET is_current = false, removed_at = now()
        WHERE wallet_id = p_wallet_id AND address = existing[i] AND is_current = true;
        INSERT INTO config_log (wallet_id, event, subject, owner_count)
        VALUES (p_wallet_id, 'owner_removed', existing[i], p_owner_count);
      END IF;
    END LOOP;
  END IF;

  -- Upsert owners with correct positions (and journal each addition)
  FOR i IN 1..array_length(p_owners, 1) LOOP
    IF EXISTS (
      SELECT 1 FROM owners
      WHERE wallet_id = p_wallet_id AND lower(address) = lower(p_owners[i]) AND is_current = true
    ) THEN
      UPDATE owners SET position = i - 1
      WHERE wallet_id = p_wallet_id AND lower(address) = lower(p_owners[i]) AND is_current = true;
    ELSE
      -- An address that was an owner before and is one again gets its existing
      -- row revived rather than a second one inserted beside it: the partial
      -- unique index only covers current rows, so a re-add would otherwise
      -- accumulate a retired row per cycle. This is also the path that repairs
      -- a vault whose owner set was rewritten by an anonymous caller.
      UPDATE owners SET is_current = true, removed_at = NULL, position = i - 1
      WHERE wallet_id = p_wallet_id AND lower(address) = lower(p_owners[i]) AND is_current = false;
      IF NOT FOUND THEN
        INSERT INTO owners (wallet_id, address, position, is_current)
        VALUES (p_wallet_id, p_owners[i], i - 1, true);
      END IF;
      INSERT INTO config_log (wallet_id, event, subject, owner_count)
      VALUES (p_wallet_id, 'owner_added', p_owners[i], p_owner_count);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── GRANT SELF-HEAL ──────────────────────────────────────────────
-- DROP FUNCTION takes the function's grants with it, and two functions above
-- are dropped on every run (mark_executed and mark_queued, because CREATE OR
-- REPLACE cannot remove a parameter default). So applying THIS file alone —
-- which is exactly what the client's drift banner tells an operator to do —
-- silently revoked anon's access to both, and the dapp went on calling them
-- with the errors discarded: proposals executed on chain simply stopped being
-- recorded, with nothing on screen to say so.
--
-- Re-granting here means schema.sql is self-sufficient for the surface it
-- drops. roles.sql remains the file that CREATES the roles and grants
-- everything else; this only puts back what this file just took away, and only
-- if the role is already there.
-- The same hazard, one section further down the file and worse, because it is
-- silent in the other direction: the three views above are DROPPED and recreated
-- on every run (see the note at the VIEWS heading — CREATE OR REPLACE VIEW
-- cannot reorder a column list, so replacing them is not an option). DROP VIEW
-- takes their grants with it exactly as DROP FUNCTION does.
--
-- So re-applying this file alone revoked anon's SELECT on my_wallets, tx_summary
-- and tx_history — which is every read the dashboard makes. dbMyWallets returns
-- null and the vault list empties; dbGetPending and dbGetRecentTerminal fail and
-- the queue empties. An operator following the drift banner ("re-apply
-- db/schema.sql") to fix one problem would have created a worse one, and the
-- only way back was to notice that roles.sql had to be run again too.
--
-- Found by running this file against a database that already had roles.sql
-- applied and then reading the views as anon, which is what the deployment
-- actually does and what no earlier check here did.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION mark_executed(uuid, bigint, text, text) TO anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION mark_queued(uuid, bigint, bigint, text, text) TO anon';
    EXECUTE 'GRANT SELECT ON my_wallets, tx_summary, tx_history TO anon';
  END IF;
END $$;

-- ── THE INTERNAL HELPERS ARE NOT AN API ──────────────────────────
-- A newly created function is EXECUTE-able by PUBLIC. That is PostgreSQL's
-- default and it is the opposite of what every one of these wants.
--
-- roles.sql intends to cover this twice — `REVOKE EXECUTE ON ALL FUNCTIONS IN
-- SCHEMA public FROM PUBLIC` for what exists, and `ALTER DEFAULT PRIVILEGES ...
-- REVOKE ALL ON FUNCTIONS FROM PUBLIC` for what comes later. Neither reaches a
-- function this file creates AFTER roles.sql last ran, which is the normal order
-- of events: roles.sql is a one-time setup step and schema.sql is re-applied
-- whenever the client says the database has drifted. Checked rather than
-- assumed — pg_default_acl came back empty on a database where roles.sql had
-- run, so the second line records nothing and the protection was never there.
--
-- The result was reachable, not theoretical: with schema.sql applied over a
-- roles.sql database, `SET ROLE anon; SELECT rate_gate('...', 1, '1 hour')`
-- succeeded. rate_gate takes the bucket name as an argument, so anyone could
-- name another vault's bucket and spend its budget — turning the limiter into
-- the denial of service it exists to prevent, which is precisely what roles.sql
-- warns about two lines above its own grant list.
--
-- Revoked from PUBLIC rather than from anon: every function the dapp is meant to
-- reach holds an explicit `anon=X` grant from roles.sql, and REVOKE ... FROM
-- PUBLIC does not touch an explicit grant. So this removes the default and
-- leaves the intended surface exactly as it was.
--
-- Every function, not a list of the ones known to be sensitive today. A list is
-- the version of this that fails quietly: it covers what was thought of when it
-- was written, and the next internal helper added to this file is public until
-- somebody remembers to extend it — which is precisely how rate_gate came to be
-- callable in the first place. Deny by default and let roles.sql name the
-- exceptions, which is what it already does.
--
-- A loop over the catalog, and not ALTER DEFAULT PRIVILEGES, because that does
-- not work here and it is worth writing down why rather than leaving the next
-- person to find out. roles.sql ends with
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC
--
-- which reads like exactly this protection. Tested directly: after running it,
-- pg_default_acl holds no row for the schema owner, and a function created
-- immediately afterwards is still EXECUTE-able by anon. The same is true in
-- production, where the only default-ACL rows belong to the `postgres` role and
-- came from Render's own provisioning. So nothing has ever been guarding a
-- newly created function, and the comment in roles.sql promising otherwise is
-- the reason nobody looked.
--
-- The loop needs no such guarantee. A function is added to this file and this
-- file is then applied, so the revoke runs in the same pass that creates it —
-- the protection and the thing it protects arrive together, which is the one
-- ordering that cannot be forgotten.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END $$;


-- ── SECURITY DEFINER HARDENING ───────────────────────────────────
-- Every write function in this file is SECURITY DEFINER, which means it runs as
-- the role that owns it — on Render that is the database owner, which holds
-- CREATEDB and CREATEROLE. None of them pinned a search_path, so the schema each
-- unqualified `owners`, `transactions`, `wallets` resolves to was decided by
-- whatever search_path the CALLER happened to have. Anyone able to create an
-- object in a schema earlier in that path could shadow a table — or a function
-- these call, is_wallet_writer among them — and have their version run as the
-- owner.
--
-- Not reachable today, and said plainly rather than left implied: anon and
-- authenticator hold no CREATE on this database or on public, so neither can put
-- an object anywhere to be found first, and PostgREST does not let a request set
-- search_path. This is the second lock on a door that is already bolted — worth
-- fitting because the bolt is a grant, and grants are one ALTER away from
-- changing, while this holds regardless of who is later allowed to create what.
--
-- pg_temp is named LAST on purpose. It is searched first when it is not listed,
-- and every caller can create temporary objects — so leaving it implicit is the
-- one version of this hazard that anon really could reach.
--
-- Written as a loop over the catalog rather than a clause on each definition so
-- that it cannot be forgotten: a function added to this file later is pinned by
-- the next run of it, whether or not whoever wrote it remembered.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND (p.proconfig IS NULL OR NOT (p.proconfig @> ARRAY['search_path=public, pg_temp']))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f.sig);
  END LOOP;
END $$;

-- Views run with the privileges of their OWNER unless told otherwise, and the
-- owner here is the database owner, who bypasses row-level security. So each of
-- these three reads its base tables with RLS switched off and hands the result
-- to whoever asked.
--
-- That leaks nothing today: every policy on those tables is `USING (true)` for
-- SELECT, so a caller reading the tables directly sees exactly the same rows.
-- It is the coupling that is wrong — it means the RLS policies are load-bearing
-- for direct reads and decorative through the views, and the day anyone narrows
-- one (per-owner visibility, say, or hiding a vault's queue from non-owners)
-- these three would go on serving everything, silently, because nothing about
-- tightening a policy makes a view stop bypassing it.
--
-- security_invoker makes them honest: the caller's own privileges and the
-- caller's own policies. anon already holds SELECT on every base table these
-- touch, so nothing changes today — which is the point of doing it while
-- nothing changes.
ALTER VIEW my_wallets SET (security_invoker = true);
ALTER VIEW tx_summary SET (security_invoker = true);
ALTER VIEW tx_history SET (security_invoker = true);
