/* ==========================================================================
   FieldSight API · Ask conversations — spec 2026-10-22 ask-conversation-history
   --------------------------------------------------------------------------
   The palette's "Recent conversations" (FS_ASK_THREADS -> FS.api.askThreadsOn).
   The AskVoiceWorker stores each successful palette turn; org-api serves them:

     GET    /api/org/ask/threads       -> { threads: [{thread_id, title, updated_at, turns}] }
     GET    /api/org/ask/threads/{id}  -> { thread_id, scope, turns: [
                                             {turn_id, question, at, request, result}
                                           | {turn_id, question, at, request, withheld: true}] }
     DELETE /api/org/ask/threads/{id}  -> 204

   `updated_at` / `at` are epoch SECONDS (the backend is Python).

   Three readings of a response, and only one of them is "nothing":
     - 404 (_notFound): the backend has no routes, or ASK_THREADS is off there
       (spec §9: "org-api routes 404 -> section hidden"). list -> [], get -> null.
     - 403 (_accessDenied), a thrown 5xx, or a body that is not the contract's
       shape: a failure, rejected. An AccessDenied read as an empty list is a
       caller told they have no conversations when they do -- the caller hides
       the section on a rejection instead, which is honest about not knowing.
     - DELETE's 204 carries no JSON content-type, so request() resolves it as
       { _notFound, status: 204 }. That is the success, not a miss.

   No request at all with the flag off, in mock mode, or with no org base URL
   (the same gate api/org.js calls orgLive).

   Exported to: window.FS.api.askThreads
   ========================================================================== */

(function () {
  'use strict';

  var THREAD_ID_RE = /^[0-9a-f]{32}$/;

  function api() { return (window.FS && window.FS.api) || {}; }

  /* Read at call time, not load time: index.js builds FS.api after env.js. */
  function live() {
    var a = api();
    return !!a.askThreadsOn && !a.useMocks && !!a.orgBaseUrl;
  }

  function refused(res) {
    var e = new Error((res && res.error) || 'Access denied.');
    e.status = res && res.status;
    return e;
  }

  async function list() {
    if (!live()) return [];
    var res = await api().orgRequest('/ask/threads', { method: 'GET' });
    if (res && res._notFound) return [];
    if (res && res._accessDenied) throw refused(res);
    if (!res || !Array.isArray(res.threads)) {
      throw new Error('Unexpected response from /ask/threads.');
    }
    return res.threads;
  }

  /* null = no such thread for this caller (deleted, evicted, expired). */
  async function get(threadId) {
    if (!live() || typeof threadId !== 'string' || !THREAD_ID_RE.test(threadId)) return null;
    var res = await api().orgRequest('/ask/threads/' + threadId, { method: 'GET' });
    if (res && res._notFound) return null;
    if (res && res._accessDenied) throw refused(res);
    if (!res || !Array.isArray(res.turns)) {
      throw new Error('Unexpected response from /ask/threads/{id}.');
    }
    return res;
  }

  /* true once the server has acknowledged; idempotent there, so a repeat or
     an already-gone thread is also true. */
  async function remove(threadId) {
    if (!live() || typeof threadId !== 'string' || !THREAD_ID_RE.test(threadId)) return false;
    var res = await api().orgRequest('/ask/threads/' + threadId, { method: 'DELETE' });
    if (res && res._accessDenied) throw refused(res);
    return true;
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.askThreads = { list: list, get: get, remove: remove };

})();
