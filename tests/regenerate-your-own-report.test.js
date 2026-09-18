'use strict';

/*
 * Regenerate acts on YOUR OWN report, and the page follows it to completion.
 *
 * On 2026-09-14 one click on one person's 3 Sep report, in the dev UI, rewrote four
 * prod reports across two days and two people. The button called the legacy
 * gateway, whose user filter was never read by the generator, and every call also
 * ran a seven-day backfill. Then it showed "Report triggered" and nothing else:
 * Generated and Size never changed until a manual reload.
 *
 * Owner rule (2026-09-15): each person regenerates only their own reports; no
 * role may regenerate another person's; nobody regenerates a summary by hand.
 * The backend now enforces it: POST /api/org/reports/regenerate takes the folder
 * from the caller's identity, and the legacy route answers 410.
 *
 * The page's half:
 *
 *   WHO SEES THE BUTTON. Only on a daily, weekly or monthly report in the caller's
 *   own folder. Not on a summary, site or combined report, and not on a worker's
 *   report that a manager is reading. This is cosmetic -- the server ignores any
 *   folder a client could send -- but it also picks which row the page waits on,
 *   so a wrong match would wait on someone else's report forever.
 *
 *   WHAT IT SENDS. {report_type, date} to the org route, once (retry: false: a
 *   lost 202 must not become two generations). Never a folder, never the legacy
 *   gateway.
 *
 *   WHEN IT IS DONE. When the report's generated_at moves past the value captured
 *   at click time -- the object actually being rewritten -- never on the 202.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'reports.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function lift(names) {
  const parts = names.map(function (n) {
    const m = PAGE.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n  \\}'));
    assert.ok(m, n + ' has moved or been renamed');
    return m[0];
  });
  // eslint-disable-next-line no-new-func
  return new Function(parts.join('\n') + '\nreturn {' + names.join(',') + '};')();
}

const { reportFolder, canRegenerateReport, defaultPeriodEnd, regenerationFinished, regenerateErrorMessage } =
  lift(['reportFolder', 'canRegenerateReport', 'defaultPeriodEnd', 'regenerationFinished', 'regenerateErrorMessage']);

const ME = { folder_name: 'Ben_UCPK2' };
const row = (key, type) => ({ key, type: type || 'daily', date: '2026-09-03', generated_at: '2026-09-11T03:26:49+00:00' });

/* ---- whose report is this --------------------------------------------------- */

test('a per-person report key names its folder', () => {
  assert.strictEqual(reportFolder('reports/2026-09-03/Ben_UCPK2/daily_report.json'), 'Ben_UCPK2');
  assert.strictEqual(reportFolder('reports/2026-09-06/Ben_UCPK2/weekly_report.json'), 'Ben_UCPK2');
  assert.strictEqual(reportFolder('reports/2026-09-30/Ben_UCPK2/monthly_report.json'), 'Ben_UCPK2');
});

test('summary, site and combined reports belong to nobody', () => {
  for (const k of [
    'reports/2026-09-03/summary_report.json',
    'reports/2026-09-06/weekly_report.json',
    'reports/2026-09-06/sites/site-1/weekly_report.json',
    'reports/2026-09-03/Ben_UCPK2/meeting_minutes.json',
    '', null, undefined,
  ]) {
    assert.strictEqual(reportFolder(k), null, String(k));
  }
});

/* ---- who sees the button ---------------------------------------------------------- */

test('THE test: only your own daily, weekly or monthly report offers Regenerate', () => {
  assert.strictEqual(canRegenerateReport(ME, row('reports/2026-09-03/Ben_UCPK2/daily_report.json')), true);
  assert.strictEqual(canRegenerateReport(ME, row('reports/2026-09-06/Ben_UCPK2/weekly_report.json', 'weekly')), true);
});

test("a manager reading a worker's report is not offered Regenerate", () => {
  assert.strictEqual(canRegenerateReport(ME, row('reports/2026-09-03/Neil_Blunden/daily_report.json')), false);
});

test('a summary is never offered Regenerate, to anyone', () => {
  assert.strictEqual(canRegenerateReport(ME, row('reports/2026-09-03/summary_report.json', 'daily')), false);
});

test('an account with no folder is offered nothing', () => {
  assert.strictEqual(canRegenerateReport({}, row('reports/2026-09-03/Ben_UCPK2/daily_report.json')), false);
  assert.strictEqual(canRegenerateReport({ folder_name: '' }, row('reports/2026-09-03/Ben_UCPK2/daily_report.json')), false);
});

/* ---- the archive-level buttons pick your own latest period ---------------------------- */

test('daily defaults to yesterday', () => {
  assert.strictEqual(defaultPeriodEnd('daily', new Date(2026, 8, 15, 10)), '2026-09-14');
  assert.strictEqual(defaultPeriodEnd('daily', new Date(2026, 9, 1, 10)), '2026-09-30');
});

test('weekly defaults to the Sunday that ended the last completed week', () => {
  assert.strictEqual(defaultPeriodEnd('weekly', new Date(2026, 8, 15, 10)), '2026-09-13'); // Tue -> Sun 13
  assert.strictEqual(defaultPeriodEnd('weekly', new Date(2026, 8, 13, 10)), '2026-09-06'); // Sun -> previous Sun
});

test('monthly defaults to the last day of the previous month', () => {
  assert.strictEqual(defaultPeriodEnd('monthly', new Date(2026, 8, 15, 10)), '2026-08-31');
  assert.strictEqual(defaultPeriodEnd('monthly', new Date(2026, 2, 1, 10)), '2026-02-28');
});

/* ---- when it is done ------------------------------------------------------------------ */

test('done only when the report was actually rewritten after the click', () => {
  const before = '2026-09-11T03:26:49+00:00';
  assert.strictEqual(regenerationFinished(before, { generated_at: before }), false);
  assert.strictEqual(regenerationFinished(before, { generated_at: '2026-09-15T01:02:03+00:00' }), true);
  assert.strictEqual(regenerationFinished(before, null), false, 'a row that vanished is not success');
  assert.strictEqual(regenerationFinished(before, {}), false);
});

test('the refusals the server gives are shown, not swallowed', () => {
  assert.match(regenerateErrorMessage({ _accessDenied: true, error: 'your account has no recording folder' }), /folder/);
  assert.match(regenerateErrorMessage({ _notFound: true }), /no recordings/i);
  assert.strictEqual(regenerateErrorMessage({ status: 'queued', requestId: 'r' }), null);
});

/* ---- the wiring --------------------------------------------------------------------------- */

test('the detail panel gates on ownership, not on a role permission', () => {
  const right = PAGE.match(/function ReportsRightDetail\(props\) \{[\s\S]*?\n  \}/)[0];
  assert.match(right, /canRegenerateReport\(caller, sel\)/);
  assert.doesNotMatch(right, /P\('report',\s*'create'\)/);
});

test('the list refreshes when a regenerate finishes', () => {
  const middle = PAGE.match(/function ReportsMiddleColumn\(props\) \{[\s\S]*?\n  \}/)[0];
  assert.match(middle, /fs:reports-refresh/);
});

/* ---- the API client ----------------------------------------------------------------------- */

function loadReports(overrides) {
  const calls = { org: [], legacy: [] };
  global.window = {
    FieldSight: { fixtures: {} },
    FS: {
      api: Object.assign({
        useMocks: false,
        timelineSource: 'aurora',
        orgBaseUrl: 'https://org.example/prod/api',
        delay: function () { return Promise.resolve(); },
        orgRequest: function (p, opts) { calls.org.push({ path: p, opts }); return Promise.resolve({ status: 'queued', requestId: 'r1' }); },
        request: function (p, opts) { calls.legacy.push({ path: p, opts }); return Promise.resolve({}); },
      }, overrides || {}),
    },
  };
  delete require.cache[require.resolve('../scripts/api/reports.js')];
  require('../scripts/api/reports.js');
  return { api: global.window.FS.api.reports, calls };
}

test('regenerate posts only the type and date to the org route, once', async () => {
  const { api, calls } = loadReports();
  await api.regenerate({ report_type: 'daily', date: '2026-09-03', force: true, user: 'Neil_Blunden' });
  assert.deepStrictEqual(calls.legacy, [], 'the legacy gateway route is closed and must not be called');
  assert.strictEqual(calls.org.length, 1);
  assert.strictEqual(calls.org[0].path, '/reports/regenerate');
  assert.strictEqual(calls.org[0].opts.method, 'POST');
  assert.deepStrictEqual(calls.org[0].opts.body, { report_type: 'daily', date: '2026-09-03' });
  assert.strictEqual(calls.org[0].opts.retry, false);
});

test('off the org API, regenerate calls nothing and says why', async () => {
  const { api, calls } = loadReports({ timelineSource: 'report' });
  const res = await api.regenerate({ report_type: 'daily', date: '2026-09-03' });
  assert.deepStrictEqual(calls, { org: [], legacy: [] });
  assert.notStrictEqual(res.status, 'queued');
});
