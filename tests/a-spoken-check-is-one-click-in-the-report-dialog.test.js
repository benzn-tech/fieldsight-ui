'use strict';

/*
 * Voice-triggered checklists, the report dialog's half (owner 2026-09-30):
 * "starting the pre-pour concrete check" -> the dialog lists that check with
 * its window and the company checklist it matched, and one click picks the
 * checklist, the check's topics and its exact window. Reports stay on demand:
 * nothing is generated until the person presses Generate.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
if (!global.window.FieldSight) global.window.FieldSight = {};

const m = require('../scripts/composites/session-report-modal.js');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const MODAL = read('scripts', 'composites', 'session-report-modal.js');
const ORG = read('scripts', 'api', 'org.js');

const BASE = { scope: 'day', date: '2026-10-05', userFolder: 'Ben_Lin_Test',
  form: { templateId: 't-1', templateVersion: 2, title: 'Pre-pour' }, deliver: 'download' };

test('THE a check\'s exact window travels with the request', () => {
  const p = m.buildGeneratePayload(Object.assign({}, BASE,
    { window: { from: '10:59:09', to: '11:02:14' } }));
  assert.strictEqual(p.from, '10:59:09');
  assert.strictEqual(p.to, '11:02:14');
  assert.strictEqual(p.templateId, 't-1');
});

test('without a check the request is exactly what it was', () => {
  const p = m.buildGeneratePayload(Object.assign({}, BASE, { window: null }));
  assert.ok(!('from' in p) && !('to' in p));
});

test('the api layer lets the window through its whitelist, and only both ends together', () => {
  assert.match(ORG, /if \(opts\.from && opts\.to\) \{\n\s+body\.from = opts\.from;\n\s+body\.to = opts\.to;/);
  assert.match(ORG, /'\/days\/' \+ encodeURIComponent\(opts\.date\) \+ '\/inspections'/);
  assert.match(ORG, /getDayInspections: getDayInspections,/);
});

test('a check reads as its name and its window', () => {
  assert.strictEqual(m.checkLabel({ name: 'level one pre-pour inspections',
    start_at: '10:59:09', end_at: '11:02:14' }), 'level one pre-pour inspections · 10:59–11:02');
});

test('the dialog lists the day\'s checks and one click picks checklist, topics and window', () => {
  assert.match(MODAL, /org\.getDayInspections\(\{ date: props\.date, user: props\.userFolder \}\)/);
  assert.match(MODAL, /function useCheck\(c\) \{[\s\S]{0,400}setChecked\(stretchesChecked\(pTopics, segs\)\)[\s\S]{0,200}setCheckWin\(\{ from: c\.start_at, to: c\.end_at/);
  assert.match(MODAL, /applyTemplateChoice\(f, row\.id, row\.version\)/);
  assert.match(MODAL, /window: checkWin,/);
  assert.match(MODAL, /'No checklist template matches this check'/);
});

test('choosing the window by hand forgets the check', () => {
  assert.match(MODAL, /btn\('Select this window', function \(\) \{ setCheckWin\(null\);/);
  assert.match(MODAL, /btn\('Select all', function \(\) \{ setCheckWin\(null\);/);
});


test('THE an interrupted check sends its stretches and ticks only their topics', () => {
  const segs = [{ from: '11:02:03', to: '11:02:21' }, { from: '11:08:41', to: '11:10:21' }];
  const p = m.buildGeneratePayload(Object.assign({}, BASE,
    { window: { from: '11:02:03', to: '11:10:21', segments: segs } }));
  assert.deepStrictEqual(p.segments, segs);
  assert.strictEqual(m.checkLabel({ name: 'pre-pour', start_at: '11:02:03', end_at: '11:10:21', segments: segs }),
    'pre-pour · 11:02–11:02, 11:08–11:10');
  const topics = [{ topic_row_id: 'a', time_range: '11:01 – 11:02' },
                  { topic_row_id: 's', time_range: '11:05 – 11:06' },
                  { topic_row_id: 'b', time_range: '11:09 – 11:09' }];
  assert.deepStrictEqual(m.stretchesChecked(topics, segs), { a: true, s: false, b: true });
  assert.match(ORG, /if \(Array\.isArray\(opts\.segments\) && opts\.segments\.length > 1\) \{\n\s+body\.segments = /);
});

test('a check with no stretches is its whole window', () => {
  assert.deepStrictEqual(m.checkSegments({ start_at: '10:59:09', end_at: '11:02:14' }),
    [{ from: '10:59:09', to: '11:02:14' }]);
});
