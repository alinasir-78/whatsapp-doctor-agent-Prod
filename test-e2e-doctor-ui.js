const { initDb, getQuery, runQuery, allQuery } = require('./src/database');

async function testDoctorWorkflow() {
  console.log('🧪 Starting End-to-End Doctor UI & Backend Test...\n');
  await initDb();

  // 1. Verify GET /api/doctors
  const getRes = await fetch('http://127.0.0.1:3000/api/doctors');
  if (!getRes.ok) throw new Error('GET /api/doctors failed with status ' + getRes.status);
  const getData = await getRes.json();
  console.log(`✅ GET /api/doctors returned ${getData.doctors.length} doctors`);

  // 2. Test POST /api/doctors (Adding a new doctor)
  const newDoctorPayload = {
    name: 'Dr. Christopher Nolan, MD',
    title: 'Consultant Neurologist',
    specialty: 'Neurology & Brain Health',
    personal_phone: '+923345101234',
    email: 'dr.nolan@apexclinic.com',
    color_code: '#0284c7',
    bio: 'Specialist in clinical neurology, cognitive care, and migraine treatments.'
  };

  const postRes = await fetch('http://127.0.0.1:3000/api/doctors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newDoctorPayload)
  });

  const contentType = postRes.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await postRes.text();
    throw new Error('POST /api/doctors returned non-JSON: ' + text);
  }

  const postData = await postRes.json();
  if (!postData.success || !postData.doctorId) {
    throw new Error('Failed to create doctor: ' + JSON.stringify(postData));
  }
  const createdDocId = postData.doctorId;
  console.log(`✅ POST /api/doctors successfully created doctor with ID: ${createdDocId}`);

  // 3. Verify Doctor Schedules created automatically
  const scheds = await allQuery('SELECT * FROM doctor_schedules WHERE doctor_id = ?', [createdDocId]);
  if (scheds.length !== 7) {
    throw new Error(`Expected 7 daily schedules for new doctor, got ${scheds.length}`);
  }
  console.log(`✅ Automatically generated 7 weekly schedules for new doctor ID ${createdDocId}`);

  // 4. Test Single Doctor Details Endpoint GET /api/doctors/:id
  const singleRes = await fetch(`http://127.0.0.1:3000/api/doctors/${createdDocId}`);
  const singleData = await singleRes.json();
  if (!singleData.success || singleData.doctor.name !== newDoctorPayload.name) {
    throw new Error('Single doctor fetch returned incorrect data');
  }
  console.log(`✅ GET /api/doctors/${createdDocId} returned accurate profile details`);

  // 5. Test Doctor Profile Update PUT /api/doctors/:id
  const updatedSpecialty = 'Neuro-Oncology & Brain Health';
  const updatedPhone = '+923345109999';
  const putRes = await fetch(`http://127.0.0.1:3000/api/doctors/${createdDocId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      specialty: updatedSpecialty,
      personal_phone: updatedPhone
    })
  });
  const putData = await putRes.json();
  if (!putData.success || putData.doctor.specialty !== updatedSpecialty || putData.doctor.personal_phone !== updatedPhone) {
    throw new Error('Doctor profile update failed: ' + JSON.stringify(putData));
  }
  console.log(`✅ PUT /api/doctors/${createdDocId} updated doctor profile successfully`);

  // 6. Test Doctor Deactivation
  const toggleRes = await fetch(`http://127.0.0.1:3000/api/doctors/${createdDocId}/toggle-status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancelAppointments: true })
  });
  const toggleData = await toggleRes.json();
  if (!toggleData.success || toggleData.is_active !== 0) {
    throw new Error('Deactivation failed: ' + JSON.stringify(toggleData));
  }
  console.log(`✅ Doctor ${createdDocId} deactivated successfully (is_active = 0)`);

  // Clean up test doctor
  await runQuery('DELETE FROM doctor_schedules WHERE doctor_id = ?', [createdDocId]);
  await runQuery('DELETE FROM doctors WHERE id = ?', [createdDocId]);
  console.log(`🧹 Cleaned up temporary test doctor ID ${createdDocId}`);

  console.log('\n🎉 ALL DOCTOR WORKFLOW AND ENDPOINT TESTS PASSED COMPLETELY!');
  process.exit(0);
}

testDoctorWorkflow().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
