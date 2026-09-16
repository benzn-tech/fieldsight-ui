/* ==========================================================================
   FieldSight AskChat — Layer 5 composite (Sprint 2.7 / PLAN Phase G)
   --------------------------------------------------------------------------
   Q&A strip backed by /api/ask (BACKEND-CONTEXT §4.12).

   The backend is STATELESS — every question is independent and the API
   doesn't carry conversation memory (BACKEND-CONTEXT §10). The chat
   illusion is reconstructed client-side: we keep messages[] in local
   state for display, but each request sends only the one question.
   No prior turns are forwarded in the body.

   Scope (spec docs/specs/2026-09-15-one-ask-scoped.md): the HOST owns a
   `context` and AskChat only reads it. The request carries date / site_id /
   author_folder / topic_row_id; what was actually enforced comes back as
   `applied_scope` and is what the chips and scope lines show.

   Worker rule (BACKEND-CONTEXT §3, §8.5): the server forces user=self
   for workers. We pass the user param along and trust the API to
   override; no UI gating needed beyond that.

   Props:
     context         {date?, siteId?, siteName?, authorFolder?, authorName?,
                      topicRowId?, topicTitle?} — omitted = unscoped
     onContextChange function(nextContext) — chip removal / "Ask across
                     everything"; without it chips have no remove button
     focusNonce      number — a change scrolls the Ask into view and focuses
                     its input (Timeline's "Ask about this topic")
     user            folder-name string (optional — server handles default)
     placeholder     overrides placeholderFor(context)
     suggestions     overrides suggestionsFor(context)
     compact         boolean — tighter layout
     alertsProvider  optional programme alerts route (unchanged)
     initialQuestion optional string — auto-sends once on mount (Search's
                     "Ask FieldSight" hand-off).

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
     are two mounts (Timeline and the search palette) and a
     per-instance counter would hand two of them the same id. */
  var _midSeq = 0;

  var CORROB_STATE = {
    corroborated:       { label: 'Confirmed',   mod: 'ok'      },
    conflicts:          { label: 'Disagrees',   mod: 'conflict'},
    not_found:          { label: 'Not found',   mod: 'none'    },
    no_checkable_claim: { label: 'Nothing to check', mod: 'moot' },
  };

  /* Show the host, not the raw URL. A reader judges "is this a source I trust"
     from the domain; the full URL is noise at this size and wraps badly.

     The backend now sends `domain` because parsing the URL stopped being able
     to answer this. A measured annotation from the current search vendor:

         url:   https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ...
         title: "wikipedia.org"

     The link is an opaque Google redirect, so every source under every claim
     would read `vertexaisearch.cloud.google.com` -- one host, standing in for
     whoever actually published each thing, on the one surface whose promise is
     that external evidence is visibly separate and attributable.

     The URL fallback stays for a response from a backend that has not shipped
     `domain` yet; the two repos deploy independently and no order is enforced. */
  function sourceDomain(s) {
    if (s && s.domain) return String(s.domain);
    return sourceHost(s && s.url);
  }

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
                /* The visible text is the domain, so a title that IS the
                   domain would only repeat it in the tooltip. The link the
                   reader follows is the vendor's, redirect and all -- we did
                   not get another one, and inventing it would fabricate a
                   citation. The tooltip is where that is honest. */
                title: (s.title && s.title !== sourceDomain(s))
                  ? s.title + ' — ' + s.url
                  : s.url,
              }, sourceDomain(s) + (s.published ? ' · ' + s.published : ''));
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
  /* The early return that decides whether this block appears at all.

     It is its own function because it is the part that has already been wrong
     once: the design says a failure must render a LINE and never nothing, and
     an early return that only knew about the three fields existing at the time
     violated it four lines later. Every field added to the response body since
     has had to be remembered here, and `searched` is the newest -- a body that
     says "we did not consult the web" carries no items, no dropped, no
     truncated and no timeout, so the old condition would have swallowed it
     into silence, which is the exact shape this component forbids.

     Exported because it is a pure decision and this file cannot be rendered
     under Node (no React, no build step), so this is the piece a test can
     actually drive. */
  function hasNothingToShow(res) {
    if (!res) return true;
    return !(res.corroborations || []).length
        && !(res.dropped || []).length
        && !res.truncated
        && !res.timed_out
        && !res.failed
        && res.searched !== false;
  }

  /* The line that keeps the two sources apart.

     It sits ABOVE the answer for the same reason the basis line does: by the
     time a reader reaches a footnote they have already read the answer as if it
     came from their own recordings. The separation has to arrive first.

     `sources` carries `domain` because this vendor returns Google grounding
     redirects -- parsing the URL would attribute every source to
     `vertexaisearch.cloud.google.com`, which is the opposite of naming a
     publisher. */
  function renderWebOrigin(m) {
    if (!m.fromWeb) return null;
    var web = m.web || {};
    var sources = web.sources || [];
    return React.createElement('div', { className: 'fs-ask-web' },
      React.createElement('div', { className: 'fs-ask-web__label' },
        'From the open web — not from your recordings'),
      sources.length
        ? React.createElement('div', { className: 'fs-ask-web__sources' },
            sources.map(function (s, i) {
              return React.createElement('a', {
                key: i, href: s.url, target: '_blank', rel: 'noopener noreferrer',
                className: 'fs-ask-web__source',
                title: s.url,
              }, sourceDomain(s));
            }))
        : null
    );
  }

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
    if (hasNothingToShow(res)) {
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
        : null,

      /* A third thing, and it needs its own words.

         `truncated` and `timed_out` are already said separately because a
         reader who sees three cards deserves to know which happened. This is
         neither: the request finished, quickly, and never consulted anything --
         the vendor answered without running the search. Routing it through
         `timed_out` would print "ran out of time" about a four-second request,
         and calling it `not_found` would assert a search that did not happen.

         Measured on OpenRouter 2026-09-08: a model returned 200 OK with
         confident prose and zero web results. The backend now refuses to
         reconcile that; this line is how the reader is told. */
      /* A check that BROKE, which is not a check that ran late and not a
         check with nothing to do.

         All three used to arrive as `timed_out`, and one of them was measured
         on TEST: a model returned prose instead of JSON and the reader was
         told the check ran out of time -- in ten seconds, against a
         twenty-seven second budget. "Ran out of time" invites trying again;
         trying again fails identically.

         Dropping the flag instead would have made "nothing to check" and "the
         check broke" render the same, which is the thing the backend test
         guarding this has always been for. So: three states, three sentences. */
      res.failed
        ? React.createElement('div', { className: 'fs-ask-corrob__note' },
            'The web check could not be completed')
        : null,

      res.searched === false
        ? React.createElement('div', { className: 'fs-ask-corrob__note' },
            'Couldn’t check the web for this answer')
        : null
    );
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
     non-RAG path). A line reading "based on nothing" is worse than no line.

     THE LINE FOLLOWS THE QUESTION'S LANGUAGE, and the widened case is why it
     has to. The backend prompt tells the model NOT to say the period was empty
     when it is answering on screen, because this line says it first and saying
     it twice states one fact in two voices. For a question asked in Chinese
     that left the explanation nowhere: the model was silenced and the only
     thing that spoke was English, so the answer arrived about a date the reader
     had not asked for with nothing they could read to say why
     (user, 2026-09-02).

     The question, not the browser locale — the locale is the device's language
     and this is the asker's. Same rule the backend's metric renderer uses. */
  var CJK = /[㐀-䶿一-鿿豈-﫿]/;
  function askedInChinese(question) { return CJK.test(question || ''); }

  function formatAnswerBasis(basis, zh) {
    if (!basis || !basis.chunks) return null;
    var dates = basis.dates || [];
    var n = basis.chunks;
    var tail = zh ? ' · ' + n + ' 段摘录'
                  : ' · ' + n + ' excerpt' + (n === 1 ? '' : 's');
    if (basis.widened) {
      return zh
        ? '所问的时间段没有记录 — 改为基于 ' + basis.from + tail
        : 'Nothing in the period asked about — based on ' + basis.from + ' instead' + tail;
    }
    if (!basis.from && !basis.to) {
      return (zh ? '基于你能看到的全部记录' : 'Based on all records you can see') + tail;
    }
    if (basis.from === basis.to) {
      return (zh ? '基于 ' : 'Based on ') + basis.from + tail;
    }
    var span = zh
      ? '基于 ' + basis.from + ' 至 ' + basis.to
      : 'Based on ' + basis.from + ' to ' + basis.to;
    if (dates.length > 1) span += ' · ' + dates.length + (zh ? ' 天' : ' days');
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

  /* ---- scope: what this Ask is narrowed to --------------------------------

     The host owns the context ({date, siteId, siteName, authorFolder,
     authorName, topicRowId, topicTitle}); AskChat only reads it. Everything
     below is pure so it can be driven from Node -- this file cannot be rendered
     there. */

  function present(v) {
    return typeof v === 'string' ? v.trim() !== '' : v != null;
  }

  function hasScope(context) {
    var c = context || {};
    return present(c.date) || present(c.siteId) || present(c.authorFolder)
        || present(c.topicRowId);
  }

  /* Context -> POST /api/ask body. Omits absent fields rather than sending ''
     or null: the backend treats a present-but-empty field as malformed and
     reports it `dropped: invalid`, which would put a warning under every
     answer. Never sends `scope` / `topic_id` -- the RAG path ignores both.

     `scoped: true` is only added when at least one narrowing field went on
     the body -- it tells the backend "honour date/site/author/topic for
     narrowing", and an unscoped question must not opt into that by accident
     (user decision 2026-09-16). */
  function requestBodyFor(context, question) {
    var c = context || {};
    var body = { question: question };
    if (present(c.date))         body.date          = c.date;
    if (present(c.siteId))       body.site_id       = c.siteId;
    if (present(c.authorFolder)) body.author_folder = c.authorFolder;
    if (present(c.topicRowId))   body.topic_row_id  = c.topicRowId;
    if (present(c.date) || present(c.siteId) || present(c.authorFolder) || present(c.topicRowId)) {
      body.scoped = true;
    }
    return body;
  }

  var SCOPE_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var SCOPE_DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  /* 'YYYY-MM-DD' -> 'Thu 3 Sep'. UTC arithmetic only (BUG-19): a date string
     parsed as local time drifts a day in New Zealand. */
  function shortDay(iso) {
    var p = String(iso || '').split('-').map(Number);
    if (p.length !== 3 || !p[0] || !p[1] || !p[2]) return String(iso || '');
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return SCOPE_DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + SCOPE_MONTHS[d.getUTCMonth()];
  }

  var TOPIC_CHIP_MAX = 24;
  function truncateTitle(title) {
    var t = String(title || '').trim();
    if (t.length <= TOPIC_CHIP_MAX) return t;
    var cut = t.slice(0, TOPIC_CHIP_MAX + 1);
    var sp = cut.lastIndexOf(' ');
    return (sp > 0 ? cut.slice(0, sp) : t.slice(0, TOPIC_CHIP_MAX)).trim() + '…';
  }

  /* null  = no answer yet: the chip shows the request, unmarked.
     true  = the backend says it enforced this field.
     false = it did not -- including a backend that predates applied_scope,
             which must read as "not scoped" rather than silently scoped. */
  function isEnforced(response, field) {
    if (response === undefined) return null;
    var applied = response && response.applied_scope;
    return !!(applied && typeof applied === 'object'
              && Object.prototype.hasOwnProperty.call(applied, field));
  }

  function chipsFor(context, response) {
    var c = context || {};
    var chips = [];

    var segs = [];
    if (present(c.date)) segs.push({ field: 'date', text: shortDay(c.date) });
    if (present(c.siteId) && present(c.siteName)) segs.push({ field: 'site_id', text: c.siteName });
    if (present(c.authorFolder)) segs.push({ field: 'author_folder', text: c.authorFolder });
    if (segs.length) {
      segs.forEach(function (s) { s.enforced = isEnforced(response, s.field); });
      chips.push({
        kind: 'day',
        label: segs.map(function (s) { return s.text; }).join(' · '),
        title: '',
        segments: segs,
        /* Removed as one, and it takes the topic with it: a topic is pinned
           to its own day, so it cannot outlive the day chip. */
        next: {},
      });
    }

    if (present(c.topicRowId)) {
      var rest = Object.assign({}, c);
      delete rest.topicRowId;
      delete rest.topicTitle;
      var label = 'Topic: ' + (truncateTitle(c.topicTitle) || 'this topic');
      chips.push({
        kind: 'topic',
        label: label,
        title: c.topicTitle || '',
        segments: [{ field: 'topic_row_id', text: label,
                     enforced: isEnforced(response, 'topic_row_id') }],
        next: rest,
      });
    }
    return chips;
  }

  /* Copy for each `applied_scope.dropped` entry (spec §2 table). Keyed on the
     exact field:reason pair; anything else renders nothing -- a raw code under
     an answer is worse than silence, and the chips already grey the field. */
  var SCOPE_DROP_COPY = {
    'topic_row_id:not_visible':  'Topic not available — answered for the day',
    'topic_row_id:invalid':      'Topic not available — answered for the day',
    'author_folder:not_visible': "Couldn't narrow to this person — answered for the project and day",
    'author_folder:invalid':     "Couldn't narrow to this person — answered for the project and day",
    'site_id:not_visible':       "Couldn't narrow to this project",
    'site_id:invalid':           "Couldn't narrow to this project",
    'date:invalid':              "Couldn't narrow to this day",
    'date:overridden_by_question':        'Used the dates in your question',
    'date:overridden_by_topic':           "Answered for this topic's day",
    'question_range:overridden_by_topic': "Answered for this topic's day, not the dates in your question",
  };

  /* Built from the RESPONSE only. The UI renders what the backend enforced,
     never its own request: a backend that predates applied_scope must read as
     visibly unscoped, not as silently scoped. */
  function basisLinesFor(response) {
    var applied = response && response.applied_scope;
    if (!applied || typeof applied !== 'object') return ['Searched all your projects'];
    var out = [];
    (Array.isArray(applied.dropped) ? applied.dropped : []).forEach(function (d) {
      if (!d) return;
      var key = d.field + ':' + d.reason;
      if (!Object.prototype.hasOwnProperty.call(SCOPE_DROP_COPY, key)) return;
      if (out.indexOf(SCOPE_DROP_COPY[key]) === -1) out.push(SCOPE_DROP_COPY[key]);
    });
    return out;
  }

  function scopeKind(context) {
    var c = context || {};
    if (present(c.topicRowId)) return 'topic';
    return hasScope(c) ? 'day' : 'none';
  }

  var SCOPE_SUGGESTIONS = {
    topic: ['What was decided?', 'Who is responsible for follow-ups?', 'Were any risks flagged?'],
    day:   ['What were the safety issues?', 'Which actions are still open?', 'What was decided?'],
    none:  ['What happened this week?', 'Which actions are overdue?'],
  };
  var SCOPE_PLACEHOLDER = {
    topic: 'Ask about this topic…',
    day:   'Ask about this day…',
    none:  'Ask across all your projects…',
  };

  function suggestionsFor(context) { return SCOPE_SUGGESTIONS[scopeKind(context)].slice(); }
  function placeholderFor(context) { return SCOPE_PLACEHOLDER[scopeKind(context)]; }

  function AskChat(props) {
    var user    = props.user;
    var context = props.context || {};

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
    var rootRef  = React.useRef(null);
    var inputRef = React.useRef(null);
    /* A question waiting to be re-sent once the host has applied a new
       context ("Ask across everything"). Sent from the reset effect, i.e.
       after the re-render, so it goes out with the NEW context rather than
       the one this render closed over. */
    var resendRef = React.useRef(null);
    /* The same question, parked because a request was still in flight when
       the new context arrived; sent once `busy` clears (see the busy effect). */
    var deferredResendRef = React.useRef(null);
    /* Bumped by the reset effect. A request remembers the generation it was
       sent in; a response from an older generation answered a context the
       reader is no longer looking at, so it is dropped rather than appended
       under the new chips. */
    var genRef = React.useRef(0);
    /* The reset effect must not run on mount: it runs after the
       initialQuestion effect and would wipe the question that effect just
       added (palette hand-off). */
    var resetMountedRef = React.useRef(false);

    /* Task C — one-shot hand-off from Search's "Ask FieldSight" row. Runs
       once on mount only ([] deps). AUTO-SENDS: the user already typed and
       committed the question in the search palette — landing them on a
       silently prefilled input read as "nothing happened" (user feedback
       2026-07-06). */
    React.useEffect(function () {
      if (props.initialQuestion) send(props.initialQuestion);
    }, []);

    /* Put the QUESTION at the top of the view, not the last line of the answer.
       This used to be `scrollTop = scrollHeight`, which lands the reader at the
       bottom of a long answer and makes them scroll back up to find out what
       they asked (user, 2026-08-31). The answer is read downward from the
       question, so that is where the view starts.
       Falls back to the old behaviour when there is no user message to anchor
       on — a first render, or a route that seeds an answer with no question. */
    React.useEffect(function () {
      var el = listRef.current;
      if (!el) return;
      var asked = el.querySelectorAll('[data-role="user"]');
      var last = asked.length ? asked[asked.length - 1] : null;
      if (last && typeof last.offsetTop === 'number') {
        el.scrollTop = Math.max(0, last.offsetTop - el.offsetTop);
      } else {
        el.scrollTop = el.scrollHeight;
      }
    }, [msgs.length, busy]);

    /* When scope keys change (the host changed the context: a day/owner
       change, a pinned or removed topic, "Ask across everything"), drop
       history since prior context no longer applies. */
    React.useEffect(function () {
      if (!resetMountedRef.current) { resetMountedRef.current = true; return; }
      genRef.current += 1;
      setMsgs([]);
      /* Always consumed here, sent or not: a question left in the ref would
         otherwise fire on some later, unrelated context change. It is only
         sent when the new context is the unscoped one "Ask across
         everything" asked for -- a host that applied something else did not
         honour the widen. */
      var pending = resendRef.current;
      resendRef.current = null;
      deferredResendRef.current = null;
      if (pending && !hasScope(context)) {
        if (busy) deferredResendRef.current = pending;
        else send(pending);
      }
    }, [context.date, context.siteId, context.authorFolder, context.topicRowId]);

    /* A widen that landed while an older request was still in flight: send it
       once that request settles, from a render that has the new context. */
    React.useEffect(function () {
      if (busy || !deferredResendRef.current) return;
      var pending = deferredResendRef.current;
      deferredResendRef.current = null;
      send(pending);
    }, [busy]);

    /* "Ask about this topic" — bring the one Ask into view and put the cursor
       in it. Smooth scroll only when the reader has not asked for reduced
       motion. The nonce lives in the page Provider and never resets, while
       this component remounts on every day change or refetch: act only on a
       change seen by THIS mount, never on the value it was mounted with. */
    var seenFocusNonceRef = React.useRef(props.focusNonce);
    React.useEffect(function () {
      if (props.focusNonce === seenFocusNonceRef.current) return;
      seenFocusNonceRef.current = props.focusNonce;
      if (!props.focusNonce) return;
      var root = rootRef.current;
      var input = inputRef.current;
      var reduce = !!(window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      if (root && root.scrollIntoView) {
        root.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      }
      if (input && input.focus) input.focus({ preventScroll: true });
    }, [props.focusNonce]);

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

      /* Captured at send time: the context may change while this is in flight. */
      var scopedRequest = hasScope(context);
      var body = requestBodyFor(context, question);
      body.user = user;   /* undefined is dropped on the wire */
      var gen = genRef.current;
      function isStale() { return gen !== genRef.current; }
      window.FS.api.ask.ask(body).then(function (res) {
        if (isStale()) return;
        var answerText = res.answer || '';
        /* Not on a web-derived answer: corroborating the web against the web
           is a loop that reads as confirmation. */
        var wantsCorrob = !!(((window.FS || {}).api || {}).externalCorroboration)
                          && !!answerText
                          && !res.from_web;
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
          /* The records could not answer this and the web could. Carried as
             its own field, never folded into `text`: a reader who cannot tell
             what came out of their own meetings from what came off the
             internet has no reason to suspect they need to check. */
          fromWeb:   !!res.from_web,
          web:       res.web || null,
          corrob:    wantsCorrob ? { _pending: true } : null,
          /* Captured from the question at send time, not read off the answer:
             the model's reply language is not reliable (measured on prod, a
             Chinese question came back in English 2 runs out of 3), and the
             basis line must not inherit that coin flip. */
          zh:        askedInChinese(question),
          /* What the backend says it enforced. Stored as a response-shaped
             object so the chips and scope lines read exactly what came back;
             `applied_scope` undefined = a backend that predates scoping. */
          scopeResponse: { applied_scope: res.applied_scope },
          scoped:        scopedRequest,
          question:      question,
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
          .then(function (cr) { if (!isStale()) patchCorrob(mid, cr); })
          .catch(function () { if (!isStale()) patchCorrob(mid, { _failed: true }); });
      }).catch(function (err) {
        if (isStale()) return;
        /* A timeout is not an unreachable agent, and saying so sent the reader
           at the backend while it was answering correctly. Name the two cases
           apart: one is "it is slow", the other is "it is not there". */
        setMsgs(function (m) { return m.concat([{
          role:  'assistant',
          text:  (err && err.timeout)
                   ? 'The agent took too long to answer. It may still be working — try asking again.'
                   : 'Could not reach the agent. ' + (err && err.message || ''),
          error: true,
        }]); });
      }).then(function () {
        /* Even for a stale response: the request is over either way. */
        setBusy(false);
      });
    }

    function onSubmit(e) {
      if (e) e.preventDefault();
      var trimmed = (q || '').trim();
      if (!trimmed) return;
      send(trimmed);
    }

    var suggestions = props.suggestions || suggestionsFor(context);
    var lastAnswer = null;
    for (var li = msgs.length - 1; li >= 0; li--) {
      if (msgs[li].scopeResponse) { lastAnswer = msgs[li]; break; }
    }
    var chips = chipsFor(context, lastAnswer ? lastAnswer.scopeResponse : undefined);

    var className = 'fs-ask-chat' + (props.compact ? ' fs-ask-chat--compact' : '');

    return React.createElement('div', { className: className, ref: rootRef },

      /* Suggestions row — only shown while history is empty. */
      suggestions && suggestions.length > 0 && msgs.length === 0
        ? React.createElement('div', { className: 'fs-ask-chat__suggestions' },
            suggestions.map(function (s, i) {
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
        msgs.length === 0 && (!suggestions || suggestions.length === 0)
          ? React.createElement('div', { className: 'fs-ask-chat__empty' },
              placeholderFor(context))
          : null,

        msgs.map(function (m, i) {
          return React.createElement('div', {
            key: i,
            /* Marks the anchor the scroll effect looks for. The question is
               where reading starts, so it is the thing that gets put at the top
               — not the last line of the answer. */
            'data-role': m.role,
            className: 'fs-ask-chat__msg fs-ask-chat__msg--' + m.role
              + (m.error ? ' fs-ask-chat__msg--error' : ''),
          },
            /* Assistant replies are markdown → render via the safe renderer
               (it HTML-escapes first, then emits only a fixed tag set, so
               dangerouslySetInnerHTML carries no LLM-supplied markup). User
               messages are the person's own typed question → keep plain. */
            /* FIRST, above the answer — not after it, and not at the end of the
               prose. The reader asked about a period; if that period is empty
               they learn it before they read a word about another day.
               A version of this sat under the answer and it was wrong for the
               same reason the model's closing caveat was: by the time you reach
               it you have already read three sentences about a date you did not
               ask about (user, 2026-08-31). */
            m.role === 'assistant' && formatAnswerBasis(m.basis, m.zh)
              ? React.createElement('div', {
                  className: 'fs-ask-chat__basis'
                    + (m.basis && m.basis.widened ? ' fs-ask-chat__basis--widened' : ''),
                }, formatAnswerBasis(m.basis, m.zh))
              : null,
            /* What the scope turned out to be. Above the answer for the same
               reason as the basis line: the reader learns the answer is not
               about what they were looking at BEFORE reading it. */
            m.role === 'assistant' && m.scopeResponse
              ? basisLinesFor(m.scopeResponse).map(function (line, li2) {
                  return React.createElement('div', {
                    key: 'scope-' + li2, className: 'fs-ask-chat__scope-line',
                  }, line);
                })
              : null,
            m.role === 'assistant' ? renderWebOrigin(m) : null,
            m.role === 'assistant' && window.FieldSight.renderMarkdown
              ? React.createElement('div', {
                  className: 'fs-ask-chat__msg-text fs-ask-chat__msg-text--md',
                  dangerouslySetInnerHTML: { __html: window.FieldSight.renderMarkdown(m.text) },
                })
              : React.createElement('div', { className: 'fs-ask-chat__msg-text' },
                  m.text),
            m.role === 'assistant' ? renderCitations(m.citations) : null,
            /* A scoped answer that found nothing: offer the same question
               across everything. The host clears the context; the reset
               effect re-sends once the new (empty) context has rendered.
               Only when the backend reported an applied_scope: one that
               predates scoping already searched everything. */
            m.role === 'assistant' && m.scoped && m.scopeResponse
                && m.scopeResponse.applied_scope && !m.error
                && !(m.citations && m.citations.length) && props.onContextChange
              ? React.createElement('button', {
                  type: 'button',
                  className: 'fs-ask-chat__widen',
                  disabled: busy,
                  onClick: function () {
                    if (hasScope(context)) resendRef.current = m.question;
                    props.onContextChange({});
                  },
                }, 'Ask across everything')
              : null,

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

        /* The wait is p90 8.6s — long enough that three silent dots read as a
           stall. The dots say "alive"; the line says what it is doing, so a
           reader who looks away and back knows the request did not die. */
        busy ? React.createElement('div', {
          className: 'fs-ask-chat__msg fs-ask-chat__msg--assistant fs-ask-chat__msg--pending',
          role:         'status',
          'aria-live':  'polite',
        },
          React.createElement('span', { className: 'fs-ask-chat__pending-dots', 'aria-hidden': 'true' },
            React.createElement('span', { className: 'fs-ask-chat__pending-dot' }),
            React.createElement('span', { className: 'fs-ask-chat__pending-dot' }),
            React.createElement('span', { className: 'fs-ask-chat__pending-dot' }),
          ),
          React.createElement('span', { className: 'fs-ask-chat__pending-label' },
            'Looking through your records…'),
        ) : null,
      ),

      chips.length
        ? React.createElement('div', {
            className: 'fs-ask-chat__chips',
            role: 'group',
            'aria-label': 'This Ask is narrowed to',
          },
            chips.map(function (chip) {
              return React.createElement('span', {
                key: chip.kind,
                className: 'fs-ask-chip fs-ask-chip--' + chip.kind,
                title: chip.title || null,
              },
                chip.segments.map(function (s, si) {
                  return React.createElement(React.Fragment, { key: s.field },
                    si > 0
                      ? React.createElement('span', { className: 'fs-ask-chip__sep', 'aria-hidden': 'true' }, ' · ')
                      : null,
                    React.createElement('span', {
                      className: 'fs-ask-chip__seg'
                        + (s.enforced === false ? ' fs-ask-chip__seg--unenforced' : ''),
                      /* Not colour alone: struck through, and said in words.
                         The full text lives in the tooltip because a long
                         site or owner name is ellipsised at phone width. */
                      title: s.enforced === false ? s.text + ' — not applied to this answer' : s.text,
                    }, s.text,
                      s.enforced === false
                        ? React.createElement('span', { className: 'fs-sr-only' }, ' (not applied)')
                        : null));
                }),
                props.onContextChange
                  ? React.createElement('button', {
                      type: 'button',
                      className: 'fs-ask-chip__remove',
                      'aria-label': 'Remove scope: ' + chip.label,
                      disabled: busy,
                      onClick: function () { props.onContextChange(chip.next); },
                    }, '×')
                  : null);
            }))
        : null,

      /* Input */
      React.createElement('form', {
        className: 'fs-ask-chat__form',
        onSubmit:  onSubmit,
      },
        React.createElement('input', {
          type:      'text',
          ref:       inputRef,
          className: 'fs-ask-chat__input',
          placeholder: props.placeholder || placeholderFor(context),
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
  window.FieldSight._corroborationHasNothingToShow = hasNothingToShow;
  window.FieldSight._corroborationSourceDomain = sourceDomain;
  /* Exported so the wording can be pinned by a test without rendering React,
     and so SP-Ask's spoken variant can be written against the same dict. */
  window.FieldSight.formatAnswerBasis = formatAnswerBasis;
  /* Pure scope helpers, exported for tests (tests/ask-scoped-context.test.js). */
  window.FieldSight.askScope = {
    requestBodyFor: requestBodyFor,
    hasScope:       hasScope,
    shortDay:       shortDay,
    chipsFor:       chipsFor,
    basisLinesFor:  basisLinesFor,
    suggestionsFor: suggestionsFor,
    placeholderFor: placeholderFor,
  };
})();
