/* ==========================================================================
   FieldSight API · Transcripts — BACKEND-CONTEXT §4.5
   --------------------------------------------------------------------------
   GET /api/transcripts?date=&user=&start=HH:MM:SS&end=HH:MM:SS
   ========================================================================== */

(function () {
  'use strict';

  /* Sprint 2.1: ships an empty-but-shape-correct response. Phase C wires
     this to richer fixtures keyed by (date, user, time-range). */
  async function getTranscripts(opts) {
    opts = opts || {};
    await window.FS.api.delay(100);
    return {
      text:                   '',
      filtered_text:          '',
      segments:               [],
      speaker_segments:       [],
      speakers:               [],
      count:                  0,
      speaker_count:          0,
      total_speaker_segments: 0,
      _query: opts,
    };
  }

  window.FS.api.transcripts = { getTranscripts: getTranscripts };

})();
