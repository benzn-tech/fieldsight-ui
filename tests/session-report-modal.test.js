'use strict';

/*
 * Delivery-C review modal (session-report-review-export §5/§11).
 *
 * F1 — scripts/api/org.js: the three session-report client methods. Gated on the
 * SAME predicate as getSessions/compliance (timelineSource==='aurora' &&
 * orgBaseUrl && !useMocks) — session-derived, no legacy report-gateway fallback,
 * only the kill switch. The GENERATE flow is ASYNC (backend enqueues: 202 ->
 * {requestId, resultKey}); the modal polls getSessionReportStatus until
 * done/error. Harness mirrors tests/session-picker.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

let orgCalls, orgResponse;

function loadOrg(overrides) {
  orgCalls = [];
  global.window = {
    FieldSight: { fixtures: {} },
    FS: {
      api: Object.assign({
        useMocks: false,
        timelineSource: 'aurora',
        orgBaseUrl: 'https://org.example/prod/api',
        delay: function () { return Promise.resolve(); },
        orgRequest: function (path, opts) {
          orgCalls.push({
            path: path,
            method: (opts && opts.method) || 'GET',
            params: opts && opts.params,
            body: opts && opts.body,
          });
          return Promise.resolve(orgResponse);
        },
      }, overrides || {}),
    },
  };
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}

const GATED_OFF = [{ timelineSource: 'report' }, { orgBaseUrl: '' }, { useMocks: true }];

/* ---- F1a getSessionReportPreview (POST, read-only preview) --------------- */

test('getSessionReportPreview POSTs /sessions/{id}/report/preview with date+user, no body', async () => {
  const org = loadOrg();
  orgResponse = { sessionId: 'Benl1_2026-07-25_13-00-11', title: 'Morning site inspection', topics: [], fieldDefaults: { title: 'Morning site inspection' } };
  const res = await org.getSessionReportPreview({ sessionId: 'Benl1_2026-07-25_13-00-11', date: '2026-07-25', user: 'Ada_L' });
  assert.deepStrictEqual(orgCalls, [{
    path: '/sessions/Benl1_2026-07-25_13-00-11/report/preview',
    method: 'POST', params: { date: '2026-07-25', user: 'Ada_L' }, body: undefined,
  }]);
  assert.strictEqual(res, orgResponse);
});

test('getSessionReportPreview is gated off (no call, benign empty preview) off-aurora/killswitch/mocks', async () => {
  for (const ov of GATED_OFF) {
    const org = loadOrg(ov);
    const res = await org.getSessionReportPreview({ sessionId: 'S1', date: '2026-07-25', user: 'Ada_L' });
    assert.strictEqual(orgCalls.length, 0);
    assert.deepStrictEqual(res.topics, []);
  }
});

/* ---- F1b generateSessionReport (POST, async enqueue) -------------------- */

test('generateSessionReport POSTs /sessions/{id}/report with the confirmed fields body + date/user params', async () => {
  const org = loadOrg();
  orgResponse = { status: 'queued', requestId: 'req123', resultKey: 'session_report_results/Ada_L/…/req123.json' };
  const res = await org.generateSessionReport({
    sessionId: 'Benl1_2026-07-25_13-00-11', date: '2026-07-25', user: 'Ada_L',
    templateId: 'tpl-1', title: 'Morning site inspection', attendees: ['Ben', 'Neil'],
    fields: { weather: 'Fine', sign_off: 'A. L' }, deliver: 'download', recipients: [],
  });
  assert.strictEqual(orgCalls.length, 1);
  const c = orgCalls[0];
  assert.strictEqual(c.path, '/sessions/Benl1_2026-07-25_13-00-11/report');
  assert.strictEqual(c.method, 'POST');
  assert.deepStrictEqual(c.params, { date: '2026-07-25', user: 'Ada_L' });
  assert.deepStrictEqual(c.body, {
    templateId: 'tpl-1', title: 'Morning site inspection', attendees: ['Ben', 'Neil'],
    fields: { weather: 'Fine', sign_off: 'A. L' }, deliver: 'download', recipients: [],
  });
  assert.strictEqual(res.requestId, 'req123');
});

test('generateSessionReport defaults deliver=download, fields={}, recipients=[] when omitted', async () => {
  const org = loadOrg();
  orgResponse = { status: 'queued', requestId: 'r', resultKey: 'k' };
  await org.generateSessionReport({ sessionId: 'S1', date: '2026-07-25', user: 'Ada_L', title: 'T', attendees: ['A'] });
  assert.deepStrictEqual(orgCalls[0].body, {
    templateId: undefined, title: 'T', attendees: ['A'], fields: {}, deliver: 'download', recipients: [],
  });
});

test('generateSessionReport gated off returns a NON-queued shape (never a fake success), no call', async () => {
  const org = loadOrg({ useMocks: true });
  const res = await org.generateSessionReport({ sessionId: 'S1', date: '2026-07-25', user: 'Ada_L', deliver: 'download' });
  assert.strictEqual(orgCalls.length, 0);
  assert.notStrictEqual(res.status, 'queued');
});

/* ---- F1c getSessionReportStatus (GET, the poll) ------------------------- */

test('getSessionReportStatus GETs /sessions/{id}/report/status with date+user+requestId', async () => {
  const org = loadOrg();
  orgResponse = { status: 'done', docUrl: 'https://signed.example/doc.docx', emailed: false };
  const res = await org.getSessionReportStatus({ sessionId: 'Benl1_2026-07-25_13-00-11', date: '2026-07-25', user: 'Ada_L', requestId: 'req123' });
  assert.deepStrictEqual(orgCalls, [{
    path: '/sessions/Benl1_2026-07-25_13-00-11/report/status',
    method: 'GET', params: { date: '2026-07-25', user: 'Ada_L', requestId: 'req123' }, body: undefined,
  }]);
  assert.strictEqual(res.docUrl, 'https://signed.example/doc.docx');
});

test('getSessionReportStatus gated off returns a benign non-done status, no call', async () => {
  const org = loadOrg({ useMocks: true });
  const res = await org.getSessionReportStatus({ sessionId: 'S1', date: '2026-07-25', user: 'Ada_L', requestId: 'r' });
  assert.strictEqual(orgCalls.length, 0);
  assert.notStrictEqual(res.status, 'done');
});
