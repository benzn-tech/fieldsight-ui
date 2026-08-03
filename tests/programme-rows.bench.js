'use strict';

/*
 * Reproducible before/after benchmark for the Gantt row build.
 *
 * Not a test — it asserts nothing and is not picked up by `node --test`
 * (the runner only collects *.test.js). Run it directly:
 *
 *     node tests/programme-rows.bench.js
 *
 * It exists so the numbers in the render-performance PR can be re-derived
 * rather than taken on trust, and so a future regression can be measured
 * against the same fixture.
 *
 * `oldBuild` below is the implementation this branch replaced, copied
 * verbatim from scripts/pages/programme.js:802-817 as it stood at
 * commit 06fc32f. Keep it frozen — editing it to "improve" it destroys the
 * comparison.
 */

global.window = global.window || { FieldSight: {} };
require('../scripts/mock/programme-large.fixture.js');
const fixture = global.window.FieldSight.PROGRAMME_LARGE_FIXTURE;
const { buildRows } = require('../scripts/api/programme-rows.js');

/* ---- the replaced implementation, frozen --------------------------------- */

function rollupGroup(parent, leaves) {
  var children = leaves.filter(function (t) { return t.parent_id === parent.task_id; });
  if (!children.length) return { start: null, end: null, progress: 0 };
  var start = children.reduce(function (m, t) { return !m || t.start < m ? t.start : m; }, null);
  var end   = children.reduce(function (m, t) { return !m || t.end   > m ? t.end   : m; }, null);
  var totalDays = children.reduce(function (s, t) { return s + (t.duration_days || 0); }, 0);
  var doneDays  = children.reduce(function (s, t) {
    return s + ((t.duration_days || 0) * (t.progress_pct || 0) / 100);
  }, 0);
  return {
    start: start, end: end,
    progress: totalDays > 0 ? Math.round(doneDays / totalDays * 100) : 0,
  };
}

function oldBuild(parents, leaves, collapsed) {
  var rows = [];
  parents.forEach(function (parent) {
    var roll = rollupGroup(parent, leaves);
    rows.push({
      kind: 'group',
      task: Object.assign({}, parent, {
        start: roll.start, end: roll.end, duration_days: 0,
        progress_pct: roll.progress, status: 'group',
      }),
      parent: parent, indent: 0,
    });
    if (!collapsed.has(parent.task_id)) {
      leaves
        .filter(function (t) { return t.parent_id === parent.task_id; })
        .forEach(function (leaf) { rows.push({ kind: 'leaf', task: leaf, indent: 1 }); });
    }
  });
  return rows;
}

/* ---- harness ------------------------------------------------------------- */

function bench(label, fn, n) {
  fn();                                   // warm up the JIT
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / n;
  console.log(label.padEnd(28), ms.toFixed(2) + ' ms/call');
  return ms;
}

const collapsed = new Set();
const P = fixture.parents;
const L = fixture.leaves;

console.log('fixture: ' + P.length + ' groups, ' + L.length + ' leaves, '
  + fixture.start_date + ' -> ' + fixture.end_date);
console.log('');

const oldMs = bench('old inline build', () => oldBuild(P, L, collapsed), 50);
const newMs = bench('new buildRows', () => buildRows(P, L, collapsed), 200);

console.log('');
console.log('speedup: ' + (oldMs / newMs).toFixed(1) + 'x');
console.log('');
console.log('The old build ran on every render, and the scroll handler set state');
console.log('on every scrolled pixel. At 60 renders/sec that is:');
console.log('  old: ' + (oldMs * 60).toFixed(0) + ' ms of work per second of scrolling'
  + '  (' + (oldMs * 60 / 10).toFixed(0) + '% of the frame budget)');
console.log('  new: ' + (newMs * 60).toFixed(0) + ' ms — and it is memoized, so while');
console.log('       scrolling the real figure is 0: the row list is not rebuilt at all.');

/* ---- parity: the fast path must produce the identical row list ----------- */

const a = oldBuild(P, L, collapsed);
const b = buildRows(P, L, collapsed);

const sameCount = a.length === b.length;
const sameOrder = a.every((r, i) => r.kind === b[i].kind && r.task.task_id === b[i].task.task_id);
const aGroups = a.filter((r) => r.kind === 'group');
const bGroups = b.filter((r) => r.kind === 'group');
const sameRollups = aGroups.every((r, i) =>
  r.task.start === bGroups[i].task.start
  && r.task.end === bGroups[i].task.end
  && r.task.progress_pct === bGroups[i].task.progress_pct);

console.log('');
console.log('parity  rows: ' + sameCount + '  order: ' + sameOrder + '  rollups: ' + sameRollups);

if (!sameCount || !sameOrder || !sameRollups) {
  console.error('PARITY FAILED — the new build is not equivalent to the one it replaced');
  process.exit(1);
}
