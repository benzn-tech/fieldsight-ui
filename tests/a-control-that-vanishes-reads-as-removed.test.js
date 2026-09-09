'use strict';

/*
 * Two controls on Timeline disappeared instead of explaining themselves, and
 * both were reported as features that had been deleted.
 *
 *   "Preview & copy"  vanished on any day whose action items are all ticked
 *                     off — which is most days. `DraftEmailButton` returned
 *                     early with the disabled "Draft email" and never reached
 *                     the line that renders the second button, even though the
 *                     comment beneath it says "beside it, not instead of it".
 *
 *   "Generate report" vanished whenever the session picker was on "All day".
 *                     That one is a real scope limit — the route is
 *                     POST /sessions/{id}/report/preview and All day has no id
 *                     — but returning null left the obvious question ("why can
 *                     I not generate a report for the whole day?") with no
 *                     answer anywhere on screen.
 *
 * A disabled control says "not now, and here is why". A missing one is
 * indistinguishable from a build that dropped the feature. Both were read the
 * second way, by the person who asked for them.
 */

const test = require('node:test');
const assert = require('node:assert');

/* ---------- a recording React ----------------------------------------- */

function makeReact() {
  return {
    createElement(type, props, ...children) {
      const flat = [];
      (function push(list) {
        list.forEach(function (c) {
          if (Array.isArray(c)) push(c);
          else if (c !== null && c !== undefined && c !== false) flat.push(c);
        });
      })(children);
      return { type: type, props: props || {}, children: flat };
    },
    useState(v) { return [v, function () {}]; },
    useRef(v) { return { current: v }; },
    useEffect() {}, useLayoutEffect() {}, useContext() { return null; },
    useMemo(fn) { return fn(); }, useCallback(fn) { return fn; },
    Fragment: 'Fragment',
    memo(c) { return c; },
  };
}

/* timeline.js is a browser IIFE; it publishes its internals for tests through
   the same hatch the existing timeline tests use. */
function loadTimeline(opts) {
  opts = opts || {};
  const React = makeReact();
  global.React = React;
  global.window = {
    FieldSight: {
      EmailPreviewModal: opts.previewModal === false ? undefined : function EmailPreviewModal() {},
      SessionReportModal: opts.reportModal === false ? undefined : function SessionReportModal() {},
      Card: Object.assign(function Card() {}, { Body: function CardBody() {} }),
      Badge: function Badge() {}, Avatar: function Avatar() {},
      NavIcon: function NavIcon() {}, PhotoGrid: function PhotoGrid() {},
    },
    FS: {
      api: { folderName: function (n) { return String(n || '').replace(/ /g, '_'); },
             actions: { lookupAction: function () { return null; } } },
      can: function () { return opts.canCreate !== false; },
      P: function (a, b) { return a + ':' + b; },
    },
    AuthMock: { currentUser: { name: 'Ben Lin', role: 'admin' } },
    location: { href: 'https://example.test/#/timeline' },
    addEventListener() {}, removeEventListener() {},
  };
  global.document = { addEventListener() {}, removeEventListener() {},
                      createElement() { return { style: {} }; } };

  delete require.cache[require.resolve('../scripts/pages/timeline.js')];
  require('../scripts/pages/timeline.js');
  const page = global.window.FieldSight.PAGES && global.window.FieldSight.PAGES['/timeline'];
  return { React: React, page: page, exposed: global.window.FieldSight.__timelineTestHooks || null };
}

/* The two components are internal. Rather than reach for them, drive the file
   the way the page does and read the rendered tree — which is also what makes
   these tests notice if the buttons move. */
function collectButtons(node, out) {
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  if (node.props && typeof node.children !== 'undefined') {
    const label = (node.children || [])
      .filter(function (c) { return typeof c === 'string'; }).join('');
    if ((node.type === 'button' || node.type === 'a') && label) {
      out.push({ tag: node.type, label: label,
                 disabled: !!node.props.disabled, title: node.props.title || '' });
    }
  }
  (node.children || []).forEach(function (c) { collectButtons(c, out); });
  return out;
}

/* ---------- what the file exposes ------------------------------------- */

test('timeline.js still registers its page, so this file is testing something', () => {
  const { page } = loadTimeline();
  assert.ok(page && page.Middle,
    'the /timeline page did not register — every assertion below would be '
    + 'vacuous, so this is the self-check that keeps them honest');
});

/* ---------- the shape of the fix, pinned in source --------------------- */

const fs = require('node:fs');
const path = require('node:path');
const SOURCE = fs
  .readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'timeline.js'), 'utf8')
  .replace(/\r\n/g, '\n');

test('the empty draft branch still renders the preview control beside it', () => {
  const branch = SOURCE.match(/if \(!draft\) \{[\s\S]*?\n    \}/);
  assert.ok(branch, 'the empty-draft branch has moved or been renamed');
  assert.match(branch[0], /PreviewEmailButton/,
    '"Preview & copy" must be rendered in the empty branch too — returning '
    + 'only the disabled "Draft email" is what made it look deleted');
  assert.match(branch[0], /emptyReason:/,
    'and it must be told WHY it is disabled, so it can say so');
});

test('the preview control disables itself rather than returning null when empty', () => {
  const fn = SOURCE.match(/function PreviewEmailButton\(props\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, 'PreviewEmailButton has moved or been renamed');
  assert.match(fn[0], /if \(props\.emptyReason\) \{[\s\S]*?disabled:\s*true/,
    'an empty state must render a disabled button carrying the reason');
  /* The one remaining null is the script-not-loaded case, which is correct:
     a button wired to a modal that does not exist would be a broken control,
     not an explained one. */
  const nulls = (fn[0].match(/return null;/g) || []).length;
  assert.strictEqual(nulls, 1,
    'exactly one `return null` should remain — the missing-modal guard');
});

test('All day explains why report generation is per meeting instead of vanishing', () => {
  const fn = SOURCE.match(/function GenerateReportButton\(props\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, 'GenerateReportButton has moved or been renamed');

  assert.doesNotMatch(fn[0], /if \(!props\.session \|\| !Modal \|\| !canCreate\) return null;/,
    'the old guard bundled "no meeting selected" in with "no modal" and "no '
    + 'permission" — three different situations, one silent disappearance');

  assert.match(fn[0], /if \(!props\.session\) \{[\s\S]*?disabled:\s*true/,
    'with no meeting selected the control stays, disabled');
  assert.match(fn[0], /per meeting/i,
    'and says that reports here are per meeting');
  assert.match(fn[0], /Reports page/,
    'and points at where the whole day actually lives — the question was '
    + '"why can I not generate a report for all meetings", and the answer is '
    + 'that the daily report already is one');
});

test('permission and a missing modal still remove the control entirely', () => {
  const fn = SOURCE.match(/function GenerateReportButton\(props\) \{[\s\S]*?\n  \}/);
  assert.match(fn[0], /if \(!Modal \|\| !canCreate\) return null;/,
    'a user without report:create must not be shown a control they cannot '
    + 'use, even disabled — that is a different thing from "not right now"');
});
