/* ==========================================================================
   FieldSight LoginScreen — Layer 5 composite (Sprint 2.9 / Phase I)
   --------------------------------------------------------------------------
   Cognito USER_PASSWORD_AUTH + NEW_PASSWORD_REQUIRED challenge flow, plus
   self-service password reset (ForgotPassword / ConfirmForgotPassword).

   Used only when window.FS.api.useMocks === false. The shell mounts
   this in place of AppShell whenever FS.session has no live token.

   Three screens, driven by local state:
     • 'signIn' — username + password form
     • 'newPwd' — set new password (Cognito's first-login flow)
     • 'forgot' — two-step self-service password reset:
         step 1: email → FS.cognito.forgotPassword() sends a code
         step 2: code + new password → FS.cognito.confirmForgotPassword()

   Accounts are provisioned by site administrators only — there is
   intentionally no self-registration anywhere in this screen.

   Security notes:
     - Passwords and reset codes live only in transient React state for
       the controlled inputs; they are never console-logged, never written
       to localStorage/sessionStorage, and are cleared from state as soon
       as a flow completes or is abandoned (see backToSignIn/onSubmitForgotStep2).
     - Show/hide password toggles default to hidden (type="password").

   On successful authentication we populate FS.session via .set() and
   then call /api/sites to derive the role + display_name (since the
   Cognito JWT alone doesn't carry our app-specific role payload).
   The shell observes session.onChange and re-renders past this screen
   automatically.

   Props:
     onSignedIn  () => void  — optional callback after successful sign-in

   Exported to:
     window.FieldSight.LoginScreen
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function friendlyForgotError(err, step) {
    var code = (err && err.code) || '';
    if (/UserNotFoundException/.test(code)) {
      return 'No account found with that email. Check the address, or contact your site administrator.';
    }
    if (/CodeMismatchException/.test(code)) {
      return "That code doesn't match. Double-check it and try again.";
    }
    if (/ExpiredCodeException/.test(code)) {
      return 'That code has expired. Go back and request a new one.';
    }
    if (/InvalidPasswordException/.test(code)) {
      return 'Password does not meet requirements — use at least 8 characters, with a mix of letters and numbers.';
    }
    if (/(LimitExceeded|TooManyRequests)Exception/.test(code)) {
      return 'Too many attempts. Please wait a few minutes and try again.';
    }
    if (/InvalidParameterException/.test(code) && step === 1) {
      return 'Enter a valid email address.';
    }
    return (err && err.message) || 'Something went wrong. Please try again.';
  }

  function LoginScreen(props) {
    var Button = window.FieldSight.Button;

    var refMode = React.useState('signIn');  /* 'signIn' | 'newPwd' | 'forgot' */
    var mode    = refMode[0];
    var setMode = refMode[1];

    var refForm = React.useState({ username: '', password: '', newPassword: '' });
    var form    = refForm[0];
    var setForm = refForm[1];

    var refSession = React.useState({ challengeSession: null });
    var pending    = refSession[0];
    var setPending = refSession[1];

    var refStatus = React.useState({ phase: 'idle' });
    var status    = refStatus[0];
    var setStatus = refStatus[1];

    /* Show/hide toggles — one bit of state per password field, default hidden. */
    var refShowPassword = React.useState(false);
    var showPassword    = refShowPassword[0];
    var setShowPassword = refShowPassword[1];

    var refShowNewPassword = React.useState(false);
    var showNewPassword    = refShowNewPassword[0];
    var setShowNewPassword = refShowNewPassword[1];

    var refShowForgotPassword = React.useState(false);
    var showForgotPassword    = refShowForgotPassword[0];
    var setShowForgotPassword = refShowForgotPassword[1];

    /* Forgot-password flow state. */
    var refForgotStep = React.useState(1); /* 1 | 2 */
    var forgotStep    = refForgotStep[0];
    var setForgotStep = refForgotStep[1];

    var refForgotForm = React.useState({ email: '', code: '', newPassword: '' });
    var forgotForm    = refForgotForm[0];
    var setForgotForm = refForgotForm[1];

    var refForgotStatus = React.useState({ phase: 'idle' }); /* idle|submitting|error */
    var forgotStatus    = refForgotStatus[0];
    var setForgotStatus = refForgotStatus[1];

    /* One-off confirmation shown back on the sign-in screen after a
       successful reset. */
    var refResetNotice = React.useState(null);
    var resetNotice    = refResetNotice[0];
    var setResetNotice = refResetNotice[1];

    function update(field, val) {
      setForm(function (f) {
        var next = Object.assign({}, f);
        next[field] = val;
        return next;
      });
    }

    function updateForgot(field, val) {
      setForgotForm(function (f) {
        var next = Object.assign({}, f);
        next[field] = val;
        return next;
      });
    }

    /* Hydrate real identity via GET /api/org/me. Three cases (spec §8b):
       - 200 active            → full identity, orgStatus 'active'.
       - 200 + archived_at     → real identity + orgStatus 'archived' (backend
                                  lets an archived caller read /me so the UI can
                                  surface it; visible banner is batch 2b).
       - 403/404 unprovisioned → a clearly-non-default read-only placeholder so
                                  we never show the default mock persona; flagged
                                  orgStatus 'unprovisioned' for the 2b banner. */
    async function hydrateUser() {
      try {
        var me = await window.FS.api.org.getMe();
        if (me && (me._accessDenied || me._notFound)) {
          window.FS.session.set({
            user: {
              role:         'worker',
              display_name: 'Account not provisioned',
              orgStatus:    'unprovisioned',
            },
          });
          console.warn('[login] org account not provisioned/denied — read-only (2b banner pending)');
          return;
        }
        window.FS.session.set({
          user: {
            sub:          me.cognito_sub,
            email:        me.email,
            role:         me.global_role,
            display_name: [me.first_name, me.last_name].filter(Boolean).join(' '),
            sites:        me.site_ids || [],
            orgStatus:    me.archived_at ? 'archived' : 'active',
          },
        });
        /* THIS account's avatar for the nav (the bridge just cleared any
           cross-account leftover). Fire-and-forget: nav shows initials
           until it resolves; page refreshes fall back to initials too
           (hydrateUser only runs at sign-in — acceptable, settings
           re-resolves on open). */
        if (me.avatar_s3_key && window.FS.api.org.resolveAssetUrl) {
          window.FS.api.org.resolveAssetUrl(me.avatar_s3_key).then(function (url) {
            if (url && window.AuthMock && window.AuthMock.updateProfile) {
              window.AuthMock.updateProfile({ avatarUrl: url });
            }
          }).catch(function () {});
        }
      } catch (err) {
        console.warn('[login] could not load /api/org/me', err);
      }
    }

    async function onSubmitSignIn(e) {
      e.preventDefault();
      if (!form.username || !form.password) return;
      setResetNotice(null);
      setStatus({ phase: 'submitting' });
      try {
        var res = await window.FS.cognito.signIn(form.username, form.password);
        if (res.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
          setPending({ challengeSession: res.Session });
          setMode('newPwd');
          setStatus({ phase: 'idle' });
          return;
        }
        var auth = res.AuthenticationResult || {};
        window.FS.session.set({
          idToken:      auth.IdToken,
          accessToken:  auth.AccessToken,
          refreshToken: auth.RefreshToken,
          expiresIn:    auth.ExpiresIn || 3600,
        });
        await hydrateUser();
        setStatus({ phase: 'done' });
        if (props.onSignedIn) props.onSignedIn();
      } catch (err) {
        setStatus({ phase: 'error', error: err });
      }
    }

    async function onSubmitNewPassword(e) {
      e.preventDefault();
      if (!form.newPassword) return;
      setStatus({ phase: 'submitting' });
      try {
        var res = await window.FS.cognito.respondToChallenge({
          challengeName: 'NEW_PASSWORD_REQUIRED',
          session:       pending.challengeSession,
          username:      form.username,
          newPassword:   form.newPassword,
        });
        var auth = res.AuthenticationResult || {};
        window.FS.session.set({
          idToken:      auth.IdToken,
          accessToken:  auth.AccessToken,
          refreshToken: auth.RefreshToken,
          expiresIn:    auth.ExpiresIn || 3600,
        });
        await hydrateUser();
        setStatus({ phase: 'done' });
        if (props.onSignedIn) props.onSignedIn();
      } catch (err) {
        setStatus({ phase: 'error', error: err });
      }
    }

    function enterForgotMode() {
      setForgotForm(function (f) {
        return Object.assign({}, f, { email: form.username || f.email });
      });
      setForgotStep(1);
      setForgotStatus({ phase: 'idle' });
      setShowForgotPassword(false);
      setResetNotice(null);
      setMode('forgot');
    }

    function backToSignIn() {
      /* Drop any in-flight code/new-password from state — they have no
         reason to linger once the user steps away from this flow. */
      setForgotForm(function (f) { return { email: f.email, code: '', newPassword: '' }; });
      setForgotStep(1);
      setForgotStatus({ phase: 'idle' });
      setShowForgotPassword(false);
      setMode('signIn');
    }

    async function onSubmitForgotStep1(e) {
      e.preventDefault();
      if (!forgotForm.email) return;
      setForgotStatus({ phase: 'submitting' });
      try {
        await window.FS.cognito.forgotPassword(forgotForm.email);
        setForgotStatus({ phase: 'idle' });
        setForgotStep(2);
      } catch (err) {
        setForgotStatus({ phase: 'error', error: err });
      }
    }

    async function onSubmitForgotStep2(e) {
      e.preventDefault();
      if (!forgotForm.code || !forgotForm.newPassword) return;
      setForgotStatus({ phase: 'submitting' });
      try {
        await window.FS.cognito.confirmForgotPassword(
          forgotForm.email, forgotForm.code, forgotForm.newPassword
        );
        /* Success — clear the code/new-password out of state immediately. */
        setForgotForm({ email: forgotForm.email, code: '', newPassword: '' });
        setForgotStatus({ phase: 'idle' });
        setForgotStep(1);
        setShowForgotPassword(false);
        update('username', forgotForm.email);
        setResetNotice('Password reset — sign in with your new password.');
        setMode('signIn');
      } catch (err) {
        setForgotStatus({ phase: 'error', error: err });
      }
    }

    /* Shared show/hide password field — one toggle bit per field, always
       starts hidden (type="password"). */
    function renderPasswordField(opts) {
      return React.createElement('label', { className: 'fs-login__field' },
        React.createElement('span', { className: 'fs-login__label' }, opts.label),
        React.createElement('div', { className: 'fs-login__input-wrap' },
          React.createElement('input', {
            type:  opts.show ? 'text' : 'password',
            autoComplete: opts.autoComplete,
            value: opts.value,
            onChange: opts.onChange,
            className: 'fs-login__input fs-login__input--with-toggle',
            required: true,
            minLength: opts.minLength,
          }),
          React.createElement('button', {
            type: 'button',
            className: 'fs-login__toggle-pw',
            'aria-label': opts.show ? 'Hide password' : 'Show password',
            onClick: opts.onToggleShow,
          }, opts.show ? 'Hide' : 'Show'),
        ),
      );
    }

    var submitting = status.phase === 'submitting';
    var errMessage = status.phase === 'error'
      ? (status.error && status.error.message) || 'Sign-in failed'
      : null;

    var forgotSubmitting = forgotStatus.phase === 'submitting';
    var forgotErrMessage = forgotStatus.phase === 'error'
      ? friendlyForgotError(forgotStatus.error, forgotStep)
      : null;

    var caption =
      mode === 'signIn' ? 'Sign in with your FieldSight account' :
      mode === 'newPwd' ? 'Set a new password to finish signing in' :
      forgotStep === 1  ? 'Reset your password' :
                          'Enter the code we emailed you';

    var body;
    if (mode === 'signIn') {
      body = [
        resetNotice ? React.createElement('div', {
          key: 'reset-notice', className: 'fs-login__success',
        }, resetNotice) : null,
        React.createElement('form', {
          key: 'form', className: 'fs-login__form', onSubmit: onSubmitSignIn,
        },
          React.createElement('label', { className: 'fs-login__field' },
            React.createElement('span', { className: 'fs-login__label' }, 'Email'),
            React.createElement('input', {
              type:  'email', autoComplete: 'username',
              value: form.username,
              onChange: function (e) { update('username', e.target.value); },
              className: 'fs-login__input',
              required: true,
            }),
          ),
          renderPasswordField({
            label: 'Password',
            value: form.password,
            onChange: function (e) { update('password', e.target.value); },
            autoComplete: 'current-password',
            show: showPassword,
            onToggleShow: function () { setShowPassword(function (v) { return !v; }); },
          }),
          errMessage ? React.createElement('div', {
            className: 'fs-login__error',
          }, errMessage) : null,
          React.createElement(Button, {
            type:     'submit',
            disabled: submitting,
            size:     'md',
          }, submitting ? 'Signing in…' : 'Sign in'),
        ),
        React.createElement('button', {
          key: 'forgot-link',
          type: 'button',
          className: 'fs-login__link',
          onClick: enterForgotMode,
        }, 'Forgot password?'),
        React.createElement('div', {
          key: 'invite-hint', className: 'fs-login__invite-hint',
        }, 'Accounts are created by your site administrator.'),
      ];
    } else if (mode === 'newPwd') {
      body = React.createElement('form', {
        className: 'fs-login__form', onSubmit: onSubmitNewPassword,
      },
        React.createElement('div', { className: 'fs-login__hint' },
          'Signing in as ' + form.username),
        renderPasswordField({
          label: 'New password',
          value: form.newPassword,
          onChange: function (e) { update('newPassword', e.target.value); },
          autoComplete: 'new-password',
          show: showNewPassword,
          onToggleShow: function () { setShowNewPassword(function (v) { return !v; }); },
          minLength: 8,
        }),
        errMessage ? React.createElement('div', {
          className: 'fs-login__error',
        }, errMessage) : null,
        React.createElement(Button, {
          type:     'submit',
          disabled: submitting,
          size:     'md',
        }, submitting ? 'Updating…' : 'Set password and continue'),
      );
    } else { /* mode === 'forgot' */
      body = forgotStep === 1
        ? React.createElement('form', {
            className: 'fs-login__form', onSubmit: onSubmitForgotStep1,
          },
            React.createElement('label', { className: 'fs-login__field' },
              React.createElement('span', { className: 'fs-login__label' }, 'Email'),
              React.createElement('input', {
                type: 'email', autoComplete: 'username',
                value: forgotForm.email,
                onChange: function (e) { updateForgot('email', e.target.value); },
                className: 'fs-login__input',
                required: true,
              }),
            ),
            forgotErrMessage ? React.createElement('div', {
              className: 'fs-login__error',
            }, forgotErrMessage) : null,
            React.createElement(Button, {
              type:     'submit',
              disabled: forgotSubmitting,
              size:     'md',
            }, forgotSubmitting ? 'Sending…' : 'Send reset code'),
            React.createElement('button', {
              type: 'button',
              className: 'fs-login__link',
              onClick: backToSignIn,
            }, '← Back to sign in'),
          )
        : React.createElement('form', {
            className: 'fs-login__form', onSubmit: onSubmitForgotStep2,
          },
            React.createElement('div', { className: 'fs-login__hint' },
              'Code sent to your email.'),
            React.createElement('label', { className: 'fs-login__field' },
              React.createElement('span', { className: 'fs-login__label' }, 'Reset code'),
              React.createElement('input', {
                type: 'text', inputMode: 'numeric', autoComplete: 'one-time-code',
                value: forgotForm.code,
                onChange: function (e) { updateForgot('code', e.target.value); },
                className: 'fs-login__input',
                required: true,
              }),
            ),
            renderPasswordField({
              label: 'New password',
              value: forgotForm.newPassword,
              onChange: function (e) { updateForgot('newPassword', e.target.value); },
              autoComplete: 'new-password',
              show: showForgotPassword,
              onToggleShow: function () { setShowForgotPassword(function (v) { return !v; }); },
              minLength: 8,
            }),
            forgotErrMessage ? React.createElement('div', {
              className: 'fs-login__error',
            }, forgotErrMessage) : null,
            React.createElement(Button, {
              type:     'submit',
              disabled: forgotSubmitting,
              size:     'md',
            }, forgotSubmitting ? 'Resetting…' : 'Reset password'),
            React.createElement('button', {
              type: 'button',
              className: 'fs-login__link',
              onClick: backToSignIn,
            }, '← Back to sign in'),
          );
    }

    return React.createElement('div', { className: 'fs-login' },
      React.createElement('div', { className: 'fs-login__card' },
        React.createElement('img', {
          src: 'assets/logo.png?v=1', alt: '',
          className: 'fs-login__logo',
          style: { width: '76px', height: 'auto', display: 'block', margin: '0 auto 14px' },
        }),
        React.createElement('div', { className: 'fs-login__brand' }, 'FieldSight'),
        React.createElement('div', { className: 'fs-login__caption' }, caption),
        body,
      ),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.LoginScreen = LoginScreen;
})();
