/* ==========================================================================
   FieldSight Auth · Session Bridge  (Phase 0 Task 3)
   --------------------------------------------------------------------------
   Many modules read window.AuthMock.currentUser directly for role/name
   scoping (timeline.js:43-44, actions.js:114, sites.js:86-87, ...) instead
   of FS.session. In live mode (useMocks=false) the signed-in identity
   lives in FS.session — without this bridge those modules would keep
   seeing the hardcoded mock persona ("Jarley Trainor" / site_manager)
   even after a real Cognito sign-in.

   This bridge mirrors FS.session.user onto AuthMock.currentUser, via
   AuthMock's own updateProfile() so AuthMock's listeners fire (pages
   already mounted and subscribed via AuthMock.onChange re-render), and
   fires on both:

     (a) initial page load, when a persisted session is restored from
         sessionStorage — session.js reads sessionStorage synchronously
         in its own IIFE (session.js: `var state = readFromStorage();`)
         long before this script runs, so FS.session.user already
         reflects any persisted session by the time sync() below runs
         once at load.

     (b) sign-in completion — session.js's set() (session.js `function
         set(input) { ... writeToStorage(); emit(); }`) invokes emit()
         on every mutation, which calls every onChange() listener
         (session.js `function onChange(cb) { listeners.add(cb); ... }`).
         login-screen.js's onSubmitSignIn/onSubmitNewPassword call
         FS.session.set() with tokens, then again with
         `{ user: { role, display_name } }` after hydrateUser() resolves
         (login-screen.js hydrateUser()) — both trips through set() are
         observed here via FS.session.onChange(sync).

   No existing "auth changed" event is exposed beyond session.js's own
   onChange, so we subscribe to that directly rather than patching set().

   No-ops entirely when window.FS.api.useMocks !== false.

   Field mapping (brief's Interfaces block):
     name     <- display_name || name || email
     role     <- role
     initials <- first letters of first two words of the name, uppercased
     site     <- sites[0] (only if the real session actually supplies an
                 array — AuthMock's mock shape only carries a single
                 `site` string, not a `sites` array)
   Fields with no real-session equivalent (id, email, avatarUrl, isAdmin,
   avatarColor, ...) are left at their AuthMock defaults — never blanked.

   AuthMock.updateProfile(patch) (auth-mock.js) derives `name` and
   `initials` FROM `firstName`/`lastName` after merging the patch, so
   this bridge feeds it a firstName/lastName split (first word / rest)
   rather than setting `name`/`initials` directly — anything set
   directly there would just be overwritten by that recompute. Splitting
   on the first two words this way reproduces exactly the brief's
   "first letters of first two words, uppercased" rule, using AuthMock's
   own derivation logic.

   Must load AFTER scripts/auth-mock.js and scripts/auth/session.js, AND
   after window.FS.api.useMocks has been fully resolved (env.js default
   +/- the ?mocks=0 / ?mocks=1 override block in app-shell-preview.html) —
   see the script tag placement there.

   Exported to: nothing new — mutates AuthMock.currentUser only.
   ========================================================================== */

(function () {
  'use strict';

  var lastAppliedUser = null;

  function isLiveMode() {
    return !!(window.FS && window.FS.api && window.FS.api.useMocks === false);
  }

  /* Derive { firstName, lastName } so AuthMock.updateProfile's own
     name/initials recompute (auth-mock.js updateProfile()) reproduces
     "first letters of first two words, uppercased". */
  function splitName(name) {
    var words = String(name).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    return { firstName: words[0], lastName: words.slice(1).join(' ') };
  }

  function applySessionUser(sessionUser) {
    if (sessionUser === lastAppliedUser) return;
    lastAppliedUser = sessionUser;

    if (!sessionUser) return;
    if (!window.AuthMock || typeof window.AuthMock.updateProfile !== 'function') return;

    var patch = {};

    if (sessionUser.role) {
      /* Org role vocab {admin,gm,pm,site_manager,worker} ≠ the UI page-role
         registry (roles.js has no 'admin'/'pm' slug — an unmapped role gets
         ZERO permissions: empty nav, every page redirects). Bridge org→UI:
         'pm' maps to the UI slug 'project_manager'; 'admin' has no UI slug —
         grant the isAdmin flag instead (FS.can() and canSeeNav() honor it
         before any role lookup), keeping the raw 'admin' string for display
         and for the aggregators' role === 'admin' checks. */
      patch.role    = sessionUser.role === 'pm' ? 'project_manager' : sessionUser.role;
      patch.isAdmin = sessionUser.role === 'admin';
    }

    /* auth-mock's boot restore applies the GLOBAL localStorage profile
       (fs.settings.profile) to whoever loads the page — in live mode that
       leaks the PREVIOUS account's avatar into this session (cross-account
       contamination). Clear it here (bridge only runs live); the real
       account avatar is re-applied from /me by login hydrate / settings. */
    patch.avatarUrl = null;

    if (sessionUser.email) {
      patch.email = sessionUser.email;
    }

    var name = sessionUser.display_name || sessionUser.name || sessionUser.email;
    if (name) {
      var parts = splitName(name);
      if (parts) {
        patch.firstName = parts.firstName;
        patch.lastName  = parts.lastName;
      }
    }

    /* AuthMock's mock persona only carries a singular `site` field.
       Only touch it when the real session actually supplies `sites`;
       otherwise leave the mock default in place. */
    if (Array.isArray(sessionUser.sites) && sessionUser.sites.length) {
      var first = sessionUser.sites[0];
      var siteVal = typeof first === 'string' ? first : (first && (first.name || first.site_id));
      if (siteVal) patch.site = siteVal;
    }

    if (!Object.keys(patch).length) return;

    /* Use AuthMock's own update path so its listeners fire — already-
       rendered pages subscribed via AuthMock.onChange re-render. */
    window.AuthMock.updateProfile(patch);
  }

  function sync() {
    if (!isLiveMode()) return;
    var session = window.FS && window.FS.session;
    if (!session) return;
    applySessionUser(session.user);
  }

  /* (a) Initial load / persisted-session restore. */
  sync();

  /* (b) Sign-in completion (and any later session mutation, e.g. token
     refresh — applySessionUser() no-ops when session.user is unchanged
     by reference, so a refresh-only set() is a cheap skip). */
  if (window.FS && window.FS.session && typeof window.FS.session.onChange === 'function') {
    window.FS.session.onChange(sync);
  }

})();
