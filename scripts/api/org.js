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

  /* Page-shape adapters (batch 2b fan-out): map org API member/site payloads
     to the field names Sites/Team page render code expects (device_id,
     folder_name, site_id, icon, ...). PURE + idempotent-safe: running on an
     already page-shaped mock object (fixture users/sites already carry
     device_id/site_id/name/folder_name) must not blank those fields out —
     fall back to the existing value whenever the source-shaped field is
     absent. */
  function _toPageMember(m) {
    m = m || {};
    var nameFromParts = [m.first_name, m.last_name].filter(Boolean).join(' ');
    var membershipSites = (m.memberships || []).map(function (x) { return x.site_id; });
    var membershipPrimary = ((m.memberships || [])[0] || {}).site_id;
    return Object.assign({}, m, {
      device_id: m.cognito_sub || m.device_id,
      name: nameFromParts || m.name || m.email || '',
      role: m.global_role || m.role,
      folder_name: folderName(m),
      sites: membershipSites.length ? membershipSites : (m.sites || []),
      primary_site: membershipPrimary || m.primary_site || '',
      avatarUrl: m.avatar_s3_key || m.avatarUrl || null,
      archived: !!(m.archived_at || m.archived),
    });
  }

  function _toPageSite(s) {
    s = s || {};
    return Object.assign({}, s, {
      site_id: s.id || s.site_id,
      region: s.region || '',
      icon: s.icon_s3_key || s.icon || null,
      user_count: s.user_count || 0,
      archived: !!(s.archived_at || s.archived),
    });
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
    var res;
    if (orgLive()) {
      res = await api.orgRequest('/sites', opts.includeArchived ? { params: { include_archived: '1' } } : undefined);
    } else {
      await api.delay();
      res = { sites: (fx().sites || []).slice() };
    }
    if (res && (res._accessDenied || res._notFound)) return res;
    return { sites: (res.sites || []).map(_toPageSite) };
  }

  /* Photon geocode/autocomplete — free, keyless, called DIRECTLY from the
     browser (NOT through the in-VPC org API, which cannot make outbound calls,
     BUG-36). Returns up to 5 {formatted, lat, lng}; [] on any error/no result
     so the caller degrades to a plain free-text address (coords left null ->
     backfill later). geometry.coordinates is [lng, lat]. */
  async function geocodeAddress(query) {
    if (!query || !query.trim()) return [];
    var url = 'https://photon.komoot.io/api?q=' + encodeURIComponent(query)
      + '&limit=5&lang=en';
    try {
      var resp = await fetch(url);
      if (!resp.ok) return [];
      var data = await resp.json();
      return ((data && data.features) || []).map(function (f) {
        var c = (f.geometry && f.geometry.coordinates) || [];
        var p = f.properties || {};
        var line = [];
        if (p.housenumber && p.street) line.push(p.housenumber + ' ' + p.street);
        else if (p.street) line.push(p.street);
        else if (p.name) line.push(p.name);
        ['city', 'postcode', 'state', 'country'].forEach(function (k) {
          if (p[k]) line.push(p[k]);
        });
        return { formatted: line.join(', '), lat: c[1], lng: c[0] };
      }).filter(function (x) { return x.lat != null && x.lng != null; });
    } catch (e) {
      return [];
    }
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
    if (res && (res._accessDenied || res._notFound)) return res;
    (res.members || []).forEach(function (m) { m.folder_name = folderName(m); });
    return { members: (res.members || []).map(_toPageMember) };
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

  async function setMemberFolder(sub, folder) {
    if (orgWrite()) return api.orgRequest('/members/' + encodeURIComponent(sub) + '/folder', { method: 'PATCH', body: { folder_name: folder } });
    await api.delay();
    return { cognito_sub: sub, folder_name: folder };
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

  var _ALLOWED_IMAGE_TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1 };

  async function uploadImage(kind, file) {
    if (!file || !file.type || !_ALLOWED_IMAGE_TYPES[file.type]) {
      throw new Error('Unsupported image type — use JPEG, PNG or WebP');
    }
    var res = await uploadUrl(kind, file.type);
    if (!res || !res.url) return null;   // mock / writes-off: caller falls back to local preview
    // Plain fetch, NOT rawRequest/request — rawRequest would JSON.stringify the
    // Blob, force Content-Type application/json, and inject an Authorization
    // header; each of those breaks the S3 presigned signature.
    var resp = await fetch(res.url, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!resp.ok) throw new Error('Upload failed (' + resp.status + ')');
    return res.key;   // pending key — persisted via PATCH /me avatar_s3_key or site create/patch icon_s3_key
  }

  var _assetUrlCache = {};

  async function resolveAssetUrl(key) {
    if (!key) return null;
    if (/^(data:|https?:)/.test(key)) return key;   // mock data-URIs & already-resolved URLs pass through
    if (!/^org-assets\//.test(key)) return null;
    var cached = _assetUrlCache[key];
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    var res;
    try { res = await assetUrl(key); } catch (e) { return null; }
    if (res && res.url) {
      _assetUrlCache[key] = { url: res.url, expiresAt: Date.now() + 12 * 60 * 1000 };   // presign lives 15min; 12min cache leaves margin
      return res.url;
    }
    return null;
  }

  // -------- observations (safety/quality) --------
  var _mockObservations = [];

  async function createObservation(body) {
    if (orgWrite()) return api.orgRequest('/observations', { method: 'POST', body: body });
    await api.delay(300);
    var row = Object.assign({
      id: 'mock-obs-' + Date.now().toString(36),
      status: 'open',
      archived_at: null,
      created_at: new Date().toISOString(),
      author_name: 'You',
      author_sub: 'mock-sub',
      report_date: (new Date()).toISOString().slice(0, 10),
    }, body);
    _mockObservations.unshift(row);
    return row;
  }

  async function getObservations(opts) {
    opts = opts || {};
    if (orgLive()) {
      return api.orgRequest('/observations', { params: {
        kind: opts.kind, from: opts.from, to: opts.to, site_slug: opts.site_slug,
        include_archived: opts.includeArchived ? '1' : undefined,
      } });
    }
    await api.delay();
    var rows = _mockObservations.filter(function (o) {
      if (opts.kind && o.kind !== opts.kind) return false;
      if (opts.site_slug && o.site_slug !== opts.site_slug) return false;
      if (opts.from && o.report_date < opts.from) return false;
      if (opts.to && o.report_date > opts.to) return false;
      if (!opts.includeArchived && o.archived_at) return false;
      return true;
    });
    return { observations: rows };
  }

  // -------- live items (session-sourced extraction, feat 4b) --------
  /* GET /api/org/live-items?date=YYYY-MM-DD → { topics: [...] }. Date-scoped
     only — ACL is date-wide across accessible sites, NO site param (unlike
     getObservations' site_slug). Mirrors getObservations' live/mock split;
     mock returns an empty topics list (safe — no live rows merged in,
     matches the mocked-observations posture of "nothing until seeded"). */
  async function getLiveItems(opts) {
    opts = opts || {};
    if (orgLive()) {
      return api.orgRequest('/live-items', { params: { date: opts.date } });
    }
    await api.delay();
    return { topics: [] };
  }

  // -------- site members (Phase 2 — Aurora replaces legacy /site-users) --------
  /* GET /api/org/sites/{id}/members → { members:[...] } (from Aurora
     memberships, company+site ACL). Mapped to the page member shape via
     _toPageMember so getSiteUsers consumers get folder_name/name/role.
     Mock returns no members (matches getLiveItems' seed-first posture).

     Deviation from _toPageMember's default role mapping: members_for_site
     rows carry BOTH the member's company-wide global_role AND this site's
     membership role as site_role (repo: "u.global_role, m.role AS
     site_role"). _toPageMember's shared `role: m.global_role || m.role`
     picks global_role first, which is right for getMembers() (a multi-site
     roster) but wrong here — the USERS ON SITE panel and its consumers
     (sites.js line ~738 renders `[u.role, u.device_id]`) want the role the
     member holds ON THIS SITE, not their company-wide role. Override role
     with site_role post-map when present. */
  async function getSiteMembers(siteId) {
    if (orgLive()) {
      var res = await api.orgRequest('/sites/' + encodeURIComponent(siteId) + '/members');
      if (res && (res._accessDenied || res._notFound)) return res;
      var users = (res.members || []).map(function (m) {
        var page = _toPageMember(m);
        if (m.site_role) page.role = m.site_role;
        return page;
      });
      return { users: users, site: siteId };
    }
    await api.delay();
    return { users: [], site: siteId };
  }

  // -------- strategic rollup (feat 4c) --------
  /* GET /api/org/rollup/portfolio → { sites: [{ site_id (ORG UUID),
     open_safety, open_high_safety, open_actions, total_actions,
     overdue_actions, topics_count, participants, last_activity_at,
     status }] }. Safety/actions counts are all-time, topics_count/
     participants a 30-day window, last_activity_at the ALL-TIME
     MAX(topics.report_date) as an ISO YYYY-MM-DD string (null until the
     site has any topic). Sites cards read open_actions + last_activity_at
     for their Open / Last activity KPIs. ACL: admin/gm see all company
     sites, everyone else sees their memberships (platform_admin gets
     cross-company reach via _allowed_site_ids server-side). Mock mirrors
     getLiveItems' "nothing until seeded" posture — empty sites list, no
     fabricated rollup rows (pure ?mocks=1 preview renders Open 0 / '—';
     dev Amplify uses LIVE reads so it shows real values). */
  async function getPortfolioRollup() {
    if (orgLive()) return api.orgRequest('/rollup/portfolio');
    await api.delay();
    return { sites: [] };
  }

  async function updateObservation(id, patch) {
    if (orgWrite()) return api.orgRequest('/observations/' + encodeURIComponent(id), { method: 'PATCH', body: patch });
    await api.delay();
    var row = _mockObservations.filter(function (o) { return o.id === id; })[0];
    if (!row) return null;
    Object.assign(row, patch);
    return Object.assign({}, row);
  }

  async function archiveObservation(id) {
    if (orgWrite()) return api.orgRequest('/observations/' + encodeURIComponent(id) + '/archive', { method: 'POST' });
    await api.delay();
    var row = _mockObservations.filter(function (o) { return o.id === id; })[0];
    if (!row) return null;
    row.archived_at = new Date().toISOString();
    return Object.assign({}, row);
  }

  window.FS.api.org = {
    getMe: getMe,
    updateProfile: updateProfile,
    getOrgSites: getOrgSites, createOrgSite: createOrgSite, updateOrgSite: updateOrgSite, geocodeAddress: geocodeAddress,
    archiveSite: archiveSite, unarchiveSite: unarchiveSite,
    getMembers: getMembers, createMember: createMember, updateMemberRole: updateMemberRole,
    setMemberFolder: setMemberFolder,
    archiveMember: archiveMember, unarchiveMember: unarchiveMember,
    uploadUrl: uploadUrl, assetUrl: assetUrl,
    uploadImage: uploadImage, resolveAssetUrl: resolveAssetUrl,
    createObservation: createObservation, getObservations: getObservations,
    updateObservation: updateObservation, archiveObservation: archiveObservation,
    getLiveItems: getLiveItems,
    getSiteMembers: getSiteMembers,
    getPortfolioRollup: getPortfolioRollup,
    _folderName: folderName,   /* exported for batch-2b fan-out reuse */
    _toPageMember: _toPageMember, _toPageSite: _toPageSite,   /* page-shape adapters, batch-2b */
  };
})();
