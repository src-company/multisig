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

-- ── VIEWS ────────────────────────────────────────────────────────

DROP VIEW IF EXISTS pending_txs; -- legacy, removed
DROP VIEW IF EXISTS tx_summary;
DROP VIEW IF EXISTS my_wallets;

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

CREATE OR REPLACE FUNCTION is_wallet_owner(p_wallet_id uuid, p_address text)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM owners
    WHERE wallet_id = p_wallet_id
      AND lower(address) = lower(p_address)
      AND is_current = true
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
BEGIN
  -- Deployer must be in the owner list (case-insensitive)
  IF NOT (SELECT lower(p_deployer) = ANY(SELECT lower(unnest(p_owners)))) THEN
    RAISE EXCEPTION 'Deployer must be an owner';
  END IF;

  INSERT INTO wallets (chain_id, address, deployer, salt, name, threshold, owner_count, delay, executor, nonce, created_block, created_tx)
  VALUES (p_chain_id, p_address, p_deployer, p_salt, p_name, p_threshold, array_length(p_owners, 1), p_delay, p_executor, p_nonce, p_block, p_tx)
  ON CONFLICT (chain_id, address) DO UPDATE SET
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
  IF NOT is_wallet_owner(p_wallet_id, p_proposed_by) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;

  INSERT INTO transactions (wallet_id, chain_id, nonce, target, value, call_data, tx_hash, threshold, proposed_by, description)
  VALUES (p_wallet_id, p_chain_id, p_nonce, p_target, p_value, p_call_data, p_tx_hash, p_threshold, p_proposed_by, p_description)
  ON CONFLICT (chain_id, tx_hash) DO NOTHING
  RETURNING id INTO t_id;

  -- The only conflict left is the digest, which is the proposal's identity — so
  -- the existing row IS this proposal and the caller may sign it. Targeted at
  -- that constraint rather than left bare: a bare ON CONFLICT would swallow any
  -- future constraint too, and hand back whatever the fallback happened to find.
  IF t_id IS NULL THEN
    -- Matched on the wallet and nonce as well as the hash. A digest commits to
    -- the verifying contract and the nonce, so a row that carries this hash
    -- under a different wallet or nonce was not produced by hashing this
    -- proposal — it was squatted, and attaching signatures to it would file
    -- them against a row the queue will never read.
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
  IF NOT is_wallet_owner(w_id, p_signer) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;

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
CREATE OR REPLACE FUNCTION mark_executed(
  p_tx_id uuid, p_block bigint, p_execution_tx text,
  p_caller text
) RETURNS void AS $$
DECLARE
  w_id uuid;
  prev_status tx_status;
BEGIN
  SELECT wallet_id, status INTO w_id, prev_status FROM transactions WHERE id = p_tx_id;
  IF w_id IS NULL THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;
  IF NOT is_wallet_owner(w_id, p_caller) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;

  UPDATE transactions
  SET status = 'executed', executed_at = now(), executed_block = p_block, execution_tx = p_execution_tx
  WHERE id = p_tx_id;

  -- Increment nonce for real executions only:
  -- Skip if queued (already incremented at queue time) or if block=0 (stale tx cleanup)
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
  IF NOT is_wallet_owner(w_id, p_caller) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;

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
BEGIN
  SELECT wallet_id, status INTO w_id, prev_status FROM transactions WHERE id = p_tx_id;
  IF w_id IS NULL THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;
  IF NOT is_wallet_owner(w_id, p_caller) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;

  UPDATE transactions
  SET status = 'queued', eta = p_eta, queued_at = now(), queued_block = p_block, queue_tx = p_queue_tx
  WHERE id = p_tx_id AND status IN ('proposed', 'executing');

  -- On-chain nonce increments at queue time (execute() is called to queue).
  -- Guarded on the row having actually moved: a retried write — this call goes
  -- through the client's retry path — would otherwise advance the recorded
  -- nonce a second time for one on-chain queueing.
  IF prev_status IN ('proposed', 'executing') THEN
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
  IF NOT is_wallet_owner(w_id, p_cancelled_by) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;

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
  IF NOT is_wallet_owner(w_id, p_signer) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;

  DELETE FROM signatures WHERE tx_id = p_tx_id AND signer = p_signer;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION update_wallet_name(
  p_wallet_id uuid, p_name text, p_caller text
) RETURNS void AS $$
BEGIN
  IF NOT is_wallet_owner(p_wallet_id, p_caller) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
  UPDATE wallets SET name = p_name WHERE id = p_wallet_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION update_owner_label(
  p_wallet_id uuid, p_address text, p_label text, p_caller text
) RETURNS void AS $$
BEGIN
  IF NOT is_wallet_owner(p_wallet_id, p_caller) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
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
  IF NOT is_wallet_owner(p_wallet_id, p_owner) THEN
    RAISE EXCEPTION 'Not an owner';
  END IF;
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
  IF NOT is_wallet_owner(p_wallet_id, p_caller) THEN
    RAISE EXCEPTION 'Not an owner';
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
      INSERT INTO owners (wallet_id, address, position, is_current)
      VALUES (p_wallet_id, p_owners[i], i - 1, true);
      INSERT INTO config_log (wallet_id, event, subject, owner_count)
      VALUES (p_wallet_id, 'owner_added', p_owners[i], p_owner_count);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
