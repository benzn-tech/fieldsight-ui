/* ==========================================================================
   Mock taxonomy — the shape GET /api/org/tags really returns.

   A SLICE of the real base set, not an invented vocabulary. The backend seeds
   12 parents and 70 children (migration 0065); reproducing all 82 here would
   make this file a second copy of the base set that drifts from the migration
   the first time either is edited. Three parents and their children are
   enough to exercise every case the screen has: a global parent, a company
   parent, a project child, and something switched off.

   The mock TEACHES THE CONTRACT, so it carries the fields the real payload
   carries and no others — `scope`, not `company_id`, because that is what the
   route emits (lambda_org_api._tag_payload). A fixture that invents a flatter
   shape is how a client ends up written against a payload that does not
   exist; this repo has had exactly that with the 404 envelope.
   ========================================================================== */

(function () {
  'use strict';

  var TAGS = [
    /* --- global: what we ship, and what a customer cannot edit ----------- */
    { id: 'g-structure', parent_id: null, site_id: null, scope: 'global',
      slug: 'structure', label: 'Structure', is_active: true, sort_order: 10 },
    { id: 'g-structure-slab', parent_id: 'g-structure', site_id: null, scope: 'global',
      slug: 'structure.slab', label: 'Slab', is_active: true, sort_order: 20 },
    { id: 'g-structure-framing', parent_id: 'g-structure', site_id: null, scope: 'global',
      slug: 'structure.framing', label: 'Framing', is_active: true, sort_order: 30 },

    { id: 'g-architecture', parent_id: null, site_id: null, scope: 'global',
      slug: 'architecture', label: 'Architecture', is_active: true, sort_order: 20 },
    { id: 'g-arch-walls', parent_id: 'g-architecture', site_id: null, scope: 'global',
      slug: 'architecture.walls', label: 'Walls', is_active: true, sort_order: 10 },
    { id: 'g-arch-ceilings', parent_id: 'g-architecture', site_id: null, scope: 'global',
      slug: 'architecture.ceilings', label: 'Ceilings', is_active: true, sort_order: 20 },
    { id: 'g-arch-floorings', parent_id: 'g-architecture', site_id: null, scope: 'global',
      slug: 'architecture.floorings', label: 'Floorings', is_active: true, sort_order: 30 },

    { id: 'g-safety', parent_id: null, site_id: null, scope: 'global',
      slug: 'safety', label: 'Safety', is_active: true, sort_order: 90 },
    { id: 'g-safety-hazard', parent_id: 'g-safety', site_id: null, scope: 'global',
      slug: 'safety.hazard', label: 'Hazard', is_active: true, sort_order: 10 },

    /* --- the company's own word ----------------------------------------- */
    { id: 'c-prefab', parent_id: null, site_id: null, scope: 'company',
      slug: 'prefab', label: 'Prefab', is_active: true, sort_order: 200 },

    /* --- a child ONE PROJECT added for itself ---------------------------- */
    { id: 's-arch-soffits', parent_id: 'g-architecture',
      site_id: '098f5d81-fa41-4fbd-883c-7839b592c7f6', scope: 'site',
      slug: 'architecture.soffits', label: 'Soffits', is_active: true, sort_order: 40 },

    /* --- switched off: present, and only when asked for ------------------
       `getTags()` filters this out unless includeInactive is passed, exactly
       as the route does. Keeping one here is what makes "the picker does not
       show it, the admin screen does" a thing a test can assert. */
    { id: 'c-retired', parent_id: null, site_id: null, scope: 'company',
      slug: 'retired-word', label: 'Retired word', is_active: false, sort_order: 300 },
  ];

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.fixtures) window.FieldSight.fixtures = {};
  window.FieldSight.fixtures.tags = TAGS;

})();
