/* ==========================================================================
   FieldSight API · Generic media presigner — BACKEND-CONTEXT §4.9
   --------------------------------------------------------------------------
   GET /api/media/presigned-url?key=<urlencoded S3 key>
     → { url:'<https presigned>', expires_in: 900 }

   Allowed prefixes: users/, audio_segments/, transcripts/, reports/, web_video/.
   URLs expire in 15 min — re-fetch on modal re-open, do NOT cache.
   ========================================================================== */

(function () {
  'use strict';

  async function presignedUrl(key) {
    if (!window.FS.api.useMocks) {
      return window.FS.api.request('/media/presigned-url', { params: { key: key } });
    }
    await window.FS.api.delay(40);
    return {
      url:        window.FS.api.mockPresignedUrl(key),
      expires_in: 900,
      key:        key,
    };
  }

  /* Convenience: build the S3 key for a topic.related_photos filename
     (BACKEND-CONTEXT §5.1 + §7). The folder name is the user's display
     name with spaces replaced by underscores. */
  function photoKey(opts) {
    return 'users/' + window.FS.api.folderName(opts.userDisplayName)
      + '/pictures/' + opts.date + '/' + opts.filename;
  }

  window.FS.api.media = {
    presignedUrl: presignedUrl,
    photoKey:     photoKey,
  };

})();
