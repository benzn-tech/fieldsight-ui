'use strict';

/*
 * Voices page: tell same-named people apart, and merge duplicates.
 *
 * Owner's problem: two live "Ben Lin" rows that could not be merged, and no way to tell
 * three real Ben Lins apart. Customer rule: plain words, NEVER a similarity number.
 *
 * Covers the pure words (speaker-naming.js), the three API calls end to end through the
 * REAL _fetch.js (so a body that a layer drops on the way would be caught), the offline
 * rules (read stub serves data, write stub refuses), and the wiring of the page.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sn = require('../scripts/api/speaker-naming.js');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const BEN_A = { id: 'a', displayName: 'Ben Lin', status: 'tentative', samples: 2,
  linkedAccount: null, heardOn: ['Ben_UCPK2'], firstNamed: { at: '2026-09-28 01:02:03', by: 'Ben_UCPK2' },
  employer: null, mergedInto: null };
const BEN_B = { id: 'b', displayName: '  ben   LIN ', status: 'confirmed', samples: 4,
  linkedAccount: { name: 'Ben Lin', email: 'ben@x.com' }, heardOn: ['Ben_Lin_test2', 'Ben_UCPK2'],
  firstNamed: { at: '2026-09-30', by: 'Ben_Lin_test2' }, employer: 'Acme Build', mergedInto: null };
const SAM = { id: 'c', displayName: 'Sam Yu', status: 'confirmed', samples: 1 };
const GONE = { id: 'd', displayName: 'Ben Lin', status: 'withdrawn', mergedInto: { id: 'b', displayName: 'Ben Lin' } };
const DEL = { id: 'e', displayName: 'Old', status: 'withdrawn' };

/* ---- identity words ---------------------------------------------------- */

test('identity lines read in plain words and show no number', () => {
  assert.deepEqual(sn.voiceIdentityLines(BEN_B), [
    'Linked to ben@x.com', 'Heard on Ben_Lin_test2, Ben_UCPK2',
    'Named 30 Sep by Ben_Lin_test2', 'Acme Build']);
  assert.deepEqual(sn.voiceIdentityLines(BEN_A), [
    'Not linked to an account', 'Heard on Ben_UCPK2', 'Named 28 Sep by Ben_UCPK2']);
  for (const l of sn.voiceIdentityLines(BEN_B).concat(sn.voiceIdentityLines(BEN_A))) {
    assert.doesNotMatch(l, /\d\.\d|score|similar|undefined|null/i);
  }
});

test('an older backend (no new fields) renders nothing, never "undefined"', () => {
  assert.deepEqual(sn.voiceIdentityLines(SAM), []);
  assert.deepEqual(sn.voiceIdentityLines({}), []);
  assert.deepEqual(sn.voiceIdentityLines(null), []);
  assert.deepEqual(sn.voiceIdentityLines({ heardOn: [], firstNamed: {}, employer: '' }), []);
  assert.deepEqual(sn.voiceIdentityLines({ firstNamed: { by: 'X' } }), ['Named by X']);
});

/* ---- same-name detection ----------------------------------------------- */

test('two live rows with one name (case and spacing aside) both get the notice', () => {
  const rows = [BEN_A, BEN_B, SAM, GONE];
  assert.match(sn.sameNameNotice(BEN_A, rows), /^Same name as another voice/);
  assert.match(sn.sameNameNotice(BEN_B, rows), /merge or rename/);
  assert.equal(sn.sameNameNotice(SAM, rows), null);
});

test('a deleted or merged twin does not make a live row look duplicated', () => {
  assert.equal(sn.sameNameNotice(BEN_A, [BEN_A, GONE]), null);
  assert.equal(sn.sameNameNotice(GONE, [BEN_A, GONE]), null);
  assert.equal(sn.sameNameNotice({ id: 'z', displayName: '' }, [{ id: 'z' }, { id: 'y' }]), null);
});

/* ---- live / deleted split ---------------------------------------------- */

test('live rows come first; withdrawn and merged rows are held apart', () => {
  const s = sn.splitVoiceRows([GONE, BEN_A, DEL, SAM]);
  assert.deepEqual(s.live.map((r) => r.id), ['a', 'c']);
  assert.deepEqual(s.deleted.map((r) => r.id), ['d', 'e']);
  assert.deepEqual(sn.splitVoiceRows(undefined), { live: [], deleted: [] });
});

test('a merged row says "Merged into", a deleted one says "Deleted"', () => {
  assert.equal(sn.deletedVoiceWords(GONE), 'Merged into Ben Lin');
  assert.equal(sn.deletedVoiceWords(DEL), 'Deleted');
});

/* ---- merge chooser and dialog state ------------------------------------ */

test('the chooser lists the OTHER live rows, same-name first, each with its identity', () => {
  const ch = sn.mergeChoices(BEN_A, [SAM, BEN_A, GONE, BEN_B]);
  assert.deepEqual(ch.map((c) => c.id), ['b', 'c']);
  assert.equal(ch[0].sameName, true);
  assert.equal(ch[1].sameName, false);
  assert.equal(ch[0].identity[0], 'Linked to ben@x.com');
  assert.deepEqual(sn.mergeChoices(BEN_A, [BEN_A]), []);
});

test('alike and unsure merge on one press without confirm', () => {
  for (const verdict of ['alike', 'unsure']) {
    const d = sn.mergeDialogState({ verdict, message: 'm' }, 'Ben Lin');
    assert.equal(d.button, 'Merge into Ben Lin');
    assert.equal(d.confirm, false);
    assert.equal(d.warn, false);
    assert.equal(d.message, 'm');
  }
});

test('different shows a warning and needs the explicit confirm button', () => {
  const d = sn.mergeDialogState({ verdict: 'different', message: 'Sound different.' }, 'Ben Lin');
  assert.equal(d.warn, true);
  assert.equal(d.confirm, true);
  assert.equal(d.button, 'Yes, it’s the same person — merge');
  assert.equal(d.message, 'Sound different.');
  /* An answer we do not recognise fails toward asking, never toward a silent merge. */
  assert.equal(sn.mergeDialogState({ verdict: 'weird' }, 'X').confirm, true);
  assert.equal(sn.mergeDialogState(null, 'X').warn, true);
});

test('the success toast names the survivor', () => {
  assert.equal(sn.mergedToast('Ben Lin'), 'Merged. Ben Lin’s voice samples are now one profile.');
});

test('a new name must be 1-80 characters once trimmed', () => {
  assert.equal(sn.validateDisplayName('  Ben Lin (Cassidy) ').value, 'Ben Lin (Cassidy)');
  assert.equal(sn.validateDisplayName('x'.repeat(80)).ok, true);
  assert.equal(sn.validateDisplayName('x'.repeat(81)).ok, false);
  assert.equal(sn.validateDisplayName('   ').ok, false);
  assert.equal(sn.validateDisplayName(undefined).ok, false);
});

/* ---- API: through the real _fetch.js ----------------------------------- */

function loadApi(opts) {
  const calls = [];
  const sandbox = {
    console, setTimeout, clearTimeout, URL, URLSearchParams, AbortController, FormData,
    Date, Promise, JSON, encodeURIComponent,
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body });
      return { status: opts.status || 200, ok: (opts.status || 200) < 300,
        headers: { get: () => 'application/json' },
        json: async () => (opts.reply || {}) };
    },
    window: { FieldSight: { fixtures: { sites: { voiceprints: [{ id: 'f1' }] } } } },
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

test('merge-check is a GET carrying `into` in the query string', async () => {
  const { org, calls } = loadApi({ reply: { verdict: 'alike', message: 'ok' } });
  const r = await org.mergeCheck('a b', 'tgt/1');
  assert.equal(r.verdict, 'alike');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/org\/voiceprints\/a%20b\/merge-check\?into=tgt%2F1$/);
});

test('merge POSTs {into, confirm} and both reach the wire', async () => {
  const { org, calls } = loadApi({ reply: { mergedInto: 'b' } });
  await org.mergeVoiceprint('a', 'b', true);
  await org.mergeVoiceprint('a', 'b');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/org\/voiceprints\/a\/merge$/);
  assert.deepEqual(JSON.parse(calls[0].body), { into: 'b', confirm: true });
  assert.deepEqual(JSON.parse(calls[1].body), { into: 'b', confirm: false });
});

test('rename PATCHes {displayName} and it reaches the wire', async () => {
  const { org, calls } = loadApi({ reply: {} });
  await org.renameVoiceprint('a', 'Ben Lin (Cassidy)');
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].url, /\/org\/voiceprints\/a$/);
  assert.deepEqual(JSON.parse(calls[0].body), { displayName: 'Ben Lin (Cassidy)' });
});

test('a 409 from merge throws with the status and the server message, for the dialog', async () => {
  const { org } = loadApi({ status: 409, reply: { error: 'These two voices sound different.' } });
  await assert.rejects(() => org.mergeVoiceprint('a', 'b', false), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.message, 'These two voices sound different.');
    assert.equal(e.body.error, 'These two voices sound different.');
    return true;
  });
});

test('a write clears the cache, so the list is re-read after a merge', async () => {
  const { org, api } = loadApi({ reply: {} });
  let cleared = 0;
  api.cache = { clear() { cleared += 1; } };
  await org.mergeVoiceprint('a', 'b', false);
  await org.renameVoiceprint('a', 'N');
  assert.equal(cleared, 2);
});

test('offline: the write stubs refuse, the read stub serves data', async () => {
  const { org, calls } = loadApi({ useMocks: true });
  assert.equal(JSON.stringify(await org.mergeVoiceprint('a', 'b', true)), '{"_notAvailable":true}');
  assert.equal(JSON.stringify(await org.renameVoiceprint('a', 'N')), '{"_notAvailable":true}');
  const chk = await org.mergeCheck('a', 'b');
  assert.ok(['alike', 'unsure', 'different'].includes(chk.verdict));
  assert.ok(chk.message && !/\d\.\d/.test(chk.message));
  assert.equal(calls.length, 0);
  /* orgWrites off (reads live, writes not enabled) also refuses rather than faking. */
  const ro = loadApi({ orgWrites: false });
  assert.equal(JSON.stringify(await ro.org.mergeVoiceprint('a', 'b', true)), '{"_notAvailable":true}');
  assert.equal(ro.calls.length, 0);
});

/* ---- wiring ------------------------------------------------------------ */

test('the Voices page wires identity, merge, rename and the deleted toggle', () => {
  const src = read('scripts', 'composites', 'voice-library.js');
  assert.match(src, /voiceIdentityLines/);
  assert.match(src, /sameNameNotice/);
  assert.match(src, /splitVoiceRows/);
  assert.match(src, /Show deleted \(/);
  assert.match(src, /Same person as…/);
  assert.match(src, /org\.mergeCheck\(row\.id, c\.id\)/);
  assert.match(src, /org\.mergeVoiceprint\(row\.id, target\.id, check\.dlg\.confirm\)/);
  assert.match(src, /err\.status === 409/);
  assert.match(src, /org\.renameVoiceprint\(renaming\.id, v\.value\)/);
  assert.match(src, /Add something that tells people apart, e\.g\. Ben Lin \(Cassidy\)/);
  /* The actions sit behind the same gate as the rest of the panel. */
  assert.match(src, /var canEdit = mayManage\(user\)/);
  assert.match(src, /if \(canEdit && !dead\)/);
});

test('the new styles use semantic tokens as foregrounds, none from a palette scale', () => {
  const css = read('styles', 'composites.css');
  const start = css.indexOf('Voice identity, same-name notice');
  assert.ok(start > 0);
  const block = css.slice(start, css.indexOf('/* ---- Theme radio group', start));
  assert.doesNotMatch(block, /--color-(primary|accent|success|danger|warning|info|neutral)-\d/);
  assert.match(block, /\.fs-voices__choice/);
});
