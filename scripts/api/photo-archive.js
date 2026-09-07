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
