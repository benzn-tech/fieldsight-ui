'use strict';

/*
 * Timeline landing rule and the way back out of a person's day.
 *
 * Two prod complaints, one area:
 *
 *   1. A PM who opened a colleague's day had NO way back. The "back to
 *      overview" control was gated on isAdminLike (admin/gm/isAdmin), which
 *      silently excludes pm and site_manager — the two roles that spend the
 *      most time moving between people.
 *
 *   2. Landing on the team view cost every recorder an extra click, plus a
 *      scan down a list of colleagues to find themselves, before they could
 *      see what they had just recorded.
 *
 * The rule is now own-day-first with an explicit `view=team` escape, and the
 * back control is gated on whether the caller can actually REACH an overview
 * rather than on their job title.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
global.React = global.React || {};

const { canSeeOverview, isAdminLike, resolveTimelineScope } =
  require('../scripts/pages/timeline.js');

const ADMIN  = { role: 'admin', name: 'Ada Lovelace' };
const GM     = { role: 'gm', name: 'Sam Yu' };
const PM     = { role: 'pm', name: 'Pat Manager' };
const SITEMG = { role: 'site_manager', name: 'Sid Manager' };
const WORKER = { role: 'worker', name: 'Wanda Worker' };

/* ---- canSeeOverview: the bug behind "I can't get back" -------------------- */

test('a pm with a site anchored can return to the overview', () => {
  // The reported bug: this was false, so no back control rendered at all.
  assert.strictEqual(canSeeOverview(PM, 'site-1'), true);
  assert.strictEqual(canSeeOverview(SITEMG, 'site-1'), true);
});

test('a pm with NO site anchored is offered a way back too', () => {
  // This was false, on the reasoning that a siteless "back" would bounce them
  // into the view they just left. It does not: ?view=team with no site
  // renders the project picker, which is a next step rather than a dead end.
  //
  // Requiring a site made this false in exactly the DEFAULT state — the
  // header sits on "— All projects —" until someone chooses — which also
  // silently disabled the empty-day handover that depends on this predicate.
  assert.strictEqual(canSeeOverview(PM, null), true);
  assert.strictEqual(canSeeOverview(SITEMG, undefined), true);
});

test('the answer does not depend on a site at all', () => {
  // Pinned so the site argument cannot quietly come back: every caller who
  // has an overview has one whether or not a project is selected.
  [PM, SITEMG, ADMIN, GM].forEach((who) => {
    assert.strictEqual(canSeeOverview(who, null), canSeeOverview(who, 'site-1'));
  });
});

test('admin and gm can always return, site or not', () => {
  assert.strictEqual(canSeeOverview(ADMIN, null), true);
  assert.strictEqual(canSeeOverview(GM, 'site-1'), true);
});

test('a worker is never offered an overview', () => {
  // There is nothing to go back TO — they only ever see their own day.
  assert.strictEqual(canSeeOverview(WORKER, 'site-1'), false);
  assert.strictEqual(canSeeOverview(WORKER, null), false);
});

test('canSeeOverview is not just isAdminLike renamed', () => {
  // The whole point: these two answers differ for exactly the roles that
  // reported the bug.
  assert.strictEqual(isAdminLike(PM), false);
  assert.strictEqual(canSeeOverview(PM, 'site-1'), true);
});

test('a missing or malformed caller is treated as having no overview', () => {
  assert.strictEqual(canSeeOverview(null, 'site-1'), false);
  assert.strictEqual(canSeeOverview(undefined, 'site-1'), false);
  assert.strictEqual(canSeeOverview({}, null), false);
});

/* ---- resolveTimelineScope: own-day-first --------------------------------- */

test('no user and no view lands the caller on their own day', () => {
  const r = resolveTimelineScope(PM, {}, 'Pat_Manager');
  assert.strictEqual(r.user, 'Pat_Manager');
  assert.strictEqual(r.selfDefaulted, true);
});

test('an anchored site no longer forces the team view', () => {
  // The old rule: site anchored => team view, self was an extra click away.
  const r = resolveTimelineScope(PM, { site: 'site-1' }, 'Pat_Manager');
  assert.strictEqual(r.user, 'Pat_Manager');
});

test('admin and gm land on their own day too', () => {
  // They were the one group the old rule never sent to self.
  assert.strictEqual(resolveTimelineScope(ADMIN, {}, 'Ada_Lovelace').user, 'Ada_Lovelace');
  assert.strictEqual(resolveTimelineScope(GM, { site: 's' }, 'Sam_Yu').user, 'Sam_Yu');
});

test('view=team is an explicit request for the multi-person view', () => {
  const r = resolveTimelineScope(PM, { view: 'team', site: 'site-1' }, 'Pat_Manager');
  assert.strictEqual(r.user, null);
  assert.strictEqual(r.selfDefaulted, false);
});

test('an explicit ?user= wins over the own-day default', () => {
  const r = resolveTimelineScope(PM, { user: 'Sam_Yu' }, 'Pat_Manager');
  assert.strictEqual(r.user, 'Sam_Yu');
  assert.strictEqual(r.selfDefaulted, false);
});

test('?user= pointing at yourself is still an explicit choice', () => {
  // Matters for the empty-day handover: a day you deliberately opened keeps
  // its empty state instead of silently swapping to the team.
  const r = resolveTimelineScope(PM, { user: 'Pat_Manager' }, 'Pat_Manager');
  assert.strictEqual(r.selfDefaulted, false);
});

test('a worker is pinned to themselves even when the URL says otherwise', () => {
  assert.strictEqual(
    resolveTimelineScope(WORKER, { user: 'Sam_Yu' }, 'Wanda_Worker').user, 'Wanda_Worker');
  assert.strictEqual(
    resolveTimelineScope(WORKER, { view: 'team' }, 'Wanda_Worker').user, 'Wanda_Worker');
});

test('a worker never carries the selfDefaulted marker', () => {
  // They have no team view to hand over to, so the empty-day fallback must
  // never fire for them — it would have nowhere to go.
  assert.strictEqual(
    resolveTimelineScope(WORKER, {}, 'Wanda_Worker').selfDefaulted, false);
});

test('view=team survives alongside a date and site (deep-linkable)', () => {
  // The control navigates rather than calling history.back(), so the choice
  // has to round-trip through the URL for refresh, bookmarks and shared links.
  const r = resolveTimelineScope(GM, { view: 'team', date: '2026-08-03', site: 's1' }, 'Sam_Yu');
  assert.strictEqual(r.user, null);
});

/* ---- the handover is a state, not the absence of a user ------------------ */

/*
 * The empty-day handover keeps `user` set to the caller deliberately: moving
 * to a date where they DID record must show their own day again, with no URL
 * rewrite. That means "is this the multi-person view?" is NOT `!user` any
 * more, and every render branch has to agree on it.
 *
 * It did not. `canSeeOverview` required a site, so the handover never armed
 * in the default "— All projects —" state; once armed, the render branches
 * still tested `!user`, so the state was set and nothing drew it, and the
 * page fell through to the very empty day it was avoiding. On prod 8 of 10
 * site managers have no recordings of their own, so this was their landing.
 */
function isTeamView(user, state) {
  return !user || !!(state || {}).aggregated;
}

test('the handover counts as the team view even though a user is set', () => {
  assert.strictEqual(isTeamView('Jarley_Trainor', { aggregated: true }), true);
});

test('an ordinary person view does not', () => {
  assert.strictEqual(isTeamView('Jarley_Trainor', { aggregated: false }), false);
  assert.strictEqual(isTeamView('Jarley_Trainor', {}), false);
});

test('an explicitly empty team view still counts', () => {
  assert.strictEqual(isTeamView(null, {}), true);
});
