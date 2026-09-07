-- Assertions about what schema.sql's RPCs actually do.
--
--   psql -v ON_ERROR_STOP=1 -f db/schema.sql      (into a scratch database)
--   psql -v ON_ERROR_STOP=1 -f db/roles.sql
--   psql -f db/schema.test.sql
--
-- Or, from the repo root, with a server this can create a database on:
--
--   MULTISIG_TEST_PG=1 node --test test/schema.test.js
--
-- Proposal insertion is restricted to the verifier role. Crypto and chain
-- verification run in test/proposals.test.js; these tests exercise the SQL
-- trust boundary, atomic write, migration, and remaining coordination RPCs.
-- Run only on a scratch database: the verifier fixtures intentionally use
-- synthetic signatures after assuming the trusted backend identity.
--
-- Each block below is a defect that was live, written as the thing that must
-- now be true instead. Re-runnable: every vault gets a fresh address, so this
-- can be pointed at a scratch database repeatedly without accumulating state
-- that changes the answers.

\set ON_ERROR_STOP on
\pset pager off
CREATE OR REPLACE FUNCTION t_ok(cond boolean, label text) RETURNS void AS $f$
BEGIN
  IF cond THEN RAISE NOTICE 'PASS  %', label;
  ELSE RAISE EXCEPTION 'FAIL  %', label; END IF;
END $f$ LANGUAGE plpgsql;

-- Fault injection: prove a failure storing the first signature rolls back the
-- new proposal too. This trigger exists only in this scratch-database suite.
CREATE FUNCTION test_signature_failure() RETURNS trigger AS $$
BEGIN
  IF NEW.signature = '0x' || repeat('ff',65) THEN
    RAISE EXCEPTION 'injected signature write failure';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER test_signature_failure BEFORE INSERT ON signatures
FOR EACH ROW EXECUTE FUNCTION test_signature_failure();

DO $$
DECLARE
  w uuid; t uuid; n int; cur int; ded int; msg text;
  A text := '0xAAaAaA00000000000000000000000000000000aA';
  A_LC text := '0xaaaaaa00000000000000000000000000000000aa';
  B text := '0xBbBbBb00000000000000000000000000000000bB';
  C text := '0xCcCcCc00000000000000000000000000000000cC';
  -- A fresh vault per run, so the script is re-runnable against a database
  -- that already holds the previous run's rows.
  V text := '0x' || replace(gen_random_uuid()::text,'-','') || substr(replace(gen_random_uuid()::text,'-',''),1,8);
BEGIN

-- 1. labels survive a re-registration that carries none
w := register_wallet(1, V, A, 0, ARRAY[A,B], 2::smallint, 3600, '0x0000000000000000000000000000000000000000', 1, '0x' || repeat('ab',32),
                     'MY VAULT', ARRAY['TREASURER','COLD KEY'], 0);
PERFORM t_ok((SELECT label FROM owners WHERE wallet_id=w AND lower(address)=lower(A) AND is_current) = 'TREASURER',
             'label stored on first registration');
PERFORM register_wallet(1, V, A, 0, ARRAY[A,B], 2::smallint, 3600, '0x0000000000000000000000000000000000000000', 1, '0x' || repeat('ab',32), NULL, NULL, 0);
PERFORM t_ok((SELECT label FROM owners WHERE wallet_id=w AND lower(address)=lower(A) AND is_current) = 'TREASURER',
             're-registration without labels PRESERVES labels');
PERFORM t_ok((SELECT name FROM wallets WHERE id=w) = 'MY VAULT',
             're-registration without a name preserves the name');

-- 2. no dead-row accumulation, no duplicate init
PERFORM register_wallet(1, V, A, 0, ARRAY[A,B], 2::smallint, 3600, '0x0000000000000000000000000000000000000000', 1, '0x' || repeat('ab',32), NULL, NULL, 0);
PERFORM register_wallet(1, V, A, 0, ARRAY[A,B], 2::smallint, 3600, '0x0000000000000000000000000000000000000000', 1, '0x' || repeat('ab',32), NULL, NULL, 0);
SELECT count(*) INTO ded FROM owners WHERE wallet_id=w AND is_current=false;
PERFORM t_ok(ded = 0, 'four registrations leave no retired rows behind (got ' || ded || ')');
SELECT count(*) INTO n FROM config_log WHERE wallet_id=w AND event='init';
PERFORM t_ok(n = 1, 'a vault is journalled as initialised exactly once (got ' || n || ')');

-- 3. duplicate owners refused, however cased
BEGIN
  PERFORM register_wallet(1, '0x' || replace(gen_random_uuid()::text,'-','') || substr(replace(gen_random_uuid()::text,'-',''),1,8), A, 0,
                          ARRAY[A, A_LC], 1::smallint, 0, '0x0000000000000000000000000000000000000000', 1, '0x' || repeat('ab',32), NULL, NULL, 0);
  RAISE EXCEPTION 'UNCAUGHT case-variant duplicate owners were accepted';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  PERFORM t_ok(msg LIKE '%same address twice%', 'case-variant duplicate owners refused by name');
END;

-- 4. Only the trusted verifier can insert, with an atomic first signature.
PERFORM t_ok(NOT has_function_privilege('anon', 'propose_tx(uuid,integer,integer,text,numeric,text,text,smallint,text,text,text,sig_type)', 'EXECUTE'),
             'anonymous callers have no proposal insertion grant');
PERFORM t_ok(to_regprocedure('propose_tx(uuid,integer,integer,text,numeric,text,text,smallint,text,text)') IS NULL,
             'legacy unsigned proposal overload is removed');
PERFORM t_ok(has_function_privilege('proposal_writer', 'propose_tx(uuid,integer,integer,text,numeric,text,text,smallint,text,text,text,sig_type)', 'EXECUTE'),
             'verifier has the proposal insertion grant');
PERFORM t_ok(NOT has_table_privilege('proposal_writer', 'transactions', 'INSERT'),
             'verifier cannot insert directly into tables');
PERFORM t_ok(NOT has_function_privilege('proposal_writer', 'sync_wallet_state(uuid,text,smallint,smallint,integer,text,integer,text[])', 'EXECUTE'),
             'verifier has no unrelated write RPC');
BEGIN
  PERFORM propose_tx(w, 1, 0, V, 0::numeric, '0x', '0x' || repeat('de',32), 2::smallint, A, NULL);
  RAISE EXCEPTION 'UNCAUGHT unsigned proposal accepted';
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM t_ok(true, 'unsigned proposal refused without verifier identity');
END;
-- Even a caller setting fake JWT claims cannot bypass the EXECUTE grant.
PERFORM set_config('request.jwt.claims', '{"role":"proposal_writer"}', true);
SET LOCAL ROLE anon;
BEGIN
  PERFORM propose_tx(w, 1, 0, V, 0::numeric, '0x', '0x' || repeat('de',32), 2::smallint, A, NULL, '0x' || repeat('11',65), 'ecdsa');
  RAISE EXCEPTION 'UNCAUGHT anonymous caller reached trusted insertion';
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM t_ok(true, 'direct anonymous call denied even with claimed verifier role');
END;
RESET ROLE;
SET LOCAL ROLE proposal_writer;
BEGIN
  PERFORM propose_tx(w, 1, 0, V, 0::numeric, '0x', '0x' || repeat('de',32), 2::smallint, A, NULL);
  RAISE EXCEPTION 'UNCAUGHT verifier inserted without first signature';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  PERFORM t_ok(msg LIKE '%signature is required%', 'verifier cannot omit the first signature');
END;
-- Chain identity still comes from the wallet record.
BEGIN
  PERFORM propose_tx(w, 8453, 0, V, 0::numeric, '0x', '0x' || repeat('de',32), 2::smallint, A, NULL, '0x' || repeat('11',65), 'ecdsa');
  RAISE EXCEPTION 'UNCAUGHT propose_tx accepted a foreign chain id';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  PERFORM t_ok(msg LIKE '%Chain id does not match%', 'propose_tx refuses a foreign chain id');
END;
t := propose_tx(w, 1, 0, V, 0::numeric, '0x', '0x' || repeat('de',32), 2::smallint, A, NULL, '0x' || repeat('11',65), 'ecdsa');
RESET ROLE;
PERFORM t_ok(t IS NOT NULL, 'propose_tx accepts the vault''s own chain id');
PERFORM t_ok((SELECT count(*) FROM signatures WHERE tx_id=t) = 1, 'proposal commits with its first signature');
PERFORM t_ok(propose_tx(w, 1, 0, V, 0::numeric, '0x', '0x' || repeat('DE',32), 2::smallint, A, NULL, '0x' || repeat('11',65), 'ecdsa') = t,
             'identical signed retry and hash case variant reuse the same proposal');
BEGIN
  PERFORM propose_tx(w, 1, 0, B, 5::numeric, '0x', '0x' || repeat('de',32), 2::smallint, A, NULL, '0x' || repeat('11',65), 'ecdsa');
  RAISE EXCEPTION 'UNCAUGHT poisoned existing digest accepted';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  PERFORM t_ok(msg LIKE '%conflicts with the signed transaction%', 'pre-existing digest cannot redirect a signed proposal');
END;


BEGIN
  PERFORM propose_tx(w, 1, 1, V, 0::numeric, '0x', '0x' || repeat('dc',32), 2::smallint, A, NULL, '0x' || repeat('ff',65), 'ecdsa');
  RAISE EXCEPTION 'UNCAUGHT first signature failure accepted';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  PERFORM t_ok(msg = 'injected signature write failure', 'first signature write failure reaches the caller');
END;
PERFORM t_ok(NOT EXISTS(SELECT 1 FROM transactions WHERE wallet_id=w AND nonce=1),
             'first signature failure leaves no unsigned proposal behind');

-- 5. one signer is one signature row, however cased
PERFORM add_signature(t, A, '0x' || repeat('11',65), 'ecdsa');
PERFORM add_signature(t, A_LC, '0x' || repeat('22',65), 'ecdsa');
SELECT count(*) INTO n FROM signatures WHERE tx_id=t;
PERFORM t_ok(n = 1, 'a signer re-signing under another case REPLACES their row (got ' || n || ')');
PERFORM t_ok((SELECT signature FROM signatures WHERE tx_id=t) = '0x' || repeat('22',65),
             'the replacement is the newer signature');
SELECT sig_count INTO n FROM tx_summary WHERE id = t;
PERFORM t_ok(n = 1, 'tx_summary.sig_count does not double-count the case variant (got ' || n || ')');

-- 6. terminal proposals take no new signatures
PERFORM cancel_tx(t, A);
BEGIN
  PERFORM add_signature(t, B, '0x' || repeat('33',65), 'ecdsa');
  RAISE EXCEPTION 'UNCAUGHT a cancelled proposal accepted a new signature';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  PERFORM t_ok(msg LIKE '%no longer open%', 'a cancelled proposal refuses new signatures');
END;

-- 7. a revocation cased differently CLEARS the approval
PERFORM record_approval(w, 1, A, '0x' || repeat('be',32), true, 1, '0x' || repeat('ab',32));
PERFORM record_approval(w, 1, A_LC, '0x' || repeat('be',32), false, 2, '0x' || repeat('ab',32));
SELECT count(*) INTO n FROM approvals WHERE wallet_id=w AND tx_hash='0x' || repeat('be',32);
PERFORM t_ok(n = 1, 'a revocation under another case updates rather than inserts (got ' || n || ')');
PERFORM t_ok((SELECT approved FROM approvals WHERE wallet_id=w AND tx_hash='0x' || repeat('be',32)) = false,
             'the surviving row records the revocation, not the approval');
BEGIN
  PERFORM record_approval(w, 8453, A, '0x' || repeat('b2',32), true, 1, '0x' || repeat('ab',32));
  RAISE EXCEPTION 'UNCAUGHT record_approval accepted a foreign chain id';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  PERFORM t_ok(msg LIKE '%Chain id does not match%', 'record_approval refuses a foreign chain id');
END;

-- 8. sync_wallet_state survives multiple retired rows for one owner
INSERT INTO owners (wallet_id, address, position, is_current, removed_at)
VALUES (w, C, 5, false, now() - interval '3 min'),
       (w, C, 5, false, now() - interval '2 min'),
       (w, C, 5, false, now() - interval '1 min');
SELECT count(*) INTO ded FROM owners WHERE wallet_id=w AND lower(address)=lower(C) AND is_current=false;
PERFORM t_ok(ded = 3, 'three retired rows staged for one address');
PERFORM sync_wallet_state(w, A, 2::smallint, 3::smallint, 3600, '0x0000000000000000000000000000000000000000', 0, ARRAY[A,B,C]);
SELECT count(*) INTO cur FROM owners WHERE wallet_id=w AND lower(address)=lower(C) AND is_current=true;
PERFORM t_ok(cur = 1, 'reviving an owner with several retired rows revives exactly one (got ' || cur || ')');
PERFORM t_ok((SELECT threshold FROM wallets WHERE id=w) = 2,
             'the wallet update in the same call was not rolled back');

RAISE NOTICE '--- all regression checks passed ---';
END $$;

DROP TRIGGER test_signature_failure ON signatures;
DROP FUNCTION test_signature_failure();
