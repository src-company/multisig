// db/schema.sql's RPCs, run against a real Postgres.
//
//   MULTISIG_TEST_PG=1 node --test test/schema.test.js
//
// SKIPPED BY DEFAULT, and deliberately. Every other suite here runs against the
// dapp source with no dependencies at all, which is what makes `node --test`
// the whole contract — the same reasoning build.js gives for vendoring rather
// than installing. This one needs a live server, so it asks to be opted into
// rather than failing a deploy on a machine that has no psql.
//
// What it covers is worth the opt-in. The coordination database is anon-
// writable by design (see db/schema.test.sql), which makes its RPCs the only
// enforcement point in the system, and they had no coverage. The assertions
// live in db/schema.test.sql so they can also be run straight through psql
// against a scratch database; this file is the harness that stands one up.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ON = !!process.env.MULTISIG_TEST_PG;

// A server to talk to. Defaults match a scratch cluster started on a
// non-standard port so this never touches a real one by accident.
const HOST = process.env.PGHOST || '/tmp';
const PORT = process.env.PGPORT || '55432';
const USER = process.env.PGUSER || 'postgres';
const DB = 'multisig_schema_test_' + process.pid;

const psql = (args, opts = {}) =>
  execFileSync('psql', ['-h', HOST, '-p', PORT, '-U', USER, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

test('the schema applies, is idempotent, and its RPCs behave', { skip: ON ? false : 'set MULTISIG_TEST_PG=1 and point PGHOST/PGPORT at a scratch server' }, () => {
  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
  try {
    const apply = () => {
      for (const f of ['db/schema.sql', 'db/roles.sql']) {
        psql(['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(ROOT, f)]);
      }
    };
    // Applied twice: this file is hand-applied to a live database and has to
    // survive being re-run, which is why every statement in it is guarded.
    apply();
    apply();

    // Both streams: psql writes RAISE NOTICE to stderr, and the assertions
    // report through NOTICE so they can also be read when this file is run by
    // hand through psql.
    const run = spawnSync('psql',
      ['-h', HOST, '-p', PORT, '-U', USER, '-d', DB, '-q', '-f', path.join(ROOT, 'db/schema.test.sql')],
      { encoding: 'utf8' });
    const combined = String(run.stdout || '') + String(run.stderr || '');
    assert.equal(run.status, 0, `psql exited ${run.status}:\n${combined}`);
    assert.doesNotMatch(combined, /\bFAIL\b/, combined);
    const passes = (combined.match(/PASS/g) || []).length;
    assert.ok(passes >= 18, `expected the assertions in db/schema.test.sql to run, saw ${passes} passes:\n${combined}`);
  } finally {
    try { psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB}`]); } catch (_) {}
  }
});
