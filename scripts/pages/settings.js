/* ==========================================================================
   FieldSight Settings Page — Sprint 7.3 / 7.6 + account area (Phase A)
   --------------------------------------------------------------------------
   /settings — tabbed account area:
     • Preferences   — theme + density + default landing (original Sprint 7)
     • Profile       — avatar, name, email, time/date format, timezone
     • Security      — password change, two-factor authentication (mock)
     • Notifications — global email notification preferences

   All prefs are localStorage-only (mock prototype); documented as the
   /api/user/prefs migration target. Auth/security data stays out of
   localStorage where it matters (the real password change is Cognito).

   Registers as window.FieldSight.PAGES['/settings']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var LANDING_KEY  = 'fs.settings.defaultLanding';
  var PROFILE_KEY  = 'fs.settings.profile';
  /* Live mode: scope the stored profile to the signed-in account — the
     plain global key let one account's saved profile (avatar!) leak into
     the next account signed in on the same browser. Mock keeps the global
     key (single persona, persistence across reloads is the feature). */
  function profileKey() {
    var u = (window.FS && window.FS.session && window.FS.session.user) || {};
    return u.sub ? PROFILE_KEY + '.' + u.sub : PROFILE_KEY;
  }
  var NOTIF_KEY    = 'fs.settings.notifications';
  var SECURITY_KEY = 'fs.settings.security';

  /* ---------- localStorage helpers -------------------------------------- */
  function readJSON(key)  { try { return JSON.parse(localStorage.getItem(key) || 'null') || {}; } catch (_) { return {}; } }
  function writeJSON(k, o) { try { localStorage.setItem(k, JSON.stringify(o)); } catch (_) {} }
  function readLandingOverride() { try { return localStorage.getItem(LANDING_KEY) || null; } catch (_) { return null; } }
  function writeLandingOverride(p) { try { if (p) localStorage.setItem(LANDING_KEY, p); else localStorage.removeItem(LANDING_KEY); } catch (_) {} }
  function readThemeStored()   { return window.FS && window.FS.theme ? window.FS.theme.getStored() : 'auto'; }
  function readThemeResolved() { return window.FS && window.FS.theme ? window.FS.theme.get() : 'light'; }
  function readDensityStored() { return window.FS && window.FS.density ? window.FS.density.getStored() : 'comfortable'; }
  function toast(message, tone) { if (window.FS && window.FS.toast) window.FS.toast.show({ message: message, tone: tone || 'success' }); }
  /* Module-scope (not Provider-closure) so ProfileTab's onPick can reach it
     without threading a helper through ctx — matches toast()'s pattern above. */
  function orgLive() { return !!(window.FS && window.FS.api && !window.FS.api.useMocks && window.FS.api.orgBaseUrl && window.FS.api.org); }

  /* ---------- option data ----------------------------------------------- */
  var TABS = [
    { key: 'preferences',   label: 'Preferences' },
    { key: 'profile',       label: 'Profile' },
    { key: 'security',      label: 'Security' },
    { key: 'notifications', label: 'Notifications' },
  ];
  var TIME_FORMATS = [{ v: '24h', l: '24-hour (14:30)' }, { v: '12h', l: '12-hour (2:30 PM)' }];
  var DATE_FORMATS = [{ v: 'DD/MM/YYYY', l: 'DD/MM/YYYY' }, { v: 'MM/DD/YYYY', l: 'MM/DD/YYYY' }, { v: 'YYYY-MM-DD', l: 'YYYY-MM-DD' }];
  var TIMEZONES = [
    'Pacific/Auckland', 'Australia/Sydney', 'Australia/Brisbane', 'Asia/Singapore',
    'Asia/Shanghai', 'Asia/Kolkata', 'Europe/London', 'America/Los_Angeles',
    'America/New_York', 'UTC',
  ];
  var FREQ_OPTS = [
    { v: 'instant', l: 'Instant' }, { v: 'hourly', l: '1 hour' },
    { v: 'daily', l: '24 hours' }, { v: 'weekly', l: 'Weekly' },
  ];
  var EVENT_TYPES = [
    { k: 'comment_added', l: 'Comment added' }, { k: 'status_changed', l: 'Status changed' },
    { k: 'issue_completed', l: 'Issue completed' }, { k: 'title_changed', l: 'Title changed' },
    { k: 'markup_changed', l: 'Markup changed' }, { k: 'type_changed', l: 'Type changed' },
    { k: 'priority_changed', l: 'Priority changed' }, { k: 'deadline_changed', l: 'Deadline changed' },
    { k: 'assignee_changed', l: 'Assignee changed' }, { k: 'reporter_changed', l: 'Reporter changed' },
    { k: 'watchers_changed', l: 'Watchers changed' }, { k: 'visibility_changed', l: 'Visibility changed' },
    { k: 'tags_changed', l: 'Tags changed' },
  ];

  function defaultNotifications() {
    var events = {};
    EVENT_TYPES.forEach(function (e) { events[e.k] = true; });
    events.type_changed = false; events.reporter_changed = false;
    events.watchers_changed = false; events.visibility_changed = false; events.tags_changed = false;
    return { frequency: 'daily', events: events, watched_by_me: true, assigned_to_me: true };
  }

  function deriveProfile() {
    var saved = readJSON(profileKey());
    var u = (window.AuthMock && window.AuthMock.currentUser) || {};
    var parts = (u.name || '').split(' ');
    return {
      firstName:    saved.firstName    != null ? saved.firstName    : (u.firstName || parts[0] || ''),
      lastName:     saved.lastName     != null ? saved.lastName     : (u.lastName || parts.slice(1).join(' ') || ''),
      email:        saved.email        != null ? saved.email        : (u.email || ''),
      avatarUrl:    saved.avatarUrl    != null ? saved.avatarUrl    : (u.avatarUrl || null),
      timeFormat:   saved.timeFormat   || '24h',
      dateFormat:   saved.dateFormat   || 'DD/MM/YYYY',
      autoTimezone: saved.autoTimezone != null ? saved.autoTimezone : false,
      timezone:     saved.timezone     || 'Pacific/Auckland',
    };
  }

  /* ---------- Context --------------------------------------------------- */
  var SettingsContext = React.createContext(null);

  function SettingsProvider(props) {
    var refTab      = React.useState('preferences');
    var refState    = React.useState(function () {
      return { themeStored: readThemeStored(), themeResolved: readThemeResolved(), densityStored: readDensityStored(), landingOverride: readLandingOverride() };
    });
    var refProfile  = React.useState(deriveProfile);
    var refNotif    = React.useState(function () {
      var d = defaultNotifications(); var s = readJSON(NOTIF_KEY);
      return Object.assign(d, s, { events: Object.assign({}, d.events, s.events || {}) });
    });
    var refSecurity = React.useState(function () { var s = readJSON(SECURITY_KEY); return { twoFactor: !!s.twoFactor }; });

    var state = refState[0], setState = refState[1];

    /* Batch 2b task 2: shared setter so the mount effect below and ctxObj's
       patchProfile stay in sync (single merge implementation). */
    function patchProfile(patch) { refProfile[1](function (p) { return Object.assign({}, p, patch); }); }

    /* Live mode only — hydrate identity fields (name/email) and avatar from
       the real org profile once on mount; deriveProfile() already covers
       mock mode and first paint. Format/timezone prefs are untouched here.
       Guarded against unmount, and against a resolved avatar clobbering an
       image the user already picked while getMe()/resolveAssetUrl() were
       still in flight (checked via functional setState against the LATEST
       profile, not a closed-over snapshot). */
    React.useEffect(function () {
      var cancelled = false;
      if (orgLive()) {
        window.FS.api.org.getMe().then(function (me) {
          if (cancelled || !me || me._accessDenied || me._notFound) return;
          patchProfile({ firstName: me.first_name, lastName: me.last_name, email: me.email,
            company: me.company_name || null, role: me.global_role || null });
          if (me.avatar_s3_key) {
            window.FS.api.org.resolveAssetUrl(me.avatar_s3_key).then(function (url) {
              if (cancelled || !url) return;
              refProfile[1](function (prev) {
                return prev._pendingAvatarKey ? prev : Object.assign({}, prev, { avatarUrl: url });
              });
            });
          }
        }).catch(function (err) { console.warn('[settings] could not load /api/org/me', err); });
      }
      return function () { cancelled = true; };
    }, []);

    function ctxObj() {
      return {
        tab: refTab[0], setTab: refTab[1],
        state: state, user: (window.AuthMock && window.AuthMock.currentUser) || {},
        setTheme: function (m) { if (window.FS && window.FS.theme) window.FS.theme.set(m); setState(function (s) { return Object.assign({}, s, { themeStored: readThemeStored(), themeResolved: readThemeResolved() }); }); },
        setDensity: function (m) { if (window.FS && window.FS.density) window.FS.density.set(m); setState(function (s) { return Object.assign({}, s, { densityStored: readDensityStored() }); }); },
        setLanding: function (p) { writeLandingOverride(p || null); setState(function (s) { return Object.assign({}, s, { landingOverride: p || null }); }); },

        profile: refProfile[0], setProfile: refProfile[1],
        patchProfile: patchProfile,
        saveProfile: function () {
          var p = refProfile[0];
          /* Takes the final profile object to persist (not a closed-over var).
             LIVE GUARD (review fix batch 2c): never persist a presigned https
             URL — it expires in 15 minutes, and localStorage/AuthMock feed the
             sidebar avatar on every later boot, which would render a
             permanently broken <img>. Durable values are data-URIs (and null);
             an https avatarUrl in live mode keeps the previously stored one. */
          function commitLocal(finalProfile) {
            var toStore = finalProfile;
            if (orgLive() && /^https?:/.test(finalProfile.avatarUrl || '')) {
              var prev = readJSON(profileKey());
              toStore = Object.assign({}, finalProfile, { avatarUrl: prev.avatarUrl || null });
            }
            writeJSON(profileKey(), toStore);
            if (window.AuthMock && window.AuthMock.updateProfile) {
              window.AuthMock.updateProfile({ firstName: toStore.firstName, lastName: toStore.lastName, email: toStore.email, avatarUrl: toStore.avatarUrl });
            }
            toast('Profile saved');
          }
          if (orgLive()) {
            var body = { first_name: p.firstName, last_name: p.lastName };
            var sentAvatar = !!p._pendingAvatarKey;
            if (sentAvatar) body.avatar_s3_key = p._pendingAvatarKey;
            window.FS.api.org.updateProfile(body).then(function (res) {
              if (!sentAvatar) { commitLocal(p); return; }
              window.FS.api.org.resolveAssetUrl(res && res.avatar_s3_key).then(function (url) {
                /* React state gets the fresh presigned URL for display; the
                   PERSISTED copy keeps the data-URI preview (p.avatarUrl at
                   save time is the picked data-URI — the hydrate effect skips
                   overwriting while _pendingAvatarKey is set), so nothing
                   expiring ever lands in localStorage/AuthMock. */
                patchProfile({ avatarUrl: url || p.avatarUrl, _pendingAvatarKey: undefined });
                commitLocal(Object.assign({}, p, { _pendingAvatarKey: undefined }));
              });
            }).catch(function (err) {
              console.warn('[settings] could not save /api/org/me', err);
              toast(sentAvatar ? 'Could not save profile — image upload may have expired, re-upload it' : 'Could not save profile', 'error');
            });
          } else {
            commitLocal(p);
          }
        },
        resetProfile: function () { refProfile[1](deriveProfile()); toast('Reverted to saved profile', 'info'); },

        notif: refNotif[0], setNotif: refNotif[1],
        patchNotif: function (patch) { refNotif[1](function (n) { return Object.assign({}, n, patch); }); },
        toggleEvent: function (k) { refNotif[1](function (n) { var e = Object.assign({}, n.events); e[k] = !e[k]; return Object.assign({}, n, { events: e }); }); },
        saveNotif: function () { writeJSON(NOTIF_KEY, refNotif[0]); toast('Notification preferences saved'); },

        security: refSecurity[0],
        toggle2FA: function () { refSecurity[1](function (s) { var next = { twoFactor: !s.twoFactor }; writeJSON(SECURITY_KEY, next); toast(next.twoFactor ? 'Two-factor authentication enabled (demo)' : 'Two-factor authentication disabled (demo)', 'info'); return next; }); },
      };
    }

    return React.createElement(SettingsContext.Provider, { value: ctxObj() }, props.children);
  }

  /* ---------- Tab strip ------------------------------------------------- */
  function TabStrip(ctx) {
    return React.createElement('div', { className: 'fs-settings__tabs', role: 'tablist', 'aria-label': 'Settings sections' },
      TABS.map(function (t) {
        var active = ctx.tab === t.key;
        return React.createElement('button', {
          key: t.key, type: 'button', role: 'tab', 'aria-selected': active,
          className: 'fs-settings__tab' + (active ? ' fs-settings__tab--active' : ''),
          onClick: function () { ctx.setTab(t.key); },
        }, t.label);
      })
    );
  }

  /* ---------- shared field helpers -------------------------------------- */
  function Field(label, control) {
    return React.createElement('div', { className: 'fs-settings__field-row' },
      React.createElement('label', { className: 'fs-settings__label' }, label),
      control
    );
  }
  function TextInput(value, onChange, opts) {
    opts = opts || {};
    return React.createElement('input', {
      type: 'text', className: 'fs-settings__input' + (opts.readOnly ? ' fs-settings__input--readonly' : ''),
      value: value || '', readOnly: !!opts.readOnly, onChange: function (e) { if (onChange) onChange(e.target.value); },
    });
  }
  function SelectInput(value, options, onChange) {
    return React.createElement('select', { className: 'fs-settings__select', value: value, onChange: function (e) { onChange(e.target.value); } },
      options.map(function (o) { return React.createElement('option', { key: o.v, value: o.v }, o.l); })
    );
  }

  /* ---------- Preferences tab (original content) ------------------------ */
  function PreferencesTab(props) {
    var ctx = props.ctx;
    var state = ctx.state, user = ctx.user;
    var visibleItems = window.FS && window.FS.getVisibleNavItems ? window.FS.getVisibleNavItems(user) : [];
    var roleDefault = window.FS && window.FS.getDefaultLanding ? window.FS.getDefaultLanding(user) : '/today';
    var themeOptions = [
      { value: 'light', label: 'Light', caption: null },
      { value: 'dark', label: 'Dark', caption: null },
      { value: 'auto', label: 'Auto', caption: 'Matches your system, currently ' + state.themeResolved },
    ];
    var densityOptions = [
      { value: 'comfortable', label: 'Comfortable', caption: 'Default spacing — optimised for field use with gloves.' },
      { value: 'compact', label: 'Compact', caption: 'Reduced row height and padding — fits more on screen.' },
    ];
    function radioGroup(name, opts, current, onPick) {
      return React.createElement('div', { className: 'fs-settings__radio-group', role: 'radiogroup', 'aria-label': name },
        opts.map(function (opt) {
          var checked = current === opt.value;
          return React.createElement('label', { key: opt.value, className: 'fs-settings__radio-row' + (checked ? ' fs-settings__radio-row--checked' : '') },
            React.createElement('input', { type: 'radio', name: name, value: opt.value, checked: checked, onChange: function () { onPick(opt.value); }, className: 'fs-settings__radio-input' }),
            React.createElement('div', { className: 'fs-settings__radio-text' },
              React.createElement('span', { className: 'fs-settings__radio-label' }, opt.label),
              opt.caption ? React.createElement('span', { className: 'fs-settings__radio-caption' }, opt.caption) : null
            )
          );
        })
      );
    }
    return React.createElement(React.Fragment, null,
      React.createElement('section', { className: 'fs-settings__section' },
        React.createElement('div', { className: 'fs-settings__section-title' }, 'Theme'),
        React.createElement('div', { className: 'fs-settings__section-desc' }, 'Choose how FieldSight appears to you.'),
        radioGroup('fs-theme', themeOptions, state.themeStored, ctx.setTheme)
      ),
      React.createElement('section', { className: 'fs-settings__section' },
        React.createElement('div', { className: 'fs-settings__section-title' }, 'Display density'),
        React.createElement('div', { className: 'fs-settings__section-desc' }, 'Control how much information fits on screen at once.'),
        radioGroup('fs-density', densityOptions, state.densityStored, ctx.setDensity)
      ),
      React.createElement('section', { className: 'fs-settings__section' },
        React.createElement('div', { className: 'fs-settings__section-title' }, 'Default landing page'),
        React.createElement('div', { className: 'fs-settings__section-desc' }, 'Where you land when you open the app or navigate to the root.'),
        Field('On open, go to',
          React.createElement('select', { className: 'fs-settings__select', value: state.landingOverride || '', onChange: function (e) { ctx.setLanding(e.target.value || null); } },
            React.createElement('option', { value: '' }, 'Use my role\'s default (' + roleDefault + ')'),
            visibleItems.map(function (item) { return React.createElement('option', { key: item.key, value: item.path }, item.label); })
          )
        ),
        state.landingOverride ? React.createElement('div', { className: 'fs-settings__field-hint' }, 'Override active. Clear the dropdown to restore role default.') : null
      ),
      React.createElement('section', { className: 'fs-settings__section' },
        React.createElement('div', { className: 'fs-settings__section-title' }, 'Help'),
        React.createElement('div', { className: 'fs-settings__section-desc' }, 'Replay the welcome tour the next time you open the app.'),
        React.createElement('button', { type: 'button', className: 'fs-settings__link-btn', onClick: function () { try { localStorage.removeItem('fs.onboarded'); } catch (_) {} toast('Onboarding will run on next reload', 'info'); } }, 'Reset onboarding')
      )
    );
  }

  /* ---------- Profile tab ----------------------------------------------- */
  function ProfileTab(props) {
    var ctx = props.ctx;
    var p = ctx.profile;
    var Avatar = window.FieldSight && window.FieldSight.Avatar;
    var fileRef = React.useRef(null);
    function onPick(e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { ctx.patchProfile({ avatarUrl: reader.result }); };
      reader.readAsDataURL(f);
      /* Live mode: kick off the real presigned upload in parallel with the
         instant data-URI preview above (uploadImage() doesn't need the
         FileReader result, just the raw File). The pending key rides along
         in profile state until Save sends it to PATCH /me. */
      if (orgLive()) {
        window.FS.api.org.uploadImage('avatar', f).then(function (key) {
          if (key) ctx.patchProfile({ _pendingAvatarKey: key });   // null = mock/writes-off: local preview only
        }).catch(function (err) {
          console.warn('[settings] could not upload avatar', err);
          toast('Could not upload image — use JPEG, PNG or WebP', 'error');
        });
      }
    }
    var avatarEl = Avatar
      ? React.createElement(Avatar, { name: (p.firstName + ' ' + p.lastName).trim() || 'User', src: p.avatarUrl || undefined, size: 'xl' })
      : React.createElement('div', { className: 'fs-settings__avatar-fallback' }, ((p.firstName[0] || '') + (p.lastName[0] || '')).toUpperCase() || '?');

    return React.createElement('section', { className: 'fs-settings__section' },
      React.createElement('div', { className: 'fs-settings__profile' },
        React.createElement('div', { className: 'fs-settings__avatar-col' },
          avatarEl,
          React.createElement('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', ref: fileRef, onChange: onPick, style: { display: 'none' } }),
          React.createElement('button', { type: 'button', className: 'fs-settings__link-btn', onClick: function () { if (fileRef.current) fileRef.current.click(); } }, 'Change picture')
        ),
        React.createElement('div', { className: 'fs-settings__profile-fields' },
          Field('First name *', TextInput(p.firstName, function (v) { ctx.patchProfile({ firstName: v }); })),
          Field('Last name *', TextInput(p.lastName, function (v) { ctx.patchProfile({ lastName: v }); })),
          Field('Email', TextInput(p.email, null, { readOnly: true })),
          Field('Company', TextInput(p.company || '—', null, { readOnly: true })),
          Field('Role', TextInput(p.role ? p.role.replace(/_/g, ' ') : '—', null, { readOnly: true })),
          Field('Time format', SelectInput(p.timeFormat, TIME_FORMATS.map(function (o) { return { v: o.v, l: o.l }; }), function (v) { ctx.patchProfile({ timeFormat: v }); })),
          Field('Date format', SelectInput(p.dateFormat, DATE_FORMATS.map(function (o) { return { v: o.v, l: o.l }; }), function (v) { ctx.patchProfile({ dateFormat: v }); })),
          React.createElement('label', { className: 'fs-settings__checkbox-row' },
            React.createElement('input', { type: 'checkbox', checked: !!p.autoTimezone, onChange: function (e) { ctx.patchProfile({ autoTimezone: e.target.checked }); } }),
            React.createElement('span', null, 'Set time zone automatically')
          ),
          Field('Your time zone',
            React.createElement('select', { className: 'fs-settings__select', value: p.timezone, disabled: !!p.autoTimezone, onChange: function (e) { ctx.patchProfile({ timezone: e.target.value }); } },
              TIMEZONES.map(function (tz) { return React.createElement('option', { key: tz, value: tz }, tz); })
            )
          ),
          React.createElement('div', { className: 'fs-settings__actions' },
            React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--md', onClick: ctx.resetProfile }, 'Reset'),
            React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--primary fs-btn--md', onClick: ctx.saveProfile }, 'Save')
          )
        )
      )
    );
  }

  /* ---------- Security tab ---------------------------------------------- */
  function SecurityTab(props) {
    var ctx = props.ctx;
    var Modal = window.FieldSight && window.FieldSight.ModalOverlay;
    var refPw = React.useState(false); var pwOpen = refPw[0], setPwOpen = refPw[1];
    function row(icon, title, sub, btnLabel, onClick) {
      return React.createElement('div', { className: 'fs-settings__security-row' },
        React.createElement('div', { className: 'fs-settings__security-main' },
          React.createElement('span', { className: 'fs-settings__security-icon' }, icon),
          React.createElement('div', null,
            React.createElement('div', { className: 'fs-settings__security-title' }, title),
            sub ? React.createElement('div', { className: 'fs-settings__security-sub' }, sub) : null
          )
        ),
        React.createElement('button', { type: 'button', className: 'fs-settings__link-btn', onClick: onClick }, btnLabel + ' →')
      );
    }
    return React.createElement('section', { className: 'fs-settings__section' },
      React.createElement('div', { className: 'fs-settings__security-card' },
        row('🔑', 'Password', null, 'Change', function () { setPwOpen(true); }),
        row('🛡', 'Two-factor authentication', ctx.security.twoFactor ? 'On' : 'Off', 'Change', ctx.toggle2FA)
      ),
      (pwOpen && Modal) ? React.createElement(Modal, {
        open: true, size: 'sm', title: 'Change password', onClose: function () { setPwOpen(false); },
      },
        React.createElement('div', { className: 'fs-settings__pw-form' },
          Field('Current password', React.createElement('input', { type: 'password', className: 'fs-settings__input' })),
          Field('New password', React.createElement('input', { type: 'password', className: 'fs-settings__input' })),
          Field('Confirm new password', React.createElement('input', { type: 'password', className: 'fs-settings__input' })),
          React.createElement('div', { className: 'fs-settings__actions' },
            React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--md', onClick: function () { setPwOpen(false); } }, 'Cancel'),
            React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--primary fs-btn--md', onClick: function () { setPwOpen(false); toast('Password updated (demo)'); } }, 'Update password')
          )
        )
      ) : null
    );
  }

  /* ---------- Notifications tab ----------------------------------------- */
  function NotificationsTab(props) {
    var ctx = props.ctx;
    var n = ctx.notif;
    return React.createElement('section', { className: 'fs-settings__section' },
      React.createElement('div', { className: 'fs-settings__section-desc' }, 'Configure global email notification settings for your projects.'),
      Field('Notification frequency', SelectInput(n.frequency, FREQ_OPTS, function (v) { ctx.patchNotif({ frequency: v }); })),
      React.createElement('div', { className: 'fs-settings__section-title', style: { marginTop: '20px' } }, 'Event types'),
      React.createElement('div', { className: 'fs-settings__notif-grid' },
        EVENT_TYPES.map(function (e) {
          return React.createElement('label', { key: e.k, className: 'fs-settings__checkbox-row' },
            React.createElement('input', { type: 'checkbox', checked: !!n.events[e.k], onChange: function () { ctx.toggleEvent(e.k); } }),
            React.createElement('span', null, e.l)
          );
        })
      ),
      React.createElement('div', { className: 'fs-settings__section-title', style: { marginTop: '20px' } }, 'My involvement'),
      React.createElement('div', { className: 'fs-settings__notif-grid' },
        React.createElement('label', { className: 'fs-settings__checkbox-row' },
          React.createElement('input', { type: 'checkbox', checked: !!n.watched_by_me, onChange: function (e) { ctx.patchNotif({ watched_by_me: e.target.checked }); } }),
          React.createElement('span', null, 'Watched by me')
        ),
        React.createElement('label', { className: 'fs-settings__checkbox-row' },
          React.createElement('input', { type: 'checkbox', checked: !!n.assigned_to_me, onChange: function (e) { ctx.patchNotif({ assigned_to_me: e.target.checked }); } }),
          React.createElement('span', null, 'Assigned to me')
        )
      ),
      React.createElement('div', { className: 'fs-settings__actions' },
        React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--primary fs-btn--md', onClick: ctx.saveNotif }, 'Save')
      )
    );
  }

  /* ---------- Middle column --------------------------------------------- */
  function SettingsMiddleColumn() {
    var ctx = React.useContext(SettingsContext);
    if (!ctx) return null;
    var body;
    if (ctx.tab === 'profile') body = React.createElement(ProfileTab, { ctx: ctx });
    else if (ctx.tab === 'security') body = React.createElement(SecurityTab, { ctx: ctx });
    else if (ctx.tab === 'notifications') body = React.createElement(NotificationsTab, { ctx: ctx });
    else body = React.createElement(PreferencesTab, { ctx: ctx });

    return React.createElement('div', { className: 'fs-settings' },
      React.createElement('div', { className: 'fs-settings__header' },
        React.createElement('h2', { className: 'fs-settings__title' }, 'Settings'),
        React.createElement('div', { className: 'fs-settings__subtitle' }, 'Account & app preferences')
      ),
      TabStrip(ctx),
      body
    );
  }

  /* ---------- Right detail (kept minimal) ------------------------------- */
  function SettingsRightDetail() {
    return React.createElement('div', { className: 'fs-settings-summary fs-settings-summary--empty' },
      'Settings are saved in your browser.');
  }

  /* ---------- Register -------------------------------------------------- */
  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/settings'] = {
    Middle:   SettingsMiddleColumn,
    Right:    SettingsRightDetail,
    Provider: SettingsProvider,
    layout:   'full-width',
  };

})();
