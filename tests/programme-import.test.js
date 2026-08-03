'use strict';

/*
 * The programme importer — the parser behind every import, and until now it
 * had NO automated coverage at all.
 *
 * Not through neglect: the module attached to `window` unconditionally, so it
 * could not be required. That is how a truncating task id survived to reach a
 * real customer file (ui#191), where it collided 420 of 849 tasks, merged
 * nodes in the dependency graph, fabricated a 30-task cycle, and made the
 * critical path refuse to draw.
 *
 * The XML path needs a DOMParser and still cannot run here — it says so
 * itself rather than failing obscurely, and that is asserted below. The CSV
 * path and the id rule are pure, and are covered properly.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  parseCSV, parseMSProjectXML, taskIdFromUid,
} = require('../scripts/api/programme-import.js');

/* ---- the id rule that went wrong ----------------------------------------- */

test('a uid above 999 keeps every digit', () => {
  /* THE regression. ('000' + uid).slice(-3) took the LAST three characters,
     so 1234 and 234 both became T-234. */
  assert.strictEqual(taskIdFromUid('1234'), 'T-1234');
  assert.strictEqual(taskIdFromUid('8814'), 'T-8814');
});

test('uids that share their last three digits stay distinct', () => {
  const ids = ['234', '1234', '11234'].map(taskIdFromUid);
  assert.strictEqual(new Set(ids).size, 3, ids.join(' '));
});

test('a short uid is still padded, so ids line up', () => {
  assert.strictEqual(taskIdFromUid('7'), 'T-007');
  assert.strictEqual(taskIdFromUid('42'), 'T-042');
  assert.strictEqual(taskIdFromUid('999'), 'T-999');
});

test('a numeric uid is handled as well as a string one', () => {
  /* The DOM gives strings; a caller need not know that. */
  assert.strictEqual(taskIdFromUid(1234), 'T-1234');
});

/* ---- the XML path says why it cannot run, rather than failing obscurely --- */

test('MSPDI reports a missing DOMParser instead of throwing', () => {
  const r = parseMSProjectXML('<Project/>');
  assert.strictEqual(r.leaves.length, 0);
  assert.match(r.errors.map(e => e.message).join(' '), /DOMParser/);
});

/* ---- CSV: pure, and now actually covered --------------------------------- */

/* A row is a GROUP when its status is "group" OR it has no parent_id
   (programme-import.js:181). So a leaf needs both the column and a group to
   point at.

   Learned by reading the classifier after three fixtures in a row produced
   parents and no leaves — the module was right each time and my idea of its
   input was wrong. Worth stating here because the next person writing a
   fixture will assume the same thing I did. */
const HEAD  = 'task_id,wbs,parent_id,name,start,end,status';
const GROUP = 'G1,1,,Foundations,2026-04-01,2026-04-10,group';
const LEAF  = 'A1,1.1,G1,Pour slab,2026-04-01,2026-04-10,not_started';
const csv = (...rows) => [HEAD].concat(rows).join('\n');

test('a well-formed CSV parses into a group and a leaf', () => {
  const r = parseCSV(csv(GROUP, LEAF));
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.strictEqual(r.parents.length, 1);
  assert.strictEqual(r.leaves.length, 1);
  assert.strictEqual(r.leaves[0].task_id, 'A1');
  assert.strictEqual(r.leaves[0].name, 'Pour slab');
});

test('a row with no parent_id is a group, not a leaf', () => {
  /* The classifier, pinned. It is the rule every fixture gets wrong. */
  const r = parseCSV(csv('X1,1,,Standalone,2026-04-01,2026-04-10,not_started'));
  assert.strictEqual(r.parents.length, 1);
  assert.strictEqual(r.leaves.length, 0);
});

test('a missing required column is an error, not a silent skip', () => {
  const r = parseCSV('task_id,name\nA1,Pour slab');
  assert.ok(r.errors.length > 0);
  assert.strictEqual(r.leaves.length, 0);
});

test('an empty file is refused rather than parsed as zero tasks', () => {
  assert.ok(parseCSV('').errors.length > 0);
});

test('a BOM does not break the header', () => {
  /* Excel writes one. Without stripping it the first column name is
     "﻿task_id" and every row fails on a missing task_id. */
  const r = parseCSV('﻿' + csv(GROUP, LEAF));
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.strictEqual(r.leaves.length, 1);
});

test('CRLF line endings parse the same as LF', () => {
  const r = parseCSV([HEAD, GROUP, LEAF].join('\r\n') + '\r\n');
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.strictEqual(r.leaves.length, 1);
});

test('a quoted field containing a comma stays one field', () => {
  const r = parseCSV(csv(GROUP,
    'A1,1.1,G1,"Pour slab, east side",2026-04-01,2026-04-10,not_started'));
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.strictEqual(r.leaves[0].name, 'Pour slab, east side');
});

test('an unparseable date is reported against its row', () => {
  const r = parseCSV(csv(GROUP,
    'A1,1.1,G1,Pour slab,not-a-date,2026-04-10,not_started'));
  assert.ok(r.errors.length > 0, 'a bad date must not pass silently');
  assert.ok(r.errors.some(e => e.row === 3), JSON.stringify(r.errors));
});

test('status is required on every row, including a group', () => {
  const r = parseCSV(csv('G1,1,,Foundations,2026-04-01,2026-04-10,', LEAF));
  assert.ok(r.errors.some(e => e.field === 'status'), JSON.stringify(r.errors));
});

test('a blank line between rows is skipped, not treated as a task', () => {
  const r = parseCSV(csv(GROUP, LEAF, '',
    'A2,1.2,G1,Strip forms,2026-04-11,2026-04-12,not_started'));
  assert.strictEqual(r.leaves.length, 2, JSON.stringify(r.errors));
});
