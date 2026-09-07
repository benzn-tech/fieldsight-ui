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
