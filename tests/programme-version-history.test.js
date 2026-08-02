'use strict';

/*
 * Programme version history — the rollback safety net.
 *
 * Every import writes a version row, so a Replace that turned out to be wrong
 * can be undone. The drawer's job is to make each row legible enough that
 * someone can tell which version they want back, months later, without
 * remembering what they did that day.
 *
 * The summary lines are rendered with the SAME describeDiff used at import
 * time, so the history reads identically to the moment the decision was made.
 * If those two ever diverge, a PM comparing them concludes the record is
 * wrong.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  describeVersion, canRestore, restoreWarning,
} = require('../scripts/composites/programme-version-history.js');

const V = {
  version_no: 4,
  mode: 'update',
  filename: 'rev-c.xml',
  imported_at: '2026-07-14T02:31:00Z',
  diff_summary: { updated: 12, added: 3, removed: 1, date_shifted: 8,
                  max_shift_days: 14, archived_with_parent: 0,
                  locally_modified_overwritten: [] },
};

/* ---- describeVersion ----------------------------------------------------- */

test('a version summarises with the same wording the import used', () => {
  const lines = describeVersion(V).join(' | ');
  assert.match(lines, /12 tasks updated/);
  assert.match(lines, /3 tasks added/);
});

test('a replace version says what it replaced, not what it updated', () => {
  const lines = describeVersion(
    { version_no: 5, mode: 'replace', diff_summary: { mode: 'replace', tasks: 320 } },
  ).join(' | ');
  assert.match(lines, /320/);
  assert.doesNotMatch(lines, /updated/);
});

test('a restore version says where it came from', () => {
  /* Otherwise a rollback appears in the history as an unexplained version. */
  const lines = describeVersion(
    { version_no: 6, mode: 'replace', diff_summary: { restored_from: 3 } },
  ).join(' | ');
  assert.match(lines, /restored from version 3/i);
});

test('the first import is labelled as such rather than as a change', () => {
  const lines = describeVersion(
    { version_no: 1, mode: 'initial', diff_summary: {} },
  ).join(' | ');
  assert.match(lines, /first import/i);
});

test('a version with no summary still renders something', () => {
  assert.ok(describeVersion({ version_no: 2, mode: 'update' }).length);
});

/* ---- canRestore ---------------------------------------------------------- */

test('an older version can be restored', () => {
  assert.strictEqual(canRestore({ version_no: 3 }, { current: 5, role: 'pm' }), true);
});

test('the current version cannot be restored', () => {
  /* It is already the state of the programme; offering it invites a
     destructive-looking action that does nothing. */
  assert.strictEqual(canRestore({ version_no: 5 }, { current: 5, role: 'pm' }), false);
});

test('restoring requires a manager role', () => {
  assert.strictEqual(canRestore({ version_no: 3 }, { current: 5, role: 'site_manager' }), false);
  assert.strictEqual(canRestore({ version_no: 3 }, { current: 5, role: 'worker' }), false);
  ['pm', 'gm', 'admin'].forEach(function (r) {
    assert.strictEqual(canRestore({ version_no: 3 }, { current: 5, role: r }), true);
  });
});

/* ---- restoreWarning ------------------------------------------------------ */

test('the warning names the version and says the rollback is itself reversible', () => {
  const w = restoreWarning({ version_no: 3 }, { current: 5 });
  assert.match(w, /version 3/);
  assert.match(w, /reversible|rolled back|undone/i);
});

test('the warning says how many versions are being stepped back', () => {
  assert.match(restoreWarning({ version_no: 3 }, { current: 5 }), /2 imports/);
  assert.match(restoreWarning({ version_no: 4 }, { current: 5 }), /1 import\b/);
});

test('the warning does not claim data will be deleted', () => {
  /* Nothing is deleted — a restore flips removed_in_version. Saying otherwise
     would stop people using the safety net that exists for them. */
  const w = restoreWarning({ version_no: 3 }, { current: 5 });
  assert.doesNotMatch(w, /delete/i);
});
