/* ==========================================================================
   FieldSight API · Generic media presigner — BACKEND-CONTEXT §4.9
   --------------------------------------------------------------------------
   GET /api/media/presigned-url?key=<urlencoded S3 key>
     → { url:'<https presigned>', expires_in: 900 }

   Allowed prefixes: users/, audio_segments/, transcripts/, reports/, web_video/.
   URLs expire in 15 min.

   Sprint 8.8.4 — presigned URL cache with TTL.
   Each URL is cached with its expiresAt timestamp. If the URL would
   expire within 2 minutes of access, a fresh one is fetched first.
   Use getUrl(key) (or presignedUrl(key)) from callers; both return
   the same { url, expires_in, key } shape.
   ========================================================================== */

(function () {
  'use strict';

  /* Map<key, { url, expiresAt }> */
  var _urlCache = new Map();

  var REFRESH_LEAD_MS = 2 * 60 * 1000; /* re-fetch 2 min before expiry */

  async function _fetchFresh(key) {
    var res;
    if (!window.FS.api.useMocks) {
      var params = { key: key };
      /* authority flip (pipeline plan 2026-07-14): the legacy
         /media/presigned-url gateway resolves the caller from the OLD
         DynamoDB identity store, a different store than Aurora `users` —
         an Aurora-only account (e.g. a site_manager with no DynamoDB row)
         403s there even though the S3 object exists. Mirrors
         transcripts.js's aurora gate verbatim; 'aurora' only takes effect
         when orgBaseUrl is non-empty (kill switch). */
      if (window.FS.api.timelineSource === 'aurora' && window.FS.api.orgBaseUrl) {
        res = await window.FS.api.orgRequest('/media/presigned-url', { params: params });
      } else {
        res = await window.FS.api.request('/media/presigned-url', { params: params });
      }
    } else {
      await window.FS.api.delay(40);
      res = {
        url:        window.FS.api.mockPresignedUrl(key),
        expires_in: 900,
        key:        key,
      };
    }
    /* Do not cache failure sentinels (_accessDenied / _notFound from
       _fetch.js) — they resolve rather than throw, and res.url is
       undefined. Caching one here would poison the TTL cache for the
       remainder of the window, so a retry after the underlying
       permission/availability issue is fixed would still fail. */
    if (!res || !res.url) {
      _urlCache.delete(key);
      return res;
    }
    var expiresAt = Date.now() + (res.expires_in || 900) * 1000;
    _urlCache.set(key, { url: res.url, expiresAt: expiresAt });
    return res;
  }

  /* Main entry point — checks cache before hitting the server. */
  async function presignedUrl(key) {
    var cached = _urlCache.get(key);
    if (cached && (cached.expiresAt - Date.now()) >= REFRESH_LEAD_MS) {
      return { url: cached.url, expires_in: Math.round((cached.expiresAt - Date.now()) / 1000), key: key };
    }
    return _fetchFresh(key);
  }

  /* Alias used by PhotoGrid / VideoPlayer (PLAN Sprint 8.8.4). */
  var getUrl = presignedUrl;

  /* Convenience: build the S3 key for a topic.related_photos filename
     (BACKEND-CONTEXT §5.1 + §7). The folder name is the user's display
     name with spaces replaced by underscores. */
  function photoKey(opts) {
    return 'users/' + window.FS.api.folderName(opts.userDisplayName)
      + '/pictures/' + opts.date + '/' + opts.filename;
  }

  /* Q7 — DELETE /api/org/media/keyframe { s3_key }. Removes an
     auto-generated video keyframe (backend rejects any key whose basename
     doesn't match _kf_s\d{6}\.jpg and authorizes via the topic's
     content-edit tier; 200 on success, also 200 idempotent if already
     gone). AURORA ORG WRITE — same authority-flip gate as _fetchFresh
     above / transcripts.js's getTranscripts (mirrored verbatim): only
     rides orgRequest when timelineSource==='aurora' AND orgBaseUrl is set
     (kill switch). There is no legacy-gateway equivalent for this
     endpoint, so outside that gate we deliberately do NOT fall back to
     window.FS.api.request — we resolve the same _notFound envelope
     _fetch.js callers already know how to handle, with no network call.
     On success, evict the key from the presign TTL cache (module-level
     _urlCache above) so a re-render (or a sibling still holding the same
     key) can't serve a stale thumbnail for a now-deleted object. */
  async function deleteKeyframe(s3Key) {
    var res;
    if (!window.FS.api.useMocks) {
      if (window.FS.api.timelineSource === 'aurora' && window.FS.api.orgBaseUrl) {
        res = await window.FS.api.orgRequest('/media/keyframe', {
          method: 'DELETE', body: { s3_key: s3Key },
        });
      } else {
        res = { _notFound: true, error: 'Keyframe delete is not available on this backend.' };
      }
    } else {
      await window.FS.api.delay(60);
      res = { deleted: true, s3_key: s3Key };
    }
    if (res && !res._accessDenied && !res._notFound) {
      _urlCache.delete(s3Key);
    }
    return res;
  }

  window.FS.api.media = {
    presignedUrl:   presignedUrl,
    getUrl:         getUrl,
    photoKey:       photoKey,
    deleteKeyframe: deleteKeyframe,
  };

})();
