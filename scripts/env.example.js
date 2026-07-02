/* ==========================================================================
   env.js — per-environment config (TEMPLATE).
   --------------------------------------------------------------------------
   The REAL env.js is generated at deploy time (see amplify.yml) and is NOT
   committed. It must load BEFORE scripts/api/index.js. Absent → mock mode.
   NOTE: baseUrl MUST end with /api (module paths carry no /api prefix).
   ========================================================================== */
window.FS_ENV = {
  baseUrl: 'https://khfj3p1fkb.execute-api.ap-southeast-2.amazonaws.com/prod/api',
  useMocks: false,   // reads go to the real API
  writeMocks: true,  // backend-less writes stay mocked (Phase 3 flips this)
};
