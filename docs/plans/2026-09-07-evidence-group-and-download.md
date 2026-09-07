# Evidence: Group by Topic + Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the Photos tab by topic and let a site manager download a selection as one zip whose folders are the topics.

**Architecture:** Three pure modules under `scripts/api/` (grouping, a store-only ZIP writer, the archive assembler) plus one additive prop set on `PhotoGrid` and the wiring in `evidence.js`. No backend, no new endpoint, no library.

**Tech Stack:** Vanilla ES2017 browser JS, in-browser Babel React. **No build step — do not add npm, webpack or vite.** Tests are `node:test` run as `node --test tests/*.test.js`.

**Spec:** `docs/specs/2026-09-07-evidence-group-by-topic-and-download.md` — read §2.1 first; it inverts the obvious reading of the measurement.

## Global Constraints

- **Every photo the page holds already has a topic** (spec §2.1). There is no ungrouped bucket to render. The grouping function still *returns* a remainder so a future list-photos endpoint trips a test instead of silently dropping photos.
- **A section is one `(date, user)` pair**, not one date (`evidence.js:297-323`). Selection and the zip name are scoped to a section. Never assume one section per date — a site manager sees several.
- **The photo object carries no timestamp.** It is `{filename, topic_id, topic_title, userDisplayName}`. Times are parsed from the filename.
- **`photoKey` takes `{userDisplayName, date, filename}`** — the display name, not a folder; `folderName()` is applied inside `media.js:78-81`.
- **A photo that fails to fetch still appears in the archive**, under `_MISSING/`. A silently short zip is the defect this feature most easily ships.
- **Register new `FS.api` modules AFTER `scripts/api/index.js`** in `app-shell-preview.html` — that file assigns `window.FS.api` wholesale and anything registered earlier is silently wiped.
- **Bump the `?v=` of every file you change** in `app-shell-preview.html`, or a local reload serves the cached copy and a working change reads as broken.

---

### Task 1: Grouping and names

**Files:**
- Create: `scripts/api/evidence-grouping.js`
- Test: `tests/evidence-grouping.test.js`

**Interfaces:**
- Produces: `FS.api.evidenceGrouping` with `photoTime(filename) -> string|null`, `groupByTopic(photos) -> {groups: [{topic_id, topic_title, photos}], ungrouped}`, `folderName(title, index) -> string`.

- [ ] **Step 1: Write the failing tests**

```javascript
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/evidence-grouping.test.js`
Expected: FAIL — `Cannot find module '../scripts/api/evidence-grouping.js'`

- [ ] **Step 3: Write the module**

```javascript
/* ==========================================================================
   api/evidence-grouping.js — the Photos tab, grouped by topic.

   Every photo the Evidence page holds arrives from
   report.topics[].related_photos (evidence.js:302-309), so it carries a topic
   BY CONSTRUCTION. `ungrouped` is therefore always empty in practice; it
   exists so that a future list-photos endpoint fails a test rather than
   silently dropping photos into nothing. See the spec's §2.1.

   Registers as FS.api.evidenceGrouping.
   ========================================================================== */
(function () {
  'use strict';

  var STAMP_RE = /_(\d{2})-(\d{2})-(\d{2})\.[a-z]+$/i;
  var KEYFRAME_RE = /_kf_s(\d{2})(\d{2})(\d{2})\.[a-z]+$/i;
  var MAX_FOLDER = 28;
  var ILLEGAL = /[\\/:*?"<>|]/g;

  /* 'HH-MM-SS', or null. Deliberately NOT a Date: the only thing needed is a
     sortable key within one day, and building a Date would drag in the NZDT
     trap (BUG-19) for no gain. Null means "no time in this name" and the
     caller sorts those last rather than guessing one. */
  function photoTime(filename) {
    var s = String(filename || '');
    var m = s.match(KEYFRAME_RE) || s.match(STAMP_RE);
    return m ? (m[1] + '-' + m[2] + '-' + m[3]) : null;
  }

  function byTime(a, b) {
    var ta = photoTime(a.filename), tb = photoTime(b.filename);
    if (ta && tb) return ta < tb ? -1 : (ta > tb ? 1 : a._i - b._i);
    if (ta) return -1;
    if (tb) return 1;
    return a._i - b._i;          /* both unknown: payload order */
  }

  function groupByTopic(photos) {
    var list = (photos || []).map(function (p, i) {
      return Object.assign({}, p, { _i: i });
    });
    var order = [], byId = {}, ungrouped = [];
    list.forEach(function (p) {
      if (!p.topic_id) { ungrouped.push(p); return; }
      if (!byId[p.topic_id]) {
        byId[p.topic_id] = { topic_id: p.topic_id,
                             topic_title: p.topic_title || '',
                             photos: [] };
        order.push(byId[p.topic_id]);
      }
      byId[p.topic_id].photos.push(p);
    });
    order.forEach(function (g) { g.photos.sort(byTime); });
    /* Groups ordered by their FIRST photo — the order the day happened in.
       A group whose photos all lack a time sorts last, by the order the
       payload gave, for the same reason a photo does. */
    order.sort(function (a, b) {
      var ta = photoTime(a.photos[0].filename);
      var tb = photoTime(b.photos[0].filename);
      if (ta && tb) return ta < tb ? -1 : (ta > tb ? 1 : 0);
      if (ta) return -1;
      if (tb) return 1;
      return a.photos[0]._i - b.photos[0]._i;
    });
    return { groups: order, ungrouped: ungrouped };
  }

  /* 'NN Title'. The number is the day's order, so a file manager sorting
     alphabetically still shows the day in sequence — and it is what keeps two
     titles that truncate to the same 28 characters apart. */
  function folderName(title, index) {
    var n = String(index + 1);
    if (n.length < 2) n = '0' + n;
    var t = String(title == null ? '' : title).replace(ILLEGAL, '-').trim();
    if (!t) return n + ' Untitled';
    if (t.length > MAX_FOLDER) {
      var cut = t.slice(0, MAX_FOLDER);
      var sp = cut.lastIndexOf(' ');
      t = (sp > 8 ? cut.slice(0, sp) : cut).replace(/[\s.-]+$/, '');
    }
    return n + ' ' + t;
  }

  var mod = { photoTime: photoTime, groupByTopic: groupByTopic,
              folderName: folderName };
  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.evidenceGrouping = mod;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/evidence-grouping.test.js`
Expected: PASS (13 tests)

- [ ] **Step 5: Revert-check**

Change `byTime`'s `if (ta) return -1;` to `return 0;` and re-run.
Expected: `an unparseable filename keeps payload order and sorts last` FAILS. Restore.

- [ ] **Step 6: Commit**

```bash
git add scripts/api/evidence-grouping.js tests/evidence-grouping.test.js
git commit -m "Group Evidence photos by the topic they already carry"
```

---

### Task 2: A store-only ZIP writer

**Files:**
- Create: `scripts/api/zip-store.js`
- Test: `tests/zip-store.test.js`

**Interfaces:**
- Produces: `FS.api.zipStore.build(entries) -> Uint8Array`, where `entries` is `[{path: string, bytes: Uint8Array}]`.

- [ ] **Step 1: Write the failing tests**

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('zlib');
const { build, crc32 } = require('../scripts/api/zip-store.js');

const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));

test('crc32 matches an independent implementation', () => {
  // Node's zlib.crc32 is the second opinion. It is ALSO the only thing zlib
  // can contribute here: it has no ZIP-container parser, and a store-only
  // archive has no zlib streams for it to read.
  const b = Buffer.from('hello world');
  assert.strictEqual(crc32(new Uint8Array(b)) >>> 0, zlib.crc32(b) >>> 0);
});

test('the archive starts with a local file header', () => {
  const out = build([{ path: 'a.txt', bytes: enc('hi') }]);
  assert.deepStrictEqual(Array.from(out.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
});

test('the central directory counts every entry', () => {
  const out = build([
    { path: '01 One/a.jpg', bytes: enc('a') },
    { path: '01 One/b.jpg', bytes: enc('bb') },
    { path: '02 Two/c.jpg', bytes: enc('ccc') },
  ]);
  const eocd = out.length - 22;
  const dv = new DataView(out.buffer, out.byteOffset);
  assert.strictEqual(dv.getUint32(eocd, true), 0x06054b50);
  assert.strictEqual(dv.getUint16(eocd + 10, true), 3);   // total entries
});

test('a real unzip reads back exactly what went in', () => {
  // The load-bearing test: a second implementation, not the writer agreeing
  // with itself. ASCII paths only -- see the UTF-8 test below for why unzip
  // cannot be trusted with the others on Windows.
  const out = build([
    { path: '01 Laundry Equipment/one.jpg', bytes: enc('first') },
    { path: '01 Laundry Equipment/two.jpg', bytes: enc('second') },
    { path: '02 Steam Heating/three.jpg', bytes: enc('third') },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const zip = path.join(dir, 't.zip');
  fs.writeFileSync(zip, Buffer.from(out));
  const listing = execFileSync('unzip', ['-l', zip], { encoding: 'utf8' });
  assert.ok(listing.includes('01 Laundry Equipment/one.jpg'), listing);
  assert.ok(listing.includes('02 Steam Heating/three.jpg'), listing);
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  assert.strictEqual(
    fs.readFileSync(path.join(dir, '01 Laundry Equipment/two.jpg'), 'utf8'),
    'second');
});

test('an empty archive is still a valid archive', () => {
  const out = build([]);
  assert.strictEqual(out.length, 22);
  const dv = new DataView(out.buffer, out.byteOffset);
  assert.strictEqual(dv.getUint32(0, true), 0x06054b50);
});

test('a non-ASCII path is written as UTF-8 with the flag that says so', () => {
  // NOT asserted through `unzip`. Info-ZIP's Windows build ignores general-
  // purpose bit 11 and decodes names in the local codepage, so it renders a
  // CORRECT archive as mojibake -- verified: the same file that unzip lists as
  // `03 ??+???` reads back as `03 楼层检查` through .NET's ZipFile, and the raw
  // bytes in the local header are valid UTF-8 with bit 11 set.
  //
  // Asserting on the unzip listing here would fail against a correct writer,
  // which is worse than not testing it. So this reads the archive's own bytes.
  const out = build([{ path: '01 楼层检查/a.jpg', bytes: enc('x') }]);
  const buf = Buffer.from(out);
  const flag = buf.readUInt16LE(6);
  const nlen = buf.readUInt16LE(26);
  assert.ok(flag & 0x0800, 'general-purpose bit 11 (UTF-8 name) must be set');
  assert.strictEqual(buf.slice(30, 30 + nlen).toString('utf8'), '01 楼层检查/a.jpg');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/zip-store.test.js`
Expected: FAIL — module not found.

If `unzip` is missing, run `which unzip`; on this machine it is under Git's `usr/bin`. Do **not** replace that test with a self-comparison.

- [ ] **Step 3: Write the module**

```javascript
/* ==========================================================================
   api/zip-store.js — a ZIP writer, `store` method only.

   No compression, and that is the point rather than a shortcut: the payload
   is JPEGs, which are already compressed, so deflate would burn CPU on a
   field laptop for no measurable gain. Dropping compression is what makes
   writing the format by hand SIMPLER than pulling in a library — which this
   repo cannot do anyway without a build step.

   Format: PKWARE APPNOTE 6.3.2, sections 4.3.7 (local header), 4.3.12
   (central directory) and 4.3.16 (end of central directory).

   Bit 11 of the general-purpose flag is set so the name is read as UTF-8;
   without it a non-ASCII topic title unzips as mojibake.

   Registers as FS.api.zipStore.
   ========================================================================== */
(function () {
  'use strict';

  var TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n += 1) {
      var c = n;
      for (var k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i += 1) {
      c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return Uint8Array.from(Buffer.from(s, 'utf8'));   /* node test path */
  }

  function build(entries) {
    var items = (entries || []).map(function (e) {
      var name = utf8(String(e.path));
      var bytes = e.bytes || new Uint8Array(0);
      return { name: name, bytes: bytes, crc: crc32(bytes) };
    });

    var localSize = items.reduce(function (n, it) {
      return n + 30 + it.name.length + it.bytes.length;
    }, 0);
    var centralSize = items.reduce(function (n, it) {
      return n + 46 + it.name.length;
    }, 0);

    var out = new Uint8Array(localSize + centralSize + 22);
    var dv = new DataView(out.buffer);
    var off = 0, offsets = [];

    items.forEach(function (it) {
      offsets.push(off);
      dv.setUint32(off, 0x04034b50, true);
      dv.setUint16(off + 4, 20, true);        /* version needed */
      dv.setUint16(off + 6, 0x0800, true);    /* bit 11: UTF-8 name */
      dv.setUint16(off + 8, 0, true);         /* method 0 = store */
      dv.setUint16(off + 10, 0, true);        /* time  — see note below */
      dv.setUint16(off + 12, 0x21, true);     /* date  = 1980-01-01 */
      dv.setUint32(off + 14, it.crc, true);
      dv.setUint32(off + 18, it.bytes.length, true);
      dv.setUint32(off + 22, it.bytes.length, true);
      dv.setUint16(off + 26, it.name.length, true);
      dv.setUint16(off + 28, 0, true);
      out.set(it.name, off + 30);
      out.set(it.bytes, off + 30 + it.name.length);
      off += 30 + it.name.length + it.bytes.length;
    });

    var centralStart = off;
    items.forEach(function (it, i) {
      dv.setUint32(off, 0x02014b50, true);
      dv.setUint16(off + 4, 20, true);
      dv.setUint16(off + 6, 20, true);
      dv.setUint16(off + 8, 0x0800, true);
      dv.setUint16(off + 10, 0, true);
      dv.setUint16(off + 12, 0, true);
      dv.setUint16(off + 14, 0x21, true);
      dv.setUint32(off + 16, it.crc, true);
      dv.setUint32(off + 20, it.bytes.length, true);
      dv.setUint32(off + 24, it.bytes.length, true);
      dv.setUint16(off + 28, it.name.length, true);
      dv.setUint16(off + 30, 0, true);
      dv.setUint16(off + 32, 0, true);
      dv.setUint16(off + 34, 0, true);
      dv.setUint16(off + 36, 0, true);
      dv.setUint32(off + 38, 0, true);
      dv.setUint32(off + 42, offsets[i], true);
      out.set(it.name, off + 46);
      off += 46 + it.name.length;
    });

    dv.setUint32(off, 0x06054b50, true);
    dv.setUint16(off + 8, items.length, true);
    dv.setUint16(off + 10, items.length, true);
    dv.setUint32(off + 12, centralSize, true);
    dv.setUint32(off + 16, centralStart, true);
    return out;
  }

  /* A fixed 1980-01-01 timestamp on every entry, deliberately. The real
     capture time is already in each photo's filename, which is preserved
     exactly; writing the DOWNLOAD's clock into the entries would put a second,
     wrong-looking date beside it in every file manager. */

  var mod = { build: build, crc32: crc32 };
  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.zipStore = mod;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/zip-store.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Revert-check**

Remove `dv.setUint16(off + 6, 0x0800, true)` from the LOCAL header and re-run.
Expected: `a non-ASCII path survives the round trip` fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add scripts/api/zip-store.js tests/zip-store.test.js
git commit -m "A ZIP writer, store only, because the payload is JPEG"
```

---

### Task 3: The archive assembler

**Files:**
- Create: `scripts/api/photo-archive.js`
- Test: `tests/photo-archive.test.js`

**Interfaces:**
- Consumes: Task 1's `groupByTopic`/`folderName`, Task 2's `build`, `FS.api.media.photoKey` + `getUrl`.
- Produces: `FS.api.photoArchive.buildArchive({photos, date, userDisplayName, fetchImpl}) -> Promise<{bytes, name, missing}>`.

- [ ] **Step 1: Write the failing tests**

```javascript
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/photo-archive.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```javascript
/* ==========================================================================
   api/photo-archive.js — selected photos -> one zip, folders named by topic.

   The rule this module exists to enforce: EVERY selected photo is accounted
   for. One that cannot be fetched still produces an entry, under _MISSING/,
   because a zip holding 47 of 53 photos is indistinguishable from a complete
   one and the person who forwards it to a client never finds out. This repo
   has shipped that shape twice — the collapse whose merged rows vanished, and
   1078 uploads that logged nothing on success.

   Registers as FS.api.photoArchive.
   ========================================================================== */
(function () {
  'use strict';

  /* Measured, not guessed: the busiest real day in the prod lake is 56 photos
     / 62.5 MB, so a day's archive sits far under this. The cap exists for the
     selection nobody has made yet. */
  var MAX_BYTES = 150 * 1024 * 1024;
  var BATCH = 6;

  async function buildArchive(opts) {
    var eg = window.FS.api.evidenceGrouping;
    var zip = window.FS.api.zipStore;
    var media = window.FS.api.media;
    var doFetch = opts.fetchImpl || window.fetch.bind(window);

    var grouped = eg.groupByTopic(opts.photos || []);
    var jobs = [];
    grouped.groups.forEach(function (g, i) {
      var folder = eg.folderName(g.topic_title, i);
      g.photos.forEach(function (p) {
        jobs.push({ path: folder + '/' + p.filename, filename: p.filename });
      });
    });

    var entries = [], missing = [], total = 0;
    for (var s = 0; s < jobs.length; s += BATCH) {
      /* Presigned URLs are requested in batches AS the archive is built rather
         than all up front: the TTL is 900 s (media.js) and a slow connection
         would otherwise expire the tail of a large selection. */
      var slice = jobs.slice(s, s + BATCH);
      var got = await Promise.all(slice.map(async function (j) {
        try {
          var key = media.photoKey({ userDisplayName: opts.userDisplayName,
                                     date: opts.date, filename: j.filename });
          var res = await media.getUrl(key);
          if (!res || !res.url) throw new Error('no presigned url');
          var r = await doFetch(res.url);
          if (!r || !r.ok) throw new Error('HTTP ' + ((r && r.status) || '?'));
          return { j: j, bytes: new Uint8Array(await r.arrayBuffer()) };
        } catch (err) {
          return { j: j, err: (err && err.message) || String(err) };
        }
      }));
      got.forEach(function (x) {
        if (x.err) { missing.push({ filename: x.j.filename, reason: x.err }); return; }
        total += x.bytes.length;
        entries.push({ path: x.j.path, bytes: x.bytes });
      });
      if (total > MAX_BYTES) {
        throw new Error('This selection is too large to package in the browser ('
          + Math.round(total / 1048576) + ' MB). Select fewer photos.');
      }
    }

    var missingText = '';
    if (missing.length) {
      missingText = 'These photos could not be downloaded:\n\n'
        + missing.map(function (m) { return m.filename + ' — ' + m.reason; }).join('\n')
        + '\n';
      entries.push({ path: '_MISSING/not-downloaded.txt',
                     bytes: new TextEncoder().encode(missingText) });
    }

    return {
      bytes: zip.build(entries),
      name: opts.date + ' ' + opts.userDisplayName + '.zip',
      paths: entries.map(function (e) { return e.path; }),
      missing: missing,
      missingText: missingText,
    };
  }

  var mod = { buildArchive: buildArchive, MAX_BYTES: MAX_BYTES };
  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.photoArchive = mod;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/photo-archive.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Revert-check**

Delete the `missing.push(...)` line so failures vanish silently, and re-run.
Expected: three tests fail, including `every selected photo is accounted for`. Restore.

- [ ] **Step 6: Commit**

```bash
git add scripts/api/photo-archive.js tests/photo-archive.test.js
git commit -m "Every selected photo is in the zip, present or accounted for"
```

---

### Task 4: Optional selection on PhotoGrid

**Files:**
- Modify: `scripts/composites/photo-grid.js`
- Test: `tests/photo-grid-selection.test.js`

`PhotoGrid` is used by `evidence.js`, `timeline.js`, `safety.js` and `quality.js`. The new props are **additive and inert when absent**, so those three are untouched.

**Interfaces:**
- Produces: props `selectable` (bool), `selectedFilenames` (object used as a set), `onToggleFilename(filename)`.

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'composites', 'photo-grid.js'), 'utf8');

test('selection is opt-in, so the other three consumers are unaffected', () => {
  // timeline.js, safety.js and quality.js render PhotoGrid without these
  // props. If the checkbox ever renders unconditionally it appears on three
  // pages that never asked for it.
  assert.match(SRC, /props\.selectable/);
  assert.ok(!/checkbox[\s\S]{0,200}?(?<!selectable\s*&&\s*)React\.createElement\('input'/
    .test(SRC) || /props\.selectable\s*&&/.test(SRC),
    'the checkbox must be gated on props.selectable');
});

test('the toggle is reported by filename, not by index', () => {
  // Index would break the moment the grid is re-grouped, which is exactly
  // what this feature does to it.
  assert.match(SRC, /onToggleFilename/);
  assert.ok(!/onToggleFilename\(\s*i\s*\)/.test(SRC),
            'toggling must pass the filename');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/photo-grid-selection.test.js`
Expected: FAIL — no `props.selectable` in the file.

- [ ] **Step 3: Add the props**

In the tile render, gated entirely on `props.selectable`, add a checkbox whose `checked` is `!!(props.selectedFilenames || {})[filename]` and whose `onChange` calls `props.onToggleFilename(filename)`. Stop the event from reaching the tile's existing open-lightbox handler.

Keying on the **filename** rather than the index is load-bearing: this feature re-groups the grid, so an index means something different before and after the toggle.

- [ ] **Step 4: Run both this and the full suite**

Run: `node --test tests/*.test.js`
Expected: PASS, and no existing PhotoGrid test breaks.

- [ ] **Step 5: Commit**

```bash
git add scripts/composites/photo-grid.js tests/photo-grid-selection.test.js
git commit -m "PhotoGrid can be selected from, when a caller asks"
```

---

### Task 5: Wire the Photos tab

**Files:**
- Modify: `scripts/pages/evidence.js`, `styles/composites.css`, `app-shell-preview.html`

- [ ] **Step 1: Fix the duplicate React key first, on its own**

`evidence.js:492` and `evidence.js:701` both use `key: day.date` while rows are per `(date, user)` (`evidence.js:297-323`). On a multi-user day React sees duplicate keys. Change both to `day.date + '|' + (day.user_folder || day.user_name || '')`.

This is a pre-existing bug, unrelated to the feature, and it goes in its own commit so it can be reverted independently.

```bash
git commit -m "One section per person per day, so keys stop colliding"
```

- [ ] **Step 2: Register the three modules**

In `app-shell-preview.html`, **after** `scripts/api/index.js` (that file assigns `window.FS.api` wholesale and anything before it is silently wiped):

```html
  <!-- feat/evidence-grouped-download — grouping, the zip writer and the
       archive assembler. All three MUST load after api/index.js. -->
  <script src="scripts/api/evidence-grouping.js?v=1"></script>
  <script src="scripts/api/zip-store.js?v=1"></script>
  <script src="scripts/api/photo-archive.js?v=1"></script>
```

and bump the `?v=` on `scripts/pages/evidence.js`, `scripts/composites/photo-grid.js` and `styles/composites.css`.

- [ ] **Step 3: Add the Group control**

Beside the existing toolbar on the Photos tab, using the same chip classes the Today page uses (`.fs-today__sort-btn` is the precedent; add `.fs-evidence__group-btn` mirroring it rather than reaching across page namespaces):

```
Group   [ By day ]  [ By topic ]
```

State lives in `PhotosTab`, defaults to `'day'`, and is **not persisted** — same reasoning as Today's order: a grouping is a per-visit question and the default has to serve arrival.

- [ ] **Step 4: Render per-topic sub-sections**

Under `'topic'`, replace the single `PhotoGrid` call with one per group, each preceded by a sub-header carrying the topic title and its count. `PhotoGrid` needs no change for this — it already takes a plain filename array.

- [ ] **Step 5: Add selection and the Download button**

Per section (one `(date, user)` row), a `useState({})` map keyed by filename — the same shape `DeletableMediaTab` uses at `evidence.js:529`. Section and topic checkboxes set the map; `Download (N)` is disabled at zero, and on click calls `buildArchive` then triggers the download:

```javascript
var blob = new Blob([res.bytes], { type: 'application/zip' });
var url = URL.createObjectURL(blob);
var a = document.createElement('a');
a.href = url; a.download = res.name;
document.body.appendChild(a); a.click(); a.remove();
setTimeout(function () { URL.revokeObjectURL(url); }, 0);
```

If `res.missing.length`, show a toast naming the count — the `_MISSING/` file inside the zip is the record, but a person who never opens the zip still deserves to know.

- [ ] **Step 6: Full suite**

Run: `node --test tests/*.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git commit -m "Group the Photos tab by topic, and hand back a folder"
```

---

### Task 6: Verify in the browser

Local preview only. **Do not verify against prod** — this branch is not deployed, and a green local run is the evidence for the PR.

- [ ] **Step 1: Serve on a port you have proved is free**

```bash
python -m http.server 8877
curl -s http://localhost:8877/scripts/api/zip-store.js | grep -c "0x04034b50"
```

A port already held by another session serves **a different directory**, which reads exactly like a stale file. The `curl` is the check.

- [ ] **Step 2: Open `?dev=1#/evidence`, Photos tab**

Confirm: the Group control renders; `By topic` produces sub-sections; **every sub-header count equals the tiles under it**; switching back restores the day view.

- [ ] **Step 3: Confirm the running code is the code you wrote**

```javascript
String(window.FS.api.evidenceGrouping.folderName)  // must contain the truncation
```

A cached `?v=` served the old file twice on 2026-09-07 and the first reading looked exactly like "the change does not work".

- [ ] **Step 4: Download one section and open the zip**

The folder names must match the sub-headers on screen, and the file count must match the button's `(N)`.

- [ ] **Step 5: Both themes**

Chips and sub-headers legible in light and dark. Status scale tokens do not theme-flip (CLAUDE.md) — pin a foreground if you use one.

- [ ] **Step 6: Open the PR to `dev`**

Include: the counts from §2 of the spec, what was verified in the browser, and the note that the CORS rule this depends on is out-of-band and in no template.
