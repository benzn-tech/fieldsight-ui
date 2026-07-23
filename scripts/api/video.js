/* ==========================================================================
   FieldSight API · Video segments — BACKEND-CONTEXT §4.7
   --------------------------------------------------------------------------
   GET /api/video-segments?date=&user=&start=HH:MM:SS&end=HH:MM:SS

   Always prefer is_preview:true (H264, browser-playable). Originals
   may be H265 and won't play in Chrome — fixture only ships previews;
   a hardcoded filter mirrors the production API's de-dupe behaviour.
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

  async function getVideoSegments(opts) {
    opts = opts || {};
    if (!window.FS.api.useMocks) {
      var params = { date: opts.date, user: opts.user, start: opts.start, end: opts.end };
      /* authority flip (pipeline plan 2026-07-14): the legacy /video-segments
         gateway resolves the caller from the OLD DynamoDB identity store,
         a different store than Aurora `users` — an Aurora-only account
         (e.g. a site_manager with no DynamoDB row) 403s there even though
         the video segment S3 objects exist. Mirrors transcripts.js's aurora
         gate verbatim; 'aurora' only takes effect when orgBaseUrl is
         non-empty (kill switch). */
      if (window.FS.api.timelineSource === 'aurora' && window.FS.api.orgBaseUrl) {
        return window.FS.api.orgRequest('/video-segments', { params: params });
      }
      return window.FS.api.request('/video-segments', { params: params });
    }
    await window.FS.api.delay(120);

    var bundle = lookup(opts.date, opts.user);
    if (!bundle) return { videos: [], count: 0 };

    var startSec = toSeconds(opts.start);
    var endSec   = toSeconds(opts.end);
    var BUFFER   = 60;

    var rows = (bundle.video || []).filter(function (v) {
      if (!v.is_preview) return false;
      if (startSec == null) return true;
      /* Each preview file covers ~10 minutes; accept if the file overlaps
         the window with the spec's 60s buffer either side. */
      var fileStart = v.video_start_sec;
      var fileEnd   = v.video_start_sec + 600;
      return fileEnd >= (startSec - BUFFER) && fileStart <= (endSec + BUFFER);
    }).map(function (v) {
      return Object.assign({}, v, {
        url: window.FS.api.mockPresignedUrl(v.key),
      });
    });

    return { videos: rows, count: rows.length };
  }

  window.FS.api.video = { getVideoSegments: getVideoSegments };

})();
