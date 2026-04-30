/* ==========================================================================
   FieldSight API · _fetch — shared real-backend helper
   --------------------------------------------------------------------------
   Used by every FS.api.* module when window.FS.api.useMocks === false.

   Responsibilities:
     • Attach Authorization: <idToken>
     • Auto-refresh the token when it's within the refresh window
     • CloudFront SPA-fallback trap (BACKEND-CONTEXT §8.2 / BUG-20):
       a 404 may arrive as 200 with content-type:text/html. Always
       inspect content-type; if it isn't application/json, treat the
       response as { _notFound: true }.
     • Retry once on 401 after refreshing the session.
     • Surface 403 with role-aware payload (BACKEND-CONTEXT §8.4):
       returns { _accessDenied: true, error } so the UI can render an
       empathetic state instead of a generic toast.
     • Honour the no-localStorage rule for tokens — those live in
       sessionStorage via FS.session.

   Exported to:
     window.FS.api.request(path, opts)
       opts: {
         method:  'GET' | 'POST' | 'DELETE' | 'PUT'
         params:  object → query string (skips null/undefined)
         body:    object → JSON-encoded body
         signal:  AbortSignal
         allowAnon: boolean — skip auth header (e.g. /api/health)
       }
       → resolves to either:
            the JSON body, or
            { _notFound: true,     status, raw }, or
            { _accessDenied: true, status, error }
          and rejects on transport / unexpected errors.
   ========================================================================== */

(function () {
  'use strict';

  function buildQuery(params) {
    if (!params) return '';
    var parts = [];
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v == null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function isJsonResponse(res) {
    var ct = (res.headers.get && res.headers.get('content-type')) || '';
    return ct.indexOf('application/json') !== -1;
  }

  async function rawRequest(path, opts) {
    opts = opts || {};
    var base = (window.FS && window.FS.api && window.FS.api.baseUrl) || '/api';
    var url  = base + path + buildQuery(opts.params);

    var headers = Object.assign({}, opts.headers || {});
    if (opts.body !== undefined && opts.body !== null && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    if (!opts.allowAnon) {
      var token = window.FS.session && (await window.FS.session.ensureFresh());
      if (token) headers['Authorization'] = token;
    }

    return fetch(url, {
      method:  opts.method || 'GET',
      headers: headers,
      body:    opts.body !== undefined && opts.body !== null
                 ? (opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body))
                 : undefined,
      signal:  opts.signal,
    });
  }

  async function request(path, opts) {
    opts = opts || {};
    var res = await rawRequest(path, opts);

    /* 401 — refresh once and retry. */
    if (res.status === 401 && !opts._retried && window.FS.session) {
      var refreshed = await window.FS.session.refresh();
      if (refreshed) {
        return request(path, Object.assign({}, opts, { _retried: true }));
      }
      return { _accessDenied: true, status: 401,
               error: 'Sign-in expired. Please sign in again.' };
    }

    /* CloudFront HTML-404 trap (BUG-20) — never trust an HTML body. */
    if (!isJsonResponse(res)) {
      return { _notFound: true, status: res.status };
    }

    /* Some endpoints return a structured 200 body that the UI must
       still treat as not-found / disambiguation (e.g. /api/timeline).
       The body is parsed below; downstream callers handle those keys. */
    var body = null;
    try { body = await res.json(); } catch (e) { /* fallthrough */ }

    if (res.status === 403) {
      return {
        _accessDenied: true,
        status:        403,
        error:         (body && body.error) || 'Access denied.',
      };
    }
    if (res.status === 404) {
      return { _notFound: true, status: 404, raw: body };
    }
    if (!res.ok) {
      var err = new Error((body && body.message) || ('HTTP ' + res.status));
      err.status = res.status;
      err.body   = body;
      throw err;
    }

    return body;
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.request = request;

})();
