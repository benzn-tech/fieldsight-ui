'use strict';

/*
 * fix/the-easing-token-that-never-existed
 *
 * Checking off a single task has not removed its row from Today or Tasks
 * since 2026-04-30. Three separate things had to be true for that, and a
 * test that pins only one of them passes over a broken feature:
 *
 *   1. `.fs-task-card--checking-off` declares
 *      `animation: fs-task-checkoff 900ms var(--easing-out) forwards`, and
 *      `--easing-out` was defined NOWHERE. An undefined var() with no
 *      fallback invalidates the whole declaration at computed-value time,
 *      so animation-name computed to `none` and `animationend` never fired.
 *
 *   2. The handler was passed to `Card.Body`, and `CardBody`
 *      (components/card.js) destructures exactly className/style/children
 *      with no rest spread -- so it reached no DOM node at all.
 *
 *   3. Even attached there it would have been on the wrong element: the
 *      animating class sits on the Card ROOT, and animation events
 *      propagate upward, never down into a descendant.
 *
 * `onCheckedOff` is the ONLY caller of removeMy/removeRow on the single
 * check-off path (today.js, tasks.js), so all three had to be fixed
 * together. These tests drive the real render and the real stylesheet
 * rather than asserting the shape of the source.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* ---------- a recording React ----------------------------------------- */

/* Enough of React to render one component and walk what it built. Nodes
   keep their `type` so a test can tell Card from Card.Body -- which is the
   distinction defect (3) turns on and the reason a shallower double
   (recording only props) would pass against the bug. */
function makeReact(stateSeed) {
  let stateIndex = 0;
  return {
    _reset() { stateIndex = 0; },
    createElement(type, props, ...children) {
      const flat = [];
      (function push(list) {
        list.forEach(function (c) {
          if (Array.isArray(c)) push(c);
          else if (c !== null && c !== undefined && c !== false) flat.push(c);
        });
      })(children);
      return { type: type, props: props || {}, children: flat };
    },
    useState(initial) {
      const i = stateIndex++;
      const v = (i < stateSeed.length) ? stateSeed[i] : initial;
      return [v, function () {}];
    },
    useRef(v) { return { current: v }; },
    useEffect() {},
    useContext() { return null; },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    Fragment: 'Fragment',
  };
}

function loadTaskCard(stateSeed) {
  const React = makeReact(stateSeed);
  global.React = React;
  global.window = {
    FieldSight: {
      /* Distinct sentinels so the walk below can name what it found. */
      Card: Object.assign(function Card() {}, { Body: function CardBody() {} }),
      Avatar: function Avatar() {},
      Badge: function Badge() {},
      NavIcon: function NavIcon() {},
    },
    FS: { api: {} },
  };
  global.window.FieldSight.Card.Body = function CardBody() {};
  global.document = { addEventListener() {}, removeEventListener() {} };

  delete require.cache[require.resolve('../scripts/composites/task-card.js')];
  require('../scripts/composites/task-card.js');
  return { React: React, TaskCard: global.window.FieldSight.TaskCard,
           Card: global.window.FieldSight.Card };
}

/* NEWLINES NORMALISED BEFORE ANY MATCHING. This repo is developed on Windows
   with core.autocrlf=true, so the same file is LF in one checkout and CRLF in
   the next — a `git stash pop` is enough to flip it. A pattern spanning a line
   break then matches when the file happens to be LF and fails when it happens
   to be CRLF, which reads as "the code changed" when nothing changed. */
function readNormalised(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'styles', name), 'utf8')
    .replace(/\r\n/g, '\n');
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  (node.children || []).forEach(function (c) { walk(c, visit); });
}

const TASK = {
  id: 't1', title: 'Seal the roof penetration', status: 'Open',
  statusTone: 'warning', dueTime: '4pm', assignee: 'Neil Blunden',
};

/* ---------- the wiring, driven ---------------------------------------- */

test('the animationend handler is on the element that actually animates, not on a descendant of it', () => {
  /* checkingOff = true: the component's only useState. */
  const { TaskCard, Card } = loadTaskCard([true]);
  const tree = TaskCard({ task: TASK, onCheckedOff: function () {} });

  const carriers = [];
  walk(tree, function (n) { if (n.props && n.props.onAnimationEnd) carriers.push(n); });

  assert.strictEqual(carriers.length, 1,
    'exactly one element should carry onAnimationEnd');
  assert.strictEqual(carriers[0].type, Card,
    'onAnimationEnd must sit on Card (which receives fs-task-card--checking-off '
    + 'and therefore dispatches animationend), not on Card.Body -- events '
    + 'propagate up, so a handler below the animating element never runs');

  assert.match(String(carriers[0].props.className || ''),
    /fs-task-card--checking-off/,
    'the element carrying the handler must be the one carrying the animating class');
});

test('firing animationend on that element removes the row', () => {
  const { TaskCard } = loadTaskCard([true]);
  let removed = null;
  const tree = TaskCard({ task: TASK, onCheckedOff: function (t) { removed = t; } });

  let handler = null;
  walk(tree, function (n) { if (n.props && n.props.onAnimationEnd) handler = n.props.onAnimationEnd; });
  assert.ok(handler, 'no animationend handler was rendered');

  handler();
  assert.strictEqual(removed, TASK,
    'onCheckedOff is the only caller of removeMy/removeRow on the single '
    + 'check-off path; without it the row stays on screen until remount');
});

test('a row that is NOT checking off does not report itself checked off', () => {
  const { TaskCard } = loadTaskCard([false]);
  let removed = null;
  const tree = TaskCard({ task: TASK, onCheckedOff: function (t) { removed = t; } });

  let handler = null;
  walk(tree, function (n) { if (n.props && n.props.onAnimationEnd) handler = n.props.onAnimationEnd; });

  if (handler) handler();
  assert.strictEqual(removed, null,
    'an unrelated animation on the card must not drop the row');
});

/* ---------- the stylesheet, driven ------------------------------------ */

/* This is the guard that would have caught the original typo, and it is
   written to catch the NEXT one: every custom property referenced without a
   fallback must resolve to a definition. It reads the real files rather
   than a fixture, because the defect was that the two files disagreed. */
test('every custom property used without a fallback is actually defined', () => {
  const root = path.join(__dirname, '..', 'styles');
  const files = fs.readdirSync(root).filter(function (f) { return f.endsWith('.css'); });

  const defined = new Set();
  const usedNoFallback = new Map();   // token -> "file:line"

  files.forEach(function (f) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    text.split('\n').forEach(function (line, i) {
      const def = line.match(/^\s*(--[A-Za-z0-9-]+)\s*:/);
      if (def) defined.add(def[1]);
      /* var(--x) with NO comma before the closing paren = no fallback. */
      let m;
      const re = /var\(\s*(--[A-Za-z0-9-]+)\s*\)/g;
      while ((m = re.exec(line)) !== null) {
        if (!usedNoFallback.has(m[1])) usedNoFallback.set(m[1], f + ':' + (i + 1));
      }
    });
  });

  /* A scan that finds nothing also reports zero failures. */
  assert.ok(defined.size > 100,
    'expected to have parsed a real token file; found ' + defined.size + ' definitions');
  assert.ok(usedNoFallback.size > 20,
    'expected to have found real no-fallback var() uses; found ' + usedNoFallback.size);

  /* KNOWN AND DELIBERATELY NOT FIXED HERE. Each of these is a cosmetic
     fall-through -- a background that stays transparent, a font-size that
     inherits -- not dead behaviour, and repainting sixteen backgrounds was
     out of scope for the change that added this test. They are listed
     rather than waved through by a loose assertion, so that a NEW one
     fails and so the list itself records what is still owed.

     Shrinking this list is the fix. The second assertion below makes that
     shrinking mandatory rather than optional: define one of these and the
     test tells you to delete its line, so the list cannot rot into a
     description of a problem that no longer exists. */
  const KNOWN_UNDEFINED = [
    '--danger',
    '--font-weight-normal',
    '--surface-base',
    '--surface-hover',
    '--surface-panelMuted',
    '--surface-raised',
    '--surface-subtle',
    '--text-lg',
    '--text-sm',
    '--text-xs',
  ];

  const missing = [];
  usedNoFallback.forEach(function (where, token) {
    if (!defined.has(token) && KNOWN_UNDEFINED.indexOf(token) === -1) {
      missing.push(token + '  (' + where + ')');
    }
  });
  missing.sort();

  assert.deepStrictEqual(missing, [],
    'these custom properties are referenced with no fallback and never '
    + 'defined, so every declaration carrying one is invalid at '
    + 'computed-value time and silently drops to its initial value:\n  '
    + missing.join('\n  '));

  const nowDefined = KNOWN_UNDEFINED.filter(function (t) { return defined.has(t); });
  assert.deepStrictEqual(nowDefined, [],
    'these are defined now and must come OUT of KNOWN_UNDEFINED, or the list '
    + 'stops describing anything true:\n  ' + nowDefined.join('\n  '));
});

test('the check-off animation resolves to a real easing curve', () => {
  /* Newlines normalised: core.autocrlf=true flips these files between LF and
     CRLF, and a pattern spanning a line break must not depend on which. */
  const composites = readNormalised('composites.css');
  const tokens = readNormalised('tokens.css');

  const decl = composites.match(/\.fs-task-card--checking-off\s*\{[^}]*animation:\s*([^;]+);/);
  assert.ok(decl, 'the check-off animation declaration has moved or been removed');

  const refs = decl[1].match(/var\(\s*(--[A-Za-z0-9-]+)\s*\)/g) || [];
  refs.forEach(function (ref) {
    const name = ref.match(/(--[A-Za-z0-9-]+)/)[1];
    assert.match(tokens, new RegExp('^\\s*' + name + '\\s*:', 'm'),
      name + ' is referenced by the check-off animation but not defined in '
      + 'tokens.css -- animation-name computes to `none`, animationend never '
      + 'fires, and the row is never removed');
  });
});
