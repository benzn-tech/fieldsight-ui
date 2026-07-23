/* ==========================================================================
   FieldSight API · Audio segments — BACKEND-CONTEXT §4.6
   --------------------------------------------------------------------------
   GET /api/audio-segments?date=&user=&start=HH:MM:SS&end=HH:MM:SS

   Each segment is short (5–90s) — built from VAD output. URLs are
   re-derived on every call to mimic 15-min presigned-URL expiry
   (BACKEND-CONTEXT §7) — callers MUST NOT cache.
   ========================================================================== */

(function () {
  'use strict';

  function toSeconds(t) {
    if (!t) return null;
    var parts = String(t).split(':').map(Number);
    if (parts.length < 2) return null;
    return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  }

  function lookup(date, user) {
    var media = window.FieldSight && window.FieldSight.fixtures && window.FieldSight.fixtures.media;
    if (!media || !media[date]) return null;
    var folder = window.FS.api.folderName(user || '');
    return media[date][folder] || null;
  }

  async function getAudioSegments(opts) {
    opts = opts || {};
    if (!window.FS.api.useMocks) {
      var params = { date: opts.date, user: opts.user, start: opts.start, end: opts.end };
      /* authority flip (pipeline plan 2026-07-14): the legacy /audio-segments
         gateway resolves the caller from the OLD DynamoDB identity store,
         a different store than Aurora `users` — an Aurora-only account
         (e.g. a site_manager with no DynamoDB row) 403s there even though
         the audio segment S3 objects exist. Mirrors transcripts.js's aurora
         gate verbatim; 'aurora' only takes effect when orgBaseUrl is
         non-empty (kill switch). */
      if (window.FS.api.timelineSource === 'aurora' && window.FS.api.orgBaseUrl) {
        return window.FS.api.orgRequest('/audio-segments', { params: params });
      }
      return window.FS.api.request('/audio-segments', { params: params });
    }
    await window.FS.api.delay(120);

    var bundle = lookup(opts.date, opts.user);
    if (!bundle) return { segments: [], count: 0 };

    var startSec = toSeconds(opts.start);
    var endSec   = toSeconds(opts.end);
    var BUFFER   = 60;

    var rows = (bundle.audio || []).filter(function (a) {
      if (startSec == null) return true;
      return a.absolute_end >= (startSec - BUFFER) && a.absolute_start <= (endSec + BUFFER);
    }).map(function (a) {
      var key = 'audio_segments/' + window.FS.api.folderName(opts.user || '')
              + '/' + opts.date + '/' + a.filename;
      return Object.assign({}, a, {
        url: window.FS.api.mockPresignedUrl(key),
      });
    });

    return { segments: rows, count: rows.length };
  }

  window.FS.api.audio = { getAudioSegments: getAudioSegments };

})();
