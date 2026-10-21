'use strict';

/*
 * Every date or time the UI shows a person is New Zealand time.
 *
 * Owner rule 2026-10-22: the server stores and returns UTC; the client always
 * displays Pacific/Auckland. Seen on prod the same day: a template saved at
 * 10:30 on 22 Oct in Auckland read "Version 1 · updated 21 Oct 2026", because
 * the Library took the first ten characters of a UTC timestamp. The Documents
 * section, for its part, rendered "10/22/2026" -- US order, browser zone.
 *
 * The other direction matters as much: a bare 'YYYY-MM-DD' is a calendar day
 * (report dates, S3 day folders) and must come back unshifted.
 *
 * These run in whatever zone the machine is in; the helper must not care.
 * The suite was also run with TZ=America/Los_Angeles to prove it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
require('../scripts/api/index.js');
const api = global.window.FS.api;

test('a UTC timestamp late in the UTC day is the next day in NZ', () => {
  const iso = '2026-10-21T21:30:00Z';
  assert.strictEqual(api.nzDate(iso), '22 Oct 2026');
  assert.strictEqual(api.nzDateTime(iso), '22 Oct 2026, 10:30');
  assert.strictEqual(api.nzTime(iso), '10:30');
  assert.strictEqual(api.nzDay(iso), '2026-10-22');
});

test('the prod Library case: saved 10:30 NZ on 22 Oct reads 22 Oct', () => {
  /* Postgres-style str() of a timestamptz, as the org API sends it. */
  assert.strictEqual(api.nzDate('2026-10-21 21:30:12.345678+00:00'), '22 Oct 2026');
});

test('offsets other than Z, a Date and epoch milliseconds all convert', () => {
  assert.strictEqual(api.nzDateTime('2026-10-22T10:30:00+13:00'), '22 Oct 2026, 10:30');
  assert.strictEqual(api.nzDateTime(new Date(Date.UTC(2026, 9, 21, 21, 30))), '22 Oct 2026, 10:30');
  assert.strictEqual(api.nzDateTime(Date.UTC(2026, 9, 21, 21, 30)), '22 Oct 2026, 10:30');
});

test('a timestamp with no offset is NZ wall clock already and is not shifted', () => {
  /* A session's started_at is the device's NZ clock from the filename
     (session_scope.session_start), never a UTC instant. */
  assert.strictEqual(api.nzDateTime('2026-10-21T21:30:00'), '21 Oct 2026, 21:30');
  assert.strictEqual(api.nzTime('2026-07-25 13:05:12'), '13:05');
});

test('a pure YYYY-MM-DD never shifts', () => {
  assert.strictEqual(api.nzDate('2026-10-21'), '21 Oct 2026');
  assert.strictEqual(api.nzDateTime('2026-10-21'), '21 Oct 2026');
  assert.strictEqual(api.nzTime('2026-10-21'), '');
  assert.strictEqual(api.nzDay('2026-10-21'), '2026-10-21');
  assert.strictEqual(api.nzDate('2026-01-01'), '1 Jan 2026');
  assert.strictEqual(api.nzDate('2026-12-31'), '31 Dec 2026');
});

test('September is Sep, not ICU\'s en-NZ "Sept"', () => {
  assert.strictEqual(api.nzDate('2026-09-03T00:00:00Z'), '3 Sep 2026');
});

test('midnight is 00:00, never 24:00', () => {
  /* 2026-10-21T11:00Z = 22 Oct 00:00 NZDT */
  assert.strictEqual(api.nzDateTime('2026-10-21T11:00:00Z'), '22 Oct 2026, 00:00');
});

test('summer and winter: the same UTC clock is +13 in January, +12 in June', () => {
  assert.strictEqual(api.nzTime('2026-01-15T00:00:00Z'), '13:00');
  assert.strictEqual(api.nzTime('2026-06-15T00:00:00Z'), '12:00');
});

test('DST starts 27 Sep 2026: 01:59 NZST is followed by 03:00 NZDT', () => {
  assert.strictEqual(api.nzDateTime('2026-09-26T13:59:00Z'), '27 Sep 2026, 01:59');
  assert.strictEqual(api.nzDateTime('2026-09-26T14:00:00Z'), '27 Sep 2026, 03:00');
});

test('DST ends 5 Apr 2026: 02:59 NZDT is followed by 02:00 NZST', () => {
  assert.strictEqual(api.nzDateTime('2026-04-04T13:59:00Z'), '5 Apr 2026, 02:59');
  assert.strictEqual(api.nzDateTime('2026-04-04T14:00:00Z'), '5 Apr 2026, 02:00');
});

test('empty and unparseable input: empty stays empty, garbage shows as itself', () => {
  assert.strictEqual(api.nzDate(null), '');
  assert.strictEqual(api.nzDate(undefined), '');
  assert.strictEqual(api.nzDate(''), '');
  assert.strictEqual(api.nzDate('not-a-date'), 'not-a-date');
  assert.strictEqual(api.nzDate('2026-13-01'), '2026-13-01');
  assert.strictEqual(api.nzDay('not-a-date'), '');
});

/* ── The call sites that showed the bug use the helper ──────────────────── */

function src(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

test('Library dates a version by its NZ day, not the UTC prefix', () => {
  const s = src('scripts/pages/library.js');
  const fn = s.slice(s.indexOf('function fmtDate('), s.indexOf('function sectionCount('));
  assert.match(fn, /nzDate\(/);
  assert.doesNotMatch(fn, /slice\(0, 10\)/);
});

test('the Documents section dates rows in NZ order and zone, never toLocaleDateString', () => {
  const s = src('scripts/composites/project-documents-section.js');
  assert.doesNotMatch(s, /toLocaleDateString\(\)/);
  assert.match(s, /nzDate\(/);
});

test('Reports says Generated in NZ time, not "UTC"', () => {
  const s = src('scripts/pages/reports.js');
  assert.doesNotMatch(s, /\+ ' UTC'/);
});
