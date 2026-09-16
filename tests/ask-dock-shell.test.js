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

test('S2 the Footer is a sibling of the scrolling content, never a child of it', () => {
  const slice = sliceMiddleColumn();
  const contentIdx = slice.indexOf('style: contentStyle');
  assert.ok(contentIdx >= 0, 'contentStyle scroll container not found');
  const fallbackIdx = slice.indexOf('Fallback placeholder');
  assert.ok(fallbackIdx > contentIdx, 'Fallback placeholder not found after contentStyle');
  const footerMarkerIdx = slice.indexOf(
    '/* Footer slot — OUTSIDE the scrolling content (spec 2026-09-16 §3).'
  );
  assert.ok(footerMarkerIdx >= 0, 'Footer slot marker comment not found');
  const footerRefIdx = slice.indexOf('page.Footer', footerMarkerIdx);
  assert.ok(
    footerRefIdx > footerMarkerIdx,
    'page.Footer must appear after the marker comment (source order pin)'
  );
  assert.ok(
    footerRefIdx > fallbackIdx,
    'Footer block must come after the placeholder in the content div (i.e. after the content div, not inside it)'
  );

  /* The content div's own closing sequence — `),` right after the
     Fallback-placeholder IIFE closes the content div's children array and
     the div itself — must appear between contentStyle and the Footer
     block, or the Footer is still nested inside the scroll container. */
  const between = slice.slice(fallbackIdx, footerRefIdx);
  assert.match(between, /\)\s*,/, 'no content-div closing sequence found before the Footer block');

  /* The load-bearing check: INDENTATION. `React.createElement('div', {
     style: contentStyle }, ...)` is itself a direct child of MiddleColumn's
     returned element, indented 4 spaces (same as the header div and the
     DragDivider block). A structurally correct Footer marker sits at that
     SAME 4-space depth. If the Footer block is instead nested as the last
     child of the contentStyle div, its marker comment sits one level
     deeper (6 spaces, matching the Middle IIFE and the placeholder's own
     indentation) even though the marker's TEXT and the loose `),`-anywhere
     check above are unchanged — so indentation is what actually catches
     the seam violation the textual checks above do not. */
  const contentDivIndent = slice.match(/\n( *)React\.createElement\('div', \{ style: contentStyle \}/);
  assert.ok(contentDivIndent, 'content div opening not found');
  const marker = "/* Footer slot — OUTSIDE the scrolling content (spec 2026-09-16 §3).";
  const markerLineStart = slice.lastIndexOf('\n', footerMarkerIdx) + 1;
  const markerIndent = slice.slice(markerLineStart, footerMarkerIdx);
  assert.strictEqual(
    markerIndent, contentDivIndent[1],
    'the Footer marker must sit at the SAME indentation depth as the ' +
    'contentStyle div itself (a true sibling) — got ' +
    JSON.stringify(markerIndent) + ' spaces, expected ' +
    JSON.stringify(contentDivIndent[1]) + '; a deeper indent means the ' +
    'Footer was nested INSIDE the scroll area'
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
