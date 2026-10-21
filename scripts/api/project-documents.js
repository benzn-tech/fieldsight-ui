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

  /* Does the browser show this type in a tab, or save it? A PDF and plain text are
     shown; a Word file is saved -- and a tab opened for it stays on about:blank
     forever, because the tab committed the blank page before the file arrived.
     Unknown ('') counts as shown: that is what open() always did. text/* includes
     Markdown, which Chromium renders as text (the server sends it inline). */
  function opensInTab(contentType) {
    return !contentType || contentType === EXT_TYPES.pdf || /^text\//.test(contentType);
  }

  /* Save the file without leaving the page. The presigned URL is cross-origin, so the
     `download` attribute is ignored and this is an ordinary navigation of this tab --
     which, for a type the browser cannot show, becomes a download and the page stays.
     Only ever called for such a type (opensInTab false). */
  function saveInPlace(host, url, filename) {
    var doc = host.document;
    var a = doc.createElement('a');
    a.href = url;
    a.download = filename || '';
    a.rel = 'noopener';
    a.style.display = 'none';
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
  }

  /* opts.contentType / opts.filename: what the row or search hit already knows about
     the file, so the choice "tab or save" is made inside the click.

     A tab is opened BEFORE the first await: a window.open after one is no longer in
     the click's user gesture and the popup blocker eats it. A Word file opens no tab
     at all and is saved in place once its URL arrives. */
  async function open(siteId, docId, page, opts) {
    opts = opts || {};
    var host = opts.window || window;
    var known = opts.contentType || EXT_TYPES[extOf(opts.filename)] || '';
    if (!opensInTab(known)) {
      var got = await call(base(siteId) + '/' + enc(docId) + '/file');
      if (got.off) throw new Error('Project documents are not available.');
      /* The server disagrees and says the browser would SHOW it: navigating this tab
         would replace FieldSight with the file, so use a tab even at the risk of the
         popup blocker. */
      if (got.contentType && opensInTab(got.contentType)) {
        host.open(got.url, '_blank', 'noopener');
      } else {
        saveInPlace(host, got.url, got.filename);
      }
      return got.url;
    }
    var tab = host.open('about:blank', '_blank');
    try {
      var res = await call(base(siteId) + '/' + enc(docId) + '/file');
      if (res.off) throw new Error('Project documents are not available.');
      var href = pageHref(res.url, res.contentType, page);
      if (tab && !opensInTab(res.contentType)) {
        /* The type was not known at the click and it is one the browser saves: the
           tab would stay blank. Close it and save from here instead. */
        tab.close();
        saveInPlace(host, res.url, res.filename);
        return res.url;
      }
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
        contentType: r.content_type || '',
      };
    });
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.projectDocuments = {
    isLive: orgLive,
    EXT_TYPES: EXT_TYPES, MAX_BYTES: MAX_BYTES, STUCK_MS: STUCK_MS, REFRESH_MS: REFRESH_MS,
    typeFor: typeFor, checkFile: checkFile, list: list, history: history, upload: upload,
    rename: rename, remove: remove, retry: retry, open: open, opensInTab: opensInTab, pageHref: pageHref,
    pageLabel: pageLabel, citeLabel: citeLabel, statusOf: statusOf, shouldPoll: shouldPoll, toPaletteItems: toPaletteItems,
  };
})();
