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

  /* ---- external corroboration (the second pass) -------------------------

     Everything below renders what the OPEN WEB says. The answer above it
     renders what the customer's own recordings say. Those are two different
     kinds of statement, and the whole job of this block is to stop the reader
     hearing them as one: the answer is evidence about their site, this is
     evidence about the world, and this is the half that can be wrong in ways
     a site manager has no way to detect.

     Hence: its own labelled divider, its own surface, the source domain on
     every claim, and the retrieval date. Not colour alone -- colour is the
     first thing lost to a screenshot, a printout, or a colour-blind reader. */

  /* Module-scope so ids stay unique across every AskChat on the page. There
     are four mounts (three on Timeline, one in the search palette) and a
     per-instance counter would hand two of them the same id. */
  var _midSeq = 0;

  var CORROB_STATE = {
    corroborated:       { label: 'Confirmed',   mod: 'ok'      },
    conflicts:          { label: 'Disagrees',   mod: 'conflict'},
    not_found:          { label: 'Not found',   mod: 'none'    },
    no_checkable_claim: { label: 'Nothing to check', mod: 'moot' },
  };

  /* Show the host, not the raw URL. A reader judges "is this a source I trust"
     from the domain; the full URL is noise at this size and wraps badly. */
  function sourceHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch (e) { return url || ''; }
  }

  function renderCorroborationItem(c, i) {
    var meta = CORROB_STATE[c.state] || CORROB_STATE.no_checkable_claim;
    return React.createElement('li', {
      key: i,
      className: 'fs-ask-corrob__item fs-ask-corrob__item--' + meta.mod,
    },
      React.createElement('div', { className: 'fs-ask-corrob__head' },
        React.createElement('span', { className: 'fs-ask-corrob__entity' }, c.entity),
        React.createElement('span', {
          className: 'fs-ask-corrob__state fs-ask-corrob__state--' + meta.mod,
        }, meta.label)
      ),

      /* `conflicts` is the state this feature exists for, and the easiest one
         to lose to a renderer that prints every result as a summary. It gets
         both sides, attributed, on separate lines -- never merged into prose
         where the disagreement can read as elaboration. */
      c.state === 'conflicts'
        ? React.createElement('div', { className: 'fs-ask-corrob__conflict' },
            React.createElement('div', null,
              React.createElement('span', { className: 'fs-ask-corrob__side' }, 'The recording:'),
              ' ', c.claim || '—'),
            React.createElement('div', null,
              React.createElement('span', { className: 'fs-ask-corrob__side' }, 'The web:'),
              ' ', c.summary || '—')
          )
        : (c.summary
            ? React.createElement('div', { className: 'fs-ask-corrob__summary' }, c.summary)
            : null),

      (c.sources && c.sources.length)
        ? React.createElement('div', { className: 'fs-ask-corrob__sources' },
            c.sources.map(function (s, j) {
              return React.createElement('a', {
                key: j, href: s.url, target: '_blank', rel: 'noopener noreferrer',
                className: 'fs-ask-corrob__source',
                title: s.title || s.url,
              }, sourceHost(s.url) + (s.published ? ' · ' + s.published : ''));
            })
          )
        : null
    );
  }

  /* `res` is the corroborate response, or one of two sentinels:
       { _pending: true }  -- request in flight
       { _failed: true }   -- request rejected or timed out

     A failure renders a muted LINE, never nothing. With the flag on and the
     route broken, "render nothing" is indistinguishable from
     working-and-empty -- a shape this repo has shipped three separate times
     (swallowed 403s on the fire-and-forget write, the legacy gateway's 403
     shown as an empty state, 1078 uploads with zero log lines). The answer
     itself still never acquires an error banner: an optional enrichment
     failing is not the answer failing. */
  function renderCorroboration(res) {
    if (!res) return null;

    if (res._pending) {
      return React.createElement('div', { className: 'fs-ask-corrob fs-ask-corrob--pending' },
        React.createElement('div', { className: 'fs-ask-corrob__label' }, 'Checking the web…'));
    }
    if (res._failed) {
      return React.createElement('div', { className: 'fs-ask-corrob fs-ask-corrob--failed' },
        React.createElement('div', { className: 'fs-ask-corrob__label' },
          'Web check unavailable'));
    }

    var items = res.corroborations || [];
    var dropped = res.dropped || [];

    /* `timed_out` has to be in this condition. The backend returns it with
       EVERYTHING else empty on five separate paths -- gate allowed nothing and
       the clock ran out, search failed, reconcile failed, or either step
       started with less than a useful timeout left. Without it here the whole
       block returns null and a timeout renders as nothing at all, which is the
       exact swallowed-failure shape this component's own rule forbids: with the
       flag on and the upstream broken, "render nothing" is indistinguishable
       from working-and-empty.

       This was written into the design and then violated four lines later by
       an early return that only knew about the three fields it had at the
       time. */
    if (!items.length && !dropped.length && !res.truncated && !res.timed_out) {
      return null;
    }

    return React.createElement('div', { className: 'fs-ask-corrob' },
      React.createElement('div', { className: 'fs-ask-corrob__label' },
        'From the open web — not from your recordings'),

      items.length
        ? React.createElement('ul', { className: 'fs-ask-corrob__list' },
            items.map(renderCorroborationItem))
        : null,

      /* Both of these are caps, and a cap the reader cannot see reads as
         "everything was checked". `dropped` is the privacy gate refusing to
         send something; `truncated` is the three-entity limit. They are
         different facts and are said separately. */
      /* "Not checked", and NOT a reason invented here.

         An earlier version of this line said "not sent — commercially
         sensitive" for every dropped entity. The backend drops for several
         different reasons and only some of them are that: the gate refuses a
         kind outside the allowlist, a string shaped like a person's name, a
         clause-narrowed standard, digits on a non-standard — and separately,
         `no usable state` means the entity WAS sent and the reconcile step
         could not place it, so even "not sent" was false for that one.

         The visible line now says only what is true for all of them. The
         reasons are real and worth having, so they go in the tooltip verbatim
         rather than being mapped into a second vocabulary this side would then
         have to keep in sync with the gate's. */
      dropped.length
        ? React.createElement('div', {
            className: 'fs-ask-corrob__note',
            title: dropped.map(function (d) {
              return (d.entity || '?') + ' — ' + (d.reason || 'no reason given');
            }).join('\n'),
          },
            dropped.length + ' thing' + (dropped.length === 1 ? '' : 's') +
            ' not checked')
        : null,

      res.truncated
        ? React.createElement('div', { className: 'fs-ask-corrob__note' },
            'Only the first ' + items.length + ' were checked')
        : null,

      res.timed_out
        ? React.createElement('div', { className: 'fs-ask-corrob__note' },
            'The check ran out of time')
        : null
    );
  }

  /* One line saying what the answer was built from.

     Composed HERE from the numbers the backend computed, and never asked of the
     model. The same `basis` dict is rendered as this line on screen and as a
     spoken clause by SP-Ask; a model asked to phrase it would drift between the
     two and would sooner or later say "three meetings" over a single excerpt,
     which nothing downstream could catch.

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

    /* Attach a corroboration result to the answer it belongs to.

       Matching on id and not on position: the log is append-only today, but a
       later feature that inserts or removes a message would silently move
       every block one seat over, and nothing would fail loudly. A miss is a
       no-op -- the panel may have been reset (a date change clears `msgs`)
       while the request was in flight, and a late arrival must not resurrect
       a message that is gone. */
    function patchCorrob(mid, value) {
      setMsgs(function (m) {
        var hit = false;
        var next = m.map(function (msg) {
          if (msg.id !== mid) return msg;
          hit = true;
          return Object.assign({}, msg, { corrob: value });
        });
        return hit ? next : m;
      });
    }

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
        var answerText = res.answer || '';
        var wantsCorrob = !!(((window.FS || {}).api || {}).externalCorroboration)
                          && !!answerText;
        /* A per-message id, because the corroboration arrives later and has to
           find its own answer again. Position is not an identity here: two
           questions can be in flight, and matching on text attaches the block
           to the wrong one as soon as somebody asks the same thing twice. */
        var mid = ++_midSeq;
        setMsgs(function (m) { return m.concat([{
          id:        mid,
          role:      'assistant',
          text:      answerText,
          citations: res.citations || [],
          model:     res.model,
          /* What the backend actually searched. Absent on the legacy path and
             on older deploys, which formatAnswerBasis renders as no line. */
          basis:     res.basis || null,
          corrob:    wantsCorrob ? { _pending: true } : null,
        }]); });

        /* The second pass. Fired after the answer is already on screen and
           awaited by nothing the answer depends on -- /ask spends its whole
           29s API Gateway budget on embed + rag-search + synthesis, so this
           could not have ridden along even if we wanted it to.

           Fired HERE and not inside a setMsgs updater: React may invoke an
           updater twice, and a request sent from inside one is a request sent
           twice. */
        if (!wantsCorrob) return;
        window.FS.api.ask.corroborate({ question: question, answer: answerText })
          .then(function (cr) { patchCorrob(mid, cr); })
          .catch(function () { patchCorrob(mid, { _failed: true }); });
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

            /* Below the citations, deliberately: citations point back into the
               customer's own recordings, and this points out of them. Reading
               order carries the same separation the styling does. */
            m.role === 'assistant' ? renderCorroboration(m.corrob) : null,
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
