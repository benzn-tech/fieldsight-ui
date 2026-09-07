'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { photoTime, groupByTopic, folderName } =
  require('../scripts/api/evidence-grouping.js');

function p(over) {
  return Object.assign({
    filename: 'Benl1_2026-09-02_09-55-26.jpg',
    topic_id: 't1', topic_title: 'Laundry Equipment Overview',
    userDisplayName: 'Ben Lin',
  }, over);
}

test('photoTime reads the ordinary device filename', () => {
  assert.strictEqual(photoTime('Benl1_2026-09-02_09-55-26.jpg'), '09-55-26');
});

test('photoTime reads a keyframe filename', () => {
  // Zero of these exist on prod today, but the code path that writes them
  // ships (photo-grid.js:44), so the parser must not mis-sort them into
  // "unknown" the day one appears.
  assert.strictEqual(photoTime('Benl1_2026-09-02_kf_s095526.jpg'), '09-55-26');
});

test('photoTime refuses to guess', () => {
  assert.strictEqual(photoTime('IMG_0042.jpg'), null);
  assert.strictEqual(photoTime(''), null);
  assert.strictEqual(photoTime(null), null);
});

test('groups are ordered by their first photo, not alphabetically', () => {
  const out = groupByTopic([
    p({ topic_id: 'b', topic_title: 'Air Compressor',
        filename: 'Benl1_2026-09-02_14-00-00.jpg' }),
    p({ topic_id: 'a', topic_title: 'Zebra Crossing',
        filename: 'Benl1_2026-09-02_08-00-00.jpg' }),
  ]);
  assert.deepStrictEqual(out.groups.map(g => g.topic_id), ['a', 'b']);
});

test('photos inside a group stay chronological', () => {
  const out = groupByTopic([
    p({ filename: 'Benl1_2026-09-02_10-00-00.jpg' }),
    p({ filename: 'Benl1_2026-09-02_09-00-00.jpg' }),
  ]);
  assert.deepStrictEqual(out.groups[0].photos.map(x => photoTime(x.filename)),
                         ['09-00-00', '10-00-00']);
});

test('an unparseable filename keeps payload order and sorts last', () => {
  // Guessing a time would put an invention into the folder numbering.
  const out = groupByTopic([
    p({ topic_id: 'x', filename: 'IMG_0042.jpg' }),
    p({ topic_id: 'x', filename: 'Benl1_2026-09-02_09-00-00.jpg' }),
  ]);
  assert.deepStrictEqual(out.groups[0].photos.map(x => x.filename),
    ['Benl1_2026-09-02_09-00-00.jpg', 'IMG_0042.jpg']);
});

test('nothing is dropped', () => {
  const input = [p({ topic_id: 'a' }), p({ topic_id: 'b' }), p({ topic_id: 'a' })];
  const out = groupByTopic(input);
  const total = out.groups.reduce((n, g) => n + g.photos.length, 0)
              + out.ungrouped.length;
  assert.strictEqual(total, input.length);
});

test('the same filename under two topics yields two entries', () => {
  // media.js:90-91 says this is real. De-duplicating would drop a photo from
  // a folder that should have it.
  const f = 'Benl1_2026-09-02_09-00-00.jpg';
  const out = groupByTopic([p({ topic_id: 'a', filename: f }),
                            p({ topic_id: 'b', filename: f })]);
  assert.strictEqual(out.groups.length, 2);
});

test('the ungrouped remainder is empty for anything the page can produce', () => {
  // A tripwire, not a feature (spec §2.1): every photo the Evidence page holds
  // came from report.topics[].related_photos and therefore HAS a topic. If a
  // list-photos endpoint later feeds this function topic-less photos, this
  // goes red and forces the UI decision instead of letting them vanish.
  const out = groupByTopic([p(), p({ topic_id: 'b' })]);
  assert.deepStrictEqual(out.ungrouped, []);
  const stray = groupByTopic([p({ topic_id: null, topic_title: null })]);
  assert.strictEqual(stray.ungrouped.length, 1);
});

test('folderName numbers, truncates at a word boundary, and never mid-word', () => {
  assert.strictEqual(
    folderName('Laundry Equipment Overview and Lint Collection System', 0),
    '01 Laundry Equipment Overview');
  assert.ok(folderName('Steam Heating and Energy Recovery System', 1)
            .startsWith('02 '));
});

test('folderName replaces path characters instead of dropping them', () => {
  // Dropping would merge "Level 1/2 inspection" and "Level 12 inspection".
  assert.strictEqual(folderName('Level 1/2 inspection', 0), '01 Level 1-2 inspection');
  assert.ok(!/[\\/:*?"<>|]/.test(folderName('a:b*c?d"e<f>g|h/i\\j', 0)));
});

test('two titles that truncate identically stay distinct by their number', () => {
  const a = folderName('Washing Machine Control Panel and Capacity Review', 0);
  const b = folderName('Washing Machine Control Panel and Load Sensors', 1);
  assert.notStrictEqual(a, b);
});

test('an empty title still yields a usable folder', () => {
  assert.strictEqual(folderName('', 4), '05 Untitled');
  assert.strictEqual(folderName(null, 0), '01 Untitled');
});
