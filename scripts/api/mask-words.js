/* ==========================================================================
   FieldSight mask-words — hides a short list of words in the transcript display
   --------------------------------------------------------------------------
   DISPLAY ONLY. Stored text, reports, Ask, search and exports never pass through
   here. Every use is one press from the original, because the transcript is read
   to check accuracy and a masked word cannot be checked.

   Whole words only, and only words with no ordinary site meaning. Left alone on
   purpose: stopcock, Dick (a name), prick (a pin prick), piss, hell, damn, bloody,
   crap. Over-masking a construction transcript is the worse failure.

   Exported to: window.FS.maskWords (and CommonJS for tests)
   ========================================================================== */

(function () {
  'use strict';

  var WORDS = [
    'fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking', 'fuckin', 'fuckwit', 'fuckwits',
    'motherfucker', 'motherfuckers', 'motherfucking',
    'shit', 'shits', 'shitty', 'shitting', 'shithead', 'shitheads', 'bullshit', 'horseshit',
    'cunt', 'cunts',
    'bitch', 'bitches', 'bitching',
    'asshole', 'assholes', 'arsehole', 'arseholes',
    'wanker', 'wankers',
    'bastard', 'bastards',
    'twat', 'twats',
    'dickhead', 'dickheads',
    'cocksucker', 'cocksuckers',
  ];
  var PATTERN = new RegExp('(^|[^A-Za-z0-9_])(' + WORDS.join('|') + ')(?![A-Za-z0-9_])', 'gi');
  var STORE_KEY = 'fs.transcript.showOriginal';

  /* First letter, then stars to the same length, so revealing does not reflow. */
  function maskWords(text) {
    if (text == null) return '';
    return String(text).replace(PATTERN, function (_, before, word) {
      return before + word[0] + new Array(word.length).join('*');
    });
  }

  function hasMasked(text) {
    return maskWords(text) !== String(text == null ? '' : text);
  }

  var subs = [];
  var revealed = false;
  try { revealed = localStorage.getItem(STORE_KEY) === '1'; } catch (_) { /* masked */ }

  function isRevealed() { return revealed; }

  function setRevealed(v) {
    revealed = !!v;
    try { localStorage.setItem(STORE_KEY, revealed ? '1' : '0'); } catch (_) { /* this page only */ }
    subs.slice().forEach(function (cb) { cb(); });
  }

  function subscribe(cb) {
    subs.push(cb);
    return function () { subs = subs.filter(function (x) { return x !== cb; }); };
  }

  /* What to put on screen for this viewer. */
  function display(text) {
    return revealed ? (text == null ? '' : String(text)) : maskWords(text);
  }

  var api = {
    WORDS: WORDS, maskWords: maskWords, hasMasked: hasMasked, display: display,
    isRevealed: isRevealed, setRevealed: setRevealed, subscribe: subscribe,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    window.FS.maskWords = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
