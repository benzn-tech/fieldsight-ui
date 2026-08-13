/* ==========================================================================
   api/recording-deletion.js — the rules behind deleting recordings
   --------------------------------------------------------------------------
   Backend spec: fieldsight-pipeline
     docs/superpowers/specs/2026-08-14-user-deletes-a-recording.md
   Endpoints (live on TEST and PROD, ENABLE_USER_DELETION=true):
     POST /api/org/recordings/delete    {recordings:[{folder,date,sessionBase}], reason}
       → {batch_id, results:[{recording, topics_hidden, error?}]}
     POST /api/org/recordings/undelete  {batchId}

   WHAT ACTUALLY HAPPENS, so nobody reading this later is misled by the
   customer-facing copy: nothing is erased. The backend writes a reversible,
   audited `redactions` row (`scope='deleted'`) per recording and per derived
   topic, and every read path filters on it. The S3 audio, transcripts and
   extractions stay. `POST /recordings/undelete` restores a batch, and it works
   INDEFINITELY — there is no TTL on `redactions`, no purge job, and no S3
   lifecycle rule tied to deletion (verified 2026-08-14 against the deployed
   stack, not the docs). The 24-hour window below is a UI affordance: how long
   the batch stays in the user's own restore list. It is NOT a purge.

   Three rules that fail silently if they are wrong:

   1. A row with no `sessionBase` is NOT selectable. `/sessions` returns
      `session_id: null` for report-sourced days — one S3 key for the whole
      day, so no per-session granularity exists in the data. The backend
      refuses those (`_source_prefixes_for` returns []), and its own comment
      says widening the prefix to the day would hide recordings the customer
      never selected, "silently, and phrased as success".

   2. `topics_hidden: 0` is a REPORTABLE OUTCOME, not a success. A delete that
      matched nothing and reported success is the worst result available here:
      the customer is told their recording is gone and it is not. The summary
      below keeps those rows separate so the UI can say so.

   3. Authorization is PER RECORDING. One unauthorized entry fails that entry
      only; the rest still commit. So the UI gates each row rather than
      sending a batch it knows will half-fail.

   Exported to:
     window.FS.recordingDeletion   (browser)
     module.exports                (node --test)
   ========================================================================== */

(function () {
  'use strict';

  /* How long a batch stays in the user's own restore list. Not a purge — see
     the header. After it drops off, the batch is still restorable through the
     endpoint; it is simply no longer offered here. */
  var RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

  var LEDGER_KEY = 'fs_deleted_batches_v1';
  var LEDGER_CAP = 10;

  /* Same list the backend's `_can_delete_folder` accepts on the role arm. */
  var DELETE_ROLES = ['admin', 'gm', 'platform_admin'];

  /* A recording the endpoint can actually address. */
  function isSelectable(row) {
    return !!(row && row.folder && row.date
              && typeof row.sessionBase === 'string' && row.sessionBase.trim());
  }

  /* Who may delete this row. The role arm OR ownership of the folder — the
     backend allows both, and a worker deleting their own mis-recording is the
     ordinary case. Gating per row means a mixed list never produces a batch
     that is half-refused. */
  function canDelete(row, caller) {
    if (!isSelectable(row)) return false;
    caller = caller || {};
    if (DELETE_ROLES.indexOf(String(caller.role || '')) !== -1) return true;
    return !!(caller.folder && caller.folder === row.folder);
  }

  function toRequest(rows, reason) {
    return {
      recordings: (rows || []).filter(isSelectable).map(function (r) {
        return { folder: r.folder, date: r.date, sessionBase: r.sessionBase };
      }),
      reason: String(reason || 'deleted by the user'),
    };
  }

  /* Match a per-recording result back to the row the user selected, so the UI
     can name it rather than echoing a folder/date/sid triple at them. */
  function _labelFor(rows, rec) {
    var hit = (rows || []).filter(function (r) {
      return r.folder === (rec || {}).folder && r.date === (rec || {}).date
        && r.sessionBase === (rec || {}).sessionBase;
    })[0];
    return (hit && hit.label) || ((rec && rec.date) || '') || 'recording';
  }

  /* Partition the response into the three things the user needs to be told
     apart. `nothingHidden` exists because a zero here is the one outcome that
     looks identical to success and is not. */
  function summariseResult(res, rows) {
    var results = (res && res.results) || [];
    var out = {
      batchId: (res && res.batch_id) || null,
      deleted: 0,
      topicsHidden: 0,
      nothingHidden: [],
      failed: [],
    };
    results.forEach(function (r) {
      var label = _labelFor(rows, r && r.recording);
      if (r && r.error) {
        out.failed.push({ label: label, error: r.error });
        return;
      }
      var hidden = (r && r.topics_hidden) || 0;
      out.deleted += 1;
      out.topicsHidden += hidden;
      if (hidden === 0) out.nothingHidden.push(label);
    });
    return out;
  }

  /* One line stating what happened, including the parts that are easy to
     swallow. Never collapses to a bare "Deleted". */
  function summaryLine(summary) {
    var s = summary || {};
    var parts = [];
    parts.push((s.deleted || 0) + ' recording' + ((s.deleted === 1) ? '' : 's') + ' deleted');
    parts.push((s.topicsHidden || 0) + ' topic'
      + ((s.topicsHidden === 1) ? '' : 's') + ' removed');
    var nothing = (s.nothingHidden || []).length;
    if (nothing) parts.push(nothing + ' had nothing to remove');
    var failed = (s.failed || []).length;
    if (failed) parts.push(failed + ' refused');
    return parts.join(' · ');
  }

  // -------- the local restore ledger --------

  function _storage(store) {
    if (store) return store;
    try { return window.localStorage; } catch (e) { return null; }
  }

  function readLedger(store) {
    var s = _storage(store);
    if (!s) return [];
    try {
      var raw = s.getItem(LEDGER_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      /* A corrupt ledger must not take the page down with it — the batches are
         still restorable through the endpoint either way. */
      return [];
    }
  }

  function _write(store, list) {
    var s = _storage(store);
    if (!s) return list;
    try { s.setItem(LEDGER_KEY, JSON.stringify(list)); } catch (e) { /* full/denied */ }
    return list;
  }

  function appendBatch(entry, nowMs, store) {
    if (!entry || !entry.batchId) return readLedger(store);
    var next = [{
      batchId: entry.batchId,
      at: nowMs,
      count: entry.count || 0,
      topicsHidden: entry.topicsHidden || 0,
      labels: (entry.labels || []).slice(0, 6),
    }].concat(readLedger(store).filter(function (b) {
      return b && b.batchId !== entry.batchId;
    })).slice(0, LEDGER_CAP);
    return _write(store, next);
  }

  function removeBatch(batchId, store) {
    var next = readLedger(store).filter(function (b) {
      return b && b.batchId !== batchId;
    });
    return _write(store, next);
  }

  /* Batches still inside the self-restore window. Expiry is computed on read
     rather than swept on a timer — a timer that never fires would leave stale
     entries offering a window that has closed. */
  function activeBatches(nowMs, store) {
    return readLedger(store).filter(function (b) {
      return b && typeof b.at === 'number' && (nowMs - b.at) < RESTORE_WINDOW_MS;
    });
  }

  function hoursLeft(batch, nowMs) {
    if (!batch || typeof batch.at !== 'number') return 0;
    var left = RESTORE_WINDOW_MS - (nowMs - batch.at);
    if (left <= 0) return 0;
    return Math.max(1, Math.ceil(left / (60 * 60 * 1000)));
  }

  var mod = {
    RESTORE_WINDOW_MS: RESTORE_WINDOW_MS,
    LEDGER_KEY: LEDGER_KEY,
    LEDGER_CAP: LEDGER_CAP,
    DELETE_ROLES: DELETE_ROLES,
    isSelectable: isSelectable,
    canDelete: canDelete,
    toRequest: toRequest,
    summariseResult: summariseResult,
    summaryLine: summaryLine,
    readLedger: readLedger,
    appendBatch: appendBatch,
    removeBatch: removeBatch,
    activeBatches: activeBatches,
    hoursLeft: hoursLeft,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    window.FS.recordingDeletion = mod;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();
