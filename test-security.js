// test-security.js - Automated Verification for RBAC, Auth, Password Policies & Doctor Cascades
const http = require('http');

const PORT = process.env.PORT || 3000;
const baseUrl = `http://127.0.0.1:${PORT}`;

// Load app which starts server on PORT
require('./src/server');

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, data: json });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('🩺 STARTING CLINICAL SECURITY & RBAC SUITE TESTS');
  console.log('====================================================\n');

  let adminToken = null;
  let directorToken = null;
  let patelToken = null;

  // TEST 1: Admin Login (Mandatory first-login change required for all accounts including Admin)
  console.log('[TEST 1] Testing Admin Login (admin / Admin@2026!)...');
  const adminRes = await request('POST', '/api/auth/login', { username: 'admin', password: 'Admin@2026!' });
  if (adminRes.status === 200 && adminRes.data.success && adminRes.data.mustChangePassword === true) {
    adminToken = adminRes.data.token;
    console.log('✅ Admin login succeeded, mustChangePassword = true flagged as required.');

    // Change admin password to new secure password
    const adminPassChange = await request('POST', '/api/auth/change-password', {
      newPassword: 'AdminSecurePass@2026!',
      confirmPassword: 'AdminSecurePass@2026!'
    }, adminToken);
    if (adminPassChange.status === 200 && adminPassChange.data.success) {
      console.log('✅ Admin first-time password change succeeded.');
    } else {
      throw new Error('Admin password change failed: ' + JSON.stringify(adminPassChange.data));
    }
  } else {
    throw new Error(`Admin login failed: ${JSON.stringify(adminRes.data)}`);
  }

  // TEST 2: Director Login (Mandatory first-login password change flag = true)
  console.log('\n[TEST 2] Testing Medical Director Login (director / Director@2026!)...');
  const dirRes = await request('POST', '/api/auth/login', { username: 'director', password: 'Director@2026!' });
  if (dirRes.status === 200 && dirRes.data.success && dirRes.data.mustChangePassword === true) {
    directorToken = dirRes.data.token;
    console.log('✅ Director login succeeded, mustChangePassword = true flagged as required.');
  } else {
    throw new Error(`Director initial login check failed: ${JSON.stringify(dirRes.data)}`);
  }

  // TEST 3: Director First-time Password Change
  console.log('\n[TEST 3] Testing Mandatory Password Change for Director...');
  const changeRes = await request('POST', '/api/auth/change-password', {
    newPassword: 'DirectorNewSecure@2026!',
    confirmPassword: 'DirectorNewSecure@2026!'
  }, directorToken);

  if (changeRes.status === 200 && changeRes.data.success) {
    console.log('✅ Password successfully changed for director.');
  } else {
    throw new Error(`Password change failed: ${JSON.stringify(changeRes.data)}`);
  }

  // Verify Director can now log in with the new password and mustChangePassword is false
  const dirRelogin = await request('POST', '/api/auth/login', { username: 'director', password: 'DirectorNewSecure@2026!' });
  if (dirRelogin.status === 200 && dirRelogin.data.mustChangePassword === false) {
    directorToken = dirRelogin.data.token;
    console.log('✅ Director signed in with new password; mustChangePassword is now false.');
  } else {
    throw new Error(`Director re-login check failed: ${JSON.stringify(dirRelogin.data)}`);
  }

  // TEST 4: Doctor Account Login (dr.patel / DoctorPass@2026!)
  console.log('\n[TEST 4] Testing Doctor Login (dr.patel / DoctorPass@2026!)...');
  const patelRes = await request('POST', '/api/auth/login', { username: 'dr.patel', password: 'DoctorPass@2026!' });
  if (patelRes.status === 200 && patelRes.data.success) {
    patelToken = patelRes.data.token;
    console.log(`✅ Dr. Patel logged in. Doctor ID: ${patelRes.data.user.doctorId}, Role: ${patelRes.data.user.role}`);
  } else {
    throw new Error(`Dr. Patel login failed: ${JSON.stringify(patelRes.data)}`);
  }

  // TEST 5: Doctor Access Control Restriction (Dr. Patel forbidden from /api/users)
  console.log('\n[TEST 5] Testing Permission Boundary: Dr. Patel accesses /api/users (should be 403 Forbidden)...');
  const forbiddenUsersRes = await request('GET', '/api/users', null, patelToken);
  if (forbiddenUsersRes.status === 403) {
    console.log('✅ RBAC successfully blocked doctor from user administration (HTTP 403 Forbidden).');
  } else {
    throw new Error(`Doctor should not have access to /api/users, but got status ${forbiddenUsersRes.status}`);
  }

  // TEST 6: Doctor Calendar Segregation
  console.log('\n[TEST 6] Testing Doctor Calendar Segregation (Dr. Patel should only see Dr. Patel)...');
  const patelCalendar = await request('GET', '/api/calendar', null, patelToken);
  if (patelCalendar.status === 200 && patelCalendar.data.doctors) {
    const docNames = patelCalendar.data.doctors.map(d => d.name);
    console.log('Calendar doctors visible to Dr. Patel:', docNames);
    if (docNames.length === 1 && docNames[0].includes('Patel')) {
      console.log('✅ Calendar strictly filtered to only Dr. Patel.');
    } else {
      throw new Error(`Doctor calendar segregation failed. Returned: ${JSON.stringify(docNames)}`);
    }
  } else {
    throw new Error(`Failed to load calendar for doctor: ${JSON.stringify(patelCalendar.data)}`);
  }

  // TEST 7: Admin RBAC User Management
  console.log('\n[TEST 7] Testing Admin Access to User Management (/api/users)...');
  const allUsersRes = await request('GET', '/api/users', null, adminToken);
  if (allUsersRes.status === 200 && allUsersRes.data.users) {
    const roles = allUsersRes.data.users.map(u => `${u.username} (${u.role})`);
    console.log(`✅ Loaded ${allUsersRes.data.users.length} system users:`, roles.join(', '));
  } else {
    throw new Error(`Admin failed to load users: ${JSON.stringify(allUsersRes.data)}`);
  }

  // TEST 8: Dynamic Doctor Account Auto-Creation & Cascading Deactivation
  console.log('\n[TEST 8] Testing Doctor Auto-Provisioning & Cascading Account Deactivation...');
  // 8a: Create a new doctor
  const newDocRes = await request('POST', '/api/doctors', {
    name: 'Dr. Gregory House',
    specialty: 'Diagnostic Medicine',
    personal_phone: '+15557778888',
    email: 'house@example.com',
    slot_duration_minutes: 30,
    working_days: '1,2,3,4,5',
    day_start_time: '09:00',
    day_end_time: '17:00'
  }, adminToken);

  if ((newDocRes.status === 200 || newDocRes.status === 201) && newDocRes.data.doctorId) {
    const doctorId = newDocRes.data.doctorId;
    console.log(`✅ Created new physician with ID: ${doctorId}`);

    // Verify linked user was created automatically
    const usersCheck = await request('GET', '/api/users', null, adminToken);
    const houseUser = usersCheck.data.users.find(u => u.doctor_id === doctorId);
    if (houseUser) {
      console.log(`✅ Linked user account automatically created: username="${houseUser.username}", role="${houseUser.role}", mustChangePassword=${houseUser.must_change_password}`);

      // 8b: Deactivate physician in directory
      console.log('Deactivating Dr. Gregory House in physician directory...');
      const deactRes = await request('PUT', `/api/doctors/${doctorId}`, {
        name: 'Dr. Gregory House',
        specialty: 'Diagnostic Medicine',
        personal_phone: '+15557778888',
        email: 'house@example.com',
        slot_duration_minutes: 30,
        working_days: '1,2,3,4,5',
        day_start_time: '09:00',
        day_end_time: '17:00',
        is_active: 0 // Deactivate!
      }, adminToken);

      if (deactRes.status === 200) {
        // Verify user account was automatically cascaded to is_active = 0
        const usersPostDeact = await request('GET', '/api/users', null, adminToken);
        const houseUserPost = usersPostDeact.data.users.find(u => u.doctor_id === doctorId);
        if (houseUserPost && houseUserPost.is_active === 0) {
          console.log('✅ Cascading deactivation confirmed: Doctor account is_active is now 0 (Suspended).');
        } else {
          throw new Error('Cascading deactivation failed: linked user is still active!');
        }

        // Verify that trying to login with deactivated user fails
        const deactLogin = await request('POST', '/api/auth/login', { username: houseUser.username, password: 'DoctorPass@2026!' });
        if ((deactLogin.status === 401 || deactLogin.status === 403) && deactLogin.data.error.includes('deactivated')) {
          console.log('✅ Deactivated doctor user is prevented from signing in.');
        } else {
          throw new Error(`Deactivated user should not be able to log in: ${JSON.stringify(deactLogin.data)}`);
        }
      } else {
        throw new Error(`Doctor deactivation update failed: ${JSON.stringify(deactRes.data)}`);
      }
    } else {
      throw new Error('Auto-provisioning failed: No user found for newly created doctor!');
    }
  } else {
    throw new Error(`Failed to create test doctor: ${JSON.stringify(newDocRes.data)}`);
  }

  // TEST 9: Forgot Password Endpoint
  console.log('\n[TEST 9] Testing Forgot Password / Reset Request...');
  const forgotRes = await request('POST', '/api/auth/forgot-password', { identifier: 'reception' });
  if (forgotRes.status === 200 && forgotRes.data.success) {
    console.log(`✅ Forgot password handled: "${forgotRes.data.message}"`);
  } else {
    throw new Error(`Forgot password failed: ${JSON.stringify(forgotRes.data)}`);
  }

  // TEST 10: Permissions List Endpoint
  console.log('\n[TEST 10] Testing Permissions Catalog Endpoint...');
  const permsRes = await request('GET', '/api/auth/permissions-list', null, adminToken);
  if (permsRes.status === 200 && permsRes.data.permissions && permsRes.data.permissions.length === 15) {
    console.log(`✅ Loaded ${permsRes.data.permissions.length} granular permissions successfully.`);
  } else {
    throw new Error(`Permissions catalog check failed: ${JSON.stringify(permsRes.data)}`);
  }

  console.log('\n====================================================');
  console.log('🎉 ALL SECURITY, RBAC & CASCADING TESTS PASSED!');
  console.log('====================================================\n');
}

// Give SQLite a moment to initialize then run tests
setTimeout(async () => {
  try {
    await runTests();
    process.exit(0);
  } catch (err) {
    console.error('❌ TEST FAILED:', err);
    process.exit(1);
  }
}, 800);
