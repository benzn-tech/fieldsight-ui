'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = { FieldSight: {} };
global.React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) };

const { KpiStrip } = require('../scripts/composites/kpi-strip.js');

test('KpiStrip without compact keeps the base class only', () => {
  assert.strictEqual(KpiStrip({ children: [] }).props.className, 'fs-kpi-strip');
});

test('KpiStrip compact appends the modifier class', () => {
  assert.strictEqual(KpiStrip({ compact: true, children: [] }).props.className,
    'fs-kpi-strip fs-kpi-strip--compact');
});

/* SOURCE SCAN (wiring pin). Both ReportKpis mounts render through the single
   KpiStrip call inside ReportKpis, which must pass compact. No other KpiStrip
   mount under scripts/ passes it. */
const root = path.join(__dirname, '..', 'scripts');
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const timeline = src('pages/timeline.js');

test('ReportKpis passes compact:true to KpiStrip, and ReportKpis is mounted twice', () => {
  const start = timeline.indexOf('function ReportKpis(');
  const end = timeline.indexOf('\n  }\n', start);
  assert.ok(start > 0 && end > start);
  assert.match(timeline.slice(start, end), /createElement\(KpiStrip,\s*\{\s*compact:\s*true\s*\}/);
  assert.strictEqual((timeline.match(/createElement\(ReportKpis,/g) || []).length, 2);
});

test('no other KpiStrip mount in scripts/ passes compact', () => {
  const offenders = fs.readdirSync(root, { recursive: true })
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => f.endsWith('.js') && f !== 'composites/kpi-strip.js')
    .filter((f) => {
      const n = (src(f).match(/createElement\(KpiStrip,\s*\{[^}]*compact/g) || []).length;
      return f === 'pages/timeline.js' ? n !== 1 : n > 0;
    });
  assert.deepStrictEqual(offenders, []);
});

/* SOURCE SCAN (wiring pin). The compact strip's 6px gap must survive the
   `@media (max-width: 47.9375rem)` block, where `.fs-kpi-strip { gap: 8px }`
   (equal-specificity, later in source order) would otherwise win and silently
   revert the mobile gap to 8px. This requires EITHER the base compact gap
   rule to be scoped at equal-or-higher specificity than plain `.fs-kpi-strip`
   (`.fs-kpi-strip.fs-kpi-strip--compact`, not bare `.fs-kpi-strip--compact`),
   OR a compact-gap rule declared inside the mobile media block itself. */
const cssPath = path.join(__dirname, '..', 'styles', 'composites.css');
const css = fs.readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');

test('compact strip gap survives the mobile media query', () => {
  const hasHighSpecificityBaseRule =
    /\.fs-kpi-strip\.fs-kpi-strip--compact\s*\{[^}]*gap:\s*6px/.test(css);

  const mobileBlockStart = css.indexOf('@media (max-width: 47.9375rem)');
  assert.ok(mobileBlockStart > 0, 'expected the /today mobile media query to exist');
  const mobileBlockEnd = css.indexOf('\n}\n', mobileBlockStart);
  const mobileBlock = css.slice(mobileBlockStart, mobileBlockEnd);
  const hasMobileCompactGapRule =
    /\.fs-kpi-strip(?:\.fs-kpi-strip--compact|--compact)[^{]*\{[^}]*gap:\s*6px/.test(mobileBlock);

  assert.ok(
    hasHighSpecificityBaseRule || hasMobileCompactGapRule,
    'compact gap (6px) must be declared with selector specificity that beats ' +
    '`.fs-kpi-strip { gap: 8px }` inside the mobile media query, or be re-declared ' +
    'inside that media query'
  );
});
