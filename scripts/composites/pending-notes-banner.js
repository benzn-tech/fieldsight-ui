/* ==========================================================================
   FieldSight · pending-notes-banner
   --------------------------------------------------------------------------
   Owner, 2026-10-07: a recording that uploaded fine while our AI model is down
   must never fail silently. One banner per pending session (the caller's OWN,
   for the selected day) says the recording is safe and the notes will appear
   on their own, with an "Expedite" button that asks the backend for a prompt
   retry (model-fallback spec D6).

   - GET  /sessions/pending?date=   (FS.api.org.getPendingSessions)
   - POST /sessions/{id}/expedite   (FS.api.org.expediteSession)
   - Re-polls every 60 s while any banner shows. A session that leaves the
     list has recovered: its banner goes and onRecovered() asks the page to
     reload its data so the notes appear.
   - "Notified" is remembered per session for 10 minutes (localStorage, best
     effort) and also shown on load when the server's expedited_at is that
     recent.

   Pure helpers are exported for tests; the component is plain
   React.createElement (no JSX). Registers window.FieldSight.PendingNotesBanners.
   ========================================================================== */
(function () {
  'use strict';

  var POLL_MS = 60000;
  var NOTIFIED_MS = 10 * 60 * 1000;
  var STORE_KEY = 'fs.pendingNotes.expedited';

  var TEXT = {
    body: function (range) {
      return 'Your recording (' + range + ') was uploaded safely and won’t be lost. ' +
        'Our AI model is temporarily unavailable — we’re reconnecting automatically ' +
        'and will show your notes as soon as it recovers.';
    },
    button: 'Expedite',
    notified: 'We’ve been notified and are on it',
    retry: 'Couldn’t reach us — try again',
  };

  function readStore() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      var v = raw ? JSON.parse(raw) : {};
      return (v && typeof v === 'object') ? v : {};
    } catch (e) { return {}; }
  }

  function remember(sid, now) {
    try {
      var all = readStore();
      all[sid] = now;
      Object.keys(all).forEach(function (k) { if (now - all[k] > NOTIFIED_MS) delete all[k]; });
      window.localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch (e) { /* storage may be blocked; the in-memory state still holds */ }
  }

  /* True when this session was expedited within the last 10 minutes, by this
     browser (localStorage) or by anyone (server expedited_at). */
  function isNotified(session, now) {
    var local = readStore()[session.session_id];
    if (typeof local === 'number' && now - local < NOTIFIED_MS && now - local >= 0) return true;
    if (session.expedited_at) {
      var t = Date.parse(session.expedited_at);
      if (!isNaN(t) && now - t < NOTIFIED_MS) return true;
    }
    return false;
  }

  /* Session ids in `prev` that are no longer in `next` (they recovered). */
  function recoveredIds(prev, next) {
    var still = {};
    (next || []).forEach(function (s) { still[s.session_id] = true; });
    return (prev || []).filter(function (s) { return !still[s.session_id]; })
      .map(function (s) { return s.session_id; });
  }

  function orgApi() { return ((window.FS || {}).api || {}).org; }

  function PendingNotesBanners(props) {
    var h = React.createElement;
    var enabled = props.enabled !== false && !!props.date;

    var sRef = React.useState([]);   var sessions = sRef[0], setSessions = sRef[1];
    var nRef = React.useState({});   var notified = nRef[0], setNotified = nRef[1];
    var eRef = React.useState({});   var failed = eRef[0], setFailed = eRef[1];
    var bRef = React.useState({});   var busy = bRef[0], setBusy = bRef[1];
    var lastRef = React.useRef([]);
    var recoveredCb = React.useRef(null);
    recoveredCb.current = props.onRecovered;

    function apply(list) {
      var gone = recoveredIds(lastRef.current, list);
      lastRef.current = list;
      setSessions(list);
      if (gone.length && recoveredCb.current) recoveredCb.current(gone);
    }

    function poll(isAlive) {
      var org = orgApi();
      if (!org || !org.getPendingSessions) return Promise.resolve();
      return Promise.resolve(org.getPendingSessions({ date: props.date }))
        .then(function (res) {
          if (!isAlive()) return;
          apply((res && res.sessions) || []);
        })
        .catch(function (e) {
          if (window.console) window.console.warn('[pending] poll failed', e && e.message);
        });
    }

    /* Load on date change (and clear the previous day's banners at once). */
    React.useEffect(function () {
      var alive = true;
      lastRef.current = [];
      setSessions([]);
      if (!enabled) return undefined;
      poll(function () { return alive; });
      return function () { alive = false; };
    }, [props.date, enabled]);

    /* Re-poll while any banner shows. */
    var any = enabled && sessions.length > 0;
    React.useEffect(function () {
      if (!any) return undefined;
      var alive = true;
      var timer = setInterval(function () { poll(function () { return alive; }); }, POLL_MS);
      return function () { alive = false; clearInterval(timer); };
    }, [any, props.date]);

    function expedite(sid) {
      var org = orgApi();
      setBusy(function (b) { var n = Object.assign({}, b); n[sid] = true; return n; });
      setFailed(function (f) { var n = Object.assign({}, f); delete n[sid]; return n; });
      function done(ok) {
        setBusy(function (b) { var n = Object.assign({}, b); delete n[sid]; return n; });
        if (ok) {
          remember(sid, Date.now());
          setNotified(function (m) { var n = Object.assign({}, m); n[sid] = true; return n; });
        } else {
          setFailed(function (f) { var n = Object.assign({}, f); n[sid] = true; return n; });
        }
      }
      return Promise.resolve()
        .then(function () { return org.expediteSession(sid); })
        .then(function (res) { done(!!(res && (res.ok || res.alreadyExpedited))); })
        .catch(function (e) {
          if (e && e.status === 429) { done(true); return; }
          if (window.console) window.console.warn('[pending] expedite failed', e && e.message);
          done(false);
        });
    }

    if (!enabled || !sessions.length) return null;
    var now = Date.now();
    return h('div', { className: 'fs-pending-notes', 'data-testid': 'pending-notes' },
      sessions.map(function (s) {
        var sid = s.session_id;
        var isDone = !!notified[sid] || isNotified(s, now);
        return h('div', { key: sid, className: 'fs-pending-notes__banner', role: 'status' },
          h('div', { className: 'fs-pending-notes__text' }, TEXT.body(s.time_range || '')),
          h('div', { className: 'fs-pending-notes__actions' },
            isDone
              ? h('button', { type: 'button', disabled: true,
                  className: 'fs-btn fs-btn--secondary fs-btn--sm fs-pending-notes__btn' }, TEXT.notified)
              : h('button', { type: 'button', disabled: !!busy[sid],
                  className: 'fs-btn fs-btn--secondary fs-btn--sm fs-pending-notes__btn',
                  onClick: function () { expedite(sid); } }, TEXT.button),
            (!isDone && failed[sid])
              ? h('span', { className: 'fs-pending-notes__error' }, TEXT.retry) : null));
      }));
  }

  var exported = { PendingNotesBanners: PendingNotesBanners, isNotified: isNotified,
                   recoveredIds: recoveredIds, TEXT: TEXT, POLL_MS: POLL_MS, NOTIFIED_MS: NOTIFIED_MS };
  if (typeof window !== 'undefined') {
    if (!window.FieldSight) window.FieldSight = {};
    window.FieldSight.PendingNotesBanners = PendingNotesBanners;
    window.FieldSight._pendingNotes = exported;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
