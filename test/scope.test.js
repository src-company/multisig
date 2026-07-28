// Every identifier the dapp reaches for is one something declared.
//
//   node --test              (from the repo root; discovers all four suites)
//
// This exists because of one line that shipped:
//
//   const mustApprove = cannotSign(ct.connectedAddress, S.chainId);   // renderDash
//
// `ct` is the deploy overlay's context object. It is declared in this file three
// times, in three other functions, and never in that one. Nothing caught it: the
// file parses, `new Function()` compiles it, the build's own literal check is
// about comments, and no suite called renderDash. What a co-signer got was a
// blank page — renderDash builds the page as one string and renderNow assigns it
// to #app at the end, so a throw never reaches the assignment, #app keeps an
// empty div, and every later render throws in the same place.
//
// A parser would settle this properly. This repo has no dependencies by design,
// so instead: read the file with the scanner build.js already uses to strip
// comments — the one whose regex-versus-division handling the build proves on
// every run — and check, per top-level function, that every identifier it names
// is either its own local, something declared at the top level, or a global.
//
// It is a heuristic, and it is written to fail in the safe direction: a name it
// cannot account for is reported, and the fix is either a real bug or a line in
// GLOBALS below. What it must never do is what its first draft did — a greedy
// declarator regex swallowed initialiser expressions, so `const hit = ct.foo`
// registered `ct` as declared and the whole scan came back clean on the very bug
// it was written to find. bindersOf() below is the correction, and the last test
// in this file is the proof: it reintroduces the bug into a copy of the source
// and asserts the scan reports it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const DAPP = path.join(ROOT, 'dapp');

// ── the scanner, borrowed from the build ──────────────────────────
// Lifted rather than copied: one definition of how this project reads
// JavaScript, and it is the one the build already checks itself against.
const BUILD = fs.readFileSync(path.join(ROOT, 'build.js'), 'utf8');
const scanJs = (() => {
  const a = BUILD.indexOf('const REGEX_OK_WORDS');
  const b = BUILD.indexOf('const literalsOf');
  if (a === -1 || b === -1 || b < a) throw new Error('scope.test.js: build.js no longer exposes scanJs where this expects it.');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(BUILD.slice(a, b) + '\nglobalThis.scanJs = scanJs;', ctx);
  return ctx.scanJs;
})();

// ── what a `const|let|var` run actually binds ─────────────────────
// At depth 0 a declarator begins. If it opens with `{` or `[`, every identifier
// in that pattern binds (bar property keys); otherwise the leading identifier
// binds and everything to the next depth-0 comma is an initialiser, which binds
// nothing. Getting this wrong in the lax direction is what makes the whole check
// vacuous — see the note at the top.
function bindersOf(text, start) {
  const names = [];
  let i = start;
  const n = text.length;
  for (;;) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    if (text[i] === '{' || text[i] === '[') {
      const open = text[i], close = open === '{' ? '}' : ']';
      let d = 0, j = i;
      for (; j < n; j++) {
        if (text[j] === open) d++;
        else if (text[j] === close) { d--; if (!d) break; }
      }
      const pat = text.slice(i, j + 1);
      const re = /([A-Za-z_$][\w$]*)\s*(:?)/g;
      let x;
      while ((x = re.exec(pat))) if (x[2] !== ':') names.push(x[1]);
      i = j + 1;
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
      if (!m) break;
      names.push(m[0]);
      i += m[0].length;
    }
    let depth = 0;
    let ended = false;
    for (; i < n; i++) {
      const c = text[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (depth === 0) return names; depth--; }
      else if (c === ';' && depth === 0) return names;
      else if (c === ',' && depth === 0) { i++; ended = true; break; }
      else if (c === '\n' && depth === 0) {
        const rest = /^\s*(,)/.exec(text.slice(i + 1));
        if (!rest) return names;
      }
    }
    if (!ended) break;
  }
  return names;
}

// ── reading one file ──────────────────────────────────────────────
// Comments and literal text are blanked in place, so offsets — and therefore
// line numbers — survive. A template literal is reported in chunks, so what
// sits inside `${...}` stays code, which is where most of this app lives.
function codeOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  let text;
  if (file.endsWith('.js')) text = src;
  else {
    text = src.replace(/[^\n]/g, ' ');
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(src))) {
      const at = m.index + m[0].indexOf('>') + 1;
      text = text.slice(0, at) + m[1] + text.slice(at + m[1].length);
    }
  }
  const chars = text.split('');
  const blank = (s, e) => { for (let i = s; i < e; i++) if (chars[i] !== '\n') chars[i] = ' '; };
  scanJs(text, blank, blank);
  return chars.join('');
}

// What a page's own <script src> tags put on the window before its inline
// script runs. index.html calls walletSwitchChain(), walletRebindSigner() and
// half a dozen others that wallet.js declares as `window.foo = …`, and those are
// as real a declaration as anything in the file — they are just in the file
// beside it. Read from the page's tags in order rather than listed here, so
// adding a script, or reordering two, needs no change to this suite.
function preludeOf(file) {
  const names = new Set();
  if (file.endsWith('.js')) return names;
  const src = fs.readFileSync(file, 'utf8');
  const re = /<script[^>]*\bsrc=["']\.\/([\w.-]+\.js)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const dep = path.join(path.dirname(file), m[1]);
    if (!fs.existsSync(dep)) continue;
    // Minified vendor bundles are not read for identifiers; only what they
    // publish matters, and that is picked up by the same window.* rule.
    const bare = codeOf(dep);
    const g = /\b(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*=[^=]/g;
    let x;
    while ((x = g.exec(bare))) names.add(x[1]);
  }
  return names;
}

function declsIn(text, into) {
  let x;
  for (const re of [
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
  ]) while ((x = re.exec(text))) into.add(x[1]);
  { const re = /\b(?:const|let|var)\s+/g;
    while ((x = re.exec(text))) for (const t of bindersOf(text, re.lastIndex)) into.add(t); }
  for (const re of [
    /\bfunction\s*\*?\s*[\w$]*\s*\(([\s\S]{0,400}?)\)/g,
    /\(([^()]{0,300}?)\)\s*=>/g,
  ]) while ((x = re.exec(text))) for (const t of x[1].match(/[A-Za-z_$][\w$]*/g) || []) into.add(t);
  { const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g; while ((x = re.exec(text))) into.add(x[2]); }
  { const re = /(^|[,{\n]\s*)([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g; while ((x = re.exec(text))) into.add(x[2]); }
  return into;
}

// Names bound at the top level of the file. Both the dapp's inline script and
// wallet.js's IIFE body sit unindented, so column 0 is the test — which is also
// what keeps a name declared inside some other function from counting, and that
// is the whole point.
function topLevelOf(bare) {
  const top = new Set();
  let x;
  for (const re of [
    /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
    /^class\s+([A-Za-z_$][\w$]*)/gm,
  ]) while ((x = re.exec(bare))) top.add(x[1]);
  { const re = /^(?:const|let|var)\s+/gm;
    while ((x = re.exec(bare))) for (const t of bindersOf(bare, re.lastIndex)) top.add(t); }
  // `window.foo = …` at the top of a file declares a global as surely as `var`
  // does, and wallet.js states its whole public surface that way.
  { const re = /\b(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*=[^=]/g;
    while ((x = re.exec(bare))) top.add(x[1]); }
  return top;
}

const GLOBALS = new Set((
  'Object Array String Number Boolean Math JSON Date RegExp Error TypeError RangeError SyntaxError ' +
  'Map Set WeakMap WeakSet Promise Symbol BigInt Infinity NaN undefined Intl Proxy Reflect Function ' +
  'isFinite isNaN parseInt parseFloat encodeURIComponent decodeURIComponent encodeURI decodeURI ' +
  'window document location history navigator localStorage sessionStorage console globalThis self ' +
  'setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame ' +
  'fetch AbortController Event CustomEvent URL URLSearchParams TextEncoder TextDecoder matchMedia ' +
  'getComputedStyle performance crypto atob btoa structuredClone queueMicrotask ' +
  'Node Element HTMLElement Image FormData Blob File Headers Request Response ' +
  // Loaded before the app's own script, from files this repo vendors.
  'ethers'
).split(/\s+/));

const KEYWORD = /^(if|for|while|switch|catch|return|typeof|new|delete|void|in|of|do|else|case|function|await|async|throw|try|class|const|let|var|instanceof|yield|this|super|break|continue|finally|default|export|import|extends|static|get|set|true|false|null)$/;

// Identifiers a top-level function names that nothing accounts for.
function unresolved(bare, prelude) {
  const top = topLevelOf(bare);
  for (const n of (prelude || [])) top.add(n);
  const lines = bare.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
    if (!h) continue;
    let j = i;
    const opens = (lines[i].match(/\{/g) || []).length, closes = (lines[i].match(/\}/g) || []).length;
    if (!(opens > 0 && opens === closes)) { j = i + 1; while (j < lines.length && !/^\}/.test(lines[j])) j++; }
    const body = lines.slice(i, j + 1).join('\n');
    const local = declsIn(body, new Set());
    const re = /(^|[^\w$.?])([A-Za-z_$][\w$]*)\s*(?=[.([])/gm;
    let x;
    while ((x = re.exec(body))) {
      const name = x[2];
      if (KEYWORD.test(name) || GLOBALS.has(name) || top.has(name) || local.has(name)) continue;
      out.push({ fn: h[1], name, line: i + body.slice(0, x.index).split('\n').length });
    }
  }
  // One report per (function, identifier); the line is the first sighting.
  const seen = new Map();
  for (const p of out) { const k = p.fn + '|' + p.name; if (!seen.has(k)) seen.set(k, p); }
  return [...seen.values()];
}

const say = ps => ps.map(p => `  ${p.name} — referenced in ${p.fn}() around line ${p.line}, declared nowhere it can see`).join('\n');

// ── the check ─────────────────────────────────────────────────────

for (const file of ['index.html', 'wallet.js', 'docs.html', 'brand.html']) {
  test(`${file} names nothing it has not declared`, () => {
    const f = path.join(DAPP, file);
    const ps = unresolved(codeOf(f), preludeOf(f));
    assert.deepEqual(ps, [], ps.length ? `\n${say(ps)}\n` : '');
  });
}

// ── the check, checked ────────────────────────────────────────────

test('the scan reports a reference to a name declared only in another function', () => {
  // The bug this file exists for, put back into a copy of the real source. If
  // this ever passes silently, the scan above has stopped being worth running —
  // which is exactly what happened to its first draft.
  const src = fs.readFileSync(path.join(DAPP, 'index.html'), 'utf8');
  const good = 'const mustApprove = !S.demoMode && cannotSign(you, S.chainId);';
  assert.ok(src.includes(good), 'renderDash no longer contains the line this proof is built on — update it.');
  const bare = codeOf(path.join(DAPP, 'index.html'));
  // `ct` is declared in renderDeployOverlay, txReviewBody and updateTxReview —
  // so a scan that merely collected declarations file-wide would miss it.
  assert.ok(/\bconst ct = /.test(bare), 'expected `ct` to still be a local of some other function');
  const broken = bare.replace(
    'const mustApprove = !S.demoMode && cannotSign(you, S.chainId);',
    'const mustApprove = cannotSign(ct.connectedAddress, S.chainId);');
  const ps = unresolved(broken, preludeOf(path.join(DAPP, 'index.html')));
  assert.ok(ps.some(p => p.name === 'ct' && p.fn === 'renderDash'),
    'the scan did not report `ct` in renderDash — it would not have caught the bug it was written for');
});
