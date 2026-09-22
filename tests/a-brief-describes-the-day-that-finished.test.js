'use strict';

/*
 * A morning brief describes a day that has FINISHED.
 *
 * Measured on prod 2026-09-23: `executive_summary` reaches the client only
 * through the nightly S3 document (lambda_org_api.py:6750), written by
 * cron(0 16 * * ? *) = 04:00 NZ the NEXT day and keyed to the PREVIOUS date.
 * Today's report therefore does not exist while Today is on screen, so the
 * page asking for `today` got null every day, for everyone, and the card
 * rendered an empty <ul> under a hardcoded "5:42 AM" — a generation time for
 * a generation that had not happened.
 *
 * Two things are pinned here. `briefFromReport` must return NOTHING when a
 * report carries no summary, so "there is no brief" and "here is an empty
 * brief" stop being the same value; and the card's subtitle must name the DAY
 * the brief covers rather than a time of day, because the client has no
 * generation timestamp to tell the truth with (the live shape's
 * `_report_metadata` is `{source, version}` — lambda_org_api.py:6762 — the
 * document's own `generated_at` is not passed through).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = {
  FieldSight: {},
  FS: {
    api: {
      folderName: function (name) { return String(name || '').replace(/ /g, '_'); },
      actions: { lookupAction: function () { return undefined; } },
    },
  },
};
global.React = {
  createElement: () => null,
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
};

const { briefFromReport } = require('../scripts/api/today-adapter.js');
const { briefSubtitle } = require('../scripts/composites/morning-brief-card.js');

/* ---- briefFromReport ----------------------------------------------------- */

test('a report with no executive summary yields no brief at all', () => {
  /* The live-extraction shape every ordinary day returns: real topics, and
     the four prose fields null because no S3 document exists for the date. */
  const live = { report_date: '2026-09-22', executive_summary: null, topics: [{}] };
  assert.strictEqual(briefFromReport(live, '2026-09-22', 'Ben_UCPK2'), null);
});

test('a report with bullets yields them under the date it covers', () => {
  const doc = {
    report_date: '2026-09-21',
    executive_summary: ['Demonstrated the dashboard', 'Verified the evidence graph'],
  };
  const brief = briefFromReport(doc, '2026-09-21', 'Ben_UCPK2');
  assert.deepStrictEqual(brief.bullets,
    ['Demonstrated the dashboard', 'Verified the evidence graph']);
  assert.strictEqual(brief.date, '2026-09-21');
  assert.strictEqual(brief.userFolder, 'Ben_UCPK2');
});

test('a v1 bare-string summary becomes one bullet', () => {
  const brief = briefFromReport(
    { report_date: '2026-07-04', executive_summary: 'One paragraph.' }, '2026-07-04', 'X');
  assert.deepStrictEqual(brief.bullets, ['One paragraph.']);
});

test('an empty array is no brief, not a brief with no bullets', () => {
  assert.strictEqual(
    briefFromReport({ report_date: '2026-09-22', executive_summary: [] }, '2026-09-22', 'X'),
    null);
});

test('blank entries are dropped, and a summary of only blanks is no brief', () => {
  const brief = briefFromReport(
    { executive_summary: ['  ', 'Real bullet', ''] }, '2026-09-21', 'X');
  assert.deepStrictEqual(brief.bullets, ['Real bullet']);
  assert.strictEqual(
    briefFromReport({ executive_summary: ['', '   '] }, '2026-09-21', 'X'), null);
});

test('the error envelopes are no brief, never a crash', () => {
  /* _fetch.js nests a 404 body under `raw`; three producers send _notFound
     with no raw at all, so the envelope is all the caller gets. */
  assert.strictEqual(briefFromReport({ _notFound: true, status: 404 }, '2026-09-21', 'X'), null);
  assert.strictEqual(briefFromReport({ _accessDenied: true }, '2026-09-21', 'X'), null);
  assert.strictEqual(briefFromReport({ available_users: ['a'] }, '2026-09-21', 'X'), null);
  assert.strictEqual(briefFromReport(null, '2026-09-21', 'X'), null);
});

test('the date falls back to the date asked for when the document omits one', () => {
  const brief = briefFromReport({ executive_summary: ['b'] }, '2026-09-20', 'X');
  assert.strictEqual(brief.date, '2026-09-20');
});

/* ---- firstBriefIn: a listed day is a CANDIDATE, not a guarantee ---------- */

/*
 * Observed in the browser, not reasoned about: /api/dates listed
 * 2026-04-29 with hasReport true, and getTimeline for that date came back
 * _notFound. GeneratedTodaySection already walks its candidates in sequence
 * for exactly this reason ("the date index is site-scoped while getSessions
 * is default-to-self"). A brief loader that tries only the newest candidate
 * shows nothing on a day when an older one would have answered.
 */
const { firstBriefIn } = require('../scripts/api/today-adapter.js');

function fetcherFrom(byDate) {
  const asked = [];
  return {
    asked: asked,
    fetch: function (date) {
      asked.push(date);
      return Promise.resolve(byDate[date] || { _notFound: true, status: 404 });
    },
  };
}

test('a candidate day with no report is walked past, not given up on', async () => {
  const f = fetcherFrom({
    '2026-04-26': { report_date: '2026-04-26', executive_summary: ['The older day'] },
  });
  const brief = await firstBriefIn(['2026-04-29', '2026-04-28', '2026-04-26'], f.fetch, 'X');
  assert.deepStrictEqual(brief.bullets, ['The older day']);
  assert.strictEqual(brief.date, '2026-04-26');
  assert.deepStrictEqual(f.asked, ['2026-04-29', '2026-04-28', '2026-04-26']);
});

test('the walk stops at the first day that answers', async () => {
  const f = fetcherFrom({
    '2026-04-29': { report_date: '2026-04-29', executive_summary: ['The newest day'] },
    '2026-04-28': { report_date: '2026-04-28', executive_summary: ['Should never be asked'] },
  });
  const brief = await firstBriefIn(['2026-04-29', '2026-04-28'], f.fetch, 'X');
  assert.deepStrictEqual(brief.bullets, ['The newest day']);
  assert.deepStrictEqual(f.asked, ['2026-04-29'], 'one call, not two');
});

test('no candidates and no answers both come back as no brief', async () => {
  assert.strictEqual(await firstBriefIn([], fetcherFrom({}).fetch, 'X'), null);
  assert.strictEqual(await firstBriefIn(['2026-04-29'], fetcherFrom({}).fetch, 'X'), null);
});

test('one day throwing does not abandon the days after it', async () => {
  const asked = [];
  const fetch = function (date) {
    asked.push(date);
    if (date === '2026-04-29') return Promise.reject(new Error('gateway 504'));
    return Promise.resolve({ report_date: date, executive_summary: ['Survived'] });
  };
  const brief = await firstBriefIn(['2026-04-29', '2026-04-28'], fetch, 'X');
  assert.deepStrictEqual(brief.bullets, ['Survived']);
  assert.deepStrictEqual(asked, ['2026-04-29', '2026-04-28']);
});

/* ---- briefSubtitle ------------------------------------------------------- */

test('the subtitle names the day the brief covers and claims no clock time', () => {
  const s = briefSubtitle({ date: '2026-09-21', bullets: ['b'] });
  assert.match(s, /21 Sep 2026/);
  assert.doesNotMatch(s, /\d{1,2}:\d{2}/, 'no time of day may appear');
  assert.doesNotMatch(s, /AM|PM/i);
});

test('a brief with no date says so rather than inventing one', () => {
  const s = briefSubtitle({ bullets: ['b'] });
  assert.doesNotMatch(s, /\d{4}/);
  assert.ok(s.length > 0);
});

/* ---- wiring pins (source scan — these pin CONNECTIONS, not behaviour) ----- */

const read = (...p) =>
  fs.readFileSync(path.join(__dirname, '..', 'scripts', ...p), 'utf8').replace(/\r\n/g, '\n');

/* Comments are stripped first: both files now DESCRIBE the old literal in
   prose explaining why it went, and a scan that cannot tell the two apart
   would fail on the explanation rather than on the defect. */
const readCode = (...p) =>
  read(...p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('nothing anywhere still hands the card a fabricated generation time', () => {
  assert.doesNotMatch(readCode('api', 'today-adapter.js'), /5:42/);
  assert.doesNotMatch(readCode('composites', 'morning-brief-card.js'), /overnight transcripts/);
  assert.doesNotMatch(readCode('pages', 'today.js'), /generatedAt/,
    'the page no longer builds a brief shape carrying one');
});

test('Today loads the brief for a finished day, not for today', () => {
  const src = read('pages', 'today.js');
  assert.match(src, /loadMorningBrief/, 'the loader exists');
  assert.match(src, /firstBriefIn/, 'and walks every candidate, not just the newest');
  assert.match(src, /Promise\.all\(\[loadFor\(today\), loadRollingOpenItems\(\), programmePromise, loadMorningBrief\(\)\]\)/,
    'and is awaited alongside the other Today loads');
  assert.doesNotMatch(src, /loadMorningBrief\(today\)/, 'the brief is never asked for today');
});

test('the card renders on having bullets, not on today having a report', () => {
  const src = read('pages', 'today.js');
  const mount = src.slice(src.indexOf('fs.MorningBriefCard') - 200,
                          src.indexOf('fs.MorningBriefCard') + 120);
  assert.doesNotMatch(mount, /effectiveDate \?/,
    'gating on effectiveDate is what hid the brief on the mornings it is for');
  assert.match(mount, /bullets/);
});
