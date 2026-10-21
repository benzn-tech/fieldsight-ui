'use strict';
/*
 * SOURCE SCAN, not a behaviour test. Pins the tablet layout (768–1023px,
 * iPad portrait): list fills the width, the detail pane is a right-hand
 * drawer that opens on selection. Before this, 820px got three panes with a
 * 196px detail column. Behaviour was verified in browser frames at 768 / 820
 * / 1023 (drawer) and 1024 / 1440 (three panes unchanged).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'app-shell.css'), 'utf8').replace(/\r\n/g, '\n');

/* Body of the first @media block whose query matches `query` exactly. */
function mediaBody(query) {
  const start = css.indexOf('@media ' + query + ' {');
  assert.ok(start >= 0, '@media ' + query + ' not found');
  let i = css.indexOf('{', start) + 1, depth = 1;
  const from = i;
  for (; i < css.length && depth; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
  }
  return css.slice(from, i - 1);
}
function rule(body, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&').replace(/\s+/g, '\\s+');
  const m = body.match(new RegExp('(^|[\\n}])\\s*' + esc + '\\s*\\{([^}]*)\\}'));
  assert.ok(m, selector + ' rule not found');
  return m[2];
}

const TABLET = '(min-width: 48rem) and (max-width: 63.9375rem)';

test('tablet: list takes the width the inline middleWidth would fix at 560', () => {
  const b = rule(mediaBody(TABLET), '.middle-column');
  assert.match(b, /width:\s*auto\s*!important/);
  assert.match(b, /max-width:\s*none\s*!important/);
  assert.match(b, /flex:\s*1/);
});

test('tablet: detail pane is a fixed right drawer, hidden until selection', () => {
  const body = mediaBody(TABLET);
  const base = rule(body, '.app-shell:not(.app-shell--full-width) .right-detail');
  assert.match(base, /position:\s*fixed/);
  assert.match(base, /transform:\s*translateX\(100%\)/);
  assert.match(base, /visibility:\s*hidden/);
  const open = rule(body, '.app-shell.has-selection .right-detail');
  assert.match(open, /transform:\s*none/);
  assert.match(open, /visibility:\s*visible/);
});

test('tablet: the Back button closes the drawer', () => {
  // Scoped selector: the unscoped base rule comes later in the file and wins a tie.
  assert.match(rule(mediaBody(TABLET), '.right-detail .fs-mobile-back'), /display:\s*flex/);
});

test('768px is tablet, not the half-phone fallback', () => {
  // `max-width: 48rem` includes 768 itself, which stacked the left nav into a
  // 56px row while the bottom nav (≤767) stayed hidden.
  assert.ok(!css.includes('@media (max-width: 48rem)'), 'fallback block still includes 768px');
});

test('shell height follows the visible viewport on iOS', () => {
  const b = rule(css, '.app-shell');
  assert.match(b, /height:\s*100vh;\s*\n\s*height:\s*100dvh;/);
});
