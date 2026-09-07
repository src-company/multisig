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

test('the queue keeps a deterministic nonce/id order after pagination', async () => {
  const rows = [{nonce:2,id:'b'}, {nonce:1,id:'b'}, {nonce:1,id:'a'}];
  const context = { sb: { from:()=>({ eq(){return this;}, in(){return this;} }) },
    dbReadProposalPages: async () => ({ rows: [...rows], sigs: true }) };
  vm.createContext(context);
  vm.runInContext(grab('dbGetPending'), context);
  const result = await context.dbGetPending('vault');
  assert.deepEqual(result.rows.map(r=>r.id), ['a','b','b']);
  assert.deepEqual(result.rows.map(r=>r.nonce), [1,1,2]);
});

function coordinationContext() {
  const ctx={console:{error(){}},S:{chainId:1},URLSearchParams};
  ctx.window=ctx; vm.createContext(ctx);
  for(const name of ['PgQuery','SIG_EMBED','PROPOSAL_PAGE_SIZE','TERMINAL_COLS',
    'dbReadProposalPages','dbGetRecentTerminal','dbSyncWalletState'])
    vm.runInContext(grab(name),ctx);
  vm.runInContext('globalThis.sb={from:table=>new PgQuery(table)};',ctx);
  ctx.pgJson=JSON.parse;
  return ctx;
}

test('terminal recovery paginates beyond the server cap using stable keys',async()=>{
  const ctx=coordinationContext();
  const rows=Array.from({length:1205},(_,i)=>({id:String(i).padStart(5,'0'),nonce:4,signatures:[]}));
  const requests=[];
  ctx.pgFetch=async path=>{
    const params=new URLSearchParams(path.split('?')[1]); requests.push(params);
    const cursor=(params.get('id')||'gt.').slice(3);
    const page=rows.filter(r=>r.id>cursor).slice(0,Math.min(137,Number(params.get('limit'))));
    return {ok:true,text:async()=>JSON.stringify(page)};
  };
  const result=await ctx.dbGetRecentTerminal('vault',5);
  assert.equal(result.rows.length,1205);
  assert.equal(new Set(result.rows.map(r=>r.id)).size,1205);
  assert.ok(requests.length>8);
  for(const p of requests){assert.equal(p.get('order'),'id.asc');assert.equal(p.get('nonce'),'lt.5');}
});

test('a failed later page cannot look like a complete terminal inventory',async()=>{
  const ctx=coordinationContext();
  ctx.pgFetch=async path=>path.includes('id=gt.')
    ? {ok:false,status:503,text:async()=> 'unavailable'}
    : {ok:true,text:async()=>JSON.stringify([{id:'a',nonce:4,signatures:[]}])};
  const result=await ctx.dbGetRecentTerminal('vault',5);
  assert.equal(result.failed,true); assert.equal(result.rows.length,0);
});

const OWNER='0x1111111111111111111111111111111111111111';
const SQUATTER='0x2222222222222222222222222222222222222222';
const VAULT='0x3333333333333333333333333333333333333333';
function repairContext({owner=OWNER,firstError='Not an owner',change=null,recordChain=1}={}) {
  const ctx=coordinationContext();ctx._connectedAddress=owner;
  const writes=[];
  ctx.sb.rpc=async(fn,params)=>{writes.push({...params});return writes.length===1&&firstError?{error:{message:firstError}}:{error:null};};
  ctx.pgFetch=async path=>{
    if(change==='account')ctx._connectedAddress=SQUATTER;
    if(change==='chain')ctx.S.chainId=8453;
    return {ok:true,text:async()=>JSON.stringify(path.startsWith('wallets?')
      ? [{id:'w',address:VAULT,chain_id:recordChain}]:[{address:SQUATTER}])};
  };
  const state={owners:[OWNER],threshold:1,ownerCount:1,delay:0,nonce:3,executor:SQUATTER};
  return {ctx,writes,state};
}

test('a verified chain owner can repair an initially squatted coordination record',async()=>{
  const {ctx,writes,state}=repairContext();
  assert.equal(await ctx.dbSyncWalletState(VAULT,'w',state),true);
  assert.equal(writes.length,2);assert.equal(writes[0].p_caller,OWNER);assert.equal(writes[1].p_caller,SQUATTER);
  assert.deepEqual([...writes[1].p_owners],[OWNER]);
  assert.equal(writes[1].p_nonce,3);
});

test('ordinary owner sync still uses one request',async()=>{
  const {ctx,writes,state}=repairContext({firstError:null});
  assert.equal(await ctx.dbSyncWalletState(VAULT,'w',state),true);assert.equal(writes.length,1);
});

test('repair refuses nonowners, network errors, mismatched records and changed sessions',async()=>{
  for(const opts of [{owner:SQUATTER},{firstError:'timeout'},{change:'account'},{change:'chain'},{recordChain:8453}]) {
    const {ctx,writes,state}=repairContext(opts);
    assert.equal(await ctx.dbSyncWalletState(VAULT,'w',state),false,JSON.stringify(opts));
    assert.ok(writes.length<=1,'must not retry with a public writer claim');
  }
});

test('plain signature fallback bounds URL size and paginates every signature',async()=>{
  const ctx=coordinationContext();
  vm.runInContext(grab('dbGetSigsByTxIds'),ctx);
  ctx.dbError=(label)=>new Error(label);
  const ids=Array.from({length:105},(_,i)=>`tx${String(i).padStart(4,'0')}`);
  const sigs=ids.flatMap(tx_id=>Array.from({length:30},(_,i)=>({id:tx_id+String(i).padStart(3,'0'),tx_id,signer:OWNER,signature:'0x',sig_type:'ecdsa'})));
  ctx.pgFetch=async path=>{
    const p=new URLSearchParams(path.split('?')[1]);
    const selected=p.get('tx_id').slice(4,-1).split(','); assert.ok(selected.length<=40);
    const cursor=(p.get('id')||'gt.').slice(3);
    const page=sigs.filter(s=>selected.includes(s.tx_id)&&s.id>cursor).slice(0,83);
    return {ok:true,text:async()=>JSON.stringify(page)};
  };
  const result=await ctx.dbGetSigsByTxIds(ids);
  for(const id of ids)assert.equal(result.get(id).length,30);
});
