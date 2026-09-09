'use strict';

/*
 * fix/batch-select-row-target + the Order row's direction control.
 *
 * The report was "batch 选择里面 shift+ 和 ctrl+ 都没有作用". The hook was
 * never the problem — driven directly (a real useState harness) its
 * Shift-range, Ctrl-toggle and anchor behaviour are all correct, and in the
 * browser Shift+click ON THE ROUND BUTTON ranges correctly. What did not
 * work was the obvious gesture: in Batch Select mode the row BODY still
 * opened the detail panel, so clicking rows and Shift-clicking rows selected
 * nothing. Two defects met there:
 *
 *   1. the row's onClick was `function () { onSelect(task); }` — it dropped
 *      the event, so even a wired-up row would have had no shiftKey to read;
 *   2. nothing routed the row to the batch handler at all.
 *
 * These tests drive TaskCard's rendered element tree, not the predicate:
 * asserting "rowSelects === true" would pass against a handler that still
 * throws the event away.
 */
const test = require('node:test');
const assert = require('node:assert');

/* ---- minimal React + FieldSight stubs ---------------------------------- */

global.React = {
  createElement: function (type, props) {
    return {
      type: type,
      props: props || {},
      children: Array.prototype.slice.call(arguments, 2),
    };
  },
  Fragment: 'Fragment',
  useState: function (v) { return [v, function () {}]; },
  useEffect: function () {},
  useRef: function (v) { return { current: v }; },
  useContext: function () { return null; },
  createContext: function (d) { return { Provider: 'Provider', _def: d }; },
};
global.window = {
  FieldSight: {
    Card: Object.assign(function Card() {}, { Body: function CardBody() {} }),
    Badge: function Badge() {},
    Avatar: function Avatar() {},
    NavIcon: function NavIcon() {},
  },
  FS: { api: {} },
};
global.document = { addEventListener() {}, removeEventListener() {} };

require('../scripts/composites/task-card.js');
const TaskCard = window.FieldSight.TaskCard;

const TASK = { id: 't1', title: 'Pour concrete', topic_id: 'tp1', actionIndex: 0, date: '2026-04-29' };

function render(props) {
  return TaskCard(Object.assign({ task: TASK }, props));
}

/* ---- the row is a selection target in batch mode ----------------------- */

test('batch mode OFF: clicking the row opens the detail, as before', () => {
  const opened = [];
  const batched = [];
  const el = render({
    checkable: true, batchMode: false,
    onSelect: (t) => opened.push(t.id),
    onBatchToggle: (t, e) => batched.push([t.id, e]),
  });

  el.props.onClick({});
  assert.deepStrictEqual(opened, ['t1']);
  assert.deepStrictEqual(batched, []);
  assert.ok(!/fs-task-card--batch/.test(el.props.className));
});

test('batch mode ON: clicking the row selects instead of opening', () => {
  const opened = [];
  const batched = [];
  const el = render({
    checkable: true, batchMode: true,
    onSelect: (t) => opened.push(t.id),
    onBatchToggle: (t, e) => batched.push([t.id, e]),
  });

  el.props.onClick({ preventDefault() {} });
  assert.deepStrictEqual(opened, [], 'the detail panel must not take the click');
  assert.strictEqual(batched.length, 1);
  assert.strictEqual(batched[0][0], 't1');
  assert.ok(/fs-task-card--batch/.test(el.props.className));
});

test('the row FORWARDS the event, so Shift and Ctrl survive the trip', () => {
  /* The specific old bug: `function () { onSelect(task); }` took no
     argument. A handler that selects the right row but drops the modifiers
     looks fixed and still cannot range-select. */
  const seen = [];
  const el = render({
    checkable: true, batchMode: true,
    onSelect: function () {},
    onBatchToggle: (t, e) => seen.push(e),
  });

  el.props.onClick({ shiftKey: true, ctrlKey: false, preventDefault() {} });
  el.props.onClick({ shiftKey: false, ctrlKey: true, preventDefault() {} });

  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].shiftKey, true, 'shiftKey must reach the hook');
  assert.strictEqual(seen[1].ctrlKey, true, 'ctrlKey must reach the hook');
});

test('a row with no round button is never hijacked by batch mode', () => {
  /* checkable false — a programme row, or an item missing topic_id. It has
     no selector of its own, so it must keep opening its detail. */
  const opened = [];
  const batched = [];
  const el = render({
    checkable: false, batchMode: true,
    onSelect: (t) => opened.push(t.id),
    onBatchToggle: (t) => batched.push(t.id),
  });

  el.props.onClick({});
  assert.deepStrictEqual(opened, ['t1']);
  assert.deepStrictEqual(batched, []);
});

test('batch mode with no onBatchToggle wired falls back to opening', () => {
  const opened = [];
  const el = render({ checkable: true, batchMode: true, onSelect: (t) => opened.push(t.id) });
  el.props.onClick({});
  assert.deepStrictEqual(opened, ['t1']);
});

/* ---- the round button still works, and still stops the row ------------- */

test('the round button keeps its own handler and does not double-fire', () => {
  const opened = [];
  const batched = [];
  const el = render({
    checkable: true, batchMode: true,
    onSelect: (t) => opened.push(t.id),
    onBatchToggle: (t, e) => batched.push(e),
  });

  /* Walk to the check button in the rendered tree. */
  let check = null;
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    const cn = n.props && n.props.className;
    if (typeof cn === 'string' && cn.indexOf('fs-task-card__check') !== -1) check = n;
    (n.children || []).forEach(function (c) {
      if (Array.isArray(c)) c.forEach(walk); else walk(c);
    });
  }(el));

  assert.ok(check, 'the round check button must still render in batch mode');
  let stopped = false;
  check.props.onClick({ shiftKey: true, stopPropagation() { stopped = true; }, preventDefault() {} });
  assert.strictEqual(batched.length, 1);
  assert.strictEqual(batched[0].shiftKey, true);
  assert.ok(stopped, 'the button must stop the row handler from also firing');
  assert.deepStrictEqual(opened, []);
});

/* ---- the direction control --------------------------------------------- */

const ordering = require('../scripts/api/today-ordering.js');

const ITEMS = [
  { id: 'a', date: '2026-04-20', priority: 'medium' },
  { id: 'b', date: '2026-04-29', priority: 'medium' },
  { id: 'c', date: '2026-04-24', priority: 'medium' },
];

test('omitting dir is byte-identical to the shipped order', () => {
  const withOut = ordering.orderOpenItemsBy(ITEMS, 'said').map((i) => i.id);
  const withDesc = ordering.orderOpenItemsBy(ITEMS, 'said', 'desc').map((i) => i.id);
  assert.deepStrictEqual(withOut, ['b', 'c', 'a'], 'newest said first');
  assert.deepStrictEqual(withDesc, withOut);
});

test("dir 'asc' flips the order", () => {
  assert.deepStrictEqual(
    ordering.orderOpenItemsBy(ITEMS, 'said', 'asc').map((i) => i.id),
    ['a', 'c', 'b']);
});

test('flipping does NOT promote the items the mode cannot order', () => {
  /* The reason this is not a plain .reverse(). Roughly three quarters of
     prod's open items resolve to no due date; reversing the array would
     open the list with that pile. */
  const mixed = [
    { id: 'dated-1', date: '2026-04-20' },
    { id: 'undated', date: '' },
    { id: 'dated-2', date: '2026-04-29' },
  ];
  const asc = ordering.orderOpenItemsBy(mixed, 'said', 'asc').map((i) => i.id);
  assert.strictEqual(asc[asc.length - 1], 'undated',
    'an item with no key stays at the end in both directions');
  assert.deepStrictEqual(asc.slice(0, 2), ['dated-1', 'dated-2']);
});

test('an unknown dir is treated as the default, not as asc', () => {
  assert.deepStrictEqual(
    ordering.orderOpenItemsBy(ITEMS, 'said', 'sideways').map((i) => i.id),
    ['b', 'c', 'a']);
});

test('the arrow label names the right thing for each mode', () => {
  const today = require('../scripts/pages/today.js');
  assert.strictEqual(today.sortDirLabel('said', 'desc'), 'Newest first');
  assert.strictEqual(today.sortDirLabel('said', 'asc'), 'Oldest first');
  assert.strictEqual(today.sortDirLabel('due', 'desc'), 'Soonest due first');
  assert.strictEqual(today.sortDirLabel('due', 'asc'), 'Latest due first');
});

test('visibleTasks threads the direction through', () => {
  const today = require('../scripts/pages/today.js');
  window.FS.api.orderOpenItemsBy = ordering.orderOpenItemsBy;
  assert.deepStrictEqual(
    today.visibleTasks(ITEMS, false, 'said', 'asc').map((i) => i.id),
    ['a', 'c', 'b']);
  assert.deepStrictEqual(
    today.visibleTasks(ITEMS, false, 'said').map((i) => i.id),
    ['b', 'c', 'a'], 'no direction given → unchanged');
});
