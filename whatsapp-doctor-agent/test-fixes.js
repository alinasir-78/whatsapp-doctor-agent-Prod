// test-fixes.js
const http = require('http');
require('./src/server');

const baseUrl = 'http://127.0.0.1:3000';

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

async function run() {
  console.log('🧪 Starting Verification of Edit User, Reset Password & Direct Self-Service Recovery...');

  // 1. Admin login
  console.log('\n[TEST 1] Admin Sign-In...');
  const adminRes = await request('POST', '/api/auth/login', { username: 'admin', password: 'Admin@2026!' });
  if (!adminRes.data || !adminRes.data.token) throw new Error('Admin login failed: ' + JSON.stringify(adminRes.data));
  const adminToken = adminRes.data.token;
  console.log('✅ Admin authenticated.');

  // 2. Test Edit User
  const usersCheckPre = await request('GET', '/api/users', null, adminToken);
  const targetVance = usersCheckPre.data.users.find(u => u.username === 'dr.vance');
  const vanceId = targetVance ? targetVance.id : 6;
  const vanceDocId = targetVance ? targetVance.doctor_id : 3;

  console.log(`\n[TEST 2] Testing Edit User (PUT /api/users/${vanceId} for dr.vance)...`);
  const editRes = await request('PUT', `/api/users/${vanceId}`, {
    fullName: 'Dr. Marcus Vance, DO (Lead Physician)',
    email: 'dr.vance.lead@apexclinic.com',
    role: 'doctor',
    doctorId: vanceDocId,
    isActive: 1
  }, adminToken);

  if (editRes.status === 200 && editRes.data.success) {
    console.log('✅ Edit user API succeeded:', editRes.data.message);
  } else {
    throw new Error('Edit user failed: ' + JSON.stringify(editRes.data));
  }

  // Verify updated user
  const usersCheck = await request('GET', '/api/users', null, adminToken);
  const vanceUser = usersCheck.data.users.find(u => u.id === vanceId);
  if (vanceUser && vanceUser.full_name === 'Dr. Marcus Vance, DO (Lead Physician)') {
    console.log('✅ Verified updated user record:', vanceUser.full_name, '| Email:', vanceUser.email);
  } else {
    throw new Error('User update verification failed: ' + JSON.stringify(vanceUser));
  }

  // 3. Test Reset Password via Users Page
  console.log(`\n[TEST 3] Testing Reset Password via Users Page (POST /api/users/${vanceId}/reset-password)...`);
  const resetRes = await request('POST', `/api/users/${vanceId}/reset-password`, {}, adminToken);
  if (resetRes.status === 200 && resetRes.data.success && resetRes.data.tempPassword) {
    console.log('✅ Password reset generated temporary password:', resetRes.data.tempPassword);
    console.log('   Dispatched targets:', resetRes.data.dispatchedTo);

    // Verify Vance can sign in with this temporary password
    const vanceLogin = await request('POST', '/api/auth/login', {
      username: 'dr.vance',
      password: resetRes.data.tempPassword
    });
    if (vanceLogin.status === 200 && vanceLogin.data.mustChangePassword === true) {
      console.log('✅ Vance successfully signed in with newly generated temporary password; mustChangePassword = true.');
    } else {
      throw new Error('Login with reset temporary password failed: ' + JSON.stringify(vanceLogin.data));
    }
  } else {
    throw new Error('Reset password failed: ' + JSON.stringify(resetRes.data));
  }

  // 4. Test Forgot Password (Self-Service via Username - Zero Admin routing)
  console.log('\n[TEST 4] Testing Direct Forgot Password Recovery via Username (identifier="dr.patel")...');
  const forgotUsernameRes = await request('POST', '/api/auth/forgot-password', { identifier: 'dr.patel' });
  if (forgotUsernameRes.status === 200 && forgotUsernameRes.data.success && forgotUsernameRes.data.tempPassword) {
    const tempP = forgotUsernameRes.data.tempPassword;
    console.log('✅ Direct temporary password generated for Dr. Patel:', tempP);
    console.log('   Dispatched to:', forgotUsernameRes.data.dispatchedTo);

    // Test sign-in with Dr. Patel's new temp password
    const patelLogin = await request('POST', '/api/auth/login', {
      username: 'dr.patel',
      password: tempP
    });
    if (patelLogin.status === 200 && patelLogin.data.mustChangePassword === true) {
      console.log('✅ Dr. Patel signed in with self-service temporary password! Doctor profile linked:', patelLogin.data.user.doctorProfile.name);
    } else {
      throw new Error('Dr. Patel login with self-service temp pass failed: ' + JSON.stringify(patelLogin.data));
    }
  } else {
    throw new Error('Forgot password via username failed: ' + JSON.stringify(forgotUsernameRes.data));
  }

  // 5. Test Forgot Password via WhatsApp Mobile Phone Number
  console.log('\n[TEST 5] Testing Direct Forgot Password Recovery via WhatsApp Phone (identifier="5550187711")...');
  const forgotPhoneRes = await request('POST', '/api/auth/forgot-password', { identifier: '5550187711' });
  if (forgotPhoneRes.status === 200 && forgotPhoneRes.data.success && forgotPhoneRes.data.tempPassword) {
    console.log('✅ Phone lookup succeeded for Dr. Patel! Generated temp password:', forgotPhoneRes.data.tempPassword);
    console.log('   Target phone:', forgotPhoneRes.data.dispatchedTo.whatsapp);
  } else {
    throw new Error('Forgot password via phone failed: ' + JSON.stringify(forgotPhoneRes.data));
  }

  console.log('\n====================================================');
  console.log('🎉 ALL EDIT, RESET & DIRECT SELF-SERVICE TESTS PASSED!');
  console.log('====================================================\n');
  process.exit(0);
}

setTimeout(() => {
  run().catch(err => {
    console.error('❌ TEST FAILED:', err);
    process.exit(1);
  });
}, 800);
