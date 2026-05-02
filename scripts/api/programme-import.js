/* ==========================================================================
   FieldSight — programme-import.js  (Sprint 5.4)
   --------------------------------------------------------------------------
   Native CSV parser for Programme task import. No external dependencies —
   plain ES2017, safe to load as a plain <script> (no Babel required).

   Exported to: window.FS.api.programmeImport

   Public API:
     parseCSV(text) → { parents, leaves, errors, warnings }

   Column contract (order-independent, case-sensitive header names):
     task_id, wbs, parent_id, name, start, end, progress_pct, status,
     depends_on, assignees

   - depends_on and assignees are pipe-separated lists ("T-001|T-002")
   - parent_id empty or absent → treated as a group (status forced to 'group')
   - Groups come before their leaf children in the returned arrays
   - Errors block import; warnings are informational
   ========================================================================== */

/* global window */

(function () {
  'use strict';

  var REQUIRED_COLS = ['task_id', 'wbs', 'name', 'start', 'end', 'status'];
  var OPTIONAL_COLS = ['parent_id', 'progress_pct', 'depends_on', 'assignees'];
  var ALL_COLS = REQUIRED_COLS.concat(OPTIONAL_COLS);

  var VALID_STATUSES = ['not_started', 'in_progress', 'completed', 'delayed', 'blocked', 'group'];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  /* --- helpers ------------------------------------------------------------ */

  function stripBOM(text) {
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  }

  function normaliseLine(line) {
    /* CRLF → LF already done by split; trim trailing CR just in case */
    return line.replace(/\r$/, '').trim();
  }

  /* Minimal RFC-4180-ish CSV tokeniser.
     Handles quoted fields with embedded commas + doubled quotes.
     Does not handle multi-line fields (construction programme CSVs don't). */
  function tokeniseLine(line) {
    var fields = [];
    var i = 0;
    var len = line.length;
    while (i <= len) {
      if (i === len) { fields.push(''); break; }
      if (line[i] === '"') {
        /* quoted field */
        var j = i + 1;
        var buf = '';
        while (j < len) {
          if (line[j] === '"') {
            if (line[j + 1] === '"') { buf += '"'; j += 2; }
            else { j++; break; }
          } else {
            buf += line[j++];
          }
        }
        fields.push(buf);
        /* skip comma or end */
        if (line[j] === ',') j++;
        i = j;
      } else {
        /* unquoted field */
        var k = line.indexOf(',', i);
        if (k === -1) { fields.push(line.slice(i)); break; }
        fields.push(line.slice(i, k));
        i = k + 1;
      }
    }
    return fields;
  }

  function isValidDate(s) {
    if (!DATE_RE.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime());
  }

  function diffDays(a, b) {
    var da = new Date(a + 'T00:00:00Z');
    var db = new Date(b + 'T00:00:00Z');
    return Math.round((db - da) / 86400000);
  }

  function splitPipe(val) {
    if (!val) return [];
    return val.split('|').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /* --- main parser -------------------------------------------------------- */

  function parseCSV(text) {
    var errors   = [];
    var warnings = [];

    text = stripBOM(text || '');
    var rawLines = text.split('\n');
    var lines = rawLines.map(normaliseLine).filter(function (l) { return l.length > 0; });

    if (lines.length === 0) {
      errors.push({ row: 0, field: null, message: 'File is empty.' });
      return { parents: [], leaves: [], errors: errors, warnings: warnings };
    }

    /* --- header row ------------------------------------------------------- */
    var headerFields = tokeniseLine(lines[0]);
    var colIndex = {};
    headerFields.forEach(function (h, i) { colIndex[h.trim()] = i; });

    var missingCols = REQUIRED_COLS.filter(function (c) { return !(c in colIndex); });
    if (missingCols.length > 0) {
      errors.push({
        row: 1, field: null,
        message: 'Missing required columns: ' + missingCols.join(', ') + '.',
      });
      return { parents: [], leaves: [], errors: errors, warnings: warnings };
    }

    /* Warn about unrecognised columns (they are silently ignored). */
    headerFields.forEach(function (h) {
      var name = h.trim();
      if (name && ALL_COLS.indexOf(name) === -1) {
        warnings.push({ row: 1, field: name, message: 'Unknown column "' + name + '" will be ignored.' });
      }
    });

    function get(fields, col) {
      var idx = colIndex[col];
      return (idx !== undefined && idx < fields.length) ? (fields[idx] || '').trim() : '';
    }

    /* --- data rows -------------------------------------------------------- */
    var seenIds = {};
    var rawRows = [];

    for (var r = 1; r < lines.length; r++) {
      var rowNum = r + 1; /* 1-based, header is row 1 */
      var fields = tokeniseLine(lines[r]);

      var taskId    = get(fields, 'task_id');
      var wbs       = get(fields, 'wbs');
      var parentId  = get(fields, 'parent_id');
      var name      = get(fields, 'name');
      var start     = get(fields, 'start');
      var end       = get(fields, 'end');
      var progRaw   = get(fields, 'progress_pct');
      var status    = get(fields, 'status');
      var depsRaw   = get(fields, 'depends_on');
      var assignRaw = get(fields, 'assignees');

      /* Required fields */
      if (!taskId) { errors.push({ row: rowNum, field: 'task_id', message: 'Row ' + rowNum + ': task_id is required.' }); continue; }
      if (!name)   { errors.push({ row: rowNum, field: 'name',    message: 'Row ' + rowNum + ' (' + taskId + '): name is required.' }); continue; }
      if (!status) { errors.push({ row: rowNum, field: 'status',  message: 'Row ' + rowNum + ' (' + taskId + '): status is required.' }); continue; }

      /* Duplicate ID check */
      if (seenIds[taskId]) {
        errors.push({ row: rowNum, field: 'task_id', message: 'Row ' + rowNum + ': duplicate task_id "' + taskId + '".' });
        continue;
      }
      seenIds[taskId] = rowNum;

      /* Status validation */
      if (VALID_STATUSES.indexOf(status) === -1) {
        errors.push({
          row: rowNum, field: 'status',
          message: 'Row ' + rowNum + ' (' + taskId + '): invalid status "' + status + '". Expected: ' + VALID_STATUSES.join(', ') + '.',
        });
        continue;
      }

      /* Groups: parent_id must be empty; leaves: parent_id required */
      var isGroup = (status === 'group' || !parentId);
      if (isGroup && parentId) {
        warnings.push({ row: rowNum, field: 'parent_id', message: 'Row ' + rowNum + ' (' + taskId + '): group rows should have an empty parent_id (ignored).' });
        parentId = '';
      }

      /* Date validation (only for leaf tasks) */
      if (!isGroup) {
        if (!wbs) {
          errors.push({ row: rowNum, field: 'wbs', message: 'Row ' + rowNum + ' (' + taskId + '): wbs is required for leaf tasks.' });
          continue;
        }
        if (!start || !isValidDate(start)) {
          errors.push({ row: rowNum, field: 'start', message: 'Row ' + rowNum + ' (' + taskId + '): invalid start date "' + start + '". Expected YYYY-MM-DD.' });
          continue;
        }
        if (!end || !isValidDate(end)) {
          errors.push({ row: rowNum, field: 'end', message: 'Row ' + rowNum + ' (' + taskId + '): invalid end date "' + end + '". Expected YYYY-MM-DD.' });
          continue;
        }
        if (end < start) {
          errors.push({ row: rowNum, field: 'end', message: 'Row ' + rowNum + ' (' + taskId + '): end date must be ≥ start date.' });
          continue;
        }
      }

      /* Progress */
      var progressPct = progRaw === '' ? 0 : Number(progRaw);
      if (isNaN(progressPct) || progressPct < 0 || progressPct > 100) {
        errors.push({ row: rowNum, field: 'progress_pct', message: 'Row ' + rowNum + ' (' + taskId + '): progress_pct must be a number 0–100, got "' + progRaw + '".' });
        continue;
      }
      progressPct = Math.round(progressPct);

      var dependsOn = splitPipe(depsRaw);
      var assignees = splitPipe(assignRaw);

      rawRows.push({
        task_id:      taskId,
        wbs:          wbs,
        parent_id:    parentId,
        name:         name,
        start:        start,
        end:          end,
        duration_days: (start && end) ? diffDays(start, end) + 1 : null,
        progress_pct: progressPct,
        status:       isGroup ? 'group' : status,
        depends_on:   dependsOn,
        assignees:    assignees,
        /* Fields the fixture carries; default to empty for imports */
        resource_pool:       [],
        linked_action_items: [],
        tags:                [],
        baseline_start: start,
        baseline_end:   end,
        _isGroup:       isGroup,
      });
    }

    /* --- cross-row validation --------------------------------------------- */

    /* depends_on referencing IDs not present in the file */
    rawRows.forEach(function (row) {
      row.depends_on.forEach(function (depId) {
        if (!seenIds[depId]) {
          warnings.push({
            row: seenIds[row.task_id],
            field: 'depends_on',
            message: row.task_id + ': depends_on references unknown task_id "' + depId + '" (will be kept as-is).',
          });
        }
      });
    });

    /* leaf tasks referencing unknown parent_id */
    rawRows.forEach(function (row) {
      if (!row._isGroup && row.parent_id && !seenIds[row.parent_id]) {
        warnings.push({
          row: seenIds[row.task_id],
          field: 'parent_id',
          message: row.task_id + ': parent_id "' + row.parent_id + '" not found in file (task will still be imported).',
        });
      }
    });

    /* --- split + strip internal flag ------------------------------------- */
    var parents = rawRows.filter(function (r) { return r._isGroup; })
                          .map(function (r) { var o = Object.assign({}, r); delete o._isGroup; return o; });
    var leaves  = rawRows.filter(function (r) { return !r._isGroup; })
                          .map(function (r) { var o = Object.assign({}, r); delete o._isGroup; return o; });

    return { parents: parents, leaves: leaves, errors: errors, warnings: warnings };
  }

  /* --- attach -------------------------------------------------------------- */

  window.FS = window.FS || {};
  window.FS.api = window.FS.api || {};
  window.FS.api.programmeImport = { parseCSV: parseCSV };

}());
