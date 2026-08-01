'use strict';

/*
 * Unit tests for the Today page's "Generated" section.
 *
 * The first cut was today-only AND gated on `effectiveDate` (today having its
 * own report), and returned null — heading included — on loading, error and
 * empty alike. On any day without a recording the section did not exist, which
 * is most days: there was no way to tell "nothing recorded today" apart from
 * "the feature is broken", and no way to eyeball it without recording first.
 * That is exactly how it was reported: "I don't see this section."
 *
 * It now shows the most recent day that HAS sessions, naming that day in the
 * heading when it is not today. These tests pin the probe order (today first,
 * stop at the first day with sessions), that a failing probe does not abort
 * the walk, and the BUG-19-safe day label.
 */
const test = require('node:test');
const assert = require('node:assert');

let calls;
let sessionsByDate;      // date -> sessions array, or an Error to reject with
let datesResponse;       // what getDates resolves with
let datesRejects;

global.window = {
  FieldSight: {},
  FS: {
    api: {
      todayNZDT: function () { return '2026-08-02'; },
      addDaysISO: function (iso, n) {
        const p = iso.split('-').map(Number);
        const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      },
      dates: {
        getDates: function (opts) {
          calls.getDates.push(opts);
          if (datesRejects) return Promise.reject(new Error('dates down'));
          return Promise.resolve(datesResponse);
        },
      },
      org: {
        getSessions: function (opts) {
          calls.getSessions.push(opts.date);
          const v = sessionsByDate[opts.date];
          if (v instanceof Error) return Promise.reject(v);
          return Promise.resolve({ sessions: v || [] });
        },
      },
    },
  },
  console: { warn: function () {} },
};
global.console.warn = function () {};

let stateSeed = { status: 'loading', sessions: [], date: null };
let setStates = [];

global.React = {
  useState: function () { return [stateSeed, function (v) { setStates.push(v); }]; },
  useEffect: function (fn) { fn(); },
  useRef: function (v) { return { current: v }; },
  useContext: function () { return null; },
  createContext: function (def) { return { Provider: 'Provider', _def: def }; },
  createElement: function (type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    return { type: type, props: props || {}, children: children };
  },
  Fragment: 'Fragment',
};
global.document = { addEventListener() {}, removeEventListener() {} };

const {
  _generatedDayLabel, _fallbackCandidates, GeneratedTodaySection,
} = require('../scripts/pages/today.js');

function reset() {
  calls = { getSessions: [], getDates: [] };
  sessionsByDate = {};
  datesResponse = { dates: {} };
  datesRejects = false;
  setStates = [];
  stateSeed = { status: 'loading', sessions: [], date: null };
}

function textOf(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children || []).map(textOf).join('');
}

const sess = (id) => ({ session_id: id, started_at: '2026-07-31T17:49:31', topic_count: 5 });

/* ---- _generatedDayLabel -------------------------------------------------- */

test('_generatedDayLabel renders weekday, day and month', () => {
  assert.strictEqual(_generatedDayLabel('2026-07-31'), 'Fri 31 Jul');
  assert.strictEqual(_generatedDayLabel('2026-08-02'), 'Sun 2 Aug');
  assert.strictEqual(_generatedDayLabel('2026-01-01'), 'Thu 1 Jan');
});

test('_generatedDayLabel does not drift a day (BUG-19)', () => {
  // new Date('2026-07-31') parses as UTC midnight; read back in NZ (UTC+12)
  // that is still the 31st, but the naive local getters flip other dates.
  // Building and reading via UTC keeps the label on the date it was given.
  for (const iso of ['2026-07-31', '2026-12-31', '2026-03-01', '2026-06-30']) {
    assert.ok(_generatedDayLabel(iso).endsWith(
      ({ '07': 'Jul', '12': 'Dec', '03': 'Mar', '06': 'Jun' })[iso.slice(5, 7)]));
    assert.ok(_generatedDayLabel(iso).includes(String(Number(iso.slice(8, 10)))));
  }
});

test('_generatedDayLabel passes a malformed value through rather than throwing', () => {
  assert.strictEqual(_generatedDayLabel(''), '');
  assert.strictEqual(_generatedDayLabel(null), '');
  assert.strictEqual(_generatedDayLabel('not-a-date'), 'not-a-date');
});

/* ---- _fallbackCandidates ------------------------------------------------- */

test('_fallbackCandidates returns days strictly before today, newest first', async () => {
  reset();
  datesResponse = { dates: { '2026-07-28': 1, '2026-07-31': 1, '2026-08-02': 1, '2026-07-30': 1 } };

  assert.deepStrictEqual(await _fallbackCandidates('2026-08-02'),
    ['2026-07-31', '2026-07-30', '2026-07-28']);
});

test('_fallbackCandidates caps how many days it will probe', async () => {
  reset();
  const days = {};
  for (let d = 1; d <= 20; d++) days['2026-07-' + String(d).padStart(2, '0')] = 1;
  datesResponse = { dates: days };

  assert.strictEqual((await _fallbackCandidates('2026-08-02')).length, 5);
});

test('_fallbackCandidates degrades to no candidates when the date index fails', async () => {
  reset();
  datesRejects = true;

  assert.deepStrictEqual(await _fallbackCandidates('2026-08-02'), []);
});

/* ---- the section's probe walk ------------------------------------------- */

async function runSection(today) {
  GeneratedTodaySection({ today: today });
  await new Promise((r) => setImmediate(r));
  return setStates[setStates.length - 1];
}

test('a day with its own sessions costs exactly one call and no date lookup', async () => {
  reset();
  sessionsByDate['2026-08-02'] = [sess('s-today')];

  const out = await runSection('2026-08-02');

  assert.deepStrictEqual(calls.getSessions, ['2026-08-02']);
  assert.strictEqual(calls.getDates.length, 0, 'must not look back when today has sessions');
  assert.strictEqual(out.date, '2026-08-02');
  assert.strictEqual(out.sessions.length, 1);
});

test('an empty today falls back to the most recent day that has sessions', async () => {
  reset();
  sessionsByDate['2026-08-02'] = [];
  sessionsByDate['2026-08-01'] = [];
  sessionsByDate['2026-07-31'] = [sess('s-31')];
  datesResponse = { dates: { '2026-08-01': 1, '2026-07-31': 1, '2026-07-30': 1 } };

  const out = await runSection('2026-08-02');

  // stops at the first day that has sessions — 07-30 is never probed
  assert.deepStrictEqual(calls.getSessions, ['2026-08-02', '2026-08-01', '2026-07-31']);
  assert.strictEqual(out.date, '2026-07-31');
  assert.strictEqual(out.sessions.length, 1);
});

test('a failing probe does not abort the walk', async () => {
  reset();
  sessionsByDate['2026-08-02'] = [];
  sessionsByDate['2026-08-01'] = new Error('one bad day');
  sessionsByDate['2026-07-31'] = [sess('s-31')];
  datesResponse = { dates: { '2026-08-01': 1, '2026-07-31': 1 } };

  const out = await runSection('2026-08-02');

  assert.strictEqual(out.date, '2026-07-31');
  assert.strictEqual(out.sessions.length, 1);
});

test('no sessions anywhere resolves to a ready-but-empty state', async () => {
  reset();
  sessionsByDate['2026-08-02'] = [];
  datesResponse = { dates: { '2026-07-31': 1 } };
  sessionsByDate['2026-07-31'] = [];

  const out = await runSection('2026-08-02');

  assert.strictEqual(out.status, 'ready');
  assert.strictEqual(out.sessions.length, 0);
  assert.strictEqual(out.date, null);
});

test('sessions are ordered newest first', async () => {
  reset();
  sessionsByDate['2026-08-02'] = [
    { session_id: 'early', started_at: '2026-08-02T08:00:00' },
    { session_id: 'late', started_at: '2026-08-02T17:00:00' },
    { session_id: 'mid', started_at: '2026-08-02T12:00:00' },
  ];

  const out = await runSection('2026-08-02');

  assert.deepStrictEqual(out.sessions.map((s) => s.session_id), ['late', 'mid', 'early']);
});

/* ---- heading ------------------------------------------------------------- */

test('heading says "Generated today" when the sessions are today\'s', () => {
  reset();
  stateSeed = { status: 'ready', sessions: [sess('s-1')], date: '2026-08-02' };

  const out = GeneratedTodaySection({ today: '2026-08-02' });

  assert.ok(textOf(out).includes('Generated today'), textOf(out));
});

test('heading names the day when falling back', () => {
  reset();
  stateSeed = { status: 'ready', sessions: [sess('s-1')], date: '2026-07-31' };

  const out = GeneratedTodaySection({ today: '2026-08-02' });

  assert.ok(textOf(out).includes('Generated · Fri 31 Jul'), textOf(out));
});

test('renders nothing while loading, on error, or with no sessions', () => {
  for (const seed of [
    { status: 'loading', sessions: [], date: null },
    { status: 'error', sessions: [], date: null },
    { status: 'ready', sessions: [], date: null },
  ]) {
    reset();
    stateSeed = seed;
    assert.strictEqual(GeneratedTodaySection({ today: '2026-08-02' }), null,
      'status ' + seed.status);
  }
});

test('rows deep-link to the day the sessions came from, not to today', () => {
  reset();
  stateSeed = { status: 'ready', sessions: [sess('s-1')], date: '2026-07-31' };

  const out = GeneratedTodaySection({ today: '2026-08-02' });
  const rows = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.props && n.props.date) rows.push(n.props.date);
    (n.children || []).forEach(walk);
  })(out);

  assert.ok(rows.length > 0, 'expected at least one dated row');
  assert.ok(rows.every((d) => d === '2026-07-31'), rows.join(','));
});
