'use strict';

/*
 * The Team page has always modelled a person as having ONE primary site plus
 * some "secondary" pills, where primary_site is derived as memberships[0] --
 * i.e. whichever project they happened to be added to first. The backend has
 * never had a primary: it has N equal memberships, each carrying its own role,
 * and since GRADED_ROLES went true on prod that per-site role decides what the
 * person can see on that project. So "pm on Project A, worker on Project B" is
 * a real, live state the page could neither show nor edit.
 *
 * These are the pure helpers that replace the primary_site shape
 * (scripts/api/staffing.js). They are a separate module for the same reason
 * mine-team.js is: the page is a React IIFE with no renderer in this suite, so
 * logic that lives inside it cannot be driven. Everything decidable lives here
 * and is tested for real; the page keeps only the JSX.
 */
const test = require('node:test');
const assert = require('node:assert');

function load() {
  global.window = { FS: {}, FieldSight: {} };
  delete require.cache[require.resolve('../scripts/api/staffing.js')];
  require('../scripts/api/staffing.js');
  return global.window.FS.staffing;
}

const BO = {
  device_id: 'sub-bo', name: 'Bo',
  memberships: [{ site_id: 'site-a', role: 'pm' },
                { site_id: 'site-b', role: 'worker' }],
};
const ADA = {
  device_id: 'sub-ada', name: 'Ada',
  memberships: [{ site_id: 'site-b', role: 'site_manager' }],
};
const NOBODY = { device_id: 'sub-nul', name: 'Nul', memberships: [] };

/* ---- projectsOf ---------------------------------------------------------- */

test('projectsOf lists every project with the role held on THAT project', () => {
  const s = load();
  assert.deepStrictEqual(s.projectsOf(BO), [
    { site_id: 'site-a', role: 'pm' },
    { site_id: 'site-b', role: 'worker' },
  ]);
});

test('projectsOf returns an empty list for someone on no project', () => {
  const s = load();
  assert.deepStrictEqual(s.projectsOf(NOBODY), []);
  assert.deepStrictEqual(s.projectsOf({}), []);
  assert.deepStrictEqual(s.projectsOf(null), []);
});

test('projectsOf falls back to the mock fixture shape without inventing a role', () => {
  /* Fixture users carry sites[] and no memberships. They must still appear on
     their projects, but nothing in that shape says what role they hold there,
     so it reads as worker rather than borrowing global_role -- which would
     silently show a fixture admin as pm on every site. */
  const s = load();
  assert.deepStrictEqual(
    s.projectsOf({ sites: ['site-a', 'site-b'], role: 'admin' }),
    [{ site_id: 'site-a', role: 'worker' }, { site_id: 'site-b', role: 'worker' }]);
});

test('projectsOf ignores membership rows with no site', () => {
  const s = load();
  assert.deepStrictEqual(
    s.projectsOf({ memberships: [{ role: 'pm' }, { site_id: 'site-a', role: 'pm' }] }),
    [{ site_id: 'site-a', role: 'pm' }]);
});

/* ---- roleOnSite ---------------------------------------------------------- */

test('roleOnSite answers per project, not per person', () => {
  const s = load();
  assert.strictEqual(s.roleOnSite(BO, 'site-a'), 'pm');
  assert.strictEqual(s.roleOnSite(BO, 'site-b'), 'worker');
});

test('roleOnSite is null where there is no membership, not a default role', () => {
  /* The caller needs to tell "worker on this project" apart from "not on this
     project at all" -- a defaulted 'worker' would make an unstaffed person
     look staffed. */
  const s = load();
  assert.strictEqual(s.roleOnSite(BO, 'site-z'), null);
  assert.strictEqual(s.roleOnSite(NOBODY, 'site-a'), null);
});

/* ---- groupByProject ------------------------------------------------------ */

test('somebody on two projects appears under both', () => {
  /* The whole point. Grouping on primary_site put Bo under site-a only, so
     the site-b roster was wrong on the page that exists to show rosters. */
  const s = load();
  const groups = s.groupByProject([BO, ADA]);
  const bySite = {};
  groups.forEach(function (g) {
    bySite[g.site_id] = g.users.map(function (row) { return row.user.device_id; });
  });
  assert.deepStrictEqual(bySite['site-a'], ['sub-bo']);
  assert.deepStrictEqual(bySite['site-b'].sort(), ['sub-ada', 'sub-bo']);
});

test('each grouped row carries the role for THAT group, not the person', () => {
  const s = load();
  const groups = s.groupByProject([BO]);
  const roleAt = {};
  groups.forEach(function (g) { roleAt[g.site_id] = g.users[0].role; });
  assert.deepStrictEqual(roleAt, { 'site-a': 'pm', 'site-b': 'worker' });
});

test('people on no project are kept in their own bucket rather than dropped', () => {
  const s = load();
  const groups = s.groupByProject([NOBODY]);
  assert.deepStrictEqual(groups.map(function (g) { return g.site_id; }), ['__none__']);
  assert.strictEqual(groups[0].users[0].user.device_id, 'sub-nul');
  assert.strictEqual(groups[0].users[0].role, null);
});

test('groups are ordered by headcount, then site id, and the unstaffed bucket is last', () => {
  const s = load();
  const groups = s.groupByProject([BO, ADA, NOBODY]);
  assert.deepStrictEqual(groups.map(function (g) { return g.site_id; }),
    ['site-b', 'site-a', '__none__']);
});

test('groupByProject is a pure read of its input', () => {
  const s = load();
  const before = JSON.stringify(BO);
  s.groupByProject([BO, ADA]);
  assert.strictEqual(JSON.stringify(BO), before);
});

/* ---- membershipsForInvite ------------------------------------------------ */

test('an invite can name several projects at once', () => {
  /* createMember has always taken an array; the form sent at most one. */
  const s = load();
  assert.deepStrictEqual(s.membershipsForInvite(['site-a', 'site-b'], 'pm'), [
    { site_id: 'site-a', role: 'pm' },
    { site_id: 'site-b', role: 'pm' },
  ]);
});

test('an org role that is not a per-site role lands as worker', () => {
  /* admin/gm/regional_manager are global tiers; ALLOWED_MEMBERSHIP_ROLES is
     pm/site_manager/worker, and sending anything else is a 400. */
  const s = load();
  assert.deepStrictEqual(s.membershipsForInvite(['site-a'], 'admin'),
    [{ site_id: 'site-a', role: 'worker' }]);
  assert.deepStrictEqual(s.membershipsForInvite(['site-a'], 'regional_manager'),
    [{ site_id: 'site-a', role: 'worker' }]);
});

test('no site picked means no membership sent', () => {
  const s = load();
  assert.deepStrictEqual(s.membershipsForInvite([], 'pm'), []);
  assert.deepStrictEqual(s.membershipsForInvite(null, 'pm'), []);
});

test('a site picked twice is sent once', () => {
  const s = load();
  assert.deepStrictEqual(s.membershipsForInvite(['site-a', 'site-a'], 'worker'),
    [{ site_id: 'site-a', role: 'worker' }]);
});

test('blank site ids are dropped rather than sent as an invalid FK', () => {
  const s = load();
  assert.deepStrictEqual(s.membershipsForInvite(['', 'site-a', null], 'worker'),
    [{ site_id: 'site-a', role: 'worker' }]);
});

/* ---- editing the list ---------------------------------------------------- */

test('withProject adds a project the person was not on', () => {
  const s = load();
  assert.deepStrictEqual(s.withProject(BO.memberships, 'site-c', 'site_manager'), [
    { site_id: 'site-a', role: 'pm' },
    { site_id: 'site-b', role: 'worker' },
    { site_id: 'site-c', role: 'site_manager' },
  ]);
});

test('withProject changes the role in place rather than adding a second row', () => {
  /* The backend upserts on (user_id, site_id), so a duplicate row here would
     make the page disagree with what the server actually holds. */
  const s = load();
  assert.deepStrictEqual(s.withProject(BO.memberships, 'site-b', 'pm'), [
    { site_id: 'site-a', role: 'pm' },
    { site_id: 'site-b', role: 'pm' },
  ]);
});

test('withProject leaves the original list untouched', () => {
  const s = load();
  const before = JSON.stringify(BO.memberships);
  s.withProject(BO.memberships, 'site-c', 'pm');
  assert.strictEqual(JSON.stringify(BO.memberships), before);
});

test('withoutProject drops exactly one project', () => {
  const s = load();
  assert.deepStrictEqual(s.withoutProject(BO.memberships, 'site-a'),
    [{ site_id: 'site-b', role: 'worker' }]);
});

test('withoutProject on a project they are not on changes nothing', () => {
  const s = load();
  assert.deepStrictEqual(s.withoutProject(BO.memberships, 'site-z'), BO.memberships);
});

test('withoutProject can empty the list', () => {
  const s = load();
  assert.deepStrictEqual(s.withoutProject(ADA.memberships, 'site-b'), []);
});

/* ---- what is left to add ------------------------------------------------- */

test('addableProjects offers only the projects the person is not already on', () => {
  const s = load();
  const options = [{ v: 'site-a', l: 'A' }, { v: 'site-b', l: 'B' }, { v: 'site-c', l: 'C' }];
  assert.deepStrictEqual(s.addableProjects(BO, options), [{ v: 'site-c', l: 'C' }]);
});

test('addableProjects is empty when they are on everything', () => {
  const s = load();
  assert.deepStrictEqual(
    s.addableProjects(BO, [{ v: 'site-a', l: 'A' }, { v: 'site-b', l: 'B' }]), []);
});

/* ---- the header chip ----------------------------------------------------- */

const NAME = (id) => ({ 'site-a': 'Alpha', 'site-b': 'Bravo' }[id] || id);

test('projectSummary names the single project someone is on', () => {
  const s = load();
  assert.strictEqual(s.projectSummary(ADA, NAME), 'Bravo');
});

test('projectSummary names one project and counts the rest', () => {
  /* The chip used to show siteDisplayName(primary_site) -- the name of
     whichever project they joined first, with no hint there were others. */
  const s = load();
  assert.strictEqual(s.projectSummary(BO, NAME), 'Alpha +1');
});

test('projectSummary says so when there is no project', () => {
  const s = load();
  assert.strictEqual(s.projectSummary(NOBODY, NAME), 'No project');
});

/* ---- wiring -------------------------------------------------------------- */

const fs = require('node:fs');
const path = require('node:path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('the page ships: staffing.js is on the shell before the pages that call it', () => {
  /* A helper module nobody loads is a dead path that every unit test above
     would still call green. */
  const html = read('app-shell-preview.html');
  const at = html.indexOf('scripts/api/staffing.js');
  const team = html.indexOf('scripts/pages/team.js');
  assert.ok(at > -1, 'staffing.js must be loaded by the app shell');
  assert.ok(team > -1 && at < team, 'staffing.js must load before pages/team.js');
});

test('team.js groups by project and no longer keys rows off primary_site', () => {
  const src = read('scripts', 'pages', 'team.js');
  assert.ok(/staffing\.groupByProject\s*\(/.test(src),
    'grouping must go through staffing.groupByProject');
  assert.ok(!/u\.primary_site \|\| '__none__'/.test(src),
    'the primary_site grouping key must be gone');
});

test('the invite form sends the whole picked list, not one site', () => {
  const src = read('scripts', 'pages', 'team.js');
  assert.ok(/membershipsForInvite\s*\(\s*form\.site_ids/.test(src),
    'createMember must be given the multi-site list');
  assert.ok(!/memberships: form\.primary_site \?/.test(src),
    'the single-site invite path must be gone');
});

test('the detail panel writes memberships through the provider', () => {
  const src = read('scripts', 'pages', 'team.js');
  assert.ok(/ProjectsField/.test(src), 'the projects editor must be mounted');
  assert.ok(/ctx\.writeMembership\(/.test(src),
    'project edits must go through writeMembership, which patches state only after the server took it');
});
