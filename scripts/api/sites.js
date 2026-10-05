/* ==========================================================================
   FieldSight API · Sites & Users — BACKEND-CONTEXT §4.2
   --------------------------------------------------------------------------
   LIVE: org directory (GET /sites, /members, /sites/{id}/members) — never the
   legacy gateway. MOCK: fixtures. Shapes: { sites, role, display_name } /
   { users, site } / { users }.
   ========================================================================== */

(function () {
  'use strict';

  function fixtures() {
    return (window.FieldSight && window.FieldSight.fixtures) || {};
  }

  /* LIVE reads come from the org directory (Aurora, company-scoped) and from
     nowhere else. The legacy gateway served these from a frozen, company-blind
     mapping file, so there is deliberately NO fallback to it: when the
     directory is unreachable (or the org kill switch is off) the call REJECTS,
     and consumers must show the failure rather than substitute fixtures. Mock
     mode (useMocks) is unchanged. */
  function orgReady() {
    return !!(window.FS.api.orgBaseUrl && window.FS.api.org);
  }

  function requireOrg(what) {
    if (!orgReady()) throw new Error(what + ': the org directory is not configured');
  }

  /* orgRequest resolves 401/403/404 as flag objects instead of throwing; a
     directory READ that was refused is a failure here, not an empty list. */
  function rejectIfRefused(res, what) {
    if (res && (res._accessDenied || res._notFound)) {
      var err = new Error(what + ' failed (' + (res.status || (res._accessDenied ? 403 : 404)) + ')');
      err.status = res.status;
      err.response = res;
      throw err;
    }
    return res;
  }

  /* /members answers 403 for everyone below admin/gm/platform_admin, so the
     caller's role picks the route up front -- the 403 is never the normal
     path. Role comes from the session profile (session-bridge keeps the RAW
     role there; isAdmin is true for admin/platform_admin). */
  function canListAllMembers() {
    var c = (window.AuthMock && window.AuthMock.currentUser) || {};
    return c.role === 'admin' || c.role === 'gm' || c.role === 'platform_admin' || !!c.isAdmin;
  }

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* The org directory is keyed by UUID; a legacy/report-side slug is resolved
     through the directory's own site list (rows carry both site_id and slug).
     A value that matches nothing is passed through unchanged so the server,
     not the client, decides it does not exist. */
  async function resolveOrgSiteId(site) {
    if (!site || UUID_RE.test(String(site))) return site;
    var res = rejectIfRefused(await window.FS.api.org.getOrgSites(), 'getSites');
    var hit = ((res && res.sites) || []).filter(function (s) {
      return s.slug === site || s.site_id === site;
    })[0];
    return hit ? hit.site_id : site;
  }

  async function getSites() {
    if (!window.FS.api.useMocks) {
      requireOrg('getSites');
      var res = rejectIfRefused(await window.FS.api.org.getOrgSites(), 'getSites');
      var u0 = (window.AuthMock && window.AuthMock.currentUser) || {};
      return { sites: res.sites || [], role: u0.role || null, display_name: u0.name || null };
    }
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
    if (!window.FS.api.useMocks) {
      requireOrg('getSiteUsers');
      var id = await resolveOrgSiteId(site);
      /* An access-denied result is returned as-is (callers render it); it is
         never retried against the legacy gateway. */
      return window.FS.api.org.getSiteMembers(id);
    }
    await window.FS.api.delay();
    var f = fixtures().sites || { users: [] };
    var users = f.users.filter(function (u) {
      return (u.sites || []).indexOf(site) !== -1;
    });
    return { users: users, site: site };
  }

  async function getUsers() {
    if (!window.FS.api.useMocks) {
      requireOrg('getUsers');
      if (canListAllMembers()) {
        var m = rejectIfRefused(await window.FS.api.org.getMembers(), 'getUsers');
        return { users: m.members || [] };
      }
      /* Everyone else: the union of the members of the sites they can see,
         de-duplicated by identity (a person on two sites is one user). */
      var sitesRes = await getSites();
      /* One site refusing or failing must not blank the roster: skip it and
         use the rest. Only when EVERY site fails is that a failure (a caller
         with zero sites has simply nobody to list). */
      var firstErr = null;
      var settled = await Promise.all(sitesRes.sites.map(function (s) {
        return window.FS.api.org.getSiteMembers(s.site_id).then(function (r) {
          return rejectIfRefused(r, 'getUsers');
        }).then(function (r) { return { ok: true, r: r }; },
                function (e) { firstErr = firstErr || e; return { ok: false }; });
      }));
      var lists = settled.filter(function (x) { return x.ok; }).map(function (x) { return x.r; });
      if (sitesRes.sites.length > 0 && lists.length === 0) throw firstErr;
      var seen = {}, out = [];
      lists.forEach(function (r) {
        ((r && r.users) || []).forEach(function (u) {
          var key = u.device_id || u.email || u.name;
          if (!key || seen[key]) return;
          seen[key] = true;
          out.push(u);
        });
      });
      return { users: out };
    }
    await window.FS.api.delay();
    var f = fixtures().sites || { users: [] };
    return { users: f.users.slice() };   /* copy — see getSites note */
  }

  function slugify(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  }

  /* Mock create/update mutations (Phase B). They mutate the in-memory
     fixtures (session-scoped — reset on reload) and return the new object.
     They have callers (pages/sites.js and pages/team.js use them when the org
     API is not live), so they stay — but only as MOCK writers: the legacy
     gateway POST /sites, POST /users and PATCH /users/{id} they used to fall
     through to are gone. Outside mock mode the real writers are
     org.createOrgSite / createMember / updateMemberRole; reaching here means
     the org API is off, and the honest answer is a refusal that the callers'
     .catch turns into a toast. */
  function legacyWriteGone() {
    return Promise.reject(new Error('This change is not available right now.'));
  }
  function mockWrites() { return window.FS.api.useMocks || window.FS.api.writeMocks; }

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
    if (!mockWrites()) return legacyWriteGone();
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
    if (!mockWrites()) return legacyWriteGone();
    await window.FS.api.delay(400);
    var f = fixtures().sites; if (f && f.users) f.users.unshift(user);
    return user;
  }

  async function updateUserRole(deviceId, role) {
    if (!mockWrites()) return legacyWriteGone();
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
