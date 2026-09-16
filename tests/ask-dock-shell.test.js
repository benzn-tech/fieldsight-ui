'use strict';
/*
 * SOURCE SCAN, not a behaviour test. app-shell.js cannot be required under
 * Node (no module.exports, reads window.FS.tokens at load), so this pins
 * the Footer slot's shape and location the way tests/middle-column-width.test.js
 * pins the width constants. Spec: docs/specs/2026-09-16-ask-dock.md §3.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const js  = read('scripts', 'app-shell.js');
const css = read('styles', 'app-shell.css');
const registry = read('scripts', 'pages', '_page-registry.js');

function sliceMiddleColumn() {
  const start = js.indexOf('function MiddleColumn(');
  assert.ok(start >= 0, 'function MiddleColumn( not found');
  const end = js.indexOf('function MobileBack(');
  assert.ok(end > start, 'function MobileBack( not found after MiddleColumn');
  return js.slice(start, end);
}

test('S1 the middle column reads a Footer from the page entry the way it reads Middle', () => {
  const slice = sliceMiddleColumn();
  assert.match(slice, /page\.Footer/);
  assert.match(slice, /React\.createElement\(\s*page\.Footer\s*,\s*\{/);
});

/* Walk forward from `openIdx` (which must point at an opening bracket)
   tracking nesting depth over ( ) { } [ ], skipping over string literals
   (single- and double-quoted, with backslash escapes) and // and /* *\/
   comments so bracket characters that merely appear in text don't perturb
   the count. Returns the offset of the bracket that closes the one at
   `openIdx`, or -1 if the text ends first. Good enough for this one file;
   not a general JS parser (no template literals, regex literals, etc. —
   none of those appear between the contentStyle div's open paren and its
   close in scripts/app-shell.js). */
function findMatchingClose(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

test('S2 the Footer is a sibling of the scrolling content, never a child of it', () => {
  const slice = sliceMiddleColumn();
  const footerMarkerIdx = slice.indexOf(
    '/* Footer slot — OUTSIDE the scrolling content (spec 2026-09-16 §3).'
  );
  assert.ok(footerMarkerIdx >= 0, 'Footer slot marker comment not found');
  const footerRefIdx = slice.indexOf('page.Footer', footerMarkerIdx);
  assert.ok(
    footerRefIdx > footerMarkerIdx,
    'page.Footer must appear after the marker comment (source order pin)'
  );

  /* The load-bearing check: STRUCTURE, not indentation. Find the specific
     `React.createElement('div', { style: contentStyle }, ...)` call and
     walk its argument list forward — counting nesting depth over brackets,
     skipping string/comment contents — to the offset where THAT call's own
     closing paren sits. A true sibling Footer slot has to start after that
     offset, because it isn't part of the contentStyle div's children list
     at all. If the Footer block were instead pasted in as the div's last
     child, its marker would land BEFORE that closing paren, however the
     block happens to be indented — this check doesn't read whitespace. */
  const callMatch = slice.match(/React\.createElement\('div', \{ style: contentStyle \}/);
  assert.ok(callMatch, 'contentStyle div createElement call not found');
  const openParenIdx = callMatch.index + callMatch[0].indexOf('(');
  assert.strictEqual(slice[openParenIdx], '(', 'expected an opening paren at the located offset');
  const contentDivCloseIdx = findMatchingClose(slice, openParenIdx);
  assert.ok(contentDivCloseIdx > openParenIdx, 'contentStyle div call never closes');
  assert.ok(
    footerMarkerIdx > contentDivCloseIdx,
    'the Footer slot must start after the contentStyle div\'s own closing ' +
    'paren (offset ' + contentDivCloseIdx + '), not before it — the marker ' +
    'sits at offset ' + footerMarkerIdx + ', which means the Footer is ' +
    'still nested inside the scroll container\'s children list'
  );

  /* Pin the Footer element itself: flexShrink: 0, and NOT a child of the
     contentStyle div's own createElement children list. */
  const footerBlock = slice.slice(footerMarkerIdx);
  assert.match(footerBlock, /flexShrink:\s*0/);
});

test('S3 a route without a Footer renders nothing', () => {
  const slice = sliceMiddleColumn();
  assert.match(slice, /page\s*&&\s*page\.Footer/);
});

test('S4 the footer class has a rule and it does not shrink', () => {
  const block = css.match(/(^|\n)\.middle-column__footer\s*\{([^}]*)\}/);
  assert.ok(block, '.middle-column__footer rule not found');
  assert.match(block[2], /flex-shrink:\s*0/);
});

test('S5 the registry documents the slot', () => {
  assert.match(registry, /Footer/);
});
