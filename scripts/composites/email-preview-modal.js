/* ==========================================================================
   FieldSight EmailPreviewModal — Layer 5 composite
   --------------------------------------------------------------------------
   The day's / meeting's outstanding action items, shown before they leave —
   with the photos that evidence them — and copied to the clipboard as rich
   text the user pastes into their own mail client.

   Why this exists rather than the mailto it replaces:

     * mailto cannot carry an attachment. A finding without its photo is an
       assertion; with it, it is evidence. "The wall is out of tolerance,
       John by Wednesday" and the photograph showing it belong in one block,
       and mailto can never put them there.
     * mailto's body rides in a URL, so buildSessionEmailDraft has to fit an
       ~1800-character budget and DROPS items past it (draft.omittedItems).
       A hand-off that silently truncates is worse than one that asks for a
       paste.
     * The user could not see what was about to be sent. This shows it.

   What is lost, stated plainly: mailto pre-fills the recipient and subject
   and opens the compose window. A clipboard payload cannot do any of that —
   the user pastes into a message they opened themselves. That is the trade,
   and it is why the mailto button is not removed; this sits beside it.

   Copy writes BOTH flavours to the clipboard:
     text/html   — topic groups, action lines, inline photos
     text/plain  — the same content, for clients that refuse HTML
   Every mail client picks the richest one it supports, so a plain-text
   reader still gets a readable list rather than markup.

   Photos travel as https URLs rather than base64. Reading pixels back off a
   canvas needs CORS, taints on any slip, and produces `data:` sources that
   Gmail and Outlook strip out of pasted HTML anyway — four fixes down that
   road never put a photo in an email. A remote <img> is fetched by the mail
   client while the draft is open, which is the behaviour that works. The
   URLs are presigned and live 900 seconds, so the fetch has to happen while
   composing; for photos that must outlive the paste, the Word report is the
   way.

   Props:
     open        boolean
     onClose     () => void
     topics      array   — the visible topics (already session-scoped)
     session     object? — the picked session, or null for the whole day
     date        string  — YYYY-MM-DD
     reportDate  string? — defaults to date
     siteName    string?
     userFolder  string? — resolves photo S3 keys; no photos without it
     isDone      (action, topicId, idx) => boolean

     `deepLink` is intentionally not a prop here. The footer used to read
     "Generated from FieldSight — <link>"; the product owner ruled the link
     out entirely (customers must never get our internal app URL in a
     paste), so the footer is now the fixed string below and nothing in
     this module reads a link out of `opts`/`props`. Do not re-add it —
     see `footer:` in buildPreviewModel() and the anti-leak test in
     tests/email-preview-modal.test.js.

   Exported to: window.FieldSight.EmailPreviewModal
   Pure helpers (buildPreviewModel, renderEmailHtml, renderEmailText) are
   exported for node --test — the React shell is not unit-tested, like the
   other L5 composites.
   ========================================================================== */

/* global React, window, document */

(function () {
  'use strict';


  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---- pure model ------------------------------------------------------ */

  /* One outstanding thing, in the four fields the reader acts on.

     Blank stays blank. No em-dash filler, no "Unassigned", no date invented
     to square off a column: an empty cell says "the meeting did not state
     this", and every placeholder says something it did not say. 有就有，
     没有就没有.

     sessionIndex/taskIndex ride along because they are the tie-break below,
     and because a renderer needs a key that is not the text. */
  function taskRow(t, sessionIndex, taskIndex) {
    t = t || {};
    return {
      text:     t.text || '',
      at:       t.at || '',
      assignee: t.assignee || '',
      due:      t.due || '',
      /* The exact title of the section this task came from, or `null` —
         carried through untouched, never defaulted to '' (§1 of the
         2026-09-18 spec: "a section field that does not match any section
         title exactly is set to null" — that validation is the backend's
         job; this side only reads the result and must not invent a
         mismatch of its own by coercing null to a string). Not rendered as
         a table cell anywhere — it exists only to decide which of the
         brief's OWN sections produced no task (§2, `sunkSectionsFor`
         below). */
      section:  t.section == null ? null : t.section,
      sessionIndex: sessionIndex,
      taskIndex:    taskIndex,
    };
  }

  /* How much of a topic's own summary rides in its row (§1.5). Mirrors
     `lambda_item_writer.TOPIC_ROW_MAX_CHARS` exactly — this is the shared
     constant the parity test pins against. */
  var TOPIC_ROW_MAX_CHARS = 180;

  /* The one truncation rule every sunk row (topic OR brief-section) is built
     with: cap at 180 CODEPOINTS, matching Python's `len()` — not UTF-16 code
     units. `.length`/`.slice()` on a JS string count the latter, and an
     astral character (an emoji, a CJK Extension B ideograph — anything
     outside the Basic Multilingual Plane) is TWO UTF-16 units but one
     codepoint. Near the boundary that made JS count one character too many
     and `.slice()` could cut a surrogate pair in half, producing an unpaired
     surrogate the backend's `text[:180]` would never produce. `Array.from`
     iterates a string by codepoint (it is what for...of and the spread
     operator use under the hood), so counting and slicing through it stays
     byte-for-byte aligned with the Python side. Factored out of
     `topicRowText` (fix round, 2026-09-18) so `sectionRowText` — the brief's
     own sunk rows — is truncated by the exact same rule, not a second one
     that could drift from it. */
  function _truncateRowText(text) {
    var codepoints = Array.from(text);
    if (codepoints.length > TOPIC_ROW_MAX_CHARS) {
      text = codepoints.slice(0, TOPIC_ROW_MAX_CHARS - 1).join('').replace(/\s+$/, '') + '…';
    }
    return text;
  }

  /* The text for a topic that produced no action items, built byte-for-byte
     the way `lambda_item_writer._topic_rows` builds it, so the email and
     "Preview & copy" cannot drift into showing two different sentences for
     the same topic. Returns '' when there is nothing to say (no title, no
     summary) — the caller drops the row rather than emitting a blank one.

     Used only for a topic whose session has NO usable brief (§2, fix round
     2026-09-18): once a session's brief exists, that session's extraction
     topics contribute nothing to the table — sunk rows for a briefed
     session come from `sectionRowText` below instead, not from this. */
  function topicRowText(t) {
    t = t || {};
    var title = String(t.topic_title || t.title || '').trim();
    var summary = String(t.summary || '').split(/\s+/).filter(Boolean).join(' ');
    /* The first sentence, not the whole summary: the rest repeats it at
       length, which is what pushed the old prose below the fold. */
    var first = summary.split('. ')[0].trim();
    if (first && first !== summary && first.charAt(first.length - 1) !== '.') {
      first += '.';
    }
    var text = [title, first].filter(Boolean).join(' — ');
    return _truncateRowText(text);
  }

  /* The text for a brief SECTION that produced no task (§2 of the
     2026-09-18 "brief says where a task came from" spec): `title — first
     bullet`, truncated by the exact same rule as `topicRowText` — the spec
     is explicit that it is "the SAME rule `topicRowText` already
     implements", not a lookalike. Unlike `topicRowText` this takes the
     WHOLE first bullet, not its first sentence: a section's bullet is
     already one sentence-shaped thing the model wrote, not prose to further
     trim. Returns '' when there is nothing to say (no title, no bullets),
     same contract as `topicRowText` — the caller drops the row. */
  function sectionRowText(sec) {
    sec = sec || {};
    var title = String(sec.title || '').trim();
    var bullets = sec.bullets || [];
    var first = String((bullets[0] && bullets[0].text) || '').trim();
    var text = [title, first].filter(Boolean).join(' — ');
    return _truncateRowText(text);
  }

  /* A raw speaker label ("spk_0", "spk-12", "Speaker 2", case-insensitive) is
     not a name (§1.4) — it is what the diarizer wrote when nobody stated who
     the owner was, and showing it as an assignee would tell the reader it was.
     The SAME pattern as the confirmation email's filter,
     fieldsight-pipeline session_brief._SPEAKER_LABEL — the two surfaces render
     one table, so they must agree on what is not a name. An earlier version
     matched only "spk_N", and a row the email blanked showed here verbatim. */
  function isSpeakerLabel(s) {
    return /^\s*(spk|speaker)[\s_-]*\d+\s*$/i.test(String(s == null ? '' : s));
  }

  /* Topic-row suppression was time-based (§7.1 of the original plan): a
     topic was "covered" when a brief task's `at` fell inside the topic's own
     `time_range`. Measured against a real session it ate content — the
     brief's 8 tasks carried only THREE distinct `at` values, and the
     extraction's topics were 2-minute windows overlapping those anchors, so
     a task about meeting KCD at the Icehouse office suppressed a Papakura
     topic row that shared nothing but a clock window with it. Time cannot
     separate topics that overlap in time, and in real conversation they do.

     Replaced with a TEXT test: a topic row is suppressed iff its own row
     text is "represented" (§7.4 below, `isRepresented` /
     `REPRESENTED_JACCARD_THRESHOLD`) in some brief task of that topic's own
     session. Same function, same threshold, same stop list as the back-fill
     rule below it — one place decides "does this text already say that",
     used in both directions. Below the threshold = not represented = the
     row is KEPT, so both directions carry the same bias: when unsure, do
     not lose content (§10) — suppression only fires on a confident match,
     exactly like back-fill only skips a confident match. */

  /* §7.4 — "represented" is a deliberately conservative text test.
     Lower-case, keep [a-z0-9]+ tokens of 3+ characters, drop the stop list,
     Jaccard overlap. One constant, named identically to the backend's, and
     both sides pin the §9 worked examples against it. */
  var REPRESENTED_STOP_WORDS = ('the a an and or to of for on in at is are '
    + 'be by with from that this it as').split(' ');
  var REPRESENTED_JACCARD_THRESHOLD = 0.30;

  var _stopSet = {};
  REPRESENTED_STOP_WORDS.forEach(function (w) { _stopSet[w] = true; });

  function _tokenSet(s) {
    var words = String(s == null ? '' : s).toLowerCase().match(/[a-z0-9]+/g) || [];
    var set = {};
    words.forEach(function (w) {
      if (w.length >= 3 && !_stopSet[w]) set[w] = true;
    });
    return set;
  }

  function _jaccard(setA, setB) {
    var keysA = Object.keys(setA), keysB = Object.keys(setB);
    if (!keysA.length || !keysB.length) return 0;
    var union = {}, inter = 0;
    keysA.forEach(function (k) { union[k] = true; if (setB[k]) inter += 1; });
    keysB.forEach(function (k) { union[k] = true; });
    var unionSize = Object.keys(union).length;
    return unionSize ? inter / unionSize : 0;
  }

  /* True iff `text` is represented in ANY of `briefTexts` — the BEST
     overlap across the brief's tasks, not the average or the first. §7.4:
     "Represented iff overlap >= 0.30. A tie ... counts as NOT represented" —
     read together, a best-overlap that lands EXACTLY on the threshold is the
     tie in question and counts as not represented, so the comparison below
     is strictly-greater-than. An empty token set on either side already
     scores 0 from `_jaccard`, which is always < the threshold, so it falls
     out of the same comparison rather than needing its own branch — and the
     bias stays towards carrying a commitment twice rather than losing it (§10). */
  function isRepresented(text, briefTexts) {
    var tokens = _tokenSet(text);
    var best = 0;
    (briefTexts || []).forEach(function (bt) {
      var j = _jaccard(tokens, _tokenSet(bt));
      if (j > best) best = j;
    });
    return best > REPRESENTED_JACCARD_THRESHOLD;
  }

  /* A session's brief tasks, keyed by sessionId — usable ones only.
     "Usable" (§1.3, fix round 2026-09-18): the session loaded a brief
     (present in `opts.briefs`) AND it has at least one task. A brief with
     zero tasks is treated as no brief at all for that session.

     Substitution is now PER SESSION, not per day: this map only says what a
     given session's brief WOULD contribute if that session comes up during
     the topic walk in buildPreviewModel. It never decides, on its own,
     whether any particular action item is replaced — a session with no
     topic in `opts.topics` (e.g. scoped away) is simply never looked up,
     which is how §1.3 rule 4 falls out for free rather than needing its own
     check. */
  /* §2 (2026-09-18): the brief's OWN sections that produced no task, for one
     usable session — the sunk-row source once a brief exists, replacing the
     extraction-topic text test entirely for that session. "Produced a task"
     is an EXACT title match only (§1: "a section field that does not match
     any section title exactly is set to null" server-side; here that means
     a task whose `section` is null, or a string that happens to match
     nothing in THIS session's own `sections`, suppresses nothing — every
     section with no exact-matching task is sunk, never fewer). */
  function sunkSectionsFor(sections, tasks) {
    var covered = {};
    (tasks || []).forEach(function (t) {
      var s = t && t.section;
      if (s != null && s !== '') covered[s] = true;
    });
    return (sections || []).filter(function (sec) {
      var title = (sec && sec.title) || '';
      return !!title && !covered[title];
    });
  }

  /* A session's brief tasks AND its sunk sections, keyed by sessionId —
     usable sessions only. "Usable" (§1.3, fix round 2026-09-18): the
     session loaded a brief (present in `opts.briefs`) AND it has at least
     one task. A brief with zero tasks is treated as no brief at all for
     that session — and, since there is then no task to test a section
     against, it contributes no sunk rows either (the whole session falls
     back to the extraction path, §1.3).

     Substitution is now PER SESSION, not per day: this map only says what a
     given session's brief WOULD contribute if that session comes up during
     the topic walk in buildPreviewModel. It never decides, on its own,
     whether any particular action item is replaced — a session with no
     topic in `opts.topics` (e.g. scoped away) is simply never looked up,
     which is how §1.3 rule 4 falls out for free rather than needing its own
     check.

     Returns `{ tasks: {sid: [row]}, sunkSections: {sid: [section]} }` —
     two maps rather than one, because a caller only ever wants one or the
     other and the two shapes (task rows vs raw section objects) are not the
     same thing pretending to be. */
  function briefsBySession(briefs) {
    var tasksMap = {};
    var sunkMap = {};
    (briefs || []).forEach(function (b) {
      if (!b || !b.sessionId) return;
      var art = (b && b.brief) || {};
      var tasks = art.tasks || [];
      if (!tasks.length) return;
      var rows = tasks.map(function (t, ti) { return taskRow(t, 0, ti); });
      /* `at` is HH:MM:SS with no date in it. Sorted within the session only
         — there is no longer a day-wide merge to break ties across sessions
         for, since a session's block is emitted whole, in one place. A row
         with no time sorts last rather than first: absent is not early. */
      rows.sort(function (a, c) {
        if (!a.at !== !c.at) return a.at ? -1 : 1;
        if (a.at !== c.at) return a.at < c.at ? -1 : 1;
        return a.taskIndex - c.taskIndex;
      });
      tasksMap[b.sessionId] = rows;
      sunkMap[b.sessionId] = sunkSectionsFor(art.sections, tasks);
    });
    return { tasks: tasksMap, sunkSections: sunkMap };
  }

  /* One entry per topic that still has something outstanding, carrying its
     own photos. Topics with nothing open are dropped: this is a hand-off of
     work remaining, not a transcript. */
  function buildPreviewModel(opts) {
    opts = opts || {};
    var topics = opts.topics || [];
    var isDone = typeof opts.isDone === 'function' ? opts.isDone : function () { return false; };
    var groups = [];

    /* Substitution is PER SESSION (fix round, 2026-09-18): "if a brief
       exists, use it" means a session's brief replaces THAT session's own
       action items, never another session's. `emittedSessions` makes sure
       a briefed session's block is written exactly once, at the FIRST topic
       (in walk order) that belongs to it — every later topic of the same
       session contributes nothing further, brief or extraction, because its
       commitments already rode in on that first block. */
    var briefsInfo = briefsBySession(opts.briefs || []);
    var briefRowsBySession = briefsInfo.tasks;
    var sunkSectionsBySession = briefsInfo.sunkSections;
    var emittedSessions = {};
    var actionRows = [];
    var topicRows = [];
    var fromBriefCount = 0;
    var fromExtractionCount = 0;

    /* §7.3 pre-pass: every session's own OPEN extraction action items, in
       the extraction's own order (topic-walk order, then item order) —
       gathered BEFORE the main walk below because a session's brief block is
       written at its FIRST topic, but the items eligible for back-fill may
       live on a LATER topic of that same session. Excludes done items, the
       same as every other action row on this table. */
    var extractionItemsBySession = {};
    topics.forEach(function (t) {
      var sid = t.session_id;
      if (!sid) return;
      var open = (t.action_items || []).filter(function (a, idx) {
        if (a && a.status) return a.status !== 'done';
        return !isDone(a, t.topic_id, idx);
      });
      if (!open.length) return;
      if (!extractionItemsBySession[sid]) extractionItemsBySession[sid] = [];
      open.forEach(function (a) {
        extractionItemsBySession[sid].push({
          text:     a.action || a.text || '',
          assignee: a.responsible || '',
          due:      a.deadline || a.deadline_text || '',
        });
      });
    });

    /* A topic's photos travel with it into the photo section below the
       table WHENEVER the topic itself is represented on the table — as an
       action row (its own items, open, not superseded) or as a topic row
       (§1.5) — regardless of which text ends up in the AGENDA ITEM cell.
       (Fix round 2, 2026-09-18: `groups` used to be pushed only `if
       (open.length)`, so a topic row — exactly a topic with ZERO action
       items — could never contribute a group and its photos vanished with
       no error anywhere.)

       Two things this decision does NOT change, on purpose:
         - A topic whose OWN open items were superseded by its session's
           brief still has `open.length > 0` here (substitution only changes
           what is EMITTED as action rows below, not what `open` computed
           from the raw extraction is) — so its group, and its photos, are
           unaffected. Confirmed by review; not regressed.
         - A topic whose action items are ALL `status:'done'` produces
           NEITHER an action row (nothing open) NOR a topic row (its raw
           action_items is non-empty, so it fails the §1.5 "no action items
           AT ALL" test) — it is, by the model's own stated purpose, "a
           hand-off of work remaining, not a transcript" of a fully closed
           topic. Its photos are excluded here too, deliberately: they
           evidence work that is already finished and (if a task existed)
           already communicated when that task was raised, not something
           this hand-off needs to carry again. This is the one place the
           model still silently drops something — recorded here rather than
           left implicit, and pinned by a test in the same name as this
           decision. */
    function pushGroup(t, open, photos) {
      groups.push({
        topicTitle: t.topic_title || t.title || 'Untitled topic',
        timeRange:  t.time_range || '',
        category:   t.category || '',
        items: open.map(function (a) {
          return {
            action:      a.action || a.text || '',
            responsible: a.responsible || '',
            deadline:    a.deadline || a.deadline_text || '',
          };
        }),
        photos: photos,
      });
    }

    topics.forEach(function (t) {
      var open = (t.action_items || []).filter(function (a, idx) {
        if (a && a.status) return a.status !== 'done';
        return !isDone(a, t.topic_id, idx);
      });
      var hasOwnItems = (t.action_items || []).length > 0;
      var photos = (t.related_photos || []).slice();

      var sid = t.session_id;
      var briefRows = sid ? briefRowsBySession[sid] : null;

      if (briefRows) {
        /* §2 (2026-09-18): a session with a usable brief takes ITS WHOLE
           table from the brief — this topic contributes no row of its own,
           neither an action row (superseded, unchanged from before) nor a
           topic row. The text test that used to decide topic-row
           suppression here (`isRepresented` against the topic's own
           summary) is gone entirely for this branch, not just quieted: the
           brief's own `sections` now say what produced no task (emitted
           once per session, below), and the extraction's topic text is
           never consulted again. A topic still keeps its photos whenever it
           has any — the one thing that travels per topic regardless of
           whether the topic produced a row at all (task instruction §3). */
        if (open.length || photos.length) pushGroup(t, open, photos);
      } else {
        /* No usable brief for this session (or no session_id at all):
           exactly the old behaviour — a topic with no action items of its
           own becomes a topic row from its own text, never suppressed
           (there is no brief here to test it against). */
        var topicText = hasOwnItems ? '' : topicRowText(t);
        var isTopicRow = !hasOwnItems && !!topicText;
        if (open.length || isTopicRow) pushGroup(t, open, photos);
        if (isTopicRow) topicRows.push({ text: topicText, kind: 'topic' });
      }

      if (briefRows) {
        if (!emittedSessions[sid]) {
          emittedSessions[sid] = true;
          briefRows.forEach(function (r) {
            actionRows.push({ text: r.text, at: r.at, assignee: r.assignee, due: r.due });
            fromBriefCount += 1;
          });

          /* §7.3 back-fill: every extraction action item of THIS session
             that carries a non-empty due date and is not represented in the
             brief (§7.4) is appended after the brief's own rows, in the
             extraction's own order. Matched against every one of the
             session's brief task texts — best overlap wins, not the first
             or the average. */
          var briefTexts = briefRows.map(function (r) { return r.text; });
          (extractionItemsBySession[sid] || []).forEach(function (item) {
            if (!item.due) return;
            if (isRepresented(item.text, briefTexts)) return;
            actionRows.push({ text: item.text, at: '', assignee: item.assignee, due: item.due });
            fromExtractionCount += 1;
          });

          /* §2 sunk rows: this session's brief sections that produced no
             task, `title — first bullet`, truncated by the same rule as a
             topic row. Sink after the brief's own action rows and the
             back-fill above, same position a topic row always took (§1.2:
             every action row, then every topic row) — reused `kind: 'topic'`
             deliberately: N/A cells, greyed in HTML, is exactly what "there
             is no task here" already means on this table, and a sunk brief
             section is precisely that. */
          (sunkSectionsBySession[sid] || []).forEach(function (sec) {
            var text = sectionRowText(sec);
            if (text) topicRows.push({ text: text, kind: 'topic' });
          });
        }
        /* This topic's own extraction items never surface once its session
           has been substituted — that is the replacement, not a merge. The
           back-filled items above are the one deliberate exception, and they
           are drawn from `extractionItemsBySession`, not from `open` here. */
        return;
      }

      /* No usable brief for this session (fetch failed, still pending, or
         zero tasks), or the topic carries no session_id at all: the
         extraction's own open items stay on the table exactly as before.
         An action_item carries no clock time of its own; the topic it was
         raised under does, and that is the closest true answer to "when" —
         nearer than a blank, and honest in a way an invented timestamp is
         not. */
      open.forEach(function (a) {
        actionRows.push({
          text:     a.action || a.text || '',
          at:       t.time_range || '',
          assignee: a.responsible || '',
          due:      a.deadline || a.deadline_text || '',
        });
        fromExtractionCount += 1;
      });
    });

    /* `totalItems` now means the number of action rows actually on the
       table — whichever source they came from — not a count re-derived from
       `groups`. Before this fix round the two could quietly disagree (a
       brief-substituted topic's raw open-item count is not the same number
       as the brief's own task count), and `groups` is now also carrying
       topic-row entries that contribute ZERO items. `actionRows.length` is
       the one number that matches "how many commitments does this hand-off
       carry", which is what the Copy button and the empty-state message
       (both keyed off `model.rows.length` — actionRows + topicRows — in the
       React shell below) are really asking about. */
    var totalItems = actionRows.length;
    var totalPhotos = groups.reduce(function (n, g) { return n + g.photos.length; }, 0);
    var sessionLabel = (opts.session && (opts.session.title || opts.session.label)) || 'All day';
    var site = opts.siteName || '';

    /* `rowsSource` describes the ACTUAL mix of what ended up on the table,
       not a day-wide policy choice — 'mixed' is a real, expected value the
       moment one session substituted and another did not. */
    var rowsSource = (fromBriefCount && fromExtractionCount) ? 'mixed'
      : fromBriefCount ? 'brief'
      : 'action_items';

    return {
      subject: 'Action items — ' + (site ? site + ' — ' : '') + sessionLabel
        + (opts.date ? ' (' + opts.date + ')' : ''),
      intro: 'Outstanding action items from ' + (site ? site + ' — ' : '')
        + sessionLabel + (opts.date ? ' (' + opts.date + ')' : '') + ':',
      groups: groups,
      /* One flat table: every action row, then every topic row. Nothing
         interleaved, no topic label rows breaking it up (§1.2). `groups` is
         kept alongside it only for photos, which now render below the table
         rather than inside it. */
      rows: actionRows.concat(topicRows),
      rowsSource: rowsSource,
      totalItems: totalItems,
      totalPhotos: totalPhotos,
      /* No link, ever (owner's ruling): a customer pasting this hand-off
         must never carry our internal app URL. `opts.deepLink` is not
         read even when a caller still supplies one. */
      footer: 'Generated from FieldSight',
    };
  }

  /* One line per action. Owner and deadline are the two things the reader
     acts on, so they are never folded into prose.

     NOT used by the hand-off table, and that is the point of the table:
     "Redo the wall — John (by Wed)" is exactly the register the product
     owner rejected. Owner and date get their own columns or they are not
     columns. Kept and still exported because it remains the one-line form
     for a caller that has a line and no table to put it in. */
  function actionLine(item) {
    var bits = [item.action];
    if (item.responsible) bits.push('— ' + item.responsible);
    if (item.deadline) bits.push('(by ' + item.deadline + ')');
    return bits.join(' ');
  }

  /* ---- the hand-off table ---------------------------------------------- */

  /* Three columns, in the words they were asked for in. */
  var COLUMNS = ['AGENDA ITEM', 'ASSIGNED', 'DUE DATE'];

  /* Blank stays blank for an action row: an empty cell would say the meeting
     did not state this, and it DID — it just didn't name an owner or a date.
     §1.4 makes that an em dash instead, so the reader is not left guessing
     whether a truly empty cell means "nothing was said" or "this render
     forgot to fill it in". A topic row is N/A in both cells — there is no
     task here at all, which N/A says and a dash does not (§1.5/§0).

     A raw speaker label in ASSIGNED (spk_0, spk_12, case-insensitive) is not
     a name and renders as the same em dash an unstated owner would (§1.4).

     No time suffix anywhere (§1.6): the cell is the row's text, verbatim. */
  var DASH = '—';

  function cellsFor(row) {
    row = row || {};
    if (row.kind === 'topic') return [row.text || '', 'N/A', 'N/A'];
    var assignee = row.assignee || '';
    if (isSpeakerLabel(assignee)) assignee = '';
    return [row.text || '', assignee || DASH, row.due || DASH];
  }

  /* The table's rows in render order — walked by the HTML flavour, the text
     flavour and the on-screen preview, so the three cannot drift into
     showing different documents. One flat table: every action row, then
     every topic row (§1.2) — `model.rows` is already in that order. */
  function previewBlocks(model) {
    return (model.rows || []).map(function (row) { return { kind: 'row', row: row }; });
  }

  /* The topic groups that still carry a photo, in topic order — walked by
     both renderers and the on-screen preview to put the photo section below
     the table, grouped under the topic title that evidences it (§3). */
  function photoGroups(model) {
    return (model.groups || []).filter(function (g) { return g.photos && g.photos.length; });
  }

  /* photoSrc maps a filename to an embeddable src. A filename with no entry
     is omitted — never rendered as a broken image. */
  function renderEmailHtml(model, photoSrc) {
    photoSrc = photoSrc || {};
    var TH = 'padding:6px 10px;text-align:left;font-size:11px;letter-spacing:.05em;'
      + 'color:#486581;border-bottom:2px solid #9fb3c8;white-space:nowrap';
    var TD = 'padding:6px 10px;vertical-align:top;border-bottom:1px solid #d9e2ec';
    var TD_TOPIC = TD + ';color:#666';
    var LABEL = 'padding:12px 10px 4px;font-weight:600';
    var out = [];

    out.push('<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#102A43">');
    out.push('<p>' + esc(model.intro) + '</p>');
    out.push('<table cellspacing="0" cellpadding="0" '
      + 'style="border-collapse:collapse;width:100%">');
    out.push('<thead><tr>' + COLUMNS.map(function (c) {
      return '<th style="' + TH + '">' + esc(c) + '</th>';
    }).join('') + '</tr></thead><tbody>');

    previewBlocks(model).forEach(function (b) {
      var isTopic = b.row.kind === 'topic';
      out.push('<tr>' + cellsFor(b.row).map(function (c) {
        return '<td style="' + (isTopic ? TD_TOPIC : TD) + '">' + esc(c) + '</td>';
      }).join('') + '</tr>');
    });

    out.push('</tbody></table>');

    /* Photos below the table, grouped under their topic's title — no longer
       interleaved with the rows, since the table is flat now (§3). */
    photoGroups(model).forEach(function (g) {
      var srcs = g.photos.map(function (f) { return photoSrc[f]; }).filter(Boolean);
      out.push('<p style="' + LABEL + '">' + esc(g.topicTitle) + '</p>');
      if (srcs.length) {
        out.push('<p>' + srcs.map(function (src) {
          return '<img src="' + src + '" style="max-width:420px;height:auto;'
            + 'margin:0 8px 8px 0;border:1px solid #d9e2ec;border-radius:4px" />';
        }).join('') + '</p>');
      }
    });

    out.push('<p style="color:#627d98;font-size:12px">' + esc(model.footer) + '</p>');
    out.push('</div>');
    return out.join('');
  }

  /* The plain-text flavour is a TABLE too, not a bulleted list. Every mail
     client picks the richest flavour it supports and some pick this one; a
     reader who gets a list has been sent a different document from the one
     the sender previewed. */
  function renderEmailText(model) {
    var lines = [model.intro, ''];

    /* A literal pipe inside a cell would end its column early and shift
       every later cell one to the left.

       A NEWLINE is worse: it terminates the row mid-table. A markdown-aware
       client loses every row after it, and a plain reader sees the rest of
       the line orphaned under no column at all. Brief task text comes from a
       model, so a wrapped sentence is reachable rather than theoretical —
       collapsed to a space, which is what the sentence meant anyway. */
    function cell(s) {
      return String(s == null ? '' : s)
        .replace(/\r?\n/g, ' ')
        .replace(/\|/g, '\\|');
    }
    function pipe(cells) { return '| ' + cells.map(cell).join(' | ') + ' |'; }

    lines.push(pipe(COLUMNS));
    lines.push('| --- | --- | --- |');

    previewBlocks(model).forEach(function (b) { lines.push(pipe(cellsFor(b.row))); });

    /* The text flavour cannot carry an image, so it says the photos exist —
       below the table, grouped under their topic's title — rather than
       losing them silently. */
    var groupsWithPhotos = photoGroups(model);
    if (groupsWithPhotos.length) {
      lines.push('');
      groupsWithPhotos.forEach(function (g) {
        lines.push('**' + g.topicTitle + '**');
        lines.push('[' + g.photos.length + ' photo'
          + (g.photos.length === 1 ? '' : 's') + ' attached below]');
      });
    }

    lines.push('');
    lines.push(model.footer);
    return lines.join('\n');
  }

  /* ---- photo loading (browser-only) ------------------------------------ */

  /* Fetch → downscale → data URI. Resolves to null for anything that cannot
     be read, so one unreadable photo never fails the copy. */
  /* {reason: count} -> a phrase a person can act on. Only one cause can
     reach it now that nothing is read off a canvas: a photo whose URL could
     not be resolved at all. Kept as a map so a new cause has somewhere to
     go rather than being folded into a count. */
  function skipSummary(why) {
    if (!why) return 'reason unknown';
    var parts = [];
    if (why.load) parts.push(why.load + ' had no reachable link');
    if (why.unknown) parts.push(why.unknown + ' for an unrecorded reason');
    return parts.length ? parts.join('; ') : 'reason unknown';
  }

  function EmailPreviewModal(props) {
    var fs = window.FieldSight;
    var ModalOverlay = fs.ModalOverlay;
    var h = React.createElement;

    var model = React.useMemo(function () {
      return buildPreviewModel(props);
      /* props.briefs belongs in this list: it is an input to
         buildPreviewModel, and without it a brief arriving after the modal
         first rendered would leave the table built from action_items with
         nothing to say it had not updated. */
    }, [props.topics, props.session, props.date, props.siteName,
        props.briefs]);

    var srcRef   = React.useState({});
    var photoSrc = srcRef[0];
    var setPhotoSrc = srcRef[1];
    var stateRef = React.useState('idle');   /* idle | copying | copied | error */
    var copyState = stateRef[0];
    var setCopyState = stateRef[1];
    var skipRef = React.useState(0);
    var skipped = skipRef[0];
    var setSkipped = skipRef[1];
    /* Why they were skipped, as {reason: count}. Kept beside the count
       because "2 photos were dropped" and "2 photos were dropped because the
       browser refused to read them" send someone to entirely different
       places — and the first version reported only the count, which cost two
       wrong fixes before anyone knew which failure this was. */
    var reasonRef = React.useState(null);
    var skipReason = reasonRef[0];
    var setSkipReason = reasonRef[1];

    /* Preview images use the presigned URL directly — no canvas, no CORS
       dependency — so the modal shows photos even if the embed path later
       fails. Only the COPY needs pixels. */
    React.useEffect(function () {
      if (!props.open || !props.userFolder) return undefined;
      var cancelled = false;
      var names = [];
      model.groups.forEach(function (g) {
        g.photos.forEach(function (f) { if (names.indexOf(f) < 0) names.push(f); });
      });
      if (!names.length) return undefined;
      window.FS.api.media.photoUrls({
        userDisplayName: props.userFolder, date: props.date, filenames: names,
      }).then(function (m) { if (!cancelled) setPhotoSrc(m); });
      return function () { cancelled = true; };
    }, [props.open, props.userFolder, props.date, model]);

    /* Photos travel as https URLs, not base64.

       Four attempts went the other way -- downscale each photo onto a canvas,
       read it back as a data: URI, embed that in the clipboard HTML -- and the
       paste kept arriving without images. Each attempt fixed a real defect in
       that path (a refuted cache-taint theory, a silent success label, an
       unrecorded failure reason, a stale presign) and none of them produced a
       photo in an email, which is the only outcome that counts.

       That path was wrong at the root, for two reasons that no amount of
       fixing reaches:

         * It has a long failure chain -- CORS, canvas tainting, toDataURL,
           a size budget, presign expiry -- and every link fails silently
           into "text only".
         * Gmail and Outlook strip `data:` image sources out of pasted HTML.
           Even a perfect data URI can arrive and be discarded at the far end.

       An <img src="https://..."> has neither problem. Nothing is read back,
       so canvas and CORS stop mattering entirely; and a mail client fetches
       a remote image while composing, which is the behaviour that actually
       puts a picture in a message.

       The cost, stated plainly: these are presigned URLs with a 900-second
       life. The client has to fetch them while the draft is open, which is
       the normal case -- someone pastes and sends within a minute. If it
       does not, the recipient gets a missing image rather than a wrong one,
       and the Word report remains the way to send photos that must outlive
       the paste. */
    function onCopy() {
      setCopyState('copying');
      setSkipped(0);
      setSkipReason(null);

      var names = [];
      model.groups.forEach(function (g) {
        g.photos.forEach(function (f) { if (names.indexOf(f) < 0) names.push(f); });
      });

      /* Re-presign first: the URLs the preview fetched may have aged out
         while the modal sat open, and the copy is where that starts to
         matter. Falls back to what the preview used. */
      var media = (((window.FS || {}).api) || {}).media;
      var refreshed = (media && media.photoUrls && props.userFolder && names.length)
        ? Promise.resolve(media.photoUrls({
            userDisplayName: props.userFolder, date: props.date, filenames: names,
          })).catch(function () { return {}; })
        : Promise.resolve({});

      refreshed.then(function (fresh) {
        var srcs = {}, dropped = 0;
        names.forEach(function (f) {
          var u = fresh[f] || photoSrc[f];
          if (u) srcs[f] = u; else dropped++;
        });
        setSkipped(dropped);
        if (dropped) {
          setSkipReason({ load: dropped });
          window.console && console.warn(
            '[FieldSight] copy: no URL for ' + dropped + ' photo(s)');
        }

        var html = renderEmailHtml(model, srcs);
        var text = renderEmailText(model);
        if (!navigator.clipboard || !window.ClipboardItem) {
          return navigator.clipboard
            ? navigator.clipboard.writeText(text)
            : Promise.reject(new Error('no clipboard'));
        }
        return navigator.clipboard.write([new window.ClipboardItem({
          'text/html':  new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        })]);
      }).then(function () {
        setCopyState('copied');
        window.setTimeout(function () { setCopyState('idle'); }, 2500);
      }).catch(function () { setCopyState('error'); });
    }

    if (!props.open) return null;

    /* "Copied ✓" on a copy that contained no photos is the same failure the
       backend had an hour before this was written: a quiet success and a
       quiet failure that look identical. The button promised photos, so when
       none survived it has to say so — the footnote below is not enough,
       because the person has already clicked away to paste. */
    var allPhotosLost = model.totalPhotos > 0 && skipped >= model.totalPhotos;
    var copyLabel = copyState === 'copying' ? 'Preparing…'
      : copyState === 'copied'
        ? (allPhotosLost ? 'Copied — text only' : 'Copied ✓')
      : copyState === 'error' ? 'Copy failed — try again'
      : (model.totalPhotos ? 'Copy with photos' : 'Copy');

    return h(ModalOverlay, {
      open: props.open, onClose: props.onClose,
      title: 'Email preview', size: 'lg', closeOnBackdrop: true,
    },
      h('div', { className: 'fs-email-preview' },
        h('p', { className: 'fs-email-preview__subject' },
          h('strong', null, 'Subject: '), model.subject),
        h('p', { className: 'fs-email-preview__intro' }, model.intro),
        /* The preview renders the SAME three columns, in the same order,
           that the clipboard payload does — it walks previewBlocks like
           both renderers do. This modal exists to show what is about to be
           sent; a preview in a different shape from the payload is a
           preview of something else. */
        h('table', { className: 'fs-email-preview__table' },
          h('thead', null,
            h('tr', null, COLUMNS.map(function (c, ci) {
              return h('th', { key: ci, scope: 'col' }, c);
            }))),
          h('tbody', null, previewBlocks(model).map(function (b, bi) {
            var isTopic = b.row.kind === 'topic';
            return h('tr', {
              key: bi,
              className: isTopic ? 'fs-email-preview__topic-row' : undefined,
            }, cellsFor(b.row).map(function (c, ci) {
              return h('td', { key: ci }, c);
            }));
          }))),
        /* Photos below the table, grouped under their topic's title — no
           longer interleaved with the rows, since the table is flat now. */
        photoGroups(model).length
          ? h('div', { className: 'fs-email-preview__photo-section' },
              photoGroups(model).map(function (g, gi) {
                return h('div', { key: gi, className: 'fs-email-preview__photo-group' },
                  h('p', { className: 'fs-email-preview__photo-group-title' }, g.topicTitle),
                  h('div', { className: 'fs-email-preview__photos' },
                    g.photos.map(function (f, pi) {
                      return photoSrc[f]
                        ? h('img', {
                            key: pi, src: photoSrc[f], alt: f,
                            className: 'fs-email-preview__photo',
                            /* No crossOrigin here, and that is now a measured
                               decision rather than an oversight.

                               The preview fetches without CORS and the copy
                               fetches the same URL with it, which looks like
                               the classic cache-taint trap -- the second
                               request served from the first's CORS-less entry,
                               tainting the canvas and silently dropping every
                               photo. It was shipped as a suspect for exactly
                               the reported symptom (photos visible, absent
                               once pasted).

                               Then it was measured, against a local image
                               served with the same headers the bucket sends:

                                 no-crossOrigin first        -> TAINTED
                                 crossOrigin after it        -> CLEAN

                               Chrome keys the cache by CORS mode, so the
                               preview's fetch cannot poison the copy's. The
                               hypothesis is refuted and the attribute is gone
                               again; leaving it would be a permanent fix for
                               a problem that does not exist, with a retry
                               path to maintain. */
                            /* A photo that will not load must leave no trace. A
                               broken-image icon in a PREVIEW reads as "the app is
                               broken", when the truth is narrower: this one file
                               is unreachable (expired presign, deleted object,
                               or mock mode with no real media behind it). The
                               copy path already skips what it cannot read, so
                               hiding it here keeps the two views honest with each
                               other. */
                            onError: function (e) { e.target.style.display = 'none'; },
                          })
                        : h('span', { key: pi, className: 'fs-email-preview__photo-pending' },
                            'loading photo…');
                    })));
              }))
          : null,
        /* "Nothing outstanding" compares against the TABLE — a topic-only
           session (no action items, but something to say about the day) is
           not empty, and must not read as if there is no hand-off to send
           (mirrors the backend's confirmation email, which renders the
           table for exactly this case). */
        model.rows.length === 0
          ? h('p', { className: 'fs-email-preview__empty' },
              'Nothing outstanding — there is no hand-off to send.')
          : null,
        h('p', { className: 'fs-email-preview__footer' }, model.footer),
        skipped > 0
          ? h('p', { className: 'fs-email-preview__note' },
              allPhotosLost
                /* Say the whole truth. "2 photos could not be included"
                   reads like an edge case when it is actually every photo,
                   and someone who trusts it will send evidence-free. */
                ? 'None of the ' + model.totalPhotos + ' photo'
                  + (model.totalPhotos === 1 ? '' : 's')
                  + ' could be included — the text copied in full, but you '
                  + 'will need to attach them yourself. (' + skipSummary(skipReason) + ')'
                : skipped + ' photo' + (skipped === 1 ? '' : 's')
                  + ' could not be included (unreadable, or past the size a '
                  + 'mail client will accept). The text copied in full.')
          : null,
      ),
      h('footer', { className: 'fs-email-preview__actions' },
        h('button', {
          type: 'button', className: 'fs-btn', onClick: props.onClose,
        }, 'Close'),
        h('button', {
          type: 'button', className: 'fs-btn fs-btn--primary',
          onClick: onCopy,
          disabled: copyState === 'copying' || model.rows.length === 0,
        }, copyLabel),
      ),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.EmailPreviewModal = EmailPreviewModal;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildPreviewModel: buildPreviewModel,
      renderEmailHtml: renderEmailHtml,
      renderEmailText: renderEmailText,
      skipSummary: skipSummary,
      actionLine: actionLine,
      topicRowText: topicRowText,
      sectionRowText: sectionRowText,
      isSpeakerLabel: isSpeakerLabel,
      cellsFor: cellsFor,
      TOPIC_ROW_MAX_CHARS: TOPIC_ROW_MAX_CHARS,
      isRepresented: isRepresented,
      REPRESENTED_JACCARD_THRESHOLD: REPRESENTED_JACCARD_THRESHOLD,
    };
  }
}());
