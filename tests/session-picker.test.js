'use strict';

/*
 * Unit tests for feat/session-picker-ui — narrowing a day's Timeline to one
 * recording session ("just that meeting") instead of the whole day.
 *
 * Covers:
 *   - scripts/api/org.js's getSessions: gated on the SAME predicate as the
 *     neighbouring timeline-derived reads (timelineSource==='aurora' &&
 *     orgBaseUrl — audio.js/media.js/video.js/transcripts.js's exact gate,
 *     copied verbatim per the plan), and that _accessDenied/_notFound pass
 *     straight through rather than being swallowed.
 *   - scripts/pages/timeline.js's pure session-picker helpers:
 *       shouldShowSessionPicker  — the >=2-sessions render rule
 *       filterTopicsBySession    — client-side topic filtering (the WHOLE
 *                                  point: no network request per selection)
 *       groupSessionsByBlock     — restart-of-one-meeting grouping
 *       formatParticipants       — sensible truncation of a long list
 *       formatSessionSummary     — the picker row's full label
 *       formatExcludedNote       — the honest "N hidden" note
 *
 * Both modules are browser IIFEs; requiring them under Node with a minimal
 * window/React stub is the established posture (see
 * tests/checkoff-org-api.test.js and tests/timeline-redaction-overrides.test.js).
 */
const test = require('node:test');
const assert = require('node:assert');

/* =========================================================================
   scripts/api/org.js — getSessions
   ========================================================================= */

let orgCalls;
let orgResponse;

function loadOrg(overrides) {
  orgCalls = [];
  global.window = {
    FieldSight: { fixtures: {} },
    FS: {
      api: Object.assign({
        useMocks:       false,
        timelineSource: 'aurora',
        orgBaseUrl:     'https://org.example/prod/api',
        delay:          function () { return Promise.resolve(); },
        orgRequest:     function (path, opts) {
          orgCalls.push({ path: path, params: opts && opts.params });
          return Promise.resolve(orgResponse);
        },
      }, overrides || {}),
    },
  };
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}

test('getSessions hits GET /sessions with date+user when aurora+orgBaseUrl are both live', async () => {
  const org = loadOrg();
  orgResponse = { date: '2026-07-18', user: 'Ben_UCPK', gap_minutes: 15, sessions: [], excluded: { non_work: 0, redacted: 0 } };

  const res = await org.getSessions({ date: '2026-07-18', user: 'Ben_UCPK' });

  assert.deepStrictEqual(orgCalls, [{ path: '/sessions', params: { date: '2026-07-18', user: 'Ben_UCPK' } }]);
  assert.strictEqual(res, orgResponse);
});

test('getSessions does NOT call the org backend when timelineSource is not aurora', async () => {
  const org = loadOrg({ timelineSource: 'report' });
  const res = await org.getSessions({ date: '2026-07-18', user: 'Ben_UCPK' });

  assert.strictEqual(orgCalls.length, 0, 'report-source timeline has no /sessions shim to call');
  assert.deepStrictEqual(res.sessions, [], 'falls back to a safe empty list, not a crash');
});

test('getSessions does NOT call the org backend when orgBaseUrl is empty (kill switch)', async () => {
  const org = loadOrg({ orgBaseUrl: '' });
  await org.getSessions({ date: '2026-07-18', user: 'Ben_UCPK' });
  assert.strictEqual(orgCalls.length, 0);
});

test('getSessions does NOT call the org backend in mock mode', async () => {
  const org = loadOrg({ useMocks: true });
  const res = await org.getSessions({ date: '2026-07-18', user: 'Ben_UCPK' });
  assert.strictEqual(orgCalls.length, 0);
  assert.deepStrictEqual(res.excluded, { non_work: 0, redacted: 0 });
});

test('getSessions lets an _accessDenied envelope through untouched — never swallowed', async () => {
  const org = loadOrg();
  orgResponse = { _accessDenied: true, status: 403, error: 'no reach' };
  const res = await org.getSessions({ date: '2026-07-18', user: 'Someone_Else' });
  assert.strictEqual(res._accessDenied, true);
  assert.strictEqual(res.error, 'no reach');
});

test('getSessions lets a _notFound envelope through untouched — never swallowed', async () => {
  const org = loadOrg();
  orgResponse = { _notFound: true, status: 404 };
  const res = await org.getSessions({ date: '2026-07-18', user: 'Ben_UCPK' });
  assert.strictEqual(res._notFound, true);
});

/* =========================================================================
   scripts/pages/timeline.js — pure session-picker helpers
   ========================================================================= */

global.window = global.window || {};
global.React = global.React || {};

const {
  shouldShowSessionPicker,
  filterTopicsBySession,
  groupSessionsByBlock,
  formatParticipants,
  formatSessionSummary,
  formatExcludedNote,
} = require('../scripts/pages/timeline.js');

const SESSION_A = {
  session_id: 'ben_ucpk_2026-07-18_15-16-24', started_at: '2026-07-18T15:16:24', ended_at: '2026-07-18T15:17:00',
  site_name: 'UC PK', topic_count: 1, open_action_count: 2,
  participants: ['Alex', 'Unknown Inspector (spk_0)'], topic_row_ids: ['r1'],
  label: '15:16 – 15:17', block: 1,
};
const SESSION_B = {
  session_id: 'ben_ucpk_2026-07-18_15-40-00', started_at: '2026-07-18T15:40:00', ended_at: null,
  site_name: 'UC PK', topic_count: 1, open_action_count: 0,
  participants: ['Alex'], topic_row_ids: ['r2'],
  label: '15:40 – ?', block: 1,   // same block as A — a restart of the same meeting
};
const SESSION_C = {
  session_id: 'ben_ucpk_2026-07-18_09-00-00', started_at: '2026-07-18T09:00:00', ended_at: '2026-07-18T09:30:00',
  site_name: 'UC PK', topic_count: 2, open_action_count: 1,
  participants: ['Jarley'], topic_row_ids: ['r3'],
  label: '09:00 – 09:30', block: 2,
};

/* ---- shouldShowSessionPicker: the >=2-sessions render rule --------------- */

test('shouldShowSessionPicker is false for zero sessions', () => {
  assert.strictEqual(shouldShowSessionPicker([]), false);
  assert.strictEqual(shouldShowSessionPicker(null), false);
  assert.strictEqual(shouldShowSessionPicker(undefined), false);
});

test('shouldShowSessionPicker is false for exactly one session — nothing to choose between', () => {
  assert.strictEqual(shouldShowSessionPicker([SESSION_A]), false);
});

test('shouldShowSessionPicker is true for two or more sessions', () => {
  assert.strictEqual(shouldShowSessionPicker([SESSION_A, SESSION_C]), true);
  assert.strictEqual(shouldShowSessionPicker([SESSION_A, SESSION_B, SESSION_C]), true);
});

/* ---- filterTopicsBySession: client-side filtering, no network ------------ */

const TOPIC_SESSION_A  = { topic_id: 0, topic_title: 'Scaffold check', session_id: SESSION_A.session_id, session_kind: 'extraction' };
const TOPIC_SESSION_C  = { topic_id: 1, topic_title: 'Delivery review', session_id: SESSION_C.session_id, session_kind: 'extraction' };
const TOPIC_REPORT_KIND = { topic_id: 2, topic_title: 'Legacy summary topic', session_id: undefined, session_kind: 'report' };
const ALL_TOPICS = [TOPIC_SESSION_A, TOPIC_SESSION_C, TOPIC_REPORT_KIND];

test('filterTopicsBySession returns every topic unchanged on "All day" (null selection) — report-kind topics included', () => {
  const out = filterTopicsBySession(ALL_TOPICS, null);
  assert.deepStrictEqual(out, ALL_TOPICS);
  assert.strictEqual(out.indexOf(TOPIC_REPORT_KIND) !== -1, true);
});

test('filterTopicsBySession with undefined selection also means "All day"', () => {
  assert.deepStrictEqual(filterTopicsBySession(ALL_TOPICS, undefined), ALL_TOPICS);
});

test('filterTopicsBySession keeps only the matching session\'s topics', () => {
  const out = filterTopicsBySession(ALL_TOPICS, SESSION_A.session_id);
  assert.deepStrictEqual(out, [TOPIC_SESSION_A]);
});

test('filterTopicsBySession hides session_kind:"report" topics (no session_id) once a specific session is selected', () => {
  const out = filterTopicsBySession(ALL_TOPICS, SESSION_C.session_id);
  assert.deepStrictEqual(out, [TOPIC_SESSION_C]);
  assert.strictEqual(out.indexOf(TOPIC_REPORT_KIND), -1);
});

test('filterTopicsBySession tolerates a null/undefined topics list', () => {
  assert.deepStrictEqual(filterTopicsBySession(null, SESSION_A.session_id), []);
  assert.deepStrictEqual(filterTopicsBySession(undefined, null), []);
});

test('selecting a session issues no network request — filterTopicsBySession touches nothing off window/fetch', () => {
  /* Proof it is pure client-side filtering: this call runs with NO window.FS.api
     stub at all (global.window is the bare {} set up above, no .api, no
     .org, no fetch). If filterTopicsBySession reached for the network in any
     way it would throw a ReferenceError/TypeError here instead of returning. */
  const savedWindow = global.window;
  global.window = {};
  try {
    const out = filterTopicsBySession(ALL_TOPICS, SESSION_A.session_id);
    assert.deepStrictEqual(out, [TOPIC_SESSION_A]);
  } finally {
    global.window = savedWindow;
  }
});

/* ---- groupSessionsByBlock: restart-of-one-meeting grouping --------------- */

test('groupSessionsByBlock groups sessions sharing a block together, in first-appearance order', () => {
  const groups = groupSessionsByBlock([SESSION_A, SESSION_C, SESSION_B]);
  assert.strictEqual(groups.length, 2, 'A and B share block 1 -> one group; C -> its own group');
  assert.deepStrictEqual(groups[0], { block: 1, sessions: [SESSION_A, SESSION_B] });
  assert.deepStrictEqual(groups[1], { block: 2, sessions: [SESSION_C] });
});

test('groupSessionsByBlock gives a blockless session its own singleton group', () => {
  const solo = Object.assign({}, SESSION_C, { block: undefined, session_id: 'solo-1' });
  const groups = groupSessionsByBlock([solo]);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].sessions, [solo]);
});

test('groupSessionsByBlock tolerates an empty/null list', () => {
  assert.deepStrictEqual(groupSessionsByBlock([]), []);
  assert.deepStrictEqual(groupSessionsByBlock(null), []);
});

/* ---- formatParticipants: sensible truncation ------------------------------ */

test('formatParticipants joins a short list with ", "', () => {
  assert.strictEqual(formatParticipants(['Alex', 'Unknown Inspector (spk_0)']), 'Alex, Unknown Inspector (spk_0)');
});

test('formatParticipants truncates a long list to "+N more"', () => {
  assert.strictEqual(formatParticipants(['Alex', 'Jarley', 'David', 'Ben'], 2), 'Alex, Jarley +2 more');
});

test('formatParticipants returns empty string for no participants', () => {
  assert.strictEqual(formatParticipants([]), '');
  assert.strictEqual(formatParticipants(null), '');
});

/* ---- formatSessionSummary: the picker row's full label -------------------- */

test('formatSessionSummary matches the spec example verbatim', () => {
  assert.strictEqual(
    formatSessionSummary(SESSION_A),
    '15:16 – 15:17 · 1 topic · 2 open · Alex, Unknown Inspector (spk_0)',
  );
});

test('formatSessionSummary pluralizes "topics" and handles zero open actions', () => {
  const s = { label: '09:00 – 09:30', topic_count: 2, open_action_count: 0, participants: ['Jarley'] };
  assert.strictEqual(formatSessionSummary(s), '09:00 – 09:30 · 2 topics · 0 open · Jarley');
});

test('formatSessionSummary omits the participants segment when there are none', () => {
  const s = { label: '09:00 – 09:30', topic_count: 1, open_action_count: 0, participants: [] };
  assert.strictEqual(formatSessionSummary(s), '09:00 – 09:30 · 1 topic · 0 open');
});

/* ---- formatExcludedNote: the honest excluded-count note ------------------- */

test('formatExcludedNote reads "1 personal topic hidden" for excluded.redacted:1 (real verified response shape)', () => {
  assert.strictEqual(formatExcludedNote({ non_work: 0, redacted: 1 }), '1 personal topic hidden');
});

test('formatExcludedNote pluralizes for more than one', () => {
  assert.strictEqual(formatExcludedNote({ non_work: 0, redacted: 3 }), '3 personal topics hidden');
});

test('formatExcludedNote covers non_work too, joining both when present', () => {
  assert.strictEqual(
    formatExcludedNote({ non_work: 2, redacted: 1 }),
    '1 personal topic hidden · 2 non-work topics hidden',
  );
});

test('formatExcludedNote returns null (no note rendered) when nothing was excluded', () => {
  assert.strictEqual(formatExcludedNote({ non_work: 0, redacted: 0 }), null);
  assert.strictEqual(formatExcludedNote(null), null);
  assert.strictEqual(formatExcludedNote(undefined), null);
});
