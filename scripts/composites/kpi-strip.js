/* ==========================================================================
   FieldSight KpiStrip — Layer 5 composite
   --------------------------------------------------------------------------
   Horizontal flex container for StatCards. Each child takes equal
   width via flex:1 in CSS.

   Props:
     children   StatCard nodes
     compact    boolean, optional — one-line variant, Timeline day header only

   Exported to:
     window.FieldSight.KpiStrip
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function KpiStrip(props) {
    return React.createElement('div', {
      className: 'fs-kpi-strip' + (props.compact ? ' fs-kpi-strip--compact' : ''),
    }, props.children);
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.KpiStrip = KpiStrip;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { KpiStrip: KpiStrip };
  }
})();
