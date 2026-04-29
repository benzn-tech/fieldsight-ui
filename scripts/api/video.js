/* ==========================================================================
   FieldSight API · Video segments — BACKEND-CONTEXT §4.7
   --------------------------------------------------------------------------
   GET /api/video-segments?date=&user=&start=HH:MM:SS&end=HH:MM:SS

   Always prefer is_preview:true (H264, browser-playable). Originals may
   be H265 and won't play in Chrome — the API already de-dupes.
   ========================================================================== */

(function () {
  'use strict';

  async function getVideoSegments(opts) {
    opts = opts || {};
    await window.FS.api.delay(100);
    return { videos: [], count: 0, _query: opts };
  }

  window.FS.api.video = { getVideoSegments: getVideoSegments };

})();
