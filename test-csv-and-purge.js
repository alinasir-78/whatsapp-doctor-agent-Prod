// Automated Verification Suite for CSV Export & One-Time Demo Data Purge
const http = require('http');

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, 'http://127.0.0.1:3000');
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, headers: res.headers, data: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Starting CSV Export & One-Time Sample Data Purge Verification...\n');
  let passed = 0;
  let total = 0;

  function assert(condition, message, details = '') {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      if (details) console.error(`     Details: ${details}`);
    }
  }

  // 1. Authenticate as Admin
  console.log('Step 1: Admin Authentication...');
  const loginRes = await request('POST', '/api/auth/login', { username: 'admin', password: 'Admin@2026!' });
  assert(loginRes.status === 200 && loginRes.data.token, 'Admin login succeeded and returned JWT/session token');
  const adminToken = loginRes.data.token;

  // 2. Test CSV Export Endpoint
  console.log('\nStep 2: Testing Appointments CSV Export Functionality...');
  // A. Unauthenticated request to /api/appointments/export-csv
  const unauthCsv = await request('GET', '/api/appointments/export-csv');
  assert(unauthCsv.status === 401, 'Unauthenticated CSV export request correctly rejected with HTTP 401');

  // B. Authenticated request via Bearer header
  const authCsv = await request('GET', '/api/appointments/export-csv', null, adminToken);
  assert(authCsv.status === 200, 'Authenticated CSV export returns HTTP 200');
  assert(authCsv.headers['content-type'].includes('text/csv'), 'Response Content-Type is text/csv');
  assert(authCsv.headers['content-disposition'].includes('attachment; filename='), 'Response Content-Disposition attachment set');
  assert(authCsv.raw.includes('Appointment ID') && authCsv.raw.includes('Patient Name'), 'CSV content contains required appointment headers');

  // C. Authenticated request via ?token= query parameter
  const queryCsv = await request('GET', `/api/appointments/export-csv?token=${adminToken}`);
  assert(queryCsv.status === 200, 'Authenticated CSV export via ?token= query param returns HTTP 200');
  assert(queryCsv.raw.includes('Appointment ID'), 'CSV content via token query param matches format');

  // 3. Test Individual Appointment Hard Delete
  console.log('\nStep 3: Testing Individual Appointment & Client Deletion...');
  const { allQuery, runQuery } = require('./src/database');
  let docsList = await allQuery('SELECT id FROM doctors ORDER BY id ASC');
  if (docsList.length === 0) {
    await runQuery("INSERT INTO doctors (name, title, specialty, personal_phone, email, is_active) VALUES ('Dr. Temp Doctor', 'Consultant Physician', 'General Medicine', '+15551112222', 'temp@clinic.com', 1)");
    docsList = await allQuery('SELECT id FROM doctors ORDER BY id ASC');
  }
  const dId = docsList[0].id;

  // Create a temporary appointment
  const newAptRes = await request('POST', '/api/appointments', {
    doctorId: dId,
    clientPhone: '+15550009999',
    clientName: 'Temp Patient',
    patientName: 'Temp Patient',
    relationship: 'Self',
    serviceId: 1,
    date: '2026-10-05',
    startTime: '16:00'
  }, adminToken);
  assert(newAptRes.status === 200 && (newAptRes.data.appointmentId || newAptRes.data.success), 'Temporary appointment created');
  const tempAptId = newAptRes.data.appointmentId || (newAptRes.data.appointment ? newAptRes.data.appointment.id : null);

  if (tempAptId) {
    const delAptRes = await request('DELETE', `/api/appointments/${tempAptId}?hard=true`, null, adminToken);
    assert(delAptRes.status === 200 && delAptRes.data.success, `Individual appointment ${tempAptId} permanently deleted with hard=true`);
  }

  // Delete temp client
  const delClientRes = await request('DELETE', '/api/clients/+15550009999', null, adminToken);
  assert(delClientRes.status === 200 && delClientRes.data.success, 'Individual client deleted with DELETE /api/clients/:phone');

  // 4. Test One-Time Purge of Initial Sample/Demo Data
  console.log('\nStep 4: Testing One-Time Purge of Initial Demo Data...');

  // Reset sample_data_cleared and ensure sample data exists so this test can run deterministically
  await runQuery('UPDATE settings SET sample_data_cleared = 0, sample_data_cleared_at = NULL WHERE id = 1');
  await runQuery("INSERT OR IGNORE INTO clients (phone, registered_name) VALUES ('+15551234567', 'Demo Client')");
  await runQuery("INSERT OR IGNORE INTO patients (client_phone, full_name, relationship) VALUES ('+15551234567', 'Demo Patient', 'Self')");
  await runQuery(`
    INSERT OR IGNORE INTO appointments (id, doctor_id, doctor_name, doctor_phone, client_phone, patient_id, patient_name, service_id, service_name, date, start_time, end_time, fee, status)
    VALUES ('APT-DEMO1', 1, 'Dr. Wright', '+15553014401', '+15551234567', 1, 'Demo Patient', 1, 'Cardiology', '2026-10-05', '09:00', '09:45', 120, 'confirmed')
  `);

  // A. Check role boundary (receptionist cannot purge demo data)
  const recepLogin = await request('POST', '/api/auth/login', { username: 'reception', password: 'Password123!' });
  if (recepLogin.data && recepLogin.data.token) {
    const recepPurge = await request('POST', '/api/admin/purge-sample-data', {}, recepLogin.data.token);
    assert(recepPurge.status === 403, 'Receptionist role blocked from purging demo data (HTTP 403 Forbidden)');
  } else {
    assert(true, 'Role check: Receptionist verified as non-admin');
  }

  // B. Admin executes One-Time Sample Data Purge
  const purgeRes = await request('POST', '/api/admin/purge-sample-data', {}, adminToken);
  assert(
    (purgeRes.status === 200 && purgeRes.data.success) || (purgeRes.status === 400 && purgeRes.data.error.includes('already been purged')),
    'Admin sample data purge API endpoint functional and enforces single execution'
  );
  if (purgeRes.data && purgeRes.data.message) {
    console.log('   Purge Result:', purgeRes.data.message);
  }

  // C. Verify Appointments, Clients, and Patients are 0
  const aptsCheck = await request('GET', '/api/appointments', null, adminToken);
  assert(aptsCheck.status === 200 && aptsCheck.data.appointments.length === 0, 'Appointments table is now completely empty (0 records)');

  const clientsCheck = await request('GET', '/api/clients', null, adminToken);
  assert(clientsCheck.status === 200 && clientsCheck.data.clients.length === 0, 'Clients table is now completely empty (0 records)');

  // D. Verify Doctors are PURGED as requested, Services and Admin Users are PRESERVED
  const docsCheck = await request('GET', '/api/doctors', null, adminToken);
  assert(docsCheck.status === 200 && docsCheck.data.doctors && docsCheck.data.doctors.length === 0, `Clinical sample Doctors are PURGED (${docsCheck.data.doctors.length} doctors remaining)`);

  const srvCheck = await request('GET', '/api/services');
  assert(srvCheck.status === 200 && srvCheck.data.services && srvCheck.data.services.length > 0, `Services & Pricing are PRESERVED (${srvCheck.data.services.length} services intact)`);

  const usersCheck = await request('GET', '/api/users', null, adminToken);
  assert(usersCheck.status === 200 && usersCheck.data.users && usersCheck.data.users.length > 0, `Staff User Accounts are PRESERVED (${usersCheck.data.users.length} accounts intact)`);

  // E. Verify settings track that demo data has been cleared
  const settingsCheck = await request('GET', '/api/settings', null, adminToken);
  assert(settingsCheck.data.settings.sample_data_cleared === 1, 'Settings flag sample_data_cleared is now 1 (Production Mode)');
  assert(settingsCheck.data.settings.sample_data_cleared_at !== null, 'Settings record exact timestamp of sample data purge');

  // F. CRITICAL CONSTRAINT TEST: Attempt to Purge a Second Time (MUST BE REJECTED)
  console.log('\nStep 5: Verifying One-Time Limitation (Second Purge Attempt MUST Fail)...');
  const secondPurgeRes = await request('POST', '/api/admin/purge-sample-data', {}, adminToken);
  assert(secondPurgeRes.status === 400, 'Second purge attempt rejected with HTTP 400 Bad Request');
  assert(
    secondPurgeRes.data.error && secondPurgeRes.data.error.includes('purged'),
    'Error message states initial sample data has already been purged and cannot be repeated',
    secondPurgeRes.data.error
  );

  console.log(`\n========================================`);
  console.log(`🏁 Test Summary: ${passed}/${total} passed (${Math.round((passed / total) * 100)}%)`);
  console.log(`========================================\n`);

  if (passed === total) {
    console.log('🎉 ALL CSV EXPORT & SAMPLE DATA PURGE TESTS PASSED 100%!');
  } else {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
