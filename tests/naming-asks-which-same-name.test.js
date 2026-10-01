'use strict';

/*
 * Naming asks "which Ben Lin is this?" instead of silently making another one.
 * Spec: fieldsight-pipeline docs/superpowers/specs/2026-10-01-naming-asks-which-same-name-person.md
 *
 * Covers the pure helpers (speaker-naming.js), the check and the correction through the REAL
 * _fetch.js (a layer that rebuilt the body would drop voiceprint_id / new_person), the offline
 * rule (the read stub answers "don't ask" and must not block naming), and the wiring.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sn = require('../scripts/api/speaker-naming.js');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const P1 = { id: 'p1', displayName: 'Ben Lin', linkedAccount: null, heardOn: ['Ben_UCPK2'],
  firstNamed: { at: '2026-08-28T01:00:00+00:00', by: 'Ben_UCPK2' }, employer: null,
  lastHeard: '2026-09-30T05:00:00+00:00' };
/* 23:50 UTC on 30 Sep is the morning of 1 Oct in Auckland. */
const P2 = { id: 'p2', displayName: 'Ben Lin', linkedAccount: { name: 'Ben Lin', email: 'ben@x.com' },
  heardOn: ['Ben_Lin_test2'], firstNamed: { at: '2026-09-30', by: 'Ben_Lin_test2' }, employer: 'Acme',
  lastHeard: '2026-09-30T23:50:02+00:00' };
const ASK = { profiles: [P1, P2], wouldUse: null, ask: true };

const SEG = { source_filename: 'Ben_2026-10-01_09-00-00_sid' + 'a'.repeat(32) + '_c0001.wav',
  chunk_start: 10, duration: 5 };

/* ---- deciding whether to ask ------------------------------------------- */

test('ask only when the backend says ask and there is something to choose between', () => {
  assert.equal(sn.sameNameShouldAsk(ASK), true);
  assert.equal(sn.sameNameShouldAsk({ profiles: [P1], wouldUse: 'p1', ask: false }), false);
  assert.equal(sn.sameNameShouldAsk({ profiles: [], wouldUse: null, ask: false }), false);
  assert.equal(sn.sameNameShouldAsk({ profiles: [], ask: true }), false);
  assert.equal(sn.sameNameShouldAsk({ profiles: [P1] }), false);
  assert.equal(sn.sameNameShouldAsk({ profiles: [P1], ask: 'true' }), false);
  assert.equal(sn.sameNameShouldAsk(null), false);
  assert.equal(sn.sameNameShouldAsk(undefined), false);
});

/* ---- option rows ------------------------------------------------------- */

test('an option is the identity line plus "last heard" as the NZ calendar day', () => {
  const [a, b] = sn.sameNameOptions(ASK);
  assert.equal(a.id, 'p1');
  assert.equal(a.detail,
    'Not linked to an account · Heard on Ben_UCPK2 · Named 28 Aug by Ben_UCPK2 · last heard 30 Sep');
  assert.equal(b.id, 'p2');
  assert.equal(b.detail,
    'Linked to ben@x.com · Heard on Ben_Lin_test2 · Named 30 Sep by Ben_Lin_test2 · Acme · last heard 1 Oct');
  assert.equal(b.lastHeard, 'last heard 1 Oct');
});

test('options are plain words: no score, no "undefined", and a bare row still reads', () => {
  const rows = sn.sameNameOptions({ profiles: [P1, P2, { id: 'bare', displayName: 'Ben Lin' }, null, {}] });
  assert.equal(rows.length, 3);
  assert.equal(rows[2].detail, 'No details recorded yet');
  for (const r of rows) assert.doesNotMatch(r.detail, /\d\.\d|score|similar|undefined|null/i);
  assert.deepEqual(sn.sameNameOptions(null), []);
});

test('title and "someone else" wording', () => {
  assert.equal(sn.sameNameTitle(' Ben Lin '), 'Which Ben Lin is this?');
  assert.equal(sn.sameNameElseLabel('Ben Lin'), 'Someone else called Ben Lin');
  assert.equal(sn.sameNameElseDefault('Ben Lin'), 'Ben Lin ()');
});

/* ---- "someone else" ---------------------------------------------------- */

test('someone else: unchanged (or only the empty brackets left) is a new person', () => {
  for (const typed of ['Ben Lin ()', 'Ben Lin', '  ben   lin ()  ', 'Ben Lin (  )']) {
    assert.deepEqual(sn.sameNameElseOutcome('Ben Lin', typed),
      { action: 'send', name: 'Ben Lin', newPerson: true }, typed);
  }
});

test('someone else: a changed name is checked again, not sent', () => {
  assert.deepEqual(sn.sameNameElseOutcome('Ben Lin', 'Ben Lin (Cassidy)'),
    { action: 'recheck', name: 'Ben Lin (Cassidy)' });
  assert.deepEqual(sn.sameNameElseOutcome('Ben Lin', 'Benjamin Lin'),
    { action: 'recheck', name: 'Benjamin Lin' });
});

test('someone else: an empty or over-long name does nothing', () => {
  assert.equal(sn.sameNameElseOutcome('Ben Lin', '   ').action, 'invalid');
  assert.equal(sn.sameNameElseOutcome('Ben Lin', '()').action, 'invalid');
  assert.equal(sn.sameNameElseOutcome('Ben Lin', 'x'.repeat(81)).action, 'invalid');
});

/* ---- the correction body ----------------------------------------------- */

test('no choice: the body is exactly what it always was', () => {
  const opts = { user: 'Ben_UCPK2', displayName: 'Ben Lin' };
  const plain = sn.correctionBody(SEG, opts);
  assert.deepEqual(sn.correctionBodyForChoice(SEG, opts, null), plain);
  assert.deepEqual(sn.correctionBodyForChoice(SEG, opts, undefined), plain);
  assert.equal('voiceprint_id' in plain, false);
  assert.equal('new_person' in plain, false);
});

test('a chosen profile adds voiceprint_id only; someone else adds new_person only', () => {
  const opts = { user: 'Ben_UCPK2', displayName: 'Ben Lin' };
  const a = sn.correctionBodyForChoice(SEG, opts, { voiceprintId: 'p2' });
  assert.equal(a.voiceprint_id, 'p2');
  assert.equal('new_person' in a, false);
  assert.equal(a.display_name, 'Ben Lin');
  const b = sn.correctionBodyForChoice(SEG, opts, { newPerson: true });
  assert.equal(b.new_person, true);
  assert.equal('voiceprint_id' in b, false);
  /* Mutually exclusive on the backend: a muddled choice can never send both. */
  const both = sn.sameNameChoiceFields({ voiceprintId: 'p2', newPerson: true });
  assert.deepEqual(both, { voiceprint_id: 'p2' });
  assert.deepEqual(sn.sameNameChoiceFields({ newPerson: false }), {});
});

/* ---- API: through the real _fetch.js ----------------------------------- */

function loadApi(opts) {
  const calls = [];
  const sandbox = {
    console, setTimeout, clearTimeout, URL, URLSearchParams, AbortController, FormData,
    Date, Promise, JSON, encodeURIComponent,
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body });
      if (opts.fail) throw new TypeError('network down');
      return { status: opts.status || 200, ok: (opts.status || 200) < 300,
        headers: { get: () => 'application/json' },
        json: async () => (opts.reply || {}) };
    },
    window: { FieldSight: { fixtures: { sites: { voiceprints: [] } } } },
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.FS = { api: { useMocks: !!opts.useMocks, orgBaseUrl: 'https://gw.test/prod/api',
    orgWrites: opts.orgWrites !== false, delay: async () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(read('scripts', 'api', '_fetch.js'), sandbox);
  vm.runInContext(read('scripts', 'api', 'org.js'), sandbox);
  sandbox.window.FS.api.orgBaseUrl = 'https://gw.test/prod/api';
  return { org: sandbox.window.FS.api.org, calls, api: sandbox.window.FS.api };
}

test('same-name is a GET carrying name and user in the query string', async () => {
  const { org, calls } = loadApi({ reply: ASK });
  const r = await org.sameNameVoices('Ben Lin', 'Ben_UCPK2');
  assert.equal(r.ask, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/org\/voiceprints\/same-name\?name=Ben%20Lin&user=Ben_UCPK2$/);
});

test('same-name with no user sends no empty user parameter', async () => {
  const { org, calls } = loadApi({ reply: ASK });
  await org.sameNameVoices('Ben Lin', '');
  assert.doesNotMatch(calls[0].url, /user=/);
});

test('voiceprint_id and new_person reach the wire body through the real _fetch.js', async () => {
  const { org, calls } = loadApi({ reply: {} });
  const opts = { user: 'Ben_UCPK2', displayName: 'Ben Lin' };
  const ref = '2026-10-01_sid' + 'a'.repeat(32);
  await org.setSpeakerName(ref, sn.correctionBodyForChoice(SEG, opts, { voiceprintId: 'p2' }));
  await org.setSpeakerName(ref, sn.correctionBodyForChoice(SEG, opts, { newPerson: true }));
  await org.setSpeakerName(ref, sn.correctionBodyForChoice(SEG, opts, null));
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/speaker-corrections$/);
  assert.equal(calls[0].method, 'POST');
  const [w1, w2, w3] = calls.map((c) => JSON.parse(c.body));
  assert.equal(w1.voiceprint_id, 'p2');
  assert.equal('new_person' in w1, false);
  assert.equal(w2.new_person, true);
  assert.equal('voiceprint_id' in w2, false);
  assert.equal('voiceprint_id' in w3, false);
  assert.equal('new_person' in w3, false);
  assert.equal(w1.display_name, 'Ben Lin');
});

test('offline: the read stub answers "do not ask" and never blocks naming; the write still refuses', async () => {
  const { org, calls } = loadApi({ useMocks: true });
  const r = await org.sameNameVoices('Ben Lin', 'x');
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { profiles: [], wouldUse: null, ask: false });
  assert.equal(sn.sameNameShouldAsk(r), false);
  assert.equal(JSON.stringify(await org.setSpeakerName('r', {})), '{"_notAvailable":true}');
  assert.equal(calls.length, 0);
});

test('a failing check call rejects (the panel turns that into an error and sends nothing)', async () => {
  const { org } = loadApi({ fail: true });
  await assert.rejects(() => org.sameNameVoices('Ben Lin', 'x'));
  assert.match(sn.sameNameCheckFailedWords(), /nothing was saved/);
});

/* ---- wiring ------------------------------------------------------------ */

test('the naming panel checks first, sends the choice, and never falls back silently', () => {
  const src = read('scripts', 'composites', 'transcript-list.js');
  assert.match(src, /sameNameVoices\(name, user\)/);
  assert.match(src, /sn\.sameNameShouldAsk\(res\)/);
  assert.match(src, /sn\.correctionBodyForChoice\(seg, \{/);
  assert.match(src, /\{ voiceprintId: opt\.id \}/);
  assert.match(src, /\{ newPerson: true \}/);
  assert.match(src, /sn\.sameNameCheckFailedWords\(\)/);
  assert.match(src, /sn\.sameNameElseOutcome\(props\.name, typed\)/);
  /* The only place a correction is sent is sendName, and only runCheck/chooser reach it. */
  assert.equal((src.match(/setSpeakerName\(/g) || []).length, 1);
  /* Cancel sends nothing: chooserCancel never calls sendName. */
  const cancel = /function chooserCancel\(\) \{[\s\S]*?\n    \}/.exec(src)[0];
  assert.doesNotMatch(cancel, /sendName|setSpeakerName/);
  /* The failure branch does not send. */
  const failBranch = /\.catch\(function \(\) \{\s*if \(checkSeq[\s\S]*?onFail\(.*\);/.exec(src)[0];
  assert.doesNotMatch(failBranch, /sendName/);
});
