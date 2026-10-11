'use strict';

/*
 * A checklist report made on its own from a spoken check (owner, 2026-10-06)
 * is waiting in two places: the day's Timeline ("Checklist reports") and the
 * bell, which also says when a check had no checklist to fill (never a wrong
 * form -- the owner's choice).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const ORG = read('scripts', 'api', 'org.js');
const TL = read('scripts', 'pages', 'timeline.js');
const BELL = read('scripts', 'composites', 'notification-bell.js');
const HTML = read('app-shell-preview.html');

global.window = global.window || {};
const store = {};
global.window.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
const cr = require('../scripts/api/checklist-reports.js');

const R = { id: 'r1', templateName: 'Concrete Pre-pour Inspection Checklist',
  checkName: 'level 2 pre-pour', startAt: '10:59:09', status: 'done', requestId: 'abc', date: '2026-10-06' };

test('THE a ready checklist says so, by its template and check', () => {
  assert.strictEqual(cr.words(R), 'Concrete Pre-pour Inspection Checklist — level 2 pre-pour, 10:59: ready');
  assert.match(cr.words(Object.assign({}, R, { status: 'pending' })), /being written…$/);
  assert.match(cr.words(Object.assign({}, R, { status: 'error' })), /could not be written$/);
});

test('a check with no checklist is a notice, not a report', () => {
  assert.strictEqual(cr.unmatchedWords({ checkName: 'steel inspection', startAt: '11:02:21' }),
    'Heard “steel inspection” at 11:02 — no checklist in your Library matches it.');
});

test('seen ones stop counting', () => {
  const api = global.window.FS.checklistReports;
  assert.strictEqual(api.get().unseen, 0);
  api.markSeen('r1');
  assert.ok(api.get().seen.r1);
});

test('the api asks for the day and for the caller\'s recent ones', () => {
  assert.match(ORG, /'\/days\/' \+ encodeURIComponent\(opts\.date\) \+ '\/checklist-reports'/);
  assert.match(ORG, /api\.orgRequest\('\/checklist-reports\/recent'\)/);
  assert.match(ORG, /getRecentChecklistReports: getRecentChecklistReports,/);
});

test('the Timeline shows them above the topics, and the bell counts and lists them', () => {
  assert.match(TL, /React\.createElement\(ChecklistReportsCard, \{ date: date, userFolder: user \|\| null \}\)/);
  assert.match(TL, /'Checklist reports'/);
  assert.match(BELL, /count \+= \(checks && checks\.unseen\) \|\| 0;/);
  assert.match(BELL, /h\('span', null, 'Checklists'\)/);
  assert.match(BELL, /checksApi\.download\(r, checks\.folder\)/);
  assert.match(HTML, /scripts\/api\/checklist-reports\.js\?v=\d+/);
});
