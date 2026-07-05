/* ==========================================================================
   FieldSight API · Org — Phase 3 write backend (fieldsight-test-org-api)
   --------------------------------------------------------------------------
   Backend-shaped module for the org routes on the TEST gateway (Aurora is
   the only org database; report reads stay on the prod baseUrl):

     GET   /org/me                     → { me, site_ids }
     PATCH /org/me                     → { me }                (first/last name)
     GET   /org/sites                  → { sites }             (org site: id uuid)
     POST  /org/sites                  → { site }              (admin/gm)
     GET   /org/members                → { members }           (admin/gm)
     POST  /org/members                → { member }            (admin/gm)
     PATCH /org/members/{sub}/role     → { member }            (admin/gm)
     POST  /org/upload-url             → { upload_url, key }
     GET   /org/asset-url?key=...      → { url }
     POST  /org/seed                   → backfill summary      (bootstrap/admin)

   Gate: isLive() — BOTH FS.api.orgBaseUrl set AND FS.api.orgWrites true.
   When not live, callers (scripts/api/sites.js adapters, settings page)
   keep their existing mock behaviour; this module never mocks.

   NOTE: uploads PUT straight to S3 with the presigned URL — the data
   bucket's CORS must allow the app origin (pipeline scripts/wire-bucket-cors.sh).
   ========================================================================== */

(function () {
  'use strict';

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};

  function isLive() {
    return !!window.FS.api.orgBaseUrl && window.FS.api.orgWrites === true;
  }

  function req(path, opts) {
    opts = opts || {};
    opts.base = window.FS.api.orgBaseUrl;
    return window.FS.api.request('/org' + path, opts);
  }

  /* Throw on the envelope errors _fetch.js returns for 4xx so callers can
     use one catch path for both transport and permission failures. */
  function must(promise) {
    return promise.then(function (res) {
      if (res && res._accessDenied) { var e1 = new Error(res.error || 'Access denied'); e1.status = res.status; throw e1; }
      if (res && res._notFound)     { var e2 = new Error('Not found');                  e2.status = res.status; throw e2; }
      return res;
    });
  }

  function getMe()        { return must(req('/me')); }
  function patchMe(patch) { return must(req('/me', { method: 'PATCH', body: patch })); }

  function listSites()      { return must(req('/sites')); }
  function createSite(body) { return must(req('/sites', { method: 'POST', body: body })); }

  function listMembers()      { return must(req('/members')); }
  function createMember(body) { return must(req('/members', { method: 'POST', body: body })); }
  function setMemberRole(sub, role) {
    return must(req('/members/' + encodeURIComponent(sub) + '/role',
                    { method: 'PATCH', body: { role: role } }));
  }

  function getAssetUrl(key) { return must(req('/asset-url', { params: { key: key } })); }

  /* Two-step image upload: presigned PUT into org-assets/ (the backend
     persists the DB pointer at issuance — a failed PUT just leaves the
     old/absent image until retried). kind: 'avatar' | 'site_icon'. */
  async function uploadImage(kind, file, siteId) {
    var res = await must(req('/upload-url', {
      method: 'POST',
      body: { kind: kind, content_type: file.type, site_id: siteId || undefined },
    }));
    var up = await fetch(res.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!up.ok) {
      var err = new Error('Image upload failed (HTTP ' + up.status + ')');
      err.status = up.status;
      throw err;
    }
    return res.key;
  }

  function uploadAvatar(file)           { return uploadImage('avatar', file); }
  function uploadSiteIcon(siteId, file) { return uploadImage('site_icon', file, siteId); }

  function seed(body) { return must(req('/seed', { method: 'POST', body: body || {} })); }

  window.FS.api.org = {
    isLive:         isLive,
    getMe:          getMe,
    patchMe:        patchMe,
    listSites:      listSites,
    createSite:     createSite,
    listMembers:    listMembers,
    createMember:   createMember,
    setMemberRole:  setMemberRole,
    getAssetUrl:    getAssetUrl,
    uploadAvatar:   uploadAvatar,
    uploadSiteIcon: uploadSiteIcon,
    seed:           seed,
  };

})();
