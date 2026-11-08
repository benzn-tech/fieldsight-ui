/* ==========================================================================
   FieldSight API · contact — the Contact FieldSight window's two calls.
   --------------------------------------------------------------------------
   POST {orgBaseUrl}/contact/transcribe  { audio, mime } → { text, error? }
   POST {orgBaseUrl}/contact/messages    { id, text, transcript, audio, mime,
                                           context:{name,company,project,page} }
                                         → 201 { id }
   (spec 2026-11-08 contact-fieldsight)

   Routed with FS.api.request and an explicit baseUrl, not orgRequest:
   orgRequest prefixes '/org', and these routes live beside /api/org on the
   same gateway (FieldSightApi), whose base already ends in /api.

   retry:false on both. A transcribe spends Ask STT credit per attempt, and a
   messages POST can send an email -- the server is idempotent on `id`, but a
   ladder of retries on a slow SES call is still a queue of duplicate work.
   timeoutMs 28000: the function's budget is 28 s and a 2-minute clip's
   transcription can take most of it; the 10 s default would cut it off.

   Bodies are built from named keys only. Identity is the authorizer's job;
   anything else a caller passes must not reach the server.

   Result shapes are request()'s: 404 (backend flag off) resolves to
   { _notFound: true }, 401/403 resolve to { _accessDenied: true }, and a
   429 throws an Error with .status 429 and .body.retry_after_s.
   ========================================================================== */
(function () {
  'use strict';
  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};

  var TIMEOUT_MS = 28000;
  var CHUNK = 0x8000;

  function api() { return window.FS.api; }

  function available() {
    var a = api();
    return !a.useMocks && !!a.orgBaseUrl;
  }

  function newId() {
    var c = window.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    if (c && c.randomUUID) return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var r = Math.random() * 16 | 0;
      return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /* arrayBuffer + chunked btoa: one path that runs the same in the browser and
     under node. Chunked because spreading a 500 KB array into fromCharCode
     overflows the argument limit. */
  async function blobToBase64(blob) {
    var bytes = new Uint8Array(await blob.arrayBuffer());
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(''));
  }

  function post(path, body) {
    return api().request(path, {
      method: 'POST',
      body: body,
      baseUrl: api().orgBaseUrl,
      retry: false,
      timeoutMs: TIMEOUT_MS,
    });
  }

  function str(v) { return v == null ? '' : String(v); }

  async function transcribe(blob, mime) {
    return post('/contact/transcribe', {
      audio: await blobToBase64(blob),
      mime: mime,
    });
  }

  async function send(payload) {
    var p = payload || {};
    var ctx = p.context || {};
    var hasAudio = !!p.blob;
    return post('/contact/messages', {
      id: p.id,
      text: str(p.text),
      transcript: p.transcript ? String(p.transcript) : null,
      audio: hasAudio ? await blobToBase64(p.blob) : null,
      mime: hasAudio ? (p.mime || null) : null,
      context: {
        name: str(ctx.name),
        company: str(ctx.company),
        project: str(ctx.project),
        page: str(ctx.page),
      },
    });
  }

  window.FS.api.contact = {
    available: available,
    transcribe: transcribe,
    send: send,
    newId: newId,
    blobToBase64: blobToBase64,
  };
})();
