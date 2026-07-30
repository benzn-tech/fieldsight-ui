'use strict';
/* Delivery-C Tier-2 review-modal PURE LOGIC (F2 shell + F4/F5 cores). The React
   shell (SessionReportModal) is a thin ModalOverlay wrapper and isn't unit-tested
   in this repo's node harness; the testable logic is factored into pure helpers,
   same split as timeline.js buildSessionEmailDraft. window is stubbed so requiring
   the composite (an IIFE that sets window.FieldSight + module.exports) is safe. */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
if (!global.window.FieldSight) global.window.FieldSight = {};

const { buildGeneratePayload, interpretReportStatus } = require('../scripts/composites/session-report-modal.js');


// ---- buildGeneratePayload (the F1 generateSessionReport body) -----------

test('buildGeneratePayload produces the F1 body and trims the title', () => {
  const p = buildGeneratePayload({
    session: { session_id: 'sid1' }, date: '2026-07-25', userFolder: 'Ada_L',
    form: { templateId: 't1', title: '  Slab pour  ', attendees: ['Neil'], fields: { weather: 'wet' } },
    deliver: 'download',
  });
  assert.deepEqual(p, {
    sessionId: 'sid1', date: '2026-07-25', user: 'Ada_L',
    templateId: 't1', title: 'Slab pour', attendees: ['Neil'],
    fields: { weather: 'wet' }, deliver: 'download', recipients: [],
  });
});

test('buildGeneratePayload: email carries recipients, download drops them', () => {
  const email = buildGeneratePayload({ session: { session_id: 's' }, date: 'd', userFolder: 'u',
    form: {}, deliver: 'email', recipients: ['a@b.com'] });
  assert.equal(email.deliver, 'email');
  assert.deepEqual(email.recipients, ['a@b.com']);

  const dl = buildGeneratePayload({ session: { session_id: 's' }, date: 'd', userFolder: 'u',
    form: {}, deliver: 'download', recipients: ['a@b.com'] });
  assert.equal(dl.deliver, 'download');
  assert.deepEqual(dl.recipients, []);          // recipients only when emailing
});

test('buildGeneratePayload defaults to a safe shape from an empty form', () => {
  const p = buildGeneratePayload({ session: { session_id: 's' }, date: 'd', userFolder: 'u', form: {} });
  assert.equal(p.templateId, null);
  assert.equal(p.title, '');
  assert.deepEqual(p.attendees, []);
  assert.deepEqual(p.fields, {});
  assert.equal(p.deliver, 'download');          // default when unset
  assert.deepEqual(p.recipients, []);
});


// ---- interpretReportStatus (poll response -> UI phase) ------------------

test('interpretReportStatus maps done with docUrl + emailed', () => {
  assert.deepEqual(
    interpretReportStatus({ status: 'done', docUrl: 'http://x/d.docx', emailed: true }),
    { phase: 'done', docUrl: 'http://x/d.docx', emailed: true });
});

test('interpretReportStatus maps error + unavailable to error phase', () => {
  const e = interpretReportStatus({ status: 'error', error: 'boom' });
  assert.equal(e.phase, 'error');
  assert.equal(e.message, 'boom');
  assert.equal(interpretReportStatus({ status: 'unavailable' }).phase, 'error');
});

test('interpretReportStatus treats queued/unknown as pending', () => {
  assert.equal(interpretReportStatus({ status: 'queued', requestId: 'r' }).phase, 'pending');
  assert.equal(interpretReportStatus({ status: 'whatever' }).phase, 'pending');
});

test('interpretReportStatus surfaces access/not-found/empty envelopes as errors', () => {
  assert.equal(interpretReportStatus({ _accessDenied: true }).phase, 'error');
  assert.equal(interpretReportStatus({ _notFound: true }).phase, 'error');
  assert.equal(interpretReportStatus(null).phase, 'error');
});
