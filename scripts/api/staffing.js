'use strict';

/* Staffing — who is on which project, and as what.
 *
 * The Team page modelled a person as one `primary_site` plus "secondary" site
 * pills, with primary_site derived as memberships[0]: whichever project they
 * were added to first. The backend has never had a primary. It has N equal
 * memberships, each with its own role, and since GRADED_ROLES went true on
 * prod that per-site role decides what the person sees on that project. "pm on
 * Project A, worker on Project B" is a real state the primary_site shape could
 * neither show nor edit.
 *
 * These helpers live outside the page for the same reason mine-team.js does:
 * the page is a React IIFE and there is no renderer in the test suite, so
 * anything decidable has to sit where it can be driven directly. The page
 * keeps the JSX and calls in here for the decisions.
 */
(function () {
  var MEMBERSHIP_ROLES = ['pm', 'site_manager', 'worker'];
  var UNSTAFFED = '__none__';

  /* Every project the person is on, with the role held on THAT project.
     Falls back to the mock fixture shape (sites[] and no memberships) so the
     fixtures keep rendering -- but reads those as 'worker' rather than
     borrowing global_role, which would show a fixture admin as pm everywhere. */
  function projectsOf(user) {
    if (!user) return [];
    var rows = user.memberships;
    if (rows && rows.length) {
      return rows.filter(function (m) { return m && m.site_id; })
                 .map(function (m) {
                   return { site_id: m.site_id, role: m.role || 'worker' };
                 });
    }
    return (user.sites || []).filter(Boolean).map(function (siteId) {
      return { site_id: siteId, role: 'worker' };
    });
  }

  /* The role on one project, or null. Null and 'worker' are different answers:
     one means "not on this project", the other "on it, with the least
     authority", and defaulting the first to the second makes an unstaffed
     person look staffed. */
  function roleOnSite(user, siteId) {
    var hit = projectsOf(user).filter(function (p) { return p.site_id === siteId; })[0];
    return hit ? hit.role : null;
  }

  /* Group people by project. Somebody on two projects appears under BOTH --
     grouping on primary_site left them off the second project's roster, on the
     page whose job is showing rosters. People on no project keep their own
     bucket instead of disappearing. Ordered by headcount, then site id, with
     the unstaffed bucket last however big it is. */
  function groupByProject(users) {
    var map = {};
    function bucket(siteId) {
      if (!map[siteId]) map[siteId] = { site_id: siteId, users: [] };
      return map[siteId];
    }
    (users || []).forEach(function (u) {
      var projects = projectsOf(u);
      if (!projects.length) {
        bucket(UNSTAFFED).users.push({ user: u, role: null });
        return;
      }
      projects.forEach(function (p) {
        bucket(p.site_id).users.push({ user: u, role: p.role });
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
      if (a.site_id === UNSTAFFED) return 1;
      if (b.site_id === UNSTAFFED) return -1;
      var diff = b.users.length - a.users.length;
      if (diff !== 0) return diff;
      return String(a.site_id).localeCompare(String(b.site_id));
    });
  }

  /* The `memberships` array for POST /members. The form used to send at most
     one entry although the endpoint always took a list. A global tier
     (admin/gm/regional_manager) is not a per-site role, and sending one is a
     400, so it lands as worker. */
  function membershipsForInvite(siteIds, orgRole) {
    var role = MEMBERSHIP_ROLES.indexOf(orgRole) >= 0 ? orgRole : 'worker';
    var seen = {};
    return (siteIds || []).filter(function (id) {
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    }).map(function (id) {
      return { site_id: id, role: role };
    });
  }

  /* Add a project, or change the role on one already held. Never two rows for
     the same project: the backend upserts on (user_id, site_id), so a second
     row would make the page disagree with what the server holds. Returns a new
     list -- the caller is React state. */
  function withProject(memberships, siteId, role) {
    var found = false;
    var next = (memberships || []).map(function (m) {
      if (m.site_id !== siteId) return m;
      found = true;
      return { site_id: siteId, role: role };
    });
    if (!found) next.push({ site_id: siteId, role: role });
    return next;
  }

  /* Drop one project. A project they are not on is not an error -- the caller
     may be reconciling against a server that already removed it. */
  function withoutProject(memberships, siteId) {
    return (memberships || []).filter(function (m) { return m.site_id !== siteId; });
  }

  /* The picker's options minus what the person already holds, so "add to
     project" cannot silently mean "change the role on one they are on". */
  function addableProjects(user, options) {
    var held = {};
    projectsOf(user).forEach(function (p) { held[p.site_id] = true; });
    return (options || []).filter(function (o) { return !held[o.v]; });
  }

  /* One-line "which projects" for the detail header. The chip used to be
     siteDisplayName(primary_site): the name of whichever project the person
     joined first, with nothing to say there were others. */
  function projectSummary(user, siteName) {
    var projects = projectsOf(user);
    if (!projects.length) return 'No project';
    var first = siteName(projects[0].site_id);
    return projects.length === 1 ? first : first + ' +' + (projects.length - 1);
  }

  if (!window.FS) window.FS = {};
  window.FS.staffing = {
    MEMBERSHIP_ROLES: MEMBERSHIP_ROLES,
    UNSTAFFED: UNSTAFFED,
    projectsOf: projectsOf,
    roleOnSite: roleOnSite,
    groupByProject: groupByProject,
    membershipsForInvite: membershipsForInvite,
    withProject: withProject,
    withoutProject: withoutProject,
    addableProjects: addableProjects,
    projectSummary: projectSummary,
  };
}());
