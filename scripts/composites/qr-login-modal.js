/* ==========================================================================
   FieldSight QrLoginModal — Layer 5 composite (Web Task 3, 2026-07-30)
   --------------------------------------------------------------------------
   Renders a scannable terminal-login QR code with a live 90s countdown and
   a Regenerate action. Consumes:
     - window.FS.api.qrLogin.create()  → { code, expiresAt, ttlSeconds }
                                          or { _accessDenied: true, error }
     - window.FS.session.user.email    → embedded in the QR payload
     - window.qrcode(typeNumber, ecc)  → vendored qrcode-generator.js

   The QR payload is JSON `{ v, u, c, env }` — v=schema version, u=user
   email, c=one-time code, env=environment name. The code is never persisted
   (no localStorage) and never logged; it lives only in component state for
   the lifetime of the modal.

   Produces: window.FieldSight.QrLoginModal (props: { onClose }). Intended
   to be rendered as the content of ModalOverlay (composites/modal-overlay.js)
   by the caller, same as other Layer-5 modal composites.
   ========================================================================== */
(function () {
  'use strict';
  var e = React.createElement;

  function envString() {
    /* v1 web = prod. If a single build ever serves both, derive from the API base. */
    return (window.FS_ENV && window.FS_ENV.name) || 'prod';
  }

  function buildQrDataUrl(payloadObj) {
    var qr = window.qrcode(0, 'H');           /* type 0 = auto-fit; H = high ECC */
    qr.addData(JSON.stringify(payloadObj));
    qr.make();
    return qr.createDataURL(6, 4);            /* cellSize 6px, margin 4 cells */
  }

  function QrLoginModal(props) {
    var email = (window.FS.session && window.FS.session.user && window.FS.session.user.email) || '';
    var st = React.useState({ loading: true, error: null, dataUrl: null, expiresAt: 0 });
    var state = st[0], setState = st[1];
    var remaining = React.useState(0);
    var setRemaining = remaining[1];

    function refresh() {
      setState({ loading: true, error: null, dataUrl: null, expiresAt: 0 });
      window.FS.api.qrLogin.create().then(function (res) {
        if (res && res._accessDenied) { setState({ loading: false, error: res.error, dataUrl: null, expiresAt: 0 }); return; }
        var payload = { v: 1, u: email, c: res.code, env: envString() };
        setState({ loading: false, error: null, dataUrl: buildQrDataUrl(payload), expiresAt: res.expiresAt });
      }).catch(function (err) {
        setState({ loading: false, error: (err && err.message) || 'Could not create a login code', dataUrl: null, expiresAt: 0 });
      });
    }

    React.useEffect(function () { refresh(); }, []);

    /* Countdown tick. */
    React.useEffect(function () {
      if (!state.expiresAt) return;
      var t = setInterval(function () {
        var left = Math.max(0, state.expiresAt - Math.floor(Date.now() / 1000));
        setRemaining(left);
      }, 1000);
      return function () { clearInterval(t); };
    }, [state.expiresAt]);

    var left = Math.max(0, state.expiresAt - Math.floor(Date.now() / 1000));
    var expired = state.expiresAt && left <= 0;

    return e('div', { className: 'fs-qr-login' },
      e('h2', { className: 'fs-qr-login__title' }, 'Log in a terminal'),
      e('p', { className: 'fs-qr-login__hint' },
        'On the terminal, tap “Scan QR to Sign in” and point it at this code. Expires in 90 seconds.'),
      state.loading ? e('div', { className: 'fs-qr-login__status' }, 'Generating…') :
      state.error   ? e('div', { className: 'fs-qr-login__status fs-qr-login__status--error' }, state.error) :
        e('div', { className: 'fs-qr-login__code' },
          e('img', { className: 'fs-qr-login__img' + (expired ? ' fs-qr-login__img--expired' : ''),
                     src: state.dataUrl, alt: 'Login QR code', width: 240, height: 240 }),
          e('div', { className: 'fs-qr-login__ttl' },
            expired ? 'Expired' : ('Expires in ' + left + 's'))
        ),
      e('div', { className: 'fs-qr-login__actions' },
        e('button', { className: 'fs-btn fs-btn--secondary', onClick: refresh, disabled: state.loading }, 'Regenerate'),
        e('button', { className: 'fs-btn', onClick: props.onClose }, 'Done')
      )
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.QrLoginModal = QrLoginModal;
})();
