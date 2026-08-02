'use strict';

/*
 * The import diff screen's decision logic.
 *
 * Re-importing a revised programme is the moment work gets destroyed, so the
 * screen's whole job is to make the two modes cost different things out loud.
 * Update lists what changes. Replace lists what it *destroys* — and
 * deliberately omits the update counts, which would soften a warning that
 * should not be softened.
 *
 * The guard against clicking through Replace is not a confirm dialog — those
 * get clicked through — it is requiring the site name to be typed while the
 * losses are on screen.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  describeDiff, canCommit, commitPayload,
} = require('../scripts/composites/programme-import-diff.js');

const PREVIEW = {
  suggested_mode: 'update',
  update_preview: {
    added: 3, removed: 1, updated: 12, date_shifted: 8, max_shift_days: 14,
    archived_with_parent: 0, locally_modified_overwritten: [],
  },
  replace_preview: {
    local_tasks_discarded: 47, allocations_discarded: 12,
    tasks_with_progress_discarded: 203,
  },
  rename_candidates: [],
};

/* ---- describeDiff -------------------------------------------------------- */

test('update mode describes what changes', () => {
  const s = describeDiff('update', PREVIEW).join(' | ');
  assert.match(s, /12 tasks updated/);
  assert.match(s, /3 tasks added/);
  assert.match(s, /1 task no longer/);
  assert.match(s, /14 days/);
});

test('update says removals are hidden, not deleted', () => {
  /* The distinction matters: a PM who thinks a month of progress was deleted
     will not run the import at all. */
  assert.match(describeDiff('update', PREVIEW).join(' | '), /hidden, not deleted/);
});

test('replace mode describes what it destroys, not what changes', () => {
  const s = describeDiff('replace', PREVIEW).join(' | ');
  assert.match(s, /47/);
  assert.match(s, /12/);
  assert.match(s, /203/);
  assert.doesNotMatch(s, /updated/,
    'the update counts are irrelevant here and would soften the warning');
});

test('replace still says the previous version can be rolled back', () => {
  /* True, and it is the difference between a scary-but-recoverable action and
     one people avoid entirely. */
  assert.match(describeDiff('replace', PREVIEW).join(' | '), /rolled back/i);
});

test('a new-programme import says it changes nothing existing', () => {
  const s = describeDiff('new', PREVIEW).join(' | ');
  assert.match(s, /Nothing existing is changed/);
});

test('locally edited rows are called out so the PM sees the overwrite coming', () => {
  const p = JSON.parse(JSON.stringify(PREVIEW));
  p.update_preview.locally_modified_overwritten = [
    { id: 'a', name: 'Pour slab' }, { id: 'b', name: 'Strip forms' },
  ];
  assert.match(describeDiff('update', p).join(' | '),
    /2 tasks you edited here.*overwritten/i);
});

test('local subtasks archived with a departing parent are called out', () => {
  /* Otherwise they simply vanish and the site manager who built them has no
     idea why. */
  const p = JSON.parse(JSON.stringify(PREVIEW));
  p.update_preview.archived_with_parent = 5;
  assert.match(describeDiff('update', p).join(' | '), /5 local subtasks archived/i);
});

test('a no-op line is omitted rather than shown as zero', () => {
  const p = JSON.parse(JSON.stringify(PREVIEW));
  p.update_preview.date_shifted = 0;
  p.update_preview.archived_with_parent = 0;
  const s = describeDiff('update', p).join(' | ');
  assert.doesNotMatch(s, /0 tasks moved/);
  assert.doesNotMatch(s, /0 local subtasks/);
});

test('singulars are not written as "1 tasks"', () => {
  const p = JSON.parse(JSON.stringify(PREVIEW));
  p.update_preview.added = 1;
  const s = describeDiff('update', p).join(' | ');
  assert.match(s, /1 task added/);
  assert.doesNotMatch(s, /1 tasks added/);
});

test('describeDiff survives a preview with missing sections', () => {
  assert.ok(describeDiff('update', {}).length);
  assert.ok(describeDiff('replace', {}).length);
});

/* ---- canCommit ----------------------------------------------------------- */

test('update commits without a typed confirmation', () => {
  assert.strictEqual(canCommit('update', { typed: '', siteName: 'UC Physics' }), true);
});

test('replace stays blocked until the site name matches exactly', () => {
  assert.strictEqual(canCommit('replace', { typed: '', siteName: 'UC Physics' }), false);
  assert.strictEqual(canCommit('replace', { typed: 'uc physics', siteName: 'UC Physics' }), false);
  assert.strictEqual(canCommit('replace', { typed: ' UC Physics', siteName: 'UC Physics' }), false);
  assert.strictEqual(canCommit('replace', { typed: 'UC Physics', siteName: 'UC Physics' }), true);
});

test('replace cannot be unlocked by an empty site name', () => {
  /* A site with no name would otherwise make the empty input match. */
  assert.strictEqual(canCommit('replace', { typed: '', siteName: '' }), false);
});

test('a new-programme import needs no confirmation because it destroys nothing', () => {
  assert.strictEqual(canCommit('new', { typed: '', siteName: 'UC Physics' }), true);
});

/* ---- commitPayload ------------------------------------------------------- */

test('the commit payload carries the mode and the parsed file', () => {
  const p = commitPayload('update', { parents: [1], leaves: [2, 3] }, {});
  assert.strictEqual(p.mode, 'update');
  assert.deepStrictEqual(p.leaves, [2, 3]);
  assert.ok(!p.dry_run);
});

test('replace carries confirm_replace so the server can refuse a bare call', () => {
  const p = commitPayload('replace', { parents: [], leaves: [] }, {});
  assert.strictEqual(p.confirm_replace, true);
});

test('update does not carry confirm_replace', () => {
  const p = commitPayload('update', { parents: [], leaves: [] }, {});
  assert.ok(!('confirm_replace' in p));
});

test('only accepted renames are sent', () => {
  const cands = [
    { existing_id: 'a', incoming_source_task_id: 'A1R1' },
    { existing_id: 'b', incoming_source_task_id: 'B1R1' },
  ];
  const p = commitPayload('update', { parents: [], leaves: [] },
    { renameCandidates: cands, acceptedRenames: { a: true, b: false } });
  assert.deepStrictEqual(p.accept_renames, [cands[0]]);
});

test('no accepted renames sends no accept_renames key at all', () => {
  /* An empty array would make the server re-reconcile for nothing. */
  const p = commitPayload('update', { parents: [], leaves: [] },
    { renameCandidates: [{ existing_id: 'a', incoming_source_task_id: 'X' }],
      acceptedRenames: {} });
  assert.ok(!('accept_renames' in p));
});
