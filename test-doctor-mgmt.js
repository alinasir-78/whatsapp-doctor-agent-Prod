const { initDb, getQuery, runQuery, allQuery } = require('./src/database');
const { processIncomingMessage } = require('./src/aiAgent');
const { getAvailableDoctorSlots } = require('./src/slotManager');

async function runDoctorMgmtTest() {
  console.log('🧪 Starting Doctor Management & Deactivation Test...\n');
  await initDb();

  // Reset doctor 1 to default before test
  await runQuery(`
    UPDATE doctors 
    SET name = 'Dr. Alexander Wright, MD', 
        specialty = 'Cardiology & Internal Medicine', 
        personal_phone = '+1 (555) 301-4401', 
        is_active = 1 
    WHERE id = 1
  `);

  // 1. Get an existing doctor
  const doctors = await allQuery('SELECT * FROM doctors ORDER BY id ASC');
  const testDoc = doctors[0];
  console.log(`Initial Doctor: [ID: ${testDoc.id}] ${testDoc.name} (${testDoc.specialty}) - Active: ${testDoc.is_active}`);

  // 2. Test Doctor Details Update
  const updatedName = 'Dr. Alexander Wright, MD, FACC';
  const updatedSpecialty = 'Interventional Cardiology';
  const updatedPhone = '+923345109999';

  await runQuery(`
    UPDATE doctors
    SET name = ?, specialty = ?, personal_phone = ?
    WHERE id = ?
  `, [updatedName, updatedSpecialty, updatedPhone, testDoc.id]);

  let docCheck = await getQuery('SELECT * FROM doctors WHERE id = ?', [testDoc.id]);
  if (docCheck.name !== updatedName || docCheck.specialty !== updatedSpecialty || docCheck.personal_phone !== updatedPhone) {
    throw new Error('Doctor info update failed in DB');
  }
  console.log('✅ Doctor profile info updated successfully!');

  // 3. Test Doctor Deactivation
  await runQuery('UPDATE doctors SET is_active = 0 WHERE id = ?', [testDoc.id]);
  docCheck = await getQuery('SELECT * FROM doctors WHERE id = ?', [testDoc.id]);
  if (docCheck.is_active !== 0) {
    throw new Error('Doctor deactivation failed');
  }
  console.log('✅ Doctor deactivated (is_active = 0)');

  // 4. Verify Doctor is excluded from active queries
  const activeDoctors = await allQuery('SELECT * FROM doctors WHERE is_active = 1');
  const foundInactiveInActiveList = activeDoctors.some(d => d.id === testDoc.id);
  if (foundInactiveInActiveList) {
    throw new Error('Inactive doctor appeared in active doctors list!');
  }
  console.log('✅ Inactive doctor correctly excluded from active doctor list');

  // 5. Verify Slot Generation returns 0 slots for deactivated doctor
  const slotResult = await getAvailableDoctorSlots(testDoc.id, '2026-10-01');
  if (slotResult.slots.length !== 0) {
    throw new Error(`Expected 0 slots for deactivated doctor, got ${slotResult.slots.length}`);
  }
  console.log('✅ Slot generator correctly returns 0 slots for deactivated doctor');

  // 6. Test WhatsApp Inquiry Menu excludes inactive doctor
  const testPhone = '9998887777';
  await runQuery('DELETE FROM chat_sessions WHERE phone = ?', [testPhone]);
  const inquiryReply = await processIncomingMessage(testPhone, 'doctors', 'Doctor Inquirer');
  if (inquiryReply.includes('Alexander Wright')) {
    throw new Error('Deactivated doctor appeared in WhatsApp doctor inquiry list!');
  }
  console.log('✅ WhatsApp inquiry menu correctly omits deactivated doctor');

  // 7. Test Doctor Reactivation
  await runQuery('UPDATE doctors SET is_active = 1, name = ?, specialty = ?, personal_phone = ? WHERE id = ?', [
    testDoc.name,
    testDoc.specialty,
    testDoc.personal_phone,
    testDoc.id
  ]);
  docCheck = await getQuery('SELECT * FROM doctors WHERE id = ?', [testDoc.id]);
  if (docCheck.is_active !== 1) {
    throw new Error('Doctor reactivation failed');
  }
  console.log('✅ Doctor successfully reactivated and restored');

  // 8. Test Doctor Deactivation with Scheduled Appointments Cancellation & Patient WhatsApp Alert
  console.log('\n--- Testing Deactivation with Scheduled Appointments Cancellation ---');
  const doc2 = doctors[1]; // Dr. Sophia Patel, MD
  const patientPhone = '923345108888';
  const testAptId = 'APT-TEST-88';

  // Seed test appointment
  await runQuery('DELETE FROM appointments WHERE id = ?', [testAptId]);
  await runQuery(`
    INSERT INTO appointments (
      id, doctor_id, doctor_name, doctor_phone, client_phone, patient_id,
      patient_name, service_id, service_name, date, start_time, end_time,
      fee, status, notes
    ) VALUES (?, ?, ?, ?, ?, 1, 'Emma Watson', 2, 'Pediatric Checkup', '2026-10-05', '10:00', '10:30', 95.0, 'confirmed', 'Test booking')
  `, [testAptId, doc2.id, doc2.name, doc2.personal_phone, patientPhone]);

  // Simulate API call to toggle-status with cancelAppointments = true
  const res = await fetch(`http://127.0.0.1:3000/api/doctors/${doc2.id}/toggle-status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancelAppointments: true })
  });
  const data = await res.json();

  if (!data.success || data.is_active !== 0 || data.cancelledCount < 1) {
    throw new Error('Doctor toggle with appointment cancellation failed: ' + JSON.stringify(data));
  }
  console.log(`✅ Doctor ${doc2.name} deactivated and ${data.cancelledCount} appointment(s) cancelled`);

  // Verify appointment in DB
  const cancelledApt = await getQuery('SELECT * FROM appointments WHERE id = ?', [testAptId]);
  if (cancelledApt.status !== 'cancelled' || cancelledApt.cancelled_by !== 'clinic') {
    throw new Error('Appointment status was not set to cancelled by clinic');
  }
  console.log('✅ Appointment status verified as cancelled by clinic');

  // Verify message sent to patient
  const patientMsg = await getQuery(`
    SELECT * FROM messages
    WHERE phone = ? AND direction = 'outbound'
    ORDER BY id DESC LIMIT 1
  `, [patientPhone]);

  if (!patientMsg || !patientMsg.message.includes('is no longer available with our clinic')) {
    throw new Error('Patient cancellation message does not contain required departure wording: ' + (patientMsg ? patientMsg.message : 'null'));
  }
  console.log('✅ Patient WhatsApp cancellation notification verified in message log:');
  console.log(patientMsg.message.split('\n').slice(0, 5).join('\n'));

  // Clean up: Reactivate doc2
  await fetch(`http://127.0.0.1:3000/api/doctors/${doc2.id}/toggle-status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancelAppointments: false })
  });
  await runQuery('DELETE FROM appointments WHERE id = ?', [testAptId]);
  await runQuery('DELETE FROM messages WHERE phone = ?', [patientPhone]);

  console.log('\n🎉 ALL DOCTOR MANAGEMENT & CANCELLATION TESTS PASSED!');
  process.exit(0);
}

runDoctorMgmtTest().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
