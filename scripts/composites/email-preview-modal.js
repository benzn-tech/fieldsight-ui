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
     deepLink    string?

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
      sessionIndex: sessionIndex,
      taskIndex:    taskIndex,
    };
  }

  /* How much of a topic's own summary rides in its row (§1.5). Mirrors
     `lambda_item_writer.TOPIC_ROW_MAX_CHARS` exactly — this is the shared
     constant the parity test pins against. */
  var TOPIC_ROW_MAX_CHARS = 180;

  /* The text for a topic that produced no action items, built byte-for-byte
     the way `lambda_item_writer._topic_rows` builds it, so the email and
     "Preview & copy" cannot drift into showing two different sentences for
     the same topic. Returns '' when there is nothing to say (no title, no
     summary) — the caller drops the row rather than emitting a blank one. */
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
    if (text.length > TOPIC_ROW_MAX_CHARS) {
      text = text.slice(0, TOPIC_ROW_MAX_CHARS - 1).replace(/\s+$/, '') + '…';
    }
    return text;
  }

  /* A raw speaker label ("spk_0", "spk_12", case-insensitive) is not a name
     (§1.4) — it is what the diarizer wrote when nobody stated who the owner
     was, and showing it as an assignee would tell the reader it was. */
  function isSpeakerLabel(s) {
    return /^spk_\d+$/i.test(String(s == null ? '' : s).trim());
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
  function briefsBySession(briefs) {
    var map = {};
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
      map[b.sessionId] = rows;
    });
    return map;
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
    var briefRowsBySession = briefsBySession(opts.briefs || []);
    var emittedSessions = {};
    var actionRows = [];
    var fromBriefCount = 0;
    var fromExtractionCount = 0;

    topics.forEach(function (t) {
      var open = (t.action_items || []).filter(function (a, idx) {
        if (a && a.status) return a.status !== 'done';
        return !isDone(a, t.topic_id, idx);
      });
      if (open.length) {
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
          photos: (t.related_photos || []).slice(),
        });
      }

      var sid = t.session_id;
      var briefRows = sid ? briefRowsBySession[sid] : null;

      if (briefRows) {
        if (!emittedSessions[sid]) {
          emittedSessions[sid] = true;
          briefRows.forEach(function (r) {
            actionRows.push({ text: r.text, at: r.at, assignee: r.assignee, due: r.due });
            fromBriefCount += 1;
          });
        }
        /* This topic's own extraction items never surface once its session
           has been substituted — that is the replacement, not a merge. */
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

    var totalItems = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
    var totalPhotos = groups.reduce(function (n, g) { return n + g.photos.length; }, 0);
    var sessionLabel = (opts.session && (opts.session.title || opts.session.label)) || 'All day';
    var site = opts.siteName || '';

    /* `rowsSource` describes the ACTUAL mix of what ended up on the table,
       not a day-wide policy choice — 'mixed' is a real, expected value the
       moment one session substituted and another did not. */
    var rowsSource = (fromBriefCount && fromExtractionCount) ? 'mixed'
      : fromBriefCount ? 'brief'
      : 'action_items';

    /* Topic rows (§1.5) sink to the bottom of the SAME table, after every
       action row. A topic belongs here only when its extraction produced NO
       action items AT ALL — raw presence, not "nothing still open" — because
       a topic whose only item was ticked off is already accounted for by
       having been in the action-row set once; listing it again here would
       double it. This is unaffected by brief substitution: a topic that had
       action items superseded by its session's brief is not "topics that
       produced no action items" — it produced some, they are just told a
       different way. */
    var topicRows = [];
    topics.forEach(function (t) {
      if ((t.action_items || []).length) return;
      var text = topicRowText(t);
      if (!text) return;
      topicRows.push({ text: text, kind: 'topic' });
    });

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
      footer: 'Generated from FieldSight'
        + (opts.deepLink ? ' — ' + opts.deepLink : ''),
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
    }, [props.topics, props.session, props.date, props.siteName, props.deepLink,
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
      isSpeakerLabel: isSpeakerLabel,
      cellsFor: cellsFor,
      TOPIC_ROW_MAX_CHARS: TOPIC_ROW_MAX_CHARS,
    };
  }
}());
