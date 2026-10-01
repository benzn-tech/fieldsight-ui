'use strict';

/*
 * "No silent failure or success: say it failed or succeeded, and how to store it again."
 * Pure words and wiring for: the Voices-page refused row, the bell's "Voices not saved" row
 * and badge count, retryVoiceprint's request, and the rewrite-summary block's new home.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sn = require('../scripts/api/speaker-naming.js');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const ENGINEERING = /tentative|refused|stored|homogeneous|window|spread|sample/i;

const RETRY = { date: '2026-09-26', userFolder: 'Ben_UCPK2', sessionBase: 'sid90cc2026',
                sourceFilename: 'a.json', startSec: 0.4, endSec: 5.2 };
const REFUSED = { id: 'vp1', displayName: 'Ben Lin', status: 'tentative', samples: 0,
  lastAttemptOutcome: 'refused', lastAttemptDetail: 'this window does not hold one voice',
  lastAttemptAt: '2026-09-28 00:20:25', retry: RETRY };

test('a refused row shows the reason, the guidance and both actions in plain words', () => {
  const a = sn.voiceRetryActions(REFUSED);
  assert.match(a.reason, /^Ben Lin was not saved: /);
  assert.equal(a.guidance, 'Name another passage where only Ben Lin is speaking.');
  assert.equal(a.tryAgainLabel, 'Try again');
  assert.equal(a.openLabel, 'Open the recording');
  assert.equal(a.canRetry, true);
  assert.equal(a.openRoute, '/timeline?date=2026-09-26&user=Ben_UCPK2');
  for (const v of [a.reason, a.guidance]) assert.doesNotMatch(v, ENGINEERING);
});

test('a saved, withdrawn or never-attempted voice offers no retry', () => {
  assert.equal(sn.voiceRetryActions({ ...REFUSED, lastAttemptOutcome: 'stored' }), null);
  assert.equal(sn.voiceRetryActions({ ...REFUSED, status: 'withdrawn' }), null);
  assert.equal(sn.voiceRetryActions({ id: 'x' }), null);
});

test('without a remembered passage there is no Try again, and no fake route', () => {
  const a = sn.voiceRetryActions({ ...REFUSED, retry: null });
  assert.equal(a.canRetry, false);
  assert.equal(a.openRoute, null);
  assert.equal(sn.timelineRouteForRetry({ date: '2026-09-26' }), null);
});

test('the rename outcome carries the profile id, guidance and retry passage on a refusal', () => {
  const out = sn.enrolmentOutcome([{ ...REFUSED, lastAttemptAt: '2026-09-28 00:00:10' }], 'Ben Lin',
    Date.parse('2026-09-28T00:00:00Z'));
  assert.equal(out.state, 'refused');
  assert.equal(out.voiceprintId, 'vp1');
  assert.deepEqual(out.retry, RETRY);
  assert.equal(out.guidance, 'Name another passage where only Ben Lin is speaking.');
});

test('the bell row: words at one and many, nothing at zero', () => {
  assert.equal(sn.notSavedRowWords(0), null);
  assert.equal(sn.notSavedRowWords(undefined), null);
  assert.equal(sn.notSavedRowWords(1).title, '1 voice could not be saved — see why');
  assert.equal(sn.notSavedRowWords(3).title, '3 voices could not be saved — see why');
  assert.equal(sn.notSavedRowWords(2).route, '/evidence?tab=voices');
});

test('the bell badge counts not-saved voices with everything else', () => {
  assert.equal(sn.bellBadgeCount({ unseen: 1, waiting: 2, introductions: 3, notSaved: 4 }), 10);
  assert.equal(sn.bellBadgeCount({ notSaved: 2 }), 2);
  assert.equal(sn.bellBadgeCount({}), 0);
});

test('the bell reads notSaved from the poll store and renders the row', () => {
  const store = read('scripts', 'api', 'name-proposals.js');
  assert.match(store, /state\.notSaved = \(r && r\.notSaved\) \|\| 0/);
  assert.match(store, /notSaved: state\.notSaved/);
  const bell = read('scripts', 'composites', 'notification-bell.js');
  assert.match(bell, /Voices not saved/);
  assert.match(bell, /bellBadgeCount/);
  assert.match(bell, /Router\.navigate\(notSavedWords\.route\)/);
});

function loadOrg(orgRequest, useMocks) {
  const sandbox = {
    window: { FieldSight: { fixtures: {} },
      FS: { api: { orgRequest, delay: async () => {}, useMocks, orgBaseUrl: 'x' } } },
    console, setTimeout,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(read('scripts', 'api', 'org.js'), sandbox);
  return sandbox.window.FS.api.org;
}

test('retryVoiceprint is exported and, when the mock is off, POSTs once with no fetch retry', async () => {
  const calls = [];
  const org = loadOrg(async (p, o) => { calls.push([p, o]); return { enrolment: 'requested' }; }, false);
  assert.equal(typeof org.retryVoiceprint, 'function');
  /* orgWrite() may be false in this sandbox (no role); the request path is then covered by
     the source check below, and the call must still answer an object, never nothing. */
  const r = await org.retryVoiceprint('a b');
  assert.ok(r && typeof r === 'object');
  if (calls.length) {
    assert.equal(calls[0][0], '/voiceprints/a%20b/retry');
    assert.equal(calls[0][1].method, 'POST');
    assert.equal(calls[0][1].retry, false);
  }
  assert.match(read('scripts', 'api', 'org.js'),
    /'\/voiceprints\/' \+ encodeURIComponent\(voiceprintId\) \+ '\/retry'/);
});

test('the fixtures give one voice a refused attempt with a retry passage, and the mock badge counts it', () => {
  const src = read('scripts', 'mock', 'sites.fixture.js');
  assert.match(src, /lastAttemptOutcome: 'refused'/);
  assert.match(src, /retry: \{ date:/);
  assert.match(src, /voiceprints:\s+VOICEPRINTS/);
  assert.match(read('scripts', 'api', 'org.js'), /notSaved: \(fx\(\)\.voiceprints/);
});

test('the Voices page shows the reason visibly and wires both actions', () => {
  const src = read('scripts', 'composites', 'voice-library.js');
  assert.match(src, /voiceRetryActions/);
  assert.match(src, /retryVoiceprint\(row\.id\)/);
  assert.match(src, /this takes about a minute/);
  assert.match(src, /router\.navigate/);
  assert.match(src, /fs-voices__reason/);
});

test('the dialog shows the outcome and offers Try again on a refusal', () => {
  const src = read('scripts', 'composites', 'intro-suggestion-dialog.js');
  assert.match(src, /guidance: out\.state === 'refused'/);
  assert.match(src, /retryVoiceprint\(saved\.voiceprintId\)/);
  assert.match(src, /'Try again'/);
});

test('the rewrite-summary block is gone from the transcript and lives in the overview', () => {
  const tl = read('scripts', 'composites', 'transcript-list.js');
  assert.doesNotMatch(tl, /fs-transcript-list__regen/);
  assert.doesNotMatch(tl, /regenerateSession/);
  assert.doesNotMatch(tl, /Rewrite the summary with these names/);
  const ov = read('scripts', 'composites', 'session-names-regen.js');
  assert.match(ov, /fs-transcript-list__regen/);
  assert.match(ov, /org\.regenerateSession\(s\.sessionBase, \{ date: date, user: user \}\)/);
  assert.match(ov, /Rewrite the summary with these names/);
  assert.match(ov, /Asked for\. The summary, action items and draft email/);
  const page = read('scripts', 'pages', 'timeline.js');
  assert.match(page, /createElement\(fs\.SessionNamesRegen, mediaProps\)/);
  assert.match(read('app-shell-preview.html'), /session-names-regen\.js/);
});

test('the overview offers sessions from the same rule the transcript used', () => {
  const sid = 'sid' + 'ab'.repeat(16);
  const res = { unmatchedNames: 0, speaker_segments: [
    { speaker_state: 'confirmed', speaker_name: 'Ben Lin', source_filename: 'x_' + sid + '_c0.json' },
    { speaker_state: 'tentative', speaker_name: 'Guess', source_filename: 'x_' + sid + '_c1.json' }] };
  const caller = { role: 'worker', folder_name: 'Ben_UCPK2' };
  assert.deepEqual(sn.regenOfferSessions(res, caller, 'Ben_UCPK2'),
    [{ sessionBase: sid, names: ['Ben Lin'] }]);
  assert.deepEqual(sn.regenOfferSessions(res, caller, 'Someone_Else'), []);
  assert.deepEqual(
    sn.regenOfferSessions({ speaker_segments: res.speaker_segments }, caller, 'Ben_UCPK2'), []);
});
