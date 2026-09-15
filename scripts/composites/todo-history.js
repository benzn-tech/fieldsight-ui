/* ==========================================================================
   FieldSight TodoHistory — Layer 5 composite
   --------------------------------------------------------------------------
   A to-do's provenance line and version list (docs/specs/2026-08-30-todo-
   history-card.md §2-3, numbering REPLACED by docs/specs/2026-09-15-todo-
   card-history-and-save-feedback.md §3.4). Not the CURRENT line — each host
   already renders that.

   Props:
     actionItemId  durable action_items.id; absent -> render/fetch nothing
     sessionId, sessionKind  from the owning topic
     date, folder  the report OWNER's day and folder (never the caller's)
     open          host-owned; NO request of any kind while false
     currentText   the to-do's current text (v1 when text was never edited)
     onVersion     (n) => void, optional — authoritative 1 + edits.length

   Exported to window.FieldSight.TodoHistory (helpers attached as statics).
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var NZ = 'Pacific/Auckland';

  function partsOf(fmt, d) {
    var p = {};
    fmt.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }

  /* 'Wed 7:00 am'. A zoned ISO is converted to NZ time; a naive ISO (the mock
     sessions) is already NZ wall-clock and is formatted as-is. */
  function formatWhen(iso) {
    if (!iso) return '';
    var s = String(iso).replace(' ', 'T');
    var zoned = /(Z|[+-]\d\d:?\d\d)$/.test(s);
    var d;
    if (zoned) {
      d = new Date(s);
    } else {
      var m = s.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/);
      if (!m) return '';
      d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    }
    if (isNaN(d.getTime())) return '';
    var p = partsOf(new Intl.DateTimeFormat('en-NZ', {
      timeZone: zoned ? NZ : 'UTC', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
    }), d);
    return p.weekday + ' ' + p.hour + ':' + p.minute + ' ' + String(p.dayPeriod || '').toLowerCase();
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* '2026-09-18' -> 'Fri 18 Sep' (calendar date, no time zone involved).
     Month is spelled out here (not via Intl 'short') because this ICU's
     'en-NZ' short month gives 'Sept', not the spec's 'Sep'. */
  function formatDeadline(v) {
    var m = String(v).match(/^(\d{4})-(\d\d)-(\d\d)/);
    if (!m) return String(v);
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var weekday = partsOf(new Intl.DateTimeFormat('en-NZ', {
      timeZone: 'UTC', weekday: 'short',
    }), d).weekday;
    return weekday + ' ' + (+m[3]) + ' ' + MONTHS[+m[2] - 1];
  }

  /* Four states (spec §3.3): extraction found / extraction not in sessions /
     report / unknown-or-absent with a null id (-> null, no line at all). */
  function provenanceFor(topic, sessions) {
    topic = topic || {};
    var id = topic.sessionId || null;
    if (topic.sessionKind === 'report') {
      return { kind: 'report', text: 'From the daily report', time: null, sessionId: null };
    }
    if (!id) return null;
    var s = (sessions || []).filter(function (x) { return x && x.session_id === id; })[0];
    if (s) {
      return { kind: 'extraction', text: 'From ' + (s.title || 'a recording'),
               time: formatWhen(s.started_at) || null, sessionId: id };
    }
    /* Never fall back to time_range: it is LLM free text (card spec §2). */
    return { kind: 'extraction', text: topic.sessionTitle ? 'From ' + topic.sessionTitle : 'From a recording',
             time: null, sessionId: null };
  }

  function fieldSentence(edit) {
    var after = edit && edit.after_text;
    if (after == null || after === '') return edit.field + ' cleared';
    return edit.field + ' changed to ' + (edit.field === 'deadline' ? formatDeadline(after) : after);
  }

  function editedBy(edit) {
    return 'edited by ' + ((edit && edit.actor_name) || 'someone');
  }

  /* spec §3.4: version = 1 + number of content_edits rows, any field.
     Server order is newest first. */
  function versionsFor(edits, currentText) {
    var list = (edits || []).filter(Boolean);
    if (!list.length) return [];
    var n = list.length;
    var out = list.map(function (e, i) {
      var isText = e.field === 'text';
      return {
        version: n + 1 - i,
        heading: 'v' + (n + 1 - i),
        body:    isText ? (e.after_text || '') : fieldSentence(e),
        isText:  isText,
        who:     editedBy(e),
        when:    formatWhen(e.created_at),
      };
    });
    var oldestText = null;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].field === 'text') { oldestText = list[i]; break; }
    }
    out.push({
      version: 1, heading: 'v1 · as recorded',
      body: oldestText ? (oldestText.before_text || '') : (currentText || ''),
      isText: true, who: null, when: null,
    });
    return out;
  }

  function defaultDeps() {
    var api = window.FS && window.FS.api;
    return { org: api && api.org, actions: api && api.actions };
  }

  /* The request decision. Returns null — having called NOTHING — unless the
     host says open and the row has a durable id. History is never cached;
     sessions go through the shared cached read. 404/403 read as empty. */
  function loadTodoHistory(props, deps) {
    if (!props || !props.open || !props.actionItemId) return null;
    deps = deps || defaultDeps();
    if (!deps.actions || !deps.actions.getContentHistory) return null;
    var wantSessions = !!(props.sessionId && props.date && props.folder
                          && deps.org && deps.org.getSessionsCached);
    var sessionsP = wantSessions
      ? Promise.resolve(deps.org.getSessionsCached(props.date, props.folder)).then(function (r) {
          return (r && !r._accessDenied && !r._notFound && r.sessions) || [];
        }, function () { return []; })
      : Promise.resolve([]);
    var historyP = Promise.resolve(deps.actions.getContentHistory('action_items', props.actionItemId))
      .then(function (r) {
        return (r && !r._notFound && !r._accessDenied && Array.isArray(r.edits)) ? r.edits : [];
      }, function () { return []; });
    return Promise.all([sessionsP, historyP]).then(function (v) {
      return { sessions: v[0], edits: v[1] };
    });
  }

  function modelFor(props, loaded) {
    loaded = loaded || { sessions: [], edits: [] };
    return {
      provenance: provenanceFor({ sessionId: props.sessionId, sessionKind: props.sessionKind }, loaded.sessions),
      versions:   versionsFor(loaded.edits, props.currentText),
    };
  }

  function TodoHistoryView(props) {
    var h = React.createElement;
    var prov = props.provenance;
    var versions = props.versions || [];
    if (!prov && !versions.length) return null;
    return h('div', { className: 'fs-todo-history' },
      prov ? h('div', { className: 'fs-todo-history__provenance' },
        prov.text,
        prov.time ? ' · ' + prov.time : null,
        prov.sessionId && props.onOpenMeeting ? h(React.Fragment, null, ' · ',
          h('button', {
            type: 'button', className: 'fs-todo-history__link',
            onClick: function (e) { e.preventDefault(); e.stopPropagation(); props.onOpenMeeting(prov.sessionId); },
          }, 'open the meeting')) : null,
      ) : null,
      versions.length ? h('ol', { className: 'fs-todo-history__versions' },
        versions.map(function (v) {
          return h('li', { key: v.version, className: 'fs-todo-history__version' },
            h('div', { className: 'fs-todo-history__heading' },
              h('span', { className: 'fs-todo-history__tag' }, v.heading),
              v.when ? h('span', { className: 'fs-todo-history__when' }, v.when) : null),
            h('div', { className: 'fs-todo-history__body' + (v.isText ? '' : ' fs-todo-history__body--field') }, v.body),
            v.who ? h('div', { className: 'fs-todo-history__who' }, v.who) : null);
        })) : null,
    );
  }

  function TodoHistory(props) {
    var dataRef = React.useState({ status: 'idle', sessions: [], edits: [] });
    var data = dataRef[0], setData = dataRef[1];
    var tickRef = React.useState(0);
    var tick = tickRef[0], setTick = tickRef[1];
    var onVersionRef = React.useRef(props.onVersion);
    onVersionRef.current = props.onVersion;

    /* Fetch on each transition to open, and again after a matching save.
       Never append optimistically (card spec §5). */
    React.useEffect(function () {
      var p = loadTodoHistory(props);
      if (!p) { setData({ status: 'idle', sessions: [], edits: [] }); return undefined; }
      var alive = true;
      setData(function (d) { return d.status === 'ok' ? d : { status: 'loading', sessions: [], edits: [] }; });
      p.then(function (r) {
        if (!alive) return;
        setData({ status: 'ok', sessions: r.sessions, edits: r.edits });
        if (onVersionRef.current) onVersionRef.current(1 + r.edits.length);
      });
      return function () { alive = false; };
    }, [props.open, props.actionItemId, props.sessionId, props.date, props.folder, tick]);

    React.useEffect(function () {
      var events = window.FS && window.FS.events;
      if (!props.open || !props.actionItemId || !events || !events.onContentEdited) return undefined;
      return events.onContentEdited('action_items', props.actionItemId, function () {
        setTick(function (n) { return n + 1; });
      });
    }, [props.open, props.actionItemId]);

    if (!props.open || !props.actionItemId) return null;
    if (data.status !== 'ok') {
      return React.createElement('div', { className: 'fs-todo-history fs-todo-history--loading' }, 'Loading history…');
    }
    var model = modelFor(props, data);
    return React.createElement(TodoHistoryView, {
      provenance: model.provenance,
      versions:   model.versions,
      onOpenMeeting: function (sessionId) {
        var router = window.FS && window.FS.Router;
        if (!router) return;
        router.navigate('/timeline?date=' + encodeURIComponent(props.date)
          + '&user=' + encodeURIComponent(props.folder)
          + '&session=' + encodeURIComponent(sessionId));
      },
    });
  }

  var helpers = {
    formatWhen: formatWhen, formatDeadline: formatDeadline, provenanceFor: provenanceFor,
    fieldSentence: fieldSentence, editedBy: editedBy, versionsFor: versionsFor,
    loadTodoHistory: loadTodoHistory, modelFor: modelFor,
  };

  TodoHistory.View = TodoHistoryView;
  Object.keys(helpers).forEach(function (k) { TodoHistory[k] = helpers[k]; });

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TodoHistory = TodoHistory;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign({ TodoHistory: TodoHistory, TodoHistoryView: TodoHistoryView }, helpers);
  }
})();
