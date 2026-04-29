/* ==========================================================================
   FieldSight API · Audio segments — BACKEND-CONTEXT §4.6
   --------------------------------------------------------------------------
   GET /api/audio-segments?date=&user=&start=HH:MM:SS&end=HH:MM:SS
   ========================================================================== */

(function () {
  'use strict';

  async function getAudioSegments(opts) {
    opts = opts || {};
    await window.FS.api.delay(100);
    return { segments: [], count: 0, _query: opts };
  }

  window.FS.api.audio = { getAudioSegments: getAudioSegments };

})();
