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
    if (!window.FS.api.useMocks) return window.FS.api.request('/site-users', { params: { site: site } });
    await window.FS.api.delay();
    var f = fixtures().sites || { users: [] };
    var users = f.users.filter(function (u) {
      return (u.sites || []).indexOf(site) !== -1;
    });
    return { users: users, site: site };
  }

  async function getUsers() {
    /* Phase 3: real member roster from the org backend when live. Only
       admin/gm may list members — on 403 (e.g. a PM opening /team) fall
       through to the legacy read so their directory keeps working. */
    if (window.FS.api.org && window.FS.api.org.isLive()) {
      try {
        var results = await Promise.all([
          window.FS.api.org.listMembers(),
          orgSiteNameIndex(),
        ]);
        return { users: (results[0].members || []).map(function (m) {
          return orgMemberToLegacy(m, results[1]);
        }) };
      } catch (e) {
        if (!e || e.status !== 403) throw e;
      }
    }
    if (!window.FS.api.useMocks) return window.FS.api.request('/users');
    await window.FS.api.delay();
    var f = fixtures().sites || { users: [] };
    return { users: f.users.slice() };   /* copy — see getSites note */
  }

  function slugify(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  }

  /* ---------- Phase 3 org adapters --------------------------------------
     When FS.api.org.isLive() the write paths below go to the real org
     backend (Aurora via the test gateway). The org API speaks its own
     shapes (member: cognito_sub/global_role, site: id uuid); these
     adapters translate to the legacy shapes call sites already render. */

  function orgLive() {
    return !!(window.FS.api.org && window.FS.api.org.isLive());
  }

  /* UI role taxonomy (roles.js, 7+3) is richer than the backend's
     admin/gm > pm > site_manager > worker. Provisional lossy map until the
     backend grows the full taxonomy — the UI keeps rendering the UI role,
     only the persisted ACL role is coarser. */
  var ORG_ROLE_BY_UI_ROLE = {
    admin: 'admin', gm: 'gm', director: 'gm',
    construction_manager: 'pm', project_manager: 'pm', pm: 'pm',
    hse_manager: 'pm', quality_manager: 'pm',
    site_manager: 'site_manager', foreman: 'site_manager',
    worker: 'worker',
  };
  var UI_ROLE_BY_ORG_ROLE = {
    admin: 'admin', gm: 'gm', pm: 'project_manager',
    site_manager: 'site_manager', worker: 'worker',
  };
  var ORG_MEMBERSHIP_ROLES = { pm: 1, site_manager: 1, worker: 1 };

  function toOrgRole(uiRole) {
    return ORG_ROLE_BY_UI_ROLE[uiRole] || 'worker';
  }

  /* Map an org site's uuid onto the fixture slug the pages group by when
     a fixture site shares the name; otherwise keep the uuid (cosmetic
     degradation only — grouping still works, label shows the raw id). */
  function fixtureSlugByName(name) {
    var f = fixtures().sites || { sites: [] };
    var hit = (f.sites || []).filter(function (s) { return s.name === name; })[0];
    return hit ? hit.site_id : null;
  }

  function orgSiteToLegacy(site) {
    return {
      site_id:            fixtureSlugByName(site.name) || site.id,
      org_site_id:        site.id,
      name:               site.name,
      location:           site.location || '',
      region:             'south-island',
      client:             site.client || '',
      project_value_nzd:  0,
      planned_completion: '',
      icon:               site.icon_url || null,
      user_count:         0,
    };
  }

  function orgMemberToLegacy(m, siteNameById) {
    var name = ((m.first_name || '') + ' ' + (m.last_name || '')).trim() || m.email;
    var siteIds = (m.memberships || []).map(function (ms) {
      var nm = siteNameById[String(ms.site_id)];
      return (nm && fixtureSlugByName(nm)) || String(ms.site_id);
    });
    return {
      device_id:     m.cognito_sub,   /* stable row key the team page uses */
      cognito_sub:   m.cognito_sub,
      name:          name,
      email:         m.email,
      folder_name:   name.replace(/\s+/g, '_'),
      role:          UI_ROLE_BY_ORG_ROLE[m.global_role] || m.global_role,
      primary_site:  siteIds[0] || '',
      sites:         siteIds,
      managed_sites: [],
      avatarUrl:     m.avatar_url || null,
    };
  }

  async function orgSiteNameIndex() {
    var res = await window.FS.api.org.listSites();
    var idx = {};
    (res.sites || []).forEach(function (s) { idx[String(s.id)] = s.name; });
    return idx;
  }

  /* Resolve a legacy/fixture site selection (slug) to an org site uuid by
     matching names — org sites are seeded from the same user_mapping, so
     names line up. Returns null when unresolvable (caller skips membership). */
  function orgSiteIdForSlug(orgSites, slug) {
    var f = fixtures().sites || { sites: [] };
    var fx = (f.sites || []).filter(function (s) { return s.site_id === slug; })[0];
    var name = fx ? fx.name : null;
    var hit = (orgSites || []).filter(function (s) {
      return String(s.id) === String(slug) || (name && s.name === name);
    })[0];
    return hit ? hit.id : null;
  }

  /* Mock create/update mutations (Phase B). In mock mode they mutate the
     in-memory fixtures (session-scoped — reset on reload) and return the new
     object; live mode goes to the Phase 3 org backend. */
  async function createSite(input) {
    if (orgLive()) {
      var created = await window.FS.api.org.createSite({
        name:     input.name,
        location: input.location || null,
        client:   input.client || null,
      });
      return orgSiteToLegacy(created.site);
    }
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
    await window.FS.api.delay(400);
    var f = fixtures().sites; if (f && f.sites) f.sites.unshift(site);
    return site;
  }

  async function createUser(input) {
    if (orgLive()) {
      if (!input.email) {
        var e = new Error('Email is required to invite a member');
        e.status = 400;
        throw e;
      }
      var parts = (input.name || '').trim().split(/\s+/);
      var orgRole = toOrgRole(input.role || 'worker');
      var mships = [];
      if (input.primary_site) {
        var orgSites = (await window.FS.api.org.listSites()).sites || [];
        var siteId = orgSiteIdForSlug(orgSites, input.primary_site);
        if (siteId) {
          mships.push({
            site_id: siteId,
            role: ORG_MEMBERSHIP_ROLES[orgRole] ? orgRole : 'worker',
          });
        }
      }
      var res = await window.FS.api.org.createMember({
        email:       input.email,
        first_name:  parts[0] || null,
        last_name:   parts.slice(1).join(' ') || null,
        global_role: orgRole,
        memberships: mships,
      });
      var legacy = orgMemberToLegacy(res.member, {});
      /* keep the picker's slug so the new row groups under the chosen site */
      if (input.primary_site) { legacy.primary_site = input.primary_site; legacy.sites = [input.primary_site]; }
      return legacy;
    }
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
    await window.FS.api.delay(400);
    var f = fixtures().sites; if (f && f.users) f.users.unshift(user);
    return user;
  }

  async function updateUserRole(deviceId, role) {
    if (orgLive()) {
      /* live rows carry device_id = cognito_sub (orgMemberToLegacy) */
      var res = await window.FS.api.org.setMemberRole(deviceId, toOrgRole(role));
      return orgMemberToLegacy(res.member, {});
    }
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
