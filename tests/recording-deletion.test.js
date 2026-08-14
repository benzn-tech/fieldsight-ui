'use strict';

/*
 * Unit tests for the recording-deletion rules.
 *
 * Backend spec: fieldsight-pipeline
 *   docs/superpowers/specs/2026-08-14-user-deletes-a-recording.md
 *
 * The two that matter most:
 *
 *   - a `topics_hidden: 0` row must survive into the summary as its own
 *     category. The backend goes out of its way to return zeros rather than
 *     failing, precisely so the UI can say "this one matched nothing"; folding
 *     it into a success count tells the customer their recording is gone when
 *     it is not.
 *   - a session with no `session_base` is never selectable. The backend
 *     refuses it, and the alternative it warns about — widening the prefix to
 *     the whole day — would hide recordings nobody selected, silently.
 */
const test = require('node:test');
const assert = require('node:assert');

const rd = require('../scripts/api/recording-deletion.js');

const HOUR = 60 * 60 * 1000;
const NOW = 1770000000000;   /* fixed; Date.now() is never called in a test */

const ROW = {
  folder: 'Jarley_Trainor',
  date: '2026-04-29',
  sessionBase: 'sid0123456789abcdef0123456789abcdef',
  label: '11:49 · 3 topics',
};
/* A report-sourced day: one S3 key for the whole day, no session granularity
   exists in the data at all. */
const WHOLE_DAY = {
  folder: 'Jarley_Trainor', date: '2026-04-29', sessionBase: null,
  label: 'Whole day',
};

/* A localStorage double. The real one throws in private mode and when full,
   which the module has to survive — see the quota case below. */
function fakeStore(initial) {
  var data = Object.assign({}, initial || {});
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    _data: data,
  };
}

test('a session with no session_base is never selectable', () => {
  assert.strictEqual(rd.isSelectable(ROW), true);
  assert.strictEqual(rd.isSelectable(WHOLE_DAY), false);
  assert.strictEqual(rd.isSelectable({ folder: 'x', date: '2026-01-01', sessionBase: '  ' }), false);
  assert.strictEqual(rd.isSelectable(null), false);

  /* And it cannot sneak into a request either, even if a caller passes it. */
  const req = rd.toRequest([ROW, WHOLE_DAY], 'because');
  assert.strictEqual(req.recordings.length, 1);
  assert.deepStrictEqual(req.recordings[0], {
    folder: ROW.folder, date: ROW.date, sessionBase: ROW.sessionBase,
  });
  assert.strictEqual(req.reason, 'because');
});

test('the request body carries exactly what the endpoint addresses', () => {
  const req = rd.toRequest([ROW]);
  assert.deepStrictEqual(Object.keys(req.recordings[0]).sort(),
    ['date', 'folder', 'sessionBase']);
  /* Label and topic counts are UI-side; sending them would invite someone to
     start trusting them server-side. */
  assert.strictEqual(req.recordings[0].label, undefined);
});

test('authorization is per row: role OR ownership', () => {
  const admin  = { role: 'admin',  folder: 'Someone_Else' };
  const gm     = { role: 'gm',     folder: 'Someone_Else' };
  const owner  = { role: 'worker', folder: 'Jarley_Trainor' };
  const other  = { role: 'worker', folder: 'Someone_Else' };
  const sm     = { role: 'site_manager', folder: 'Someone_Else' };

  assert.strictEqual(rd.canDelete(ROW, admin), true);
  assert.strictEqual(rd.canDelete(ROW, gm), true);
  assert.strictEqual(rd.canDelete(ROW, owner), true, 'the recorder may delete their own');
  assert.strictEqual(rd.canDelete(ROW, other), false);
  /* site_manager is NOT on the backend's delete list, even though it is on
     the speaker-naming one. Two different endpoints, two different lists. */
  assert.strictEqual(rd.canDelete(ROW, sm), false);
  /* Unselectable stays unselectable no matter who is asking. */
  assert.strictEqual(rd.canDelete(WHOLE_DAY, admin), false);
  assert.strictEqual(rd.canDelete(ROW, null), false);
});

test('a row that hid nothing is reported, not counted as a success', () => {
  const rows = [
    ROW,
    Object.assign({}, ROW, { sessionBase: 'sidbbbb', label: '14:02 · 0 topics' }),
  ];
  const res = {
    batch_id: 'b-1',
    results: [
      { recording: { folder: ROW.folder, date: ROW.date, sessionBase: ROW.sessionBase },
        topics_hidden: 5 },
      { recording: { folder: ROW.folder, date: ROW.date, sessionBase: 'sidbbbb' },
        topics_hidden: 0 },
    ],
  };
  const s = rd.summariseResult(res, rows);

  assert.strictEqual(s.batchId, 'b-1');
  assert.strictEqual(s.deleted, 2);
  assert.strictEqual(s.topicsHidden, 5);
  assert.deepStrictEqual(s.nothingHidden, ['14:02 · 0 topics']);
  assert.deepStrictEqual(s.failed, []);

  /* And it must reach the one line the user actually reads. */
  const line = rd.summaryLine(s);
  assert.match(line, /2 recordings deleted/);
  assert.match(line, /5 topics removed/);
  assert.match(line, /1 had nothing to remove/,
    'a zero-hit recording must be visible in the summary line');
});

test('a per-item refusal is named, and does not count as deleted', () => {
  const rows = [ROW, Object.assign({}, ROW, { folder: 'Someone_Else', label: 'their recording' })];
  const res = {
    batch_id: 'b-2',
    results: [
      { recording: { folder: ROW.folder, date: ROW.date, sessionBase: ROW.sessionBase },
        topics_hidden: 3 },
      { recording: { folder: 'Someone_Else', date: ROW.date, sessionBase: ROW.sessionBase },
        topics_hidden: 0, error: 'not permitted to delete this user\'s recordings' },
    ],
  };
  const s = rd.summariseResult(res, rows);
  assert.strictEqual(s.deleted, 1, 'a refused item is not a deleted item');
  assert.strictEqual(s.topicsHidden, 3);
  assert.strictEqual(s.failed.length, 1);
  assert.strictEqual(s.failed[0].label, 'their recording');
  assert.deepStrictEqual(s.nothingHidden, [],
    'a refusal is not also a nothing-to-remove');
  assert.match(rd.summaryLine(s), /1 refused/);
});

test('an empty result set says zero rather than nothing at all', () => {
  const s = rd.summariseResult({ batch_id: 'b-3', results: [] }, []);
  assert.strictEqual(rd.summaryLine(s), '0 recordings deleted · 0 topics removed');
});

test('the clock time is read off the string, never through a Date', () => {
  assert.strictEqual(rd.clockTime('2026-04-29T11:49:00'), '11:49:00');
  assert.strictEqual(rd.clockTime('2026-04-29T11:49:00+12:00'), '11:49:00');
  assert.strictEqual(rd.clockTime(null), null);
  assert.strictEqual(rd.clockTime('2026-04-29'), null);
});

test('an unknown session end is inferred from the next start, and admits it', () => {
  const a = { started_at: '2026-04-29T09:00:00', ended_at: '2026-04-29T09:42:00' };
  const b = { started_at: '2026-04-29T11:49:00', ended_at: null };
  const c = { started_at: '2026-04-29T14:05:00', ended_at: null };

  /* A known end is used as-is and claims nothing. */
  assert.deepStrictEqual(rd.sessionWindow(a, b),
    { start: '09:00:00', end: '09:42:00', inferredEnd: false });

  /* `ended_at` is cosmetic and may be absent — the backend renders "?" there
     rather than guessing, so a fallback must be flagged as one. */
  assert.deepStrictEqual(rd.sessionWindow(b, c),
    { start: '11:49:00', end: '14:05:00', inferredEnd: true });

  /* Last of the day: run to midnight rather than invent a duration. */
  assert.deepStrictEqual(rd.sessionWindow(c, null),
    { start: '14:05:00', end: '23:59:59', inferredEnd: true });

  /* A neighbour that starts BEFORE this one is not a usable boundary. */
  assert.deepStrictEqual(
    rd.sessionWindow(c, { started_at: '2026-04-29T08:00:00' }),
    { start: '14:05:00', end: '23:59:59', inferredEnd: true });

  /* No start at all: refuse to produce a window rather than one from 00:00. */
  assert.deepStrictEqual(rd.sessionWindow({ started_at: null }, c),
    { start: null, end: null, inferredEnd: true });
});

test('the restore ledger survives a reload and expires on read', () => {
  const store = fakeStore();
  rd.appendBatch({ batchId: 'b-1', count: 2, topicsHidden: 7, labels: ['a', 'b'] }, NOW, store);

  /* Same key a reload would read. */
  const reloaded = rd.readLedger(store);
  assert.strictEqual(reloaded.length, 1);
  assert.strictEqual(reloaded[0].batchId, 'b-1');
  assert.strictEqual(reloaded[0].topicsHidden, 7);

  assert.strictEqual(rd.activeBatches(NOW + HOUR, store).length, 1);
  assert.strictEqual(rd.activeBatches(NOW + 23 * HOUR, store).length, 1);
  /* Expiry is computed on read, so an entry cannot outlive its window just
     because no timer happened to fire. */
  assert.strictEqual(rd.activeBatches(NOW + 25 * HOUR, store).length, 0);
  /* ...but it is still IN the ledger — the window closes the offer, it does
     not destroy the record, and the batch is still restorable via the API. */
  assert.strictEqual(rd.readLedger(store).length, 1);
});

test('hours left counts down and never reads as a full window', () => {
  const b = { batchId: 'b', at: NOW };
  assert.strictEqual(rd.hoursLeft(b, NOW), 24);
  assert.strictEqual(rd.hoursLeft(b, NOW + 1 * HOUR), 23);
  assert.strictEqual(rd.hoursLeft(b, NOW + 23.5 * HOUR), 1,
    'a half hour left rounds up to 1h, never down to 0h while still restorable');
  assert.strictEqual(rd.hoursLeft(b, NOW + 24 * HOUR), 0);
});

test('the ledger is capped and a repeat batch id does not stack', () => {
  const store = fakeStore();
  for (let i = 0; i < rd.LEDGER_CAP + 4; i++) {
    rd.appendBatch({ batchId: 'b-' + i, count: 1, topicsHidden: 1 }, NOW + i, store);
  }
  assert.strictEqual(rd.readLedger(store).length, rd.LEDGER_CAP);
  /* Newest first. */
  assert.strictEqual(rd.readLedger(store)[0].batchId, 'b-' + (rd.LEDGER_CAP + 3));

  rd.appendBatch({ batchId: 'b-' + (rd.LEDGER_CAP + 3), count: 9, topicsHidden: 9 }, NOW, store);
  const dupes = rd.readLedger(store)
    .filter((b) => b.batchId === 'b-' + (rd.LEDGER_CAP + 3));
  assert.strictEqual(dupes.length, 1);
  assert.strictEqual(dupes[0].count, 9, 'the repeat replaces rather than duplicating');
});

test('removeBatch takes exactly one entry out', () => {
  const store = fakeStore();
  rd.appendBatch({ batchId: 'b-1', count: 1 }, NOW, store);
  rd.appendBatch({ batchId: 'b-2', count: 1 }, NOW, store);
  rd.removeBatch('b-1', store);
  assert.deepStrictEqual(rd.readLedger(store).map((b) => b.batchId), ['b-2']);
});

test('a corrupt or unreadable ledger degrades to empty, never throws', () => {
  const corrupt = fakeStore({ [rd.LEDGER_KEY]: 'not json{' });
  assert.deepStrictEqual(rd.readLedger(corrupt), []);
  assert.deepStrictEqual(rd.activeBatches(NOW, corrupt), []);

  /* Stored as a JSON object rather than an array — also not usable. */
  const wrongShape = fakeStore({ [rd.LEDGER_KEY]: '{"b":1}' });
  assert.deepStrictEqual(rd.readLedger(wrongShape), []);

  /* A full/denied quota must not take the delete down with it: the batch is
     already gone server-side and is still restorable through the endpoint. */
  const throwing = {
    getItem() { return null; },
    setItem() { throw new Error('QuotaExceededError'); },
  };
  assert.doesNotThrow(function () {
    rd.appendBatch({ batchId: 'b-1', count: 1 }, NOW, throwing);
  });
});
