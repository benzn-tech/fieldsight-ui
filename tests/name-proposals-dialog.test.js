/* The two things in the voices dialog that decide whether it can work at all.

   1. The audio key. If it is built wrong, every "Listen" button answers
      "Audio unavailable", and the person is left judging a VOICE from the
      transcriber's words -- which get names wrong often enough that this is a
      guess. It is also easy to build wrong: the audio must come from
      audio_segments/, never users/.../audio/, because after batching a
      transcript's timeline belongs to the batch file and the original upload it
      looks like it came from is a different recording.

   2. Closing is not deciding. The api refuses any decision that is not
      'confirmed' or 'rejected', so a future "dismiss" wired to the close button
      cannot quietly burn questions that were simply not answered yet. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const { audioKey, fmtDate } =
  require(path.join(__dirname, '..', 'scripts', 'composites', 'name-proposals-dialog.js'));

test('a passage becomes the audio_segments key its transcript shares a stem with', () => {
  assert.equal(
    audioKey({
      userFolder: 'Ben_UCPK2', date: '2026-09-22',
      sourceFilename: 'ben_ucpk2_2026-09-22_15-32-57_sid90cc_c0000_bn2_off0.0_to39.0_srcwav.json',
    }),
    'audio_segments/Ben_UCPK2/2026-09-22/'
      + 'ben_ucpk2_2026-09-22_15-32-57_sid90cc_c0000_bn2_off0.0_to39.0_srcwav.wav');
});

test('the key never points at the original upload under users/', () => {
  const k = audioKey({ userFolder: 'X', date: '2026-09-22', sourceFilename: 'a.json' });
  assert.ok(k.startsWith('audio_segments/'), k);
  assert.ok(!k.includes('/audio/'), 'users/<folder>/audio/ is a different recording after batching');
});

test('a passage missing any part of its address has no key, rather than a wrong one', () => {
  // A wrong key presigns fine and then 403s -- and this bucket answers 403 for
  // absent keys too, so it would read as "no permission", not "no file".
  assert.equal(audioKey({ date: '2026-09-22', sourceFilename: 'a.json' }), null);
  assert.equal(audioKey({ userFolder: 'X', sourceFilename: 'a.json' }), null);
  assert.equal(audioKey({ userFolder: 'X', date: '2026-09-22' }), null);
});

test('dates are read as calendar dates, not as UTC midnight (BUG-19)', () => {
  // new Date('2026-09-22') is UTC midnight and shows as 21 Sep in New Zealand.
  assert.equal(fmtDate('2026-09-22'), '22 Sep');
  assert.equal(fmtDate('2026-01-01'), '1 Jan');
  assert.equal(fmtDate(''), '');
});

/* ---- the api layer refuses anything that is not an answer ---------------- */

function loadOrgApi() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'api', 'org.js'), 'utf8');
  const posted = [];
  const window = {
    FieldSight: { fixtures: { sites: {} } },
    FS: {
      api: {
        delay: async () => {},
        orgRequest: async (url, opts) => { posted.push({ url, opts }); return { ok: true }; },
      },
      env: {},
    },
    FS_ENV: { useMocks: false, orgWrites: true, orgBaseUrl: 'https://x' },
  };
  const ctx = vm.createContext({ window, console, Promise, setTimeout, encodeURIComponent });
  vm.runInContext(src, ctx);
  return { org: window.FS.api.org, posted };
}

test('closing the dialog cannot be sent as a decision', async () => {
  const { org } = loadOrgApi();
  assert.ok(org && org.decideNameProposal, 'decideNameProposal is not exported from org.js');
  for (const bad of ['dismissed', 'pending', '', undefined, 'closed']) {
    await assert.rejects(org.decideNameProposal('p1', bad), undefined,
      `"${bad}" was accepted -- a close wired to it would consume unanswered questions`);
  }
});
