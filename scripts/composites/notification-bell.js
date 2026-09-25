/* ==========================================================================
   FieldSight · NotificationBell — reports you started, and voices to confirm
   --------------------------------------------------------------------------
   A report takes minutes to write. Before this, the only place its progress
   existed was the modal that started it, so asking for one meant standing
   still until it arrived -- in front of a client, if that is where you were.

   The bell is the answer to "is it done yet" from anywhere in the app. It
   reads window.FS.reportJobs, which owns the polling and survives a reload.

   TWO THINGS IT DELIBERATELY DOES NOT DO:

   It does not hold the download URL. Those are presigned and expire in
   fifteen minutes; the store asks for a fresh one when the button is pressed.
   A stored link would answer 403 later, and this bucket answers 403 for
   missing keys too, so it would not even read as expired.

   It does not announce itself. No toast, no sound, no dot that follows you
   across pages demanding attention. A count on a bell, and nothing until you
   look -- somebody on a site does not need this product interrupting them.

   TWO SOURCES, DELIBERATELY NOT MERGED INTO ONE LIST. A report is something you
   started and are waiting on; a voice to confirm is something waiting on YOU.
   Sorting them together by time would bury the second kind under the first, and
   the second kind is the one with a consequence: until twenty of them have been
   answered, a company has no calibrated threshold and every automatic name stays
   a guess with a question mark.

   Exposed as window.FieldSight.NotificationBell
   ========================================================================== */

(function () {
  'use strict';

  function fmtWhen(ts) {
    if (!ts) return '';
    var mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins === 1) return '1 min ago';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    return hrs === 1 ? '1 hour ago' : hrs + ' hours ago';
  }

  function JobRow(props) {
    var h = React.createElement;
    var job = props.job;
    var s_busy = React.useState(false);
    var busy = s_busy[0], setBusy = s_busy[1];
    var s_err = React.useState(null);
    var err = s_err[0], setErr = s_err[1];

    function download() {
      setBusy(true);
      setErr(null);
      window.FS.reportJobs.freshUrl(job.requestId).then(function (url) {
        setBusy(false);
        /* A real navigation, not window.open: a pop-up blocker eats the
           second one and the person is left pressing a button that does
           nothing. */
        var a = document.createElement('a');
        a.href = url;
        a.rel = 'noopener';
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.FS.reportJobs.markSeen(job.requestId);
      }).catch(function (e) {
        setBusy(false);
        setErr((e && e.message) || 'Could not fetch the report.');
      });
    }

    return h('li', {
      className: 'fs-bell__job fs-bell__job--' + job.status
                 + (job.seen ? '' : ' fs-bell__job--unseen'),
    },
      h('div', { className: 'fs-bell__job-head' },
        h('span', { className: 'fs-bell__job-label' }, job.label),
        h('button', {
          type: 'button',
          className: 'fs-bell__job-dismiss',
          title: 'Remove from this list',
          'aria-label': 'Remove ' + job.label + ' from this list',
          onClick: function () { window.FS.reportJobs.dismiss(job.requestId); },
        }, '×')),

      h('div', { className: 'fs-bell__job-meta' },
        [job.templateName, job.date, fmtWhen(job.startedAt)].filter(Boolean).join(' · ')),

      job.status === 'working'
        ? h('div', { className: 'fs-bell__job-status' },
            h('span', { className: 'fs-bell__spinner', 'aria-hidden': 'true' }),
            /* Says what is happening AND that leaving is fine. The whole
               point of the bell is that nobody has to wait here. */
            h('span', null, 'Writing it now — you can carry on; it will appear here.'))
        : null,

      job.status === 'done'
        ? h('div', { className: 'fs-bell__job-status' },
            h('button', {
              type: 'button',
              className: 'fs-btn fs-btn--primary fs-btn--sm',
              disabled: busy,
              onClick: download,
            }, busy ? 'Fetching…' : 'Download'),
            err ? h('span', { className: 'fs-bell__job-error' }, err) : null)
        : null,

      job.status === 'error'
        ? h('div', { className: 'fs-bell__job-status fs-bell__job-status--error' },
            /* The server's own sentence. It knows what went wrong and this
               panel does not, and a generic "failed" would send somebody
               looking at their own template. */
            h('span', null, job.error || 'The report could not be generated.'))
        : null,
    );
  }

  function VoiceRow(props) {
    var h = React.createElement;
    var p = props.person;
    return h('li', { className: 'fs-bell__row' },
      h('div', { className: 'fs-bell__row-main' },
        h('span', { className: 'fs-bell__row-title' }, p.displayName || 'Someone'),
        h('span', { className: 'fs-bell__row-sub' },
          p.pending + (p.pending === 1 ? ' passage' : ' passages') + ' that may be them')),
      h('button', {
        type: 'button',
        className: 'fs-bell__row-action',
        onClick: function () { props.onOpen(p); },
      }, 'Check'));
  }


  function NotificationBell() {
    var h = React.createElement;
    var jobsApi = (window.FS || {}).reportJobs;

    var s_open = React.useState(false);
    var open = s_open[0], setOpen = s_open[1];
    var s_jobs = React.useState(jobsApi ? jobsApi.list() : []);
    var jobs = s_jobs[0], setJobs = s_jobs[1];
    var voicesApi = (window.FS || {}).nameProposals;
    var s_voices = React.useState(voicesApi ? voicesApi.get() : { people: [], total: 0 });
    var voices = s_voices[0], setVoices = s_voices[1];

    React.useEffect(function () {
      if (!jobsApi) return undefined;
      setJobs(jobsApi.list());
      return jobsApi.subscribe(function (next) { setJobs(next); });
    }, []);

    React.useEffect(function () {
      if (!voicesApi) return undefined;
      return voicesApi.subscribe(function (next) { setVoices(next); });
    }, []);

    /* Close on Escape and on a click elsewhere. A panel that can only be
       closed by pressing the thing that opened it is a panel people leave
       open by accident. */
    React.useEffect(function () {
      if (!open) return undefined;
      function onKey(e) { if (e.key === 'Escape') setOpen(false); }
      function onDown(e) {
        var root = document.querySelector('.fs-bell');
        if (root && !root.contains(e.target)) setOpen(false);
      }
      document.addEventListener('keydown', onKey);
      document.addEventListener('mousedown', onDown);
      return function () {
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('mousedown', onDown);
      };
    }, [open]);

    /* Only gone when NEITHER source exists. Returning null because one is missing
       would remove the bell from a build where the other works. */
    if (!jobsApi && !voicesApi) return null;

    var unseen = jobsApi ? jobsApi.unseenCount() : 0;
    var busy = jobsApi ? jobsApi.working() : 0;
    var waiting = (voices && voices.total) || 0;
    /* One number, because two badges on one bell is a puzzle. The count is what
       is unread OR unanswered; the panel below says which is which. */
    var count = unseen + waiting;

    return h('div', { className: 'fs-bell' },
      h('button', {
        type: 'button',
        className: 'fs-utility-item fs-bell__btn'
                   + (busy ? ' fs-bell__btn--busy' : '')
                   /* `count`, not `unseen`: a bell showing a number but styled as
                      quiet is the state where the number gets ignored. */
                   + (count ? ' fs-bell__btn--unseen' : ''),
        'aria-label': (function () {
          var parts = [];
          if (busy) parts.push(busy + ' report' + (busy === 1 ? '' : 's') + ' being written');
          if (unseen) parts.push(unseen + ' finished report' + (unseen === 1 ? '' : 's'));
          if (waiting) parts.push(waiting + ' voice' + (waiting === 1 ? '' : 's') + ' to confirm');
          return parts.length ? parts.join(', ') : 'Reports and voices to confirm';
        })(),
        'aria-expanded': open ? 'true' : 'false',
        title: 'Reports and voices to confirm',
        onClick: function () {
          var next = !open;
          setOpen(next);
          /* Seen means looked at, so the REPORT count clears on opening rather
             than on downloading -- you have been told, which is what it counted.
             The voice count does NOT clear: it counts questions nobody has
             answered, and looking at a question is not answering it. */
          if (next && jobsApi) jobsApi.markAllSeen();
        },
      },
        window.FieldSight.NavIcon
          ? h(window.FieldSight.NavIcon, { name: 'bell', size: 16 })
          : h('span', { 'aria-hidden': 'true' }, '🔔'),
        /* The number is what is unread; a plain dot while something is still
           being written, because a count of in-flight work is not news. */
        count
          ? h('span', { className: 'fs-bell__badge' }, count > 9 ? '9+' : String(count))
          : (busy ? h('span', { className: 'fs-bell__dot', 'aria-hidden': 'true' }) : null),
      ),

      open
        ? h('div', { className: 'fs-bell__panel', role: 'dialog',
                     'aria-label': 'Reports and voices to confirm' },
            /* Voices first: they are waiting on the reader, reports are waiting
               on the machine. */
            waiting
              ? h('div', { className: 'fs-bell__section' },
                  h('div', { className: 'fs-bell__panel-head' },
                    h('span', null, 'Voices to confirm'),
                    h('span', { className: 'fs-bell__panel-count' },
                      voices.people.length
                      + (voices.people.length === 1 ? ' person' : ' people'))),
                  h('ul', { className: 'fs-bell__list' },
                    voices.people.map(function (p) {
                      return h(VoiceRow, {
                        key: p.voiceprintId,
                        person: p,
                        onOpen: function (person) {
                          setOpen(false);
                          /* The dialog owns the answering; the bell only points
                             at it. Two things that both write an answer would
                             be two places to get `source='correction'` wrong,
                             and that string is the whole mechanism. */
                          window.dispatchEvent(new CustomEvent('fs:open-name-proposals', {
                            detail: { voiceprintId: person.voiceprintId,
                                      displayName: person.displayName },
                          }));
                        },
                      });
                    })))
              : null,

            h('div', { className: 'fs-bell__section' },
              h('div', { className: 'fs-bell__panel-head' },
                h('span', null, 'Reports'),
                jobs.length
                  ? h('span', { className: 'fs-bell__panel-count' },
                      busy ? busy + ' in progress' : jobs.length + ' recent')
                  : null),
              jobs.length
                ? h('ul', { className: 'fs-bell__list' },
                    jobs.map(function (j) {
                      return h(JobRow, { key: j.requestId, job: j });
                    }))
                : h('p', { className: 'fs-bell__empty' },
                    /* Says where they come from. An empty panel that does not is
                       read as broken. */
                    'Reports you generate will appear here while they are being '
                    + 'written, and stay for a day once they are ready.')),

            /* Only when BOTH are empty, and it names the second kind so somebody
               who has never seen one knows what would put it here. */
            (!waiting && !jobs.length)
              ? h('p', { className: 'fs-bell__empty' },
                  'When you name a speaker, passages that may be the same person '
                  + 'will appear here to confirm.')
              : null)
        : null,
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.NotificationBell = NotificationBell;

})();
