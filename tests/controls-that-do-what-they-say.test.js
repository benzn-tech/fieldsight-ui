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
  /* A button that appears and then gets a 403 is worse than no button. */
  const m = code(LIBRARY).match(/var canDelete = [\s\S]*?;\n/);
  assert.ok(m, 'canDelete has moved');
  assert.match(m[0], /sel\.scope === 'personal'/);
  assert.match(m[0], /template:manage:self/);
  assert.match(m[0], /canManageOrg/);
});
