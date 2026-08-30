/* ==========================================================================
   FieldSight AskChat — Layer 5 composite (Sprint 2.7 / PLAN Phase G)
   --------------------------------------------------------------------------
   Q&A strip backed by /api/ask (BACKEND-CONTEXT §4.12).

   The backend is STATELESS — every question is independent and the API
   doesn't carry conversation memory (BACKEND-CONTEXT §10). The chat
   illusion is reconstructed client-side: we keep messages[] in local
   state for display, but each request sends only the one question.
   No prior turns are forwarded in the body.

   Two scoping modes:
     • scope='transcript' + topic_id → grounds answers to ONE topic's
       time range (used in TopicDetail's Ask tab)
     • scope='both' (default) → grounds to the whole report (transcript
       + report) — used by the per-report Ask card on /timeline

   Worker rule (BACKEND-CONTEXT §3, §8.5): the server forces user=self
   for workers. We pass the user param along and trust the API to
   override; no UI gating needed beyond that.

   Props:
     date            'YYYY-MM-DD'
     user            folder-name string (optional — server handles default)
     scope           'report' | 'transcript' | 'both'  (default 'both')
     topic_id        number | null
     placeholder     string for the input (e.g. "Ask about this topic…")
     suggestions     string[] of pre-canned questions (clickable chips)
     compact         boolean — render in a tighter layout for sidebars
     initialQuestion optional string — auto-sends once on mount (Search's
                     "Ask FieldSight" hand-off: the question was already
                     committed in the palette, so it fires immediately).

   Exported to:
     window.FieldSight.AskChat
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* Parse a chunk's source_s3_key (reports/{date}/{user_folder}/daily_report.json)
     into the Timeline deep-link params. Returns null if the shape is unexpected
     (transcript-window chunks still carry the report key, so this holds). */
  function citationTarget(sourceKey) {
    var parts = (sourceKey || '').split('/');
    if (parts[0] !== 'reports' || parts.length < 3) return null;
    return { date: parts[1], user: parts[2] };
  }

  /* One line saying what the answer was built from.

     Composed HERE from the numbers the backend computed, and never asked of the
     model — a model asked to phrase it would sooner or later say "three
     meetings" over a single excerpt, and nothing downstream could catch that.

     An earlier version of this comment said SP-Ask rendered the same dict as a
     spoken clause. It did not: the voice response was built from scratch and
     dropped `basis` at the boundary. The backend now carries it (pipeline
     #633), the device does not speak it yet, and this is the only renderer
     there is — written in the present tense on purpose, unlike the sentence it
     replaced.

     `widened` is the case that has to speak up. The person asked about
     yesterday and is being shown the 27th — answering from another day without
     saying so is the original defect wearing a date.

     Returns null when there is no basis (an older backend, or the legacy
     non-RAG path). A line reading "based on nothing" is worse than no line. */
  function formatAnswerBasis(basis) {
    if (!basis || !basis.chunks) return null;
    var dates = basis.dates || [];
    var n = basis.chunks;
    var tail = ' · ' + n + ' excerpt' + (n === 1 ? '' : 's');
    if (basis.widened) {
      return 'Nothing in the period asked about — based on ' + basis.from + ' instead' + tail;
    }
    if (!basis.from && !basis.to) {
      return 'Based on all records you can see' + tail;
    }
    if (basis.from === basis.to) {
      return 'Based on ' + basis.from + tail;
    }
    var span = 'Based on ' + basis.from + ' to ' + basis.to;
    if (dates.length > 1) span += ' · ' + dates.length + ' days';
    return span + tail;
  }

  /* Render the citations block under an assistant answer. Every field is passed
     as a React text child (auto-escaped) — the snippet/topic/site come from
     retrieved chunk text (transcripts) and must never reach innerHTML. */
  function renderCitations(citations) {
    if (!citations || !citations.length) return null;
    return React.createElement('div', { className: 'fs-ask-chat__citations' },
      React.createElement('div', { className: 'fs-ask-chat__citations-label' },
        'Sources · ' + citations.length),
      citations.map(function (c, i) {
        var tgt = citationTarget(c.source_s3_key);
        var meta = [c.site_name, c.report_date].filter(Boolean).join(' · ');
        var onOpen = tgt && window.FS && window.FS.Router
          ? function () {
              var url = '/timeline?date=' + encodeURIComponent(tgt.date)
                + '&user=' + encodeURIComponent(tgt.user);
              /* Deep-link to the specific topic so the Timeline opens + flashes
                 it (matched by title — see timeline.js). */
              if (c.topic_title) url += '&topicTitle=' + encodeURIComponent(c.topic_title);
              /* A2-2 — transcript-window citations carry an absolute HH:MM:SS
                 time_start (backend A2-1); topic citations have it null, so
                 this only fires for transcript citations. Timeline reads
                 params.turnTime and, once the cited topic opens, passes it
                 down to TranscriptList as highlightTime so the exact line
                 scrolls into view and flashes (transcript-list.js). */
              if (c.time_start) url += '&turnTime=' + encodeURIComponent(c.time_start);
              /* Cross-project Ask citation → sync the top-bar project selector
                 to the cited report's project (联动 — Timeline reads params.site).
                 site_slug is the selector's identifier (NOT the site UUID). */
              if (c.site_slug) url += '&site=' + encodeURIComponent(c.site_slug);
              window.FS.Router.navigate(url);
            }
          : null;
        return React.createElement('div', {
          key: i,
          className: 'fs-ask-chat__cite' + (onOpen ? ' fs-ask-chat__cite--link' : ''),
          role: onOpen ? 'button' : null,
          tabIndex: onOpen ? 0 : null,
          onClick: onOpen,
          onKeyDown: onOpen ? function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
          } : null,
        },
          React.createElement('span', { className: 'fs-ask-chat__cite-num' }, '[' + (i + 1) + ']'),
          React.createElement('div', { className: 'fs-ask-chat__cite-body' },
            meta ? React.createElement('div', { className: 'fs-ask-chat__cite-meta' }, meta) : null,
            c.topic_title
              ? React.createElement('div', { className: 'fs-ask-chat__cite-title' }, c.topic_title)
              : null,
            c.snippet
              ? React.createElement('div', { className: 'fs-ask-chat__cite-snippet' }, c.snippet)
              : null,
          ),
        );
      }),
    );
  }

  function AskChat(props) {
    var date     = props.date;
    var user     = props.user;
    var scope    = props.scope || 'both';
    var topic_id = props.topic_id != null ? props.topic_id : null;

    /* messages: [{ role: 'user'|'assistant', text, citations?, model? }] */
    var refMsgs = React.useState([]);
    var msgs    = refMsgs[0];
    var setMsgs = refMsgs[1];

    var refQ = React.useState('');
    var q    = refQ[0];
    var setQ = refQ[1];

    var refBusy = React.useState(false);
    var busy    = refBusy[0];
    var setBusy = refBusy[1];

    var listRef = React.useRef(null);

    /* Task C — one-shot hand-off from Search's "Ask FieldSight" row. Runs
       once on mount only ([] deps). AUTO-SENDS: the user already typed and
       committed the question in the search palette — landing them on a
       silently prefilled input read as "nothing happened" (user feedback
       2026-07-06). */
    React.useEffect(function () {
      if (props.initialQuestion) send(props.initialQuestion);
    }, []);

    /* Auto-scroll the message list to the bottom whenever it grows. */
    React.useEffect(function () {
      var el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [msgs.length, busy]);

    /* When scope keys change (e.g. user switched topics), drop history
       since prior context no longer applies. */
    React.useEffect(function () {
      setMsgs([]);
    }, [date, user, scope, topic_id]);

    function send(question) {
      if (!question || busy) return;
      var userMsg = { role: 'user', text: question };
      setMsgs(function (m) { return m.concat([userMsg]); });
      setQ('');
      setBusy(true);

      /* The alerts route (routing spec 3.5). Answered here rather than by
         the agent because every signal is already on the client and none of
         it is a retrieval problem: overdue, blocked, behind baseline, and
         tasks nobody has mentioned.

         Only available when the mounting page supplies programme context via
         `alertsProvider`. Without it the route does not exist and every
         question goes to the agent exactly as before — this component knows
         nothing about programme state on its own.

         The answer says which path it took. A route the reader cannot see is
         a route they cannot correct. */
      var alerts = window.FS.api.programmeAlerts;
      if (alerts && props.alertsProvider && alerts.isAlertsQuestion(question)) {
        var built = null;
        try {
          built = alerts.buildAlerts(props.alertsProvider() || {});
        } catch (e) { built = null; }
        if (built) {
          setMsgs(function (m) { return m.concat([{
            role:  'assistant',
            text:  alerts.formatAlerts(built),
            route: 'alerts',
          }]); });
          setBusy(false);
          return;
        }
        /* Falling through to the agent is the right failure: retrieval is
           this product's normal answer, and it is the recoverable one. */
      }

      window.FS.api.ask.ask({
        date:     date,
        user:     user,
        scope:    scope,
        topic_id: topic_id,
        question: question,
      }).then(function (res) {
        setMsgs(function (m) { return m.concat([{
          role:      'assistant',
          text:      res.answer || '',
          citations: res.citations || [],
          model:     res.model,
          /* What the backend actually searched. Absent on the legacy path and
             on older deploys, which formatAnswerBasis renders as no line. */
          basis:     res.basis || null,
        }]); });
      }).catch(function (err) {
        setMsgs(function (m) { return m.concat([{
          role:  'assistant',
          text:  'Could not reach the agent. ' + (err && err.message || ''),
          error: true,
        }]); });
      }).then(function () {
        setBusy(false);
      });
    }

    function onSubmit(e) {
      if (e) e.preventDefault();
      var trimmed = (q || '').trim();
      if (!trimmed) return;
      send(trimmed);
    }

    var className = 'fs-ask-chat' + (props.compact ? ' fs-ask-chat--compact' : '');

    return React.createElement('div', { className: className },

      /* Suggestions row — only shown while history is empty. */
      props.suggestions && props.suggestions.length > 0 && msgs.length === 0
        ? React.createElement('div', { className: 'fs-ask-chat__suggestions' },
            props.suggestions.map(function (s, i) {
              return React.createElement('button', {
                key: i, type: 'button',
                className: 'fs-ask-chat__suggestion',
                onClick:   function () { send(s); },
                disabled:  busy,
              }, s);
            })
          )
        : null,

      /* Message log */
      React.createElement('div', {
        className: 'fs-ask-chat__messages',
        ref:       listRef,
      },
        msgs.length === 0 && (!props.suggestions || props.suggestions.length === 0)
          ? React.createElement('div', { className: 'fs-ask-chat__empty' },
              'Ask anything grounded in this ' + (topic_id != null ? 'topic.' : 'report.'))
          : null,

        msgs.map(function (m, i) {
          return React.createElement('div', {
            key: i,
            className: 'fs-ask-chat__msg fs-ask-chat__msg--' + m.role
              + (m.error ? ' fs-ask-chat__msg--error' : ''),
          },
            /* Assistant replies are markdown → render via the safe renderer
               (it HTML-escapes first, then emits only a fixed tag set, so
               dangerouslySetInnerHTML carries no LLM-supplied markup). User
               messages are the person's own typed question → keep plain. */
            m.role === 'assistant' && window.FieldSight.renderMarkdown
              ? React.createElement('div', {
                  className: 'fs-ask-chat__msg-text fs-ask-chat__msg-text--md',
                  dangerouslySetInnerHTML: { __html: window.FieldSight.renderMarkdown(m.text) },
                })
              : React.createElement('div', { className: 'fs-ask-chat__msg-text' },
                  m.text),
            /* Above the citations and below the answer: it qualifies the whole
               answer, so it must be readable before the reader decides whether
               to trust it — and it is one line, not a card. */
            m.role === 'assistant' && formatAnswerBasis(m.basis)
              ? React.createElement('div', {
                  className: 'fs-ask-chat__basis'
                    + (m.basis && m.basis.widened ? ' fs-ask-chat__basis--widened' : ''),
                }, formatAnswerBasis(m.basis))
              : null,
            m.role === 'assistant' ? renderCitations(m.citations) : null,
            m.role === 'assistant' && m.model
              ? React.createElement('div', { className: 'fs-ask-chat__model' },
                  m.model)
              : null,
            /* Which route answered. The routing spec requires the answer to
               say — a route the reader cannot see is one they cannot
               correct. */
            m.route === 'alerts'
              ? React.createElement('div', { className: 'fs-ask-chat__model' },
                  'from the programme, not the reports')
              : null,
          );
        }),

        busy ? React.createElement('div', {
          className: 'fs-ask-chat__msg fs-ask-chat__msg--assistant fs-ask-chat__msg--pending',
        },
          React.createElement('span', { className: 'fs-ask-chat__pending-dot' }),
          React.createElement('span', { className: 'fs-ask-chat__pending-dot' }),
          React.createElement('span', { className: 'fs-ask-chat__pending-dot' }),
        ) : null,
      ),

      /* Input */
      React.createElement('form', {
        className: 'fs-ask-chat__form',
        onSubmit:  onSubmit,
      },
        React.createElement('input', {
          type:      'text',
          className: 'fs-ask-chat__input',
          placeholder: props.placeholder || 'Ask the agent…',
          value:     q,
          onChange:  function (e) { setQ(e.target.value); },
          disabled:  busy,
        }),
        React.createElement('button', {
          type:      'submit',
          className: 'fs-ask-chat__send',
          disabled:  busy || !q.trim(),
          'aria-label': 'Send question',
        }, busy ? '…' : 'Ask'),
      ),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.AskChat = AskChat;
  /* Exported so the wording can be pinned by a test without rendering React,
     and so SP-Ask's spoken variant can be written against the same dict. */
  window.FieldSight.formatAnswerBasis = formatAnswerBasis;
})();
