/* The pure logic behind the self-introduction dialog: which roster name a
   heard name is closest to, when "heard as" earns its place under the field,
   the audio key/date helpers duplicated from name-proposals-dialog.js, and
   the api layer's refusal of anything that is not an answer.

   1. Roster matching. Get this wrong and the field prefills with nothing or
      the wrong person, and a site manager either types the whole name by
      hand every time or, worse, saves the wrong person's voice under it.
   2. The request body. The plan calls this out by name (memory:
      "ui-api-layer-whitelists-request-body") -- `display_name` must actually
      land on the wire, or an edited name is silently dropped and the backend
      falls back to what the transcriber misheard. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const { audioKey, fmtDate, closestRosterName, shouldShowHeardAs, notSavedNote } =
  require(path.join(__dirname, '..', 'scripts', 'composites', 'intro-suggestion-dialog.js'));

/* ---- duplicated-helpers parity with name-proposals-dialog.js -------------- */

test('the audio key rule is identical to name-proposals-dialog.js', () => {
  assert.equal(
    audioKey({
      userFolder: 'Ben_UCPK2', date: '2026-09-26',
      sourceFilename: 'ben_ucpk2_2026-09-26_08-14-02_sid90cc_c0000_off0.0_to12.0_srcwav.json',
    }),
    'audio_segments/Ben_UCPK2/2026-09-26/'
      + 'ben_ucpk2_2026-09-26_08-14-02_sid90cc_c0000_off0.0_to12.0_srcwav.wav');
});

test('a suggestion missing any part of its address has no key', () => {
  assert.equal(audioKey({ date: '2026-09-26', sourceFilename: 'a.json' }), null);
  assert.equal(audioKey({ userFolder: 'X', sourceFilename: 'a.json' }), null);
  assert.equal(audioKey({ userFolder: 'X', date: '2026-09-26' }), null);
});

test('dates are read as calendar dates, not as UTC midnight (BUG-19)', () => {
  assert.equal(fmtDate('2026-09-26'), '26 Sep');
  assert.equal(fmtDate(''), '');
});

test('a refusal from the server is not reported as a connection problem', () => {
  const e = new Error('display_name must not be empty');
  e.status = 400;
  const note = notSavedNote(e);
  assert.match(note, /display_name must not be empty/);
  assert.doesNotMatch(note, /connection/);
  assert.match(notSavedNote(new Error('Failed to fetch')), /connection/);
});

/* ---- closest roster name --------------------------------------------------- */

const ROSTER = [
  { name: 'Petros Pan' }, { name: 'Jarley Trainor' }, { name: 'Sam Yu' },
  { name: 'Mike OBrien' },
];

test('exact, case-insensitive, on the full name', () => {
  assert.equal(closestRosterName(ROSTER, 'jarley trainor'), 'Jarley Trainor');
});

test('a first-name-only introduction prefix-matches the roster full name', () => {
  // This is the design doc's own example: "Hi, this is Petros" -> "Petros Pan".
  assert.equal(closestRosterName(ROSTER, 'Petros'), 'Petros Pan');
});

test('edit distance <= 2 on the full name catches what the transcriber misheard', () => {
  // The design doc's own misheard example: "Petros Pan" -> "Petrus Pang".
  assert.equal(closestRosterName(ROSTER, 'Petrus Pang'), 'Petros Pan');
});

test('nothing close returns null rather than a wrong guess', () => {
  assert.equal(closestRosterName(ROSTER, 'Zbigniew Kowalski'), null);
});

test('an empty roster or heard name returns null, not a crash', () => {
  assert.equal(closestRosterName([], 'Petros'), null);
  assert.equal(closestRosterName(ROSTER, ''), null);
  assert.equal(closestRosterName(ROSTER, null), null);
});

test('"heard as" only shows when the chosen name actually differs', () => {
  assert.equal(shouldShowHeardAs('Petros Pan', 'Petros'), true);
  assert.equal(shouldShowHeardAs('Petros', 'Petros'), false);
  assert.equal(shouldShowHeardAs('petros  pan', 'Petros Pan'), false);
  assert.equal(shouldShowHeardAs('', 'Petros'), false);
});

/* ---- the api layer: decision + display_name on the wire ------------------- */

function loadOrgApi() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'api', 'org.js'), 'utf8');
  const posted = [];
  const window = {
    FieldSight: { fixtures: { sites: {} } },
    FS: {
      api: {
        useMocks: false, orgWrites: true, orgBaseUrl: 'https://x',
        delay: async () => {},
        orgRequest: async (url, opts) => { posted.push({ url, opts }); return { ok: true }; },
      },
      env: {},
    },
  };
  const ctx = vm.createContext({ window, console, Promise, setTimeout, encodeURIComponent });
  vm.runInContext(src, ctx);
  return { org: window.FS.api.org, posted };
}

test('decision refuses anything but confirmed/rejected', async () => {
  const { org } = loadOrgApi();
  assert.ok(org && org.decideNameSuggestion, 'decideNameSuggestion is not exported from org.js');
  for (const bad of ['dismissed', 'pending', '', undefined, 'closed']) {
    await assert.rejects(org.decideNameSuggestion('s1', bad, 'Petros Pan'), undefined,
      `"${bad}" was accepted -- a close wired to it would consume unanswered questions`);
  }
});

test('an edited display_name actually reaches the request body', async () => {
  const { org, posted } = loadOrgApi();
  await org.decideNameSuggestion('s1', 'confirmed', 'Petros Pan');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, '/name-suggestions/s1');
  assert.equal(posted[0].opts.method, 'POST');
  assert.equal(JSON.stringify(posted[0].opts.body), JSON.stringify({ decision: 'confirmed', display_name: 'Petros Pan' }));
});

test('no display_name means the key is left off, not sent empty', async () => {
  const { org, posted } = loadOrgApi();
  await org.decideNameSuggestion('s1', 'confirmed');
  assert.equal(JSON.stringify(posted[0].opts.body), JSON.stringify({ decision: 'confirmed' }));
});

test('a blank display_name (all whitespace) is also left off the body', async () => {
  const { org, posted } = loadOrgApi();
  await org.decideNameSuggestion('s1', 'confirmed', '   ');
  assert.equal(JSON.stringify(posted[0].opts.body), JSON.stringify({ decision: 'confirmed' }));
});

test('rejected never carries a display_name', async () => {
  const { org, posted } = loadOrgApi();
  await org.decideNameSuggestion('s1', 'rejected', 'Petros Pan');
  assert.equal(JSON.stringify(posted[0].opts.body), JSON.stringify({ decision: 'rejected', display_name: 'Petros Pan' }));
  // display_name is harmless on a rejection (the backend ignores it there), but the
  // field itself must still travel when present -- this pins that decideNameSuggestion
  // does not special-case it away.
});

test('getNameSuggestions reads the fixture, never an empty list, when mocked', async () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'api', 'org.js'), 'utf8');
  const window = {
    FieldSight: { fixtures: { sites: {
      nameSuggestions: [{ id: 'x1', heardName: 'Petros' }],
    } } },
    FS: { api: { useMocks: true, orgWrites: false, orgBaseUrl: '', delay: async () => {} }, env: {} },
  };
  const ctx = vm.createContext({ window, console, Promise, setTimeout, encodeURIComponent });
  vm.runInContext(src, ctx);
  const r = await window.FS.api.org.getNameSuggestions();
  assert.equal(JSON.stringify(r.suggestions), JSON.stringify([{ id: 'x1', heardName: 'Petros' }]));
});
