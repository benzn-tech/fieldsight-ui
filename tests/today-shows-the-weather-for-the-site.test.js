'use strict';

/*
 * Today shows the morning's weather for the active site, as the pipeline
 * decided it (owner, 2026-09-29: weather goes in the Morning Brief and the
 * daily report; the code decides, the model words).
 *
 * The page judges nothing -- the lines come from weather_advice against the
 * day's programme. What is pinned here is that it stays that way, that the
 * card does not wait for a report (the brief does), and that an absent
 * forecast is said rather than hidden.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const CARD = read('scripts', 'composites', 'today-weather-card.js');
const TODAY = read('scripts', 'pages', 'today.js');
const ORG = read('scripts', 'api', 'org.js');
const HTML = read('app-shell-preview.html');

global.window = { FieldSight: {} };
const { basisNote, summaryLines } = require('../scripts/composites/today-weather-card.js');

test('THE card shows the lines as sent and decides nothing itself', () => {
  assert.match(CARD, /adviceLines\(state\.forecast\)\.map\(function \(line, i\)/);
  for (const judged of ['prob', 'mm', 'gust', 'threshold', 'probability_word']) {
    assert.ok(!new RegExp('forecast\.items|\b' + judged + '\b').test(CARD.replace(/\/\*[\s\S]*?\*\//g, '')),
      'the card must not read ' + judged + ' -- judgement belongs to weather_advice');
  }
});

test('it says which basis the lines were judged on', () => {
  assert.strictEqual(basisNote({ impact_basis: 'planned' }), 'Checked against today’s programme.');
  assert.match(basisNote({ impact_basis: 'general' }), /No programme for this site/);
  assert.strictEqual(basisNote(null), null);
});

test('an absent forecast is said, not hidden', () => {
  assert.match(CARD, /No forecast for this site yet/);
});

test('it sits above the brief and does not wait for a report', () => {
  const card = TODAY.indexOf('React.createElement(fs.TodayWeatherCard, null)');
  const brief = TODAY.indexOf('React.createElement(fs.MorningBriefCard');
  assert.ok(card > 0 && card < brief, 'weather before the brief');
  const line = TODAY.slice(TODAY.lastIndexOf('\n', card), card);
  assert.ok(!/effectiveDate/.test(line), 'not gated on today having a report');
});

test('it asks org-api for one site and one day', () => {
  assert.match(ORG, /api\.orgRequest\('\/weather', \{ params: \{ site: opts\.site, date: opts\.date \} \}\)/);
  assert.match(ORG, /getSiteWeather: getSiteWeather,/);
});

test('the page loads the card', () => {
  assert.match(HTML, /scripts\/composites\/today-weather-card\.js\?v=\d+/);
});

test('the numbers for the day are shown as sent, above the advice (owner, 2026-10-05)', () => {
  const summary = ['Light drizzle', 'Temperature range: 11.8°C – 18.4°C',
    'Rainfall: 0.3mm', 'Max wind speed: 16.2 km/h'];
  assert.deepStrictEqual(summaryLines({ summary: summary, lines: [] }), summary);
  assert.deepStrictEqual(summaryLines({ lines: ['x'] }), [], 'an older forecast has none');
  const facts = CARD.indexOf("className: 'fs-today-weather__facts'");
  assert.ok(facts > 0 && facts < CARD.indexOf("className: 'fs-today-weather__lines'"),
    'the numbers render, above the advice');
  assert.match(CARD, /var facts = summaryLines\(state\.forecast\);/);
});
