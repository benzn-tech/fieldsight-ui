/* ==========================================================================
   FieldSight Programme Version History — the rollback safety net
   --------------------------------------------------------------------------
   Every import writes a version row, so a Replace that turned out to be wrong
   can be undone. This drawer's job is to make each row legible enough that
   someone can tell which version they want back months later, without
   remembering what they did that day.

   Summaries are rendered with the SAME describeDiff used at import time, so
   the history reads identically to the moment the decision was made. If the
   two ever diverge, a PM comparing them concludes the record is wrong.

   Nothing a restore does is a deletion — it flips `removed_in_version` — and
   the restore itself records a version for the state it leaves, so it is
   reversible too. The copy says both, because a safety net people are afraid
   of is not a safety net.

   describeVersion / canRestore / restoreWarning are pure so they can be tested
   under Node; the component below is the presentation around them.

   Exported to:
     window.FieldSight.ProgrammeVersionHistory   (browser)
     module.exports                              (node:test)
   ========================================================================== */

(function () {
  'use strict';

  var MANAGER_ROLES = ['pm', 'gm', 'admin', 'project_manager',
                       'construction_manager', 'director'];

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /* One or more lines describing what a version did. Delegates to the import
     screen's own copy so history and the moment of decision read the same. */
  function describeVersion(version) {
    var s = (version && version.diff_summary) || {};

    if (s.restored_from != null) {
      return ['Rolled back — restored from version ' + s.restored_from];
    }
    if (version && version.mode === 'initial') {
      return ['First import' + (s.tasks ? ' · ' + plural(s.tasks, 'task', 'tasks') : '')];
    }
    if ((version && version.mode === 'replace') || s.mode === 'replace') {
      return ['Replaced the whole programme'
              + (s.tasks != null ? ' · ' + plural(s.tasks, 'task', 'tasks') : '')];
    }

    var helpers = (typeof window !== 'undefined' && window.FieldSight
                   && window.FieldSight.ProgrammeImportDiff)
      || (typeof require === 'function' ? safeRequireDiff() : null);
    if (helpers) return helpers.describeDiff('update', { update_preview: s });

    /* No helper available (module load order in a stripped harness) — say
       something true rather than nothing. */
    return ['Updated from an imported file'];
  }

  function safeRequireDiff() {
    try {
      return require('./programme-import-diff.js');
    } catch (e) {
      return null;
    }
  }

  /* The current version is already the state of the programme; offering to
     restore it invites a destructive-looking action that does nothing. */
  function canRestore(version, ctx) {
    if (!version || !ctx) return false;
    if (version.version_no >= ctx.current) return false;
    return MANAGER_ROLES.indexOf(ctx.role) !== -1;
  }

  /* Names the version, says how far back it steps, and says the rollback is
     itself reversible. Deliberately does NOT say anything is deleted —
     nothing is, and claiming otherwise would stop people using the safety net
     that exists for them. */
  function restoreWarning(version, ctx) {
    var steps = Math.max(0, (ctx && ctx.current ? ctx.current : 0) - version.version_no);
    return 'Roll the programme back to version ' + version.version_no
      + ', undoing ' + plural(steps, 'import', 'imports') + '. '
      + 'The current state is archived first, so this can itself be undone.';
  }

  var api = {
    describeVersion: describeVersion,
    canRestore:      canRestore,
    restoreWarning:  restoreWarning,
    MANAGER_ROLES:   MANAGER_ROLES,
  };

  if (typeof window !== 'undefined') {
    if (!window.FieldSight) window.FieldSight = {};
    window.FieldSight.ProgrammeVersionHistory = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
