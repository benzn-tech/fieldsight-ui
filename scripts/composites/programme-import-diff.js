/* ==========================================================================
   FieldSight Programme Import Diff — the reconcile step of the import modal
   --------------------------------------------------------------------------
   Re-importing a revised programme is the moment work gets destroyed, so this
   screen's whole job is to make the two modes cost different things out loud.

   Update lists what CHANGES. Replace lists what it DESTROYS, and deliberately
   omits the update counts — they would soften a warning that should not be
   softened. Replace's cost is not visible from the reconciliation plan at all:
   it is measured in what Update would have preserved, which is why the server's
   dry run returns it as its own block.

   The guard against clicking through Replace is not a confirm dialog — those
   get clicked through — it is requiring the site name to be typed while the
   losses are on screen.

   describeDiff / canCommit / commitPayload are pure so they can be tested
   under Node; the component below is the presentation around them.

   Exported to:
     window.FieldSight.ProgrammeImportDiff   (browser)
     module.exports                          (node:test)
   ========================================================================== */

(function () {
  'use strict';

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /* Lines for the chosen mode. Zero-valued lines are omitted rather than
     rendered as "0 tasks moved" — a list of zeroes reads as noise and buries
     the counts that are real. */
  function describeDiff(mode, preview) {
    preview = preview || {};

    if (mode === 'replace') {
      var r = preview.replace_preview || {};
      return [
        'Will discard ' + plural(r.local_tasks_discarded || 0,
          'task created here', 'tasks created here'),
        plural(r.allocations_discarded || 0, 'allocation', 'allocations'),
        plural(r.tasks_with_progress_discarded || 0,
          'task with recorded progress', 'tasks with recorded progress'),
        'The current version is archived first, so this can be rolled back.',
      ];
    }

    if (mode === 'new') {
      return ['Imported as a second programme for this site. '
              + 'Nothing existing is changed.'];
    }

    var u = preview.update_preview || {};
    var lines = [
      plural(u.updated || 0, 'task updated', 'tasks updated'),
      plural(u.added || 0, 'task added', 'tasks added'),
      plural(u.removed || 0, 'task no longer in the file',
        'tasks no longer in the file') + ' — hidden, not deleted',
    ];
    if (u.date_shifted) {
      lines.push(plural(u.date_shifted, 'task moved', 'tasks moved')
        + ', by up to ' + (u.max_shift_days || 0) + ' days');
    }
    if (u.archived_with_parent) {
      lines.push(plural(u.archived_with_parent, 'local subtask archived',
        'local subtasks archived') + ' with their parent');
    }
    var lm = (u.locally_modified_overwritten || []).length;
    if (lm) {
      lines.push(plural(lm, 'task you edited here', 'tasks you edited here')
        + ' will be overwritten by the file');
    }
    return lines;
  }

  /* Replace destroys work that Update would keep. Typing the site name does
     not happen by accident; clicking a confirm button does. Compared exactly:
     a case-insensitive or trimmed match would let a half-read prompt through,
     and an empty site name must never make an empty input pass. */
  function canCommit(mode, state) {
    if (mode !== 'replace') return true;
    var typed = (state && state.typed) || '';
    var name = (state && state.siteName) || '';
    return !!name && typed === name;
  }

  /* The body for the committing call. `dry_run` is deliberately absent rather
     than false — the server branches on its presence. */
  function commitPayload(mode, parsed, state) {
    state = state || {};
    var payload = {
      mode: mode,
      parents: (parsed && parsed.parents) || [],
      leaves: (parsed && parsed.leaves) || [],
    };
    if (parsed && parsed.filename) payload.filename = parsed.filename;
    if (mode === 'replace') payload.confirm_replace = true;

    var accepted = (state.renameCandidates || []).filter(function (c) {
      return (state.acceptedRenames || {})[c.existing_id];
    });
    /* Omitted entirely when nothing was accepted: an empty array would make
       the server re-reconcile for no reason. */
    if (accepted.length) payload.accept_renames = accepted;
    return payload;
  }

  var api = {
    describeDiff:  describeDiff,
    canCommit:     canCommit,
    commitPayload: commitPayload,
  };

  if (typeof window !== 'undefined') {
    if (!window.FieldSight) window.FieldSight = {};
    window.FieldSight.ProgrammeImportDiff = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
