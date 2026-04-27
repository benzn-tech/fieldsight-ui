/* ==========================================================================
   FieldSight Badge — Layer 4 display atom
   --------------------------------------------------------------------------
   Tonal-not-loud by default. Subtle variant uses soft backgrounds (100/50
   shade) with dark text (700/800 shade). Solid variant (500 bg + white
   text) is reserved for critical/urgent states.

   Exported to:
     window.FieldSight.Badge
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function classNames() {
    return Array.prototype.slice.call(arguments).filter(Boolean).join(' ');
  }

  /* ---------- Badge -------------------------------------------------------- */
  function Badge(props) {
    var variant   = props.variant   || 'subtle';    // subtle | solid | outline
    var color     = props.color     || 'neutral';   // neutral | accent | danger | warning | success | info
    var size      = props.size      || 'md';        // sm | md | lg
    var dot       = props.dot       || false;        // show leading dot indicator
    var icon      = props.icon;                      // Lucide icon name (left)
    var className = props.className;
    var style     = props.style;
    var children  = props.children;

    var known = ['variant','color','size','dot','icon','className','style','children'];
    var rest = {};
    Object.keys(props).forEach(function(k) {
      if (known.indexOf(k) === -1) rest[k] = props[k];
    });

    var cls = classNames(
      'fs-badge',
      'fs-badge--' + variant,
      'fs-badge--' + color,
      'fs-badge--' + size,
      className
    );

    var NavIcon = window.FieldSight && window.FieldSight.NavIcon;
    var iconPx = size === 'sm' ? 10 : size === 'lg' ? 14 : 12;

    var badgeProps = Object.assign({}, rest, {
      className: cls,
      style: style,
    });

    return React.createElement('span', badgeProps,
      dot ? React.createElement('span', {
        className: 'fs-badge__dot',
        'aria-hidden': 'true',
      }) : null,
      icon && NavIcon ? React.createElement(NavIcon, {
        name: icon,
        size: iconPx,
        style: { flexShrink: 0 },
      }) : null,
      children != null ? React.createElement('span', {
        className: 'fs-badge__label',
      }, children) : null,
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.Badge = Badge;

})();
