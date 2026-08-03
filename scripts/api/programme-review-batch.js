/* ==========================================================================
   FieldSight Programme — the breakdown review gate
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-08-03-programme-breakdown-allocation-design.md §3.5
   Plan: docs/superpowers/plans/2026-08-03-programme-breakdown-allocation.md Task 7b

   "框定一个范围，生成对应的 breakdown 的内容，我的人先 review，像是 report review
   一样，说 OK，这个大概符合我的想法，再点生成。"

   Scope a range, generate, a person reads it, then commit. Batch rather than
   per task, which is the only way it is worth anyone's time across thirty
   tasks.

   This is the batch's state, not its markup: which proposals a reviewer has
   accepted, rejected or edited, and what may therefore be written. Pure, so
   the rules below are testable without a browser.

   --------------------------------------------------------------------------
   THE RULE THIS EXISTS FOR

   Nothing is written until a person accepts it, and a REJECTED proposal must
   leave no trace. That is the one behavioural difference from the matcher's
   suggestion queue: a rejected suggestion changes nothing because it was only
   ever about an existing task, whereas a rejected breakdown would otherwise
   have created rows.

   So `writeSet` returns only accepted items, and an item is never accepted by
   default. Silence is not consent — a reviewer who scrolls past thirty
   proposals and presses Commit must write nothing, not everything.

   --------------------------------------------------------------------------
   WHY THIS IS NOT A SECOND REVIEW QUEUE

   The plan's Global Constraints forbid growing a second review surface. This
   module deliberately holds only what a BATCH needs — per-item decisions and
   a commit gate — and carries no fetching, no rendering and no decision
   endpoint of its own. The matcher's queue keeps owning single-suggestion
   review; this is the part that queue has no concept of.

   Pure: no React, no DOM, no fetch.

   Exported to:
     window.FS.api.programmeReviewBatch   (browser)
     module.exports                       (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* Each entry: { taskId, taskName, proposal, plan, decision, children }
       decision  'pending' | 'accepted' | 'rejected'
       plan      validateProposal's result — ok/errors/children
       children  the rows that would be written; edited copies live here so a
                 reviewer's change survives without touching `plan`. */
  function createBatch(items) {
    return (items || []).map(function (it) {
      var plan = it.plan || { ok: false, errors: ['No proposal.'], children: [] };
      return {
        taskId:   it.taskId,
        taskName: it.taskName || it.taskId,
        plan:     plan,
        /* Never 'accepted'. Silence is not consent. */
        decision: 'pending',
        children: (plan.children || []).map(function (c) {
          return Object.assign({}, c);
        }),
      };
    });
  }

  function _find(batch, taskId) {
    for (var i = 0; i < (batch || []).length; i++) {
      if (batch[i].taskId === taskId) return batch[i];
    }
    return null;
  }

  /* Returns a NEW batch; the caller holds it in state and React sees a
     changed reference. Mutating in place is how a review screen stops
     re-rendering after the third decision. */
  function decide(batch, taskId, decision) {
    return (batch || []).map(function (it) {
      if (it.taskId !== taskId) return it;
      /* A proposal that failed validation cannot be accepted. The reviewer
         is reading errors, not rows. */
      if (decision === 'accepted' && !it.plan.ok) return it;
      return Object.assign({}, it, { decision: decision });
    });
  }

  /* Accept everything that VALIDATED. Deliberately not "accept everything":
     a bulk action that also accepts what the validator refused would write
     rows nobody could have read. */
  function acceptAllValid(batch) {
    return (batch || []).map(function (it) {
      return it.plan.ok ? Object.assign({}, it, { decision: 'accepted' }) : it;
    });
  }

  function rejectAll(batch) {
    return (batch || []).map(function (it) {
      return Object.assign({}, it, { decision: 'rejected' });
    });
  }

  /* A reviewer editing one step of one proposal. Kept on `children` rather
     than on `plan`, so the original proposal stays visible next to the edit
     — the reviewer is judging the model, not just the result. */
  function editChild(batch, taskId, index, patch) {
    return (batch || []).map(function (it) {
      if (it.taskId !== taskId) return it;
      var next = it.children.slice();
      if (!next[index]) return it;
      next[index] = Object.assign({}, next[index], patch || {});
      return Object.assign({}, it, { children: next });
    });
  }

  /* What Commit would write: only accepted items, with their (possibly
     edited) children. Never the pending ones. */
  function writeSet(batch) {
    return (batch || [])
      .filter(function (it) { return it.decision === 'accepted' && it.plan.ok; })
      .map(function (it) {
        return { taskId: it.taskId, children: it.children };
      });
  }

  /* { total, accepted, rejected, pending, invalid, taskCount, rowCount,
       canCommit, blockedReason }

     `canCommit` is false while anything is still pending: a reviewer who
     scrolled past twenty proposals has not reviewed them, and committing a
     partial batch silently is exactly what the gate exists to prevent. They
     may reject the rest — that is a decision — but they may not skip it. */
  function summarise(batch) {
    var b = batch || [];
    var accepted = b.filter(function (i) { return i.decision === 'accepted'; });
    var rejected = b.filter(function (i) { return i.decision === 'rejected'; });
    var pending  = b.filter(function (i) { return i.decision === 'pending'; });
    var invalid  = b.filter(function (i) { return !i.plan.ok; });
    var rowCount = accepted.reduce(function (n, i) { return n + i.children.length; }, 0);

    var blockedReason = null;
    if (!b.length) {
      blockedReason = 'Nothing to review.';
    } else if (pending.length) {
      blockedReason = pending.length + ' proposal'
        + (pending.length === 1 ? ' has' : 's have')
        + ' not been reviewed yet.';
    } else if (!accepted.length) {
      blockedReason = 'Nothing was accepted.';
    }

    return {
      total: b.length,
      accepted: accepted.length,
      rejected: rejected.length,
      pending: pending.length,
      invalid: invalid.length,
      taskCount: accepted.length,
      rowCount: rowCount,
      canCommit: blockedReason === null,
      blockedReason: blockedReason,
    };
  }

  var api = {
    createBatch:    createBatch,
    decide:         decide,
    acceptAllValid: acceptAllValid,
    rejectAll:      rejectAll,
    editChild:      editChild,
    writeSet:       writeSet,
    summarise:      summarise,
    find:           _find,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeReviewBatch = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
