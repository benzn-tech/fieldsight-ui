/* ==========================================================================
   api/org.js — org backend data layer (Phase 3 batch 2).
   --------------------------------------------------------------------------
   Second base URL (FS.api.orgBaseUrl) for the org API: sites/members/roles/
   profile/images live in Aurora, reached via FS.api.orgRequest. Must load
   AFTER api/index.js and _fetch.js (which define orgBaseUrl + orgRequest).

   Gating (spec §5.2 / §8b):
     org LIVE  = !useMocks && orgBaseUrl non-empty  (empty = kill switch)
     org WRITE = org LIVE && orgWrites              (does NOT touch writeMocks)
   Mocked fallbacks keep the no-backend prototype working.
   ========================================================================== */
(function () {
  'use strict';
  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};

  var api = window.FS.api;

  function orgLive()  { return !api.useMocks && !!api.orgBaseUrl; }
  function orgWrite() { return orgLive() && !!api.orgWrites; }
  function fx()       { return (window.FieldSight && window.FieldSight.fixtures
                                && window.FieldSight.fixtures.sites) || {}; }

  /* folder_name bridges org identity → report-data folders (report S3 paths
     use display name with spaces→underscores, e.g. "Jarley_Trainor"). */
  function folderName(m) {
    if (m.folder_name) return m.folder_name;
    var fromParts = [m.first_name, m.last_name].filter(Boolean).join('_');
    if (fromParts) return fromParts;
    return m.name ? m.name.replace(/ /g, '_') : '';
  }

  // -------- profile --------
  async function getMe() {
    if (orgLive()) return api.orgRequest('/me');
    await api.delay();
    var u = (window.AuthMock && window.AuthMock.currentUser) || {};
    var parts = (u.name || 'Jarley Trainor').split(' ');
    return {
      cognito_sub: 'mock-sub', email: u.email || 'mock@example.com',
      global_role: u.role || 'site_manager',
      first_name: parts[0] || '', last_name: parts.slice(1).join(' '),
      site_ids: [], scope: 'MEMBERSHIPS', archived_at: null,
    };
  }

  // -------- sites --------
  async function getOrgSites(opts) {
    opts = opts || {};
    if (orgLive()) {
      return api.orgRequest('/sites', opts.includeArchived ? { params: { include_archived: '1' } } : undefined);
    }
    await api.delay();
    return { sites: (fx().sites || []).slice() };
  }

  async function createOrgSite(body) {
    if (orgWrite()) return api.orgRequest('/sites', { method: 'POST', body: body });
    await api.delay(400);
    var site = { id: 'mock-' + Date.now().toString(36), name: body.name,
                 location: body.location || '', client: body.client || '',
                 icon_s3_key: body.icon_s3_key || null, archived_at: null };
    var f = fx(); if (f.sites) f.sites.unshift(site);
    return site;
  }

  async function updateOrgSite(id, patch) {
    if (orgWrite()) return api.orgRequest('/sites/' + encodeURIComponent(id), { method: 'PATCH', body: patch });
    await api.delay();
    return Object.assign({ id: id }, patch);
  }

  async function updateProfile(patch) {
    if (orgWrite()) return api.orgRequest('/me', { method: 'PATCH', body: patch });
    await api.delay();
    return Object.assign({}, patch);
  }

  async function archiveSite(id)   { return _siteArchive(id, 'archive'); }
  async function unarchiveSite(id) { return _siteArchive(id, 'unarchive'); }
  async function _siteArchive(id, action) {
    if (orgWrite()) return api.orgRequest('/sites/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
    await api.delay();
    return { id: id, archived_at: action === 'archive' ? new Date().toISOString() : null };
  }

  // -------- members --------
  async function getMembers(opts) {
    opts = opts || {};
    var res;
    if (orgLive()) {
      res = await api.orgRequest('/members', opts.includeArchived ? { params: { include_archived: '1' } } : undefined);
    } else {
      await api.delay();
      res = { members: (fx().users || []).slice() };
    }
    (res.members || []).forEach(function (m) { m.folder_name = folderName(m); });
    return res;
  }

  async function createMember(body) {
    if (orgWrite()) return api.orgRequest('/members', { method: 'POST', body: body });
    await api.delay(400);
    return { user: { cognito_sub: 'mock-' + Date.now().toString(36), email: body.email,
                     global_role: body.global_role || 'worker' }, memberships: body.memberships || [] };
  }

  async function updateMemberRole(sub, role) {
    if (orgWrite()) return api.orgRequest('/members/' + encodeURIComponent(sub) + '/role', { method: 'PATCH', body: { global_role: role } });
    await api.delay();
    return { cognito_sub: sub, global_role: role };
  }

  async function archiveMember(sub)   { return _memberArchive(sub, 'archive'); }
  async function unarchiveMember(sub) { return _memberArchive(sub, 'unarchive'); }
  async function _memberArchive(sub, action) {
    if (orgWrite()) return api.orgRequest('/members/' + encodeURIComponent(sub) + '/' + action, { method: 'POST' });
    await api.delay();
    return { cognito_sub: sub, archived_at: action === 'archive' ? new Date().toISOString() : null };
  }

  // -------- assets (presign) --------
  async function uploadUrl(kind, contentType) {
    if (orgWrite()) return api.orgRequest('/upload-url', { method: 'POST', body: { kind: kind, content_type: contentType } });
    await api.delay();
    return { url: null, key: null };   // mock: caller falls back to data-URI preview
  }

  async function assetUrl(key) {
    if (orgLive()) return api.orgRequest('/asset-url', { params: { key: key } });
    await api.delay();
    return { url: null };
  }

  window.FS.api.org = {
    getMe: getMe,
    updateProfile: updateProfile,
    getOrgSites: getOrgSites, createOrgSite: createOrgSite, updateOrgSite: updateOrgSite,
    archiveSite: archiveSite, unarchiveSite: unarchiveSite,
    getMembers: getMembers, createMember: createMember, updateMemberRole: updateMemberRole,
    archiveMember: archiveMember, unarchiveMember: unarchiveMember,
    uploadUrl: uploadUrl, assetUrl: assetUrl,
    _folderName: folderName,   /* exported for batch-2b fan-out reuse */
  };
})();
