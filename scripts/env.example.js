/* ==========================================================================
   env.js — per-environment config (TEMPLATE).
   --------------------------------------------------------------------------
   The REAL env.js is generated at deploy time (see amplify.yml) and is NOT
   committed. It must load BEFORE scripts/api/index.js. Absent → mock mode.
   NOTE: baseUrl MUST end with /api (module paths carry no /api prefix).
   Amplify env vars FS_USEMOCKS / FS_WRITEMOCKS must be literally true or false.
   ========================================================================== */
window.FS_ENV = {
  baseUrl: 'https://khfj3p1fkb.execute-api.ap-southeast-2.amazonaws.com/prod/api',
  useMocks: false,   // reads go to the real API
  writeMocks: true,  // non-org backend-less writes stay mocked
  orgBaseUrl: 'https://wdsgobb7b0.execute-api.ap-southeast-2.amazonaws.com/prod/api',  // org backend (empty '' = kill switch → org回mock)
  orgWrites: true,   // org-domain writes go live (batch 2)
  timelineSource: 'report',  // 'aurora' routes getTimeline to org /timeline shim (only when orgBaseUrl is set — kill switch); default 'report' = zero behavior change
};
