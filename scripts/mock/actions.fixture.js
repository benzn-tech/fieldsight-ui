/* ==========================================================================
   FieldSight Fixtures · Action items audit state
   --------------------------------------------------------------------------
   Mirrors GET /api/actions response shape — keyed first by date, then by
   `${topic_id}_${action_index}` (BACKEND-CONTEXT §4.10, §8.8).

   User-dimension audit key (plan docs/superpowers/plans/2026-07-13-user-
   dimension-audit-key.md, §1.3) — these keys are intentionally left BARE
   (no `<user_folder>|` prefix). They represent true legacy/unmigrated
   records, resolved only through `FS.api.actions.lookupAction()`'s bare-
   key fallback (never a raw `state[date][bareKey]` read — that would be
   the ANTI-REGRESSION IRON RULE violation). Keeping them bare means mock
   mode permanently exercises the legacy-fallback path alongside the
   composite-key path (mock writes go through `actionKey(user_folder, …)`
   in scripts/api/actions.js, which produces composite keys whenever a
   caller passes a user_folder — see toggleAction/createAction there).
   Do NOT rewrite these to composite keys.

   Note: topic_ids may shift if a report is regenerated (BUG §8.8). The
   fixture takes that as accepted risk; for hard audit, use the action
   history endpoint.

   Exported to window.FieldSight.fixtures.actions = { 'YYYY-MM-DD': { '<key>': {…} } }
   ========================================================================== */

(function () {
  'use strict';

  var actions = {
    '2026-04-29': {
      /* Topic 0 — Morning safety briefing — first action already done. */
      '0_0': {
        checked:    true,
        checked_by: 'Jack Gibson',
        checked_at: '2026-04-29T07:42:00Z',
      },
      /* Topic 2 — Concrete pour — slump test action checked off. */
      '2_1': {
        checked:    true,
        checked_by: 'Jarley Trainor',
        checked_at: '2026-04-29T01:18:42Z',
      },
    },
  };

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.fixtures) window.FieldSight.fixtures = {};
  window.FieldSight.fixtures.actions = actions;

})();
