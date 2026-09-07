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
