/* ==========================================================================
   FieldSight AppShell — React/createElement
   Exported to window.FieldSight.AppShell
   ========================================================================== */

/* global React, ReactDOM, window */

const STORAGE_KEYS = {
  middleWidth:  'fs.appshell.middleWidth',
  navCollapsed: 'fs.appshell.navCollapsed',
};

const MIDDLE_WIDTH_DEFAULT = 320;

/* ---------- Tiny inline weather indicator ------------------------------- */
/* Mock data for now — Sprint 2 wires the real API.
   Render only inside the MiddleColumn header utility area. */
function WeatherIndicator() {
  const t = window.FS.tokens;
  const NavIcon = window.FieldSight && window.FieldSight.NavIcon;

  /* Mock: 17°C, partly cloudy, light wind */
  const temp = 17;
  const condition = 'cloud-sun';
  const wind = '12 km/h';

  function handleClick() {
    console.log('[Weather] open detail panel (Sprint 2 wires this)');
  }

  return React.createElement('button', {
    type: 'button',
    onClick: handleClick,
    className: 'fs-utility-item',
    title: 'Site weather · ' + temp + '°C · ' + wind,
    'aria-label': 'Site weather, ' + temp + ' degrees, wind ' + wind,
  },
    NavIcon && React.createElement(NavIcon, {
      name: condition,
      size: 16,
    }),
    React.createElement('span', {
      className: 'fs-utility-item__text',
    }, temp + '°'),
  );
}
const MIDDLE_WIDTH_MIN     = 280;
const MIDDLE_WIDTH_MAX     = 480;

/* ---------- MiddleColumn -------------------------------------------------- */
function MiddleColumn({ route, width, onWidthChange }) {
  const t = window.FS.tokens;

  const routeLabel = (route || '/').replace(/^\//, '') || 'today';
  const title = routeLabel
    .split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

  const style = {
    width: width + 'px',
    background: t.surface.panel,
    borderRight: '1px solid ' + t.border.subtle,
  };

  const headerStyle = {
    height: '56px',
    display: 'flex',
    alignItems: 'center',
    padding: '0 20px',
    borderBottom: '1px solid ' + t.border.subtle,
    flexShrink: 0,
    gap: '12px',
  };

  const contentStyle = {
    flex: 1,
    overflowY: 'auto',
    padding: '24px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  };

  const placeholders = Array.from({ length: 6 }, function(_, i) { return i; });

  return React.createElement('div', { style: style, className: 'middle-column' },

    React.createElement('div', { style: headerStyle, className: 'middle-column__header' },
      React.createElement('span', {
        style: {
          fontWeight: t.typography.fontWeight.semibold,
          fontSize: t.typography.fontSize.base,
          color: t.text.primary,
          flex: 1,
        },
      }, title),

      /* Right-side utility area: weather + future bell etc. */
      React.createElement('div', { className: 'middle-column__utility' },
        React.createElement(WeatherIndicator),
      ),
    ),

    React.createElement('div', { style: contentStyle },
      React.createElement('p', {
        style: {
          fontSize: t.typography.fontSize.sm,
          color: t.text.tertiary,
          margin: '0 0 16px',
          padding: '12px 16px',
          background: t.surface.panelMuted,
          borderRadius: '8px',
          border: '1px dashed ' + t.border.subtle,
        },
      }, 'Sprint 1 placeholder — ' + title + ' content coming soon.'),

      placeholders.map(function(i) {
        return React.createElement('div', {
          key: i,
          style: {
            height: '64px',
            borderRadius: '8px',
            background: t.surface.panelMuted,
            border: '1px solid ' + t.border.subtle,
            flexShrink: 0,
          },
        });
      }),
    ),

    /* Drag handle on right edge — controlled by AppShell */
    window.FieldSight.DragDivider ? React.createElement(
      window.FieldSight.DragDivider,
      {
        value: width,
        onChange: onWidthChange,
        min: MIDDLE_WIDTH_MIN,
        max: MIDDLE_WIDTH_MAX,
        storageKey: STORAGE_KEYS.middleWidth,
        ariaLabel: 'Resize middle column',
      }
    ) : null,
  );
}

/* ---------- RightDetail --------------------------------------------------- */
function RightDetail() {
  const t = window.FS.tokens;

  const style = {
    background: t.surface.app,
    color: t.text.tertiary,
  };

  const iconWrapStyle = {
    width: '60px', height: '60px', borderRadius: '50%',
    background: t.surface.panel,
    border: '1px solid ' + t.border.subtle,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: t.shadow.sm,
  };

  return React.createElement('div', { style: style, className: 'right-detail' },
    React.createElement('div', { style: iconWrapStyle },
      window.FieldSight && window.FieldSight.NavIcon
        ? React.createElement(window.FieldSight.NavIcon, {
            name: 'panel-right-open',
            size: 28,
            color: t.text.disabled,
          })
        : null,
    ),
    React.createElement('div', {
      style: {
        fontWeight: t.typography.fontWeight.semibold,
        fontSize: t.typography.fontSize.base,
        color: t.text.secondary,
      },
    }, 'Select an item'),
    React.createElement('div', {
      style: {
        fontSize: t.typography.fontSize.sm,
        color: t.text.tertiary,
      },
    }, 'Choose from the list to view details'),
  );
}

/* ---------- AppShell ------------------------------------------------------ */
function AppShell({ showDevSwitcher = false }) {
  const dd = window.FieldSight.DragDivider;
  const lgBreakpoint = window.FS.tokens.breakpoint ? window.FS.tokens.breakpoint.lg : '64rem';

  const [user, setUser]   = React.useState(function() { return window.AuthMock.currentUser; });
  const [route, setRoute] = React.useState(function() { return window.FS.Router.getCurrentRoute().path; });

  /* Persisted nav-collapsed state */
  const [isCollapsed, setCollapsed] = React.useState(function() {
    var stored = dd ? dd.read(STORAGE_KEYS.navCollapsed, null) : null;
    if (stored === 1) return true;
    if (stored === 0) return false;
    return window.matchMedia('(max-width: ' + lgBreakpoint + ')').matches;
  });

  /* Persisted middle column width */
  const [middleWidth, setMiddleWidth] = React.useState(function() {
    return (dd && dd.read(STORAGE_KEYS.middleWidth, MIDDLE_WIDTH_DEFAULT)) || MIDDLE_WIDTH_DEFAULT;
  });

  React.useEffect(function() {
    return window.AuthMock.onChange(function(u) { setUser(Object.assign({}, u)); });
  }, []);

  React.useEffect(function() {
    return window.FS.Router.subscribe(function(r) { setRoute(r.path); });
  }, []);

  /* Redirect if user can't see the current route */
  React.useEffect(function() {
    var entries = Object.entries(window.FS.NAV_ITEMS);
    var found = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i][1].path === route) { found = entries[i][0]; break; }
    }
    if (found && !window.FS.canSeeNav(found, user)) {
      window.FS.Router.navigate(window.FS.getDefaultLanding(user));
    }
  }, [user, route]);

  /* Keyboard shortcut ⌘/Ctrl+B — ignored when typing in text fields */
  React.useEffect(function() {
    function onKey(e) {
      var target = e.target;
      var tag = target && target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleCollapse();
      }
    }
    window.addEventListener('keydown', onKey);
    return function() { window.removeEventListener('keydown', onKey); };
  });

  /* Auto-collapse on viewport changes — only if user has no stored preference */
  React.useEffect(function() {
    var mq = window.matchMedia('(max-width: ' + lgBreakpoint + ')');
    function onChange(e) {
      var stored = dd ? dd.read(STORAGE_KEYS.navCollapsed, null) : null;
      if (stored == null) setCollapsed(e.matches);
    }
    mq.addEventListener('change', onChange);
    return function() { mq.removeEventListener('change', onChange); };
  }, [lgBreakpoint]);

  function toggleCollapse() {
    setCollapsed(function(c) {
      var next = !c;
      if (dd) dd.write(STORAGE_KEYS.navCollapsed, next ? 1 : 0);
      return next;
    });
  }

  function navigate(path) {
    window.FS.Router.navigate(path);
  }

  var shellStyle = {
    background: window.FS.tokens.surface.app,
    fontFamily: window.FS.tokens.typography.fontFamily.sans,
    color: window.FS.tokens.text.primary,
  };

  return React.createElement('div', { style: shellStyle, className: 'app-shell' },

    React.createElement(window.FieldSight.LeftNav, {
      user: user,
      currentRoute: route,
      isCollapsed: isCollapsed,
      onToggleCollapse: toggleCollapse,
      onNavigate: navigate,
    }),

    React.createElement(MiddleColumn, {
      route: route,
      width: middleWidth,
      onWidthChange: setMiddleWidth,
    }),

    React.createElement(RightDetail),

    showDevSwitcher && window.FieldSight.DevRoleSwitcher
      ? React.createElement(window.FieldSight.DevRoleSwitcher)
      : null,
  );
}

/* ---------- Mount helper -------------------------------------------------- */
function mountAppShell(containerId, opts) {
  containerId = containerId || 'root';
  opts = opts || {};
  var el = document.getElementById(containerId);
  if (!el) { console.error('[AppShell] No element #' + containerId); return; }
  var root = ReactDOM.createRoot(el);
  root.render(React.createElement(AppShell, opts));
}

if (!window.FieldSight) window.FieldSight = {};
Object.assign(window.FieldSight, { AppShell: AppShell, MiddleColumn: MiddleColumn, RightDetail: RightDetail, mountAppShell: mountAppShell });
