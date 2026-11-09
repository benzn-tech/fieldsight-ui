/* ==========================================================================
   FieldSight topic wave — the real loudness of a topic's recordings
   --------------------------------------------------------------------------
   Reads each WAV as it downloads and keeps one peak per 100ms, so a two minute
   file becomes 1200 numbers and no audio stays in memory. Never invents a shape:
   a file that cannot be read draws nothing, and the player falls back to marking
   where someone spoke.

   Exported to: window.FS.topicWave (and CommonJS for tests)
   ========================================================================== */

(function () {
  'use strict';

  var PEAKS_PER_SEC = 10;
  /* A cap, not a limit expected in use: a 16kHz two minute file is about 4MB. */
  var MAX_BYTES_PER_FILE = 64 * 1024 * 1024;
  var MAX_CACHED_FILES = 300;

  function tag(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  /* `{ channels, rate, dataOffset }`; null when more bytes are needed. Throws on
     anything but 16-bit PCM, the only thing the recorder writes. */
  function parseHeader(b) {
    if (b.length < 12) return null;
    if (tag(b, 0) !== 'RIFF' || tag(b, 8) !== 'WAVE') throw new Error('not a wav');
    var o = 12;
    var fmt = null;
    while (o + 8 <= b.length) {
      var id = tag(b, o);
      var size = u32(b, o + 4);
      if (id === 'fmt ') {
        if (o + 24 > b.length) return null;
        fmt = { format: u16(b, o + 8), channels: u16(b, o + 10), rate: u32(b, o + 12), bits: u16(b, o + 22) };
        if (fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels || !fmt.rate) throw new Error('not 16-bit pcm');
      } else if (id === 'data') {
        if (!fmt) throw new Error('data before fmt');
        return { channels: fmt.channels, rate: fmt.rate, dataOffset: o + 8 };
      }
      o += 8 + size + (size % 2);
    }
    return null;
  }

  /* Fed the file in whatever pieces the network delivers. */
  function createPeakReader() {
    var head = new Uint8Array(0);
    var info = null;
    var peaks = [];
    var perPeak = 0;
    var count = 0;
    var max = 0;
    var carry = -1;

    function sample(v) {
      var a = Math.abs(v);
      if (a > max) max = a;
      count += 1;
      if (count >= perPeak) { peaks.push(max / 32768); count = 0; max = 0; }
    }
    function samples(b, from) {
      var i = from;
      if (carry >= 0 && i < b.length) {
        sample(((b[i] << 24) >> 16) | carry);
        carry = -1;
        i += 1;
      }
      for (; i + 1 < b.length; i += 2) sample(((b[i + 1] << 24) >> 16) | b[i]);
      if (i < b.length) carry = b[i];
    }
    return {
      feed: function (chunk) {
        if (info) { samples(chunk, 0); return; }
        var joined = new Uint8Array(head.length + chunk.length);
        joined.set(head);
        joined.set(chunk, head.length);
        info = parseHeader(joined);
        if (!info) { head = joined; return; }
        perPeak = Math.max(1, Math.round(info.rate / PEAKS_PER_SEC) * info.channels);
        samples(joined, info.dataOffset);
      },
      finish: function () {
        if (!info) throw new Error('no audio data');
        if (count > 0) { peaks.push(max / 32768); count = 0; max = 0; }
        return peaks;
      },
    };
  }

  /* One height per bar, 0..1. Scaled to this topic's own loud moments, because
     site recordings are quiet and would otherwise draw flat. Null when no file
     has been read, so the caller knows there is no shape to show. */
  function barsFor(timeline, peaksByFile, count) {
    if (!timeline.total || !(count > 0)) return null;
    var bars = new Array(count).fill(0);
    var any = false;
    timeline.items.forEach(function (item) {
      var peaks = peaksByFile[item.filename];
      if (!peaks) return;
      any = true;
      var n = Math.min(peaks.length, Math.ceil(item.duration * PEAKS_PER_SEC));
      for (var k = 0; k < n; k++) {
        var bar = Math.floor((item.start + k / PEAKS_PER_SEC) / timeline.total * count);
        if (bar >= 0 && bar < count && peaks[k] > bars[bar]) bars[bar] = peaks[k];
      }
    });
    if (!any) return null;
    var sorted = bars.filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
    var ref = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.98)] : 1;
    return bars.map(function (v) { return ref > 0 ? Math.sqrt(Math.min(1, v / ref)) : 0; });
  }

  var cache = {};
  var cached = [];

  function remember(filename, peaks) {
    if (!cache[filename]) cached.push(filename);
    cache[filename] = peaks;
    while (cached.length > MAX_CACHED_FILES) delete cache[cached.shift()];
  }

  /* Rejects when the file cannot be read; the abort signal stops the download. */
  function fetchPeaks(filename, url, signal) {
    if (cache[filename]) return Promise.resolve(cache[filename]);
    return window.fetch(url, { signal: signal }).then(function (res) {
      if (!res.ok || !res.body) throw new Error('status ' + res.status);
      var reader = res.body.getReader();
      var peakReader = createPeakReader();
      var bytes = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return null;
          bytes += r.value.length;
          peakReader.feed(r.value);
          if (bytes >= MAX_BYTES_PER_FILE) { reader.cancel(); return null; }
          return pump();
        });
      }
      return pump().then(function () {
        var peaks = peakReader.finish();
        remember(filename, peaks);
        return peaks;
      });
    });
  }

  var api = {
    PEAKS_PER_SEC: PEAKS_PER_SEC,
    parseHeader: parseHeader, createPeakReader: createPeakReader,
    barsFor: barsFor, fetchPeaks: fetchPeaks,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    window.FS.topicWave = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
