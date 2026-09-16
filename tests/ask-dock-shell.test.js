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
const composites = read('styles', 'composites.css');

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

/* Slice the dock's own CSS out of the shared composites.css file, so S6/S7
   pin only what this task added, not the whole file (which already has
   unrelated @media (max-width:) rules from before this branch). */
function sliceDockCss() {
  const start = composites.indexOf('.fs-ask-chat--dock');
  assert.ok(start >= 0, '.fs-ask-chat--dock rule not found');
  const end = composites.indexOf('/* Visually hidden, still read by screen readers. */', start);
  assert.ok(end > start, 'end marker after the dock CSS block not found');
  return composites.slice(start, end);
}

test('S6 the overlay is absolutely positioned against a relatively positioned dock', () => {
  const slice = sliceDockCss();
  const dockBlock = slice.match(/\.fs-ask-chat--dock\s*\{([^}]*)\}/);
  assert.ok(dockBlock, '.fs-ask-chat--dock rule not found');
  assert.match(dockBlock[1], /position:\s*relative/);

  const overlayBlock = slice.match(/\.fs-ask-chat--dock \.fs-ask-chat__overlay\s*\{([^}]*)\}/);
  assert.ok(overlayBlock, '.fs-ask-chat--dock .fs-ask-chat__overlay rule not found');
  assert.match(overlayBlock[1], /position:\s*absolute/);
  assert.match(overlayBlock[1], /bottom:\s*100%/);
});

test('S7 the dock CSS has no phone-width media query', () => {
  const slice = sliceDockCss();
  assert.doesNotMatch(slice, /@media \(max-width:/,
    'phone layouts are out of scope for the dock (spec 2026-09-16 §2)');
});

/* S6 only proves the no-reflow rule holds INSIDE the region sliceDockCss()
   cuts out. A later rule elsewhere in composites.css -- outside that slice,
   so invisible to S6 -- could still target the same two selectors with
   equal or higher specificity and override `position`, defeating the seam
   without S6 ever failing. This walks the WHOLE file (not the slice) and
   counts, for every rule, the rightmost simple selector of each
   comma-separated selector -- i.e. what class the rule is actually keyed
   on, independent of ancestor combinators -- so a second rule anywhere,
   in any selector shape, that targets `.fs-ask-chat--dock` or
   `.fs-ask-chat__overlay` is caught. */
function ruleSelectors(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const raw = m[1].trim();
    if (!raw || raw.charAt(0) === '@') continue; // @media / @keyframes header, not a rule selector
    raw.split(',').forEach(function (sel) { out.push(sel.trim()); });
  }
  return out;
}

test('S8 .fs-ask-chat--dock and .fs-ask-chat__overlay each key exactly one rule in the whole file', () => {
  const rightmost = sel => sel.split(/\s+/).pop();
  const selectors = ruleSelectors(composites);
  const dockCount = selectors.filter(s => rightmost(s) === '.fs-ask-chat--dock').length;
  const overlayCount = selectors.filter(s => rightmost(s) === '.fs-ask-chat__overlay').length;
  assert.strictEqual(dockCount, 1,
    'expected exactly one rule keyed on .fs-ask-chat--dock, found ' + dockCount +
    ' -- a second one can override `position: relative` and break the no-reflow seam');
  assert.strictEqual(overlayCount, 1,
    'expected exactly one rule keyed on .fs-ask-chat__overlay, found ' + overlayCount +
    ' -- a second one can override `position: absolute` and break the no-reflow seam');
});

/* The plan calls the next test "S8", but S8 is already taken above by the Task
   3 fix round (the "defined exactly once" CSS guard), so it ships as S9. */
test('S9 the timeline registers the dock as its Footer and mounts it in dock mode', () => {
  const timeline = read('scripts', 'pages', 'timeline.js');
  assert.match(timeline, /Footer:\s*TimelineAskDock/,
    'the dock is not registered in the page entry, so the Footer slot renders nothing');
  const start = timeline.indexOf('function TimelineAskDock(');
  assert.ok(start > 0, 'function TimelineAskDock( not found');
  const end = timeline.indexOf('\n  function ', start + 1);
  assert.ok(end > start, 'no module-level function follows TimelineAskDock');
  const slice = timeline.slice(start, end);
  assert.match(slice, /React\.createElement\(AskChat\b/, 'the dock mounts no AskChat');
  assert.match(slice, /variant:\s*'dock'/, 'the dock mounts AskChat in its panel variant');
});
