/* ==========================================================================
   FieldSight API · Sites & Users — BACKEND-CONTEXT §4.2
   --------------------------------------------------------------------------
   GET /api/sites                       → { sites, role, display_name }
   GET /api/site-users?site=<site_id>   → { users, site }
   GET /api/users                       → { users }
   ========================================================================== */

(function () {
  'use strict';

  function fixtures() {
    return (window.FieldSight && window.FieldSight.fixtures) || {};
  }

  async function getSites() {
    if (!window.FS.api.useMocks) return window.FS.api.request('/sites');
    await window.FS.api.delay();
    var f  = fixtures().sites || { sites: [], users: [] };
    var u  = (window.AuthMock && window.AuthMock.currentUser) || {};
    return {
      sites:        f.sites.slice(),   /* copy — keep state independent of the fixture so optimistic adds don't double up */
      role:         u.role || 'site_manager',
      display_name: u.name || 'Jarley Trainor',
    };
  }

  async function getSiteUsers(site) {
    /* Phase 2 (Aurora read consolidation): the org backend knows Aurora-only
       sites that legacy /site-users (user_mapping-based) does not — that gap
       was the "USERS ON SITE empty" bug. When org is live, read members from
       Aurora; only fall back to legacy on an ACL divergence AND when the D5
       legacyReadFallback flag is still on (so the legacy read path can be
       retired by flipping the flag). Task 4 adds legacyReadFallback; until
       then the `&&` short-circuits on undefined -> no fallback, fail-closed
       to Aurora. */
    if (!window.FS.api.useMocks && window.FS.api.orgBaseUrl && window.FS.api.org) {
      var res = await window.FS.api.org.getSiteMembers(site);
      if (res && res._accessDenied && window.FS.api.legacyReadFallback) {
        return window.FS.api.request('/site-users', { params: { site: site } });
      }
      return res;
    }
    if (!window.FS.api.useMocks) return window.FS.api.request('/site-users', { params: { site: site } });
    await window.FS.api.delay();
    var f = fixtures().sites || { users: [] };
    var users = f.users.filter(function (u) {
      return (u.sites || []).indexOf(site) !== -1;
    });
    return { users: users, site: site };
  }

  async function getUsers() {
    if (!window.FS.api.useMocks) return window.FS.api.request('/users');
    await window.FS.api.delay();
    var f = fixtures().sites || { users: [] };
    return { users: f.users.slice() };   /* copy — see getSites note */
  }

  function slugify(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  }

  /* Mock create/update mutations (Phase B). In mock mode they mutate the
     in-memory fixtures (session-scoped — reset on reload) and return the new
     object; live mode POST/PATCHes the real API. */
  async function createSite(input) {
    var site = {
      site_id:            (slugify(input.name) || 'site') + '-' + Date.now().toString(36),
      name:               input.name,
      location:           input.location || '',
      region:             input.region || 'south-island',
      client:             input.client || '',
      project_value_nzd:  Number(input.project_value_nzd) || 0,
      planned_completion: input.planned_completion || '',
      icon:               input.icon || null,
      user_count:         0,
    };
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) return window.FS.api.request('/sites', { method: 'POST', body: site });
    await window.FS.api.delay(400);
    var f = fixtures().sites; if (f && f.sites) f.sites.unshift(site);
    return site;
  }

  async function createUser(input) {
    var user = {
      device_id:    'user_' + Date.now().toString(36),
      name:         input.name,
      email:        input.email || '',
      folder_name:  (input.name || '').replace(/\s+/g, '_'),
      role:         input.role || 'worker',
      primary_site: input.primary_site || '',
      sites:        input.primary_site ? [input.primary_site] : [],
      managed_sites: [],
      avatarUrl:    input.avatarUrl || null,
    };
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) return window.FS.api.request('/users', { method: 'POST', body: user });
    await window.FS.api.delay(400);
    var f = fixtures().sites; if (f && f.users) f.users.unshift(user);
    return user;
  }

  async function updateUserRole(deviceId, role) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) return window.FS.api.request('/users/' + deviceId, { method: 'PATCH', body: { role: role } });
    await window.FS.api.delay(300);
    var f = fixtures().sites;
    if (f && f.users) {
      var u = f.users.filter(function (x) { return x.device_id === deviceId; })[0];
      if (u) u.role = role;
      return u || null;
    }
    return null;
  }

  window.FS.api.sites = {
    getSites:       getSites,
    getSiteUsers:   getSiteUsers,
    getUsers:       getUsers,
    createSite:     createSite,
    createUser:     createUser,
    updateUserRole: updateUserRole,
  };

})();
