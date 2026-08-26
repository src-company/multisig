// The query this app actually sends to PostgREST.
//
//   node --test              (from the repo root; discovers every suite)
//
// PgQuery is four lines of fluent builder and every read in the dapp goes
// through it, which is exactly the shape that gets changed without anybody
// looking at the URL it produces. The URL is the whole contract: PostgREST reads
// the query string and nothing else, so a parameter spelled the wrong way is not
// an error, it is a different question quietly asked and answered.
//
// One of those spellings has already cost something. A multi-column sort is
// `order=a.asc,b.asc` — ONE parameter — and the builder appended a second
// `order=` instead, of which only one survives. That is invisible in every way
// that matters: the request is a 200, the rows come back, and the tie-break that
// was added for a reason is simply not applied. It matters here because a nonce
// is contested rather than owned, so two proposals can sit at the same one, and
// only the first of them is drawn with any controls on it. Without the second
// sort key, which of a contested pair leads is whatever the planner returned —
// not stable between requests, and not the same answer for two co-signers, who
// would then each sign the payload the other could not see.
//
// So these tests read the query string, not the rows.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dapp', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

// Same reader as the suites beside it, plus the one shape they do not need: a
// `class NAME {` closed by a brace in column 0. A missing name throws rather
// than returning nothing, so a rename fails the suite instead of quietly
// deleting its coverage.
function grab(name) {
  const start = LINES.findIndex(l =>
    l.startsWith(`class ${name} `) || l.startsWith(`class ${name}{`) ||
    l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`) ||
    l.startsWith(`const ${name} `) || l.startsWith(`const ${name}=`));
  if (start === -1) throw new Error(`pgquery.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  if (/;\s*(\/\/.*)?$/.test(LINES[start])) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !/^[}\])]/.test(LINES[end])) end++;
  if (end >= LINES.length) throw new Error(`pgquery.test.js: no closing line found for '${name}'.`);
  return LINES.slice(start, end + 1).join('\n');
}

const sandbox = { URLSearchParams, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(grab('PgQuery') + '\nglobalThis.PgQuery = PgQuery;', sandbox);

const { PgQuery } = sandbox;
// What would go on the wire, minus the table name — `_run` is the only thing
// that reads it, and it interpolates exactly this.
const qs = q => String(q._params);

test('one order is one parameter, spelled as PostgREST spells it', () => {
  assert.equal(qs(new PgQuery('t').order('nonce', { ascending: true })), 'order=nonce.asc');
  assert.equal(qs(new PgQuery('t').order('sort_ts', { ascending: false })), 'order=sort_ts.desc');
  // No opts at all means ascending — every caller in the dapp that omits them
  // is relying on this, and it is the direction PostgREST defaults to anyway.
  assert.equal(qs(new PgQuery('t').order('nonce')), 'order=nonce.asc');
});

test('two orders are one parameter with two keys, not two parameters', () => {
  // The bug this file exists for. `order=nonce.asc&order=id.asc` is two
  // questions where PostgREST expects one, and it answers only one of them —
  // silently, with a 200 and rows that look right.
  const q = new PgQuery('tx_summary').order('nonce', { ascending: true }).order('id', { ascending: true });
  assert.equal(qs(q), 'order=nonce.asc%2Cid.asc');
  assert.deepEqual(q._params.getAll('order'), ['nonce.asc,id.asc'],
    'the sort arrived as more than one order parameter, so the tie-break is dropped on the floor');
});

test('direction is per key, not per query', () => {
  const q = new PgQuery('t').order('a', { ascending: false }).order('b', { ascending: true });
  assert.equal(q._params.get('order'), 'a.desc,b.asc');
});

test('ordering an embedded resource is a parameter of its own name', () => {
  // PostgREST spells an embedded sort as `<rel>.order=`, which is a different
  // parameter from the parent's — merging the two would sort the wrong list.
  const q = new PgQuery('tx_summary').order('nonce', { ascending: true }).orderOn('signatures', 'signer');
  assert.equal(q._params.get('order'), 'nonce.asc');
  assert.equal(q._params.get('signatures.order'), 'signer.asc');
});

test('the rest of the builder still spells what it always spelled', () => {
  // eq/in append, deliberately: several filters on one column is how PostgREST
  // expresses a range, and collapsing those the way `order` is collapsed would
  // turn two conditions into one.
  const q = new PgQuery('tx_summary')
    .select('id,nonce')
    .eq('wallet_id', 'w1')
    .in('status', ['proposed', 'queued'])
    .limit(40);
  assert.equal(q._params.get('select'), 'id,nonce');
  assert.equal(q._params.get('wallet_id'), 'eq.w1');
  assert.equal(q._params.get('status'), 'in.(proposed,queued)');
  assert.equal(q._params.get('limit'), '40');
  // ilike carries no wildcard on purpose: these columns hold hex, and an ilike
  // with no % or _ is just a case-blind =.
  assert.equal(qs(new PgQuery('wallets').ilike('address', '0xAbC')), 'address=ilike.0xAbC');
  // select and limit are set, not appended — calling either twice must leave one.
  const twice = new PgQuery('t').limit(1).limit(2).select('a').select('b');
  assert.deepEqual(twice._params.getAll('limit'), ['2']);
  assert.deepEqual(twice._params.getAll('select'), ['b']);
});

test('the queue asks for its tie-break', () => {
  // The reason the merge above exists. dbGetPending decides which of a contested
  // pair is the one every owner is offered controls on, so its sort has to be
  // total — and it has to be the same total order for everybody, which is what
  // `id` buys: arbitrary, but arbitrary in the same direction for every client.
  const body = grab('dbGetPending');
  assert.match(body, /\.order\('nonce'[^)]*\)\s*\n?\s*\.order\('id'/,
    'dbGetPending no longer orders by (nonce, id) — which of two proposals contesting a nonce is actionable goes back to being whatever the planner returned');
});
