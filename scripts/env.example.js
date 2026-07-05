/* ==========================================================================
   env.js — per-environment config (TEMPLATE).
   --------------------------------------------------------------------------
   The REAL env.js is generated at deploy time (see amplify.yml) and is NOT
   committed. It must load BEFORE scripts/api/index.js. Absent → mock mode.
   NOTE: baseUrl MUST end with /api (module paths carry no /api prefix).
   Amplify env vars FS_USEMOCKS / FS_WRITEMOCKS must be literally true or false.

   Phase 3 dual-base setup: org data (projects/members/roles/assets) lives in
   Aurora behind the TEST stack's gateway, while report reads stay on prod.
   orgBaseUrl MUST also end with /api (org module prefixes /org itself).
   orgWrites=true is the org-only write switch — programme / safety-create
   and other still-backend-less writes remain governed by writeMocks.
   ========================================================================== */
window.FS_ENV = {
  baseUrl: 'https://khfj3p1fkb.execute-api.ap-southeast-2.amazonaws.com/prod/api',
  useMocks: false,   // reads go to the real API
  writeMocks: true,  // backend-less writes stay mocked
  orgBaseUrl: 'https://<test-api-id>.execute-api.ap-southeast-2.amazonaws.com/prod/api',
  orgWrites: false,  // flip to true once fieldsight-test-org-api is deployed
};
