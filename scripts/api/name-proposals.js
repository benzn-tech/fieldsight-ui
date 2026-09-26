/* ==========================================================================
   FieldSight · name-proposals — voices waiting for somebody to say yes or no
   --------------------------------------------------------------------------
   After somebody names a speaker, the backend looks through the last 72 hours
   for other passages that sound like that person and queues them as questions.
   This store is what the bell reads to know they are there.

   WHY THE BELL AND NOT A TOAST. The questions are not urgent — nothing breaks
   if they wait a week — and the person who triggered them was in the middle of
   something else. A count on a bell is the whole of the interruption anybody
   on a site should get from this.

   THE TRUTH IS ON THE SERVER, WHICH IS WHY THIS IS NOT report-jobs. That store
   keeps jobs in localStorage because a report generation belongs to the browser
   that asked for it. A proposal belongs to the company: a colleague may answer
   it, it must survive this laptop, and Claude reads the answers back to
   calibrate a threshold. So this polls and holds nothing of its own — there is
   no local state that could disagree with the server.

   WHY THE COUNT MATTERS BEYOND THE BADGE. A company cannot get a calibrated
   rejection threshold until twenty of these have been answered, and until it
   has one, every automatic name stays a guess with a question mark. So a count
   that only ever grows is not a nagging inbox — it is the feature failing to
   arrive, reported. If this number climbs for weeks, that is the finding.

   Exposed as window.FS.nameProposals
   ========================================================================== */

(function () {
  'use strict';

  /* Slow on purpose. Proposals are created by a human naming somebody, which
     happens a few times a day at most, and this runs on every page. Polling
     faster would cost requests all day to notice something that arrives at
     walking pace. */
  var POLL_MS = 120000;

  var state = { people: [], total: 0, loaded: false, error: null };
  var subs = [];
  var timer = null;
  var inflight = null;

  function emit() {
    subs.slice().forEach(function (fn) {
      try { fn(snapshot()); } catch (e) { /* a bad subscriber must not stop the rest */ }
    });
  }

  function snapshot() {
    return {
      people: state.people.slice(),
      total: state.total,
      loaded: state.loaded,
      error: state.error,
    };
  }

  /* Returns the request already in flight rather than nothing. `afterNaming`
     awaits this and then reads the result; returning early while the bell's own
     poll was still running would hand it the answer from before the rename. */
  function refresh() {
    if (inflight) return inflight;       /* a slow response must not stack requests */
    inflight = doRefresh();
    return inflight;
  }

  async function doRefresh() {
    var org = ((window.FS || {}).api || {}).org;
    if (!org || !org.getNameProposals) { inflight = null; return; }
    try {
      var r = await org.getNameProposals();
      state.people = (r && r.people) || [];
      state.total = (r && r.total) || 0;
      state.error = null;
    } catch (e) {
      /* Keep the last good answer and record that this attempt failed. Blanking
         the list on a dropped request would read as "everything got answered",
         which is the opposite of what happened. */
      state.error = (e && e.message) || 'could not reach the server';
    } finally {
      state.loaded = true;
      inflight = null;
      emit();
    }
  }

  /* Somebody just named a speaker. Two things follow, on two clocks.

     NOW: if that person already has passages waiting from an earlier rename, open
     the dialog on them. They have just shown they care who this voice is, which
     is the moment they are most willing to spend ten seconds answering -- better
     than any reminder, and better than hoping they open the bell.

     IN ABOUT A MINUTE: the backend is embedding the passage they just named and
     will then look for others. Nothing exists to show yet, so poll again once it
     has had time, and let the bell pick the new ones up. Opening a dialog a
     minute later, while they are doing something else, would be an interruption
     they did not ask for. */
  async function afterNaming(displayName) {
    var name = String(displayName || '').trim().toLowerCase();
    await refresh();
    var hit = (state.people || []).find(function (p) {
      return String(p.displayName || '').trim().toLowerCase() === name;
    });
    if (hit && hit.pending > 0) {
      window.dispatchEvent(new CustomEvent('fs:open-name-proposals', {
        detail: { voiceprintId: hit.voiceprintId, displayName: hit.displayName },
      }));
    }
    setTimeout(refresh, 90000);
  }

  function start() {
    if (timer) return;
    refresh();
    timer = setInterval(refresh, POLL_MS);
  }

  function subscribe(fn) {
    subs.push(fn);
    start();
    fn(snapshot());
    return function () {
      var i = subs.indexOf(fn);
      if (i >= 0) subs.splice(i, 1);
    };
  }

  if (!window.FS) window.FS = {};
  window.FS.nameProposals = {
    subscribe: subscribe,
    refresh: refresh,
    get: snapshot,
    /* For the moment right after somebody names a speaker: the backend builds
       the candidates while the enrolment is embedded, which takes about a
       minute, so one immediate poll would ask before there is anything to
       find. */
    refreshSoon: function (ms) { setTimeout(refresh, ms || 90000); },
    afterNaming: afterNaming,
  };

})();
