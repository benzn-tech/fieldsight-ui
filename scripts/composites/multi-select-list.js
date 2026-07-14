/* ==========================================================================
   FieldSight useMultiSelect — Layer 5 composite
   --------------------------------------------------------------------------
   T4 — extracted from feat/leftover-batch-select (T1), which shipped
   batchMode + Shift/Ctrl range-select + anchor tracking inline inside
   Today's Leftover section (scripts/pages/today.js). This is the SAME
   logic, moved to one place so /today (Leftover), /safety, and /quality
   share exactly one implementation instead of three copies. Today's
   behavior is unchanged by this extraction (today.js was refactored to
   consume this hook, not redesigned).

   window.FieldSight.useMultiSelect({ items, getId })

     items   Array — the CURRENTLY RENDERED items, in on-screen order.
             Shift-range selection walks THIS array's order/index, so
             pass the same order you render (e.g. today.js's
             leftoverItems, or a page's flattened, already-filtered/
             sorted row list). Read fresh every render — no memoisation,
             so a changed filter/sort/page is picked up immediately.
     getId   (item) => id, optional — defaults to `item.id`.

   Returns:
     batchMode      boolean — off by default.
     setBatchMode   (next: boolean | (prev:boolean)=>boolean) — same
                    calling convention as React's setState. Turning OFF
                    (resolved value === false) clears selectedIds AND the
                    Shift-anchor — a stale selection/anchor has no
                    meaning once selecting turns off (mirrors Today's
                    T1 toggleBatchMode exactly).
     selectedIds    { [id]: true } map — O(1) toggle/lookup, the idiom
                    already used elsewhere in this codebase (myIds,
                    onSiteById, ...).
     onItemClick(item, evt) — the mode+Shift/Ctrl+anchor dispatcher
                    (Today's T1 onBatchToggle, unchanged in behavior):
                      evt.shiftKey        → range-select from the anchor
                                            to item, contiguous in
                                            `items`' CURRENT order (adds
                                            the whole slice; anchor stays
                                            put so a repeat Shift+Click
                                            re-ranges cleanly — file-
                                            explorer idiom).
                      evt.ctrlKey/metaKey → toggle only this item, anchor
                                            untouched.
                      plain click         → toggle this item AND set it
                                            as the new anchor.
                    No-op when batchMode is false, so callers can wire
                    this unconditionally without an `if (batchMode)`
                    guard at the call site.
     selectedItems  Array — `items` filtered to selectedIds, in `items`'
                    order. A stale id (an item that resolved/was removed
                    elsewhere, e.g. via the actionsBus) silently drops
                    out instead of over-counting or crashing a lookup.
     clear()        Clears selectedIds ONLY — anchor untouched. Mirrors
                    Today's T1 "Clear" bulk-bar button, deliberately
                    distinct from setBatchMode(false) (which clears
                    both).

   Two extras beyond that 6-field spec, added (not substituted) because
   Today's existing bulk-bar behavior needs them and the brief's "keep
   bulkResolveLeftover untouched" constraint means the hook has to carry
   the weight instead of the page reinventing selection internals:
     selectAll()       Selects every id in `items` — Today's "Select
                        all" bulk-bar button.
     setSelectedIds     Raw passthrough setState setter — Today's
                        bulkResolveLeftover needs to drop only the
                        SUCCEEDED ids after a partial-failure pooled
                        toggleAction batch (failed ones stay selected
                        for retry), which isn't expressible through
                        clear()/selectAll() alone.

   Exported to:
     window.FieldSight.useMultiSelect
     window.FieldSight.MultiSelectBulkBar  (optional shared bulk-bar UI)
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function defaultGetId(item) {
    return item && item.id;
  }

  function useMultiSelect(opts) {
    opts = opts || {};
    var items = opts.items || [];
    var getId = opts.getId || defaultGetId;

    var modeRef          = React.useState(false);
    var batchMode        = modeRef[0];
    var setBatchModeRaw  = modeRef[1];

    var selRef            = React.useState({});
    var selectedIds       = selRef[0];
    var setSelectedIdsRaw = selRef[1];

    var anchorRef    = React.useState(null);
    var anchorId     = anchorRef[0];
    var setAnchorId  = anchorRef[1];

    /* Turning OFF clears both selectedIds and the anchor — same
       semantics as Today's T1 toggleBatchMode. Accepts either a bare
       boolean or a React-style updater function so callers can do
       setBatchMode(v => !v) same as before. */
    function setBatchMode(next) {
      setBatchModeRaw(function (prev) {
        var resolved = typeof next === 'function' ? next(prev) : next;
        if (!resolved) {
          setSelectedIdsRaw({});
          setAnchorId(null);
        }
        return resolved;
      });
    }

    function toggleOne(item) {
      var id = getId(item);
      setSelectedIdsRaw(function (prev) {
        var next = Object.assign({}, prev);
        if (next[id]) { delete next[id]; } else { next[id] = true; }
        return next;
      });
    }

    function onItemClick(item, evt) {
      if (!batchMode) return;
      var id         = getId(item);
      var shift      = !!(evt && evt.shiftKey);
      var ctrlOrMeta = !!(evt && (evt.ctrlKey || evt.metaKey));

      if (shift && anchorId != null) {
        var ids     = items.map(getId);
        var fromIdx = ids.indexOf(anchorId);
        var toIdx   = ids.indexOf(id);
        if (fromIdx !== -1 && toIdx !== -1) {
          var lo = Math.min(fromIdx, toIdx);
          var hi = Math.max(fromIdx, toIdx);
          var rangeIds = ids.slice(lo, hi + 1);
          setSelectedIdsRaw(function (prev) {
            var next = Object.assign({}, prev);
            rangeIds.forEach(function (rid) { next[rid] = true; });
            return next;
          });
          return;
        }
        /* Anchor no longer in the rendered items (e.g. it resolved and
           dropped out) — fall through to plain toggle+re-anchor below. */
      }

      if (ctrlOrMeta) {
        toggleOne(item);
        return;
      }

      toggleOne(item);
      setAnchorId(id);
    }

    function clear() {
      setSelectedIdsRaw({});
    }

    function selectAll() {
      setSelectedIdsRaw(function () {
        var next = {};
        items.forEach(function (it) { next[getId(it)] = true; });
        return next;
      });
    }

    var selectedItems = items.filter(function (it) { return !!selectedIds[getId(it)]; });

    return {
      batchMode:      batchMode,
      setBatchMode:   setBatchMode,
      selectedIds:    selectedIds,
      onItemClick:    onItemClick,
      selectedItems:  selectedItems,
      clear:          clear,
      selectAll:      selectAll,
      setSelectedIds: setSelectedIdsRaw,
    };
  }

  /* ---------- MultiSelectBulkBar — optional shared presentational piece
     -----------------------------------------------------------------
     Renders the "N selected [actions...]" bar Today's T1 Leftover
     section shipped first, generalized so /safety and /quality (T4)
     reuse the same markup/classes instead of hand-rolling their own.
     Not a hook — plain props in, JSX out.

     Props:
       count    number — shown as "N selected".
       actions  [{ key, label, onClick, disabled, primary }] — rendered
                left-to-right as buttons. `primary` paints the filled
                accent variant (.fs-multi-select__bulk-bar-btn--primary).
   */
  function MultiSelectBulkBar(props) {
    var count   = props.count || 0;
    var actions = props.actions || [];
    return React.createElement('div', { className: 'fs-multi-select__bulk-bar' },
      React.createElement('span', { className: 'fs-multi-select__bulk-bar-count' },
        count + ' selected'),
      React.createElement('div', { className: 'fs-multi-select__bulk-bar-actions' },
        actions.map(function (a) {
          return React.createElement('button', {
            key:       a.key,
            type:      'button',
            className: 'fs-multi-select__bulk-bar-btn'
              + (a.primary ? ' fs-multi-select__bulk-bar-btn--primary' : ''),
            onClick:   a.onClick,
            disabled:  !!a.disabled,
          }, a.label);
        }),
      ),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.useMultiSelect = useMultiSelect;
  window.FieldSight.MultiSelectBulkBar = MultiSelectBulkBar;
})();
