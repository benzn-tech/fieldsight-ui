'use strict';
/* A day report travels on /days/{date}/report…; a meeting report is unchanged.
   Spec 2026-09-15 §5.1, §9 step 5. */
const test = require('node:test');
const assert = require('node:assert');

let calls;

function loadOrg() {
  calls = [];
  global.window = {
    FieldSight: { fixtures: {} },
    FS: {
      api: {
        useMocks: false, orgWrites: true, timelineSource: 'aurora',
        orgBaseUrl: 'https://org.example/prod/api',
        delay: function () { return Promise.resolve(); },
        orgRequest: function (path, opts) {
          calls.push({ path: path, method: opts && opts.method, params: opts && opts.params, body: opts && opts.body });
          return Promise.resolve({ ok: true });
        },
      },
    },
  };
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}

test('a day preview posts to /days/{date}/report/preview with only the user', async () => {
  const org = loadOrg();
  await org.getSessionReportPreview({ scope: 'day', date: '2026-09-10', user: 'James_Lamb' });
  assert.deepStrictEqual(calls, [{ path: '/days/2026-09-10/report/preview', method: 'POST',
    params: { user: 'James_Lamb' }, body: undefined }]);
});

test('a day generate posts to /days/{date}/report and forwards a real selection', async () => {
  const org = loadOrg();
  await org.generateSessionReport({ scope: 'day', date: '2026-09-10', user: 'James_Lamb',
    deliver: 'download', topicRowIds: ['t-1'] });
  assert.equal(calls[0].path, '/days/2026-09-10/report');
  assert.deepStrictEqual(calls[0].params, { user: 'James_Lamb' });
  assert.deepStrictEqual(calls[0].body.topicRowIds, ['t-1']);
});

test('a day status polls /days/{date}/report/status', async () => {
  const org = loadOrg();
  await org.getSessionReportStatus({ scope: 'day', date: '2026-09-10', user: 'James_Lamb', requestId: 'r' });
  assert.deepStrictEqual(calls[0], { path: '/days/2026-09-10/report/status', method: undefined,
    params: { user: 'James_Lamb', requestId: 'r' }, body: undefined });
});

test('a meeting report is unchanged', async () => {
  const org = loadOrg();
  await org.getSessionReportPreview({ sessionId: 'sid1', date: '2026-09-10', user: 'James_Lamb' });
  assert.deepStrictEqual(calls[0], { path: '/sessions/sid1/report/preview', method: 'POST',
    params: { date: '2026-09-10', user: 'James_Lamb' }, body: undefined });
});

test('buildGeneratePayload: a day carries its scope and no session id; a meeting carries no scope', () => {
  global.window = { FieldSight: {} };
  delete require.cache[require.resolve('../scripts/composites/session-report-modal.js')];
  const { buildGeneratePayload } = require('../scripts/composites/session-report-modal.js');
  const day = buildGeneratePayload({ scope: 'day', date: 'd', userFolder: 'u', form: {} });
  assert.equal(day.scope, 'day');
  assert.ok(!('sessionId' in day));
  const meeting = buildGeneratePayload({ session: { session_id: 's' }, date: 'd', userFolder: 'u', form: {} });
  assert.ok(!('scope' in meeting));
  assert.equal(meeting.sessionId, 's');
});

test('a worker with no recording folder is told so, not "unavailable"', () => {
  global.window = { FieldSight: {} };
  delete require.cache[require.resolve('../scripts/composites/session-report-modal.js')];
  const { previewErrorMessage, generateErrorMessage } = require('../scripts/composites/session-report-modal.js');
  assert.match(previewErrorMessage({ _accessDenied: true, error: 'no folder mapping for your account' }),
    /no recording folder/);
  assert.equal(previewErrorMessage({ _notFound: true }), 'Preview is unavailable here.');
  assert.equal(generateErrorMessage({ error: 'topicRowIds: at most 200' }), 'topicRowIds: at most 200');
  assert.equal(generateErrorMessage({}), 'The report did not start.');
});

test('interpretReportStatus: access denied surfaces the server reason, not a generic line', () => {
  global.window = { FieldSight: {} };
  delete require.cache[require.resolve('../scripts/composites/session-report-modal.js')];
  const { interpretReportStatus } = require('../scripts/composites/session-report-modal.js');

  const folderless = interpretReportStatus({ _accessDenied: true, error: 'no folder mapping for your account' });
  assert.equal(folderless.phase, 'error');
  assert.match(folderless.message, /no recording folder/);

  const otherReason = interpretReportStatus({ _accessDenied: true, error: 'not a member of this site' });
  assert.equal(otherReason.phase, 'error');
  assert.equal(otherReason.message, 'not a member of this site');

  const noReason = interpretReportStatus({ _accessDenied: true });
  assert.equal(noReason.phase, 'error');
  assert.equal(noReason.message, 'You don’t have access to this report.');

  const noResponse = interpretReportStatus(null);
  assert.equal(noResponse.phase, 'error');
  assert.equal(noResponse.message, 'You don’t have access to this report.');
});

test('interpretReportStatus: not found reads as a day or a session depending on scope', () => {
  global.window = { FieldSight: {} };
  delete require.cache[require.resolve('../scripts/composites/session-report-modal.js')];
  const { interpretReportStatus } = require('../scripts/composites/session-report-modal.js');

  const day = interpretReportStatus({ _notFound: true }, 'day');
  assert.equal(day.phase, 'error');
  assert.equal(day.message, 'Nothing was found for this day.');

  const meeting = interpretReportStatus({ _notFound: true });
  assert.equal(meeting.phase, 'error');
  assert.equal(meeting.message, 'Session not found.');

  const meetingExplicitScope = interpretReportStatus({ _notFound: true }, 'session');
  assert.equal(meetingExplicitScope.message, 'Session not found.');
});

test('generateReportScope: a meeting, a day, or nothing', () => {
  global.React = { createElement: function () { return {}; }, useState: function (v) { return [v, function () {}]; },
    useEffect: function () {}, useRef: function (v) { return { current: v }; }, Fragment: 'Fragment' };
  global.window = { FS: {}, FieldSight: {}, location: { href: '' } };
  global.document = { addEventListener() {}, removeEventListener() {} };
  delete require.cache[require.resolve('../scripts/pages/timeline.js')];
  const { generateReportScope } = require('../scripts/pages/timeline.js');
  assert.equal(generateReportScope({ session_id: 's' }, 3), 'session');
  assert.equal(generateReportScope(null, 2), 'day');
  assert.equal(generateReportScope(null, 0), null);
});
