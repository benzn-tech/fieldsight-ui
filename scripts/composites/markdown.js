/* ==========================================================================
   FieldSight renderMarkdown — tiny, dependency-free, XSS-safe markdown → HTML.
   --------------------------------------------------------------------------
   The Ask agent (and any future RAG answer) returns markdown; this turns it
   into a small, fixed set of safe HTML tags for display.

   SECURITY MODEL: every raw line is HTML-escaped FIRST (escapeHtml), so any
   `<script>` / `<img onerror=…>` / raw HTML in the LLM output becomes inert
   text. Only AFTER escaping do we introduce tags — and only from this closed
   set: p, br, strong, em, code, pre, ul, ol, li, h1–h3, a. Link hrefs are
   validated to http(s)/relative, otherwise the link is dropped to plain text.
   Because nothing the model wrote can reach the DOM as markup, the result is
   safe to hand to dangerouslySetInnerHTML.

   No build step, no library (CSP blocks CDNs). Exported to
   window.FieldSight.renderMarkdown(mdString) -> htmlString.
   ========================================================================== */
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Inline spans. INPUT MUST ALREADY BE HTML-ESCAPED. Emits only strong/em/
     code/a. Order matters: code first (so * inside `code` isn't touched),
     then links, then bold before italic. */
  function inline(escaped) {
    var s = escaped;
    s = s.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, text, url) {
      // url is already HTML-escaped; validate scheme (http/https or relative).
      if (!/^(https?:\/\/|\/|#)/.test(url)) return text;
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
    return s;
  }

  function renderMarkdown(md) {
    if (!md) return '';
    var lines = String(md).replace(/\r\n/g, '\n').split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];

      /* fenced code block ``` */
      if (/^\s*```/.test(line)) {
        var buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(escapeHtml(lines[i])); i++; }
        i++; /* skip closing fence */
        out.push('<pre><code>' + buf.join('\n') + '</code></pre>');
        continue;
      }

      /* headings # / ## / ### */
      var h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        var lvl = h[1].length;
        out.push('<h' + lvl + '>' + inline(escapeHtml(h[2])) + '</h' + lvl + '>');
        i++;
        continue;
      }

      /* unordered list */
      if (/^\s*[-*]\s+/.test(line)) {
        var uli = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          uli.push('<li>' + inline(escapeHtml(lines[i].replace(/^\s*[-*]\s+/, ''))) + '</li>');
          i++;
        }
        out.push('<ul>' + uli.join('') + '</ul>');
        continue;
      }

      /* ordered list */
      if (/^\s*\d+\.\s+/.test(line)) {
        var oli = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          oli.push('<li>' + inline(escapeHtml(lines[i].replace(/^\s*\d+\.\s+/, ''))) + '</li>');
          i++;
        }
        out.push('<ol>' + oli.join('') + '</ol>');
        continue;
      }

      /* blank line → paragraph break */
      if (/^\s*$/.test(line)) { i++; continue; }

      /* paragraph: consecutive plain lines, joined with <br> */
      var para = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^(#{1,3})\s/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !/^\s*```/.test(lines[i])
      ) {
        para.push(inline(escapeHtml(lines[i])));
        i++;
      }
      out.push('<p>' + para.join('<br>') + '</p>');
    }
    return out.join('');
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.renderMarkdown = renderMarkdown;
})();
