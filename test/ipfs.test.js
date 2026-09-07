// How the app works out which pinned bundle it is.
//
//   node --test              (from the repo root; discovers every suite)
//
// The footer carries the CID of the build being run, and a CID cannot be written
// into the bundle it names — recording it would change it. So it is discovered
// at runtime, and the discovery has to cover every shape this app is served in:
//
//   https://multisig.wei.limo/            name-based: a gateway resolves the
//                                         contenthash and serves it at the name,
//                                         so the URL says nothing at all
//   https://ipfs.io/ipfs/<cid>/           path gateway: CID in the path
//   https://<cid>.ipfs.dweb.link/         subdomain gateway: CID as the origin
//   https://multisig.software/            no gateway: the sidecar records it
//
// The defect this file was written for: only the two middle shapes were read,
// and the app is published under the first. multisig.wei.limo (and .wei.is, and
// .wei.domains) serve the pin with the CID nowhere in the URL, and the fallback
// — dist/ipfs.json — is deliberately excluded from the pinned bundle, so it 404s
// there. The footer was blank on the one deployment that mattered.
//
// The gateway names the CID in a header in all three IPFS shapes, and this page
// asks its own URL, which is same-origin, so nothing has to be opted into.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'dapp', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

function grab(name) {
  const re = new RegExp(`^(async function|const|let|var|function)\\s+${name}\\b`);
  const start = LINES.findIndex(l => re.test(l));
  if (start === -1) throw new Error(`ipfs.test.js: '${name}' is no longer in dapp/index.html — it was renamed or removed, and its coverage went with it.`);
  const opens = (LINES[start].match(/\{/g) || []).length;
  const closes = (LINES[start].match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return LINES[start];
  if (opens === 0 && /;\s*$/.test(LINES[start])) return LINES[start];
  let end = start + 1;
  while (end < LINES.length && !LINES[end].startsWith('}')) end++;
  return LINES.slice(start, end + 1).join('\n');
}

// A real CID, and the one this suite's assertions are about.
const CID = 'bafybeiaqci4xd7576xkct47izwuir2dovp3p5k5zoqgolbxxlp3oqddg4a';
// The second entry x-ipfs-roots carries: the file under the directory, which is
// emphatically not the thing to show.
const CHILD = 'bafybeigjxitpjq4iqg7bz7afgjaks3ftmcuohnbl3w6eiv4ppmksf4i4c4';

const sandbox = { console: { ...console, warn() {}, error() {} }, location: { hostname: 'example.com', pathname: '/', protocol: 'https:', href: 'https://example.com/' } };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(grab('IPFS_CID_RE') + '\n' + grab('_ipfsCidFromHeaders') + '\nglobalThis.IPFS_CID_RE = IPFS_CID_RE; globalThis._ipfsCidFromHeaders = _ipfsCidFromHeaders;', sandbox);
const { _ipfsCidFromHeaders, IPFS_CID_RE } = sandbox;

// Headers, as a fetch Response exposes them: case-insensitive, null when absent.
const res = h => ({ headers: { get: k => { const f = Object.keys(h).find(x => x.toLowerCase() === k.toLowerCase()); return f === undefined ? null : h[f]; } } });

test('a name-based gateway names the root directly', () => {
  // multisig.wei.limo, .wei.is and .wei.domains all answer with exactly this,
  // and nothing else about the request says which bundle replied.
  assert.equal(_ipfsCidFromHeaders(res({ 'x-ipfs-cid': CID })), CID);
  assert.equal(_ipfsCidFromHeaders(res({ 'X-Ipfs-Cid': CID })), CID, 'header lookup must not be case-sensitive');
  assert.equal(_ipfsCidFromHeaders(res({ 'x-ipfs-cid': `  ${CID}  ` })), CID, 'a padded header value is still that CID');
});

test('x-ipfs-roots is read outermost-first, never the file under it', () => {
  // kubo and ipfs.io both send the whole chain. The root leads; taking any other
  // entry would put the hash of index.html in a footer that claims to name the
  // bundle, and it would look entirely plausible.
  assert.equal(_ipfsCidFromHeaders(res({ 'x-ipfs-roots': `${CID},${CHILD}` })), CID);
  assert.equal(_ipfsCidFromHeaders(res({ 'x-ipfs-roots': `${CID}, ${CHILD}` })), CID);
  assert.equal(_ipfsCidFromHeaders(res({ 'x-ipfs-roots': CID })), CID);
});

test('x-ipfs-path gives up the root when it is the only header there', () => {
  assert.equal(_ipfsCidFromHeaders(res({ 'x-ipfs-path': `/ipfs/${CID}/index.html` })), CID);
  assert.equal(_ipfsCidFromHeaders(res({ 'x-ipfs-path': `/ipfs/${CID}/` })), CID);
  assert.equal(_ipfsCidFromHeaders(res({ 'x-ipfs-path': `/ipfs/${CID}` })), CID);
  assert.equal(_ipfsCidFromHeaders(res({ 'x-ipfs-path': `/ipfs/${CID}/docs.html?x=1` })), CID);
});

test('the direct header wins over the ones that need unpacking', () => {
  // A gateway may send several. The one that states the root outright is the one
  // with no parsing between it and the answer.
  assert.equal(_ipfsCidFromHeaders(res({
    'x-ipfs-cid': CID, 'x-ipfs-roots': `${CHILD},${CHILD}`, 'x-ipfs-path': `/ipfs/${CHILD}/index.html`,
  })), CID);
});

test('a host that is not a gateway yields nothing, rather than something wrong', () => {
  // multisig.software sends no x-ipfs headers at all, and the caller falls
  // through to the sidecar. Anything but an empty string here would put a
  // fabricated CID in the footer.
  assert.equal(_ipfsCidFromHeaders(res({})), '');
  assert.equal(_ipfsCidFromHeaders(res({ 'content-type': 'text/html', 'server': 'cloudflare' })), '');
});

test('a header that is present but not a CID is refused', () => {
  for (const junk of ['', '   ', 'not-a-cid', 'QmNotBase32Enough', '../../etc/passwd', 'ba']) {
    assert.equal(_ipfsCidFromHeaders(res({ 'x-ipfs-cid': junk })), '', `x-ipfs-cid: ${JSON.stringify(junk)} must not be accepted`);
  }
  assert.equal(_ipfsCidFromHeaders(res({ 'x-ipfs-roots': 'garbage,more-garbage' })), '');
  assert.equal(_ipfsCidFromHeaders(res({ 'x-ipfs-path': '/not-ipfs/' + CID })), '', 'a path that is not under /ipfs/ is not a CID source');
});

test('the CID pattern accepts a base32 v1 and rejects what is not one', () => {
  assert.ok(IPFS_CID_RE.test(CID));
  assert.ok(IPFS_CID_RE.test(CHILD));
  for (const bad of ['QmPRPMHAeNBykwJKM3pvSqYqzi2GyENPZsDxKNN1VVhB35', 'bafy', '', 'BAFYBEIAQCI', 'ba1234567890']) {
    assert.ok(!IPFS_CID_RE.test(bad), `${JSON.stringify(bad)} must not read as a CIDv1`);
  }
});
