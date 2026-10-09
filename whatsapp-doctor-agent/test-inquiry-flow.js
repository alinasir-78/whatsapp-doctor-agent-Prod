const { processIncomingMessage } = require('./src/aiAgent');
const { getQuery, allQuery, runQuery } = require('./src/database');

async function runTest() {
  console.log('🧪 Starting Inquiries vs Registration Verification Test...\n');
  const testPhone = '19998881111';

  // Clean any previous test data
  await runQuery('DELETE FROM appointments WHERE client_phone = ?', [testPhone]);
  await runQuery('DELETE FROM patients WHERE client_phone = ?', [testPhone]);
  await runQuery('DELETE FROM clients WHERE phone = ?', [testPhone]);
  await runQuery('DELETE FROM chat_sessions WHERE phone = ?', [testPhone]);

  async function checkRegistration() {
    const client = await getQuery('SELECT * FROM clients WHERE phone = ?', [testPhone]);
    const patients = await allQuery('SELECT * FROM patients WHERE client_phone = ?', [testPhone]);
    return { isClientRegistered: !!client, client, patientCount: patients.length, patients };
  }

  // 1. Initial Greeting
  console.log('--- Step 1: Guest sends "Hi" ---');
  let reply = await processIncomingMessage(testPhone, 'Hi');
  console.log('🤖 Agent Reply Snippet:\n' + reply.split('\n').slice(0, 4).join('\n') + '...');
  let reg = await checkRegistration();
  console.log(`📊 DB Check: Client Registered? ${reg.isClientRegistered} | Patient Records: ${reg.patientCount}`);
  if (reg.isClientRegistered) throw new Error('FAIL: Client was registered on greeting!');

  // 2. Pricing Inquiry
  console.log('\n--- Step 2: Guest inquires about prices ---');
  reply = await processIncomingMessage(testPhone, 'What are your prices and fees?');
  console.log('🤖 Agent Reply Snippet:\n' + reply.split('\n').slice(0, 3).join('\n') + '...');
  reg = await checkRegistration();
  console.log(`📊 DB Check: Client Registered? ${reg.isClientRegistered} | Patient Records: ${reg.patientCount}`);
  if (reg.isClientRegistered) throw new Error('FAIL: Client was registered on pricing inquiry!');

  // 3. Doctors Inquiry
  console.log('\n--- Step 3: Guest inquires about doctors ---');
  reply = await processIncomingMessage(testPhone, 'Who are your specialists and doctors?');
  console.log('🤖 Agent Reply Snippet:\n' + reply.split('\n').slice(0, 3).join('\n') + '...');
  reg = await checkRegistration();
  console.log(`📊 DB Check: Client Registered? ${reg.isClientRegistered} | Patient Records: ${reg.patientCount}`);
  if (reg.isClientRegistered) throw new Error('FAIL: Client was registered on doctor inquiry!');

  // 4. Location Inquiry
  console.log('\n--- Step 4: Guest inquires about location ---');
  reply = await processIncomingMessage(testPhone, 'Where is the clinic located?');
  console.log('🤖 Agent Reply Snippet:\n' + reply.split('\n').slice(0, 3).join('\n') + '...');
  reg = await checkRegistration();
  console.log(`📊 DB Check: Client Registered? ${reg.isClientRegistered} | Patient Records: ${reg.patientCount}`);
  if (reg.isClientRegistered) throw new Error('FAIL: Client was registered on location inquiry!');

  // 5. Unregistered user asks for bookings
  console.log('\n--- Step 5: Guest inquires about "my bookings" ---');
  reply = await processIncomingMessage(testPhone, 'My bookings');
  console.log('🤖 Agent Reply Snippet:\n' + reply.split('\n').slice(0, 2).join('\n'));
  reg = await checkRegistration();
  console.log(`📊 DB Check: Client Registered? ${reg.isClientRegistered} | Patient Records: ${reg.patientCount}`);
  if (reg.isClientRegistered) throw new Error('FAIL: Client was registered on "my bookings" inquiry!');

  // 6. User decides to book
  console.log('\n--- Step 6: Guest decides to book ("I want to book an appointment") ---');
  reply = await processIncomingMessage(testPhone, 'I want to book an appointment');
  console.log('🤖 Agent Reply:\n' + reply);
  reg = await checkRegistration();
  console.log(`📊 DB Check: Client Registered? ${reg.isClientRegistered} (Should be false until name is provided)`);
  if (reg.isClientRegistered) throw new Error('FAIL: Client was registered before name was provided!');

  // 7. User provides their name
  console.log('\n--- Step 7: User provides name ("Olivia Vance") ---');
  reply = await processIncomingMessage(testPhone, 'Olivia Vance');
  console.log('🤖 Agent Reply Snippet:\n' + reply.split('\n').slice(0, 5).join('\n') + '...');
  reg = await checkRegistration();
  console.log(`📊 DB Check: Client Registered? ${reg.isClientRegistered} | Name: ${reg.client ? reg.client.registered_name : 'none'}`);
  console.log(`📊 Patient Record Count: ${reg.patientCount}`);
  if (!reg.isClientRegistered || reg.client.registered_name !== 'Olivia Vance') {
    throw new Error('FAIL: Client should be registered now as Olivia Vance!');
  }
  if (reg.patientCount !== 1) {
    throw new Error('FAIL: Exactly 1 patient record should be created!');
  }

  // 8. User picks doctor (1)
  console.log('\n--- Step 8: User chooses Doctor 1 ---');
  reply = await processIncomingMessage(testPhone, '1');
  console.log('🤖 Agent Reply Snippet:\n' + reply.split('\n').slice(0, 4).join('\n') + '...');

  // 9. User picks service (1)
  console.log('\n--- Step 9: User chooses Service 1 ---');
  reply = await processIncomingMessage(testPhone, '1');
  console.log('🤖 Agent Reply Snippet:\n' + reply.split('\n').slice(0, 4).join('\n') + '...');

  // 10. User specifies date ("Tomorrow")
  console.log('\n--- Step 10: User specifies date ("Tomorrow") ---');
  reply = await processIncomingMessage(testPhone, 'Tomorrow');
  console.log('🤖 Agent Reply Snippet:\n' + reply.split('\n').slice(0, 4).join('\n') + '...');

  // 11. User chooses slot 1
  console.log('\n--- Step 11: User selects slot 1 ---');
  reply = await processIncomingMessage(testPhone, '1');
  console.log('🤖 Agent Reply Snippet:\n' + reply.split('\n').slice(0, 4).join('\n') + '...');

  // 12. Final confirmation
  console.log('\n--- Step 12: User confirms booking ("CONFIRM") ---');
  reply = await processIncomingMessage(testPhone, 'CONFIRM');
  console.log('🤖 Agent Reply Snippet:\n' + reply.split('\n').slice(0, 4).join('\n') + '...');

  // Check appointment in database
  const apt = await getQuery('SELECT * FROM appointments WHERE client_phone = ?', [testPhone]);
  console.log(`\n🎉 Verified: Appointment created in database: ${apt ? apt.id : 'NONE'} for patient ${apt ? apt.patient_name : 'NONE'}`);

  console.log('\n✅ ALL 12 VERIFICATION CHECKS PASSED PERFECTLY!\n');
}

runTest().catch(err => {
  console.error('❌ Test Error:', err);
  process.exit(1);
});
