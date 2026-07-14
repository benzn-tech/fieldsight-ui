/* ==========================================================================
   FieldSight Auth Mock — dev only
   window.AuthMock
   ========================================================================== */

(function () {
  'use strict';

  const listeners = new Set();

  function emit() {
    listeners.forEach(cb => { try { cb(AuthMock.currentUser); } catch (e) { console.error('[AuthMock]', e); } });
  }

  const AuthMock = {
    currentUser: {
      id: 'user_001',
      name: 'Jarley Trainor',
      firstName: 'Jarley',
      lastName: 'Trainor',
      email: 'jarley.trainor@southbase.co.nz',
      avatarUrl: null,
      initials: 'JT',
      role: 'site_manager',
      isAdmin: false,
      avatarColor: '#2E75B6',
      site: 'Ellesmere',
    },

    setRole(roleName) {
      const roles = window.FS && window.FS.ROLES;
      if (roles && !roles[roleName]) {
        console.warn('[AuthMock] Unknown role:', roleName);
        return;
      }
      AuthMock.currentUser = Object.assign({}, AuthMock.currentUser, {
        role: roleName,
        isAdmin: false,
      });
      emit();
    },

    setAdmin(isAdmin) {
      AuthMock.currentUser = Object.assign({}, AuthMock.currentUser, { isAdmin: !!isAdmin });
      emit();
    },

    setUser(user) {
      AuthMock.currentUser = Object.assign({}, user);
      // Derive initials if not provided
      if (!AuthMock.currentUser.initials && AuthMock.currentUser.name) {
        AuthMock.currentUser.initials = AuthMock.currentUser.name
          .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      }
      emit();
    },

    updateProfile(patch) {
      AuthMock.currentUser = Object.assign({}, AuthMock.currentUser, patch);
      const fn = AuthMock.currentUser.firstName, ln = AuthMock.currentUser.lastName;
      if (fn != null || ln != null) {
        AuthMock.currentUser.name = ((fn || '') + ' ' + (ln || '')).trim() || AuthMock.currentUser.name;
        AuthMock.currentUser.initials = (((fn || '')[0] || '') + ((ln || '')[0] || '')).toUpperCase() || AuthMock.currentUser.initials;
      }
      emit();
    },

    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };

  // Ensure initials are set on the default user
  AuthMock.currentUser.initials = 'JT';

  // Apply any saved profile (Settings -> Profile) so edits persist across
  // reloads in the mock prototype (localStorage 'fs.settings.profile').
  try {
    const savedProfile = JSON.parse(localStorage.getItem('fs.settings.profile') || 'null');
    if (savedProfile) {
      if (savedProfile.firstName != null) AuthMock.currentUser.firstName = savedProfile.firstName;
      if (savedProfile.lastName != null)  AuthMock.currentUser.lastName  = savedProfile.lastName;
      if (savedProfile.email != null)     AuthMock.currentUser.email     = savedProfile.email;
      if (savedProfile.avatarUrl != null) AuthMock.currentUser.avatarUrl = savedProfile.avatarUrl;
      const fn = AuthMock.currentUser.firstName || '', ln = AuthMock.currentUser.lastName || '';
      if (fn || ln) {
        AuthMock.currentUser.name = (fn + ' ' + ln).trim();
        AuthMock.currentUser.initials = ((fn[0] || '') + (ln[0] || '')).toUpperCase();
      }
    }
  } catch (_) {}

  window.AuthMock = AuthMock;

})();
