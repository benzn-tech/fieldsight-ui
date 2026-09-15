'use strict';

/*
 * A day with exactly one meeting could never produce a meeting report.
 *
 * Reproduced on dev on 2026-09-14, Ben_UCPK2, Mon 7 Sep: one recording, one
 * session, and a disabled "Generate report" whose tooltip says "pick one above".
 * There was nothing above to pick.
 *
 * Two rules met and cancelled out:
 *
 *   shouldShowSessionPicker  -- renders only for >=2 sessions. Correct for the
 *                               picker: with one session there is nothing to
 *                               narrow, and it is pinned in session-picker.test.js.
 *   GenerateReportButton     -- enabled only for a SELECTED session, and the only
 *                               way to select one is the picker.
 *
 * So one-meeting days -- the common case for a single recorder -- had a report
 * button that could not be enabled by anything the user could do.
 *
 * The picker rule is not changed. What the report button is given is:
 * reportableSession() answers "which meeting would a report be about?", which is
 * the selected one, or -- when nothing is selected and the day holds exactly one
 * -- that one. The email draft keeps the selection as it was, because "All day"
 * is a real and different scope for a draft.
 *
 * And the disabled tooltip stops asking the user to pick from a picker that is
 * not there: a day with no meeting at all is told so.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
global.React = global.React || {};

const { reportableSession, generateReportUnavailableReason, shouldShowSessionPicker } =
  require('../scripts/pages/timeline.js');

const ONE = [{ session_id: 'sid105a8f27806d42b78abe6e193368196b', title: 'Recording Sync Failure Troubleshooting' }];
const THREE = [
  { session_id: 'sidAAA', title: 'Morning' },
  { session_id: 'sidBBB', title: 'Midday' },
  { session_id: 'sidCCC', title: 'Afternoon' },
];

test('THE test: a day with one meeting reports on that meeting without a picker', () => {
  assert.strictEqual(shouldShowSessionPicker(ONE), false, 'the picker rule is unchanged');
  assert.strictEqual(reportableSession(ONE, null), ONE[0],
    'nothing can be selected on this day, so the one meeting must be the subject');
});

test('a selected meeting is always the subject', () => {
  assert.strictEqual(reportableSession(THREE, 'sidBBB'), THREE[1]);
  assert.strictEqual(reportableSession(ONE, ONE[0].session_id), ONE[0]);
});

test('several meetings and none selected: no subject, the picker is there to choose', () => {
  assert.strictEqual(shouldShowSessionPicker(THREE), true);
  assert.strictEqual(reportableSession(THREE, null), null);
  assert.strictEqual(reportableSession(THREE, undefined), null);
});

test('a selection that no longer exists is not silently replaced', () => {
  // A stale id (the day changed under the selection) must not fall back to the
  // one-meeting rule and report on a different meeting than the user picked.
  assert.strictEqual(reportableSession(ONE, 'sidGONE'), null);
});

test('no meetings at all: no subject', () => {
  assert.strictEqual(reportableSession([], null), null);
  assert.strictEqual(reportableSession(null, null), null);
  assert.strictEqual(reportableSession(undefined, null), null);
});

test('the disabled tooltip does not point at a picker that is not rendered', () => {
  const none = generateReportUnavailableReason(0);
  assert.ok(!/pick one above/i.test(none), none);
  assert.ok(/no meeting/i.test(none), none);
});

test('with several meetings the tooltip still says to pick one', () => {
  assert.ok(/pick one above/i.test(generateReportUnavailableReason(3)));
});
