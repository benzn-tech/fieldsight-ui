/* ==========================================================================
   FieldSight Auth · Cognito IDP — Sprint 2.9 (PLAN.md Phase I)
   --------------------------------------------------------------------------
   Thin wrapper over the Cognito IDP REST surface used by the production
   backend. Configured per BACKEND-CONTEXT §3:

     Region:    ap-southeast-2
     User pool: ap-southeast-2_ps7XIQGHB
     Client ID: 5npb81jbj1hgh9tsck25kan3os

   This module is invoked only when window.FS.api.useMocks === false.
   The prototype defaults to mocks so the preview HTMLs keep working
   without a real Cognito user. To go live:

     1. Flip FS.api.useMocks = false in app-shell-preview.html
        (or build a real index.html + Login route)
     2. Mount LoginScreen until window.FS.session.idToken is set
     3. After signIn() resolves, FS.session is populated and api/*
        modules switch to real fetch via api/_fetch.js

   Three flows, all spec-compliant with Cognito IDP's JSON-1.1 envelope:

     • USER_PASSWORD_AUTH      → signIn(username, password)
     • RespondToAuthChallenge  → respondToChallenge(...)  (NEW_PASSWORD_REQUIRED)
     • REFRESH_TOKEN_AUTH      → refreshTokens(refreshToken)

   Exported to:
     window.FS.cognito.signIn(username, password)
     window.FS.cognito.respondToChallenge({ challengeName, session, username, newPassword })
     window.FS.cognito.refreshTokens(refreshToken)
   ========================================================================== */

(function () {
  'use strict';

  /* These match the production Cognito user pool. Override at runtime
     for testing alternate pools by setting window.FS_COGNITO_CONFIG
     before this script loads. */
  var DEFAULTS = {
    region:   'ap-southeast-2',
    poolId:   'ap-southeast-2_ps7XIQGHB',
    clientId: '5npb81jbj1hgh9tsck25kan3os',
  };

  function config() {
    var override = window.FS_COGNITO_CONFIG || {};
    return {
      region:   override.region   || DEFAULTS.region,
      poolId:   override.poolId   || DEFAULTS.poolId,
      clientId: override.clientId || DEFAULTS.clientId,
    };
  }

  function endpoint() {
    return 'https://cognito-idp.' + config().region + '.amazonaws.com/';
  }

  /* All Cognito IDP calls use the same envelope. Action goes in the
     X-Amz-Target header; body is application/x-amz-json-1.1. */
  async function call(action, body) {
    var res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.' + action,
      },
      body: JSON.stringify(body),
    });
    var json = null;
    try { json = await res.json(); } catch (e) { /* fallthrough — surface as error */ }
    if (!res.ok) {
      var err = new Error((json && json.message) || ('Cognito ' + action + ' failed: ' + res.status));
      err.code   = json && json.__type;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async function signIn(username, password) {
    var cfg = config();
    return call('InitiateAuth', {
      AuthFlow:       'USER_PASSWORD_AUTH',
      ClientId:       cfg.clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    });
    /* Caller inspects the response:
         AuthenticationResult.IdToken / AccessToken / RefreshToken / ExpiresIn
         OR
         ChallengeName === 'NEW_PASSWORD_REQUIRED' (with Session)
       and dispatches to respondToChallenge() in the second case. */
  }

  async function respondToChallenge(opts) {
    var cfg = config();
    return call('RespondToAuthChallenge', {
      ChallengeName: opts.challengeName,
      ClientId:      cfg.clientId,
      Session:       opts.session,
      ChallengeResponses: {
        USERNAME:     opts.username,
        NEW_PASSWORD: opts.newPassword,
      },
    });
  }

  async function refreshTokens(refreshToken) {
    var cfg = config();
    return call('InitiateAuth', {
      AuthFlow:       'REFRESH_TOKEN_AUTH',
      ClientId:       cfg.clientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    });
    /* Note: REFRESH_TOKEN_AUTH does NOT return a new RefreshToken — re-use
       the existing one until it expires (~30 days by default). */
  }

  if (!window.FS) window.FS = {};
  window.FS.cognito = {
    signIn:              signIn,
    respondToChallenge:  respondToChallenge,
    refreshTokens:       refreshTokens,
    config:              config,
  };

})();
