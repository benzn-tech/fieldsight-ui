'use strict';
/*
 * SOURCE SCAN, not a behaviour test. app-shell.js cannot be required under
 * Node, so this pins the two rules whose absence broke the phone layout
 * (reported on iPhone Safari 2026-10-09). The behaviour itself was verified
 * in a 390px browser frame: elementFromPoint at the bottom edge hit the
 * closed More sheet, and the detail pane took the lower half of the screen.
 *
 * 1. The closed More sheet sits one z-index above the bottom nav and slides
 *    DOWN onto it, so unless it is hidden when closed it covers the nav and
 *    leaves only a 56px strip of itself to scroll.
 * 2. An inline `display` on .right-detail beats the mobile
 *    `.app-shell:not(.has-selection) .right-detail { display: none }` rule,
 *    so the empty detail pane stays on screen beside the list.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const js  = read('scripts', 'app-shell.js');
const css = read('styles', 'app-shell.css');

function block(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const m = css.match(new RegExp('(^|\\n)' + esc + '\\s*\\{([^}]*)\\}'));
  assert.ok(m, selector + ' block not found');
  return m[2];
}

test('closed More sheet is hidden, open sheet is visible', () => {
  assert.match(block('.fs-bottom-nav__more-sheet'), /visibility:\s*hidden/);
  assert.match(block('.fs-bottom-nav__more-sheet--open'), /visibility:\s*visible/);
});

test('closed More sheet hides only after its slide-out finishes', () => {
  // Without delaying the visibility change the sheet vanishes mid-animation.
  assert.match(block('.fs-bottom-nav__more-sheet'), /transition:[^;]*visibility[^;]*\d+ms\s+\d+ms/);
});

test('no inline display on any right-detail element', () => {
  const re = /className:\s*'right-detail[^']*'[\s\S]{0,400}?style:\s*\{([^}]*)\}|style:\s*\{([^}]*)\},\s*className:\s*'right-detail/g;
  let m, seen = 0;
  while ((m = re.exec(js))) {
    seen++;
    const style = m[1] || m[2];
    assert.doesNotMatch(style, /\bdisplay\s*:/, 'inline display overrides the mobile pane swap: ' + style.trim());
  }
  assert.ok(seen >= 2, 'expected both right-detail render paths, saw ' + seen);
});

test('page variant of right-detail stretches its content via CSS', () => {
  assert.match(js, /className:\s*'right-detail right-detail--page'/);
  const b = block('.right-detail--page');
  assert.match(b, /align-items:\s*stretch/);
  assert.match(b, /justify-content:\s*flex-start/);
});
