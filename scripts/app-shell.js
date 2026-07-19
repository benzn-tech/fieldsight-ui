/* ==========================================================================
   FieldSight AppShell — React/createElement
   Exported to window.FieldSight.AppShell
   ========================================================================== */

/* global React, ReactDOM, window */

const STORAGE_KEYS = {
  middleWidth:  'fs.appshell.middleWidth',
  navCollapsed: 'fs.appshell.navCollapsed',
  theme:        'fs.settings.theme',
  density:      'fs.settings.density',
};

const MIDDLE_WIDTH_DEFAULT = 320;

/* ---------- Mobile bottom-nav item icons (mirrors NAV_ICONS in left-nav.js) */
const NAV_ICONS_BOTTOM = {
  today:     'calendar-check',
  timeline:  'gantt-chart',
  tasks:     'check-square',
  safety:    'shield-alert',
  programme: 'gantt-chart',
  quality:   'badge-check',
  evidence:  'folder-open',
  reports:   'file-text',
  insights:  'bar-chart-3',
  sites:     'map-pin',
  team:      'users',
  activity:  'activity',
  settings:  'settings',
  portfolio: 'layout-dashboard',
  regional:  'map',
  executive: 'briefcase',
};

/* ---------- BottomNav (mobile only — rendered by AppShell) -------------- */
/* Top 5 visible nav items shown as tabs; remainder accessible via More drawer. */
function BottomNav({ user, currentRoute, onNavigate }) {
  const NavIcon   = window.FieldSight && window.FieldSight.NavIcon;
  const [moreOpen, setMoreOpen] = React.useState(false);

  const visibleItems = (window.FS.getVisibleNavItems ? window.FS.getVisibleNavItems(user) : [])
    .filter(function (i) { return i.key !== 'settings'; });

  const primary = visibleItems.slice(0, 4);
  const overflow = visibleItems.slice(4);
  const anyOverflowActive = overflow.some(function (i) { return i.path === currentRoute; });

  function closeMore() { setMoreOpen(false); }

  /* Sprint 8 follow-up — wrap entire bottom-nav stack (sheet + backdrop +
     bar) in a single portal div so we can hide the whole thing on desktop
     via one CSS rule. The previous Fragment leaked `__more-sheet` content
     into desktop layout in some cases (Programme item showing below
     Settings). One container = one display toggle. */
  return React.createElement('div', { className: 'fs-bottom-nav-portal' },
    /* Backdrop for more-sheet */
    React.createElement('div', {
      className: 'fs-bottom-nav__more-sheet-backdrop' + (moreOpen ? ' fs-bottom-nav__more-sheet-backdrop--open' : ''),
      onClick:   closeMore,
      'aria-hidden': true,
    }),

    /* More sheet */
    React.createElement('div', {
      className:    'fs-bottom-nav__more-sheet' + (moreOpen ? ' fs-bottom-nav__more-sheet--open' : ''),
      role:         'menu',
      'aria-label': 'More navigation items',
    },
      overflow.map(function (item) {
        var active = currentRoute === item.path;
        return React.createElement('button', {
          key:          item.key,
          type:         'button',
          className:    'fs-bottom-nav__more-item' + (active ? ' fs-bottom-nav__more-item--active' : ''),
          role:         'menuitem',
          onClick:      function () { onNavigate(item.path); closeMore(); },
        },
          NavIcon ? React.createElement(NavIcon, {
            name: NAV_ICONS_BOTTOM[item.key] || 'circle',
            size: 18,
            color: active ? 'var(--color-accent-500)' : 'rgba(255,255,255,0.65)',
          }) : null,
          item.label,
        );
      }),
    ),

    /* Bottom tab bar */
    React.createElement('nav', {
      className:    'fs-bottom-nav',
      role:         'navigation',
      'aria-label': 'Main navigation',
    },
      primary.map(function (item) {
        var active = currentRoute === item.path;
        return React.createElement('button', {
          key:          item.key,
          type:         'button',
          className:    'fs-bottom-nav__item' + (active ? ' fs-bottom-nav__item--active' : ''),
          'aria-label': item.label,
          'aria-current': active ? 'page' : undefined,
          onClick:      function () { onNavigate(item.path); },
        },
          NavIcon ? React.createElement(NavIcon, {
            name: NAV_ICONS_BOTTOM[item.key] || 'circle',
            size: 20,
            color: active ? 'var(--color-accent-500)' : 'rgba(255,255,255,0.55)',
          }) : null,
          React.createElement('span', null, item.label),
        );
      }),

      /* More button — only if there are overflow items */
      overflow.length > 0
        ? React.createElement('button', {
            type:         'button',
            className:    'fs-bottom-nav__item' + (anyOverflowActive ? ' fs-bottom-nav__item--active' : ''),
            'aria-label': 'More navigation items',
            'aria-expanded': moreOpen,
            onClick:      function () { setMoreOpen(function (o) { return !o; }); },
          },
            NavIcon ? React.createElement(NavIcon, {
              name: 'more-horizontal',
              size: 20,
              color: anyOverflowActive ? 'var(--color-accent-500)' : 'rgba(255,255,255,0.55)',
            }) : null,
            React.createElement('span', null, 'More'),
          )
        : null,
    ),
  );
}

/* ---------- Weather: WMO weathercode → {icon, label} -------------------
   Open-Meteo returns a numeric WMO 4677 weather code (both the archive
   and forecast APIs). Icon names are lucide keys (see NavIcon in
   left-nav.js — kebab-case, converted to PascalCase at render time). */
const WMO_WEATHER_CODES = {
  0:  { icon: 'sun',             label: 'Clear sky' },
  1:  { icon: 'cloud-sun',       label: 'Mainly clear' },
  2:  { icon: 'cloud-sun',       label: 'Partly cloudy' },
  3:  { icon: 'cloud',           label: 'Overcast' },
  45: { icon: 'cloud-fog',       label: 'Fog' },
  48: { icon: 'cloud-fog',       label: 'Depositing rime fog' },
  51: { icon: 'cloud-drizzle',   label: 'Light drizzle' },
  53: { icon: 'cloud-drizzle',   label: 'Moderate drizzle' },
  55: { icon: 'cloud-drizzle',   label: 'Dense drizzle' },
  56: { icon: 'cloud-drizzle',   label: 'Light freezing drizzle' },
  57: { icon: 'cloud-drizzle',   label: 'Dense freezing drizzle' },
  61: { icon: 'cloud-rain',      label: 'Slight rain' },
  63: { icon: 'cloud-rain',      label: 'Moderate rain' },
  65: { icon: 'cloud-rain',      label: 'Heavy rain' },
  66: { icon: 'cloud-rain',      label: 'Light freezing rain' },
  67: { icon: 'cloud-rain',      label: 'Heavy freezing rain' },
  71: { icon: 'cloud-snow',      label: 'Slight snow' },
  73: { icon: 'cloud-snow',      label: 'Moderate snow' },
  75: { icon: 'cloud-snow',      label: 'Heavy snow' },
  77: { icon: 'cloud-snow',      label: 'Snow grains' },
  80: { icon: 'cloud-rain',      label: 'Slight showers' },
  81: { icon: 'cloud-rain',      label: 'Moderate showers' },
  82: { icon: 'cloud-rain',      label: 'Violent showers' },
  85: { icon: 'cloud-snow',      label: 'Slight snow showers' },
  86: { icon: 'cloud-snow',      label: 'Heavy snow showers' },
  95: { icon: 'cloud-lightning', label: 'Thunderstorm' },
  96: { icon: 'cloud-lightning', label: 'Thunderstorm, slight hail' },
  99: { icon: 'cloud-lightning', label: 'Thunderstorm, heavy hail' },
};
function wmoLookup(code) {
  return WMO_WEATHER_CODES[code] || { icon: 'cloud', label: 'Unknown' };
}

/* sb1108-ellesmere (Christchurch) — sensible NZ fallback when there is no
   active site (siteContext) or the active site has no `coord` yet. Mirrors
   the value on that fixture in scripts/mock/sites.fixture.js. */
/* Wind bearing (degrees) → 16-point compass label, e.g. 214 → 'SW'.
   Open-Meteo gives current_weather.winddirection / daily
   winddirection_10m_dominant in meteorological degrees (from which the wind
   blows). '' when unknown so the caller can omit it. */
const _WX_COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                     'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function degToCompass(deg) {
  if (deg == null || isNaN(deg)) return '';
  return _WX_COMPASS[Math.round(Number(deg) / 22.5) % 16];
}

/* BUG-19-safe date/time formatting for the forecast strips. Open-Meteo
   returns Pacific/Auckland-local ISO strings (hourly 'YYYY-MM-DDTHH:MM',
   daily 'YYYY-MM-DD'); parse by slicing / UTC arithmetic, never
   new Date('YYYY-MM-DD') (which drifts a day in NZ). */
const _WX_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _WX_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function _wxHourLabel(iso) {
  const h = parseInt(String(iso).slice(11, 13), 10);
  if (isNaN(h)) return '';
  const h12 = (h % 12) || 12;
  return h12 + (h < 12 ? 'am' : 'pm');
}
function _wxDayName(iso) {
  const p = String(iso).slice(0, 10).split('-');
  if (p.length !== 3) return '';
  return _WX_DAYS[new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay()];
}
function _wxDayDate(iso) {
  const p = String(iso).slice(0, 10).split('-');
  if (p.length !== 3) return '';
  return (+p[2]) + ' ' + _WX_MONTHS[(+p[1]) - 1];
}

const WEATHER_DEFAULT_COORD = { lat: -43.5321, lng: 172.6362 };

/* site_id -> { lat, lng } | null, filled once from the org API (real Aurora
   coordinates, now that the site record carries latitude/longitude). null = a
   resolved site that has no coordinate yet (un-backfilled) -> caller falls back
   to fixture coord / default. */
const orgSiteCoordCache = {};

/* Module-level cache: `${lat},${lng},${date},${h|r}` → { data, ts }.
   Cheap insurance against refetch storms (route/site churn while a
   popover is open, StrictMode double-invoke, etc). Historical ('h')
   entries are cached indefinitely — the past doesn't change. Realtime
   ('r') entries get a TTL below (Minor B, Fable review) so an all-day-open
   tab doesn't keep showing the morning temperature. */
const weatherFetchCache = {};
const WEATHER_REALTIME_TTL_MS = 10 * 60 * 1000; // 10 minutes

/* ---------- Weather Indicator + Popover -------------------------------- */
/* Click reveals a popover with current/selected-date conditions, next 12h
   hourly, and a 7-day daily forecast. The headline indicator follows the
   selected date (route ?date=) and active site (FS.siteContext) via a
   plain fetch() against Open-Meteo (no key, no Cognito):
     - selectedDate < today (NZDT)   → archive API (historical daily)
     - today / future / no date     → forecast API (current_weather)
   Falls back to the static MockData.WEATHER fixture on fetch failure or
   when no coordinates are available, so the indicator never disappears
   or crashes the shell. */
function WeatherIndicator() {
  const NavIcon = window.FieldSight && window.FieldSight.NavIcon;
  const mockWeather = window.FieldSight.MockData
    ? window.FieldSight.MockData.WEATHER
    : null;

  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);

  /* Close on outside click */
  React.useEffect(function() {
    if (!open) return;
    function onClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return function() { document.removeEventListener('mousedown', onClick); };
  }, [open]);

  /* Close on Escape */
  React.useEffect(function() {
    if (!open) return;
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('keydown', onKey);
    return function() { document.removeEventListener('keydown', onKey); };
  }, [open]);

  /* Selected date — from the route's ?date= param (e.g. /timeline?date=
     2026-04-10). Router.subscribe() already wraps 'hashchange' and emits
     synchronously on subscribe, so this doubles as the initial read. */
  const [routeParams, setRouteParams] = React.useState(function() {
    return (window.FS && window.FS.Router) ? window.FS.Router.getCurrentRoute().params : {};
  });
  React.useEffect(function() {
    if (!(window.FS && window.FS.Router)) return undefined;
    return window.FS.Router.subscribe(function(r) { setRouteParams(r.params || {}); });
  }, []);

  /* Active site — FS.siteContext, same pub/sub the header project
     selector uses. */
  const [activeSiteId, setActiveSiteId] = React.useState(function() {
    return (window.FS && window.FS.siteContext) ? window.FS.siteContext.get() : null;
  });
  React.useEffect(function() {
    if (!(window.FS && window.FS.siteContext)) return undefined;
    return window.FS.siteContext.onChange(function(siteId) { setActiveSiteId(siteId); });
  }, []);

  /* BUG-19: never new Date('YYYY-MM-DD') (UTC drift in NZ) — string
     compare 'YYYY-MM-DD' dates directly, and use FS.api.todayNZDT(). */
  const todayISO = (window.FS && window.FS.api) ? window.FS.api.todayNZDT() : null;
  const selectedDate = routeParams.date || todayISO;
  const isHistorical = !!(todayISO && selectedDate && selectedDate < todayISO);

  const sitesList = (window.FieldSight.fixtures && window.FieldSight.fixtures.sites
    && window.FieldSight.fixtures.sites.sites) || [];
  const fixtureSite = activeSiteId
    ? sitesList.find(function(s) { return s.site_id === activeSiteId; })
    : null;

  /* Real Aurora coordinate for the active site, fetched once from the org API
     (spec §3.6). Falls back to the fixture coord, then the NZ default, so the
     indicator never disappears (BUG-20-safe: getOrgSites uses the guarded
     org request; a non-JSON SPA-shell 200 resolves to _notFound, not a crash). */
  const [siteCoord, setSiteCoord] = React.useState(function() {
    return activeSiteId ? orgSiteCoordCache[activeSiteId] || null : null;
  });
  React.useEffect(function() {
    if (!activeSiteId) { setSiteCoord(null); return undefined; }
    if (orgSiteCoordCache[activeSiteId] !== undefined) {
      setSiteCoord(orgSiteCoordCache[activeSiteId]);
      return undefined;
    }
    if (!(window.FS && window.FS.api && window.FS.api.org
          && window.FS.api.org.getOrgSites)) { return undefined; }
    let cancelled = false;
    window.FS.api.org.getOrgSites().then(function(res) {
      const list = (res && res.sites) || [];
      list.forEach(function(s) {
        if (s && s.site_id && s.latitude != null && s.longitude != null) {
          orgSiteCoordCache[s.site_id] = { lat: s.latitude, lng: s.longitude };
        }
      });
      if (orgSiteCoordCache[activeSiteId] === undefined) {
        orgSiteCoordCache[activeSiteId] = null;  // resolved: this site has no coord
      }
      if (!cancelled) setSiteCoord(orgSiteCoordCache[activeSiteId]);
    }).catch(function() { if (!cancelled) setSiteCoord(null); });
    return function() { cancelled = true; };
  }, [activeSiteId]);

  const coord = siteCoord
    || (fixtureSite && fixtureSite.coord)
    || WEATHER_DEFAULT_COORD;

  /* status: 'loading' | 'success' | 'error' */
  const [liveState, setLiveState] = React.useState({ status: 'loading', data: null });

  React.useEffect(function() {
    if (!coord || !selectedDate) { setLiveState({ status: 'error', data: null }); return undefined; }

    const cacheKey = coord.lat + ',' + coord.lng + ',' + selectedDate + ',' + (isHistorical ? 'h' : 'r');
    const cached = weatherFetchCache[cacheKey];
    /* Minor B (Fable review) — historical entries are always fresh (the
       past doesn't change); realtime entries go stale after the TTL so a
       long-open tab refetches instead of showing the morning temperature
       all day. */
    if (cached && (isHistorical || (Date.now() - cached.ts) < WEATHER_REALTIME_TTL_MS)) {
      setLiveState({ status: 'success', data: cached.data });
      return undefined;
    }

    let cancelled = false;
    setLiveState({ status: 'loading', data: null });

    const url = isHistorical
      ? 'https://archive-api.open-meteo.com/v1/archive?latitude=' + coord.lat
        + '&longitude=' + coord.lng + '&start_date=' + selectedDate
        + '&end_date=' + selectedDate
        + '&daily=temperature_2m_max,temperature_2m_min,weathercode,windspeed_10m_max,winddirection_10m_dominant'
        + '&timezone=Pacific/Auckland'
      : 'https://api.open-meteo.com/v1/forecast?latitude=' + coord.lat
        + '&longitude=' + coord.lng + '&current_weather=true'
        + '&hourly=temperature_2m,weathercode,winddirection_10m'
        + '&daily=temperature_2m_max,temperature_2m_min,weathercode,windspeed_10m_max,winddirection_10m_dominant'
        + '&forecast_days=7&timezone=Pacific/Auckland';

    fetch(url)
      .then(function(res) {
        if (!res.ok) throw new Error('weather http ' + res.status);
        return res.json();
      })
      .then(function(json) {
        if (cancelled) return;
        let result;
        if (isHistorical) {
          const daily = json && json.daily;
          if (!daily || !Array.isArray(daily.weathercode) || daily.weathercode.length === 0
              || daily.weathercode[0] == null) {
            throw new Error('no historical data');
          }
          const wmo = wmoLookup(daily.weathercode[0]);
          result = {
            temp:           Math.round(daily.temperature_2m_max[0]),
            tempLow:        Math.round(daily.temperature_2m_min[0]),
            condition:      wmo.icon,
            conditionLabel: wmo.label,
            wind:           Math.round(daily.windspeed_10m_max[0]) + ' km/h',
            windDir:        degToCompass(daily.winddirection_10m_dominant && daily.winddirection_10m_dominant[0]),
            humidity:       null,
            hourly:         [],   /* forecast strips are forward-looking; a past date has none */
            daily:          [],
            tag:            'Historical · ' + selectedDate,
          };
        } else {
          const cw = json && json.current_weather;
          if (!cw || cw.temperature == null) throw new Error('no realtime data');
          const wmo = wmoLookup(cw.weathercode);
          /* Next-12h strip from json.hourly, starting at the current hour
             (string-compare the 'YYYY-MM-DDTHH' prefix — BUG-19 safe). */
          const _h = (json && json.hourly) || {};
          const _htimes = _h.time || [];
          const _nowKey = String(cw.time || '').slice(0, 13);
          let _start = 0;
          for (let _i = 0; _i < _htimes.length; _i++) {
            if (String(_htimes[_i]).slice(0, 13) >= _nowKey) { _start = _i; break; }
          }
          const _hourly = [];
          for (let _j = _start; _j < Math.min(_start + 12, _htimes.length); _j++) {
            _hourly.push({
              hour: _wxHourLabel(_htimes[_j]),
              condition: wmoLookup(_h.weathercode && _h.weathercode[_j]).icon,
              temp: Math.round(_h.temperature_2m[_j]),
            });
          }
          /* 7-day strip from json.daily. */
          const _d = (json && json.daily) || {};
          const _dtimes = _d.time || [];
          const _daily = [];
          for (let _k = 0; _k < _dtimes.length; _k++) {
            _daily.push({
              day: _wxDayName(_dtimes[_k]),
              date: _wxDayDate(_dtimes[_k]),
              condition: wmoLookup(_d.weathercode && _d.weathercode[_k]).icon,
              high: Math.round(_d.temperature_2m_max[_k]),
              low: Math.round(_d.temperature_2m_min[_k]),
            });
          }
          result = {
            temp:           Math.round(cw.temperature),
            condition:      wmo.icon,
            conditionLabel: wmo.label,
            wind:           Math.round(cw.windspeed) + ' km/h',
            windDir:        degToCompass(cw.winddirection),
            humidity:       null,
            hourly:         _hourly,
            daily:          _daily,
            tag:            'Live',
          };
        }
        weatherFetchCache[cacheKey] = { data: result, ts: Date.now() };
        setLiveState({ status: 'success', data: result });
      })
      .catch(function() {
        if (!cancelled) setLiveState({ status: 'error', data: null });
      });

    return function() { cancelled = true; };
  }, [coord.lat, coord.lng, selectedDate, isHistorical]);

  /* Resolve what to actually render: live result, else the mock fixture
     (tag-less — mock has no historical/realtime distinction), else
     nothing while a first fetch is in flight. */
  const display = liveState.status === 'success'
    ? liveState.data
    : (liveState.status === 'error' && mockWeather)
      ? Object.assign({ tag: null }, mockWeather.current)
      : null;

  const loading = liveState.status === 'loading' && !display;

  if (!display && !loading) return null;

  return React.createElement('div', {
    ref: wrapRef,
    style: { position: 'relative', display: 'inline-block' },
  },
    React.createElement('button', {
      type: 'button',
      onClick: function() { if (display) setOpen(function(o) { return !o; }); },
      className: 'fs-utility-item' + (open ? ' fs-utility-item--active' : ''),
      disabled: !display,
      title: display
        ? ('Site weather · ' + display.temp + '°C · ' + display.wind + (display.tag ? ' · ' + display.tag : ''))
        : 'Loading weather…',
      'aria-label': display ? ('Site weather, ' + display.temp + ' degrees') : 'Loading weather',
      'aria-expanded': open,
    },
      loading
        ? React.createElement('span', { className: 'fs-weather-indicator__spinner', 'aria-hidden': 'true' })
        : [
            NavIcon && React.createElement(NavIcon, { key: 'icon', name: display.condition, size: 16 }),
            React.createElement('span', { key: 'text', className: 'fs-utility-item__text' },
              display.temp + '°'),
          ],
    ),

    (open && display) ? React.createElement(WeatherPopover, {
      current: display,
      hourly: (display && display.hourly) || (mockWeather && mockWeather.hourly) || [],
      daily: (display && display.daily) || (mockWeather && mockWeather.daily) || [],
      onClose: function() { setOpen(false); },
    }) : null,
  );
}

/* ---------- Weather popover content ----------------------------------- */
/* `current`/`hourly`/`daily` are all live Open-Meteo forecast data now
   (current_weather + hourly[next 12h] + daily[7d], with wind direction),
   or the static mock fixture on a fetch failure. `hourly`/`daily` are empty
   on a historical date (forward-looking strips don't apply) and self-hide. */
function WeatherPopover(props) {
  const NavIcon = window.FieldSight && window.FieldSight.NavIcon;
  const Badge = window.FieldSight && window.FieldSight.Badge;
  const current = props.current;

  return React.createElement('div', {
    className: 'fs-weather-popover',
    role: 'dialog',
    'aria-label': 'Weather forecast',
  },

    /* Current */
    React.createElement('div', { className: 'fs-weather-popover__current' },
      React.createElement('div', { className: 'fs-weather-popover__current-icon' },
        NavIcon && React.createElement(NavIcon, { name: current.condition, size: 36 }),
      ),
      React.createElement('div', null,
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          React.createElement('span', { className: 'fs-weather-popover__current-temp' },
            current.temp + '°'),
          (current.tag && Badge) ? React.createElement(Badge, {
            tone: 'neutral', variant: 'subtle', size: 'sm', pill: true,
          }, current.tag) : null,
        ),
        React.createElement('div', { className: 'fs-weather-popover__current-label' },
          current.conditionLabel),
        React.createElement('div', { className: 'fs-weather-popover__current-meta' },
          'Wind ' + current.wind
            + (current.windDir ? ' · ' + current.windDir : '')
            + (current.humidity ? ' · Humidity ' + current.humidity : '')),
      ),
    ),

    /* Next 12h hourly strip (real forecast data; hidden on a historical
       date, whose forward-looking strip is empty). */
    props.hourly.length ? React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'fs-weather-popover__section-label' },
        'Next 12 hours'),
      React.createElement('div', { className: 'fs-weather-popover__hourly' },
        props.hourly.map(function(h, i) {
          return React.createElement('div', {
            key: i, className: 'fs-weather-popover__hour',
          },
            React.createElement('div', { className: 'fs-weather-popover__hour-time' },
              h.hour),
            NavIcon && React.createElement(NavIcon, { name: h.condition, size: 16 }),
            React.createElement('div', { className: 'fs-weather-popover__hour-temp' },
              h.temp + '°'),
          );
        }),
      )
    ) : null,

    /* 7-day daily (real forecast data; hidden on a historical date). */
    props.daily.length ? React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'fs-weather-popover__section-label' },
        '7-day forecast'),
      React.createElement('div', { className: 'fs-weather-popover__daily' },
        props.daily.map(function(d, i) {
          return React.createElement('div', {
            key: i, className: 'fs-weather-popover__day',
          },
            React.createElement('span', { className: 'fs-weather-popover__day-name' },
              d.day),
            React.createElement('span', { className: 'fs-weather-popover__day-date' },
              d.date),
            NavIcon && React.createElement(NavIcon, { name: d.condition, size: 16 }),
            React.createElement('span', { className: 'fs-weather-popover__day-range' },
              d.high + '° / ' + d.low + '°'),
          );
        }),
      )
    ) : null,
  );
}
const MIDDLE_WIDTH_MIN     = 280;
const MIDDLE_WIDTH_MAX     = 480;

/* ---------- Date subtitle helper ------------------------------------------ */
function formatTodayDate() {
  var d = new Date();
  var days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var months = ['Jan','Feb','Mar','Apr','May','Jun',
                'Jul','Aug','Sep','Oct','Nov','Dec'];
  return days[d.getDay()] + ' · ' + d.getDate() + ' ' + months[d.getMonth()];
}

/* ---------- Share / copy-link helper (Sprint 8.10.2) -------------------- */
async function shareCurrentLink() {
  var url = window.location.href;
  /* Prefer Web Share API on mobile when available. */
  if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '')) {
    try {
      await navigator.share({ title: document.title, url: url });
      return;
    } catch (_) { /* user dismissed — fall through to clipboard */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    if (window.FS && window.FS.toast) {
      window.FS.toast.show({ message: 'Link copied to clipboard', tone: 'success' });
    }
  } catch (_) {
    if (window.FS && window.FS.toast) {
      window.FS.toast.show({
        message: 'Copy failed — URL: ' + url,
        tone:    'warning',
        duration: 8000,
      });
    }
  }
}

/* ---------- MiddleColumn -------------------------------------------------- */

/* Batch A2 Task 1 — routes scoped by the header project selector (FS.
   siteContext). Strategic pages (Insights/Portfolio/Regional/Executive),
   Today, Team/Sites and Ask are exempt BY DESIGN — see scripts/site-context.js. */
const SITE_SCOPED_ROUTES = ['/timeline', '/safety', '/quality', '/tasks', '/evidence', '/activity'];

function MiddleColumn({ route, width, onWidthChange, onSelect, selectedItem, fullWidth, onSearchOpen }) {
  const t = window.FS.tokens;

  const routeLabel = (route || '/').replace(/^\//, '') || 'today';
  const title = routeLabel
    .split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

  /* Batch A2 Task 1 — header project selector (SITE_SCOPED_ROUTES only).
     sitesList is fetched once per mount (mirrors the cancelled-guard
     pattern used elsewhere, e.g. composites/audio-playlist.js:59-72);
     activeSite mirrors FS.siteContext so the header re-renders whenever
     any page changes the active project. */
  const [sitesList, setSitesList] = React.useState([]);
  React.useEffect(function () {
    var cancelled = false;
    /* Source the header selector's sites from the SAME place the pages do —
       Aurora org.getOrgSites() when org-live (mirrors sites.js/timeline.js
       orgLive()). Sourcing from the legacy sites.getSites() gave
       platform_admin a DIFFERENT list than the pages: a project picked on
       Timeline wasn't in the header list (selector reset to "All projects"),
       and a project picked in the header wasn't in Timeline's Aurora list
       (Timeline fell back to its own "Pick a project" card). One source ⇒
       the two selectors agree. */
    var live = !!(window.FS && window.FS.api && !window.FS.api.useMocks
      && window.FS.api.orgBaseUrl && window.FS.api.org);
    var req = live ? window.FS.api.org.getOrgSites() : window.FS.api.sites.getSites();
    req.then(function (res) {
      if (cancelled) return;
      setSitesList((res && res.sites) || []);
    }).catch(function () {
      if (cancelled) return;
      setSitesList([]);
    });
    return function () { cancelled = true; };
  }, []);

  const [activeSite, setActiveSite] = React.useState(function () {
    return window.FS.siteContext ? window.FS.siteContext.get() : null;
  });
  React.useEffect(function () {
    if (!window.FS.siteContext) return;
    return window.FS.siteContext.onChange(setActiveSite);
  }, []);

  /* Stale-value validation: if the persisted/legacy-adopted activeSite no
     longer matches a real project (e.g. a fixture/backend change removed
     it), fall back to '' in the UI and drop the stale key — done in an
     effect, not during render, since it's a side effect on shared state. */
  const validatedActiveSite = (sitesList.length > 0 && sitesList.some(function (s) { return s.site_id === activeSite; }))
    ? activeSite
    : '';
  React.useEffect(function () {
    if (activeSite && sitesList.length > 0 && !sitesList.some(function (s) { return s.site_id === activeSite; })) {
      window.FS.siteContext.set(null);
    }
  }, [activeSite, sitesList]);

  function onHeaderSiteChange(e) {
    var v = e.target.value || null;
    window.FS.siteContext.set(v);
    /* Special case: /timeline's own URL `?site=` outranks the global
       context for deep-link support (a shared link must keep showing the
       linked project even if the visitor's last-picked context differs).
       That means switching projects from the header has to rewrite the
       URL too, or the page would keep reading the old ?site= value and
       silently ignore the header change. Date is preserved; user is
       deliberately dropped — a project switch resets the person filter. */
    if (route === '/timeline') {
      var p = window.FS.Router.getCurrentRoute().params || {};
      window.FS.Router.navigate('/timeline' + (v ? '?site=' + encodeURIComponent(v) + (p.date ? '&date=' + p.date : '') : ''));
    }
  }

  /* Sprint 4.7 — full-width pages (currently /programme) ignore the
     middle-column width slider and let the column flex to fill the
     entire content area. The static right detail is suppressed at
     the AppShell level; a slide-in drawer takes its place when the
     user selects something. */
  const style = fullWidth
    ? {
        flex: 1,
        minWidth: 0,
        background: 'var(--surface-app)',
        borderRight: '1px solid var(--border-subtle)',
      }
    : {
        width: width + 'px',
        background: 'var(--surface-app)',
        borderRight: '1px solid var(--border-subtle)',
      };

  const headerStyle = {
    height: '56px',
    display: 'flex',
    alignItems: 'center',
    padding: '0 20px',
    borderBottom: '1px solid var(--border-subtle)',
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

  return React.createElement('div', {
    style: style, className: 'middle-column',
    id: 'fs-main-content',   /* Sprint 8.5.3 — skip-nav target */
    tabIndex: -1,
  },

    React.createElement('div', { style: headerStyle, className: 'middle-column__header' },
      React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', flex: 1, gap: '2px' },
      },
        React.createElement('span', {
          style: {
            fontWeight: t.typography.fontWeight.semibold,
            fontSize: t.typography.fontSize.base,
            color: 'var(--text-primary)',
            lineHeight: 1.2,
          },
        }, title),
        route === '/today' ? React.createElement('span', {
          style: { fontSize: '11px', color: 'var(--text-tertiary)', lineHeight: 1.2 },
        }, formatTodayDate()) : null,
      ),

      /* #5 — header project selector on EVERY page (was SITE_SCOPED_ROUTES
         only). A consistent global project scope control at the top of all
         pages; the /timeline deep-link special-cases below still apply where
         relevant, other routes read/write the shared FS.siteContext. */
      (sitesList.length > 0) ? React.createElement('select', {
        className:    'fs-settings__select',
        style:        { maxWidth: '220px' },
        /* On /timeline the URL's ?site= outranks the context (deep links) —
           the select must show what the PAGE shows, or the two project
           indicators contradict each other (Fable review #5). Other scoped
           routes have no site URL param, so context is the truth there. */
        value:        (route === '/timeline'
                        ? (((window.FS.Router.getCurrentRoute() || {}).params || {}).site || validatedActiveSite)
                        : validatedActiveSite) || '',
        onChange:     onHeaderSiteChange,
        'aria-label': 'Active project',
      },
        [{ v: '', l: '— All projects —' }].concat(
          sitesList.map(function (s) { return { v: s.site_id, l: s.name }; })
        ).map(function (o) {
          return React.createElement('option', { key: o.v, value: o.v }, o.l);
        }),
      ) : null,

      /* Right-side utility area: search + share + weather */
      React.createElement('div', { className: 'middle-column__utility' },
        onSearchOpen ? React.createElement('button', {
          type:         'button',
          className:    'fs-utility-item fs-search-btn',
          onClick:      onSearchOpen,
          title:        'Search  (⌘K)',
          'aria-label': 'Open search (Cmd+K)',
        },
          window.FieldSight.NavIcon && React.createElement(window.FieldSight.NavIcon, {
            name: 'search', size: 16,
          }),
        ) : null,
        /* Sprint 8.10.2 — copy-link / share button */
        React.createElement('button', {
          type:         'button',
          className:    'fs-utility-item fs-share-btn',
          onClick:      shareCurrentLink,
          title:        'Copy link to this view',
          'aria-label': 'Copy link to this view',
        },
          window.FieldSight.NavIcon && React.createElement(window.FieldSight.NavIcon, {
            name: 'share-2', size: 16,
          }),
        ),
        React.createElement(WeatherIndicator),
      ),
    ),

    React.createElement('div', { style: contentStyle },
      (function() {
        var page = window.FieldSight.getPageForRoute && window.FieldSight.getPageForRoute(route);
        if (page && page.Middle) {
          return React.createElement(page.Middle, {
            onSelect:     onSelect,
            selectedItem: selectedItem,
          });
        }
        /* Fallback placeholder for unregistered routes — Sprint 2 fills in
           remaining pages; until then, visualise the route as a friendly
           coming-soon state rather than a bare line of text. */
        var NavIcon = window.FieldSight && window.FieldSight.NavIcon;
        return React.createElement('div', {
          className: 'fs-page-placeholder',
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            gap: '12px',
            padding: '40px 24px',
            margin: '24px 0',
            background: 'var(--surface-panel-muted)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: '12px',
            color: 'var(--text-tertiary)',
          },
        },
          React.createElement('div', {
            style: {
              width: '48px', height: '48px', borderRadius: '50%',
              background: 'var(--surface-panel)',
              border: '1px solid var(--border-subtle)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            },
          },
            NavIcon ? React.createElement(NavIcon, {
              name: 'hammer', size: 22, color: 'var(--text-disabled)',
            }) : null,
          ),
          React.createElement('div', {
            style: {
              fontSize: t.typography.fontSize.base,
              fontWeight: t.typography.fontWeight.semibold,
              color: 'var(--text-secondary)',
            },
          }, title),
          React.createElement('div', {
            style: { fontSize: t.typography.fontSize.sm, lineHeight: 1.5 },
          }, 'This page isn’t wired up yet — coming in a later sprint.'),
        );
      })(),
    ),

    /* Drag handle on right edge — controlled by AppShell.
       Sprint 4.7: hidden on full-width pages (no neighbouring column
       to resize against). */
    !fullWidth && window.FieldSight.DragDivider ? React.createElement(
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

/* ---------- MobileBack — ← Back button shown inside right-detail on mobile */
function MobileBack({ onClose }) {
  var NavIcon = window.FieldSight && window.FieldSight.NavIcon;
  return React.createElement('button', {
    type:      'button',
    className: 'fs-mobile-back',
    onClick:   onClose,
    'aria-label': 'Back to list',
  },
    NavIcon ? React.createElement(NavIcon, { name: 'chevron-left', size: 16, color: 'var(--color-accent-500)' }) : null,
    'Back',
  );
}

/* ---------- RightDetail --------------------------------------------------- */
function RightDetail({ route, selectedItem, onClose }) {
  const t = window.FS.tokens;

  var page = window.FieldSight.getPageForRoute && window.FieldSight.getPageForRoute(route);
  if (page && page.Right) {
    return React.createElement('div', {
      className: 'right-detail',
      /* alignItems/justifyContent reset the empty-state centering (.right-detail
         in app-shell.css) so a populated Right panel fills the full pane width. */
      style: { background: 'var(--surface-panel)', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start' },
    },
      /* Sprint 8.4.1 — back button visible only on mobile via CSS */
      React.createElement(MobileBack, { onClose: onClose }),
      React.createElement('div', { style: { flex: 1, overflow: 'hidden' } },
        React.createElement(page.Right, {
          selectedItem: selectedItem,
          onClose: onClose,
        }),
      ),
    );
  }

  /* Default empty state for unregistered routes */
  const iconWrapStyle = {
    width: '60px', height: '60px', borderRadius: '50%',
    background: 'var(--surface-app)',
    border: '1px solid var(--border-subtle)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: t.shadow.sm,
  };

  return React.createElement('div', {
    style: { background: 'var(--surface-panel)', color: 'var(--text-tertiary)' },
    className: 'right-detail',
  },
    React.createElement('div', { style: iconWrapStyle },
      window.FieldSight && window.FieldSight.NavIcon
        ? React.createElement(window.FieldSight.NavIcon, {
            name: 'panel-right-open', size: 28, color: 'var(--text-disabled)',
          })
        : null,
    ),
    React.createElement('div', {
      style: {
        fontWeight: t.typography.fontWeight.semibold,
        fontSize: t.typography.fontSize.base,
        color: 'var(--text-secondary)',
      },
    }, 'Select an item'),
    React.createElement('div', {
      style: { fontSize: t.typography.fontSize.sm, color: 'var(--text-tertiary)' },
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

  /* Selected item for right detail panel */
  const [selectedItem, setSelectedItem] = React.useState(null);

  /* Sprint 8.6 — global search palette */
  const [searchOpen, setSearchOpen] = React.useState(false);

  /* Sprint 8.11.2 — keyboard shortcut reference modal */
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  /* Sprint 8.11.1 — first-run onboarding overlay.
     Sprint 10 follow-up: only auto-open on the landing route (root or
     /today). A deep link to /programme, /tasks, /safety, etc. means the
     user knows where they're going — interrupting them with a tutorial
     modal that ends in "Open Today →" navigated them away from the page
     they actually wanted (reproduced on /programme: modal covers Gantt,
     user clicks "Open Today →" thinking it's a task, lands on /today
     with no way back to their import workflow). The `?onboarding=1`
     dev override still forces it on any route. */
  const [onboardingOpen, setOnboardingOpen] = React.useState(function () {
    try {
      var p = new URLSearchParams(window.location.search);
      if (p.get('onboarding') === '1') return true;        /* dev override */
      if (localStorage.getItem('fs.onboarded') === '1') return false;
      var hash = (window.location.hash || '').replace(/^#/, '').split('?')[0];
      var onLanding = (hash === '' || hash === '/' || hash === '/today');
      return onLanding;
    } catch (_) { return false; }
  });

  /* Sprint 10 follow-up — close the onboarding overlay automatically
     when the user navigates off the landing route. Sibling case to the
     init guard above: if the modal opened on /today and the user clicks
     a sidebar link to /programme without dismissing, we don't want the
     overlay to "follow" them and block their workflow on the new page.
     We don't persist `fs.onboarded` here — they didn't finish the tour;
     next visit to /today will re-show it. */
  React.useEffect(function () {
    if (!onboardingOpen) return;
    var hash = (route || '/today').split('?')[0];
    var onLanding = (hash === '/' || hash === '/today');
    if (!onLanding) setOnboardingOpen(false);
  }, [route, onboardingOpen]);

  /* Sprint 8.9.2 — product tour */
  const [demoTourOpen, setDemoTourOpen] = React.useState(function () {
    return !!(window.FieldSight && window.FieldSight.shouldRunDemoTour
              && window.FieldSight.shouldRunDemoTour());
  });

  /* Sprint 8.7 — offline detection */
  const [isOnline, setIsOnline] = React.useState(function () {
    return typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
  });

  /* Clear selection on route change — different page = fresh selection */
  React.useEffect(function() {
    setSelectedItem(null);
  }, [route]);

  /* Sprint 8.5.4 — announce page title to screen readers + update document.title.
     Sprint 8.10.1 — also expose printable date on #fs-main-content for @media print. */
  React.useEffect(function() {
    var label = (route || '/').replace(/^\//, '') || 'today';
    var title = label.split('-').map(function(w) { return w[0].toUpperCase() + w.slice(1); }).join(' ');
    document.title = title + ' · FieldSight';
    var region = document.getElementById('fs-live-region');
    if (region) region.textContent = 'Navigated to ' + title;
    var main = document.getElementById('fs-main-content');
    if (main) {
      var d = new Date();
      main.setAttribute('data-print-date',
        d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
        + '-' + String(d.getDate()).padStart(2, '0'));
    }
  }, [route]);

  React.useEffect(function() {
    return window.AuthMock.onChange(function(u) { setUser(Object.assign({}, u)); });
  }, []);

  /* Sprint 2b — org status banner. FS.session.user (real backend identity)
     isn't mirrored onto AuthMock (session-bridge.js only copies role/name/
     site), so `user` above won't carry orgStatus. Subscribe separately just
     to force a re-render when the session changes (sign-in, hydrateUser());
     the actual orgStatus read happens fresh each render, right before the
     return below. Guarded for mock mode, where window.FS.session is present
     but .user stays null. */
  var refOrgStatusTick   = React.useState(0);
  var setOrgStatusTick   = refOrgStatusTick[1];
  React.useEffect(function() {
    if (!(window.FS && window.FS.session && window.FS.session.onChange)) return undefined;
    return window.FS.session.onChange(function () {
      setOrgStatusTick(function (n) { return n + 1; });
    });
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

  /* Keyboard shortcuts — ignored when typing in text fields */
  React.useEffect(function() {
    function onKey(e) {
      var target = e.target;
      var tag = target && target.tagName;
      var inInput = tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        if (inInput) return;
        e.preventDefault();
        toggleCollapse();
      }
      /* Sprint 8.6 — ⌘K / Ctrl+K opens search palette */
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      /* Sprint 8.11.2 — single-key navigation + help (skipped in inputs) */
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (inInput) return;
      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen(function (s) { return !s; });
      } else if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        window.FS.Router.navigate('/today');
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        window.FS.Router.navigate('/safety');
      } else if (e.key.toLowerCase() === 'p') {
        e.preventDefault();
        window.FS.Router.navigate('/programme');
      }
    }
    window.addEventListener('keydown', onKey);
    return function() { window.removeEventListener('keydown', onKey); };
  });

  /* Sprint 8.7 — online / offline detection */
  React.useEffect(function () {
    function onOnline()  { setIsOnline(true); }
    function onOffline() { setIsOnline(false); }
    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);
    return function () {
      window.removeEventListener('online',  onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

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

  /* Sprint 3 P-07 — pages may declare a `Provider` slot in the page
     registry. AppShell wraps Middle + Right in it so the two columns
     share state through React Context (replaces the old window slot
     pattern). Provider's a Context.Provider under the hood — no DOM
     element — so the flex layout of LeftNav / Middle / Right is
     unchanged. Pages without a Provider get React.Fragment, which is
     equally transparent.

     Sprint 4.7 — pages may also declare `layout: 'full-width'`.
     When set, the static RightDetail pane is suppressed and the
     middle column flexes to fill the entire content area. A
     RightDrawer component slides in from the right edge whenever a
     selection is made; ESC / backdrop click / close button dismisses
     it. Currently used by /programme so the Gantt and kanban have
     room to breathe. */
  var pageEntry    = window.FieldSight.getPageForRoute && window.FieldSight.getPageForRoute(route);
  var PageProvider = (pageEntry && pageEntry.Provider) || React.Fragment;
  var fullWidth    = !!(pageEntry && pageEntry.layout === 'full-width');

  /* `has-selection` lets the mobile media query swap which pane is
     visible: middle when nothing is selected, right detail when something is.
     Suppressed on full-width pages — drawer handles selection there. */
  var shellClassName = 'app-shell'
    + ((selectedItem && !fullWidth) ? ' has-selection' : '')
    + (fullWidth ? ' app-shell--full-width' : '');

  /* Expose closeDetail globally so MobileBack button (and swipe handler)
     can close the right-detail panel without prop-drilling. */
  React.useEffect(function () {
    if (!window.FS) window.FS = {};
    window.FS.shell = { closeDetail: function () { setSelectedItem(null); } };
    return function () { delete window.FS.shell; };
  });

  /* Sprint 2b — org account status (unprovisioned / archived). Null-guarded:
     mock mode has no window.FS.session.user, so orgStatus stays undefined
     and the banner below renders nothing. */
  var orgStatus = ((window.FS && window.FS.session && window.FS.session.user) || {}).orgStatus;

  return React.createElement('div', { style: shellStyle, className: shellClassName },

    /* Sprint 8.5.3 — skip navigation link (visually hidden until focused) */
    React.createElement('a', {
      href:      '#fs-main-content',
      className: 'fs-skip-nav',
    }, 'Skip to main content'),

    /* Sprint 8.5.4 — polite live region for route + action announcements */
    React.createElement('div', {
      id:           'fs-live-region',
      className:    'fs-live-region',
      'aria-live':  'polite',
      'aria-atomic': true,
    }),

    React.createElement(window.FieldSight.LeftNav, {
      user: user,
      currentRoute: route,
      isCollapsed: isCollapsed,
      onToggleCollapse: toggleCollapse,
      onNavigate: navigate,
    }),

    React.createElement(PageProvider, null,
      React.createElement(MiddleColumn, {
        route: route,
        width: middleWidth,
        onWidthChange: setMiddleWidth,
        onSelect: setSelectedItem,
        selectedItem: selectedItem,
        fullWidth: fullWidth,
        onSearchOpen: function () { setSearchOpen(true); },
      }),

      /* Static right pane only in normal (3-pane) mode. */
      !fullWidth ? React.createElement(RightDetail, {
        route: route,
        selectedItem: selectedItem,
        onClose: function() { setSelectedItem(null); },
      }) : null,

      /* Slide-in drawer for full-width pages. Always mounted so
         transitions can animate on open/close; opacity + transform
         driven by the `open` prop. */
      fullWidth && window.FieldSight.RightDrawer
        ? React.createElement(window.FieldSight.RightDrawer, {
            open:         !!selectedItem,
            route:        route,
            selectedItem: selectedItem,
            onClose:      function() { setSelectedItem(null); },
          })
        : null,
    ),

    /* Sprint 8.4.1 — bottom navigation bar (rendered outside PageProvider
       so it's always present regardless of page layout mode). */
    React.createElement(BottomNav, {
      user:         user,
      currentRoute: route,
      onNavigate:   navigate,
    }),

    showDevSwitcher && window.FieldSight.DevRoleSwitcher
      ? React.createElement(window.FieldSight.DevRoleSwitcher)
      : null,

    /* Sprint 8.7 — offline banner (fixed, above all content) */
    !isOnline
      ? React.createElement('div', {
          className:   'fs-offline-banner',
          role:        'status',
          'aria-live': 'polite',
        }, '⚠️ You’re offline — changes won’t sync')
      : null,

    /* Sprint 2b — org account status banner (fixed; stacks below the
       offline banner via CSS adjacent-sibling on the rare occasion both
       show at once). 'active' / mock (null orgStatus) render nothing. */
    (orgStatus === 'unprovisioned' || orgStatus === 'archived')
      ? React.createElement('div', {
          className:   'fs-orgstatus-banner fs-orgstatus-banner--' + orgStatus,
          role:        'status',
          'aria-live': 'polite',
        }, orgStatus === 'unprovisioned'
          ? 'Your account isn’t activated yet — contact your administrator for access.'
          : 'Your account is archived — you have read-only access.')
      : null,

    /* Sprint 8.6 — global search palette */
    searchOpen && window.FieldSight.SearchPalette
      ? React.createElement(window.FieldSight.SearchPalette, {
          onClose: function () { setSearchOpen(false); },
        })
      : null,

    /* Sprint 8.11.2 — keyboard shortcut reference modal */
    shortcutsOpen && window.FieldSight.ModalOverlay
      ? React.createElement(window.FieldSight.ModalOverlay, {
          open:    true,
          onClose: function () { setShortcutsOpen(false); },
          title:   'Keyboard shortcuts',
          size:    'sm',
        },
          React.createElement('table', { className: 'fs-shortcuts' },
            React.createElement('tbody', null,
              [
                ['Cmd / Ctrl + K', 'Open search palette'],
                ['?',              'Show this shortcut reference'],
                ['Escape',         'Close modal / drawer / detail'],
                ['T',              'Go to Today'],
                ['S',              'Go to Safety'],
                ['P',              'Go to Programme'],
                ['Cmd / Ctrl + B', 'Toggle the navigation sidebar'],
                ['← / →',          'Shift Gantt task date (when bar focused)'],
              ].map(function (row, i) {
                return React.createElement('tr', { key: i },
                  React.createElement('th', { scope: 'row' },
                    React.createElement('kbd', { className: 'fs-shortcuts__key' }, row[0])),
                  React.createElement('td', null, row[1]),
                );
              }),
            ),
          ),
        )
      : null,

    /* Sprint 8.11.1 — first-run onboarding overlay */
    onboardingOpen && window.FieldSight.OnboardingOverlay
      ? React.createElement(window.FieldSight.OnboardingOverlay, {
          user:    user,
          onClose: function () { setOnboardingOpen(false); },
        })
      : null,

    /* Sprint 8.9.2 — product tour (?demo=1) */
    demoTourOpen && window.FieldSight.DemoTour
      ? React.createElement(window.FieldSight.DemoTour, {
          onClose: function () { setDemoTourOpen(false); },
        })
      : null,
  );
}

/* ---------- SessionGate (Sprint 3, P-08) ---------------------------------- */
/* Decides whether to mount the main AppShell or the LoginScreen.
   • useMocks=true (preview default): always renders AppShell. The
     mock auth-mock.js still drives roles for the dev switcher.
   • useMocks=false: renders LoginScreen until FS.session.isSignedIn(),
     then re-renders AppShell. Subscribes to session.onChange so a
     successful sign-in (or a refresh failure that clears the session)
     swaps the screen in place.

   Hooks are called unconditionally at the top so flipping useMocks
   at runtime never trips the Rules of Hooks (M-3 fix from the post-
   merge review). The early branch on useMocks just decides which
   tree to render after the hooks run. */
function SessionGate(opts) {
  const useMocks = window.FS && window.FS.api && window.FS.api.useMocks !== false;
  const session  = window.FS && window.FS.session;
  const Login    = window.FieldSight && window.FieldSight.LoginScreen;

  /* Always run the hooks — even in mock mode — so the hook order is
     stable across re-renders if useMocks ever changes at runtime. */
  const [signedIn, setSignedIn] = React.useState(function () {
    return session ? session.isSignedIn() : true;
  });

  /* Silent session restore: the access token lives ~1 h, but the refresh
     token lives 30 days. Without this, any refresh/idle past the hour
     dumps the user to LoginScreen even though session.refresh() would
     succeed instantly. Gate the login screen behind one refresh attempt. */
  const [restoring, setRestoring] = React.useState(function () {
    return !!(session && !session.isSignedIn() && session.refreshToken);
  });

  React.useEffect(function () {
    if (!restoring || !session) return undefined;
    var cancelled = false;
    session.refresh().then(function () {
      if (!cancelled) {
        setSignedIn(session.isSignedIn());
        setRestoring(false);
      }
    });
    return function () { cancelled = true; };
  }, []);

  React.useEffect(function () {
    if (!session) return undefined;
    return session.onChange(function () {
      setSignedIn(session.isSignedIn());
    });
  }, [session]);

  /* Mock mode (or no session module loaded): always render AppShell. */
  if (useMocks || !session) {
    return React.createElement(AppShell, opts);
  }

  /* Sub-second blank while the silent refresh runs — flashing the login
     screen and then swapping to the app is worse than a brief blank. */
  if (restoring) return null;

  if (!signedIn) {
    if (!Login) {
      console.error('[SessionGate] LoginScreen composite missing');
      return null;
    }
    return React.createElement(Login, {
      onSignedIn: function () { setSignedIn(true); },
    });
  }

  return React.createElement(AppShell, opts);
}

/* ---------- Mount helper -------------------------------------------------- */
function mountAppShell(containerId, opts) {
  containerId = containerId || 'root';
  opts = opts || {};
  if (window.FS && window.FS.theme)   window.FS.theme.init();
  if (window.FS && window.FS.density) window.FS.density.init();
  var el = document.getElementById(containerId);
  if (!el) { console.error('[AppShell] No element #' + containerId); return; }
  var root = ReactDOM.createRoot(el);
  root.render(React.createElement(SessionGate, opts));
}

if (!window.FieldSight) window.FieldSight = {};
Object.assign(window.FieldSight, {
  AppShell:       AppShell,
  SessionGate:    SessionGate,
  MiddleColumn:   MiddleColumn,
  RightDetail:    RightDetail,
  mountAppShell:  mountAppShell,
});
