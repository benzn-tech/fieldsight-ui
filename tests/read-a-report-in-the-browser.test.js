'use strict';

/*
 * Until now the only way to read a generated report was to download it — and
 * the download handed over a .docx, which needs Word, or (until today) raw
 * JSON. Neither is a way to glance at yesterday.
 *
 * The hard part is not the modal, it is that daily, weekly and monthly
 * reports DO NOT SHARE A SCHEMA. A viewer written against the daily shape
 * shows a weekly report as a title and nothing else, silently, because every
 * lookup just misses. Both real shapes are exercised here, taken from
 * production:
 *
 *   daily   executive_summary · quality_and_compliance · safety_observations
 *           critical_dates_and_deadlines · topics
 *   weekly  executive_summary · safety_trends · progress_highlights
 *           outstanding_actions · quality_summary · next_week_priorities
 */

const test = require('node:test');
const assert = require('node:assert');

const vm = require('../scripts/api/report-view-model.js');

/* Shapes copied from real reports (2026-09-02 daily, 2026-08-16 weekly). */
const DAILY = {
  report_date: '2026-09-02', report_type: 'daily', user_name: 'Ben_UCPK2',
  device: 'ben', site: 'UC PK',
  recording_session: {
    date: '2026-09-02', site: 'UC PK', worker: 'Ben_UCPK2', role: 'worker',
    recordings: 46, total_duration_display: '82m 28s', total_words: 13433,
    photos: 0, per_recording: [{ filename: 'x', time: '10:55:18' }],
  },
  weather: null,
  executive_summary: ['Reviewed site safety compliance.', 'Scaffold tag replaced.'],
  quality_and_compliance: [
    { item: 'Concrete cylinder testing', status: 'pending',
      details: '7-day and 28-day tests required.', follow_up_needed: true },
  ],
  safety_observations: [
    { observation: 'Scaffold tag missing', risk_level: 'medium',
      location: 'Scaffold structure', who_raised: 'Ben',
      recommended_action: 'Ensure tags are replaced and inspected.' },
  ],
  critical_dates_and_deadlines: [
    { date_mentioned: '2026-09-09', context: 'Flat slab shop drawings due',
      who_mentioned: 'Ben', urgency: 'high', type: 'deadline' },
  ],
  topics: [
    { topic_id: 0, time_range: '10:55 – 11:04',
      topic_title: 'Subcontractor Onboarding & Safety Compliance',
      category: 'safety', participants: ['Ben'],
      summary: 'Discussed onboarding of three new subcontractors.',
      key_decisions: ['Toolbox talks weekly instead of daily.'],
      action_items: [{ action: 'Enter new subbies into the onboarding system' }],
      safety_flags: [{ observation: 'Scaffold tag missing', risk_level: 'medium' }],
      related_photos: [] },
  ],
  _report_metadata: { version: 'x' },
};

const WEEKLY = {
  report_date: '2026-08-16', report_type: 'weekly',
  period: { start: '2026-08-10', end: '2026-08-16' },
  user_name: 'Ben_UCPK2', role: 'worker', site: 'UC PK', site_id: 'uc-pk',
  executive_summary: ['A steady week on the slab.'],
  safety_trends: ['Scaffold tagging improved.'],
  progress_highlights: ['Level 2 formwork complete.'],
  outstanding_actions: ['Chase raven seal delivery.'],
  quality_summary: 'No non-conformances raised this week.',
  next_week_priorities: ['Pour Level 3.'],
  _report_metadata: { version: 'x' },
};

const WEATHER = {
  date: '2026-02-09', temp_max_c: 18.4, temp_min_c: 11.8, weathercode: 51,
  condition_label: 'Light drizzle', windspeed_kmh: 16.2, precip_mm: 0.3,
  source: 'open-meteo',
};

/* ---------- the title ------------------------------------------------- */

test('a daily report is titled by type, site and date', () => {
  assert.strictEqual(vm.reportTitle(DAILY),
    'Daily Site Report: UC PK — 2026-09-02');
});

test('a weekly report shows its period, not its end date pretending to be a day', () => {
  assert.strictEqual(vm.reportTitle(WEEKLY),
    'Weekly Site Report: UC PK — 2026-08-10 → 2026-08-16');
});

/* ---------- both schemas render --------------------------------------- */

test('the daily sections come out in the order the Word document uses', () => {
  const titles = vm.sections(DAILY).map(function (s) { return s.title; });
  assert.deepStrictEqual(titles, [
    'Executive Summary', 'Quality & Compliance', 'Safety Observations',
    'Critical Dates & Deadlines', 'Detailed Timeline',
  ]);
});

test('a weekly report renders its OWN sections, not an empty daily one', () => {
  const titles = vm.sections(WEEKLY).map(function (s) { return s.title; });
  assert.deepStrictEqual(titles, [
    'Executive Summary', 'Progress Highlights', 'Quality Summary',
    'Safety Trends', 'Outstanding Actions', 'Next Week Priorities',
  ], 'a viewer hard-coded to the daily shape shows a weekly report as a '
     + 'title and nothing else, and does it silently');
});

test('a section the generator adds later still appears', () => {
  /* The failure this prevents is the one `weather` already had: a field on
     the wire that no reader ever looked at. */
  const withNew = Object.assign({}, DAILY, { environmental_notes: ['Dust suppression run.'] });
  const titles = vm.sections(withNew).map(function (s) { return s.title; });
  assert.ok(titles.indexOf('Environmental notes') !== -1, titles);
});

test('metadata and identity are not rendered as content', () => {
  const keys = vm.sections(DAILY).map(function (s) { return s.key; });
  ['report_date', 'report_type', 'user_name', 'device', 'site',
   'recording_session', 'weather', '_report_metadata'].forEach(function (k) {
    assert.ok(keys.indexOf(k) === -1, k + ' should be header or handled, not a section');
  });
});

test('an empty section is skipped rather than rendered as a heading with nothing under it', () => {
  const thin = Object.assign({}, DAILY, { safety_observations: [], quality_and_compliance: [] });
  const titles = vm.sections(thin).map(function (s) { return s.title; });
  assert.ok(titles.indexOf('Safety Observations') === -1,
    'an empty "Safety Observations" heading claims nothing was observed, '
    + 'which is not what an absent field says');
});

/* ---------- the header facts ------------------------------------------ */

test('the header carries four facts about the day, not the recording', () => {
  /* It used to carry Recordings / Total audio / Words transcribed as well.
     The report's owner asked for them to go -- "多少分钟。多少个字啊？多少，
     这些都不要了" -- because they describe the microphone, not the day: a
     reader is not helped by learning it took 1,267 files. */
  const facts = vm.headerFacts(DAILY);
  const map = {};
  facts.forEach(function (f) { map[f.label] = f.value; });
  assert.strictEqual(map.Site, 'UC PK');
  assert.ok(map.User, 'who was on site');
  assert.ok(map.Date, 'which day');
  ['Recordings', 'Total audio', 'Words transcribed', 'Photos'].forEach(function (k) {
    assert.ok(!(k in map), k + ' is a fact about the recording, not the day');
  });
});

test('a weekly report has no recording session and still produces a header', () => {
  const facts = vm.headerFacts(WEEKLY);
  assert.ok(facts.length > 0);
  assert.ok(facts.some(function (f) { return f.value === 'UC PK'; }));
});

/* ---------- weather ----------------------------------------------------- */

test('weather reads as one sentence of the numbers as recorded', () => {
  assert.strictEqual(vm.weatherLine(WEATHER),
    'Light drizzle · 11.8–18.4°C · 0.3 mm rain · wind to 16.2 km/h');
});

test('absent weather says why instead of leaving a blank', () => {
  assert.strictEqual(vm.weatherLine(DAILY.weather), null);
  const note = vm.weatherNote(DAILY);
  assert.match(note, /not recorded/i);
  assert.match(note, /coordinate/i,
    'every production report has weather:null, and not because the fetch '
    + 'failed — the generator reads the coordinate from user_mapping.json, '
    + 'where all five sites are null. A reader who is told nothing concludes '
    + 'the weather was unremarkable');
});

test('a report that HAS weather gets no apology', () => {
  assert.strictEqual(vm.weatherNote(Object.assign({}, DAILY, { weather: WEATHER })), null);
});

/* ---------- entries to lines ------------------------------------------- */

test('a plain string entry is its own headline', () => {
  assert.deepStrictEqual(vm.entryLines('Reviewed site safety compliance.'),
    { headline: 'Reviewed site safety compliance.', details: [] });
});

test('an observation leads with the observation and labels the rest', () => {
  const line = vm.entryLines(DAILY.safety_observations[0]);
  assert.strictEqual(line.headline, 'Scaffold tag missing');
  const map = {};
  line.details.forEach(function (d) { map[d.label] = d.value; });
  assert.strictEqual(map['Risk level'], 'medium');
  assert.strictEqual(map['Who raised'], 'Ben');
});

test('a topic leads with its title and folds its nested lists into readable lines', () => {
  const line = vm.entryLines(DAILY.topics[0]);
  assert.strictEqual(line.headline, 'Subcontractor Onboarding & Safety Compliance');
  const map = {};
  line.details.forEach(function (d) { map[d.label] = d.value; });
  assert.strictEqual(map['Key decisions'], 'Toolbox talks weekly instead of daily.');
  assert.strictEqual(map['Action items'], 'Enter new subbies into the onboarding system',
    'a list of objects must not render as [object Object]');
  assert.ok(!('Related photos' in map), 'an empty list is not a line');
  assert.ok(!('Topic id' in map), 'the loop index is not content');
});

test('false is kept — "follow up needed: no" is information', () => {
  const line = vm.entryLines({ item: 'Cylinder testing', follow_up_needed: false });
  const map = {};
  line.details.forEach(function (d) { map[d.label] = d.value; });
  assert.strictEqual(map['Follow up needed'], 'false');
});

test('an entry with no recognised headline still renders something', () => {
  const line = vm.entryLines({ foo: 'bar', baz: 'qux' });
  assert.ok(line.headline.length > 0,
    'otherwise the list shows a bullet with nothing beside it');
});

/* ---------- the hook that took the page down ---------------------------- */

/* The first version of this put the viewer's useState below the "nothing
   selected" early return. React then saw one hook on an empty pane and two
   once a report was picked -- "Rendered more hooks than during the previous
   render" -- and the whole page was replaced by the error boundary. Every
   test above passed: the helpers are pure, and hook ORDER is not something
   they can see. Opening the page is what found it, again. */
test('every hook in ReportsRightDetail is called before any early return', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2
    .readFileSync(path2.join(__dirname, '..', 'scripts', 'pages', 'reports.js'), 'utf8')
    .replace(/\r\n/g, '\n');

  const fn = src.match(/function ReportsRightDetail\(props\) \{[\s\S]*?\n  \}\n/);
  assert.ok(fn, 'ReportsRightDetail has moved or been renamed');

  const body = fn[0];

  /* The first `return` AT ANY INDENTATION. Matching only the four-space one
     finds the component's final return and measures nothing — which is what
     the first version of this test did, and it stayed green with the hook put
     back in the broken place. */
  const firstReturn = body.search(/\n\s*return\s/);
  const hookRe = /React\.use(?:State|Effect|Ref|Memo|Callback|LayoutEffect)\(/g;

  const hooks = [];
  let m;
  while ((m = hookRe.exec(body)) !== null) hooks.push({ at: m.index, text: m[0] });

  assert.ok(firstReturn > 0, 'expected an early return to exist — this test is '
    + 'about hooks sitting after one, so with none it proves nothing');
  assert.ok(hooks.length > 0, 'expected hooks to exist — otherwise likewise');

  const stray = hooks.filter(function (h) { return h.at > firstReturn; });
  assert.deepStrictEqual(stray.map(function (h) { return h.text; }), [],
    'a hook after the first return runs only on some renders, so React sees '
    + 'the count change and throws "Rendered more hooks than during the '
    + 'previous render", replacing the whole page with an error boundary');
});

test('null and odd input do not throw', () => {
  assert.doesNotThrow(function () { vm.entryLines(null); });
  assert.doesNotThrow(function () { vm.sections(null); });
  assert.doesNotThrow(function () { vm.headerFacts(null); });
  assert.doesNotThrow(function () { vm.reportTitle(null); });
  assert.deepStrictEqual(vm.sections('not a report'), []);
});
