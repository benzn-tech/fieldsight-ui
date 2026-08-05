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

   Photos are DOWNSCALED before embedding (PHOTO_MAX_PX / PHOTO_QUALITY).
   Site photos run ~1.3 MB each and base64 inflates by a third: five of them
   raw is ~8 MB of clipboard HTML, which Outlook and Gmail both choke on.
   Downscaled they are ~100 KB, which is the difference between a feature and
   a hang. Reading pixels needs the lake bucket's CORS rule (GET/HEAD from the
   Amplify origins) — WITHOUT it canvas taints and toDataURL throws, so a
   photo that cannot be read is skipped rather than failing the whole copy.

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

  /* Long edge in CSS pixels. 900 keeps a wall crack legible at the size a
     mail client renders an inline image, without carrying phone-camera
     resolution nobody looks at in an email. */
  var PHOTO_MAX_PX = 900;
  var PHOTO_QUALITY = 0.7;
  /* Hard ceiling on what goes on the clipboard. Past this, clients start
     failing the paste outright — better to send fewer photos and say so. */
  var TOTAL_PHOTO_BUDGET_BYTES = 3 * 1024 * 1024;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---- pure model ------------------------------------------------------ */

  /* One entry per topic that still has something outstanding, carrying its
     own photos. Topics with nothing open are dropped: this is a hand-off of
     work remaining, not a transcript. */
  function buildPreviewModel(opts) {
    opts = opts || {};
    var topics = opts.topics || [];
    var isDone = typeof opts.isDone === 'function' ? opts.isDone : function () { return false; };
    var groups = [];

    topics.forEach(function (t) {
      var open = (t.action_items || []).filter(function (a, idx) {
        if (a && a.status) return a.status !== 'done';
        return !isDone(a, t.topic_id, idx);
      });
      if (!open.length) return;
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
    });

    var totalItems = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
    var totalPhotos = groups.reduce(function (n, g) { return n + g.photos.length; }, 0);
    var sessionLabel = (opts.session && (opts.session.title || opts.session.label)) || 'All day';
    var site = opts.siteName || '';

    return {
      subject: 'Action items — ' + (site ? site + ' — ' : '') + sessionLabel
        + (opts.date ? ' (' + opts.date + ')' : ''),
      intro: 'Outstanding action items from ' + (site ? site + ' — ' : '')
        + sessionLabel + (opts.date ? ' (' + opts.date + ')' : '') + ':',
      groups: groups,
      totalItems: totalItems,
      totalPhotos: totalPhotos,
      footer: 'Generated from FieldSight'
        + (opts.deepLink ? ' — ' + opts.deepLink : ''),
    };
  }

  /* One line per action. Owner and deadline are the two things the reader
     acts on, so they are never folded into prose. */
  function actionLine(item) {
    var bits = [item.action];
    if (item.responsible) bits.push('— ' + item.responsible);
    if (item.deadline) bits.push('(by ' + item.deadline + ')');
    return bits.join(' ');
  }

  /* photoSrc maps a filename to an embeddable src (a data URI once the
     downscale has run). A filename with no entry is omitted — never rendered
     as a broken image. */
  function renderEmailHtml(model, photoSrc) {
    photoSrc = photoSrc || {};
    var out = [];
    out.push('<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#102A43">');
    out.push('<p>' + esc(model.intro) + '</p>');
    model.groups.forEach(function (g) {
      out.push('<div style="margin:0 0 18px">');
      out.push('<p style="margin:0 0 4px;font-weight:600">' + esc(g.topicTitle)
        + (g.timeRange ? ' <span style="font-weight:400;color:#627d98">('
            + esc(g.timeRange) + ')</span>' : '') + '</p>');
      out.push('<ul style="margin:0 0 8px;padding-left:20px">');
      g.items.forEach(function (it) {
        out.push('<li style="margin:0 0 3px">' + esc(actionLine(it)) + '</li>');
      });
      out.push('</ul>');
      /* Photos sit INSIDE the topic block, which is the whole point: the
         evidence stays with the claim it evidences. */
      var srcs = g.photos.map(function (f) { return photoSrc[f]; }).filter(Boolean);
      if (srcs.length) {
        out.push('<div>');
        srcs.forEach(function (src) {
          out.push('<img src="' + src + '" style="max-width:420px;height:auto;'
            + 'margin:0 8px 8px 0;border:1px solid #d9e2ec;border-radius:4px" />');
        });
        out.push('</div>');
      }
      out.push('</div>');
    });
    out.push('<p style="color:#627d98;font-size:12px">' + esc(model.footer) + '</p>');
    out.push('</div>');
    return out.join('');
  }

  function renderEmailText(model) {
    var lines = [model.intro, ''];
    model.groups.forEach(function (g) {
      lines.push(g.topicTitle + (g.timeRange ? ' (' + g.timeRange + ')' : ''));
      g.items.forEach(function (it) { lines.push('  - ' + actionLine(it)); });
      if (g.photos.length) {
        lines.push('  [' + g.photos.length + ' photo'
          + (g.photos.length === 1 ? '' : 's') + ' attached above]');
      }
      lines.push('');
    });
    lines.push(model.footer);
    return lines.join('\n');
  }

  /* ---- photo loading (browser-only) ------------------------------------ */

  /* Fetch → downscale → data URI. Resolves to null for anything that cannot
     be read, so one unreadable photo never fails the copy. */
  /* {reason: count} -> a phrase a person can act on, and that tells ME which
     failure it was without a screen-share. Deliberately names the mechanism
     rather than apologising: "the browser would not let the page read them"
     is the sentence that distinguishes a CORS problem from a dead URL. */
  function skipSummary(why) {
    if (!why) return 'reason unknown';
    var parts = [];
    if (why.load)  parts.push(why.load + ' could not be fetched');
    if (why.taint) parts.push(why.taint + ' the browser would not let the page read');
    if (why.size)  parts.push(why.size + ' too large to attach');
    if (why.unknown) parts.push(why.unknown + ' for an unrecorded reason');
    return parts.length ? parts.join('; ') : 'reason unknown';
  }

  function loadDownscaled(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      /* Required for canvas to stay untainted; the lake bucket's CORS rule
         is what makes it work. */
      img.crossOrigin = 'anonymous';
      /* This does NOT depend on the preview also asking for CORS. That was
         assumed and then measured, against a local image served with the
         same headers the bucket sends: a no-crossOrigin load first taints,
         a crossOrigin load after it comes back CLEAN. Chrome keys the cache
         by CORS mode, so the two requests never share an entry.

         Worth knowing before reaching for the usual escape hatch: a
         cache-busting query parameter is not available here anyway. These
         are PRESIGNED S3 URLs and the signature covers the query string, so
         an extra parameter turns them into a 403. */
      /* Resolves { data } on success, or { reason } on failure — never a
         bare null. The two ways this fails need completely different fixes
         and used to be indistinguishable:

           'load'  the CORS request itself did not complete — the image
                   never arrived. Points at the URL or the bucket rule.
           'taint' it arrived, but without usable CORS headers, so
                   toDataURL refuses. Points at the response, not the fetch.

         Reported once already as "the paste has no images", and two
         plausible causes were investigated and refuted before anyone knew
         which of these it was. The cost of not knowing was two wrong fixes;
         the cost of recording it is one string. */
      img.onload = function () {
        try {
          var scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve({ data: c.toDataURL('image/jpeg', PHOTO_QUALITY) });
        } catch (e) {
          resolve({ reason: 'taint', detail: (e && e.name) || 'error' });
        }
      };
      img.onerror = function () { resolve({ reason: 'load' }); };
      img.src = url;
    });
  }

  window.FieldSight = window.FieldSight || {};

  function EmailPreviewModal(props) {
    var fs = window.FieldSight;
    var ModalOverlay = fs.ModalOverlay;
    var h = React.createElement;

    var model = React.useMemo(function () {
      return buildPreviewModel(props);
    }, [props.topics, props.session, props.date, props.siteName, props.deepLink]);

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

    function onCopy() {
      setCopyState('copying');
      setSkipped(0);
      var names = Object.keys(photoSrc);
      Promise.all(names.map(function (f) {
        return loadDownscaled(photoSrc[f]).then(function (r) {
          return { f: f, data: r && r.data, reason: r && r.reason, detail: r && r.detail };
        });
      })).then(function (rows) {
        var embed = {}, used = 0, dropped = 0, why = {};
        rows.forEach(function (r) {
          if (!r.data) {
            dropped++;
            why[r.reason || 'unknown'] = (why[r.reason || 'unknown'] || 0) + 1;
            return;
          }
          /* base64 payload length is a close enough proxy for bytes. */
          var size = r.data.length * 0.75;
          if (used + size > TOTAL_PHOTO_BUDGET_BYTES) {
            dropped++;
            why.size = (why.size || 0) + 1;
            return;
          }
          used += size;
          embed[r.f] = r.data;
        });
        setSkipped(dropped);
        setSkipReason(why);
        /* Also to the console, because the note in the modal disappears the
           moment someone closes it to go and paste. */
        if (dropped) {
          window.console && console.warn('[FieldSight] copy dropped '
            + dropped + ' photo(s):', why, rows.filter(function (r) { return !r.data; }));
        }
        var html = renderEmailHtml(model, embed);
        var text = renderEmailText(model);
        if (!navigator.clipboard || !window.ClipboardItem) {
          /* Old browser: plain text only, still better than nothing. */
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
        model.groups.map(function (g, gi) {
          return h('div', { key: gi, className: 'fs-email-preview__group' },
            h('div', { className: 'fs-email-preview__topic' },
              g.topicTitle, g.timeRange
                ? h('span', { className: 'fs-email-preview__time' }, ' (' + g.timeRange + ')')
                : null),
            h('ul', { className: 'fs-email-preview__items' },
              g.items.map(function (it, ii) {
                return h('li', { key: ii }, actionLine(it));
              })),
            g.photos.length
              ? h('div', { className: 'fs-email-preview__photos' },
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
                  }))
              : null);
        }),
        model.totalItems === 0
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
          disabled: copyState === 'copying' || model.totalItems === 0,
        }, copyLabel),
      ),
    );
  }

  window.FieldSight.EmailPreviewModal = EmailPreviewModal;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildPreviewModel: buildPreviewModel,
      renderEmailHtml: renderEmailHtml,
      renderEmailText: renderEmailText,
      skipSummary: skipSummary,
      actionLine: actionLine,
    };
  }
}());
