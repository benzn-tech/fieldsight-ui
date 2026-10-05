/* ==========================================================================
   FieldSight TodayWeatherCard -- the morning's weather for the active site
   --------------------------------------------------------------------------
   What today's weather means for today's programme, at the top of Today.

   THE PAGE DECIDES NOTHING. Every line was written by the pipeline's
   weather_advice (owner, 2026-09-29: the code decides, the model words):
   thresholds, which planned tasks are hit, finish-by times, the fixed
   probability words. This card fetches GET /api/org/weather and shows the
   lines as they are -- rewording them here would make Today and the daily
   report disagree about the same weather.

   Independent of the Morning Brief on purpose: the brief only renders once
   today has a report, and the forecast exists at 05:30, hours before one.

   Shown for ONE site (FS.siteContext); with "all sites" selected there is no
   single forecast to show, and the card is absent rather than a guess.

   Exported to: window.FieldSight.TodayWeatherCard
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function basisNote(forecast) {
    if (!forecast) return null;
    if (forecast.impact_basis === 'planned') return 'Checked against today’s programme.';
    return 'No programme for this site — trades weather affects in general.';
  }

  /* The day's numbers ("Light drizzle", "Temperature range: ...", "Rainfall:
     ...", "Max wind speed: ..."), worded by the pipeline (weather.summary_lines)
     so Today and the report say them the same way. [] on a forecast written
     before 2026-10-05, which carried the advice only. */
  function summaryLines(forecast) {
    return forecast && Array.isArray(forecast.summary) ? forecast.summary : [];
  }

  function adviceLines(forecast) {
    return forecast && Array.isArray(forecast.lines) ? forecast.lines : [];
  }

  function TodayWeatherCard(props) {
    var Card = window.FieldSight.Card;
    var ctx = window.FS && window.FS.siteContext;

    var siteRef = React.useState(ctx ? ctx.get() : null);
    var site = siteRef[0]; var setSite = siteRef[1];
    var stateRef = React.useState({ status: 'idle' });
    var state = stateRef[0]; var setState = stateRef[1];

    React.useEffect(function () {
      if (!ctx || typeof ctx.onChange !== 'function') return undefined;
      return ctx.onChange(function (id) { setSite(id || null); });
    }, []);

    var date = props.date || (window.FS.api.todayNZDT && window.FS.api.todayNZDT());

    React.useEffect(function () {
      if (!site) { setState({ status: 'idle' }); return undefined; }
      var alive = true;
      setState({ status: 'loading' });
      window.FS.api.org.getSiteWeather({ site: site, date: date }).then(function (res) {
        if (alive) setState({ status: 'ok', forecast: (res && res.forecast) || null });
      }).catch(function () {
        if (alive) setState({ status: 'error' });
      });
      return function () { alive = false; };
    }, [site, date]);

    if (!site) return null;

    var body;
    if (state.status === 'loading' || state.status === 'idle') {
      body = React.createElement('p', { className: 'fs-today-weather__muted' }, 'Loading today’s weather…');
    } else if (state.status === 'error') {
      body = React.createElement('p', { className: 'fs-today-weather__muted' },
        'Could not load today’s weather.');
    } else if (!summaryLines(state.forecast).length && !adviceLines(state.forecast).length) {
      /* Absent is said, not hidden: a site with no forecast is either before
         05:30 or has no location set, and a missing card reads as fine weather. */
      body = React.createElement('p', { className: 'fs-today-weather__muted' },
        'No forecast for this site yet — it is written at 5:30 each morning for sites with a location.');
    } else {
      var facts = summaryLines(state.forecast);
      body = React.createElement(React.Fragment, null,
        facts.length ? React.createElement('ul', { className: 'fs-today-weather__facts' },
          facts.map(function (line, i) {
            return React.createElement('li', { key: i }, line);
          })) : null,
        React.createElement('ul', { className: 'fs-today-weather__lines' },
          adviceLines(state.forecast).map(function (line, i) {
            return React.createElement('li', { key: i }, line);
          })),
        React.createElement('p', { className: 'fs-today-weather__basis' }, basisNote(state.forecast)));
    }

    return React.createElement(Card, { padding: 'md', className: 'fs-today-weather' },
      React.createElement(Card.Body, null,
        React.createElement('div', { className: 'fs-today-weather__title' }, 'Weather today'),
        body));
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TodayWeatherCard = TodayWeatherCard;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { basisNote: basisNote, summaryLines: summaryLines };
  }
})();
