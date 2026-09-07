'use strict';

/*
 * PhotoGrid's opt-in selection.
 *
 * PhotoGrid is rendered by evidence.js, timeline.js, safety.js and quality.js.
 * Only Evidence wants checkboxes, so selection has to be inert when nobody
 * asks for it — otherwise a control appears on three pages that never
 * requested one.
 *
 * The plan specified this as a source-scan ("does the file contain
 * props.selectable"). It is written as a driven test instead: a scan asserts
 * the ABSENCE OF A SPELLING, not the absence of a behaviour, so an
 * implementation that gates the checkbox some other way would pass it while
 * being wrong — and one that gates nothing but happens to mention the prop
 * would pass it too. `selectionFor` is exported so the decision itself can be
 * driven, matching how isKeyframe is already tested in
 * tests/q7-keyframe-detect.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
global.React = global.React || {};

const { selectionFor } = require('../scripts/composites/photo-grid.js');

test('no selection props means no checkbox at all', () => {
  // The case timeline.js, safety.js and quality.js are in.
  assert.strictEqual(selectionFor({}, 'a.jpg'), null);
  assert.strictEqual(selectionFor({ selectable: false }, 'a.jpg'), null);
});

test('selectable alone is enough to offer the control', () => {
  // A caller that turns selection on but has selected nothing yet must still
  // get checkboxes, or the feature cannot be started.
  const s = selectionFor({ selectable: true }, 'a.jpg');
  assert.ok(s);
  assert.strictEqual(s.checked, false);
});

test('checked reflects the caller\'s set, keyed by filename', () => {
  const props = { selectable: true, selectedFilenames: { 'b.jpg': true } };
  assert.strictEqual(selectionFor(props, 'b.jpg').checked, true);
  assert.strictEqual(selectionFor(props, 'a.jpg').checked, false);
});

test('the toggle reports the filename, never a position', () => {
  // Index would break the moment the grid is re-grouped — which is exactly
  // what grouping by topic does to it. Two grids, same photo, different
  // position: both must report the same identity.
  const seen = [];
  const props = { selectable: true, onToggleFilename: (f) => seen.push(f) };
  selectionFor(props, 'x.jpg').onToggle();
  selectionFor(props, 'y.jpg').onToggle();
  assert.deepStrictEqual(seen, ['x.jpg', 'y.jpg']);
});

test('a missing onToggleFilename does not throw when clicked', () => {
  // selectable without a handler is a caller bug, but it must not take the
  // page down with it.
  const s = selectionFor({ selectable: true }, 'a.jpg');
  assert.doesNotThrow(() => s.onToggle());
});

test('a selected-set that is not an object is treated as empty', () => {
  assert.strictEqual(selectionFor({ selectable: true, selectedFilenames: null },
                                  'a.jpg').checked, false);
});
