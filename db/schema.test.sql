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
-- Why this exists. Everything in this database is reachable by an anonymous
-- HTTP request — propose_tx, add_signature, cancel_tx and register_wallet all
-- authenticate by a string the caller supplies, because PostgREST has no
-- session here and Postgres cannot recover a secp256k1 signature. So the RPCs
-- are the only place the rules live, and until this file they were the only
-- part of the system with no test at all.
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

-- 4. propose_tx rejects a chain id that is not the vault's
BEGIN
  PERFORM propose_tx(w, 8453, 0, V, 0::numeric, '0x', '0x' || repeat('de',32), 2::smallint, A, NULL);
  RAISE EXCEPTION 'UNCAUGHT propose_tx accepted a foreign chain id';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  PERFORM t_ok(msg LIKE '%Chain id does not match%', 'propose_tx refuses a foreign chain id');
END;
t := propose_tx(w, 1, 0, V, 0::numeric, '0x', '0x' || repeat('de',32), 2::smallint, A, NULL);
PERFORM t_ok(t IS NOT NULL, 'propose_tx accepts the vault''s own chain id');

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
