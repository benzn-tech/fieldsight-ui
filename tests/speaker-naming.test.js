'use strict';

/*
 * Unit tests for the speaker-naming rules
 * (spec docs/specs/2026-08-14-speaker-naming-ui.md).
 *
 * These exercise the SAME module the render path uses
 * (composites/transcript-list.js reads window.FS.speakerNaming), so the two
 * cannot independently drift.
 *
 * Three of these pin corrections the spec marks with a warning because each
 * one fails SILENTLY when it is wrong:
 *   - end_sec built from `end - start` analyses the wrong audio and still
 *     returns 202;
 *   - a bare session_id in the URL 400s every time;
 *   - a feature-detect that waits for the read to 403 never fires, because
 *     the read route is not gated.
 */
const test = require('node:test');
const assert = require('node:assert');

const sn = require('../scripts/api/speaker-naming.js');

/* A turn that straddles a batch seam: `start`/`end` are absolute clock
   seconds resolved through the batch map, which re-inserts the silence
   batching removed, so (end - start) is 41.6 s while the real in-file span is
   11.6 s. Using the wrong one sends a window 30 s too long. */
const SEAM_SEGMENT = {
  speaker: 'spk_0',
  text: 'we will close that out on Friday',
  start: 29672.5,
  end: 29714.1,
  duration: 11.6,
  chunk_start: 41.203,
  source_filename:
    'Benl1_2026-04-29_11-49-00_sid0123456789abcdef0123456789abcdef_c0000_srcwav.json',
};

const LEGACY_SEGMENT = {
  speaker: 'spk_1',
  duration: 30,
  chunk_start: 0,
  source_filename: 'Benl1_2026-04-29_08-14-32_off0.5_to612.0_srcwav.json',
};

test('end_sec is chunk_start + duration, never chunk_start + (end - start)', () => {
  const body = sn.correctionBody(SEAM_SEGMENT, { user: 'Benl1', displayName: 'Ben L' });

  assert.strictEqual(body.start_sec, 41.203);
  assert.ok(Math.abs(body.end_sec - 52.803) < 1e-9,
    'end_sec must be chunk_start + duration');

  const wrong = SEAM_SEGMENT.chunk_start + (SEAM_SEGMENT.end - SEAM_SEGMENT.start);
  assert.notStrictEqual(body.end_sec, wrong);
  /* Guard the guard: if the fixture ever stops straddling a seam, the
     assertion above becomes vacuous and this feature loses its only test. */
  assert.ok(wrong - body.end_sec > 1,
    'fixture must keep a seam gap, or the test proves nothing');
});

test('the correction body never asks for consent', () => {
  const body = sn.correctionBody(SEAM_SEGMENT, { user: 'Benl1', displayName: 'Ben L' });
  /* Consent stores a voiceprint — biometric data, and the consent required is
     that of the person whose voice it is. Phase 1 ships no consent UI. */
  assert.strictEqual(body.consent_given, false);
  assert.strictEqual(body.consented_by, null);
  assert.strictEqual(body.display_name, 'Ben L');
  assert.strictEqual(body.user, 'Benl1');
  assert.strictEqual(body.source_filename, SEAM_SEGMENT.source_filename);
});

test('the session reference carries both a date and a sid', () => {
  const ref = sn.sessionRefForSegment(SEAM_SEGMENT);
  assert.ok(/\d{4}-\d{2}-\d{2}/.test(ref), 'POST route requires a date token');
  assert.ok(/sid[0-9a-f]{32}/.test(ref), 'both write routes require a sid token');

  /* The session list's own session_id is a bare sid with NO date — posting it
     is a 400 every time. */
  assert.strictEqual(
    sn.sessionRefForSegment({ source_filename: 'sid0123456789abcdef0123456789abcdef' }),
    null);
  /* Legacy RealPTT filenames have no sid; the backend overlay and both write
     routes decline for them. Declining here is what suppresses the control. */
  assert.strictEqual(sn.sessionRefForSegment(LEGACY_SEGMENT), null);
  assert.strictEqual(sn.sessionRefForSegment(null), null);
});

test('a turn under 3 s is never offered for naming', () => {
  assert.strictEqual(sn.canName(SEAM_SEGMENT), true);
  assert.strictEqual(sn.canName(Object.assign({}, SEAM_SEGMENT, { duration: 2.9 })), false);
  assert.strictEqual(sn.canName(Object.assign({}, SEAM_SEGMENT, { duration: 3 })), true);
  /* Legacy: long enough, but there is no session to write against. */
  assert.strictEqual(sn.canName(LEGACY_SEGMENT), false);
});

test('chunk_start of 0 is a real offset, not a missing one', () => {
  const atZero = Object.assign({}, SEAM_SEGMENT, { chunk_start: 0 });
  assert.strictEqual(sn.canName(atZero), true);
  assert.strictEqual(sn.correctionBody(atZero, { displayName: 'X' }).start_sec, 0);
});

test('feature detection is the presence of the key, not its value', () => {
  assert.strictEqual(sn.featureAvailable({ speaker_segments: [], unmatchedNames: 0 }), true);
  assert.strictEqual(sn.featureAvailable({ speaker_segments: [], unmatchedNames: 3 }), true);
  /* PROD runs SPEAKER_IDENTITY_MODE=off: the read succeeds and simply omits
     the key. Nothing 403s, so absence of the key is the only signal. */
  assert.strictEqual(sn.featureAvailable({ speaker_segments: [] }), false);
  assert.strictEqual(sn.featureAvailable(null), false);
});

test('an asserted name beats a positional guess', () => {
  const named = Object.assign({}, SEAM_SEGMENT, { speaker_name: 'Ben L' });
  assert.strictEqual(sn.displayLabel(named, 'Sam Wright'), 'Ben L');
  assert.strictEqual(sn.displayLabel(SEAM_SEGMENT, 'Sam Wright'), 'Sam Wright');
  assert.strictEqual(sn.displayLabel(SEAM_SEGMENT, null), 'spk_0');
});

test('tentative is never treated as confirmed', () => {
  const tentative = Object.assign({}, SEAM_SEGMENT,
    { speaker_name: 'Ben L', speaker_state: 'tentative' });
  const confirmed = Object.assign({}, SEAM_SEGMENT,
    { speaker_name: 'Ben L', speaker_state: 'confirmed' });

  assert.strictEqual(sn.isTentative(tentative), true);
  assert.strictEqual(sn.isTentative(confirmed), false);
  /* A name with no state at all must not read as a fact either. */
  assert.strictEqual(
    sn.isTentative(Object.assign({}, SEAM_SEGMENT, { speaker_name: 'Ben L' })), true);
  /* An unnamed turn is not "tentative" — it has nothing to be unsure about. */
  assert.strictEqual(sn.isTentative(SEAM_SEGMENT), false);
});

test('only the roles the write routes accept are offered the control', () => {
  ['admin', 'gm', 'pm', 'site_manager', 'platform_admin']
    .forEach((r) => assert.strictEqual(sn.roleMayName(r), true, r));
  ['worker', 'subcontractor', '', null, undefined]
    .forEach((r) => assert.strictEqual(sn.roleMayName(r), false, String(r)));
});

test('a pm is recognised under the name the UI actually holds', () => {
  /* The UI never sees the org role `pm`: session-bridge.js:104 renames it to
     `project_manager` on the way into AuthMock.currentUser, because roles.js
     has no 'pm' slug. Matching only the backend's spelling denied every pm
     account a control the backend would have accepted — silently, since an
     absent caret looks exactly like a feature that is switched off. */
  assert.strictEqual(sn.roleMayName('project_manager'), true);
  /* The remap only touches pm — these reach the UI unchanged, so a second
     spelling for them would be inventing a role nobody sends. */
  ['admin', 'gm', 'site_manager', 'platform_admin']
    .forEach((r) => assert.strictEqual(sn.roleMayName(r), true, r));
  assert.strictEqual(sn.roleMayName('general_manager'), false);
});

test('names already used in the meeting are offered as suggestions', () => {
  const segs = [
    Object.assign({}, SEAM_SEGMENT, { speaker_name: 'Ben L' }),
    Object.assign({}, SEAM_SEGMENT, { speaker_name: 'Ana P' }),
    Object.assign({}, SEAM_SEGMENT, { speaker_name: 'Ben L' }),
    SEAM_SEGMENT,
  ];
  assert.deepStrictEqual(sn.namesInSession(segs), ['Ana P', 'Ben L']);
  assert.deepStrictEqual(sn.namesInSession([]), []);
});
