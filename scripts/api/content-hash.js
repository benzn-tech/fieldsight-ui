/* ==========================================================================
   FieldSight API · content-hash — JS twin of src/content_hash.py
   --------------------------------------------------------------------------
   The durable safety/quality "resolved" state (compliance_resolutions,
   backend migration 0025) is keyed on a re-extraction-stable natural
   identity: (company_id, site_id, report_date, domain, user_folder,
   content_hash) where content_hash = sha256(normalize(displayed text)).

   This module MUST compute normalize()/contentHash() byte-for-byte
   identically to src/content_hash.py, or a resolved mark written by the
   PATCH endpoint silently orphans when the read endpoint's map is rebuilt
   here — no error, just a flag that flips back to "open". A golden-fixture
   parity test (tests/content-hash.test.js, vendored from the backend's
   content_hash_golden.json) pins that guarantee.

   normalize(text) — the exact, ordered, cross-language spec (see the Python
   twin's docstring):
     1. None/null -> "" (a missing field hashes like an empty one).
     2. Unicode NFC normalize.
     3. Trim + collapse every internal run of whitespace to one U+0020
        (`text.trim().replace(/\s+/g, ' ')`, the twin of " ".join(text.split())).
     4. lowercase (the twin of Python casefold(); ASCII/Latin site text so the
        two agree — the golden fixtures pin the parity range; do NOT feed
        exotic-script text through this parity path without extending them).
     5. Punctuation is kept (meaningful; stripping widens collisions).

   contentHash(text) = sha256 hex of the UTF-8 bytes of normalize(text).

   SYNC on purpose: the aggregator's three row-building loops
   (compliance-aggregator.js) are synchronous forEach passes, so hashing must
   be callable inline without turning each into an async map. A compact,
   self-contained SHA-256 (no build step, no external lib, works in the
   browser <script> bundle and under Node's test runner) is used instead of
   the async SubtleCrypto digest.
   ========================================================================== */
(function () {
  'use strict';

  /* ---- normalize -------------------------------------------------------- */
  function normalize(text) {
    if (text === null || text === undefined) text = '';
    text = String(text);
    /* String.prototype.normalize exists in every browser we target and in
       Node; guard only so a wildly old engine degrades to raw text rather
       than throwing (it would still hash, just without NFC folding). */
    if (typeof text.normalize === 'function') text = text.normalize('NFC');
    text = text.trim().replace(/\s+/g, ' ');
    return text.toLowerCase();
  }

  /* ---- UTF-8 bytes ------------------------------------------------------- */
  /* TextEncoder is present in modern browsers and Node >=11. Fall back to a
     manual UTF-8 encoder so the module is fully self-contained. */
  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff) {           // high surrogate
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  /* ---- SHA-256 (FIPS 180-4), operating on a byte array ------------------ */
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rrot(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256Hex(bytes) {
    var H0 = 0x6a09e667, H1 = 0xbb67ae85, H2 = 0x3c6ef372, H3 = 0xa54ff53a,
        H4 = 0x510e527f, H5 = 0x9b05688c, H6 = 0x1f83d9ab, H7 = 0x5be0cd19;

    var l = bytes.length;
    var withOne = l + 1;
    var padZeros = (56 - (withOne % 64) + 64) % 64;
    var total = withOne + padZeros + 8;
    var buf = new Uint8Array(total);
    for (var b = 0; b < l; b++) buf[b] = bytes[b] & 0xff;
    buf[l] = 0x80;
    /* 64-bit big-endian bit length (message lengths here are tiny, but keep
       the full 64-bit form for correctness). */
    var bitLen = l * 8;
    var hi = Math.floor(bitLen / 0x100000000);
    var lo = bitLen >>> 0;
    buf[total - 8] = (hi >>> 24) & 0xff; buf[total - 7] = (hi >>> 16) & 0xff;
    buf[total - 6] = (hi >>> 8) & 0xff;  buf[total - 5] = hi & 0xff;
    buf[total - 4] = (lo >>> 24) & 0xff; buf[total - 3] = (lo >>> 16) & 0xff;
    buf[total - 2] = (lo >>> 8) & 0xff;  buf[total - 1] = lo & 0xff;

    var w = new Array(64);
    for (var i = 0; i < total; i += 64) {
      for (var t = 0; t < 16; t++) {
        w[t] = ((buf[i + 4 * t] << 24) | (buf[i + 4 * t + 1] << 16) |
                (buf[i + 4 * t + 2] << 8) | (buf[i + 4 * t + 3])) >>> 0;
      }
      for (t = 16; t < 64; t++) {
        var s0 = rrot(w[t - 15], 7) ^ rrot(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rrot(w[t - 2], 17) ^ rrot(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (((w[t - 16] + s0) >>> 0) + ((w[t - 7] + s1) >>> 0)) >>> 0;
      }
      var a = H0, c = H1, d = H2, e = H3, f = H4, g = H5, hh = H6, ii = H7;
      for (t = 0; t < 64; t++) {
        var S1 = rrot(f, 6) ^ rrot(f, 11) ^ rrot(f, 25);
        var ch = (f & g) ^ (~f & hh);
        var temp1 = (((ii + S1) >>> 0) + ((ch + K[t]) >>> 0) + w[t]) >>> 0;
        var S0 = rrot(a, 2) ^ rrot(a, 13) ^ rrot(a, 22);
        var maj = (a & c) ^ (a & d) ^ (c & d);
        var temp2 = (S0 + maj) >>> 0;
        ii = hh; hh = g; g = f; f = (e + temp1) >>> 0;
        e = d; d = c; c = a; a = (temp1 + temp2) >>> 0;
      }
      H0 = (H0 + a) >>> 0; H1 = (H1 + c) >>> 0; H2 = (H2 + d) >>> 0; H3 = (H3 + e) >>> 0;
      H4 = (H4 + f) >>> 0; H5 = (H5 + g) >>> 0; H6 = (H6 + hh) >>> 0; H7 = (H7 + ii) >>> 0;
    }

    return [H0, H1, H2, H3, H4, H5, H6, H7].map(function (x) {
      return ('00000000' + (x >>> 0).toString(16)).slice(-8);
    }).join('');
  }

  function contentHash(text) {
    return sha256Hex(utf8Bytes(normalize(text)));
  }

  /* Browser: register onto the shared api namespace (loaded as a plain
     <script> before compliance-aggregator.js). */
  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.complianceHash = { normalize: normalize, contentHash: contentHash };
  }

  /* Node test runner (CommonJS). No-op in the browser (module is undefined). */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalize: normalize, contentHash: contentHash };
  }
})();
