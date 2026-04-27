/* ==========================================================================
   FieldSight Avatar + AvatarGroup — Layer 4 display atom
   --------------------------------------------------------------------------
   Initials-first design. Image loads as an opportunistic layer on top.
   Color is generated deterministically from a string identifier so the
   same person always renders the same color, even when images fail.

   Exported to:
     window.FieldSight.Avatar
     window.FieldSight.AvatarGroup
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function classNames() {
    return Array.prototype.slice.call(arguments).filter(Boolean).join(' ');
  }

  /* Deterministic hue from a string — same input always same color */
  var AVATAR_HUES = [
    '#2563EB', '#7C3AED', '#DC2626', '#D97706', '#15803D',
    '#0891B2', '#9333EA', '#C2410C', '#4F46E5', '#059669',
    '#B91C1C', '#7E22CE', '#1D4ED8', '#CA8A04', '#0D9488',
    '#6D28D9',
  ];

  function colorFromString(str) {
    if (!str) return AVATAR_HUES[0];
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length];
  }

  function getInitials(name) {
    if (!name) return '?';
    return name
      .split(/\s+/)
      .map(function(w) { return w[0]; })
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  var SIZE_MAP = {
    xs: 24,
    sm: 28,
    md: 32,
    lg: 40,
    xl: 48,
  };

  var FONT_MAP = {
    xs: 10,
    sm: 11,
    md: 12,
    lg: 14,
    xl: 16,
  };

  /* ---------- Avatar ------------------------------------------------------- */
  function Avatar(props) {
    var name      = props.name;
    var initials  = props.initials;
    var src       = props.src;
    var alt       = props.alt;
    var size      = props.size      || 'md';        // xs | sm | md | lg | xl
    var shape     = props.shape     || 'circle';    // circle | square
    var colorSeed = props.colorSeed;                // string to derive color from (default: name)
    var color     = props.color;                    // explicit override
    var className = props.className;
    var style     = props.style;

    var known = ['name','initials','src','alt','size','shape','colorSeed',
                 'color','className','style'];
    var rest = {};
    Object.keys(props).forEach(function(k) {
      if (known.indexOf(k) === -1) rest[k] = props[k];
    });

    var displayInitials = initials || getInitials(name);
    var bgColor = color || colorFromString(colorSeed || name);
    var px = SIZE_MAP[size] || SIZE_MAP.md;
    var fontSize = FONT_MAP[size] || FONT_MAP.md;

    var imgLoaded = React.useRef(false);
    var imgError = React.useRef(false);
    var forceUpdate = React.useState(0)[1];

    // Reset img state when src changes
    React.useEffect(function() {
      imgLoaded.current = false;
      imgError.current = false;
    }, [src]);

    var cls = classNames(
      'fs-avatar',
      'fs-avatar--' + size,
      shape === 'square' && 'fs-avatar--square',
      className
    );

    var avatarProps = Object.assign({}, rest, {
      className: cls,
      style: Object.assign({
        width: px + 'px',
        height: px + 'px',
        backgroundColor: bgColor,
        fontSize: fontSize + 'px',
      }, style),
      'aria-label': name || alt || displayInitials,
      role: 'img',
    });

    return React.createElement('span', avatarProps,
      /* Initials — always present as fallback */
      React.createElement('span', {
        className: 'fs-avatar__initials',
        'aria-hidden': src ? 'true' : undefined,
      }, displayInitials),

      /* Image — loads on top of initials */
      src && !imgError.current ? React.createElement('img', {
        className: 'fs-avatar__img' + (imgLoaded.current ? ' fs-avatar__img--loaded' : ''),
        src: src,
        alt: alt || name || '',
        onLoad: function() {
          imgLoaded.current = true;
          forceUpdate(function(n) { return n + 1; });
        },
        onError: function() {
          imgError.current = true;
          forceUpdate(function(n) { return n + 1; });
        },
      }) : null,
    );
  }

  /* ---------- AvatarGroup -------------------------------------------------- */
  function AvatarGroup(props) {
    var max       = props.max       || 4;
    var size      = props.size      || 'md';
    var className = props.className;
    var style     = props.style;
    var children  = props.children;

    var items = React.Children.toArray(children);
    var visible = items.slice(0, max);
    var overflow = items.length - max;

    var px = SIZE_MAP[size] || SIZE_MAP.md;
    var fontSize = FONT_MAP[size] || FONT_MAP.md;

    var cls = classNames('fs-avatar-group', 'fs-avatar-group--' + size, className);

    return React.createElement('div', {
      className: cls,
      style: style,
      role: 'group',
      'aria-label': items.length + ' people',
    },
      visible.map(function(child, i) {
        return React.cloneElement(child, { key: i, size: size });
      }),
      overflow > 0 ? React.createElement('span', {
        className: 'fs-avatar fs-avatar--' + size + ' fs-avatar--overflow',
        style: {
          width: px + 'px',
          height: px + 'px',
          fontSize: (fontSize - 1) + 'px',
        },
        'aria-label': overflow + ' more',
      },
        React.createElement('span', { className: 'fs-avatar__initials' },
          '+' + overflow
        ),
      ) : null,
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.Avatar      = Avatar;
  window.FieldSight.AvatarGroup = AvatarGroup;

})();
