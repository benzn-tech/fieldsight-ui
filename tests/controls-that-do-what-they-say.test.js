'use strict';

/*
 * Three controls, each of which said something the system did not do.
 *
 * 1. /reports had a template picker. Choosing from it set a variable nothing
 *    read; regenerate sends report_type and date. It could not have worked,
 *    and it sat on the page most people open first.
 *
 * 2. The Library offered "Use this template" on personal templates, gated on
 *    whether you may manage your OWN templates -- which you always may. The
 *    server refuses that pair outright, so it was offered to everybody and
 *    every press was a round trip to a refusal.
 *
 * 3. There was no way to delete a template. The route existed, and so did its
 *    guard refusing to withdraw one a schedule still points at -- a guard
 *    written, tested, and unreachable by any user.
 *
 * THE test is `nothing on /reports offers a template choice`. The other two
 * added something; that one removed something, and removals are what come
 * back when a later reader finds a gap and fills it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function read(...p) {
  return fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
}

const REPORTS = read('scripts', 'pages', 'reports.js');
const LIBRARY = read('scripts', 'pages', 'library.js');

function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ---- THE test -------------------------------------------------------------- */

test('THE test: nothing on /reports offers a template choice', () => {
  /* The template a SCHEDULED report uses is a company-wide setting, changed in
     the Library by gm/admin. This page only re-runs the nightly reports, so a
     picker here can only ever mislead. */
  const src = code(REPORTS);
  assert.ok(!/TemplateFormatSelector/.test(src), 'the dead picker is back');
  assert.ok(!/selTplId/.test(src), 'its state is back');
  assert.ok(!/api\.templates/.test(src), '/reports is asking for templates again');
});

test('the reason is written where the control used to be', () => {
  /* A removal with no note is a gap, and a gap gets filled. */
  assert.match(REPORTS, /NO TEMPLATE PICKER HERE/);
});

/* ---- Activate means "the scheduled report uses this" ----------------------- */

test('only an organisation template can be made active', () => {
  assert.match(code(LIBRARY),
    /canActivate = sel\.scope === 'org' && isSchedulable && canManageOrg/);
});

test('and only one the schedule actually runs', () => {
  /* session/day reports are generated on demand; nothing schedules them, so
     binding one would be state nothing reads. */
  assert.match(code(LIBRARY), /isSchedulable = \['daily', 'weekly', 'monthly'\]/);
});

test('a personal template says what it IS for instead of offering a dead button', () => {
  /* Not a disabled control: nothing is being withheld, so a greyed-out button
     would invent a restriction that does not exist. */
  assert.match(LIBRARY, /Pick it when you generate a report from the timeline/);
  assert.match(LIBRARY, /not used for the scheduled reports/);
});

/* ---- delete ---------------------------------------------------------------- */

test('a template can be deleted at all', () => {
  const src = code(LIBRARY);
  assert.match(src, /function handleDelete/);
  assert.match(src, /templates\['delete'\]/);
  assert.match(src, /Delete template/);
});

test('deleting asks first', () => {
  assert.match(code(LIBRARY), /window\.confirm\(/);
});

test('the confirm says the reports already written are safe', () => {
  /* The server soft-deletes and keeps every version, because a withdrawn
     template is still the template that wrote last month's reports. "Delete"
     on its own would suggest they go with it. */
  assert.match(LIBRARY, /Reports already written to it keep/);
});

test("the server's refusal is shown as the server words it", () => {
  /* 409 when a schedule still points at the template. The server knows which
     schedule and this page does not; "could not delete" would send someone
     hunting for a permissions problem that is not there. */
  const m = code(LIBRARY).match(/function handleDelete[\s\S]*?\n    \}/);
  assert.ok(m, 'handleDelete has moved');
  assert.match(m[0], /err && err\.message/);
});

test('delete is offered on the same terms the server enforces', () => {
  /* A button that appears and then gets a 403 is worse than no button.
     Pinned to the RULE, not to how it is spelled: deleting reuses the editing
     gate now, which is the same rule said once instead of twice. */
  const src = code(LIBRARY);
  const del = src.match(/var canDelete = [^;]*;/);
  assert.ok(del, 'canDelete has moved');
  const edit = src.match(/var canEdit = [^;]*;/);
  assert.ok(edit, 'canEdit has moved');
  const rule = /canEdit/.test(del[0]) ? edit[0] : del[0];
  assert.match(rule, /sel\.scope === 'personal'/);
  assert.match(rule, /template:manage:self/);
  assert.match(rule, /canManageOrg/);
});

/* ---- editing is not scheduling --------------------------------------------- */

test('THE regression test: the Edit tab does not depend on scheduling rights', () => {
  /* It did. `canActivate` answered both "may you change this template?" and
     "may the scheduled reports use it?", and its old rule -- you may always
     manage your own -- happened to answer the first correctly. Narrowing it to
     org + schedulable + gm/admin was right for scheduling and took the Edit
     tab away from every personal template with it: people could no longer edit
     the templates they had just made.

     One name, two meanings, and a change made for one of them. */
  const src = code(LIBRARY);
  /* Walk back from the tab's own label to whatever guards it. */
  const at = src.indexOf("}, 'Edit') : null");
  assert.ok(at > 0, 'the Edit tab has moved');
  const guards = [...src.slice(Math.max(0, at - 400), at).matchAll(/(can\w+) \?/g)]
    .map((m) => m[1]);
  assert.ok(guards.length, 'the Edit tab is no longer guarded by a can* flag');
  assert.strictEqual(guards[guards.length - 1], 'canEdit',
    'the Edit tab must follow canEdit, not ' + guards[guards.length - 1]);
});

test('rolling a version back follows editing too, not scheduling', () => {
  const m = code(LIBRARY).match(/canManage:\s*can\w+/);
  assert.ok(m, 'the history panel prop has moved');
  assert.match(m[0], /canEdit/);
});

test('editing your own personal template needs nothing but owning it', () => {
  const m = code(LIBRARY).match(/var canEdit = [^;]*;/);
  assert.ok(m);
  assert.match(m[0], /sel\.scope === 'personal'/);
  assert.match(m[0], /template:manage:self/);
  assert.ok(!/isSchedulable/.test(m[0]),
    'whether a report type runs on a schedule has nothing to do with editing it');
});

test('a template you cannot edit says so, rather than showing one tab fewer', () => {
  /* A missing tab is not an explanation: two tabs where a colleague sees
     three reads as a fault. Fourth time today that two states looked alike. */
  assert.match(LIBRARY, /fs-library__right-readonly/);
  assert.match(LIBRARY, /an admin or GM can change it/);
  assert.match(LIBRARY, /copy it to your library/);
});
