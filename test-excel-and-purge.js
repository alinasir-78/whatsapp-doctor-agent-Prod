/**
 * test-excel-and-purge.js
 * Verification test for:
 * 1. Excel/CSV Patient Import template download
 * 2. Excel & CSV Patient Import execution
 * 3. Doctors, Patients, Appointments purge
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

function request(options, postData, postHeaders = {}) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: 'localhost',
      port: 3000,
      path: options.path,
      method: options.method || 'GET',
      headers: { ...options.headers, ...postHeaders }
    };

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          rawBody: buffer,
          text: buffer.toString('utf8'),
          json: () => {
            try { return JSON.parse(buffer.toString('utf8')); }
            catch (e) { return null; }
          }
        });
      });
    });

    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

function buildMultipartFormData(fields, fileField, filename, fileBuffer, mimeType) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const crlf = '\r\n';
  let postParts = [];

  for (const [key, value] of Object.entries(fields)) {
    postParts.push(Buffer.from(
      `--${boundary}${crlf}Content-Disposition: form-data; name="${key}"${crlf}${crlf}${value}${crlf}`
    ));
  }

  if (fileField && fileBuffer) {
    postParts.push(Buffer.from(
      `--${boundary}${crlf}Content-Disposition: form-data; name="${fileField}"; filename="${filename}"${crlf}Content-Type: ${mimeType}${crlf}${crlf}`
    ));
    postParts.push(fileBuffer);
    postParts.push(Buffer.from(crlf));
  }

  postParts.push(Buffer.from(`--${boundary}--${crlf}`));
  const body = Buffer.concat(postParts);
  return {
    body,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    }
  };
}

async function runTests() {
  console.log('--- STARTING EXCEL IMPORT & PURGE TEST SUITE ---');
  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`  ✓ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  ✗ [FAIL] ${message}`);
    }
  }

  // 1. Login as admin
  const loginRes = await request({
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, JSON.stringify({ username: 'admin', password: 'Admin@2026!' }));

  const loginData = loginRes.json();
  assert(loginRes.status === 200 && loginData && loginData.token, 'Admin login successful');
  const adminToken = loginData ? loginData.token : '';

  // 2. Download sample CSV template
  const csvTemplateRes = await request({
    path: `/api/clients/sample-template?format=csv&token=${adminToken}`
  });
  assert(csvTemplateRes.status === 200, 'Sample CSV template returns HTTP 200');
  assert(csvTemplateRes.headers['content-type'].includes('text/csv'), 'Sample CSV template has text/csv header');
  assert(csvTemplateRes.text.includes('Mobile Number'), 'Sample CSV template contains "Mobile Number" header');
  assert(csvTemplateRes.text.includes('Patient Full Name'), 'Sample CSV template contains "Patient Full Name" header');

  // 3. Download sample Excel template (.xlsx)
  const xlsxTemplateRes = await request({
    path: `/api/clients/sample-template?format=xlsx&token=${adminToken}`
  });
  assert(xlsxTemplateRes.status === 200, 'Sample XLSX template returns HTTP 200');
  assert(
    xlsxTemplateRes.headers['content-type'].includes('spreadsheet') || xlsxTemplateRes.headers['content-type'].includes('octet-stream'),
    'Sample XLSX template has valid spreadsheet content-type'
  );
  assert(xlsxTemplateRes.rawBody.length > 500, 'Sample XLSX template has binary payload (> 500 bytes)');

  // Verify XLSX can be parsed by SheetJS
  try {
    const workbook = xlsx.read(xlsxTemplateRes.rawBody, { type: 'buffer' });
    assert(workbook.SheetNames.length > 0, `Parsed XLSX template with sheet: ${workbook.SheetNames[0]}`);
    const sheetData = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    assert(sheetData.length >= 2, `XLSX template contains ${sheetData.length} sample patient rows`);
  } catch (e) {
    assert(false, 'Failed to parse generated XLSX template: ' + e.message);
  }

  // 3b. Test Appointments Download as Excel Spreadsheet (.xlsx)
  const unauthExcelRes = await request({
    path: '/api/appointments/export-excel'
  });
  assert(unauthExcelRes.status === 401, 'Unauthenticated Excel appointments export request rejected with HTTP 401');

  const authExcelRes = await request({
    path: `/api/appointments/export-excel?token=${adminToken}`
  });
  assert(authExcelRes.status === 200, 'Authenticated Excel appointments export returns HTTP 200');
  assert(
    authExcelRes.headers['content-type'].includes('spreadsheet') || authExcelRes.headers['content-type'].includes('octet-stream'),
    'Excel appointments export returns valid spreadsheet content-type'
  );
  assert(
    authExcelRes.headers['content-disposition'].includes('.xlsx'),
    'Excel appointments export content-disposition specifies .xlsx attachment'
  );

  try {
    const aptWb = xlsx.read(authExcelRes.rawBody, { type: 'buffer' });
    assert(aptWb.SheetNames.includes('Appointments'), 'Exported Excel contains "Appointments" worksheet');
    const aptRows = xlsx.utils.sheet_to_json(aptWb.Sheets['Appointments']);
    assert(aptRows.length > 0, `Exported Excel contains ${aptRows.length} appointment records`);
    assert(aptRows[0]['Appointment ID'] !== undefined, 'Excel appointment row has "Appointment ID" column');
    assert(aptRows[0]['Doctor Name'] !== undefined, 'Excel appointment row has "Doctor Name" column');
    assert(aptRows[0]['Patient Full Name'] !== undefined, 'Excel appointment row has "Patient Full Name" column');
    assert(aptRows[0]['Fee'] !== undefined, 'Excel appointment row has "Fee" column');
    assert(aptRows[0]['Status'] !== undefined, 'Excel appointment row has "Status" column');
  } catch (e) {
    assert(false, 'Failed to parse appointments Excel workbook: ' + e.message);
  }

  // 4. Test Patient Import via CSV
  const testCsvContent = `Mobile Number,Account Holder Name,Patient Full Name,Relationship,Age or DOB,Gender,Medical Notes / History\r\n` +
    `+923009990001,Tariq Mahmood,Tariq Mahmood,Self,42,Male,Hypertension\r\n` +
    `+923009990001,Tariq Mahmood,Sobia Tariq,Spouse,38,Female,No known allergies\r\n` +
    `+923009990001,Tariq Mahmood,Hamza Tariq,Child,10,Male,Asthma inhaler as needed\r\n` +
    `+923009990002,Ayesha Khan,Ayesha Khan,Self,29,Female,Routine dental checkup`;

  const csvMultipart = buildMultipartFormData(
    {},
    'file',
    'patients_test.csv',
    Buffer.from(testCsvContent, 'utf8'),
    'text/csv'
  );

  const importCsvRes = await request({
    path: `/api/clients/import?token=${adminToken}`,
    method: 'POST'
  }, csvMultipart.body, csvMultipart.headers);

  const importCsvData = importCsvRes.json();
  assert(importCsvRes.status === 200 && importCsvData && importCsvData.success, 'CSV Import executed successfully');
  assert(importCsvData && importCsvData.importedCount === 4, `CSV Import registered 4 patient profiles (got ${importCsvData ? importCsvData.importedCount : 0})`);
  assert(importCsvData && importCsvData.clientsCount === 2, `CSV Import registered 2 unique client accounts (got ${importCsvData ? importCsvData.clientsCount : 0})`);

  // Verify imported data in GET /api/clients
  const getClientsRes = await request({
    path: `/api/clients`,
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const clientsData = getClientsRes.json();
  assert(clientsData && clientsData.success, 'GET /api/clients retrieved successfully');
  const tariqClient = (clientsData.clients || []).find(c => c.phone === '+923009990001');
  assert(tariqClient !== undefined, 'Imported client +923009990001 exists in database');
  if (tariqClient) {
    assert(tariqClient.patients && tariqClient.patients.length === 3, 'Tariq client has 3 family members (Self, Spouse, Child)');
  }

  // 5. Test Patient Import via XLSX
  const wb = xlsx.utils.book_new();
  const wsData = [
    ['Mobile Number', 'Account Holder Name', 'Patient Full Name', 'Relationship', 'Age or DOB', 'Gender', 'Medical Notes / History'],
    ['+923008880001', 'Zahid Iqbal', 'Zahid Iqbal', 'Self', '55', 'Male', 'Diabetic type 2'],
    ['+923008880001', 'Zahid Iqbal', 'Rashida Zahid', 'Spouse', '52', 'Female', 'Arthritis']
  ];
  const ws = xlsx.utils.aoa_to_sheet(wsData);
  xlsx.utils.book_append_sheet(wb, ws, 'ImportPatients');
  const xlsxBuffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const xlsxMultipart = buildMultipartFormData(
    {},
    'file',
    'patients_test.xlsx',
    xlsxBuffer,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );

  const importXlsxRes = await request({
    path: `/api/clients/import?token=${adminToken}`,
    method: 'POST'
  }, xlsxMultipart.body, xlsxMultipart.headers);

  const importXlsxData = importXlsxRes.json();
  assert(importXlsxRes.status === 200 && importXlsxData && importXlsxData.success, 'Excel XLSX Import executed successfully');
  assert(importXlsxData && importXlsxData.importedCount === 2, `Excel Import registered 2 patient profiles (got ${importXlsxData ? importXlsxData.importedCount : 0})`);

  // Verify Zahid client exists
  const getClientsRes2 = await request({
    path: `/api/clients`,
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const clientsData2 = getClientsRes2.json();
  const zahidClient = (clientsData2.clients || []).find(c => c.phone === '+923008880001');
  assert(zahidClient !== undefined, 'Imported client +923008880001 exists in database');

  // 6. Test Purge Demo Data
  // Ensure flag is 0 so we can test the purge transition
  const db = require('./src/database.js');
  await db.initDb();
  await db.runQuery('UPDATE settings SET sample_data_cleared = 0 WHERE id = 1');

  // Verify doctors exist before purge; if 0, insert one test doctor
  let getDocsBefore = await request({
    path: '/api/doctors',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  let docsBefore = getDocsBefore.json();
  if (!docsBefore || !docsBefore.doctors || docsBefore.doctors.length === 0) {
    await db.runQuery(
      'INSERT INTO doctors (name, title, specialty, personal_phone, email, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      ['Dr. Sample Test', 'Consultant', 'Cardiology', '+15551112222', 'sample@clinic.com']
    );
    getDocsBefore = await request({
      path: '/api/doctors',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    docsBefore = getDocsBefore.json();
  }
  assert(docsBefore && docsBefore.doctors && docsBefore.doctors.length > 0, `Pre-purge has ${docsBefore ? docsBefore.doctors.length : 0} doctors`);

  // Execute purge
  const purgeRes = await request({
    path: '/api/admin/purge-sample-data',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify({}));

  const purgeData = purgeRes.json();
  assert(purgeRes.status === 200 && purgeData && purgeData.success, 'Purge executed successfully');
  assert(purgeData.purged && purgeData.purged.doctors !== undefined, 'Purge result reports doctors purged');
  assert(purgeData.purged && purgeData.purged.patients !== undefined, 'Purge result reports patients purged');
  assert(purgeData.purged && purgeData.purged.appointments !== undefined, 'Purge result reports appointments purged');

  // Verify doctors, patients, appointments are now 0
  const getDocsAfter = await request({
    path: '/api/doctors',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const docsAfter = getDocsAfter.json();
  assert(docsAfter && docsAfter.doctors && docsAfter.doctors.length === 0, 'Post-purge doctors count is 0');

  const getAptsAfter = await request({
    path: '/api/appointments',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const aptsAfter = getAptsAfter.json();
  assert(aptsAfter && aptsAfter.appointments && aptsAfter.appointments.length === 0, 'Post-purge appointments count is 0');

  const getClientsAfter = await request({
    path: '/api/clients',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const clientsAfter = getClientsAfter.json();
  assert(clientsAfter && clientsAfter.clients && clientsAfter.clients.length === 0, 'Post-purge clients count is 0');

  // Verify Admin & Director users are still intact
  const getUsersAfter = await request({
    path: '/api/users',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const usersAfter = getUsersAfter.json();
  assert(usersAfter && usersAfter.users && usersAfter.users.length >= 2, `Admin/staff user accounts preserved (${usersAfter.users.length} users active)`);
  const adminUser = usersAfter.users.find(u => u.username === 'admin');
  assert(adminUser !== undefined, 'Admin user account preserved');

  // Verify subsequent purge is blocked
  const secondPurgeRes = await request({
    path: '/api/admin/purge-sample-data',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify({}));
  const secondPurgeData = secondPurgeRes.json();
  assert(secondPurgeRes.status === 400 && secondPurgeData && secondPurgeData.error.includes('permanently purged'), 'Subsequent purge attempt is rejected');

  console.log(`\n--- TEST SUITE SUMMARY: ${passed}/${total} assertions passed ---`);
  if (passed === total) {
    console.log('✅ ALL TESTS PASSED SUCCESSFULLY!');
  } else {
    console.error(`❌ ${total - passed} TESTS FAILED.`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
