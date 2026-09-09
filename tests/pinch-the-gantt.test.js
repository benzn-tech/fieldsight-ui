'use strict';

/*
 * Ctrl+wheel zoom on the Gantt.
 *
 * Before this, zoom was three buttons mapping to three fixed scales —
 * 24 / 6 / 2 px per day. The step from day to week is 4x, so there was no way
 * to read the chart at anything in between, which is what the request was
 * about ("方便阅读").
 *
 * Three things had to be got right, and each has a specific failure:
 *
 *   1. LABEL DENSITY follows the scale, not the button. `gantt-strip` picked
 *      markers from `tier` alone, which was safe only while the scale could be
 *      one of three numbers. At 2 px/day the day tier draws a label every two
 *      pixels; at 64 px/day the month tier draws one every ~1900.
 *
 *   2. THE ANCHOR. If the day under the pointer moves, the reader loses their
 *      place on every notch and the feature is worse than the buttons.
 *
 *   3. THE THREE PRESETS MUST NOT MOVE. People have been reading them for
 *      months; a new capability is not licence to redefine them.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { labelTierFor } = require('../scripts/composites/gantt-strip.js');

/* programme.js is a browser IIFE with no export. Lift the pure helpers out and
   run the real definitions rather than restating them here. */
const PROGRAMME = fs
  .readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'programme.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function loadHelpers() {
  const names = ['clampPpd', 'anchorDay', 'scrollLeftForAnchor'];
  const src = names.map(function (n) {
    const m = PROGRAMME.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n  \\}'));
    assert.ok(m, n + ' has moved or been renamed');
    return m[0];
  });
  const tiers = PROGRAMME.match(/var TIER_PIXELS = \{[^}]*\};/);
  const bounds = PROGRAMME.match(/var PPD_MIN = \d+;\n  var PPD_MAX = \d+;/);
  assert.ok(tiers && bounds, 'TIER_PIXELS / PPD bounds have moved');
  // eslint-disable-next-line no-new-func
  return new Function(tiers[0] + '\n  ' + bounds[0] + '\n' + src.join('\n')
    + '\nreturn { clampPpd, anchorDay, scrollLeftForAnchor, TIER_PIXELS };')();
}

const { clampPpd, anchorDay, scrollLeftForAnchor, TIER_PIXELS } = loadHelpers();

/* ---------- the three presets are unchanged ---------------------------- */

test('the three named scales still pick the markers they always picked', () => {
  assert.strictEqual(labelTierFor(TIER_PIXELS.day), 'day');
  assert.strictEqual(labelTierFor(TIER_PIXELS.week), 'week');
  assert.strictEqual(labelTierFor(TIER_PIXELS.month), 'month');
});

test('a preset scale is inside the clamp, so pressing a button changes nothing', () => {
  ['day', 'week', 'month'].forEach(function (t) {
    assert.strictEqual(clampPpd(TIER_PIXELS[t]), TIER_PIXELS[t],
      t + ' must survive the clamp untouched, or the buttons would move');
  });
});

/* ---------- label density follows the scale ---------------------------- */

test('zoomed right out, day labels give way rather than overlapping', () => {
  /* One label every 3px is a smear, whatever button was pressed. */
  assert.notStrictEqual(labelTierFor(3, 'day'), 'day');
});

test('zoomed right in, month labels give way to something readable', () => {
  assert.strictEqual(labelTierFor(64, 'month'), 'day',
    'at 64px per day a month label appears once every ~1900px; the strip '
    + 'stops being a scale and becomes decoration');
});

test('the tiers hand over in the right order as the scale falls', () => {
  const seen = [40, 24, 20, 19, 10, 6, 5, 2].map(function (p) { return labelTierFor(p); });
  assert.deepStrictEqual(seen,
    ['day', 'day', 'day', 'week', 'week', 'week', 'month', 'month'],
    'density must decrease monotonically — a scale that skips back to a '
    + 'denser tier as you zoom out would flicker');
});

test('with no usable scale the caller’s tier is honoured', () => {
  /* The back-compatible path: any caller rendering the strip without a scale. */
  ['day', 'week', 'month'].forEach(function (t) {
    assert.strictEqual(labelTierFor(undefined, t), t);
    assert.strictEqual(labelTierFor(0, t), t);
    assert.strictEqual(labelTierFor(NaN, t), t);
  });
  assert.strictEqual(labelTierFor(undefined), 'day', 'and defaults as before');
});

/* ---------- the clamp -------------------------------------------------- */

test('the scale cannot be zoomed into uselessness in either direction', () => {
  assert.strictEqual(clampPpd(0.001), 2);
  assert.strictEqual(clampPpd(1000), 64);
});

test('a broken scale falls back to the day tier rather than to zero', () => {
  /* ppd of 0 divides by zero in the anchor maths and renders a chart of no
     width; it must never be reachable. */
  [0, -5, NaN, Infinity, null, undefined, 'abc'].forEach(function (bad) {
    assert.strictEqual(clampPpd(bad), TIER_PIXELS.day, String(bad));
  });
});

/* ---------- the anchor ------------------------------------------------- */

function dayUnderPointerAfterZoom(scrollLeft, offsetX, oldPpd, newPpd) {
  const day = anchorDay(scrollLeft, offsetX, oldPpd);
  const nextScroll = scrollLeftForAnchor(day, offsetX, newPpd);
  return anchorDay(nextScroll, offsetX, newPpd);
}

test('the day under the pointer is still under the pointer after zooming in', () => {
  const before = anchorDay(1200, 300, 6);
  const after = dayUnderPointerAfterZoom(1200, 300, 6, 24);
  assert.ok(Math.abs(after - before) < 1e-9,
    'zoom that slides the viewport makes the reader re-find their place on '
    + 'every notch — expected day ' + before + ', got ' + after);
});

test('and after zooming out', () => {
  const before = anchorDay(4800, 500, 24);
  const after = dayUnderPointerAfterZoom(4800, 500, 24, 6);
  assert.ok(Math.abs(after - before) < 1e-9);
});

test('anchoring at the very left edge does not scroll into negative space', () => {
  const scroll = scrollLeftForAnchor(anchorDay(0, 0, 24), 0, 6);
  assert.strictEqual(scroll, 0,
    'day 0 at offset 0 must stay pinned to the start at any scale');
});

test('the pointer offset is what keeps the anchor honest', () => {
  /* Same scroll position, two different pointer positions, two different
     anchored days — if offsetX were dropped these would collapse into one and
     the chart would recentre instead of holding still. */
  assert.notStrictEqual(anchorDay(1200, 100, 24), anchorDay(1200, 700, 24));
});

/* ---------- the wiring that cannot be driven here ---------------------- */

test('the wheel listener is non-passive, or ctrl+wheel is page zoom and nothing else', () => {
  assert.match(PROGRAMME, /addEventListener\('wheel',\s*onWheel,\s*\{\s*passive:\s*false\s*\}\)/,
    'a passive listener cannot preventDefault(), so the browser keeps the '
    + 'gesture and the chart never zooms at all');
  assert.match(PROGRAMME, /e\.preventDefault\(\);/);
  assert.match(PROGRAMME, /el\.removeEventListener\('wheel', onWheel\)/,
    'the listener must be torn down, or every re-render stacks another');
});

test('the scroll position is restored after the commit, not during the event', () => {
  assert.match(PROGRAMME, /useLayoutEffect\(function \(\) \{[\s\S]{0,400}scrollLeftForAnchor/,
    'assigning scrollLeft inside the wheel handler is clamped to the OLD '
    + 'scrollWidth, because the new width only reaches the DOM on commit');
});

test('the pointer offset comes from the timeline, not from whatever bar is under the cursor', () => {
  assert.match(PROGRAMME, /e\.clientX - rect\.left/);
  assert.doesNotMatch(PROGRAMME, /anchorRef[\s\S]{0,200}e\.offsetX/,
    'e.offsetX is relative to the event target — over a task bar it is the '
    + 'offset within that bar, and the anchor jumps by the bar’s width');
});

/* THIS ONE EXISTS BECAUSE THE FIRST ATTEMPT SHIPPED GREEN AND DEAD.
   The timeline node was held in a React.useRef and the wheel effect was keyed
   on [ppd, tier]. Assigning a ref does not re-render, and the timeline is not
   in the tree on the first commit (the programme is still loading), so the
   effect read null, returned early, and never ran again — none of its deps
   ever changed. Every test above passed. Dispatching a real wheel event at the
   real element in a browser is what found it: `preventDefault` never fired and
   the width never moved.

   A callback ref into state re-renders when the node appears, which is what
   makes the effect run at all. */
test('the timeline node is tracked in state, so the effect runs when it appears', () => {
  assert.match(PROGRAMME, /var refTimelineEl = React\.useState\(null\);/,
    'a React.useRef here does not re-render, so an effect keyed on the scale '
    + 'never re-runs once the timeline finally mounts');
  assert.match(PROGRAMME, /ref: setTimelineEl/,
    'the callback ref is what puts the node into state');
  assert.match(PROGRAMME, /\}, \[timelineEl, ppd, ctx\.tier, ctx\.setZoom\]\);/,
    'the node must be a dependency, or the listener attaches to whatever was '
    + 'there on the first commit — which is nothing');
});

test('changing tier resets the zoom, and does so where Overview also passes', () => {
  assert.match(PROGRAMME, /var setTier = React\.useCallback\(function \(next\) \{\s*\n\s*setZoom\(1\);/,
    'the reset must live in setTier itself — the Overview switch calls '
    + 'setTier directly, and a reset wired only into the toggle buttons '
    + 'would leave Overview rendering at the last pinched scale');
});
