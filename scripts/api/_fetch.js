/* ==========================================================================
   FieldSight API · _fetch — shared real-backend helper
   --------------------------------------------------------------------------
   Used by every FS.api.* module when window.FS.api.useMocks === false.

   Responsibilities:
     • Attach Authorization: Bearer <accessToken>
     • Auto-refresh the token when it's within the refresh window
     • CloudFront SPA-fallback trap (BACKEND-CONTEXT §8.2 / BUG-20):
       a 404 may arrive as 200 with content-type:text/html. Always
       inspect content-type; if it isn't application/json, treat the
       response as { _notFound: true }.
     • Exponential retry (3 attempts, 1s/2s/4s) on 5xx and network errors.
     • Per-request 10 s timeout (overridable via opts.timeoutMs).
     • X-Request-Id header (UUID v4) for server-side correlation.
     • Retry once on 401 after refreshing the session.
     • Surface 403 with role-aware payload (BACKEND-CONTEXT §8.4):
       returns { _accessDenied: true, error } so the UI can render an
       empathetic state instead of a generic toast.
     • Honour the no-localStorage rule for tokens — those live in
       sessionStorage via FS.session.
     • Tell a cold backend apart from a broken one. Aurora is configured to
       pause when idle, and a resume after a long pause can outlast API
       Gateway's 29 s ceiling, so the first request of a quiet morning can
       fail while nothing is wrong. When EVERY attempt failed and every
       failure was a timeout or a 502/503/504, the thrown error carries
       `waking: true` and FS.wakingNotice (if loaded) is asked to say so in
       words. A 500 is NOT folded in: that is an application fault, and
       dressing it as "please wait" would hide a real bug.

   Exported to:
     window.FS.api.request(path, opts)
       opts: {
         method:    'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
         params:    object → query string (skips null/undefined)
         body:      object → JSON-encoded body
         signal:    AbortSignal
         allowAnon: boolean — skip auth header (e.g. /api/health)
         timeoutMs: number — per-request timeout in ms (default 10000)
         retry:     boolean — false to attempt once (default: retry 5xx and
                    network faults on a 1s/2s/4s ladder). Use false when a
                    retry re-runs work the first attempt is still doing.
         retryDelaysMs: number[] — override the ladder (also sets how many
                    attempts there are: delays.length + 1). Exists so a test
                    can exercise the exhausted path without sleeping 7 s.
       }
       → resolves to either:
            the JSON body, or
            { _notFound: true,     status, raw }, or
            { _accessDenied: true, status, error }
          and rejects on transport / unexpected errors.

     window.FS.api.setBaseUrl(url)
       Override the base URL at runtime (e.g. point at staging vs local).
   ========================================================================== */

(function () {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 10000;
  var RETRY_DELAYS_MS    = [1000, 2000, 4000];

  /* The statuses a paused-then-resuming backend produces, and only those.
     502/503/504 all mean "the thing in front of the app gave up waiting or
     found nothing listening"; a 500 means the app answered and the answer was
     a fault. Adding 500 here would make every server bug read as "please
     wait", which is worse than a blunt error because it stops anyone
     reporting it. */
  var WAKE_STATUSES = [502, 503, 504];

  function isWakeStatus(status) {
    return WAKE_STATUSES.indexOf(status) !== -1;
  }

  /* The notice is optional on purpose: _fetch.js loads in previews and under
     node with no DOM, and a missing composite must never turn a backend
     hiccup into a TypeError on top of it. */
  function wakingNotice() {
    var n = window.FS && window.FS.wakingNotice;
    return (n && typeof n.show === 'function' && typeof n.hide === 'function') ? n : null;
  }

  function showWaking() {
    var n = wakingNotice();
    if (n) { try { n.show(); } catch (e) { /* never break the request path */ } }
  }

  function hideWaking() {
    var n = wakingNotice();
    if (n) { try { n.hide(); } catch (e) { /* never break the request path */ } }
  }

  /* ---------- Utilities --------------------------------------------------- */

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

  function uuidV4() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /* BUG-20: CloudFront may serve a cached HTML shell as a 200 even for
     JSON-endpoint paths. Also guard against text/html arriving on any
     status (2xx or otherwise) — never trust an HTML body. */
  function isJsonResponse(res) {
    var ct = (res.headers.get && res.headers.get('content-type')) || '';
    /* Explicit text/html check (including status-200 CF trap): */
    if (ct.indexOf('text/html') !== -1) return false;
    return ct.indexOf('application/json') !== -1;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ---------- Transport-level fetch with timeout + retry ------------------ */

  /* One low-level fetch attempt with a per-request timeout.
     Returns the Response or throws on timeout/network error. */
  async function fetchWithTimeout(url, fetchOpts, timeoutMs) {
    var controller = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    /* Merge caller's AbortSignal with our timeout signal. */
    var callerSignal = fetchOpts.signal;
    if (callerSignal) {
      callerSignal.addEventListener('abort', function () { controller.abort(); });
    }

    try {
      return await fetch(url, Object.assign({}, fetchOpts, { signal: controller.signal }));
    } catch (err) {
      /* Our own deadline, not the caller's cancel and not a network fault.
         Left as the raw AbortError it reached the Ask box as the browser's
         DOMException text -- "signal is aborted without reason" -- which tells
         a user nothing and points at the backend, which was healthy. */
      if (timedOut) {
        var e = new Error('The request timed out after ' +
                          Math.round(timeoutMs / 1000) + 's.');
        e.name = 'TimeoutError';
        e.timeout = true;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /* Retry wrapper: retries on 5xx or network-level errors.
     4xx responses are returned immediately (caller decides). */
  async function fetchWithRetry(url, fetchOpts, timeoutMs, retry, delays) {
    /* `retry: false` is for requests where a second attempt is not free.
       /ask spends a RAG search and a model call per try, so retrying a slow
       answer buys a duplicate of the same work, four times the tokens, and a
       user who waits 47s to be told the agent was unreachable while four
       copies of their question are still being answered. */
    var ladder = (delays && delays.length) ? delays : RETRY_DELAYS_MS;
    var maxAttempts = retry === false ? 1 : ladder.length + 1;
    var lastErr;
    /* Does the WHOLE run look like a backend that is waking up? Starts true
       and is falsified by the first failure that does not fit, so a run that
       times out twice and then 500s is not reported as a wake. */
    var wakeShaped = true;
    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        var res = await fetchWithTimeout(url, fetchOpts, timeoutMs);
        if (res.status < 500) return res;          /* 1xx-4xx — no retry */
        lastErr = new Error('HTTP ' + res.status);
        lastErr.status = res.status;
        lastErr._response = res;                   /* carry body for callers */
        if (!isWakeStatus(res.status)) wakeShaped = false;
      } catch (err) {
        lastErr = err;
        /* AbortError from caller signal should not be retried. */
        if (err.name === 'AbortError' && fetchOpts.signal && fetchOpts.signal.aborted) {
          throw err;
        }
        /* Our own deadline counts as wake-shaped; anything else (DNS, CORS,
           offline) does not, because those do not get better by waiting. */
        if (!err.timeout) wakeShaped = false;
      }
      if (attempt < maxAttempts - 1) {
        await sleep(ladder[attempt]);
      }
    }
    /* All attempts exhausted — surface the last 5xx response if available,
       otherwise throw the transport error. Either way, carry the verdict:
       the Response is the only channel back to request() on the 5xx path,
       and it is an ordinary object, so the flag rides on it. */
    if (lastErr && lastErr._response) {
      lastErr._response._fsWaking = wakeShaped;
      return lastErr._response;
    }
    if (lastErr && wakeShaped) lastErr.waking = true;
    throw lastErr;
  }

  /* ---------- Auth-aware request ----------------------------------------- */

  async function rawRequest(path, opts) {
    opts = opts || {};
    var base = opts.baseUrl || (window.FS && window.FS.api && window.FS.api.baseUrl) || '/api';
    var url  = base + path + buildQuery(opts.params);

    var headers = Object.assign({}, opts.headers || {});

    /* X-Request-Id only on same-origin requests: the API Gateway preflight
       allow-list is Content-Type,Authorization — any extra header makes the
       browser's CORS preflight fail ("Failed to fetch"). Verified live A/B
       2026-07-03. Cross-origin tracing can return when the gateway allows it. */
    if (base.charAt(0) === '/') {
      headers['X-Request-Id'] = uuidV4();
    }

    if (opts.body !== undefined && opts.body !== null && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    if (!opts.allowAnon) {
      var session = window.FS && window.FS.session;
      if (session) {
        var token = await session.ensureFresh();
        if (token) {
          /* This API's Cognito REST authorizer validates the ID token passed
             RAW (no "Bearer " prefix) — mirrors the shipped fieldsight_v5
             frontend exactly. Access token / Bearer prefix → 401, and the
             gateway's 401 carries no CORS headers, so the browser surfaces
             it as "Failed to fetch". */
          headers['Authorization'] = token;
        }
      }
    }

    var timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

    return fetchWithRetry(url, {
      method:  opts.method || 'GET',
      headers: headers,
      body:    opts.body !== undefined && opts.body !== null
                 ? (opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body))
                 : undefined,
      signal:  opts.signal,
    }, timeoutMs, opts.retry, opts.retryDelaysMs);
  }

  async function request(path, opts) {
    opts = opts || {};
    var res;
    try {
      res = await rawRequest(path, opts);
    } catch (err) {
      /* The transport-error path never reaches the checks below, so the
         notice has to be raised here as well as at the 5xx branch. */
      if (err && err.waking) showWaking();
      throw err;
    }

    /* A response of ANY status is proof the backend answered, so the notice is
       retracted here rather than on a timer -- and before the 401/403/404
       early returns below, which are answers too. The one exception is the
       exhausted wake-shaped run, which arrives as a response and is the
       reason the notice exists. */
    if (!res._fsWaking) hideWaking();

    /* 401 — refresh once and retry. */
    if (res.status === 401 && !opts._retried && window.FS.session) {
      var refreshed = await window.FS.session.refresh();
      if (refreshed) {
        return request(path, Object.assign({}, opts, { _retried: true }));
      }
      return { _accessDenied: true, status: 401,
               error: 'Sign-in expired. Please sign in again.' };
    }

    /* BUG-20: Never trust an HTML body — catches CF cached-HTML 200 trap. */
    if (!isJsonResponse(res)) {
      return { _notFound: true, status: res.status };
    }

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
      /* org-api returns { error: "..." }; the report-side API returns
         { message: "..." }. Reading only `message` silently discarded every
         org-api explanation and left callers rendering "HTTP 409" — which is
         how a 409 that says WHICH rows a replace would discard reached the
         user as "Try again", advice that cannot work. */
      var err = new Error((body && (body.message || body.error))
                          || ('HTTP ' + res.status));
      err.status = res.status;
      err.body   = body;
      /* NOT returned as a { _waking: true } envelope in the style of
         _notFound / _accessDenied: every caller on this path reaches a
         `catch` today, and an envelope would be read as data by all of them
         at once. The flag rides on the error that was already being thrown. */
      if (res._fsWaking) {
        err.waking = true;
        showWaking();
      }
      throw err;
    }

    /* fix/read-cache-stale-after-write — a successful write (any non-GET)
       invalidates the module-level TTL read-cache (_cache.js). That cache
       assumes reports/date-index aren't edited in-app; life-conversation
       separation (redactions) + content-correction (topic/action/finding
       edits) now DO edit them, so without this a getTimeline/getDates read
       within the 3-min TTL served the stale pre-edit report until a full
       reload — the recurring "refresh still shows the old value". Clearing
       the whole cache is safe: worst case is one extra refetch. */
    var _method = (opts.method || 'GET').toUpperCase();
    if (_method !== 'GET' && window.FS && window.FS.api && window.FS.api.cache) {
      window.FS.api.cache.clear();
    }

    return body;
  }

  function setBaseUrl(url) {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.baseUrl = url;
  }

  /* Org backend channel: same request() machinery (auth, retries, error
     envelopes) but routed at FS.api.orgBaseUrl (a cross-origin absolute URL,
     so the X-Request-Id same-origin guard omits that header automatically).
     Callers in api/org.js only invoke this when orgBaseUrl is non-empty. */
  function orgRequest(path, opts) {
    opts = Object.assign({}, opts);
    opts.baseUrl = (window.FS && window.FS.api && window.FS.api.orgBaseUrl) || '';
    /* Org endpoints live under /api/org/* on the gateway, but orgBaseUrl ends
       at /prod/api — so prefix the logical path (/me → /org/me). api/org.js
       passes Lambda-internal route names (/me, /sites, …) and only calls this
       when orgBaseUrl is set (its orgLive gate), so no report-gateway leak. */
    return request('/org' + path, opts);
  }

  /* Bounded-concurrency Promise.all for the admin fan-out cross-products.
     (dates × users reaches 150+ requests on the 'All' range; an unbounded
     burst trips API Gateway throttling, whose 429s carry no CORS headers and
     so surface as opaque "Failed to fetch" rejections that killed the whole
     page.) Takes THUNKS (() => Promise), runs at most `limit` at a time, and
     maps a failed thunk to null instead of rejecting — partial data beats a
     dead page; callers filter(Boolean). */
  async function pooledAll(thunks, limit) {
    var results = new Array(thunks.length);
    var next = 0;
    async function worker() {
      while (next < thunks.length) {
        var i = next++;
        try { results[i] = await thunks[i](); }
        catch (e) { results[i] = null; }
      }
    }
    var workers = [];
    for (var w = 0; w < Math.min(limit || 8, thunks.length); w++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.request   = request;
  window.FS.api.setBaseUrl = setBaseUrl;
  window.FS.api.orgRequest = orgRequest;
  window.FS.api.pooledAll  = pooledAll;

})();
