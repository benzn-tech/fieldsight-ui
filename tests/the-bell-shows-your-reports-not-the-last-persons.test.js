'use strict';

/*
 * The bell lists the reports YOU generated, not the ones generated in this
 * browser by whoever used it before you.
 *
 * The job store kept its list in localStorage under one key, and its header
 * said localStorage was "per-viewer" and "means nothing to anybody else". It
 * is per BROWSER. Observed on TEST, 2026-09-27: reports generated as Ben_UCPK2
 * (company UC PK) were listed in the bell after Ben_UCPK (company Southbase)
 * signed in on the same machine -- template name, date, Download button.
 *
 * The Download was never the leak: freshUrl() asks the server, which answers
 * for whoever is signed in now. The listing itself was somebody else's.
 *
 * THE test is `a second account signing in sees none of the first account's
 * reports`. It changes the signed-in user WITHOUT reloading the module, which
 * is what signing out and back in does in the app -- a test that reloaded
 * would pass on a fix that only worked after a refresh.
 */
const test = require('node:test');
const assert = require('node:assert');

function harness() {
  const store = {};
  const listeners = [];
  const session = {
    user: { sub: 'sub-ucpk2' },
    onChange(cb) { listeners.push(cb); return () => {}; },
  };
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const statusCalls = [];
  global.window = {
    FS: {
      session,
      api: {
        org: {
          async getSessionReportStatus(o) { statusCalls.push(o); return { status: 'pending' }; },
        },
      },
    },
  };
  global.setInterval = () => 1;
  global.clearInterval = () => {};
  delete require.cache[require.resolve('../scripts/api/report-jobs.js')];
  require('../scripts/api/report-jobs.js');

  function signIn(sub) {
    session.user = sub ? { sub } : null;
    listeners.forEach((cb) => cb());
  }
  return { jobs: global.window.FS.reportJobs, store, signIn, statusCalls };
}

const JOB = { requestId: 'req-ucpk2-1', label: 'daily report · 2026-09-23',
              templateName: 'daily report', scope: 'day', date: '2026-09-23' };

/* ---- THE test ---------------------------------------------------------------- */

test('THE test: a second account signing in sees none of the first account\'s reports', () => {
  const h = harness();
  h.jobs.track(JOB);
  assert.strictEqual(h.jobs.list().length, 1, 'the first account sees its own');

  h.signIn('sub-ucpk');                     // same browser, no reload
  assert.deepStrictEqual(h.jobs.list(), [], 'the second account sees nothing of the first');
  assert.strictEqual(h.jobs.unseenCount(), 0, 'and the bell carries no number for it');
});

test('the first account gets its list back when it signs in again', () => {
  const h = harness();
  h.jobs.track(JOB);
  h.signIn('sub-ucpk');
  h.signIn('sub-ucpk2');
  assert.deepStrictEqual(h.jobs.list().map((j) => j.requestId), ['req-ucpk2-1']);
});

test('each account is written under its own key', () => {
  const h = harness();
  h.jobs.track(JOB);
  h.signIn('sub-ucpk');
  h.jobs.track({ ...JOB, requestId: 'req-ucpk-1' });
  const keys = Object.keys(h.store).sort();
  assert.deepStrictEqual(keys, ['fs.reportJobs.v1:sub-ucpk', 'fs.reportJobs.v1:sub-ucpk2']);
  assert.ok(!h.store['fs.reportJobs.v1:sub-ucpk'].includes('req-ucpk2-1'));
});

test('the bell is told when the account changes, so it redraws without a reload', () => {
  /* list() would give the right answer if somebody asked -- but the bell does
     not ask, it is TOLD. Without the notification it keeps drawing the last
     person's reports until the page is refreshed. */
  const h = harness();
  h.jobs.track(JOB);
  const seen = [];
  h.jobs.subscribe((snapshot) => seen.push(snapshot.map((j) => j.requestId)));
  h.signIn('sub-ucpk');
  assert.ok(seen.length >= 1, 'the bell was notified');
  assert.deepStrictEqual(seen[seen.length - 1], [], "with the new account's (empty) list");
});

test('an account change nobody announced is still caught when the list is read', () => {
  /* The session module announces changes today. If some future path swaps
     the user without announcing it, reading the list must still check whose
     it is -- the two guards cover each other, so each is tested alone. */
  const h = harness();
  h.jobs.track(JOB);
  global.window.FS.session.user = { sub: 'sub-ucpk' };     // no listeners fired
  assert.deepStrictEqual(h.jobs.list(), []);
});

test('a poll that settles after an unannounced account change writes under the old account', async () => {
  /* save() writes the list under the account it was LOADED for. If it wrote
     under whoever is signed in at the moment of writing, this is the case
     that would put one account's job into another's key. */
  const h = harness();
  let answer;
  global.window.FS.api.org.getSessionReportStatus = () => new Promise((r) => { answer = r; });
  h.jobs.track(JOB);
  global.window.FS.session.user = { sub: 'sub-ucpk' };     // swapped, not announced
  answer({ status: 'done' });
  await new Promise((r) => setImmediate(r));
  const theirs = h.store['fs.reportJobs.v1:sub-ucpk'] || '';
  assert.ok(!theirs.includes('req-ucpk2-1'), 'nothing of the first account under the second key');
  assert.ok((h.store['fs.reportJobs.v1:sub-ucpk2'] || '').includes('"done"'),
            'the result landed where the job belongs');
});

/* ---- nobody signed in -------------------------------------------------------- */

test('with nobody signed in, nothing is shown and nothing is written', () => {
  const h = harness();
  h.jobs.track(JOB);
  h.signIn(null);
  assert.deepStrictEqual(h.jobs.list(), []);
  const before = JSON.stringify(h.store);
  assert.strictEqual(h.jobs.track({ ...JOB, requestId: 'req-anon' }), null);
  assert.strictEqual(JSON.stringify(h.store), before, 'a job with no owner is not stored');
});

/* ---- the key everyone used to share ------------------------------------------- */

test('the old shared key is removed, because nothing in it says whose it was', () => {
  const store = { 'fs.reportJobs.v1': JSON.stringify([{ requestId: 'someone-elses',
    status: 'done', startedAt: Date.now(), finishedAt: Date.now() }]) };
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  global.window = { FS: { session: { user: { sub: 'sub-x' }, onChange() {} },
    api: { org: { async getSessionReportStatus() { return { status: 'pending' }; } } } } };
  global.setInterval = () => 1;
  global.clearInterval = () => {};
  delete require.cache[require.resolve('../scripts/api/report-jobs.js')];
  require('../scripts/api/report-jobs.js');

  const jobs = global.window.FS.reportJobs;
  assert.deepStrictEqual(jobs.list(), [], 'not adopted into whoever signs in first');
  assert.ok(!('fs.reportJobs.v1' in store), 'and gone');
});

/* ---- the poll that outlives a sign-out ------------------------------------------ */

test('a poll that settles after a different account signs in does not write into it', async () => {
  const h = harness();
  let answer;
  global.window.FS.api.org.getSessionReportStatus = () => new Promise((r) => { answer = r; });
  h.jobs.track(JOB);                 // starts a poll for sub-ucpk2
  h.signIn('sub-ucpk');              // the poll is still in flight
  answer({ status: 'done' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(h.jobs.list(), [], 'the new account still has nothing');
  assert.ok(!('fs.reportJobs.v1:sub-ucpk' in h.store) ||
            !h.store['fs.reportJobs.v1:sub-ucpk'].includes('req-ucpk2-1'),
            'the old account\'s job was not written under the new key');
});

test('a Download asked for by the second account finds no first-account report', async () => {
  const h = harness();
  h.jobs.track(JOB);
  h.signIn('sub-ucpk');
  await assert.rejects(h.jobs.freshUrl('req-ucpk2-1'), /no longer listed/);
});

/* ---- the header stops saying the thing that was not true ----------------------- */

test('the header no longer calls localStorage per-viewer', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scripts', 'api', 'report-jobs.js'), 'utf8');
  assert.ok(!/it\s+is per-viewer, it means nothing to anybody else/.test(src));
  assert.match(src, /PER ACCOUNT, NOT PER BROWSER/);
});
