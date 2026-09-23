'use strict';

/*
 * A report is written in minutes; nobody should have to stand and watch it.
 *
 * Before this, the only place a generation's progress existed was the modal
 * that started it. Close it, reload, or walk away, and the report was still
 * being written while nothing on screen knew. The owner put it plainly: you
 * cannot leave a client staring at a spinner.
 *
 * So the job lives in a store that owns its own polling, and the bell reads it.
 *
 * TWO assertions here matter more than the rest, and both are about failures
 * that would be invisible in a demo and obvious in use:
 *
 *   THE test: `the download url is never stored`. Those urls are presigned
 *   with a fifteen-minute expiry. A stored one answers 403 later, and this
 *   bucket answers 403 for missing keys too -- so the button would fail in a
 *   way that does not even read as expired. It has to be asked for at the
 *   moment of the click.
 *
 *   `polling survives the component`: if a React component owned the interval,
 *   it would stop on unmount -- which is precisely when somebody navigated
 *   away, the case this whole thing exists for.
 */
const test = require('node:test');
const assert = require('node:assert');

function loadStore(opts) {
  opts = opts || {};
  const store = {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const statusCalls = [];
  global.window = {
    FS: {
      api: {
        org: {
          /* async, like the real one. A reply that throws must come back as a
             REJECTED PROMISE, not a synchronous throw -- getting that wrong
             makes the degrade-on-failure path look broken when it is the
             double that is unfaithful. (Second time today; the first was the
             template store's orgRequest stub.) */
          async getSessionReportStatus(o) {
            statusCalls.push(o);
            return opts.status ? opts.status(o) : { status: 'pending' };
          },
        },
      },
    },
  };
  global.setInterval = () => 1;
  global.clearInterval = () => {};
  delete require.cache[require.resolve('../scripts/api/report-jobs.js')];
  require('../scripts/api/report-jobs.js');
  return { jobs: global.window.FS.reportJobs, statusCalls, raw: store };
}

const JOB = {
  requestId: 'r-1', label: 'Site walk', templateName: 'Site Daily',
  scope: null, sessionId: 'sid1', date: '2026-09-10', user: 'Ben_UCPK2',
};

/* ---- THE test -------------------------------------------------------------- */

test('THE test: the download url is never stored', async () => {
  const { jobs, raw } = loadStore({
    status: () => ({ status: 'done', docUrl: 'https://signed.example/abc?X-Amz-Signature=xyz' }),
  });
  jobs.track(JOB);
  await jobs._pollOnce();
  await Promise.resolve();
  await Promise.resolve();

  const written = JSON.stringify(raw);
  assert.ok(!/X-Amz-Signature/.test(written), 'a presigned url was persisted');
  assert.ok(!/signed\.example/.test(written), 'a download url was persisted');
  assert.ok(!/docUrl/.test(written), 'the url field was persisted');
});

test('the url is fetched at the moment of the click', async () => {
  const { jobs, statusCalls } = loadStore({
    status: () => ({ status: 'done', docUrl: 'https://signed.example/abc' }),
  });
  jobs.track(JOB);
  statusCalls.length = 0;
  const url = await jobs.freshUrl('r-1');
  assert.strictEqual(url, 'https://signed.example/abc');
  assert.strictEqual(statusCalls.length, 1, 'it must ask, not remember');
});

test('a download asked for before it is ready says so', async () => {
  const { jobs } = loadStore({ status: () => ({ status: 'pending' }) });
  jobs.track(JOB);
  await assert.rejects(() => jobs.freshUrl('r-1'), /not ready/);
});

/* ---- the poll does not belong to a component -------------------------------- */

test('polling survives the component: the store carries what the poll needs', () => {
  /* The status call happens long after the screen that knew the session id
     has gone, so the job has to carry it. */
  const { jobs, statusCalls } = loadStore();
  jobs.track(JOB);
  jobs._pollOnce();
  assert.deepStrictEqual(statusCalls[0], {
    scope: null, sessionId: 'sid1', date: '2026-09-10',
    user: 'Ben_UCPK2', requestId: 'r-1',
  });
});

test('a tracked job is written down, so a reload resumes it', () => {
  const { jobs, raw } = loadStore();
  jobs.track(JOB);
  assert.match(JSON.stringify(raw), /r-1/);
  assert.match(JSON.stringify(raw), /working/);
});

/* ---- what the states mean --------------------------------------------------- */

test('done clears from working and counts as unseen', async () => {
  const { jobs } = loadStore({ status: () => ({ status: 'done', docUrl: 'u' }) });
  jobs.track(JOB);
  await jobs._pollOnce();
  await Promise.resolve();
  assert.strictEqual(jobs.working(), 0);
  assert.strictEqual(jobs.unseenCount(), 1);
});

test("an error carries the server's own sentence", async () => {
  /* The server knows what went wrong and this panel does not. A generic
     "failed" is what sent the owner looking at his own template. */
  const { jobs } = loadStore({
    status: () => ({ status: 'error', error: 'The report could not be generated (KeyError).' }),
  });
  jobs.track(JOB);
  await jobs._pollOnce();
  await Promise.resolve();
  assert.match(jobs.list()[0].error, /KeyError/);
});

test('a deleted recording is said to be deleted, not "failed"', async () => {
  const { jobs } = loadStore({ status: () => ({ status: 'removed' }) });
  jobs.track(JOB);
  await jobs._pollOnce();
  await Promise.resolve();
  assert.match(jobs.list()[0].error, /deleted/);
});

test('a failed poll is not a failed report', async () => {
  /* Losing the network for one tick must not declare the report dead. */
  const { jobs } = loadStore({ status: () => { throw new Error('offline'); } });
  jobs.track(JOB);
  try { await jobs._pollOnce(); } catch (_) { /* must not escape */ }
  await Promise.resolve();
  assert.strictEqual(jobs.list()[0].status, 'working');
});

test('a job nobody heard back about stops working, and says what is not known', async () => {
  const { jobs } = loadStore({ status: () => ({ status: 'pending' }) });
  jobs.track(JOB);
  const job = jobs.list()[0];
  job.startedAt = Date.now() - (jobs.GIVE_UP_MS + 1000);
  await jobs._pollOnce();
  await Promise.resolve();
  const settled = jobs.list()[0];
  assert.strictEqual(settled.status, 'error');
  assert.match(settled.error, /may still have been written/,
    'it must not claim the report failed; it only knows nobody answered');
});

/* ---- the count ------------------------------------------------------------- */

test('opening the panel clears the count, because you have been told', async () => {
  const { jobs } = loadStore({ status: () => ({ status: 'done', docUrl: 'u' }) });
  jobs.track(JOB);
  await jobs._pollOnce();
  await Promise.resolve();
  assert.strictEqual(jobs.unseenCount(), 1);
  jobs.markAllSeen();
  assert.strictEqual(jobs.unseenCount(), 0);
});

test('work in flight is not counted as news', async () => {
  const { jobs } = loadStore();
  jobs.track(JOB);
  assert.strictEqual(jobs.working(), 1);
  assert.strictEqual(jobs.unseenCount(), 0, 'a running job is not an unread result');
});

test('tracking the same request twice does not list it twice', () => {
  const { jobs } = loadStore();
  jobs.track(JOB);
  jobs.track(JOB);
  assert.strictEqual(jobs.list().length, 1);
});

test('a dismissed job is gone', () => {
  const { jobs } = loadStore();
  jobs.track(JOB);
  jobs.dismiss('r-1');
  assert.strictEqual(jobs.list().length, 0);
});

/* ---- the modal must hand the job over -------------------------------------- */

test('the modal registers the job as soon as it has a requestId', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'composites', 'session-report-modal.js'), 'utf8');
  /* Registered where the id arrives, not in the poll effect: the window can be
     shut a second later, and the whole point is that this survives it. */
  const m = SRC.match(/if \(res && res\.requestId\) \{[\s\S]*?\n {8}\}/);
  assert.ok(m, 'the requestId branch has moved');
  assert.match(m[0], /reportJobs\.track/);
});

test('the generating step says waiting is optional', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'composites', 'session-report-modal.js'), 'utf8');
  assert.match(SRC, /You can close this and carry on/);
  /* And the button says Close, not Cancel: pressing it stops nothing. */
  assert.match(SRC, /btn\('Close', props\.onClose, 'primary'\)/);
});
