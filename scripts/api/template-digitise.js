/* ==========================================================================
   FieldSight · api/template-digitise.js
   --------------------------------------------------------------------------
   Reads a checklist form (a Word file, a PDF, or photos of its pages) into a
   DRAFT template: upload -> request -> poll. The person checks the draft on
   the review screen and saves it through the ordinary POST /templates; nothing
   is a template before Save. Pipeline spec:
   docs/superpowers/specs/2026-10-16-template-digitise-design.md

   "Off" is a VALUE here, never a catch: the routes answer 404 when reading is
   switched off on the server, and orgRequest returns { _notFound: true } for a
   404 instead of throwing.

   Exported to: window.FS.api.templateDigitise
   ========================================================================== */

(function () {
  'use strict';

  var EXT_TYPES = {
    pdf:  'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    png:  'image/png',
  };
  var IMAGE_EXTS = ['jpg', 'jpeg', 'png'];
  var MAX_BYTES  = 20 * 1024 * 1024;
  var MAX_IMAGES = 10;
  var POLL_MS    = 3000;
  var GIVE_UP_MS = 3 * 60 * 1000;
  /* The server's own limits (report_template.py / checklist.py). Checked here as
     well, not instead: a Save that bounces after a round trip makes the person
     hunt for which of nineteen sections it meant. */
  var LIMITS = { sections: 40, title: 120, items: 120, item: 300, body: 60000 };
  var PURPOSE = "Record the inspector's answer to each item from the recording.";
  var BANNER = 'Check the wording against your form — the reader can correct a spelling without saying so.';
  var FLAG_TEXT = {
    near_duplicate_section: 'Two sections with nearly the same name — one form split across a page?',
    split_section:          'Same heading as the section next to it — probably one table split by a page break. Merge them?',
    label_kept:             'Still starts with a list number or letter — check the wording.',
    truncated:              'Cut to fit the limit — check nothing that matters was lost.',
    split_for_limit:        'Split in two: one checklist holds at most 120 items.',
    too_many_sections:      'More than 40 sections — merge some before saving.',
    too_long:               'This form is longer than one template can hold — remove or merge sections before saving.',
  };

  function api() { return window.FS.api; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  /* From the extension, never file.type: some browsers hand a Word file over with
     an empty type, and the server signs the PUT for exactly the type named here. A
     mismatch is a 403 from S3 that reads like a permissions bug. */
  function typeFor(file) { return EXT_TYPES[extOf(file && file.name)] || ''; }

  function checkFiles(files) {
    files = files || [];
    if (!files.length) return 'Choose a file.';
    var exts = files.map(function (f) { return extOf(f.name); });
    for (var i = 0; i < files.length; i++) {
      if (!EXT_TYPES[exts[i]]) return 'Use a PDF, a Word file (.docx), or photos (.jpg, .png).';
      if (files[i].size > MAX_BYTES) return files[i].name + ' is larger than 20 MB.';
    }
    var images = exts.filter(function (e) { return IMAGE_EXTS.indexOf(e) >= 0; }).length;
    if (images && images !== files.length) return 'Upload one Word file, one PDF, or up to 10 photos — not a mix.';
    if (!images && files.length > 1) return 'Upload one Word file or one PDF at a time.';
    if (images > MAX_IMAGES) return 'Up to 10 photos — one per page.';
    return null;
  }

  function refused(res) {
    if (res && res._accessDenied) throw new Error(res.error || 'Access denied.');
    return res;
  }

  /* orgRequest folds THREE things into _notFound: the route-level 404 the server
     sends when reading is switched off (`error("not found", 404)` in
     lambda_org_api), a 404 that explains itself ("an uploaded file was not found
     -- upload it again"), and any answer that is not JSON (a gateway error page,
     the CloudFront SPA shell). Only the first means reading is off. The second is
     the server telling the person something and is shown to them; the third is a
     failure and must say so, or a passing 502 would quietly create a template
     from starting sections. */
  var OFF_ERROR = 'not found';

  function serverMessage(res) {
    var raw = res && res.raw;
    return raw && typeof raw.error === 'string' ? raw.error.trim() : '';
  }

  function sentence(s) {
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return /[.!?]$/.test(s) ? s : s + '.';
  }

  function isOff(res) {
    if (!res || !res._notFound) return false;
    var msg = serverMessage(res);
    if (res.status === 404 && msg === OFF_ERROR) return true;
    if (res.status === 404 && msg) throw new Error(sentence(msg));
    throw new Error('The server gave an unexpected answer (' + (res.status || 'no status') + ') — try again.');
  }

  /* A poll that got no usable answer: a 5xx (orgRequest throws those) or a body
     that is not JSON. One of these mid-read is a blip, not the end of the read --
     the draft is still being written on the server -- so it counts as a missed
     poll and polling carries on until GIVE_UP_MS. */
  function isMissedPoll(res) {
    return !!(res && res._notFound && !(res.status === 404 && serverMessage(res)));
  }

  async function requestUploadUrl(file) {
    var res = await api().orgRequest('/templates/digitise/upload-url', {
      method: 'POST', retry: false,
      body: { filename: file.name, contentType: typeFor(file), size: file.size },
    });
    if (isOff(res)) return { off: true };
    return refused(res);
  }

  async function putFile(file, url, fetchImpl) {
    var resp = await (fetchImpl || fetch)(url, {
      method: 'PUT', headers: { 'Content-Type': typeFor(file) }, body: file,
    });
    if (!resp.ok) throw new Error('Upload of ' + file.name + ' failed (' + resp.status + ') — try again.');
  }

  async function startRead(sourceKeys, name) {
    var res = await api().orgRequest('/templates/digitise', {
      method: 'POST', retry: false, body: { sourceKeys: sourceKeys, name: name },
    });
    if (isOff(res)) return { off: true };
    return refused(res);
  }

  async function waitForDraft(id, opts) {
    var now = opts.now || Date.now;
    var wait = opts.sleep || sleep;
    var cancelled = opts.cancelled || function () { return false; };
    var started = now();
    for (;;) {
      if (cancelled()) return { cancelled: true };
      var res;
      try {
        res = await api().orgRequest('/templates/digitise/' + encodeURIComponent(id));
      } catch (e) {
        if (!(e && e.status >= 500)) throw e;
        res = null;
      }
      if (cancelled()) return { cancelled: true };
      if (res && !isMissedPoll(res)) {
        refused(res);
        if (isOff(res)) throw new Error('This draft is no longer available — upload the form again.');
        if (res.status && res.status !== 'pending') return res;
      }
      if (now() - started >= GIVE_UP_MS) throw new Error('Taking too long — try again.');
      await wait(POLL_MS);
    }
  }

  /* Upload each file, ask for the read, wait for the draft. Resolves { off: true }
     when the server does not offer reading (the caller then does today's thing),
     otherwise the poll result. onPhase('reading') fires only once the server has
     ACCEPTED the read -- the screen never says it is reading a form it did not get.

     opts.cancelled() is asked before every request: once the person has closed the
     modal, no further page is uploaded, the (billed) read is never requested, and
     polling stops. Resolves { cancelled: true } then. */
  async function digitise(files, name, opts) {
    opts = opts || {};
    var onPhase = opts.onPhase || function () {};
    var cancelled = opts.cancelled || function () { return false; };
    var problem = checkFiles(files);
    if (problem) throw new Error(problem);
    onPhase('uploading');
    var keys = [];
    for (var i = 0; i < files.length; i++) {
      if (cancelled()) return { cancelled: true };
      var u = await requestUploadUrl(files[i]);
      if (u.off) return { off: true };
      if (cancelled()) return { cancelled: true };
      await putFile(files[i], u.uploadUrl, opts.fetch);
      keys.push(u.sourceKey);
    }
    if (cancelled()) return { cancelled: true };
    var started = await startRead(keys, name);
    if (started.off) return { off: true };
    if (cancelled()) return { cancelled: true };
    onPhase('reading');
    return waitForDraft(started.id, opts);
  }

  function fromResult(result) {
    return { name: result.name || '', sections: clone(result.sections || []),
             flags: (result.flags || []).slice() };
  }

  function itemText(it) { return typeof it === 'string' ? it : ((it && it.text) || ''); }

  function slug(title, i) {
    var k = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return (k || 'section') + '-' + (i + 1);
  }

  /* The draft's {text, flags} items become the PLAIN STRINGS checklist.validate_items
     accepts; flags never leave the browser. */
  function toTemplateBody(draft) {
    var sections = (draft.sections || []).map(function (s) {
      return {
        title: String(s.title || '').trim(),
        items: (s.items || []).map(itemText)
          .map(function (t) { return t.replace(/\s+/g, ' ').trim(); })
          .filter(Boolean),
      };
    }).filter(function (s) { return s.items.length; });
    return {
      sections: sections.map(function (s, i) {
        return { key: slug(s.title, i), title: s.title, kind: 'checklist', purpose: PURPOSE, items: s.items };
      }),
      catch_all: api().templates.DEFAULT_CATCH_ALL,
      excluded_subjects: [],
      style: [],
    };
  }

  /* The length the server measures: Python's json.dumps(body, ensure_ascii=False),
     whose default separators are ', ' and ': '. JSON.stringify writes neither
     space, so its length alone passes bodies the server refuses. */
  function storedLength(v) {
    if (Array.isArray(v)) {
      return 2 + v.reduce(function (n, x, i) { return n + storedLength(x) + (i ? 2 : 0); }, 0);
    }
    if (v && typeof v === 'object') {
      return 2 + Object.keys(v).reduce(function (n, k, i) {
        return n + JSON.stringify(k).length + 2 + storedLength(v[k]) + (i ? 2 : 0);
      }, 0);
    }
    return JSON.stringify(v).length;
  }

  function bodyProblem(body) {
    var secs = body.sections || [];
    if (!secs.length) return 'The template needs at least one section with an item.';
    if (secs.length > LIMITS.sections) return 'A template holds at most 40 sections — merge some first.';
    for (var i = 0; i < secs.length; i++) {
      var s = secs[i]; var where = 'Section ' + (i + 1);
      if (!s.title) return where + ' needs a name.';
      if (s.title.length > LIMITS.title) return where + ': the name is longer than 120 characters.';
      if (s.items.length > LIMITS.items) return where + ' has more than 120 items — split it.';
      for (var j = 0; j < s.items.length; j++) {
        if (s.items[j].length > LIMITS.item) return where + ', item ' + (j + 1) + ' is longer than 300 characters.';
      }
    }
    if (storedLength(body) > LIMITS.body) return 'This form is longer than a template can hold — remove or merge sections.';
    return null;
  }

  function move(arr, i, delta) {
    var j = i + delta;
    if (j < 0 || j >= arr.length) return;
    var x = arr[i]; arr[i] = arr[j]; arr[j] = x;
  }

  /* Each edit returns a NEW draft: the review screen is controlled by the modal, which
     keeps the draft across a Save the server refuses. Touching a section or item
     clears its flags -- the person has looked at it. */
  var ops = {
    renameSection: function (d, i, title) { d = clone(d); d.sections[i].title = title; d.sections[i].flags = []; return d; },
    editItem:      function (d, i, j, text) { d = clone(d); d.sections[i].items[j] = { text: text, flags: [] }; return d; },
    deleteItem:    function (d, i, j) { d = clone(d); d.sections[i].items.splice(j, 1); return d; },
    addItem:       function (d, i) { d = clone(d); d.sections[i].items.push({ text: '', flags: [] }); return d; },
    moveItem:      function (d, i, j, delta) { d = clone(d); move(d.sections[i].items, j, delta); return d; },
    moveSection:   function (d, i, delta) { d = clone(d); move(d.sections, i, delta); return d; },
    deleteSection: function (d, i) { d = clone(d); d.sections.splice(i, 1); return d; },
    mergeWithNext: function (d, i) {
      d = clone(d);
      if (i + 1 >= d.sections.length) return d;
      d.sections[i].items = d.sections[i].items.concat(d.sections[i + 1].items);
      d.sections[i].flags = [];
      d.sections.splice(i + 1, 1);
      return d;
    },
  };

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.templateDigitise = {
    EXT_TYPES: EXT_TYPES, PURPOSE: PURPOSE, BANNER: BANNER, FLAG_TEXT: FLAG_TEXT,
    POLL_MS: POLL_MS, GIVE_UP_MS: GIVE_UP_MS,
    typeFor: typeFor, checkFiles: checkFiles, digitise: digitise,
    fromResult: fromResult, toTemplateBody: toTemplateBody, bodyProblem: bodyProblem, ops: ops,
  };
})();
