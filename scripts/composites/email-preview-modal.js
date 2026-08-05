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
  function loadDownscaled(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      /* Required for canvas to stay untainted; the lake bucket's CORS rule
         is what makes it work. */
      img.crossOrigin = 'anonymous';
      /* This only works because the PREVIEW image carries crossOrigin too.
         It did not, and that is what broke copying: the preview fetched the
         URL with no CORS headers requested, and the request here — same URL,
         now with crossOrigin='anonymous' — was served from that cache entry,
         failed the CORS check and tainted the canvas. toDataURL threw, every
         photo was skipped, and the paste came out as text.

         Exactly the reported symptom: photos visible in the preview, absent
         from what was pasted. The bucket's CORS rule was correct the whole
         time, which is why inspecting the response headers found nothing.

         The obvious fix — a cache-busting query param — is not available
         here: these are PRESIGNED S3 URLs and the signature covers the query
         string, so an extra parameter turns them into a 403. */
      img.onload = function () {
        try {
          var scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', PHOTO_QUALITY));
        } catch (e) {
          resolve(null);           /* tainted canvas → skip this one */
        }
      };
      img.onerror = function () { resolve(null); };
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
        return loadDownscaled(photoSrc[f]).then(function (d) { return { f: f, data: d }; });
      })).then(function (rows) {
        var embed = {}, used = 0, dropped = 0;
        rows.forEach(function (r) {
          if (!r.data) { dropped++; return; }
          /* base64 payload length is a close enough proxy for bytes. */
          var size = r.data.length * 0.75;
          if (used + size > TOTAL_PHOTO_BUDGET_BYTES) { dropped++; return; }
          used += size;
          embed[r.f] = r.data;
        });
        setSkipped(dropped);
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
                          /* The preview does not need CORS -- but the COPY
                             does, and this request is the one that populates
                             the cache. Asking for it here means the single
                             cache entry is usable by both, instead of the
                             copy re-requesting a URL the browser may hand
                             back from a CORS-less entry.

                             This is a SUSPECT, not a confirmed cause: it
                             could not be tested from here, because the
                             bucket's CORS rule allows only the two Amplify
                             origins and a local page is refused outright.
                             So it degrades rather than betting -- onError
                             drops the attribute and reloads, which is
                             exactly what the preview did before. The worst
                             case is one wasted request; a blank preview is
                             not on the table. */
                          crossOrigin: 'anonymous',
                          onError: function (e) {
                            var el = e.target;
                            if (el.crossOrigin) {
                              el.crossOrigin = null;
                              el.src = photoSrc[f];      /* retry plain */
                              return;
                            }
                            el.style.display = 'none';
                          },
                          /* A photo that will not load must leave no trace. A
                             broken-image icon in a PREVIEW reads as "the app is
                             broken", when the truth is narrower: this one file
                             is unreachable (expired presign, deleted object,
                             or mock mode with no real media behind it). The
                             copy path already skips what it cannot read, so
                             hiding it here keeps the two views honest with each
                             other. */
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
                  + 'will need to attach them yourself.'
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
      actionLine: actionLine,
    };
  }
}());
