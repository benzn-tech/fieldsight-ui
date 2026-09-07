'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.window = { FS: { api: {} } };
require('../scripts/api/evidence-grouping.js');
require('../scripts/api/zip-store.js');
window.FS.api.media = {
  photoKey: (o) => 'users/' + String(o.userDisplayName).replace(/ /g, '_')
    + '/pictures/' + o.date + '/' + o.filename,
  getUrl: async (key) => ({ url: 'https://example.test/' + key }),
};
const { buildArchive, MAX_BYTES } = require('../scripts/api/photo-archive.js');

function p(over) {
  return Object.assign({
    filename: 'Benl1_2026-09-02_09-55-26.jpg',
    topic_id: 't1', topic_title: 'Laundry Equipment Overview',
  }, over);
}
const okFetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });

test('the archive is named for the date and the person', async () => {
  const r = await buildArchive({ photos: [p()], date: '2026-09-02',
    userDisplayName: 'Ben Lin', fetchImpl: okFetch });
  assert.strictEqual(r.name, '2026-09-02 Ben Lin.zip');
});

test('folders are the topics, numbered in the order the day ran', async () => {
  const r = await buildArchive({
    photos: [p({ topic_id: 'b', topic_title: 'Air Compressor',
                 filename: 'Benl1_2026-09-02_14-00-00.jpg' }),
             p({ topic_id: 'a', topic_title: 'Zebra Crossing',
                 filename: 'Benl1_2026-09-02_08-00-00.jpg' })],
    date: '2026-09-02', userDisplayName: 'Ben Lin', fetchImpl: okFetch });
  assert.deepStrictEqual(r.paths, [
    '01 Zebra Crossing/Benl1_2026-09-02_08-00-00.jpg',
    '02 Air Compressor/Benl1_2026-09-02_14-00-00.jpg',
  ]);
});

test('a photo that fails to fetch is REPORTED, never silently dropped', async () => {
  // The defect this feature ships most easily. A zip holding 47 of 53 photos
  // is indistinguishable from a complete one, and the person who forwards it
  // to the client never finds out.
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n === 1) return { ok: false, status: 403 };
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
  };
  const r = await buildArchive({
    photos: [p({ filename: 'Benl1_2026-09-02_09-00-00.jpg' }),
             p({ filename: 'Benl1_2026-09-02_10-00-00.jpg' })],
    date: '2026-09-02', userDisplayName: 'Ben Lin', fetchImpl: flaky });
  assert.strictEqual(r.missing.length, 1);
  assert.ok(r.paths.some(x => x.startsWith('_MISSING/')), r.paths.join('\n'));
});

test('the failure note names the file and the reason', async () => {
  const r = await buildArchive({ photos: [p()], date: '2026-09-02',
    userDisplayName: 'Ben Lin',
    fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.match(r.missingText, /Benl1_2026-09-02_09-55-26\.jpg/);
  assert.match(r.missingText, /403/);
});

test('an oversized selection refuses instead of freezing the tab', async () => {
  const big = async () => ({ ok: true,
    arrayBuffer: async () => new ArrayBuffer(MAX_BYTES + 1) });
  await assert.rejects(
    () => buildArchive({ photos: [p()], date: '2026-09-02',
                         userDisplayName: 'Ben Lin', fetchImpl: big }),
    /too large/i);
});

test('every selected photo is accounted for, present or missing', async () => {
  const photos = [p({ filename: 'Benl1_2026-09-02_09-00-00.jpg' }),
                  p({ filename: 'Benl1_2026-09-02_10-00-00.jpg' }),
                  p({ filename: 'Benl1_2026-09-02_11-00-00.jpg' })];
  let n = 0;
  const flaky = async () => {
    n += 1;
    return n === 2 ? { ok: false, status: 500 }
                   : { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
  };
  const r = await buildArchive({ photos, date: '2026-09-02',
    userDisplayName: 'Ben Lin', fetchImpl: flaky });
  const jpgs = r.paths.filter(x => x.endsWith('.jpg')).length;
  assert.strictEqual(jpgs + r.missing.length, photos.length);
});

test('a photo with no topic is IN the zip, under No topic', async () => {
  // Caught in the browser, not here: selecting all six photos of the marquee
  // fixture produced a zip holding five. buildArchive walked grouped.groups
  // and never grouped.ungrouped — the same omission that had already hidden
  // the ungrouped section from the SCREEN once, repeated in the archive.
  //
  // It is the exact defect this module exists to prevent, and the tests above
  // all passed throughout because every fixture photo carried a topic.
  const r = await buildArchive({
    photos: [p({ topic_id: 't1', filename: 'Benl1_2026-09-02_09-00-00.jpg' }),
             p({ topic_id: null, topic_title: null,
                 filename: 'Benl1_2026-09-02_11-52-40.jpg' })],
    date: '2026-09-02', userDisplayName: 'Ben Lin', fetchImpl: okFetch });
  assert.strictEqual(r.missing.length, 0);
  assert.strictEqual(r.paths.length, 2);
  assert.ok(r.paths.some(x => x === 'No topic/Benl1_2026-09-02_11-52-40.jpg'),
            r.paths.join('\n'));
});

test('No topic sorts after the numbered topics', async () => {
  // It is the leftover, so it reads last — the same place it sits on screen.
  const r = await buildArchive({
    photos: [p({ topic_id: null, topic_title: null, filename: 'Benl1_2026-09-02_08-00-00.jpg' }),
             p({ topic_id: 't1', topic_title: 'Crane', filename: 'Benl1_2026-09-02_09-00-00.jpg' })],
    date: '2026-09-02', userDisplayName: 'Ben Lin', fetchImpl: okFetch });
  assert.deepStrictEqual(r.paths, [
    '01 Crane/Benl1_2026-09-02_09-00-00.jpg',
    'No topic/Benl1_2026-09-02_08-00-00.jpg',
  ]);
});

test('a selection that is ENTIRELY unbound still produces an archive', async () => {
  // 2026-08-14 on prod: one topic, five photos, zero bound.
  const r = await buildArchive({
    photos: [p({ topic_id: null, topic_title: null, filename: 'Benl1_2026-08-14_09-00-00.jpg' })],
    date: '2026-08-14', userDisplayName: 'Ben Lin', fetchImpl: okFetch });
  assert.deepStrictEqual(r.paths, ['No topic/Benl1_2026-08-14_09-00-00.jpg']);
});
