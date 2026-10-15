/* ==========================================================================
   FieldSight · api/project-documents.js
   --------------------------------------------------------------------------
   A project's documents and specs (backend spec
   docs/superpowers/specs/2026-10-16-project-documents-design.md): list,
   upload (upload-url -> PUT -> create), new revision, rename, delete, retry,
   open the original at a page. Indexing runs on the server; the list carries
   each document's status.

   "Off" is a VALUE here, never a catch: every route answers
   404 {"error": "not found"} when the feature is switched off, and
   orgRequest returns { _notFound: true } for a 404 instead of throwing. Only
   that exact answer means off; a 404 with its own message ("project not
   found", "the uploaded file was not found — upload it again") is shown.

   The org kill switch comes first, the way api/org.js does it: with mocks on or
   orgBaseUrl empty (local preview, a stack without the org API) every call is
   "off" and nothing is requested -- orgRequest has no base to send it to and
   would otherwise land on the legacy gateway. Changes additionally need
   orgWrites (org WRITE = org LIVE && orgWrites); without it the list says
   canWrite: false and a write is refused before any request.

   Exported to: window.FS.api.projectDocuments
   ========================================================================== */

(function () {
  'use strict';

  var EXT_TYPES = {
    pdf:  'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt:  'text/plain',
    md:   'text/markdown',
  };
  var MAX_BYTES  = 50 * 1024 * 1024;
  var STUCK_MS   = 20 * 60 * 1000;     /* server: PROJECT_DOC_STUCK */
  var REFRESH_MS = 10 * 1000;          /* re-read the list while anything is indexing */
  var OFF_ERROR  = 'not found';

  function api() { return window.FS.api; }
  function orgLive()  { var a = api(); return !a.useMocks && !!a.orgBaseUrl; }
  function orgWrite() { return orgLive() && !!api().orgWrites; }
  var WRITES_OFF = 'Changes to project documents are switched off here.';
  function enc(s) { return encodeURIComponent(s); }
  function base(siteId) { return '/sites/' + enc(siteId) + '/documents'; }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  /* From the extension, never file.type: the server signs the PUT for exactly this type
     and some browsers hand a Word or Markdown file over with an empty one. */
  function typeFor(file) { return EXT_TYPES[extOf(file && file.name)] || ''; }

  function checkFile(file) {
    if (!file) return 'Choose a file.';
    if (!EXT_TYPES[extOf(file.name)]) return 'Use a Word file (.docx), a PDF, or a text file (.txt, .md).';
    if (!file.size) return 'This file is empty.';
    if (file.size > MAX_BYTES) return file.name + ' is larger than 50 MB.';
    return null;
  }

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

  function refused(res) {
    if (res && res._accessDenied) throw new Error(res.error || 'Access denied.');
    return res;
  }

  async function call(path, opts) {
    if (!orgLive()) return { off: true };
    if (opts && opts.method && opts.method !== 'GET' && !orgWrite()) throw new Error(WRITES_OFF);
    var res = await api().orgRequest(path, opts);
    if (isOff(res)) return { off: true };
    return refused(res) || {};
  }

  async function list(siteId) {
    var res = await call(base(siteId));
    if (res.off) return res;
    return { documents: res.documents || [], canWrite: !!res.canWrite && orgWrite() };
  }

  async function history(siteId, seriesId) {
    var res = await call(base(siteId) + '?series=' + enc(seriesId));
    if (res.off) return res;
    return { documents: res.documents || [] };
  }

  async function putFile(file, url, fetchImpl) {
    var resp = await (fetchImpl || fetch)(url, {
      method: 'PUT', headers: { 'Content-Type': typeFor(file) }, body: file,
    });
    if (!resp.ok) throw new Error('Upload of ' + file.name + ' failed (' + resp.status + ') — try again.');
  }

  /* Every write is retry:false -- a 504 is the gateway giving up, not a failed write,
     and a retried create would be refused as "already added" at best. */
  async function upload(siteId, file, opts) {
    opts = opts || {};
    if (!orgLive()) return { off: true };
    if (!orgWrite()) throw new Error(WRITES_OFF);
    var problem = checkFile(file);
    if (problem) throw new Error(problem);
    var u = await call(base(siteId) + '/upload-url', {
      method: 'POST', retry: false,
      body: { filename: file.name, contentType: typeFor(file), size: file.size },
    });
    if (u.off) return u;
    await putFile(file, u.uploadUrl, opts.fetch);
    var body = { sourceKey: u.sourceKey, filename: file.name, title: opts.title || file.name };
    if (opts.seriesId) body.seriesId = opts.seriesId;
    return call(base(siteId), { method: 'POST', retry: false, body: body });
  }

  function rename(siteId, docId, title) {
    return call(base(siteId) + '/' + enc(docId), { method: 'PATCH', retry: false, body: { title: title } });
  }

  function remove(siteId, docId) {
    return call(base(siteId) + '/' + enc(docId), { method: 'DELETE', retry: false });
  }

  function retry(siteId, docId) {
    return call(base(siteId) + '/' + enc(docId) + '/retry', { method: 'POST', retry: false });
  }

  function pageHref(url, contentType, page) {
    return (contentType === EXT_TYPES.pdf && page) ? url + '#page=' + page : url;
  }

  /* The tab is opened BEFORE the first await: a window.open after one is no longer in
     the click's user gesture and the popup blocker eats it. */
  async function open(siteId, docId, page, opts) {
    opts = opts || {};
    var host = opts.window || window;
    var tab = host.open('about:blank', '_blank');
    try {
      var res = await call(base(siteId) + '/' + enc(docId) + '/file');
      if (res.off) throw new Error('Project documents are not available.');
      var href = pageHref(res.url, res.contentType, page);
      if (tab) {
        try { tab.opener = null; } catch (e) { /* cross-origin already */ }
        tab.location.href = href;
      } else {
        host.open(href, '_blank', 'noopener');
      }
      return href;
    } catch (err) {
      if (tab) tab.close();
      throw err;
    }
  }

  function pageLabel(from, to) {
    if (from == null) return '';
    return (to != null && to !== from) ? 'pp. ' + from + '–' + to : 'p. ' + from;
  }

  function citeLabel(d) {
    return [d.title, d.heading, pageLabel(d.page, d.page_to)].filter(Boolean).join(' · ');
  }

  function statusOf(doc, now) {
    var s = doc && doc.status;
    if (s === 'indexed') return { label: 'Searchable', tone: 'success', canRetry: false, detail: '' };
    if (s === 'unreadable') return { label: 'Not readable', tone: 'neutral', canRetry: false, detail: doc.reason || '' };
    if (s === 'error') return { label: 'Failed', tone: 'danger', canRetry: true, detail: doc.reason || '' };
    var since = Date.parse(doc && (doc.requestedAt || doc.createdAt));
    if (!isNaN(since) && now - since > STUCK_MS) {
      return { label: 'Taking too long', tone: 'warning', canRetry: true, detail: '' };
    }
    return { label: 'Indexing…', tone: 'info', canRetry: false, detail: '' };
  }

  /* Re-read the list only while it can change on its own: something is indexing and
     is not yet past the stuck line (past it, only a Retry moves it), and the tab is
     visible (a hidden tab resumes on visibilitychange). */
  function shouldPoll(docs, now, visibility) {
    if (visibility === 'hidden') return false;
    return (docs || []).some(function (d) {
      if (!d || d.status !== 'pending') return false;
      var since = Date.parse(d.requestedAt || d.createdAt);
      return isNaN(since) || now - since <= STUCK_MS;
    });
  }

  function toPaletteItems(rows) {
    return (rows || []).map(function (r, i) {
      return {
        type: 'document',
        id: 'doc_' + i + '_' + r.document_id,
        title: r.title || 'Untitled document',
        subtitle: [r.heading, pageLabel(r.page_from, r.page_to), r.site_name].filter(Boolean).join(' · '),
        siteId: r.site_id,
        documentId: r.document_id,
        page: r.page_from || null,
      };
    });
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.projectDocuments = {
    EXT_TYPES: EXT_TYPES, MAX_BYTES: MAX_BYTES, STUCK_MS: STUCK_MS, REFRESH_MS: REFRESH_MS,
    typeFor: typeFor, checkFile: checkFile, list: list, history: history, upload: upload,
    rename: rename, remove: remove, retry: retry, open: open, pageHref: pageHref,
    pageLabel: pageLabel, citeLabel: citeLabel, statusOf: statusOf, shouldPoll: shouldPoll, toPaletteItems: toPaletteItems,
  };
})();
