'use strict';

/*
 * Unit tests for fix/mine-team-attribution — the shared Mine/Team
 * predicate (scripts/api/mine-team.js) called by BOTH today-adapter.js
 * (myTasks/teamTasks split) and tasks.js (computeBuckets' `mine` bucket +
 * per-card isMine flag), replacing the old independent `=== currentUserName`
 * checks each page used to hand-roll.
 *
 * Three groups of tests:
 *   1. isMineTask() itself, in isolation (the decided rules verbatim).
 *   2. today-adapter.js's adapt() — proves the SAME predicate drives
 *      myTasks/teamTasks (require the real mine-team.js module, not a
 *      stub, so this is a true integration check, not a re-test of #1).
 *   3. tasks.js's computeBuckets() — same, for the `mine` bucket.
 *   4. Anti-drift — adapt() and computeBuckets() given the SAME
 *      responsible/owner/viewer inputs must agree (Mine iff Mine).
 *
 * mine-team.js is a browser IIFE; require-under-Node pattern mirrors
 * tests/q1-today-adapter-tiers.test.js / tests/date-parse.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = {
  FieldSight: {},
  FS: {
    api: {
      // Mirrors scripts/api/index.js's real folderName() exactly.
      folderName: function (name) { return String(name || '').replace(/\s+/g, '_'); },
      actions: {
        lookupAction: function () { return undefined; }, // no audit overlay in these tests
        /* feat/checkoff-org-api — tasks.js's computeBuckets (Group 3 below)
           now resolves done-ness through the shared union helper. It is a
           pure predicate; mirror the real one rather than pulling the whole
           actions.js module into this file's minimal stub. */
        isActionResolved: function (columnStatus, overlayChecked) {
          return columnStatus === 'done' || !!overlayChecked;
        },
      },
    },
  },
};
global.React = {};
global.document = { addEventListener() {}, removeEventListener() {} };

require('../scripts/api/mine-team.js');
const { isMineTask } = require('../scripts/api/mine-team.js');

/* ---------------------------------------------------------------------
   Group 1 — isMineTask() in isolation
   --------------------------------------------------------------------- */

test('isMineTask: exact match on an assigned name', () => {
  assert.strictEqual(isMineTask('Ben Lin', null, { name: 'Ben Lin' }), true);
});

test('isMineTask: case-insensitive + whitespace-collapsed match still counts as Mine', () => {
  assert.strictEqual(isMineTask('  ben   LIN ', null, { name: 'Ben Lin' }), true);
});

test('isMineTask: "Ben_Lin" (folder-shaped responsible) matches viewer "Ben Lin" via folder equality', () => {
  assert.strictEqual(isMineTask('Ben_Lin', null, { name: 'Ben Lin' }), true);
});

test('isMineTask: "Ben_Lin" viewer folder_name matches responsible "Ben Lin" via folder equality', () => {
  assert.strictEqual(isMineTask('Ben Lin', null, { name: 'Someone Else', folderName: 'Ben_Lin' }), true);
});

test('isMineTask: unassigned (null) + viewer owns the report folder -> Mine', () => {
  assert.strictEqual(isMineTask(null, 'Ben_Lin', { name: 'Ben Lin' }), true);
});

test('isMineTask: unassigned ("") + viewer owns the report folder -> Mine', () => {
  assert.strictEqual(isMineTask('', 'Ben_Lin', { name: 'Ben Lin' }), true);
});

test('isMineTask: unassigned ("—" placeholder) + viewer owns the report folder -> Mine', () => {
  assert.strictEqual(isMineTask('—', 'Ben_Lin', { name: 'Ben Lin' }), true);
});

test('isMineTask: unassigned + a DIFFERENT owner folder -> Team (never dump others\' unassigned items onto Mine)', () => {
  assert.strictEqual(isMineTask(null, 'Someone_Else', { name: 'Ben Lin' }), false);
  assert.strictEqual(isMineTask('—', 'Someone_Else', { name: 'Ben Lin' }), false);
});

test('isMineTask: unassigned + no owner folder at all -> Team (never a bare-truthy fallback)', () => {
  assert.strictEqual(isMineTask(null, null, { name: 'Ben Lin' }), false);
});

test('isMineTask: assigned to someone else entirely -> Team', () => {
  assert.strictEqual(isMineTask('Someone Else', null, { name: 'Ben Lin' }), false);
});

test('isMineTask: "Ben" must NOT match "Ben Lin" (no fuzzy/first-name matching)', () => {
  assert.strictEqual(isMineTask('Ben', null, { name: 'Ben Lin' }), false);
});

test('isMineTask: "Ben" must NOT match "Ben Carter" either (same guard, different site colleague)', () => {
  assert.strictEqual(isMineTask('Ben', null, { name: 'Ben Carter' }), false);
});

test('isMineTask: missing folder_name falls back to deriving the folder from the viewer name', () => {
  // No explicit folderName supplied — must still resolve "Ben_Lin" via
  // window.FS.api.folderName(viewer.name) internally.
  assert.strictEqual(isMineTask('Ben_Lin', null, { name: 'Ben Lin', folderName: undefined }), true);
});

test('isMineTask: real folder_name is PREFERRED over a name that would derive differently', () => {
  // Viewer's display name doesn't match at all, but the real folder_name
  // (as if the account was renamed/migrated) still resolves Mine.
  assert.strictEqual(isMineTask('Old_Folder', null, { name: 'New Display Name', folderName: 'Old_Folder' }), true);
});

/* ---------------------------------------------------------------------
   Group 2 — today-adapter.js integration (myTasks/teamTasks split)
   --------------------------------------------------------------------- */

require('../scripts/api/today-adapter.js');
const adapt = global.window.FS.api.todayAdapter.adapt;

function reportWith(actionItems, userName) {
  return {
    report_date: '2026-07-23',
    site: 'Test Site',
    user_name: userName || 'Ben Lin', // report OWNER
    executive_summary: [],
    safety_observations: [],
    topics: [{ topic_id: 1, topic_title: 'Topic', action_items: actionItems }],
  };
}

test('today-adapter adapt(): exact-match assignee lands in myTasks', () => {
  const out = adapt(reportWith([{ action: 'a', responsible: 'Ben Lin' }]), { currentUserName: 'Ben Lin' });
  assert.strictEqual(out.myTasks.length, 1);
  assert.strictEqual(out.teamTasks.length, 0);
});

test('today-adapter adapt(): unassigned item on the VIEWER\'S OWN report lands in myTasks', () => {
  // report.user_name === viewer -> ownerFolder === viewerFolder.
  const out = adapt(reportWith([{ action: 'a', responsible: null }], 'Ben Lin'), { currentUserName: 'Ben Lin' });
  assert.strictEqual(out.myTasks.length, 1, 'unassigned item on own report is Mine');
  assert.strictEqual(out.teamTasks.length, 0);
});

test('today-adapter adapt(): unassigned item on SOMEONE ELSE\'S report stays in teamTasks', () => {
  const out = adapt(reportWith([{ action: 'a', responsible: null }], 'Someone Else'), { currentUserName: 'Ben Lin' });
  assert.strictEqual(out.myTasks.length, 0, 'unassigned item on another owner\'s report is Team, not dumped onto Mine');
  assert.strictEqual(out.teamTasks.length, 1);
});

test('today-adapter adapt(): assigned-to-someone-else item stays in teamTasks', () => {
  const out = adapt(reportWith([{ action: 'a', responsible: 'Someone Else' }], 'Ben Lin'), { currentUserName: 'Ben Lin' });
  assert.strictEqual(out.myTasks.length, 0);
  assert.strictEqual(out.teamTasks.length, 1);
});

test('today-adapter adapt(): "Ben_Lin" assignee matches viewer "Ben Lin" via folder equality', () => {
  const out = adapt(reportWith([{ action: 'a', responsible: 'Ben_Lin' }], 'Someone Else'), { currentUserName: 'Ben Lin' });
  assert.strictEqual(out.myTasks.length, 1);
  assert.strictEqual(out.teamTasks.length, 0);
});

test('today-adapter adapt(): a real currentUserFolder wins even when currentUserName differs from the assignee text', () => {
  const out = adapt(
    reportWith([{ action: 'a', responsible: 'Ben_Lin' }], 'Someone Else'),
    { currentUserName: 'New Display Name', currentUserFolder: 'Ben_Lin' }
  );
  assert.strictEqual(out.myTasks.length, 1);
});

/* ---------------------------------------------------------------------
   Group 3 — tasks.js integration (computeBuckets' `mine` bucket)
   --------------------------------------------------------------------- */

const tasksStubWindow = {
  FieldSight: {},
  FS: {
    api: {
      folderName: function (name) { return String(name || '').replace(/\s+/g, '_'); },
      resolveDeadline: function () { return { absolute: null, display: '—' }; },
      isMineTask: global.window.FS.api.isMineTask, // reuse the already-loaded real predicate
      actions:    global.window.FS.api.actions,    // feat/checkoff-org-api — isActionResolved
    },
  },
};
const savedWindow = global.window;
const savedReact = global.React;
global.window = tasksStubWindow;
global.React = {
  useState: function (v) { return [v, function () {}]; },
  useContext: function () { return null; },
  useEffect: function () {},
  createContext: function (def) { return { Provider: 'Provider', _def: def }; },
  Fragment: 'Fragment',
};
const { computeBuckets } = require('../scripts/pages/tasks.js');
global.window = savedWindow;
global.React = savedReact;

function taskRow(overrides) {
  return Object.assign({
    id: 'r', responsible: 'Ben Lin', user_folder: 'Ben_Lin', date: '2026-07-23',
    deadline: null, audit: { checked: false },
  }, overrides);
}

test('tasks.js computeBuckets: exact-match responsible lands in mine', () => {
  const b = computeBuckets([taskRow({})], { name: 'Ben Lin' }, '2026-07-23');
  assert.strictEqual(b.mine.length, 1);
});

test('tasks.js computeBuckets: unassigned row owned by the viewer\'s own folder lands in mine', () => {
  const b = computeBuckets([taskRow({ responsible: null, user_folder: 'Ben_Lin' })], { name: 'Ben Lin' }, '2026-07-23');
  assert.strictEqual(b.mine.length, 1);
});

test('tasks.js computeBuckets: unassigned row owned by a DIFFERENT folder stays out of mine', () => {
  const b = computeBuckets([taskRow({ responsible: null, user_folder: 'Someone_Else' })], { name: 'Ben Lin' }, '2026-07-23');
  assert.strictEqual(b.mine.length, 0);
});

test('tasks.js computeBuckets: assigned-to-someone-else row stays out of mine', () => {
  const b = computeBuckets([taskRow({ responsible: 'Someone Else' })], { name: 'Ben Lin' }, '2026-07-23');
  assert.strictEqual(b.mine.length, 0);
});

test('tasks.js computeBuckets: "Ben" must NOT match "Ben Lin"', () => {
  const b = computeBuckets([taskRow({ responsible: 'Ben' })], { name: 'Ben Lin' }, '2026-07-23');
  assert.strictEqual(b.mine.length, 0);
});

test('tasks.js computeBuckets: missing folder_name on the viewer still resolves via derived folder', () => {
  const b = computeBuckets(
    [taskRow({ responsible: 'Ben_Lin', user_folder: 'Someone_Else' })],
    { name: 'Ben Lin', folderName: undefined },
    '2026-07-23'
  );
  assert.strictEqual(b.mine.length, 1, '"Ben_Lin" responsible matches viewer "Ben Lin" via the derived folder');
});

/* ---------------------------------------------------------------------
   Group 4 — anti-drift: Today and Tasks must agree on the same input
   --------------------------------------------------------------------- */

test('anti-drift: today-adapter adapt() and tasks.js computeBuckets() agree — exact match', () => {
  const viewer = { name: 'Ben Lin' };
  const todayOut = adapt(reportWith([{ action: 'a', responsible: 'Ben Lin' }], 'Ben Lin'), { currentUserName: viewer.name });
  const tasksOut = computeBuckets([taskRow({ responsible: 'Ben Lin', user_folder: 'Ben_Lin' })], viewer, '2026-07-23');
  assert.strictEqual(todayOut.myTasks.length === 1, tasksOut.mine.length === 1, 'both classify as Mine');
});

test('anti-drift: today-adapter adapt() and tasks.js computeBuckets() agree — unassigned, own folder', () => {
  const viewer = { name: 'Ben Lin' };
  const todayOut = adapt(reportWith([{ action: 'a', responsible: null }], 'Ben Lin'), { currentUserName: viewer.name });
  const tasksOut = computeBuckets([taskRow({ responsible: null, user_folder: 'Ben_Lin' })], viewer, '2026-07-23');
  assert.strictEqual(todayOut.myTasks.length === 1, tasksOut.mine.length === 1, 'both classify unassigned+own-folder as Mine');
});

test('anti-drift: today-adapter adapt() and tasks.js computeBuckets() agree — unassigned, other folder', () => {
  const viewer = { name: 'Ben Lin' };
  const todayOut = adapt(reportWith([{ action: 'a', responsible: null }], 'Someone Else'), { currentUserName: viewer.name });
  const tasksOut = computeBuckets([taskRow({ responsible: null, user_folder: 'Someone_Else' })], viewer, '2026-07-23');
  assert.strictEqual(todayOut.myTasks.length === 1, tasksOut.mine.length === 1, 'both classify unassigned+other-folder as Team');
  assert.strictEqual(todayOut.myTasks.length, 0);
  assert.strictEqual(tasksOut.mine.length, 0);
});

test('anti-drift: today-adapter adapt() and tasks.js computeBuckets() agree — "Ben" does not match "Ben Lin"', () => {
  const viewer = { name: 'Ben Lin' };
  const todayOut = adapt(reportWith([{ action: 'a', responsible: 'Ben' }], 'Ben Lin'), { currentUserName: viewer.name });
  const tasksOut = computeBuckets([taskRow({ responsible: 'Ben', user_folder: 'Ben_Lin' })], viewer, '2026-07-23');
  assert.strictEqual(todayOut.myTasks.length === 1, tasksOut.mine.length === 1, 'both classify "Ben" as Team, not Mine');
  assert.strictEqual(todayOut.myTasks.length, 0);
  assert.strictEqual(tasksOut.mine.length, 0);
});

/* ---------------------------------------------------------------------
   Regression: folderName() must TRIM before collapsing whitespace.
   The server builds user_name as `first_name || ' ' || last_name`, so an
   empty last_name yields a trailing space ("Ben_UCPK "). Untrimmed that
   became the folder "Ben_UCPK_", which matched nothing — it 403'd photo
   presigns (P5) and silently routed the user's own unassigned tasks to
   Team, because tasks-aggregator derives the owner folder this way
   (tasks-aggregator.js: folderName(r.user_name)). Caught on dev against
   real data; the earlier unit tests all used already-clean names.
   --------------------------------------------------------------------- */
test('folderName trims before collapsing whitespace', function () {
  function folderName(d) { return String(d == null ? '' : d).trim().replace(/\s+/g, '_'); }
  assert.equal(folderName('Ben_UCPK '), 'Ben_UCPK');      // the real prod case
  assert.equal(folderName(' Ben Lin '), 'Ben_Lin');
  assert.equal(folderName('Ben  Lin'),  'Ben_Lin');
  assert.equal(folderName('Ben_UCPK'),  'Ben_UCPK');      // idempotent
  assert.equal(folderName(null),        '');
});

test('unassigned task is Mine even when the owner name carries a trailing space', function () {
  // ownerFolder as tasks-aggregator would derive it from a TRIMMED user_name
  const viewer = { name: 'Ben_UCPK', folderName: null };  // legacy session, no folder_name
  assert.equal(isMineTask(null, 'Ben_UCPK', viewer), true);
});
