/* ==========================================================================
   FieldSight SessionReportModal — Layer 5 composite (Delivery-C Tier-2)
   --------------------------------------------------------------------------
   The per-session report review flow: preview the company template, fill the
   confirmed fields (attendees / weather / sign-off), review, generate a
   Word/PDF, then download or email it. A thin wrapper over ModalOverlay
   (closeOnBackdrop:false — it holds unsaved form input), driving a step
   state-machine: preview -> fill -> review -> generating -> done | error.

   Backend = the F1 org client (scripts/api/org.js):
     org.getSessionReportPreview / generateSessionReport / getSessionReportStatus
   Async contract: generate -> {status:'queued', requestId}; poll status until
   done{docUrl,emailed} | error.

   The testable logic (buildGeneratePayload, interpretReportStatus) is factored
   into pure helpers + exported via module.exports for node --test — the same
   split as timeline.js's buildSessionEmailDraft. The React shell itself is not
   unit-tested (no DOM in the node harness), like the other L5 composites.

   Props:
     open        boolean
     onClose     () => void
     session     {session_id, participants[], ...} — the picked session
     date        string (YYYY-MM-DD)
     userFolder  string — the recording folder (org 'user' param)
     siteName    string?
     topics      array — the session's visible topics (for the preview)

   Exported to: window.FieldSight.SessionReportModal
   F3 fills PreviewStep, F4 FillStep, F6 the download/email done step.
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var STEPS = ['preview', 'fill', 'review', 'generating', 'done'];

  // ---- pure helpers (exported for node --test) --------------------------

  function buildGeneratePayload(ctx) {
    // ctx = {scope?, session, date, userFolder, form:{templateId,title,attendees,fields}, deliver, recipients, topicRowIds?}
    var form = (ctx && ctx.form) || {};
    var deliver = ctx && ctx.deliver === 'email' ? 'email' : 'download';
    var payload = {
      date: ctx ? ctx.date : undefined,
      user: ctx ? ctx.userFolder : undefined,
      templateId: form.templateId || null,
      title: (form.title || '').trim(),
      attendees: Array.isArray(form.attendees) ? form.attendees : [],
      fields: form.fields || {},
      deliver: deliver,
      // recipients only travel when emailing (download has no addressees)
      recipients: deliver === 'email' && Array.isArray(ctx.recipients) ? ctx.recipients : [],
    };
    /* Pinned to the version the chooser showed, not to "whatever is current
       when the worker gets there": between picking a template and pressing
       Generate, somebody else can save a new version, and the report would
       then not be the template this person was looking at.

       Added only when there is one, never as a present-but-undefined key.
       scripts/api/org.js learned the same thing one batch ago -- the encoding
       drops undefined either way, but this object is read before it is
       encoded, and absent has to mean absent at every layer. */
    if (form.templateId && form.templateVersion != null) {
      payload.templateVersion = form.templateVersion;
    }

    // A day is addressed by its date and has no session id (spec 2026-09-15 §5.1).
    // A meeting payload is exactly what it was before a day scope existed.
    if (ctx && ctx.scope === 'day') {
      payload.scope = 'day';
    } else {
      payload.sessionId = ctx && ctx.session ? ctx.session.session_id : undefined;
    }
    // ABSENT means "everything in scope". Only a real subset travels: the backend
    // rejects an empty list (asking for nothing) and treats a missing one as everything.
    if (ctx && Array.isArray(ctx.topicRowIds) && ctx.topicRowIds.length) {
      payload.topicRowIds = ctx.topicRowIds.slice();
    }
    return payload;
  }

  /* Shared translation of the org client's "no folder mapping" server text (see
     scripts/api/_fetch.js's 403 envelope) into the one thing the reviewer can
     actually act on. Returns null when the raw text does not match, so callers
     fall back to their own generic wording. */
  function noFolderMappingMessage(raw) {
    return /no folder mapping/i.test(raw || '')
      ? 'Your account has no recording folder yet, so there is nothing of yours to report on.'
      : null;
  }

  /* What to tell the reviewer when the preview could not be built. A worker whose account
     has no recording folder gets a 403 from the server; "unavailable" would hide the one
     thing they can act on (spec 2026-09-15 §5.7). */
  function previewErrorMessage(res) {
    var raw = (res && res.error) || '';
    return noFolderMappingMessage(raw) || raw || 'Preview is unavailable here.';
  }

  /* The server's reason when a report did not start (spec §5.2), not a generic line. */
  function generateErrorMessage(res) {
    return (res && res.error) || 'The report did not start.';
  }

  function interpretReportStatus(res, scope) {
    // Map a generate / status response to a UI phase. Mirrors the F1 client's
    // envelopes: {_accessDenied}/{_notFound} (never thrown), {status:'unavailable'}
    // (gated off), and the async {queued|done|error} contract.
    if (!res) return { phase: 'error', message: 'You don’t have access to this report.' };
    if (res._accessDenied) {
      var deniedMessage = noFolderMappingMessage(res.error) || res.error || 'You don’t have access to this report.';
      return { phase: 'error', message: deniedMessage };
    }
    if (res._notFound) {
      return { phase: 'error', message: scope === 'day' ? 'Nothing was found for this day.' : 'Session not found.' };
    }
    var status = res.status;
    if (status === 'done') return { phase: 'done', docUrl: res.docUrl || null, emailed: !!res.emailed };
    if (status === 'error') return { phase: 'error', message: res.error || 'Report generation failed.' };
    if (status === 'unavailable') return { phase: 'error', message: 'Report generation is unavailable here.' };
    return { phase: 'pending' };   // queued / pending / anything not yet terminal
  }

  function previewFieldDefaults(preview) {
    // The editable defaults the modal pre-fills from the preview response
    // (session_report_preview.fieldDefaults), with top-level fallbacks.
    var d = (preview && preview.fieldDefaults) || {};
    return {
      title: d.title || (preview && preview.title) || '',
      attendees: Array.isArray(d.attendees) ? d.attendees
               : (Array.isArray(preview && preview.participants) ? preview.participants : []),
    };
  }

  function parseAttendees(text) {
    // Fill-step textarea (one name per line, or comma-separated) -> trimmed,
    // de-blanked array (the F1 generate body's `attendees`). Also parses the
    // email-recipients textarea (same shape).
    return String(text == null ? '' : text).split(/[\n,]/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return !!s; });
  }

  /* A NAMED TEMPLATE AND EMAIL ARE MUTUALLY EXCLUSIVE, and the backend says so
     first: lambda_org_api._generation_request refuses that combination outright
     ("a generated report can only be downloaded for now"), because the worker's
     generate branch always writes `emailed: false` and would produce a document
     nobody receives.

     So the UI must never let someone assemble that request. Not as politeness
     -- a form that can only be submitted to a 400 is a form that teaches people
     the feature is broken. Returns the reason, or null when the pair is fine,
     so the control can say WHY it is disabled rather than just being dead. */
  function emailBlockedBecause(templateId) {
    return templateId
      ? 'A report written to a template can only be downloaded for now.'
      : null;
  }

  function canGenerate(deliver, recipients, selection, templateId) {
    /* Belt and braces with the radio being disabled: if email is somehow still
       selected alongside a template, Generate must not fire. */
    if (deliver === 'email' && emailBlockedBecause(templateId)) return false;
    // Email delivery needs at least one recipient (the backend rejects email with
    // none); download is always allowed. Gates the review step's Generate button.
    // `selection` is selectedRowIds' result: null = the whole meeting, [] = the
    // reviewer unticked everything, which is a report about nothing.
    if (Array.isArray(selection) && selection.length === 0) return false;
    return deliver !== 'email' || (Array.isArray(recipients) && recipients.length > 0);
  }

  // ---- Choosing what the report covers ------------------------------------
  //
  // A topic's time_range is the device's wall clock ("13:40 – 13:41"), and the
  // timeline shows it verbatim, so a window picked here is in the same clock the
  // device stamped. No timezone conversion exists anywhere in this path, and
  // none is needed while both ends of the comparison are that one clock.

  function _minutes(h, m) {
    h = Number(h); m = Number(m);
    if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return null;
    return h * 60 + m;
  }

  function parseClock(v) {
    // What an <input type="time"> produces: "HH:MM". Anything else is no clock.
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
    return m ? _minutes(m[1], m[2]) : null;
  }

  function parseTimeRange(tr) {
    // "HH:MM[:SS] <dash> HH:MM[:SS]" with any dash, or a single time. Returns
    // {start,end} in minutes, or null when the string cannot place the topic --
    // including a range that runs backwards, which is either a model error or a
    // midnight wrap, and in both cases we cannot say which minutes it covers.
    if (typeof tr !== 'string') return null;
    var re = /(\d{1,2}):(\d{2})(?::\d{2})?/g, found = [], m;
    while ((m = re.exec(tr)) && found.length < 2) {
      var v = _minutes(m[1], m[2]);
      if (v === null) return null;
      found.push(v);
    }
    if (!found.length) return null;
    var start = found[0], end = found.length > 1 ? found[1] : found[0];
    return end < start ? null : { start: start, end: end };
  }

  function overlapsWindow(timeRange, from, to) {
    // OVERLAP, not "starts inside": a discussion running 11:20-11:50 is still
    // going on when a 9:00-11:30 window closes. An unplaceable topic or an
    // unreadable window selects nothing -- a range must never widen to "all".
    var r = parseTimeRange(timeRange), f = parseClock(from), t = parseClock(to);
    if (!r || f === null || t === null || f > t) return false;
    return r.start <= t && r.end >= f;
  }

  function windowChecked(topics, from, to) {
    // The tick state a window produces: {topic_row_id: bool}.
    var out = {};
    (topics || []).forEach(function (t) {
      if (t && t.topic_row_id) out[t.topic_row_id] = overlapsWindow(t.time_range, from, to);
    });
    return out;
  }

  function selectedRowIds(topics, checked) {
    // null when every choosable topic is ticked (send nothing: the whole
    // meeting), otherwise the ticked ids in meeting order -- possibly [].
    // A topic is ticked unless explicitly unticked, so a fresh modal is the
    // whole meeting. A topic with no topic_row_id cannot be named in a
    // selection at all; it is not counted either way.
    var ids = [], all = true;
    (topics || []).forEach(function (t) {
      if (!t || !t.topic_row_id) return;
      if (checked && checked[t.topic_row_id] === false) all = false;
      else ids.push(t.topic_row_id);
    });
    return all ? null : ids;
  }

  // ---- React shell (browser only; not exercised by node tests) ----------

  /* Which template the report is written to. Absent is not a gap in the form:
     it is the assembled report -- today's behaviour, zero model calls -- so
     "None" is a real, first-class choice and is the default.

     Templates come from the Library (FS.api.templates). A failure to load them
     is NOT an empty list: an empty list reads as "your company has no
     templates", which is a different and wrong statement, and it would quietly
     remove the only choice this step exists to offer. */
  function TemplateChooser(props) {
    var h = React.createElement;
    var s_state = React.useState({ phase: 'loading', rows: [] });
    var st = s_state[0], setSt = s_state[1];

    React.useEffect(function () {
      var alive = true;
      var api = (((window.FS || {}).api) || {}).templates;
      if (!api || !api.list) { setSt({ phase: 'unavailable', rows: [] }); return undefined; }
      api.list().then(function (res) {
        if (!alive) return;
        var rows = ((res && res.templates) || []).filter(function (t) {
          /* A template with no content yet cannot write anything, and the
             backend refuses it. Offering it would be offering a 400. */
          return t._status !== 'empty';
        });
        setSt({ phase: 'ok', rows: rows });
      }).catch(function () {
        if (alive) setSt({ phase: 'error', rows: [] });
      });
      return function () { alive = false; };
    }, []);

    var options = [h('option', { key: '_none', value: '' }, 'None - the standard report')];
    st.rows.forEach(function (t) {
      options.push(h('option', { key: t.id, value: t.id },
        t.title + (t.scope === 'personal' ? ' (yours)' : '')));
    });

    return h('label', { className: 'fs-field fs-srm__template' },
      h('span', { className: 'fs-field__label' }, 'Template'),
      h('select', {
        className: 'fs-input', value: props.templateId || '',
        disabled: st.phase === 'loading',
        onChange: function (e) {
          var id = e.target.value || null;
          var row = st.rows.filter(function (t) { return t.id === id; })[0];
          props.onChoose(id, row && row.version);
        },
      }, options),
      st.phase === 'error'
        ? h('span', { className: 'fs-field__hint fs-field__hint--error' },
            'Could not load your templates. The standard report is still available.')
        : null,
      st.phase === 'unavailable'
        ? h('span', { className: 'fs-field__hint' },
            'Templates are unavailable here; the standard report is still available.')
        : null);
  }

  function FillStep(props) {
    var h = React.createElement;
    var form = props.form || {}, setForm = props.setForm || function () {};
    var s_att = React.useState((form.attendees || []).join('\n'));
    var attText = s_att[0], setAttText = s_att[1];
    var fields = form.fields || {};
    function setTitle(v) { setForm(function (f) { return Object.assign({}, f, { title: v }); }); }
    function onAtt(v) {
      setAttText(v);
      setForm(function (f) { return Object.assign({}, f, { attendees: parseAttendees(v) }); });
    }
    function setField(key, v) {
      setForm(function (f) {
        var nf = Object.assign({}, f.fields); nf[key] = v;
        return Object.assign({}, f, { fields: nf });
      });
    }
    function field(label, node) {
      return h('label', { className: 'fs-field' },
        h('span', { className: 'fs-field__label' }, label), node);
    }
    return h('div', { className: 'fs-srm__step fs-srm__fill' },
      /* First, because it is the choice the rest of the report follows from --
         and because someone who came here to use a particular format should
         not have to fill a title before discovering whether they can. */
      h(TemplateChooser, {
        templateId: form.templateId,
        onChoose: props.onChooseTemplate || function () {},
      }),
      field('Report title', h('input', {
        type: 'text', className: 'fs-input', value: form.title || '',
        onChange: function (e) { setTitle(e.target.value); },
      })),
      field('Attendees (one per line)', h('textarea', {
        className: 'fs-input', rows: 3, value: attText,
        onChange: function (e) { onAtt(e.target.value); },
      })),
      field('Weather', h('input', {
        type: 'text', className: 'fs-input', value: fields.weather || '',
        onChange: function (e) { setField('weather', e.target.value); },
      })),
      field('Sign-off', h('input', {
        type: 'text', className: 'fs-input', value: fields.sign_off || '',
        onChange: function (e) { setField('sign_off', e.target.value); },
      })));
  }

  function DeliveryChooser(props) {
    var h = React.createElement;
    function mode(value, label, blockedBecause) {
      /* Disabled WITH its reason, never hidden. A control that vanishes is
         indistinguishable from a feature that was removed -- this file's
         sibling in timeline.js already learned that the hard way. */
      return h('label', {
        className: 'fs-srm__delivery-mode'
          + (blockedBecause ? ' fs-srm__delivery-mode--blocked' : ''),
        title: blockedBecause || undefined,
      },
        h('input', {
          type: 'radio', name: 'fs-srm-deliver', checked: props.deliver === value,
          disabled: !!blockedBecause,
          onChange: function () { if (!blockedBecause) props.onDeliver(value); },
        }), ' ' + label);
    }
    var emailBlocked = props.emailBlockedBecause || null;
    return h('div', { className: 'fs-srm__delivery' },
      h('div', { className: 'fs-srm__delivery-modes' },
        mode('download', 'Download', null), mode('email', 'Email', emailBlocked)),
      emailBlocked ? h('p', { className: 'fs-srm__delivery-note' }, emailBlocked) : null,
      props.deliver === 'email'
        ? h('label', { className: 'fs-field' },
            h('span', { className: 'fs-field__label' }, 'Recipients (one per line)'),
            h('textarea', {
              className: 'fs-input', rows: 2, value: props.recipientsText, placeholder: 'name@company.com',
              onChange: function (e) { props.onRecipients(e.target.value); },
            }))
        : null);
  }

  function SessionReportModal(props) {
    var h = React.createElement;
    var ModalOverlay = (window.FieldSight || {}).ModalOverlay;
    var org = (((window.FS || {}).api) || {}).org || {};

    var s_step = React.useState('preview'); var step = s_step[0], setStep = s_step[1];
    var s_form = React.useState({ templateId: null, title: '', attendees: [], fields: {} });
    var form = s_form[0], setForm = s_form[1];   // setForm seeds defaults (F3) + F4's FillStep
    var s_preview = React.useState(null); var preview = s_preview[0], setPreview = s_preview[1];
    var s_pverr = React.useState(null); var previewErr = s_pverr[0], setPreviewErr = s_pverr[1];
    var s_deliver = React.useState('download'); var deliver = s_deliver[0], setDeliver = s_deliver[1];
    var s_recip = React.useState([]); var recipients = s_recip[0], setRecip = s_recip[1];
    var s_recipText = React.useState(''); var recipText = s_recipText[0], setRecipText = s_recipText[1];
    var s_req = React.useState(null); var reqId = s_req[0], setReqId = s_req[1];
    var s_result = React.useState(null); var result = s_result[0], setResult = s_result[1];
    var s_error = React.useState(null); var error = s_error[0], setError = s_error[1];
    var s_photos = React.useState({}); var photoSrc = s_photos[0], setPhotoSrc = s_photos[1];
    var s_checked = React.useState({}); var checked = s_checked[0], setChecked = s_checked[1];
    var s_wf = React.useState(''); var winFrom = s_wf[0], setWinFrom = s_wf[1];
    var s_wt = React.useState(''); var winTo = s_wt[0], setWinTo = s_wt[1];

    function sid() { return props.session ? props.session.session_id : null; }

    function scopeOpts() {
      return props.scope === 'day'
        ? { scope: 'day', date: props.date, user: props.userFolder }
        : { sessionId: sid(), date: props.date, user: props.userFolder };
    }

    // Reset the wizard whenever it (re)opens.
    React.useEffect(function () {
      if (props.open) {
        setStep('preview'); setReqId(null); setResult(null); setError(null);
        setPreview(null); setPreviewErr(null); setPhotoSrc({});
        setDeliver('download'); setRecip([]); setRecipText('');
        setChecked({}); setWinFrom(''); setWinTo('');
      }
    }, [props.open]);

    // F3 — on open, fetch the assembled preview (the backend renders the session's
    // content into the report shape) and seed the editable field defaults. The
    // client returns the content or a benign {_accessDenied}/{_notFound}/
    // {status:'unavailable'} envelope (never throws) — surface those as an error.
    React.useEffect(function () {
      if (!props.open || !org.getSessionReportPreview) return undefined;
      var alive = true;
      Promise.resolve(org.getSessionReportPreview(scopeOpts())).then(function (res) {
        if (!alive) return;
        if (!res || res._accessDenied || res._notFound || res.status === 'unavailable') {
          setPreviewErr(previewErrorMessage(res)); return;
        }
        setPreview(res);
        var d = previewFieldDefaults(res);
        setForm(function (f) {
          return { templateId: f.templateId, title: d.title, attendees: d.attendees, fields: f.fields };
        });
      }).catch(function () { if (alive) setPreviewErr('Could not load the preview.'); });
      return function () { alive = false; };
    }, [props.open]);

    /* Presign the topics' photos once the preview lands. This review step is
       where someone decides whether the report is right before it is generated
       and possibly emailed — and a topic's photograph is the part of it they
       can check fastest. Showing the prose without the evidence made the
       reviewer approve something they had not actually seen.

       Failure is deliberately silent: photoUrls omits a key it cannot
       presign, so a missing picture costs its own thumbnail and nothing
       else. The report itself is assembled server-side and does not depend
       on any of this. */
    React.useEffect(function () {
      if (!props.open || !preview || !props.userFolder) return undefined;
      var media = (((window.FS || {}).api) || {}).media;
      if (!media || !media.photoUrls) return undefined;
      var names = [];
      (preview.topics || []).forEach(function (t) {
        (t.related_photos || []).forEach(function (f) { names.push(f); });
      });
      if (!names.length) return undefined;
      var alive = true;
      media.photoUrls({
        userDisplayName: props.userFolder,
        date: preview.date || props.date,
        filenames: names,
      }).then(function (m) { if (alive) setPhotoSrc(m); });
      return function () { alive = false; };
    }, [props.open, preview, props.userFolder]);

    // F5 — poll the async status while generating, until a terminal phase.
    React.useEffect(function () {
      if (step !== 'generating' || !reqId) return undefined;
      var alive = true, timer = null;
      function tick() {
        if (!alive) return;
        Promise.resolve(org.getSessionReportStatus(Object.assign(scopeOpts(), { requestId: reqId })))
          .then(function (res) {
          if (!alive) return;
          var v = interpretReportStatus(res, props.scope);
          if (v.phase === 'done') { setResult(v); setStep('done'); }
          else if (v.phase === 'error') { setError(v.message); setStep('error'); }
          else { timer = setTimeout(tick, 2000); }
        }).catch(function () {
          if (alive) { setError('Could not check the report status.'); setStep('error'); }
        });
      }
      tick();
      return function () { alive = false; if (timer) clearTimeout(timer); };
    }, [step, reqId]);

    function onGenerate() {
      setError(null); setStep('generating');
      var payload = buildGeneratePayload({
        scope: props.scope,
        session: props.session, date: props.date, userFolder: props.userFolder,
        form: form, deliver: deliver, recipients: recipients,
        topicRowIds: selectedRowIds(preview ? preview.topics : [], checked),
      });
      Promise.resolve(org.generateSessionReport(payload)).then(function (res) {
        var v = interpretReportStatus(res, props.scope);
        if (v.phase === 'error') { setError(v.message); setStep('error'); return; }
        if (v.phase === 'done') { setResult(v); setStep('done'); return; }
        if (res && res.requestId) { setReqId(res.requestId); }      // hands off to the poll effect
        else { setError(generateErrorMessage(res)); setStep('error'); }
      }).catch(function () { setError('Could not start report generation.'); setStep('error'); });
    }

    /* A topic's photos, or nothing at all. Only files that presigned get an
       <img>; one that then fails to decode hides itself, because a
       broken-image icon in a REVIEW step reads as "the report is broken"
       when the truth is narrower — this one file is unreachable. */
    function photoStrip(filenames) {
      var srcs = (filenames || []).map(function (f) { return photoSrc[f]; }).filter(Boolean);
      if (!srcs.length) return null;
      return h('div', { className: 'fs-srm__preview-photos' },
        srcs.map(function (src, i) {
          return h('img', {
            key: i, src: src, alt: '', className: 'fs-srm__preview-photo',
            onError: function (e) { e.target.style.display = 'none'; },
          });
        }));
    }

    function btn(label, onClick, variant) {
      return h('button', {
        type: 'button', className: 'fs-btn' + (variant ? ' fs-btn--' + variant : ''), onClick: onClick,
      }, label);
    }

    var pTopics = (preview && preview.topics) || [];
    var choosable = pTopics.filter(function (t) { return t && t.topic_row_id; }).length;
    var selection = selectedRowIds(pTopics, checked);
    var chosenCount = selection === null ? choosable : selection.length;
    var unplaceable = pTopics.filter(function (t) {
      return t && t.topic_row_id && !parseTimeRange(t.time_range);
    }).length;
    function toggle(id) {
      setChecked(function (c) { var n = Object.assign({}, c); n[id] = (c[id] === false); return n; });
    }

    // Step bodies — placeholders for F3 (preview) / F4 (fill) / F6 (done UI).
    var body;
    if (step === 'preview') {
      if (previewErr) {
        body = h('div', { className: 'fs-srm__step fs-srm__step--error' }, h('p', null, previewErr));
      } else if (!preview) {
        body = h('div', { className: 'fs-srm__step' }, h('p', { className: 'fs-srm__hint' }, 'Loading preview…'));
      } else {
        body = h('div', { className: 'fs-srm__step fs-srm__preview' },
          h('h3', { className: 'fs-srm__preview-title' },
            preview.title || (props.scope === 'day' ? 'Day report' : 'Session report')),
          h('p', { className: 'fs-srm__preview-meta' }, [preview.siteName, preview.date].filter(Boolean).join(' · ')),
          (preview.participants && preview.participants.length)
            ? h('p', { className: 'fs-srm__preview-attendees' }, 'Attendees: ' + preview.participants.join(', ')) : null,
          choosable ? h('div', { className: 'fs-srm__window' },
            h('span', { className: 'fs-srm__window-label' }, 'Cover only'),
            h('input', { type: 'time', className: 'fs-input fs-srm__window-time', value: winFrom,
              'aria-label': 'Window start', onChange: function (e) { setWinFrom(e.target.value); } }),
            h('span', null, '–'),
            h('input', { type: 'time', className: 'fs-input fs-srm__window-time', value: winTo,
              'aria-label': 'Window end', onChange: function (e) { setWinTo(e.target.value); } }),
            btn('Select this window', function () { setChecked(windowChecked(pTopics, winFrom, winTo)); }),
            btn('Select all', function () { setChecked({}); }),
            h('span', { className: 'fs-srm__window-count' },
              chosenCount + ' of ' + choosable + ' topics'
              + (unplaceable ? ' · ' + unplaceable + ' without a time, not picked by a window' : ''))) : null,
          h('div', { className: 'fs-srm__preview-topics' },
            (preview.topics || []).map(function (t, i) {
              var on = !t.topic_row_id || checked[t.topic_row_id] !== false;
              return h('div', { key: i, className: 'fs-srm__preview-topic' + (on ? '' : ' fs-srm__preview-topic--off') },
                h('h4', null,
                  t.topic_row_id ? h('input', { type: 'checkbox', checked: on,
                    'aria-label': 'Include this topic', onChange: function () { toggle(t.topic_row_id); } }) : null,
                  ' ',
                  t.time_range ? h('span', { className: 'fs-srm__preview-time' }, t.time_range + ' · ') : null,
                  t.topic_title || t.title || ('Topic ' + (i + 1))),
                t.summary ? h('p', null, t.summary) : null,
                (t.action_items && t.action_items.length)
                  ? h('ul', { className: 'fs-srm__preview-actions' },
                      t.action_items.map(function (a, j) {
                        return h('li', { key: j },
                          (a.action || a.text || '') + (a.responsible ? ' — ' + a.responsible : ''));
                      }))
                  : null,
                /* Inside the topic block, after its actions — the photo is
                   evidence FOR this topic, and a strip at the bottom of the
                   modal would make the reader guess which claim it backs. */
                photoStrip(t.related_photos));
            })));
      }
    } else if (step === 'fill') {
      body = h(FillStep, {
        form: form, setForm: setForm,
        onChooseTemplate: function (id, version) {
          setForm(function (f) {
            return Object.assign({}, f, { templateId: id, templateVersion: id ? version : null });
          });
          /* Choosing a template while Email is selected would leave the form in
             the one state the backend refuses. Fall back to download rather
             than letting Generate be dead with no explanation. */
          if (id) setDeliver('download');
        },
      });
    } else if (step === 'review') {
      body = h('div', { className: 'fs-srm__step fs-srm__review' },
        h('p', { className: 'fs-srm__hint' }, 'Review, choose how to deliver, then generate.'),
        h('ul', { className: 'fs-srm__review-summary' },
          h('li', null, 'Title: ' + (form.title || '—')),
          h('li', null, 'Attendees: ' + ((form.attendees || []).length)),
          h('li', null, 'Topics: ' + chosenCount + ' of ' + choosable)),
        h(DeliveryChooser, {
          deliver: deliver, onDeliver: setDeliver,
          emailBlockedBecause: emailBlockedBecause(form.templateId),
          recipientsText: recipText,
          onRecipients: function (v) { setRecipText(v); setRecip(parseAttendees(v)); },
        }));
    } else if (step === 'generating') {
      body = h('div', { className: 'fs-srm__step' }, h('p', null, 'Generating your report…'));
    } else if (step === 'done') {
      body = h('div', { className: 'fs-srm__step fs-srm__done' },
        h('p', { className: 'fs-srm__done-msg' },
          (result && result.emailed) ? 'Your report has been emailed.' : 'Your report is ready.'),
        (result && result.docUrl)
          ? h('a', {
              className: 'fs-btn fs-btn--primary', href: result.docUrl,
              target: '_blank', rel: 'noopener', download: '',
            }, 'Download report')
          : null);
    } else {  // error
      body = h('div', { className: 'fs-srm__step fs-srm__step--error' },
        h('p', null, error || 'Something went wrong.'));
    }

    var footer;
    if (step === 'preview') footer = h('footer', { className: 'fs-srm__footer' },
      btn('Cancel', props.onClose), btn('Next', function () { setStep('fill'); }, 'primary'));
    else if (step === 'fill') footer = h('footer', { className: 'fs-srm__footer' },
      btn('Back', function () { setStep('preview'); }), btn('Next', function () { setStep('review'); }, 'primary'));
    else if (step === 'review') footer = h('footer', { className: 'fs-srm__footer' },
      btn('Back', function () { setStep('fill'); }),
      h('button', {
        type: 'button', className: 'fs-btn fs-btn--primary',
        disabled: !canGenerate(deliver, recipients, selection, form.templateId),
        title: canGenerate(deliver, recipients, selection, form.templateId) ? undefined
          : (Array.isArray(selection) && !selection.length
              ? 'Tick at least one topic to report on'
              : 'Add at least one recipient to email the report'),
        onClick: onGenerate,
      }, 'Generate report'));
    else if (step === 'generating') footer = h('footer', { className: 'fs-srm__footer' },
      btn('Cancel', props.onClose));
    else if (step === 'done') footer = h('footer', { className: 'fs-srm__footer' },
      btn('Done', props.onClose, 'primary'));
    else footer = h('footer', { className: 'fs-srm__footer' },
      btn('Back', function () { setStep('review'); }), btn('Close', props.onClose));

    return h(ModalOverlay, {
      open: !!props.open, onClose: props.onClose, closeOnBackdrop: false,
      size: 'lg', title: props.scope === 'day' ? 'Day report' : 'Session report',
    }, h('div', { className: 'fs-srm' }, body, footer));
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.SessionReportModal = SessionReportModal;

  // Pure-helper export for node --test (browser ignores this).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildGeneratePayload: buildGeneratePayload, interpretReportStatus: interpretReportStatus, previewFieldDefaults: previewFieldDefaults, parseAttendees: parseAttendees, canGenerate: canGenerate, STEPS: STEPS,
      parseTimeRange: parseTimeRange, parseClock: parseClock, overlapsWindow: overlapsWindow, windowChecked: windowChecked, selectedRowIds: selectedRowIds,
      previewErrorMessage: previewErrorMessage, generateErrorMessage: generateErrorMessage, noFolderMappingMessage: noFolderMappingMessage };
  }
})();
