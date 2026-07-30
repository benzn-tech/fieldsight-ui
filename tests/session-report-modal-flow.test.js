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

const { buildGeneratePayload, interpretReportStatus, previewFieldDefaults, parseAttendees, canGenerate } = require('../scripts/composites/session-report-modal.js');


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


// ---- previewFieldDefaults (seed the editable fields from the preview) ----

test('previewFieldDefaults pulls title + attendees from fieldDefaults', () => {
  assert.deepEqual(
    previewFieldDefaults({ fieldDefaults: { title: 'Slab pour', attendees: ['Neil', 'Ada'] } }),
    { title: 'Slab pour', attendees: ['Neil', 'Ada'] });
});

test('previewFieldDefaults falls back to top-level title/participants', () => {
  const d = previewFieldDefaults({ title: 'T', participants: ['P'] });
  assert.equal(d.title, 'T');
  assert.deepEqual(d.attendees, ['P']);
});

test('previewFieldDefaults is safe on empty/null', () => {
  assert.deepEqual(previewFieldDefaults(null), { title: '', attendees: [] });
  assert.deepEqual(previewFieldDefaults({}), { title: '', attendees: [] });
});


// ---- parseAttendees (fill-step textarea -> attendees array) --------------

test('parseAttendees splits on newlines and commas, trims, drops empties', () => {
  assert.deepEqual(parseAttendees('Neil\nAda Lovelace\n\n , Bob '), ['Neil', 'Ada Lovelace', 'Bob']);
});

test('parseAttendees is safe on blank/null', () => {
  assert.deepEqual(parseAttendees('   '), []);
  assert.deepEqual(parseAttendees(null), []);
  assert.deepEqual(parseAttendees(''), []);
});


// ---- canGenerate (gate: email delivery needs recipients) ----------------

test('canGenerate: download always ok; email needs at least one recipient', () => {
  assert.equal(canGenerate('download', []), true);
  assert.equal(canGenerate('download', ['a@b.com']), true);
  assert.equal(canGenerate('email', []), false);
  assert.equal(canGenerate('email', ['a@b.com']), true);
});
