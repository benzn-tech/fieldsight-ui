/* ==========================================================================
   FieldSight API · Taxonomy — GET /api/org/tags

   The vocabulary a topic or an action can be labelled with. Two levels, three
   scopes:

     global    the base set we ship. Readable by everyone, editable by nobody.
     company   the company's own words.
     site      a child one project added for itself.

   NOTHING IS TAGGED YET. This module and the Settings screen that reads it
   land first, so the tagging change is a change to one writer rather than to
   the schema, the API, the writer and the UI at once. That is also why there
   are no filter chips anywhere: a chip over a corpus with no assignments is a
   control that does nothing, which is the exact failure the Evidence grouping
   was just fixed for.

   Registers as FS.api.tags.
   ========================================================================== */

(function () {
  'use strict';

  /* The flat payload as a two-level tree.

     PURE, and separate from the fetch, because the interesting part is not
     the request. A child whose parent is absent from the payload is promoted
     to the top rather than dropped: the parent can legitimately be missing --
     deactivated, or belonging to a site this caller cannot reach -- and a
     child that silently disappears is how a company loses half its vocabulary
     with nothing on screen to indicate it.

     EACH LEVEL IS SORTED HERE, by (sort_order, label). The first version
     leaned on the backend's ORDER BY, which tried to group a parent with its
     children in SQL and therefore ordered the GROUPS by a uuid rendered as
     text -- the twelve top-level tags came out in an order nobody chose. The
     backend now returns (sort_order, label) flat and the tree is assembled
     here, so the ordering is expressed once instead of half in each place. */
  function asTree(rows) {
    var list = (rows || []).slice();
    var byId = {};
    list.forEach(function (t) { byId[t.id] = Object.assign({}, t, { children: [] }); });

    var roots = [];
    list.forEach(function (t) {
      var node = byId[t.id];
      var parent = t.parent_id != null ? byId[t.parent_id] : null;
      /* `parent !== node` guards a row that names itself. The backend cannot
         produce one today, but a cycle is an infinite loop in a recursive
         renderer and the cost of refusing it is one comparison. */
      if (parent && parent !== node) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    });

    function byOrder(a, b) {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return String(a.label || '').localeCompare(String(b.label || ''));
    }
    roots.sort(byOrder);
    roots.forEach(function (r) { r.children.sort(byOrder); });
    return roots;
  }

  function orgLive() {
    return !window.FS.api.useMocks && !!window.FS.api.orgBaseUrl;
  }

  /* The taxonomy this caller can see. `includeInactive` is for the admin
     screen only -- a deactivated word has to stay reachable there or nothing
     could ever switch it back on, and it must stay out of every picker. */
  async function getTags(opts) {
    opts = opts || {};
    if (orgLive()) {
      return window.FS.api.orgRequest(
        '/tags', opts.includeInactive ? { params: { includeInactive: '1' } } : undefined);
    }
    await window.FS.api.delay();
    var fx = (window.FieldSight && window.FieldSight.fixtures) || {};
    var rows = (fx.tags || []).slice();
    if (!opts.includeInactive) {
      rows = rows.filter(function (t) { return t.is_active !== false; });
    }
    return { tags: rows };
  }

  var mod = { getTags: getTags, asTree: asTree };
  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.tags = mod;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();
