'use strict';

/*
 * Unit tests for the durable resolved-state UNION in
 * scripts/api/compliance-aggregator.js — the read half of moving /safety +
 * /quality "mark resolved" off the unauthenticated DynamoDB check-off overlay
 * onto the durable compliance_resolutions table (backend migration 0025).
 *
 * The union (spec §4), as implemented by the exported pure helpers:
 *   buildResolutionIndex(rows) -> { byHash, bySample } keyed on
 *       site_id|report_date|domain|user_folder|content_hash
 *   auroraResolution(...)      -> hash lookup, then content_sample de-risk
 *   deriveResolved(...)        -> Aurora-first, else legacy-overlay fallback
 *
 * Asserts: (1) a row resolved via the new path reads resolved from the Aurora
 * map; (2) a durable reopen (resolved:false) WINS over a stale overlay true;
 * (3) a hash miss falls back to the content_sample de-risk; (4) with no Aurora
 * row the legacy overlay still resolves a historical DynamoDB mark; and the
 * REGRESSION GUARD for the exact bug caught in review — (5) the key is built
 * from row.site_id (the org UUID) and NOT row.site (the display name), so the
 * same text under the display name never matches.
 *
 * The aggregator + content-hash.js + actions.js are browser IIFEs that also
 * export under CommonJS; a minimal window stub wires deriveResolved's runtime
 * deps (window.FS.api.complianceHash + window.FS.api.actions.lookupAction).
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = { FieldSight: { fixtures: { actions: {} } }, FS: { api: {} } };
require('../scripts/api/content-hash.js');   // -> window.FS.api.complianceHash
require('../scripts/api/actions.js');        // -> window.FS.api.actions.lookupAction
const { contentHash, normalize } = require('../scripts/api/content-hash.js');
const { buildResolutionIndex, auroraResolution, deriveResolved } =
  require('../scripts/api/compliance-aggregator.js');

const SITE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SITE_NAME = 'SB1108 Ellesmere College';   // the display name — must NEVER be the key
const DATE = '2026-07-20';
const FOLDER = 'Jarley_Trainor';
const TEXT = 'Loose handrail on level 3';

/* One durable resolution row, shaped like GET /compliance/resolutions items. */
function auroraRow(over) {
  return Object.assign({
    site_id: SITE_UUID, report_date: DATE, domain: 'safety', user_folder: FOLDER,
    content_hash: contentHash(TEXT), content_sample: normalize(TEXT),
    resolved: true, resolved_by: 'Ben_UCPK', resolved_at: '2026-07-26T02:00:00+00:00',
  }, over || {});
}

/* A legacy DynamoDB overlay checked-map (actions.js key shape:
   `<folder>|<topic_id>_<action_index>`). */
function overlay(topicId, actionIndex, entry) {
  var m = {};
  m[FOLDER + '|' + topicId + '_' + actionIndex] = entry;
  return m;
}

const SAFETY_OBS = { site_id: SITE_UUID, date: DATE, domain: 'safety', folder: FOLDER,
                     text: TEXT, topic_id: -1, action_index: 'obs_0' };

/* ---- (1) Aurora-first: a row resolved via the new path reads resolved ----- */

test('deriveResolved reads resolved (and the resolver) from the Aurora map by content_hash', () => {
  const idx = buildResolutionIndex([auroraRow()]);
  const out = deriveResolved(idx, {}, SAFETY_OBS);
  assert.strictEqual(out.resolved, true);
  assert.strictEqual(out.resolved_by, 'Ben_UCPK');
  assert.strictEqual(out.resolved_at, '2026-07-26T02:00:00+00:00');
  assert.strictEqual(out.source, 'aurora');
});

test('buildResolutionIndex keys byHash on site_id|date|domain|folder|hash and indexes the sample', () => {
  const idx = buildResolutionIndex([auroraRow()]);
  const key = SITE_UUID + '|' + DATE + '|safety|' + FOLDER + '|' + contentHash(TEXT);
  assert.ok(idx.byHash[key], 'the composite hash key must be present');
  const base = SITE_UUID + '|' + DATE + '|safety|' + FOLDER;
  assert.ok(idx.bySample[base][normalize(TEXT)], 'content_sample must be indexed for the de-risk path');
});

test('buildResolutionIndex ignores rows with no site_id (never a partial/wrong key)', () => {
  const idx = buildResolutionIndex([auroraRow({ site_id: null })]);
  assert.deepStrictEqual(idx.byHash, {});
  assert.deepStrictEqual(idx.bySample, {});
});

/* ---- (2) a durable reopen (resolved:false) wins over a stale overlay true -- */

test('an Aurora resolved:false WINS over a legacy overlay true (reopen durability)', () => {
  const idx = buildResolutionIndex([auroraRow({ resolved: false, resolved_by: null, resolved_at: null })]);
  const staleOverlay = overlay(-1, 'obs_0', { checked: true, checked_by: 'Old_Marker', checked_at: 'x' });
  const out = deriveResolved(idx, staleOverlay, SAFETY_OBS);
  assert.strictEqual(out.resolved, false, 'once Aurora has spoken, never fall back to the stale overlay');
  assert.strictEqual(out.source, 'aurora');
  assert.strictEqual(out.resolved_by, null);
});

/* ---- (3) content_sample de-risk on a hash miss ---------------------------- */

test('a hash miss falls back to the content_sample match (the server de-risk path)', () => {
  /* content_hash deliberately wrong, but content_sample still equals
     normalize(text) — the row must still resolve. */
  const idx = buildResolutionIndex([auroraRow({ content_hash: 'deadbeefdeadbeef' })]);
  assert.strictEqual(auroraResolution(idx, SITE_UUID, DATE, 'safety', FOLDER, TEXT).resolved, true,
    'the sample index rescues a hash that drifted');
  const out = deriveResolved(idx, {}, SAFETY_OBS);
  assert.strictEqual(out.resolved, true);
  assert.strictEqual(out.source, 'aurora');
});

test('a genuine miss (neither hash nor sample) does NOT resolve from Aurora', () => {
  const idx = buildResolutionIndex([auroraRow({ content_hash: 'deadbeef', content_sample: 'something else entirely' })]);
  assert.strictEqual(auroraResolution(idx, SITE_UUID, DATE, 'safety', FOLDER, TEXT), null);
  const out = deriveResolved(idx, {}, SAFETY_OBS);
  assert.strictEqual(out.resolved, false);
  assert.strictEqual(out.source, 'none');
});

/* ---- (4) overlay fallback still resolves a historical DynamoDB mark -------- */

test('with NO Aurora row, the legacy overlay still resolves a historical mark', () => {
  const emptyIdx = buildResolutionIndex([]);
  const legacy = overlay(-1, 'obs_0', { checked: true, checked_by: 'David_Barillaro', checked_at: '2026-06-01T00:00:00Z' });
  const out = deriveResolved(emptyIdx, legacy, SAFETY_OBS);
  assert.strictEqual(out.resolved, true);
  assert.strictEqual(out.resolved_by, 'David_Barillaro');
  assert.strictEqual(out.resolved_at, '2026-06-01T00:00:00Z');
  assert.strictEqual(out.source, 'overlay', 'no Aurora row -> read the legacy checked map');
});

test('with neither Aurora nor overlay, the row is simply unresolved', () => {
  const out = deriveResolved(buildResolutionIndex([]), {}, SAFETY_OBS);
  assert.strictEqual(out.resolved, false);
  assert.strictEqual(out.resolved_by, null);
  assert.strictEqual(out.source, 'none');
});

/* ---- (5) REGRESSION GUARD: the key is site_id (UUID), never site (name) ---- */

test('the resolution key is built from row.site_id (UUID), NOT row.site (display name)', () => {
  const idx = buildResolutionIndex([auroraRow()]);   // keyed on the UUID

  /* Correct UUID -> resolves. */
  const hit = deriveResolved(idx, {}, SAFETY_OBS);
  assert.strictEqual(hit.resolved, true, 'the org UUID is the real key');

  /* Same date/domain/folder/text but the DISPLAY NAME in the site slot ->
     must NOT match the UUID-keyed map (the exact orphaning bug this migration
     was blocked on). Falls through to the (empty) overlay: unresolved. */
  const wrong = deriveResolved(idx, {}, Object.assign({}, SAFETY_OBS, { site_id: SITE_NAME }));
  assert.strictEqual(wrong.resolved, false,
    'keying on the display name must never hit the site_id-keyed resolution');
  assert.strictEqual(wrong.source, 'none');
});

/* ---- quality parity: the same union, domain 'quality', keyed on the title -- */

test('a quality topic resolves from the Aurora map keyed on domain quality + the title text', () => {
  const TITLE = 'Concrete pour delayed; formwork not signed off.';
  const idx = buildResolutionIndex([auroraRow({
    domain: 'quality', content_hash: contentHash(TITLE), content_sample: normalize(TITLE),
    resolved: true, resolved_by: 'QA_Lead',
  })]);
  const out = deriveResolved(idx, {}, { site_id: SITE_UUID, date: DATE, domain: 'quality',
                                        folder: FOLDER, text: TITLE, topic_id: 3, action_index: 'quality' });
  assert.strictEqual(out.resolved, true);
  assert.strictEqual(out.resolved_by, 'QA_Lead');
  /* A safety-domain lookup of the same title must NOT cross domains. */
  const cross = deriveResolved(idx, {}, { site_id: SITE_UUID, date: DATE, domain: 'safety',
                                          folder: FOLDER, text: TITLE, topic_id: 3, action_index: 'flag_0' });
  assert.strictEqual(cross.resolved, false, 'domain is part of the key — safety must not read a quality mark');
});
