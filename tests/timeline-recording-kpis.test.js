'use strict';

/*
 * Unit tests for the timeline KPI strip's recording metrics.
 *
 * Background: "Recordings" and "Words" read `report._report_metadata`, which
 * only the legacy nightly daily-report JSON ever populated. On every live
 * (Aurora/extraction) day both rendered a hard 0 — UCPK2 had 21 recordings in
 * the DB and the tile said 0. org-api now counts them live off the recordings
 * table and emits `recordings_processed` + `duration_seconds`, and the second
 * tile became "Recorded" (a duration) because transcript word counts are not
 * stored anywhere.
 *
 * The regression that matters: the first fix gated on the metadata BLOCK
 * (`_report_metadata != null`), but the live path always emits a block
 * ({source, version}) — so the gate was true and the misleading 0 came back on
 * exactly the days it was meant to fix. The gate must be per-FIELD. That is
 * asserted here against the same dash-vs-value rule the component uses.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
global.React = global.React || {};

const { fmtRecordedTime } = require('../scripts/pages/timeline.js');

/* ---- fmtRecordedTime ----------------------------------------------------- */

test('fmtRecordedTime renders sub-minute durations in seconds', () => {
  assert.strictEqual(fmtRecordedTime(0), '0s');
  assert.strictEqual(fmtRecordedTime(3), '3s');
  assert.strictEqual(fmtRecordedTime(59), '59s');
});

test('fmtRecordedTime renders minutes and seconds, not a clock time', () => {
  // 569s is the real UCPK2 2026-07-31 session; "9:29" would read as a time of day
  assert.strictEqual(fmtRecordedTime(569), '9m 29s');
  assert.strictEqual(fmtRecordedTime(60), '1m 0s');
});

test('fmtRecordedTime collapses to hours and minutes past an hour', () => {
  assert.strictEqual(fmtRecordedTime(3600), '1h');
  assert.strictEqual(fmtRecordedTime(3660), '1h 1m');
  assert.strictEqual(fmtRecordedTime(7845), '2h 10m');
});

test('fmtRecordedTime returns an em dash when the metric is absent', () => {
  assert.strictEqual(fmtRecordedTime(null), '—');
  assert.strictEqual(fmtRecordedTime(undefined), '—');
});

test('fmtRecordedTime shows a real zero for a day with no recorded time', () => {
  // 0 is a fact ("nothing recorded"), not a missing metric — it must not dash
  assert.strictEqual(fmtRecordedTime(0), '0s');
});

test('fmtRecordedTime rounds fractional seconds and floors negatives at zero', () => {
  assert.strictEqual(fmtRecordedTime(12.4), '12s');
  assert.strictEqual(fmtRecordedTime(-5), '0s');
});

/* ---- the per-field gate the Recordings tile applies ---------------------- */

/* Mirrors the component's expression so the block-vs-field regression is
   pinned by a test rather than by a comment. */
function recordingsTileValue(report) {
  const meta = (report && report._report_metadata) || {};
  return meta.recordings_processed != null ? meta.recordings_processed : '—';
}

test('Recordings shows the live count when org-api provides one', () => {
  assert.strictEqual(recordingsTileValue({
    _report_metadata: {
      source: 'live_extraction', version: 'flip-v1',
      recordings_processed: 1, duration_seconds: 569,
    },
  }), 1);
});

test('Recordings shows a real zero for a day that genuinely had none', () => {
  assert.strictEqual(recordingsTileValue({
    _report_metadata: {
      source: 'live_extraction', version: 'flip-v1',
      recordings_processed: 0, duration_seconds: 0,
    },
  }), 0);
});

test('Recordings dashes when the live metadata block carries no count', () => {
  // THE regression: the block exists on every live day, so a block-level check
  // would pass here and render the misleading 0 this fix exists to remove.
  assert.strictEqual(recordingsTileValue({
    _report_metadata: { source: 'live_extraction', version: 'flip-v1' },
  }), '—');
});

test('Recordings dashes when there is no metadata at all', () => {
  assert.strictEqual(recordingsTileValue({}), '—');
  assert.strictEqual(recordingsTileValue(null), '—');
});

test('Recordings still honours the legacy nightly daily-report count', () => {
  assert.strictEqual(recordingsTileValue({
    _report_metadata: { recordings_processed: 12, total_words: 3450 },
  }), 12);
});
