/* ==========================================================================
   FieldSight Fixtures · Sites & Users
   --------------------------------------------------------------------------
   Mirrors BACKEND-CONTEXT §6 (config/user_mapping.json) shape — three sites
   with a few users each. Roles match the mapping convention (worker /
   site_manager / pm); admin & gm exist only in Cognito profiles per the
   doc, so they're not represented here.

   Exported to window.FieldSight.fixtures.sites = { sites, users }
   ========================================================================== */

(function () {
  'use strict';

  var SITES = [
    {
      site_id:    'sb1108-ellesmere',
      name:       'SB1108 Ellesmere College',
      location:   'Christchurch',
      client:     'Ministry of Education',
      user_count: 4,
    },
    {
      site_id:    'mpi',
      name:       'MPI',
      location:   'Auckland',
      client:     'Ministry for Primary Industries',
      user_count: 2,
    },
    {
      site_id:    'sb1131-northbrook-wanaka',
      name:       'SB1131 - Northbrook Wanaka',
      location:   'Wanaka',
      client:     'Northbrook Group',
      user_count: 2,
    },
  ];

  /* device_id is the primary key (BACKEND-CONTEXT §6).
     folder_name = name.replace(' ', '_'). */
  var USERS = [
    { device_id: 'Benl1', name: 'Jarley Trainor',  folder_name: 'Jarley_Trainor',
      role: 'site_manager', primary_site: 'sb1108-ellesmere',
      sites: ['sb1108-ellesmere'] },
    { device_id: 'Benl2', name: 'David Barillaro', folder_name: 'David_Barillaro',
      role: 'worker',       primary_site: 'sb1108-ellesmere',
      sites: ['sb1108-ellesmere'] },
    { device_id: 'Benl3', name: 'Ben Lin',         folder_name: 'Ben_Lin',
      role: 'worker',       primary_site: 'sb1108-ellesmere',
      sites: ['sb1108-ellesmere'] },
    { device_id: 'Benl4', name: 'Sarah Chen',      folder_name: 'Sarah_Chen',
      role: 'worker',       primary_site: 'sb1108-ellesmere',
      sites: ['sb1108-ellesmere'] },
    { device_id: 'Benl5', name: 'James Lamb',      folder_name: 'James_Lamb',
      role: 'pm',           primary_site: 'mpi',
      sites: ['mpi','sb1131-northbrook-wanaka'] },
    { device_id: 'Benl6', name: 'MPI1',            folder_name: 'MPI1',
      role: 'worker',       primary_site: 'mpi',
      sites: ['mpi'] },
    { device_id: 'Benl7', name: 'Priya Sharma',    folder_name: 'Priya_Sharma',
      role: 'worker',       primary_site: 'sb1131-northbrook-wanaka',
      sites: ['sb1131-northbrook-wanaka'] },
    { device_id: 'Benl8', name: 'Mike OBrien',     folder_name: 'Mike_OBrien',
      role: 'worker',       primary_site: 'sb1131-northbrook-wanaka',
      sites: ['sb1131-northbrook-wanaka'] },
  ];

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.fixtures) window.FieldSight.fixtures = {};
  window.FieldSight.fixtures.sites = { sites: SITES, users: USERS };

})();
