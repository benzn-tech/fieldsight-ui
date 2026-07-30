/* ==========================================================================
   FieldSight API · qr-login — mint a one-time terminal login code.
   --------------------------------------------------------------------------
   POST /api/org/auth/qr/create (authed) — AURORA ORG WRITE, rides orgRequest
   (NOT window.FS.api.request, which hits the report gateway). Mirrors the
   orgRequest pattern used by writes in api/actions.js (see updateAction /
   createRedaction etc.): orgRequest(path, opts) prepends '/org' and routes
   at FS.api.orgBaseUrl, so orgRequest('/auth/qr/create', ...) hits
   POST /api/org/auth/qr/create.

   → resolves to { code, expiresAt, ttlSeconds } on success (orgRequest
     resolves the parsed JSON body directly, no .data unwrap), or to a
     { _accessDenied: true, error } envelope on 401/403 — callers (the
     Task 3 modal) must handle both shapes, same as every other org write.

   Mock gate is window.FS.api.useMocks ONLY (not writeMocks too) — a QR
   mint must fire whenever useMocks is off, even on a writeMocks-only env,
   so the terminal login flow isn't silently suppressed on a live site.
   ========================================================================== */
(function () {
  'use strict';
  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};

  async function create() {
    if (window.FS.api.useMocks) {
      /* Dev/mock: a fake code so the modal renders before the backend is live. */
      var now = Math.floor(Date.now() / 1000);
      return { code: 'MOCK-' + uuidish(), expiresAt: now + 90, ttlSeconds: 90 };
    }
    return window.FS.api.orgRequest('/auth/qr/create', { method: 'POST', body: {} });
  }

  function uuidish() {
    return (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : String(Math.random()).slice(2);
  }

  window.FS.api.qrLogin = { create: create };
})();
