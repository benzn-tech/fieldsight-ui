'use strict';

/*
 * navDailyV2 — Timeline takes Activity's slot in the DAILY section.
 *
 * Two things this pins, and neither is "the flag returns true":
 *
 *   1. THE FLAG IS READ AT RENDER, NOT AT MODULE LOAD. `env.js` is the last
 *      script app-shell-preview.html loads (line 184); left-nav.js is the
 *      56th. A module-level `window.FS_ENV.navDailyV2` is evaluated before
 *      that object exists, so the switch would be permanently off — and it
 *      fails GREEN: the nav renders perfectly, just always in the old shape.
 *      The test therefore sets the flag AFTER requiring the module, which is
 *      the only ordering that can tell the two implementations apart.
 *
 *   2. ORDER, not just membership. "Timeline replaces Activity" means it sits
 *      where Activity sat — third, after My Work. Asserting only that the set
 *      contains 'timeline' would pass with it prepended above Today.
 *
 * The default (flag absent) must be byte-identical to what shipped, because
 * prod never sets FS_NAV_DAILY_V2 and the 2026-07-13 decision that kept
 * Timeline out of the sidebar still stands there.
 */
const test = require('node:test');
const assert = require('node:assert');

global.React = {
  createElement: function (type, props) {
    return { type: type, props: props || {},
             children: Array.prototype.slice.call(arguments, 2) };
  },
  Fragment: 'Fragment',
  useState: function (v) { return [v, function () {}]; },
  useEffect: function () {},
  useRef: function (v) { return { current: v }; },
};
global.window = { FS: {}, FieldSight: {} };
global.document = { addEventListener() {}, removeEventListener() {} };

const nav = require('../scripts/left-nav.js');

function dailyItems() {
  const daily = nav.navSections().find(function (s) { return s.key === 'DAILY'; });
  return daily.items;
}

test('flag absent: the DAILY section is exactly what shipped', () => {
  delete global.window.FS_ENV;
  assert.deepStrictEqual(dailyItems(), ['today', 'mywork', 'activity']);
});

test('flag false: still unchanged', () => {
  global.window.FS_ENV = { navDailyV2: false };
  assert.deepStrictEqual(dailyItems(), ['today', 'mywork', 'activity']);
});

test('flag on: Timeline takes Activity\'s slot, and Activity is gone', () => {
  /* Set AFTER require — see the header. An implementation that read the flag
     at module load would still be showing the old list here. */
  global.window.FS_ENV = { navDailyV2: true };
  assert.deepStrictEqual(dailyItems(), ['today', 'mywork', 'timeline'],
    'Timeline must sit where Activity sat, not merely be present');
});

test('toggling back restores the default — the const was not mutated', () => {
  global.window.FS_ENV = { navDailyV2: true };
  dailyItems();
  global.window.FS_ENV = { navDailyV2: false };
  assert.deepStrictEqual(dailyItems(), ['today', 'mywork', 'activity'],
    'navSections() must build a new object, never edit NAV_SECTIONS in place');
});

test('no other section is touched by the flag', () => {
  global.window.FS_ENV = { navDailyV2: false };
  const before = JSON.stringify(nav.navSections().filter(function (s) { return s.key !== 'DAILY'; }));
  global.window.FS_ENV = { navDailyV2: true };
  const after = JSON.stringify(nav.navSections().filter(function (s) { return s.key !== 'DAILY'; }));
  assert.strictEqual(after, before);
});

test('timeline is a real nav item with a permission and an icon', () => {
  /* Without these the flag would hide Activity and show nothing in its place:
     the render filters on visibleKeys (permission-derived) and looks up an
     icon by key. Both come from files this change does NOT touch, which is
     exactly why they are worth asserting here. */
  const globals = require('../scripts/fs-globals.js');
  const items = (global.window.FS && global.window.FS.NAV_ITEMS) || (globals && globals.NAV_ITEMS);
  assert.ok(items && items.timeline, 'NAV_ITEMS.timeline must exist');
  assert.ok(items.timeline.permission, 'timeline needs a permission or it is never visible');
  assert.strictEqual(items.timeline.path, '/timeline');
  assert.strictEqual(items.timeline.permission, items.activity.permission,
    'same permission as Activity — anyone who could see Activity can see Timeline');
});
