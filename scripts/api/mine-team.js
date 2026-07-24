/* ==========================================================================
   FieldSight · Mine/Team attribution predicate — fix/mine-team-attribution
   --------------------------------------------------------------------------
   Today (today-adapter.js's myTasks/teamTasks split) and Tasks
   (tasks.js's computeBuckets `mine` bucket + per-card `isMine` flag) used
   to each hand-roll their own `assignee === currentUserName` STRICT string
   check. Consequences that shipped:
     - an unassigned action item (assignee '', null, or the '—' placeholder)
       always fell to Team, where nobody triages it;
     - "Ben_Lin" (a folder-shaped name) vs "Ben Lin" (the display name)
       never matched;
     - stray case/whitespace differences never matched.
   One shared predicate, called by BOTH pages, so the two can't drift apart
   again.

   Decided rules (PLAN.md fix/mine-team-attribution):
     1. Normalized exact match — trim, collapse internal whitespace,
        case-insensitive compare of the free-text responsible/assignee
        against the viewer's display name.
     2. Folder-equality match — folderName(responsible) === viewerFolder
        (handles "Ben_Lin" vs "Ben Lin").
     3. Unassigned (null / '' / '—') is Mine ONLY when the item's OWNER
        folder (the report/row owner — NEVER the viewer) equals the
        viewer's folder. A site manager must not get every other
        unassigned item on the site dumped into "Mine".
     4. NO fuzzy/first-name matching. "Ben" must NOT match "Ben Lin" — it
        would also match "Ben Carter" on the same site and silently
        misattribute. Exact-normalized + folder equality only.

   viewerFolder resolution: PREFERS the real `folder_name` threaded from
   GET /api/org/me (session-bridge.js carries it onto AuthMock.currentUser
   .folder_name; today.js/tasks.js pass it through as viewer.folderName)
   and falls back to deriving it from the display name via
   window.FS.api.folderName when absent (mock/legacy callers) — see
   scripts/api/index.js's folderName() (display name, spaces -> '_').

   Exported to window.FS.api.isMineTask(responsible, ownerFolder, viewer)
   and (for the node test harness — mirrors today-adapter.js/tasks.js's own
   module.exports guard) module.exports.
   ========================================================================== */

(function () {
  'use strict';

  /* Trim + collapse internal whitespace + lower-case. Deliberately NOT
     fuzzy: this is an EXACT match modulo formatting noise, never a
     substring/first-name match. */
  function normalizeName(s) {
    return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /* An action item's raw responsible/assignee text counts as "unassigned"
     when it's null, empty, or the '—' placeholder Today/Tasks both render
     for a missing owner (today-adapter.js's `a.responsible || '—'`) —
     trimmed, so stray whitespace around any of those still counts. */
  function isUnassigned(text) {
    var t = String(text == null ? '' : text).trim();
    return t === '' || t === '—' /* — em dash */;
  }

  function resolveFolderName(name) {
    var fn = (window.FS && window.FS.api && window.FS.api.folderName)
      || function (n) { return String(n || '').replace(/\s+/g, '_'); };
    return fn(name);
  }

  /* isMineTask(responsible, ownerFolder, viewer)
       responsible  free-text assignee/responsible; may be unassigned
                    (null/''/'—').
       ownerFolder  the folder of whoever RECORDED this item (today-
                    adapter.js's `ownerFolder`; tasks-aggregator.js's
                    `user_folder`) — used ONLY by the unassigned rule
                    (rule 3 above), never for the assigned-name match.
       viewer       { name, folderName }. `folderName` is the viewer's
                    REAL folder_name when known (preferred); omitted/
                    null falls back to deriving it from `name`. */
  function isMineTask(responsible, ownerFolder, viewer) {
    viewer = viewer || {};
    var viewerName = viewer.name || '';
    var viewerFolder = viewer.folderName || (viewerName ? resolveFolderName(viewerName) : null);

    if (isUnassigned(responsible)) {
      return !!(ownerFolder && viewerFolder && ownerFolder === viewerFolder);
    }

    if (!viewerName && !viewerFolder) return false;

    if (viewerName && normalizeName(responsible) === normalizeName(viewerName)) return true;

    if (viewerFolder && resolveFolderName(responsible) === viewerFolder) return true;

    return false;
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.isMineTask = isMineTask;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isMineTask: isMineTask, normalizeName: normalizeName, isUnassigned: isUnassigned };
  }
})();
