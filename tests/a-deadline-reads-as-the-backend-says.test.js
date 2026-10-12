'use strict';
/* Owner, 2026-10-12: every surface shows a deadline as the day it names --
   "Wed 14 Oct 2026", anchored on the recording's date. The backend now sends
   `deadline_display` (fieldsight-pipeline src/due_display.py, #1091) so the
   email, the reports, Today and the Timeline read the same words. The
   frontend's own resolveDeadline stays as the fallback for a response
   without it. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = {
  FieldSight: {},
  FS: { api: { folderName: (n) => String(n || '').replace(/ /g, '_') } },
};
global.React = {};
global.document = { addEventListener() {}, removeEventListener() {} };
require('../scripts/api/mine-team.js');
require('../scripts/api/today-adapter.js');
const adapt = global.window.FS.api.todayAdapter.adapt;

function taskOf(action) {
  const out = adapt({
    report_date: '2026-10-12', site: 'L2', user_name: 'Ben Lin',
    executive_summary: [], safety_observations: [],
    topics: [{ topic_id: 0, action_items: [Object.assign({ action: 'x', responsible: 'Ben Lin' }, action)] }],
  }, { currentUserName: 'Ben Lin', nowMinutes: 16 * 60 });
  return out.myTasks.concat(out.teamTasks)[0];
}

test('THE: Today shows the words the backend sent', () => {
  const t = taskOf({ deadline: 'tomorrow morning', deadline_display: 'Tue 13 Oct 2026, morning',
                     deadline_by: '2026-10-13T12:00' });
  assert.strictEqual(t.dueTime, 'Tue 13 Oct 2026, morning');
  assert.strictEqual(t.deadline, 'tomorrow morning', 'the raw text is still there for the chip');
});

test('without deadline_display Today resolves it as before', () => {
  const t = taskOf({ deadline: '2026-10-14' });
  assert.strictEqual(t.dueTime, global.window.FS.api.resolveDeadline('2026-10-14', '2026-10-12').display);
});

/* SOURCE SCAN (wiring pins): the Timeline row and the email preview are
   React render paths with no pure seam; these pin that they read the field. */
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'scripts', ...p), 'utf8').replace(/\r\n/g, '\n');

test('the Timeline action row prefers deadline_display', () => {
  const src = read('composites', 'action-item-row.js');
  assert.match(src, /var deadlineDisplay = action\.deadline_display\n\s+\? action\.deadline_display/);
});

test('every email-preview row prefers deadline_display', () => {
  const src = read('composites', 'email-preview-modal.js');
  assert.strictEqual((src.match(/a\.deadline_display \|\| a\.deadline \|\| a\.deadline_text/g) || []).length, 3);
  assert.doesNotMatch(src, /: +a\.deadline \|\| a\.deadline_text/);
});
