#!/usr/bin/env node
'use strict';
// Build the deployable copy of the dapp: dapp/ in, dist/ out, comments gone.
//
// This project is one static file you can read. That is the point of it — the
// reasoning behind every guard, every ordering choice and every audit mitigation
// sits beside the line it is about, and the file a reviewer opens is the file the
// site serves. It is also 236 KB of prose, gzipped to about 93 KB, which is 39%
// of what a visitor downloads before the page can do anything, on a page that
// already ships a 505 KB signing library.
//
// So the source keeps its comments and the deployment does not. Nothing here
// renames, reorders, reformats or rewrites anything: it removes comment spans and
// the whitespace that only existed to lay them out. Every token that is not a
// comment comes through byte-for-byte, in the same order.
//
// No dependencies, deliberately. This repo vendors ethers rather than installing
// it, and a build step that needs a package tree is a build step that can fail
// for reasons that have nothing to do with this project. `node build.js` is the
// whole contract.
//
// It refuses rather than guesses. The scanner below tracks strings, template
// literals (including nested ${} expressions), regular-expression literals and
// comments, and it proves its own output before anything is written: the stripped
// text must contain exactly the same literals, in the same order, as the text it
// came from, and it must still parse. A build that cannot show that throws, and
// the previous dist/ is left where it is. Silently shipping a corrupted wallet is
// the one outcome this must not have.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = path.join(__dirname, 'dapp');
const OUT = path.join(__dirname, 'dist');

// ── READING JAVASCRIPT ────────────────────────────────────────────
// One scanner, character by character, reporting comments and literals as it
// passes them. Everything below is a different use of this one walk, so there is
// a single definition of how this file reads JavaScript.
//
// The hard part of reading JavaScript without parsing it is that `/` is either
// division or the start of a regular expression, and the two are told apart only
// by what came before. Getting it backwards is not a cosmetic error: reading
// /^0x[0-9a-fA-F]{40}$/ as division leaves the scanner adrift, and the next `//`
// inside a URL swallows the rest of the file.
//
// The rule is the standard one — after a value `/` divides, after an operator or
// a keyword that expects an expression it opens a regex — and it is not trusted
// on its own. stripJs checks it after the fact, by comparing the literals found
// in the output against the literals found in the input. A misread `/` moves
// those boundaries, and the comparison catches it.
const REGEX_OK_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);
const ID_CHAR = /[A-Za-z0-9_$]/;

// onComment(start, end, kind) and onLiteral(start, end) are called with half-open
// ranges into `src`. A template literal is reported in chunks — backtick to `${`,
// then `}` to the next `${` or to the closing backtick — because what sits
// between them is code, not text.
function scanJs(src, onComment, onLiteral) {
  const noop = () => {};
  onComment = onComment || noop;
  onLiteral = onLiteral || noop;
  // Each `${` pushes the brace depth it interrupted, so the `}` that ends the
  // expression is the one that returns to it — and a `}` closing an object
  // literal inside the expression does not end the template early.
  const tmpl = [];
  let depth = 0;      // brace depth within the current ${} expression
  let prev = '';      // last significant token: an operator char, or a word
  let i = 0;
  const n = src.length;

  const regexAllowed = () => {
    if(!prev) return true;
    if(prev === ')' || prev === ']' || prev === '++' || prev === '--') return false;
    if(ID_CHAR.test(prev[0])) return REGEX_OK_WORDS.has(prev);   // a word or a number
    return true;                                                 // an operator
  };
  // Consume template text from `from` (a backtick or the `}` that ended an
  // expression) up to the next `${` or the closing backtick.
  const templateChunk = from => {
    for(let j = from + 1; j < n; j++) {
      if(src[j] === '\\') { j++; continue; }
      if(src[j] === '`') { onLiteral(from, j + 1); prev = 'x'; return j + 1; }
      if(src[j] === '$' && src[j + 1] === '{') {
        onLiteral(from, j + 2);
        tmpl.push(depth); depth = 0; prev = '';
        return j + 2;
      }
    }
    throw new Error('unterminated template literal at ' + from);
  };

  while(i < n) {
    const c = src[i];
    if(c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }

    if(c === '/' && src[i + 1] === '/') {
      let j = i + 2;
      while(j < n && src[j] !== '\n') j++;
      onComment(i, j, 'line');
      i = j;
      continue;
    }
    if(c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      if(j < 0) throw new Error('unterminated block comment at ' + i);
      onComment(i, j + 2, 'block');
      i = j + 2;
      continue;
    }
    if(c === '/' && regexAllowed()) {
      let j = i + 1, inClass = false;
      for(; j < n; j++) {
        const d = src[j];
        if(d === '\\') { j++; continue; }
        if(d === '[') inClass = true;
        else if(d === ']') inClass = false;
        else if(d === '/' && !inClass) break;
        else if(d === '\n') throw new Error('unterminated regex at ' + i);
      }
      if(j >= n) throw new Error('unterminated regex at ' + i);
      j++;
      while(j < n && ID_CHAR.test(src[j])) j++;                  // flags
      onLiteral(i, j); prev = 'x'; i = j;
      continue;
    }
    if(c === '"' || c === "'") {
      let j = i + 1;
      for(; j < n; j++) {
        if(src[j] === '\\') { j++; continue; }
        if(src[j] === c) break;
        if(src[j] === '\n') throw new Error('unterminated string at ' + i);
      }
      if(j >= n) throw new Error('unterminated string at ' + i);
      onLiteral(i, j + 1); prev = 'x'; i = j + 1;
      continue;
    }
    if(c === '`') { i = templateChunk(i); continue; }
    if(c === '{') { depth++; prev = '{'; i++; continue; }
    if(c === '}') {
      if(depth === 0 && tmpl.length) { depth = tmpl.pop(); i = templateChunk(i); continue; }
      depth--; prev = '}'; i++;
      continue;
    }
    if(ID_CHAR.test(c)) {
      let j = i;
      while(j < n && (ID_CHAR.test(src[j]) || (src[j] === '.' && /[0-9]/.test(c)))) j++;
      prev = src.slice(i, j); i = j;
      continue;
    }
    if((c === '+' || c === '-') && src[i + 1] === c) { prev = c + c; i += 2; continue; }
    prev = c; i++;
  }
  if(tmpl.length) throw new Error('unterminated template literal');
}

const literalsOf = src => { const out = []; scanJs(src, null, (a, b) => out.push(src.slice(a, b))); return out; };

// ── STRIPPING JAVASCRIPT ──────────────────────────────────────────
function stripJs(src) {
  const cuts = [];
  scanJs(src, (a, b, kind) => cuts.push([a, b, kind]), null);
  let out = '', at = 0;
  for(const [a, b, kind] of cuts) {
    out += src.slice(at, a);
    // A block comment that spans lines counts as a line terminator for automatic
    // semicolon insertion, so removing one outright can weld two statements
    // together — `a = b /*\n*/ c` is two statements before and one after. Leave a
    // newline in its place; a comment that fits on one line leaves nothing.
    if(kind === 'block' && src.lastIndexOf('\n', b) >= a) out += '\n';
    at = b;
  }
  out += src.slice(at);
  out = tidy(out);

  // The proof. A comment carries no tokens, so removing every comment has to
  // leave the literals — strings, templates, regexes — exactly as they were. If
  // the scanner took a regex for division anywhere, or the other way round, its
  // idea of where literals begin and end moved, and these will not match.
  const before = literalsOf(src), after = literalsOf(out);
  if(before.length !== after.length)
    throw new Error(`literal count changed: ${before.length} -> ${after.length}`);
  for(let k = 0; k < before.length; k++)
    if(before[k] !== after[k])
      throw new Error(`literal ${k} changed:\n  in:  ${JSON.stringify(before[k].slice(0, 100))}\n  out: ${JSON.stringify(after[k].slice(0, 100))}`);
  // And it still has to be JavaScript. Function() compiles without running, so a
  // syntax error surfaces here rather than on somebody's screen.
  try { new Function(out); }
  catch(e) { throw new Error('stripped script does not parse: ' + e.message); }
  return out;
}

// The whitespace that only existed to lay comments out: indentation, trailing
// spaces, and the blank lines left where a comment block used to be.
//
// Newlines between code are never removed — automatic semicolon insertion reads
// them — and nothing inside a literal is touched, because a template literal in
// this app is HTML, where the spaces are the layout. There is at least one place
// in the source that says so explicitly: "the whitespace between the two spans is
// real ... a screen reader would otherwise say 1D TIMELOCKINSTANT".
function tidy(src) {
  const inLit = new Uint8Array(src.length);
  scanJs(src, null, (a, b) => { for(let i = a; i < b; i++) inLit[i] = 1; });

  const out = [];
  let start = 0;
  for(let i = 0; i <= src.length; i++) {
    if(i !== src.length && src[i] !== '\n') continue;
    let s = start, e = i;
    while(s < e && (src[s] === ' ' || src[s] === '\t') && !inLit[s]) s++;
    while(e > s && (src[e - 1] === ' ' || src[e - 1] === '\t') && !inLit[e - 1]) e--;
    const text = src.slice(s, e);
    // An empty line that no literal runs through was a comment line, or a blank
    // one, and its newline goes with it. Removing it cannot affect semicolon
    // insertion: the newlines on either side of a blank line are two, and one
    // remains. A blank line *inside* a template is content, and stays.
    const insideLiteral = start < src.length && inLit[start];
    if(!text && !insideLiteral) { start = i + 1; continue; }
    out.push(text);
    start = i + 1;
  }
  return out.join('\n');
}

// ── CSS ───────────────────────────────────────────────────────────
// One comment form and no `//`, so this needs only to know where strings are: a
// `/*` inside a content: value or a data: URL is text, not a comment.
function stripCss(src) {
  let out = '', i = 0;
  const n = src.length;
  while(i < n) {
    const c = src[i];
    if(c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      if(j < 0) throw new Error('unterminated CSS comment');
      i = j + 2;
      continue;
    }
    if(c === '"' || c === "'") {
      let j = i + 1;
      for(; j < n; j++) { if(src[j] === '\\') { j++; continue; } if(src[j] === c) break; }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  // Only the blank lines the comments left behind. Indentation is deliberately
  // left alone: a declaration whose value runs over several lines carries that
  // indentation *inside the value*, and while CSS treats it as insignificant,
  // "insignificant" is a claim about a parser rather than a fact about this
  // file. Measured, the whole of this file's CSS indentation is worth 101 bytes
  // gzipped — repeated leading spaces are the one thing gzip is best at — and
  // that is not a price worth paying for a transform that has to be argued
  // about. Removing it also made the built stylesheet stop matching the source
  // rule-for-rule, which is the check that proves this step is safe.
  return out.split('\n').filter(l => l.trim() !== '').join('\n');
}

// ── HTML ──────────────────────────────────────────────────────────
// Conditional comments (`<!--[if`) are markup rather than annotation, and the
// <noscript> fallback and unfurl tags are content — only real comments go.
function stripHtmlComments(src) {
  let out = '', i = 0;
  while(i < src.length) {
    const a = src.indexOf('<!--', i);
    if(a < 0) { out += src.slice(i); break; }
    if(src.startsWith('<!--[if', a)) {
      const e = src.indexOf('-->', a);
      if(e < 0) { out += src.slice(i); break; }
      out += src.slice(i, e + 3);
      i = e + 3;
      continue;
    }
    const b = src.indexOf('-->', a + 4);
    if(b < 0) { out += src.slice(i); break; }
    out += src.slice(i, a);
    let j = b + 3;
    // A comment that had a line to itself takes the line with it. One that sat
    // beside markup leaves the markup's own spacing alone — in HTML that spacing
    // is sometimes a word gap.
    const lineSoFar = out.slice(out.lastIndexOf('\n') + 1);
    if(!lineSoFar.trim()) {
      out = out.slice(0, out.lastIndexOf('\n') + 1);
      while(src[j] === ' ' || src[j] === '\t') j++;
      if(src[j] === '\n') j++;
    }
    i = j;
  }
  return out;
}

// Split on inline <script> and <style>, hand each body to the stripper that
// understands its comment syntax, and put the document back. A <script src=...>
// has no body here; the file it points at is built (or copied) on its own.
function buildHtml(src, name) {
  const re = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let out = '', at = 0, m;
  while((m = re.exec(src))) {
    out += stripHtmlComments(src.slice(at, m.index));
    const [whole, tag, attrs, body] = m;
    if(/\bsrc\s*=/i.test(attrs)) out += whole;
    else if(tag.toLowerCase() === 'script') {
      const stripped = stripJs(body);
      // A `</script` anywhere in the body would end the block early. Removing
      // text cannot introduce one, but assert it rather than assume it.
      if(/<\/script/i.test(stripped)) throw new Error(name + ': stripped script contains </script');
      out += `<${tag}${attrs}>` + stripped + `</${tag}>`;
    } else out += `<${tag}${attrs}>` + stripCss(body) + `</${tag}>`;
    at = m.index + whole.length;
  }
  return out + stripHtmlComments(src.slice(at));
}

// ── RUN ───────────────────────────────────────────────────────────
const kb = b => (b / 1024).toFixed(1) + ' KB';
const gz = buf => zlib.gzipSync(buf, { level: 9 }).length;

// Everything under dapp/, as paths relative to it. Recursive, so a directory
// added later is published rather than silently dropped.
function walk(dir, base = '') {
  const out = [];
  for(const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true }).sort((x, y) => x.name < y.name ? -1 : 1)) {
    const rel = base ? path.join(base, e.name) : e.name;
    if(e.isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out;
}

function main() {
  // Every file is built and checked before any of it is written, so a build that
  // throws leaves the previous dist/ exactly as it was rather than half-replaced.
  const built = [];
  for(const file of walk(SRC)) {
    const raw = fs.readFileSync(path.join(SRC, file));
    let out;
    if(/\.html$/i.test(file)) out = Buffer.from(buildHtml(raw.toString('utf8'), file), 'utf8');
    // Already minified upstream, and not ours to rewrite.
    else if(/\.min\.js$/i.test(file)) out = raw;
    else if(/\.js$/i.test(file)) out = Buffer.from(stripJs(raw.toString('utf8')), 'utf8');
    else if(/\.css$/i.test(file)) out = Buffer.from(stripCss(raw.toString('utf8')), 'utf8');
    else out = raw;
    built.push([file, raw, out]);
  }

  // A fresh directory rather than an overwrite, so a file that stops existing in
  // dapp/ does not go on being served out of dist/.
  fs.rmSync(OUT, { recursive: true, force: true });
  let sa = 0, sb = 0, ga = 0, gb = 0;
  const rows = [];
  for(const [file, raw, out] of built) {
    const to = path.join(OUT, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, out);
    const za = gz(raw), zb = gz(out);
    sa += raw.length; sb += out.length; ga += za; gb += zb;
    if(out.length !== raw.length) rows.push([file, raw.length, out.length, za, zb]);
  }

  const line = (f, a, b, x, y) =>
    `  ${f.padEnd(24)} ${kb(a).padStart(10)} -> ${kb(b).padStart(9)}   gz ${kb(x).padStart(9)} -> ${kb(y).padStart(9)}   -${(100 - y / x * 100).toFixed(0)}%`;
  console.log('dapp/ -> dist/');
  for(const r of rows) console.log(line(...r));
  console.log(line('TOTAL', sa, sb, ga, gb));
}

main();
