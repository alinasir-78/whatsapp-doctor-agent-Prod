const { getQuery, allQuery, runQuery, getDateOffset, getClinicDateTime } = require('./database');
const {
  getAvailableDoctorSlots,
  getAllAvailableSlots,
  getImpactedAppointments,
  formatDateFriendly,
  formatTime12,
  timeToMinutes,
  acquireSlotHold,
  releaseSlotHold,
  checkSlotConflict
} = require('./slotManager');

function getTzLabel(settings) {
  return (settings && settings.timezone_label) ? settings.timezone_label : ((settings && settings.timezone) ? settings.timezone : 'PKT');
}

function parseNaturalDate(input, timezone = 'Asia/Karachi') {
  if (!input) return null;
  const text = input.trim().toLowerCase();
  const clinicNow = getClinicDateTime(timezone || 'Asia/Karachi');
  const baseDate = new Date(Date.UTC(clinicNow.year, clinicNow.month - 1, clinicNow.day));

  if (text.includes('today')) {
    return clinicNow.dateStr;
  }
  if (text.includes('tomorrow') || text === 'tmr') {
    const d = new Date(Date.UTC(clinicNow.year, clinicNow.month - 1, clinicNow.day));
    d.setUTCDate(d.getUTCDate() + 1);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  if (text.includes('day after tomorrow')) {
    const d = new Date(Date.UTC(clinicNow.year, clinicNow.month - 1, clinicNow.day));
    d.setUTCDate(d.getUTCDate() + 2);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < daysOfWeek.length; i++) {
    const dayName = daysOfWeek[i];
    if (text.includes(dayName)) {
      const currentDay = baseDate.getUTCDay();
      let diff = i - currentDay;
      if (diff <= 0) diff += 7;
      if (text.includes('next') && diff < 7) diff += 7;
      const d = new Date(Date.UTC(clinicNow.year, clinicNow.month - 1, clinicNow.day));
      d.setUTCDate(d.getUTCDate() + diff);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }
  }

  const isoMatch = text.match(/\b(202\d-\d{1,2}-\d{1,2})\b/);
  if (isoMatch) {
    const [y, m, d] = isoMatch[1].split('-').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const currentYear = clinicNow.year;

  for (let mIdx = 0; mIdx < months.length; mIdx++) {
    const mStr = months[mIdx];
    if (text.includes(mStr)) {
      const dayMatch = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
      if (dayMatch) {
        const day = parseInt(dayMatch[1], 10);
        return `${currentYear}-${String(mIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  }

  const onlyDayMatch = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (onlyDayMatch) {
    const day = parseInt(onlyDayMatch[1], 10);
    if (day >= 1 && day <= 31) {
      const currentMonth = clinicNow.month;
      return `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

function generateAppointmentId() {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `APT-${num}`;
}

function formatPrice(amount, settings) {
  const num = Number(amount || 0).toFixed(2);
  const symbol = (settings && settings.currency_symbol) ? settings.currency_symbol : '$';
  const pos = (settings && settings.currency_position) ? settings.currency_position : 'before';
  return pos === 'after' ? `${num} ${symbol}`.trim() : `${symbol}${num}`;
}

/**
 * Handle incoming message from any WhatsApp number (Client or Doctor)
 */
async function processIncomingMessage(phone, text) {
  const cleanPhone = phone.trim();
  const rawMsg = text.trim();
  const lowerMsg = rawMsg.toLowerCase();

  const settings = await getQuery('SELECT * FROM settings WHERE id = 1');
  if (!settings) throw new Error('Settings not found');

  // Check if sender is one of our registered Doctors using their personal phone!
  const activeDoctors = await allQuery('SELECT * FROM doctors WHERE is_active = 1');
  const normalizedIncoming = cleanPhone.replace(/\D/g, '').replace(/^0+/, '');
  const doctorSender = activeDoctors.find(d => {
    const docDigits = (d.personal_phone || '').replace(/\D/g, '').replace(/^0+/, '');
    if (!docDigits || !normalizedIncoming) return false;
    return docDigits === normalizedIncoming ||
           (docDigits.length >= 8 && normalizedIncoming.endsWith(docDigits)) ||
           (normalizedIncoming.length >= 8 && docDigits.endsWith(normalizedIncoming));
  });

  if (doctorSender) {
    return await handleDoctorSelfService(doctorSender, rawMsg, lowerMsg, settings);
  }

  // Otherwise, handle as Client / Patient
  return await handleClientInteraction(cleanPhone, rawMsg, lowerMsg, settings);
}

/**
 * Doctor Self-Service via their personal WhatsApp number!
 */
async function handleDoctorSelfService(doctor, rawMsg, lowerMsg, settings) {
  const tzLabel = getTzLabel(settings);
  const todayStr = getDateOffset(0, settings.timezone);
  const tomorrowStr = getDateOffset(1, settings.timezone);

  if (lowerMsg.includes('schedule') || lowerMsg.includes('appointments') || lowerMsg.includes('agenda') || lowerMsg.includes('today')) {
    const todayApts = await allQuery(`
      SELECT * FROM appointments
      WHERE doctor_id = ? AND date = ? AND status != 'cancelled'
      ORDER BY start_time ASC
    `, [doctor.id, todayStr]);

    const tomorrowApts = await allQuery(`
      SELECT * FROM appointments
      WHERE doctor_id = ? AND date = ? AND status != 'cancelled'
      ORDER BY start_time ASC
    `, [doctor.id, tomorrowStr]);

    let res = `👨‍⚕️ *Hello ${doctor.name}! Here is your schedule overview (${tzLabel}):*\n\n`;
    res += `📅 *Today (${formatDateFriendly(todayStr)}):*\n`;
    if (todayApts.length === 0) {
      res += `  _No appointments scheduled for today._\n`;
    } else {
      todayApts.forEach(a => {
        const badge = a.status === 'confirmed' ? '🟢' : '🟡';
        res += `  ${badge} *${formatTime12(a.start_time)} - ${formatTime12(a.end_time)}*: ${a.patient_name} (${a.service_name})\n`;
      });
    }

    res += `\n📅 *Tomorrow (${formatDateFriendly(tomorrowStr)}):*\n`;
    if (tomorrowApts.length === 0) {
      res += `  _No appointments scheduled for tomorrow._\n`;
    } else {
      tomorrowApts.forEach(a => {
        const badge = a.status === 'confirmed' ? '🟢' : '🟡';
        res += `  ${badge} *${formatTime12(a.start_time)} - ${formatTime12(a.end_time)}*: ${a.patient_name} (${a.service_name}) [${a.status}]\n`;
      });
    }

    res += `\n💡 *Doctor Commands:*\n` +
      `• _'Unavailable [Date] [Reason]'_ (e.g., _Unavailable tomorrow conference_)\n` +
      `• _'Reschedule [ID] to [Date] [Time]'*`;

    return res;
  }

  if (lowerMsg.startsWith('unavailable') || lowerMsg.includes('out of office') || lowerMsg.includes('on leave') || lowerMsg.includes('block')) {
    const parsedDate = parseNaturalDate(rawMsg, settings.timezone) || tomorrowStr;
    const reasonMatch = rawMsg.replace(/unavailable|out of office|on leave|block|tomorrow|today|\d{4}-\d{2}-\d{2}/gi, '').trim();
    const reason = reasonMatch.length > 2 ? reasonMatch : 'Doctor personal leave/conference';

    await runQuery(`
      INSERT INTO doctor_unavailability (doctor_id, date, is_full_day, reason)
      VALUES (?, ?, 1, ?)
    `, [doctor.id, parsedDate, reason]);

    const impacted = await getImpactedAppointments(doctor.id, parsedDate);

    let res = `✅ *Unavailability Recorded for ${doctor.name}*\n` +
      `🗓️ Date: *${formatDateFriendly(parsedDate)}*\n` +
      `📝 Reason: ${reason}\n\n`;

    if (impacted.length > 0) {
      res += `⚠️ *${impacted.length} patient appointment(s) are impacted:*\n`;
      impacted.forEach(a => {
        res += `• *${a.id}*: ${a.patient_name} at ${formatTime12(a.start_time)} (${a.service_name})\n`;
      });
      res += `\nOur AI agent will notify these patients via WhatsApp and provide them with instant rescheduling slots with other available doctors or alternate dates!`;

      await runQuery(`
        INSERT INTO owner_notifications (doctor_id, type, phone, message)
        VALUES (?, 'unavailability_set', ?, ?)
      `, [doctor.id, doctor.personal_phone, `Dr. ${doctor.name} set unavailability for ${parsedDate}. ${impacted.length} appointments flagged for rescheduling.`]);
    } else {
      res += `🎉 No appointments were scheduled on this date. Your calendar has been blocked for new bookings.`;
    }

    return res;
  }

  return `👨‍⚕️ *Doctor Portal Assistant — ${doctor.name}*\n\n` +
    `How may I assist you, Doctor?\n` +
    `1️⃣ Reply *'Schedule'* — view your agenda and patient roster\n` +
    `2️⃣ Reply *'Unavailable tomorrow [Reason]'* — block your schedule and notify impacted patients\n` +
    `3️⃣ Reply *'Reschedule [APT-ID] to [Date] [Time]'* — update any patient booking`;
}

/**
 * Handle Client / Patient WhatsApp Interaction
 */
async function handleClientInteraction(cleanPhone, rawMsg, lowerMsg, settings) {
  const todayStr = getDateOffset(0, settings.timezone);

  let session = await getQuery('SELECT * FROM chat_sessions WHERE phone = ?', [cleanPhone]);
  let state = session ? session.state : 'IDLE';
  let context = session ? JSON.parse(session.context_data || '{}') : {};

  let client = await getQuery('SELECT * FROM clients WHERE phone = ?', [cleanPhone]);

  await runQuery(
    'INSERT INTO messages (phone, direction, sender_name, message) VALUES (?, ?, ?, ?)',
    [cleanPhone, 'inbound', client ? client.registered_name : 'New Client', rawMsg]
  );

  async function reply(replyText, nextState = state, nextContext = context) {
    await runQuery(`
      INSERT INTO chat_sessions (phone, state, context_data, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(phone) DO UPDATE SET
        state = excluded.state,
        context_data = excluded.context_data,
        updated_at = CURRENT_TIMESTAMP
    `, [cleanPhone, nextState, JSON.stringify(nextContext)]);

    await runQuery(
      'INSERT INTO messages (phone, direction, sender_name, message) VALUES (?, ?, ?, ?)',
      [cleanPhone, 'outbound', settings.persona_name, replyText]
    );

    return replyText;
  }

  // --- HELPER: RENDER MAIN MENU GREETING ---
  function getMainGreeting(customNote = '') {
    const prefix = customNote ? `${customNote}\n\n` : '';
    if (client) {
      return (
        `${prefix}Hello ${client.registered_name}! 👋 I am ${settings.persona_name}, AI Care Coordinator at *${settings.business_name}*.\n\n` +
        `How may I assist you today?\n` +
        `1️⃣ *Book an appointment*\n` +
        `2️⃣ *View my bookings*\n` +
        `3️⃣ *Reschedule an appointment*\n` +
        `4️⃣ *Cancel an appointment*\n` +
        `5️⃣ *Doctors & specialties list*\n` +
        `6️⃣ *Services & pricing*\n` +
        `7️⃣ *Clinic address & directions*\n\n` +
        `Please reply with a number (1-7) or type your request in plain English.`
      );
    } else {
      return (
        `${prefix}Hello and welcome to *${settings.business_name}*! 👋\n` +
        `I am ${settings.persona_name}, your virtual care coordinator.\n\n` +
        `How may I assist you today?\n` +
        `1️⃣ *Book an appointment*\n` +
        `2️⃣ *Our doctors & specialties*\n` +
        `3️⃣ *Services & pricing catalog*\n` +
        `4️⃣ *Clinic address, hours & directions*\n\n` +
        `💡 *Feel free to ask any question about our clinic, doctors, or pricing. You will only be registered if and when you decide to book an appointment!*`
      );
    }
  }

  // --- UNIVERSAL HOME / MENU COMMAND ---
  // If user says menu / home / start / hi / hello from ANY state
  const isHomeCmd = ['menu', 'home', 'main menu', 'start', 'reset', 'hi', 'hello', 'hey', 'help', 'info'].includes(lowerMsg);
  if (isHomeCmd) {
    await releaseSlotHold(cleanPhone);
    return reply(getMainGreeting(), 'IDLE', {});
  }

  // --- REQUIREMENT 3: CANCEL IN THE MIDDLE OF A FLOW ---
  // "if the user write cancel anywhere else dont activate cancelling of appointment."
  // If the user writes "cancel" while in an in-progress flow (NOT IDLE and NOT already in cancellation states),
  // DO NOT activate appointment cancellation. Discard current progress and return to main menu safely.
  const isCancelWord = ['cancel', 'cancel current', 'discard', 'stop', 'abort', 'nevermind', 'never mind'].includes(lowerMsg);
  if (isCancelWord && state !== 'IDLE' && state !== 'PICK_APT_TO_CANCEL' && state !== 'CONFIRM_CANCEL') {
    await releaseSlotHold(cleanPhone);
    return reply(
      `Your current request has been discarded and you have returned to the main menu.\n` +
      `None of your active appointments were cancelled.\n\n` +
      getMainGreeting(),
      'IDLE',
      {}
    );
  }

  // --- REQUIREMENT 1: UNIVERSAL BACK / PREVIOUS NAVIGATION (0 or 'back') ---
  const isBackCmd = ['0', 'back', 'previous', 'prev', 'return'].includes(lowerMsg);
  if (isBackCmd) {
    switch (state) {
      case 'IDLE':
        return reply(getMainGreeting('You are currently at the main menu.'), 'IDLE', {});

      case 'REGISTER_NAME_FOR_BOOKING':
        return reply(getMainGreeting('Booking registration closed.'), 'IDLE', {});

      case 'SELECT_PATIENT_PROFILE':
        return reply(getMainGreeting('Returned to main menu.'), 'IDLE', {});

      case 'INPUT_NEW_PATIENT_NAME': {
        const patients = await allQuery('SELECT * FROM patients WHERE client_phone = ? ORDER BY id ASC', [cleanPhone]);
        context.patients = patients;
        let pList = `👤 *Who is this appointment for?*\n\n`;
        patients.forEach((p, i) => {
          pList += `${i + 1}️⃣ *${p.full_name}* (${p.relationship || 'Self'})\n`;
        });
        pList += `➕ *Reply 'NEW' to add a family member*\n\n` +
          `Reply with the number (1-${patients.length}) or *NEW*.\n` +
          `↩️ Reply *0* or *BACK* to return to main menu.`;
        return reply(pList, 'SELECT_PATIENT_PROFILE', context);
      }

      case 'INPUT_NEW_PATIENT_RELATION':
        return reply(
          `Please reply with the *full name* of the family member or person needing the appointment:\n\n` +
          `↩️ Reply *0* or *BACK* to go back | Reply *MENU* for main menu.`,
          'INPUT_NEW_PATIENT_NAME',
          context
        );

      case 'SELECT_DOCTOR': {
        if (!client) {
          return reply(getMainGreeting('Returned to main menu.'), 'IDLE', {});
        }
        const patients = await allQuery('SELECT * FROM patients WHERE client_phone = ? ORDER BY id ASC', [cleanPhone]);
        context.patients = patients;
        let pList = `👤 *Who is this appointment for?*\n\n`;
        patients.forEach((p, i) => {
          pList += `${i + 1}️⃣ *${p.full_name}* (${p.relationship || 'Self'})\n`;
        });
        pList += `➕ *Reply 'NEW' to add a family member*\n\n` +
          `Reply with the number (1-${patients.length}) or *NEW*.\n` +
          `↩️ Reply *0* or *BACK* to return to main menu.`;
        return reply(pList, 'SELECT_PATIENT_PROFILE', context);
      }

      case 'SELECT_SERVICE': {
        return showDoctorOrServiceSelection(reply, context, context.selectedPatient ? context.selectedPatient.full_name : 'the patient');
      }

      case 'SELECT_DATE': {
        return showServicesForDoctor(reply, context, context.selectedDoctor);
      }

      case 'SELECT_SLOT': {
        const docLabel = context.selectedDoctor ? `with *${context.selectedDoctor.name}*` : '';
        const serviceName = context.selectedService ? context.selectedService.name : 'Consultation';
        return reply(
          `Selected: *${serviceName}* ${docLabel}.\n\n` +
          `Which date would you like to schedule?\n` +
          `• *'Today'*\n` +
          `• *'Tomorrow'*\n` +
          `• *'Friday'*\n` +
          `• Or enter any date like _'Sep 30'_\n\n` +
          `↩️ Reply *0* or *BACK* to choose a different service | Reply *MENU* for main menu.`,
          'SELECT_DATE',
          context
        );
      }

      case 'CONFIRM_FINAL_BOOKING': {
        await releaseSlotHold(cleanPhone);
        const slots = context.availableSlots || [];
        const dateFriendly = formatDateFriendly(context.bookingDate);
        let slotMsg = `📅 Available slots on *${dateFriendly}*:\n\n`;
        slots.slice(0, 8).forEach((s, idx) => {
          const docName = s.doctorName ? ` (${s.doctorName})` : '';
          slotMsg += `${idx + 1}️⃣ *${s.displayTime}*${docName}\n`;
        });
        slotMsg += `\nPlease reply with the slot number (e.g. *1*) or time:\n` +
          `↩️ Reply *0* or *BACK* to choose another date | Reply *MENU* for main menu.`;
        return reply(slotMsg, 'SELECT_SLOT', context);
      }

      case 'PICK_APT_TO_CANCEL':
        return reply(
          `Cancellation closed. None of your appointments were cancelled.\n\n` + getMainGreeting(),
          'IDLE',
          {}
        );

      case 'CONFIRM_CANCEL': {
        const apts = await allQuery(`
          SELECT a.*, p.relationship
          FROM appointments a
          LEFT JOIN patients p ON a.patient_id = p.id
          WHERE a.client_phone = ? AND a.date >= ? AND a.status != 'cancelled'
          ORDER BY a.date ASC, a.start_time ASC
        `, [cleanPhone, todayStr]);

        if (apts.length <= 1) {
          return reply(
            `Cancellation aborted. Your appointment remains active!\n\n` + getMainGreeting(),
            'IDLE',
            {}
          );
        }

        let list = `Which appointment would you like to cancel? Reply with the number (1-${apts.length}) or ID:\n\n`;
        apts.forEach((a, i) => {
          list += `${i + 1}️⃣ *${a.id}* — ${a.patient_name} (${a.relationship || 'Self'}) with ${a.doctor_name} on ${formatDateFriendly(a.date)} at ${formatTime12(a.start_time)}\n`;
        });
        list += `\n↩️ Reply *0* or *BACK* to return to main menu (no appointment will be cancelled).`;
        return reply(list, 'PICK_APT_TO_CANCEL', { candidateApts: apts });
      }

      case 'PICK_APT_TO_RESCHEDULE':
        return reply(
          `Rescheduling closed. None of your appointments were modified.\n\n` + getMainGreeting(),
          'IDLE',
          {}
        );

      case 'RESCHEDULE_PICK_DATE':
      case 'RESCHEDULE_PICK_SLOT':
        return reply(
          `Rescheduling closed. Your appointment remains at its original time.\n\n` + getMainGreeting(),
          'IDLE',
          {}
        );

      default:
        return reply(getMainGreeting(), 'IDLE', {});
    }
  }

  // --- INFORMATIONAL INQUIRIES (Accessible to anyone without registering!) ---

  const isDocInquiry = lowerMsg.includes('doctor') ||
    lowerMsg.includes('physician') ||
    lowerMsg.includes('specialist') ||
    lowerMsg.includes('specialty') ||
    lowerMsg.includes('specialties') ||
    lowerMsg.includes('who works') ||
    lowerMsg.includes('medical staff') ||
    lowerMsg.includes('team') ||
    (!client && state === 'IDLE' && lowerMsg === '2') ||
    (client && state === 'IDLE' && lowerMsg === '5');

  const isPriceInquiry = lowerMsg.includes('price') ||
    lowerMsg.includes('pricing') ||
    lowerMsg.includes('cost') ||
    lowerMsg.includes('fee') ||
    lowerMsg.includes('fees') ||
    lowerMsg.includes('how much') ||
    lowerMsg.includes('charges') ||
    lowerMsg.includes('service') ||
    lowerMsg.includes('catalog') ||
    (!client && state === 'IDLE' && lowerMsg === '3') ||
    (client && state === 'IDLE' && lowerMsg === '6');

  const isLocInquiry = lowerMsg.includes('address') ||
    lowerMsg.includes('location') ||
    lowerMsg.includes('where are you') ||
    lowerMsg.includes('where is') ||
    lowerMsg.includes('direction') ||
    lowerMsg.includes('how to reach') ||
    lowerMsg.includes('hour') ||
    lowerMsg.includes('timing') ||
    lowerMsg.includes('open') ||
    lowerMsg.includes('map') ||
    (!client && state === 'IDLE' && lowerMsg === '4') ||
    (client && state === 'IDLE' && lowerMsg === '7');

  if (isDocInquiry && state === 'IDLE') {
    const doctors = await allQuery('SELECT * FROM doctors WHERE is_active = 1 ORDER BY id ASC');
    let docMsg = `👨‍⚕️ *Our Doctors & Specialists at ${settings.business_name}:*\n\n`;
    doctors.forEach((d, i) => {
      docMsg += `${i + 1}. *${d.name}*\n   🩺 _${d.specialty}_\n   📋 ${d.title}\n   ℹ️ ${d.bio}\n\n`;
    });
    docMsg += `💡 *Reply 1 or BOOK whenever you would like to schedule a consultation with any of our physicians!*\n` +
      `↩️ Reply *0* or *MENU* for main menu.`;
    return reply(docMsg, 'IDLE', {});
  }

  if (isPriceInquiry && state === 'IDLE') {
    const services = await allQuery(`
      SELECT s.*, d.name as doctor_name
      FROM services s
      LEFT JOIN doctors d ON s.doctor_id = d.id
      WHERE s.is_active = 1
      ORDER BY s.id ASC
    `);
    let serviceList = `🩺 *Services & Pricing Catalog at ${settings.business_name}:*\n\n`;
    services.forEach((s, i) => {
      const docLabel = s.doctor_name ? `with ${s.doctor_name}` : 'Available with all physicians';
      serviceList += `${i + 1}. *${s.name}* (${s.duration_minutes} min) — *${formatPrice(s.price, settings)}*\n   _${s.description}_\n   👨‍⚕️ ${docLabel}\n\n`;
    });
    serviceList += `💡 *Reply 1 or BOOK whenever you would like to schedule an appointment!*\n` +
      `↩️ Reply *0* or *MENU* for main menu.`;
    return reply(serviceList, 'IDLE', {});
  }

  if (isLocInquiry && state === 'IDLE') {
    return reply(
      `📍 *${settings.business_name} Location:*\n${settings.address}\n\n` +
      `🚗 *Arrival & Parking Instructions:*\n${settings.custom_instructions}\n\n` +
      `📞 *Clinic Phone:* ${settings.clinic_phone}\n` +
      `⏰ *Operating Hours:* Monday – Saturday: 08:00 AM – 06:00 PM\n\n` +
      `💡 *Reply 1 or BOOK whenever you would like to schedule an appointment!*\n` +
      `↩️ Reply *0* or *MENU* for main menu.`,
      'IDLE',
      {}
    );
  }

  if (lowerMsg.includes('cancellation policy') || lowerMsg.includes('reschedule policy') || lowerMsg.includes('refund policy')) {
    return reply(
      `ℹ️ *Cancellation & Rescheduling Policy:*\n${settings.cancellation_policy}\n\n` +
      `💡 *Reply 1 or BOOK whenever you're ready to schedule an appointment!*\n` +
      `↩️ Reply *0* or *MENU* for main menu.`,
      'IDLE',
      {}
    );
  }

  // --- 24-HOUR CONFIRMATION REPLY HANDLER (RESTRICTED TO IDLE STATE ONLY) ---
  // Fix for bug: Prevents "Confirm" from hijacking in-progress bookings (like spouse registration)
  if (state === 'IDLE' && ['confirm', 'yes', 'confirm appointment', 'confirmed', 'i confirm'].includes(lowerMsg)) {
    const pendingApt = await getQuery(`
      SELECT * FROM appointments
      WHERE client_phone = ? AND date >= ? AND status = 'tentative'
      ORDER BY date ASC, start_time ASC LIMIT 1
    `, [cleanPhone, todayStr]);

    if (pendingApt) {
      await runQuery(`
        UPDATE appointments
        SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [pendingApt.id]);

      await runQuery(`
        INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message)
        VALUES (?, 'confirmation_update', ?, ?, ?)
      `, [
        pendingApt.doctor_id,
        pendingApt.id,
        cleanPhone,
        `✅ Patient ${pendingApt.patient_name} confirmed attendance for ${pendingApt.date} at ${formatTime12(pendingApt.start_time)} with ${pendingApt.doctor_name}.`
      ]);

      if (pendingApt.doctor_phone) {
        try {
          const { sendWhatsAppMessage } = require('./whatsappService');
          await sendWhatsAppMessage(
            pendingApt.doctor_phone,
            `✅ [APPOINTMENT CONFIRMED] Hello ${pendingApt.doctor_name}!\nPatient ${pendingApt.patient_name} confirmed attendance for ${formatDateFriendly(pendingApt.date)} at ${formatTime12(pendingApt.start_time)}.`
          );
        } catch (e) {
          console.error('Doctor alert send error:', e.message);
        }
      }

      return reply(
        `✅ Thank you, ${client ? client.registered_name : pendingApt.patient_name}!\n` +
        `Your appointment for *${pendingApt.patient_name}* with *${pendingApt.doctor_name}* on *${formatDateFriendly(pendingApt.date)} at ${formatTime12(pendingApt.start_time)}* is *CONFIRMED*.\n\n` +
        `📍 ${settings.address}\n` +
        `We look forward to seeing you!`
      );
    }
  }

  // --- REQUIREMENT 4: VIEW BOOKINGS ("MY BOOKINGS") ---
  const isViewBookings = (state === 'IDLE' && (
    lowerMsg === '2' ||
    lowerMsg.includes('my booking') ||
    lowerMsg.includes('view booking') ||
    lowerMsg.includes('my appointment') ||
    lowerMsg === 'bookings'
  ));

  if (isViewBookings) {
    if (!client) {
      return reply(
        `ℹ️ There are currently no appointments registered under this mobile number (*${cleanPhone}*).\n\n` +
        `If you would like to book a new appointment, simply reply *1* or *BOOK*!\n` +
        `Or reply *2* to view our doctors or *3* to view services and pricing.`,
        'IDLE',
        {}
      );
    }

    const apts = await allQuery(`
      SELECT a.*, p.relationship
      FROM appointments a
      LEFT JOIN patients p ON a.patient_id = p.id
      WHERE a.client_phone = ? AND a.date >= ? AND a.status != 'cancelled'
      ORDER BY a.date ASC, a.start_time ASC
    `, [cleanPhone, todayStr]);

    const pastCountResult = await getQuery(`
      SELECT COUNT(*) as count
      FROM appointments
      WHERE client_phone = ? AND (date < ? OR status = 'cancelled')
    `, [cleanPhone, todayStr]);
    const pastCount = pastCountResult ? pastCountResult.count : 0;

    if (apts.length === 0) {
      let msg = `You currently have no upcoming appointments with ${settings.business_name}.\n\n`;
      if (pastCount > 0) {
        msg += `_(You have ${pastCount} past or cancelled appointment record(s) on file)_\n\n`;
      }
      msg += `Reply *1* or *BOOK* to schedule an appointment for yourself or a family member.\n` +
        `↩️ Reply *0* or *MENU* for main menu.`;
      return reply(msg, 'IDLE', {});
    }

    let msg = `📋 *Active Appointments for ${client.registered_name} & Family:*\n\n`;
    apts.forEach((a, i) => {
      const statusIcon = a.status === 'confirmed' ? '🟢 Confirmed' : (a.status === 'tentative' ? '🟡 Tentative (Pending Confirmation)' : a.status);
      const relationLabel = a.relationship ? ` (${a.relationship})` : '';

      msg += `*${i + 1}️⃣ ${a.id}* — ${statusIcon}\n`;
      msg += `   👤 Patient: *${a.patient_name}*${relationLabel}\n`;
      msg += `   👨‍⚕️ Doctor: *${a.doctor_name}*\n`;
      msg += `   🩺 Service: ${a.service_name}\n`;
      msg += `   🗓️ Date: *${formatDateFriendly(a.date)}*\n`;
      msg += `   ⏰ Time: *${formatTime12(a.start_time)} - ${formatTime12(a.end_time)} (${getTzLabel(settings)})*\n`;
      msg += `   💳 Fee: ${formatPrice(a.fee, settings)}\n\n`;
    });

    if (pastCount > 0) {
      msg += `_(+ ${pastCount} past or completed records on file)_\n\n`;
    }

    msg += `💡 *Available Actions:*\n` +
      `• Reply *CANCEL* to cancel an appointment\n` +
      `• Reply *RESCHEDULE* to change date/time\n` +
      `• Reply *1* or *BOOK* to book for another family member\n` +
      `↩️ Reply *0* or *MENU* for main menu`;

    return reply(msg, 'IDLE', {});
  }

  // --- REQUIREMENT 3: CANCELLATION FLOW (Triggered ONLY from IDLE or explicit cancel command) ---
  const isCancelBookingCmd = (state === 'IDLE' && (
    lowerMsg === '4' ||
    lowerMsg === 'cancel' ||
    lowerMsg.startsWith('cancel ') ||
    lowerMsg.includes('cancel appointment') ||
    lowerMsg.includes('cancel booking') ||
    lowerMsg.includes('cancel my appointment')
  ));

  if (isCancelBookingCmd) {
    if (!client) {
      return reply(
        `ℹ️ There are no active appointments registered under this mobile number (*${cleanPhone}*).\n\n` +
        `Reply *1* or *BOOK* to schedule an appointment.`,
        'IDLE',
        {}
      );
    }

    const apts = await allQuery(`
      SELECT a.*, p.relationship
      FROM appointments a
      LEFT JOIN patients p ON a.patient_id = p.id
      WHERE a.client_phone = ? AND a.date >= ? AND a.status != 'cancelled'
      ORDER BY a.date ASC, a.start_time ASC
    `, [cleanPhone, todayStr]);

    if (apts.length === 0) {
      return reply(
        `You have no active or upcoming appointments to cancel.\n\nReply *1* or *BOOK* to schedule an appointment.`,
        'IDLE',
        {}
      );
    }

    const matchId = rawMsg.match(/APT-\d{4}/i);
    let targetApt = null;
    if (matchId) {
      targetApt = apts.find(a => a.id.toLowerCase() === matchId[0].toLowerCase());
    }

    if (targetApt) {
      context.cancelAptId = targetApt.id;
      return reply(
        `⚠️ Are you sure you want to cancel the following appointment?\n\n` +
        `📌 *${targetApt.id}*\n` +
        `👤 Patient: *${targetApt.patient_name}* (${targetApt.relationship || 'Self'})\n` +
        `👨‍⚕️ Doctor: *${targetApt.doctor_name}*\n` +
        `🩺 Service: ${targetApt.service_name}\n` +
        `🗓️ Date: ${formatDateFriendly(targetApt.date)} at ${formatTime12(targetApt.start_time)}\n\n` +
        `Reply *YES* to confirm cancellation or *NO* (or 0) to keep your booking.`,
        'CONFIRM_CANCEL',
        context
      );
    }

    // Always ask which appointment to cancel if not explicitly given an ID
    let list = `Which appointment would you like to cancel? Reply with the number (1-${apts.length}) or ID:\n\n`;
    apts.forEach((a, i) => {
      list += `${i + 1}️⃣ *${a.id}* — ${a.patient_name} (${a.relationship || 'Self'}) with ${a.doctor_name} on ${formatDateFriendly(a.date)} at ${formatTime12(a.start_time)}\n`;
    });
    list += `\n↩️ Reply *0* or *BACK* to return to main menu (no appointment will be cancelled).`;
    return reply(list, 'PICK_APT_TO_CANCEL', { candidateApts: apts });
  }

  if (state === 'PICK_APT_TO_CANCEL') {
    const candidateApts = context.candidateApts || [];

    if (['no', 'cancel', 'none', 'abort', 'keep', '0', 'back'].includes(lowerMsg)) {
      return reply(
        `Cancellation closed. None of your appointments were cancelled.\n\n` + getMainGreeting(),
        'IDLE',
        {}
      );
    }

    const choiceNum = parseInt(lowerMsg, 10);
    let chosenApt = null;

    if (choiceNum >= 1 && choiceNum <= candidateApts.length) {
      chosenApt = candidateApts[choiceNum - 1];
    } else {
      const match = rawMsg.match(/APT-\d{4}/i);
      if (match) {
        chosenApt = candidateApts.find(a => a.id.toLowerCase() === match[0].toLowerCase());
      }
    }

    if (!chosenApt) {
      return reply(
        `Please reply with a valid appointment number (1-${candidateApts.length}) or ID.\n` +
        `↩️ Or reply *0* or *BACK* to return to main menu without cancelling.`
      );
    }

    context.cancelAptId = chosenApt.id;
    return reply(
      `⚠️ Are you sure you want to cancel appointment *${chosenApt.id}* for *${chosenApt.patient_name}* with *${chosenApt.doctor_name}* on *${formatDateFriendly(chosenApt.date)} at ${formatTime12(chosenApt.start_time)}*?\n\n` +
      `Reply *YES* to confirm cancellation, or *NO* (or 0) to keep your appointment.`,
      'CONFIRM_CANCEL',
      context
    );
  }

  if (state === 'CONFIRM_CANCEL') {
    if (lowerMsg === 'yes' || lowerMsg === 'confirm' || lowerMsg === 'y') {
      const aptId = context.cancelAptId;
      const apt = await getQuery('SELECT * FROM appointments WHERE id = ?', [aptId]);

      if (apt) {
        await runQuery(
          "UPDATE appointments SET status = 'cancelled', cancelled_by = 'client' WHERE id = ?",
          [aptId]
        );

        await runQuery(
          'INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message) VALUES (?, ?, ?, ?, ?)',
          [
            apt.doctor_id,
            'cancelled',
            aptId,
            cleanPhone,
            `❌ Appointment ${aptId} cancelled by client (${client.registered_name}) for patient ${apt.patient_name} with ${apt.doctor_name} on ${apt.date} at ${formatTime12(apt.start_time)}. Slot is freed.`
          ]
        );

        if (apt.doctor_phone) {
          try {
            const { sendWhatsAppMessage } = require('./whatsappService');
            await sendWhatsAppMessage(
              apt.doctor_phone,
              `❌ [APPOINTMENT CANCELLED] Hello ${apt.doctor_name}!\n` +
              `• Appointment: ${aptId}\n` +
              `• Patient: ${apt.patient_name}\n` +
              `• Schedule: ${formatDateFriendly(apt.date)} at ${formatTime12(apt.start_time)}\n` +
              `• Client: ${client.registered_name} (${cleanPhone})\n` +
              `The slot has been released back to your schedule.`
            );
          } catch (e) {
            console.error('Doctor alert WhatsApp error:', e.message);
          }
        }

        return reply(
          `✅ Appointment *${aptId}* for *${apt.patient_name}* has been cancelled.\n` +
          `The slot has been released. If you wish to re-book at any time, simply reply *BOOK* or *MENU*.`,
          'IDLE',
          {}
        );
      } else {
        return reply(`Appointment could not be found. Returned to main menu.`, 'IDLE', {});
      }
    } else {
      return reply(`Cancellation aborted. Your appointment *${context.cancelAptId}* remains active!`, 'IDLE', {});
    }
  }

  // --- RESCHEDULING FLOW ---
  const isRescheduleCmd = (state === 'IDLE' && (
    lowerMsg === '3' ||
    lowerMsg.startsWith('reschedule') ||
    lowerMsg.includes('reschedule appointment') ||
    lowerMsg.includes('reschedule booking')
  ));

  if (isRescheduleCmd) {
    if (!client) {
      return reply(
        `ℹ️ There are no active appointments registered under this mobile number (*${cleanPhone}*).\n\n` +
        `Reply *1* or *BOOK* to schedule an appointment.`,
        'IDLE',
        {}
      );
    }

    const apts = await allQuery(`
      SELECT a.*, p.relationship
      FROM appointments a
      LEFT JOIN patients p ON a.patient_id = p.id
      WHERE a.client_phone = ? AND a.date >= ? AND a.status != 'cancelled'
      ORDER BY a.date ASC, a.start_time ASC
    `, [cleanPhone, todayStr]);

    if (apts.length === 0) {
      return reply(`You have no active appointments to reschedule. Reply *1* to book a new appointment.`);
    }

    const matchId = rawMsg.match(/APT-\d{4}/i);
    let targetApt = null;
    if (matchId) {
      targetApt = apts.find(a => a.id.toLowerCase() === matchId[0].toLowerCase());
    } else if (apts.length === 1) {
      targetApt = apts[0];
    }

    if (targetApt) {
      context = {
        rescheduleAptId: targetApt.id,
        doctorId: targetApt.doctor_id,
        doctorName: targetApt.doctor_name,
        patientName: targetApt.patient_name,
        patientRelationship: targetApt.relationship || 'Self',
        serviceId: targetApt.service_id,
        serviceName: targetApt.service_name,
        fee: targetApt.fee
      };
      return reply(
        `Rescheduling appointment *${targetApt.id}* for *${targetApt.patient_name}* with *${targetApt.doctor_name}* (${targetApt.service_name}).\n` +
        `Currently booked for: ${formatDateFriendly(targetApt.date)} at ${formatTime12(targetApt.start_time)}.\n\n` +
        `Which new date would you prefer?\n(e.g., 'Tomorrow', 'Friday', 'Monday')\n\n` +
        `↩️ Reply *0* or *BACK* to return to main menu | Reply *MENU* for main menu.`,
        'RESCHEDULE_PICK_DATE',
        context
      );
    } else {
      let list = `Which appointment would you like to reschedule? Reply with the number (1-${apts.length}) or ID:\n\n`;
      apts.forEach((a, i) => {
        list += `${i + 1}️⃣ *${a.id}* — ${a.patient_name} (${a.relationship || 'Self'}) with ${a.doctor_name} on ${formatDateFriendly(a.date)} at ${formatTime12(a.start_time)}\n`;
      });
      list += `\n↩️ Reply *0* or *BACK* to return to main menu.`;
      return reply(list, 'PICK_APT_TO_RESCHEDULE', { candidateApts: apts });
    }
  }

  if (state === 'PICK_APT_TO_RESCHEDULE') {
    const candidateApts = context.candidateApts || [];
    const choiceNum = parseInt(lowerMsg, 10);
    let chosenApt = null;

    if (choiceNum >= 1 && choiceNum <= candidateApts.length) {
      chosenApt = candidateApts[choiceNum - 1];
    } else {
      const match = rawMsg.match(/APT-\d{4}/i);
      if (match) {
        chosenApt = candidateApts.find(a => a.id.toLowerCase() === match[0].toLowerCase());
      }
    }

    if (!chosenApt) {
      return reply(
        `Please select a valid appointment number (1-${candidateApts.length}) or ID.\n` +
        `↩️ Or reply *0* or *BACK* to return to main menu.`
      );
    }

    context = {
      rescheduleAptId: chosenApt.id,
      doctorId: chosenApt.doctor_id,
      doctorName: chosenApt.doctor_name,
      patientName: chosenApt.patient_name,
      patientRelationship: chosenApt.relationship || 'Self',
      serviceId: chosenApt.service_id,
      serviceName: chosenApt.service_name,
      fee: chosenApt.fee
    };

    return reply(
      `Rescheduling appointment *${chosenApt.id}* for *${chosenApt.patient_name}* with *${chosenApt.doctor_name}*.\n` +
      `Currently booked for: ${formatDateFriendly(chosenApt.date)} at ${formatTime12(chosenApt.start_time)}.\n\n` +
      `Which new date would you prefer?\n(e.g., 'Tomorrow', 'Friday', 'Monday')\n\n` +
      `↩️ Reply *0* or *BACK* to return to main menu | Reply *MENU* for main menu.`,
      'RESCHEDULE_PICK_DATE',
      context
    );
  }

  if (state === 'RESCHEDULE_PICK_DATE') {
    const targetDate = parseNaturalDate(rawMsg, settings.timezone);
    if (!targetDate) {
      return reply(
        `I could not parse that date. Please try 'Tomorrow', 'Friday', or 'next Monday'.\n` +
        `↩️ Reply *0* or *BACK* to return to main menu.`
      );
    }

    const availability = await getAvailableDoctorSlots(context.doctorId, targetDate, 30, context.rescheduleAptId);
    if (!availability.available || availability.slots.length === 0) {
      return reply(
        `Sorry, ${availability.reason || 'no slots open for ' + context.doctorName + ' on ' + targetDate}.\n` +
        `Please choose another date (e.g. 'Monday'):\n` +
        `↩️ Reply *0* to return to main menu.`
      );
    }

    context.newDate = targetDate;
    context.availableSlots = availability.slots;

    let slotMsg = `📅 Available slots with *${context.doctorName}* on *${availability.dateFormatted}*:\n\n`;
    availability.slots.forEach((s, idx) => {
      slotMsg += `${idx + 1}️⃣ *${s.displayTime}*\n`;
    });
    slotMsg += `\nPlease reply with the slot number (e.g. *1*) or time:\n` +
      `↩️ Reply *0* or *BACK* to pick another date | Reply *MENU* for main menu.`;

    return reply(slotMsg, 'RESCHEDULE_PICK_SLOT', context);
  }

  if (state === 'RESCHEDULE_PICK_SLOT') {
    const slots = context.availableSlots || [];
    let selectedSlot = null;

    const num = parseInt(lowerMsg, 10);
    if (num >= 1 && num <= slots.length) {
      selectedSlot = slots[num - 1];
    } else {
      selectedSlot = slots.find(s => s.displayTime.toLowerCase().includes(lowerMsg) || s.startTime.includes(lowerMsg));
    }

    if (!selectedSlot) {
      return reply(
        `Please reply with a valid slot number (1-${slots.length}) or time.\n` +
        `↩️ Reply *0* or *BACK* to pick a different date.`
      );
    }

    const aptId = context.rescheduleAptId;
    await runQuery(`
      UPDATE appointments
      SET date = ?, start_time = ?, end_time = ?, status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [context.newDate, selectedSlot.startTime, selectedSlot.endTime, aptId]);

    const tzLabel = getTzLabel(settings);
    await runQuery(`
      INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message)
      VALUES (?, 'rescheduled', ?, ?, ?)
    `, [
      context.doctorId,
      aptId,
      cleanPhone,
      `🔄 Appointment ${aptId} rescheduled by client (${client.registered_name}) for patient ${context.patientName} to ${formatDateFriendly(context.newDate)} at ${selectedSlot.displayTime} (${tzLabel}) with ${context.doctorName}.`
    ]);

    return reply(
      `🎉 *Appointment Rescheduled Successfully!*\n\n` +
      `📌 ID: *${aptId}*\n` +
      `👤 Patient: *${context.patientName}*\n` +
      `👨‍⚕️ Doctor: *${context.doctorName}*\n` +
      `🩺 Service: *${context.serviceName}*\n` +
      `🗓️ New Date: *${formatDateFriendly(context.newDate)}*\n` +
      `⏰ New Time: *${selectedSlot.displayTime} - ${selectedSlot.displayEnd} (${tzLabel})*\n` +
      `📍 Location: ${settings.address}\n\n` +
      `We look forward to seeing you then! Reply *MY BOOKINGS* anytime to view your appointments.`,
      'IDLE',
      {}
    );
  }

  // --- BOOKING INTENT FLOW ---
  const isBookingIntent = (state === 'IDLE' && (
    lowerMsg === '1' ||
    lowerMsg === 'book' ||
    lowerMsg.startsWith('book ') ||
    lowerMsg.includes('book an appointment') ||
    lowerMsg.includes('schedule') ||
    lowerMsg.includes('new appointment') ||
    lowerMsg.includes('consultation') ||
    lowerMsg.includes('make an appointment') ||
    lowerMsg.includes('i want to book') ||
    lowerMsg.includes('i need an appointment') ||
    lowerMsg.includes('need an appointment') ||
    lowerMsg.includes('need appointment')
  ));

  if (isBookingIntent) {
    if (!client) {
      // Unregistered visitor deciding to book -> Prompt for full name
      return reply(
        `I would be delighted to help you schedule an appointment at *${settings.business_name}*! 🩺\n\n` +
        `To reserve your appointment slot, may I please have your *full name*?\n\n` +
        `↩️ Reply *0* or *BACK* to return to main menu | Reply *MENU* for main menu.`,
        'REGISTER_NAME_FOR_BOOKING',
        {}
      );
    } else {
      // Registered client -> choose patient (self or family member)
      const patients = await allQuery('SELECT * FROM patients WHERE client_phone = ? ORDER BY id ASC', [cleanPhone]);
      context = { patients };

      let pList = `👤 *Who is this appointment for?*\n\n`;
      patients.forEach((p, i) => {
        pList += `${i + 1}️⃣ *${p.full_name}* (${p.relationship || 'Self'})\n`;
      });
      pList += `➕ *Reply 'NEW' to add another family member*\n\n` +
        `Please reply with the number (1-${patients.length}), name, or *NEW*:\n` +
        `↩️ Reply *0* or *BACK* to return to main menu | Reply *MENU* for main menu.`;
      return reply(pList, 'SELECT_PATIENT_PROFILE', context);
    }
  }

  // --- REGISTRATION TRIGGER: UNREGISTERED USER ENTERING NAME ---
  if (state === 'REGISTER_NAME_FOR_BOOKING') {
    const fullName = rawMsg.replace(/^(my name is|i am|name:)\s*/i, '').trim();
    if (fullName.length < 2 || /^\d+$/.test(fullName)) {
      return reply(
        `Please provide your full name (first and last name) so we can register your appointment:\n` +
        `↩️ Reply *0* to return to main menu.`
      );
    }

    await runQuery('INSERT INTO clients (phone, registered_name) VALUES (?, ?)', [cleanPhone, fullName]);
    const pResult = await runQuery(
      'INSERT INTO patients (client_phone, full_name, relationship, age_or_notes) VALUES (?, ?, ?, ?)',
      [cleanPhone, fullName, 'Self', 'Primary Account Holder']
    );

    const newPatient = {
      id: pResult.lastID,
      client_phone: cleanPhone,
      full_name: fullName,
      relationship: 'Self'
    };

    context.selectedPatient = newPatient;

    return showDoctorOrServiceSelection(reply, context, fullName);
  }

  // --- REQUIREMENT 2 & 4: SELECT PATIENT PROFILE (Self or Family Member) ---
  if (state === 'SELECT_PATIENT_PROFILE') {
    const patients = context.patients || await allQuery('SELECT * FROM patients WHERE client_phone = ? ORDER BY id ASC', [cleanPhone]);
    context.patients = patients;

    // Check if user requested NEW family member
    if (lowerMsg === 'new' || lowerMsg.includes('add') || lowerMsg.includes('other') || lowerMsg.includes('family') || lowerMsg.includes('another')) {
      return reply(
        `Please reply with the *full name* of the family member or person needing the appointment:\n\n` +
        `↩️ Reply *0* or *BACK* to go back | Reply *MENU* for main menu.`,
        'INPUT_NEW_PATIENT_NAME',
        context
      );
    }

    // Check choice by number
    const choice = parseInt(lowerMsg, 10);
    let chosenPatient = null;

    if (choice >= 1 && choice <= patients.length) {
      chosenPatient = patients[choice - 1];
    } else {
      // Check choice by name
      chosenPatient = patients.find(p => lowerMsg.includes(p.full_name.toLowerCase()) || p.full_name.toLowerCase().includes(lowerMsg));

      // If not matched by name, check by relationship (e.g. "spouse", "wife", "husband", "child", "son", "daughter", "self", "me")
      if (!chosenPatient) {
        if (lowerMsg.includes('spouse') || lowerMsg.includes('wife') || lowerMsg.includes('husband')) {
          chosenPatient = patients.find(p => p.relationship && ['spouse', 'wife', 'husband'].includes(p.relationship.toLowerCase()));
        } else if (lowerMsg.includes('child') || lowerMsg.includes('son') || lowerMsg.includes('daughter') || lowerMsg.includes('kid')) {
          chosenPatient = patients.find(p => p.relationship && ['child', 'son', 'daughter'].includes(p.relationship.toLowerCase()));
        } else if (lowerMsg.includes('self') || lowerMsg.includes('me') || lowerMsg.includes('myself')) {
          chosenPatient = patients.find(p => p.relationship && ['self', 'primary account holder'].includes(p.relationship.toLowerCase()));
        }
      }
    }

    if (!chosenPatient) {
      return reply(
        `Please reply with a valid number (1-${patients.length}), patient name, or *NEW* to add a family member.\n` +
        `↩️ Reply *0* or *BACK* to return to main menu.`
      );
    }

    context.selectedPatient = {
      id: chosenPatient.id,
      client_phone: chosenPatient.client_phone,
      full_name: chosenPatient.full_name,
      relationship: chosenPatient.relationship
    };

    return showDoctorOrServiceSelection(reply, context, chosenPatient.full_name);
  }

  // --- INPUT NEW PATIENT NAME ---
  if (state === 'INPUT_NEW_PATIENT_NAME') {
    const newName = rawMsg.trim();
    if (newName.length < 2 || /^\d+$/.test(newName)) {
      return reply(
        `Please enter a valid full name for the person:\n` +
        `↩️ Reply *0* to go back.`
      );
    }

    context.tempNewPatientName = newName;
    return reply(
      `What is *${newName}*'s relationship to you?\n\n` +
      `1️⃣ *Spouse* (Wife / Husband)\n` +
      `2️⃣ *Child* (Son / Daughter)\n` +
      `3️⃣ *Parent* (Mother / Father)\n` +
      `4️⃣ *Sibling* (Brother / Sister)\n` +
      `5️⃣ *Other / Dependent*\n\n` +
      `Reply with the number (1-5) or relationship name:\n` +
      `↩️ Reply *0* or *BACK* to change name | Reply *MENU* for main menu.`,
      'INPUT_NEW_PATIENT_RELATION',
      context
    );
  }

  // --- INPUT NEW PATIENT RELATIONSHIP ---
  if (state === 'INPUT_NEW_PATIENT_RELATION') {
    const fullName = context.tempNewPatientName;
    let relation = 'Family Member';

    if (lowerMsg === '1' || lowerMsg.includes('spouse') || lowerMsg.includes('wife') || lowerMsg.includes('husband')) {
      relation = 'Spouse';
    } else if (lowerMsg === '2' || lowerMsg.includes('child') || lowerMsg.includes('son') || lowerMsg.includes('daughter') || lowerMsg.includes('kid')) {
      relation = 'Child';
    } else if (lowerMsg === '3' || lowerMsg.includes('parent') || lowerMsg.includes('father') || lowerMsg.includes('mother')) {
      relation = 'Parent';
    } else if (lowerMsg === '4' || lowerMsg.includes('sibling') || lowerMsg.includes('brother') || lowerMsg.includes('sister')) {
      relation = 'Sibling';
    } else if (lowerMsg === '5' || lowerMsg.includes('other')) {
      relation = 'Other';
    } else if (rawMsg.trim().length > 1) {
      relation = rawMsg.trim();
      relation = relation.charAt(0).toUpperCase() + relation.slice(1);
    }

    const result = await runQuery(
      'INSERT INTO patients (client_phone, full_name, relationship) VALUES (?, ?, ?)',
      [cleanPhone, fullName, relation]
    );

    const newPatient = {
      id: result.lastID,
      client_phone: cleanPhone,
      full_name: fullName,
      relationship: relation
    };

    context.selectedPatient = newPatient;
    return showDoctorOrServiceSelection(reply, context, fullName);
  }

  async function showDoctorOrServiceSelection(replyFn, currentContext, patientName) {
    const doctors = await allQuery('SELECT * FROM doctors WHERE is_active = 1 ORDER BY id ASC');
    currentContext.doctors = doctors;

    const patientRel = currentContext.selectedPatient && currentContext.selectedPatient.relationship ? ` (${currentContext.selectedPatient.relationship})` : '';

    let docMsg = `Great! Which doctor would you like to see for *${patientName}*${patientRel}?\n\n`;
    doctors.forEach((d, i) => {
      docMsg += `${i + 1}️⃣ *${d.name}*\n   🩺 ${d.specialty} (${d.title})\n\n`;
    });
    docMsg += `Reply with the doctor number (1-${doctors.length}) or reply *ANY* for first available physician.\n` +
      `↩️ Reply *0* or *BACK* to change patient | Reply *MENU* for main menu.`;

    return replyFn(docMsg, 'SELECT_DOCTOR', currentContext);
  }

  // --- SELECT DOCTOR ---
  if (state === 'SELECT_DOCTOR') {
    const doctors = context.doctors || await allQuery('SELECT * FROM doctors WHERE is_active = 1 ORDER BY id ASC');
    context.doctors = doctors;
    let chosenDoctor = null;

    if (lowerMsg === 'any' || lowerMsg.includes('first available') || lowerMsg.includes('anyone')) {
      context.selectedDoctor = null;
      return showServicesForDoctor(reply, context, null);
    }

    const choice = parseInt(lowerMsg, 10);
    if (choice >= 1 && choice <= doctors.length) {
      chosenDoctor = doctors[choice - 1];
    } else {
      chosenDoctor = doctors.find(d => lowerMsg.includes(d.name.toLowerCase()) || lowerMsg.includes(d.specialty.toLowerCase()));
    }

    if (!chosenDoctor) {
      return reply(
        `Please select a doctor number (1-${doctors.length}) or reply *ANY*.\n` +
        `↩️ Reply *0* or *BACK* to go back | Reply *MENU* for main menu.`
      );
    }

    context.selectedDoctor = chosenDoctor;
    return showServicesForDoctor(reply, context, chosenDoctor);
  }

  async function showServicesForDoctor(replyFn, currentContext, doctor) {
    let sql = 'SELECT * FROM services WHERE is_active = 1';
    const params = [];
    if (doctor) {
      sql += ' AND (doctor_id = ? OR doctor_id IS NULL)';
      params.push(doctor.id);
    }
    sql += ' ORDER BY id ASC';

    const services = await allQuery(sql, params);
    currentContext.services = services;

    const docName = doctor ? doctor.name : 'any available physician';
    let serviceMsg = `Please select the consultation service with *${docName}*:\n\n`;
    services.forEach((s, i) => {
      serviceMsg += `${i + 1}️⃣ *${s.name}*\n   ⏱️ ${s.duration_minutes} mins | 💳 ${formatPrice(s.price, settings)}\n   _${s.description}_\n\n`;
    });
    serviceMsg += `Please reply with the service number (1-${services.length}):\n` +
      `↩️ Reply *0* or *BACK* to choose a different doctor | Reply *MENU* for main menu.`;

    return replyFn(serviceMsg, 'SELECT_SERVICE', currentContext);
  }

  // --- SELECT SERVICE ---
  if (state === 'SELECT_SERVICE') {
    const services = context.services || [];
    const choice = parseInt(lowerMsg, 10);
    let selectedService = null;

    if (choice >= 1 && choice <= services.length) {
      selectedService = services[choice - 1];
    } else {
      selectedService = services.find(s => lowerMsg.includes(s.name.toLowerCase()));
    }

    if (!selectedService) {
      return reply(
        `Please enter a valid service number between 1 and ${services.length}.\n` +
        `↩️ Reply *0* or *BACK* to choose a different doctor | Reply *MENU* for main menu.`
      );
    }

    context.selectedService = selectedService;

    if (!context.selectedDoctor && selectedService.doctor_id) {
      context.selectedDoctor = await getQuery('SELECT * FROM doctors WHERE id = ? AND is_active = 1', [selectedService.doctor_id]);
    }

    const docLabel = context.selectedDoctor ? `with *${context.selectedDoctor.name}*` : '';
    const patientName = context.selectedPatient ? context.selectedPatient.full_name : 'Patient';

    return reply(
      `Selected: *${selectedService.name}* (${formatPrice(selectedService.price, settings)}) ${docLabel} for *${patientName}*.\n\n` +
      `Which date would you like to schedule?\n` +
      `You can reply with:\n` +
      `• *'Today'*\n` +
      `• *'Tomorrow'*\n` +
      `• *'Friday'*\n` +
      `• Or enter any date like _'Sep 30'_\n\n` +
      `↩️ Reply *0* or *BACK* to change service | Reply *MENU* for main menu.`,
      'SELECT_DATE',
      context
    );
  }

  // --- SELECT DATE ---
  if (state === 'SELECT_DATE') {
    const parsedDate = parseNaturalDate(rawMsg, settings.timezone);
    if (!parsedDate) {
      return reply(
        `I could not parse that date. Please try saying 'Today', 'Tomorrow', 'Friday', or '2026-09-30'.\n` +
        `↩️ Reply *0* or *BACK* to change service | Reply *MENU* for main menu.`
      );
    }

    const duration = context.selectedService ? context.selectedService.duration_minutes : 30;

    let availableSlots = [];
    let dateFormatted = '';

    if (context.selectedDoctor) {
      const docResult = await getAvailableDoctorSlots(context.selectedDoctor.id, parsedDate, duration, null, cleanPhone);
      if (!docResult.available || docResult.slots.length === 0) {
        return reply(
          `Sorry, ${docResult.reason || 'no slots available for ' + context.selectedDoctor.name + ' on ' + parsedDate}.\n` +
          `Would you like to try another date (e.g. 'Tomorrow' or 'Monday')?\n` +
          `↩️ Reply *0* or *BACK* to change service | Reply *MENU* for main menu.`
        );
      }
      availableSlots = docResult.slots;
      dateFormatted = docResult.dateFormatted;
    } else {
      const allResult = await getAllAvailableSlots(parsedDate, context.selectedService ? context.selectedService.id : null, duration, cleanPhone);
      if (allResult.slots.length === 0) {
        return reply(
          `Unfortunately, ${allResult.reason || 'no physicians have open slots on ' + parsedDate}. Please try another date:\n` +
          `↩️ Reply *0* or *BACK* to change service | Reply *MENU* for main menu.`
        );
      }
      availableSlots = allResult.slots;
      dateFormatted = allResult.dateFormatted;
    }

    context.bookingDate = parsedDate;
    context.availableSlots = availableSlots;

    const tzLabel = getTzLabel(settings);
    let slotMsg = `📅 Available slots on *${dateFormatted}* (${tzLabel}):\n\n`;
    availableSlots.slice(0, 8).forEach((s, idx) => {
      const docName = s.doctorName ? ` (${s.doctorName})` : '';
      slotMsg += `${idx + 1}️⃣ *${s.displayTime}*${docName}\n`;
    });
    slotMsg += `\nPlease reply with the slot number (e.g. *1*) or time:\n` +
      `↩️ Reply *0* or *BACK* to pick another date | Reply *MENU* for main menu.`;

    return reply(slotMsg, 'SELECT_SLOT', context);
  }

  // --- SELECT SLOT (With Concurrency Hold Lock) ---
  if (state === 'SELECT_SLOT') {
    const slots = context.availableSlots || [];
    let chosenSlot = null;

    const num = parseInt(lowerMsg, 10);
    if (num >= 1 && num <= slots.length) {
      chosenSlot = slots[num - 1];
    } else {
      chosenSlot = slots.find(s => s.displayTime.toLowerCase().includes(lowerMsg) || s.startTime.includes(lowerMsg));
    }

    if (!chosenSlot) {
      return reply(
        `Please reply with a valid slot number (1-${Math.min(slots.length, 8)}) or time.\n` +
        `↩️ Reply *0* or *BACK* to pick another date | Reply *MENU* for main menu.`
      );
    }

    const docId = context.selectedDoctor ? context.selectedDoctor.id : chosenSlot.doctorId;

    // ATOMIC SLOT HOLD: Lock slot exclusively for 10 minutes so no simultaneous user can claim it
    const holdResult = await acquireSlotHold(
      docId,
      context.bookingDate,
      chosenSlot.startTime,
      chosenSlot.endTime,
      cleanPhone,
      10
    );

    if (!holdResult.success) {
      // Slot collision or past slot restriction!
      const duration = context.selectedService ? context.selectedService.duration_minutes : 30;
      let refreshResult;
      if (context.selectedDoctor) {
        refreshResult = await getAvailableDoctorSlots(context.selectedDoctor.id, context.bookingDate, duration, null, cleanPhone);
      } else {
        refreshResult = await getAllAvailableSlots(context.bookingDate, context.selectedService ? context.selectedService.id : null, duration, cleanPhone);
      }

      if (refreshResult.slots && refreshResult.slots.length > 0) {
        context.availableSlots = refreshResult.slots;
        const reasonPrefix = (holdResult.reason === 'past_time' || holdResult.reason === 'past_date')
          ? `⚠️ *Notice:* ${holdResult.message}\n\nHere are the open upcoming future slots for *${formatDateFriendly(context.bookingDate)}*:\n\n`
          : `⚠️ *Notice:* The *${chosenSlot.displayTime}* time slot was just selected by another patient a moment ago.\n\nHere are the remaining open slots for *${formatDateFriendly(context.bookingDate)}*:\n\n`;

        let conflictMsg = reasonPrefix;
        refreshResult.slots.slice(0, 8).forEach((s, idx) => {
          const docName = s.doctorName ? ` (${s.doctorName})` : '';
          conflictMsg += `${idx + 1}️⃣ *${s.displayTime}*${docName}\n`;
        });
        conflictMsg += `\nPlease reply with your preferred slot number or time:\n` +
          `↩️ Reply *0* or *BACK* to pick another date | Reply *MENU* for main menu.`;
        return reply(conflictMsg, 'SELECT_SLOT', context);
      } else {
        const exhaustedMsg = (holdResult.reason === 'past_time' || holdResult.reason === 'past_date')
          ? `⚠️ *Notice:* ${holdResult.message}\nAll remaining slots for today have passed. Please reply with another date (e.g. 'Tomorrow' or 'Monday') to find an open time:\n`
          : `⚠️ *Notice:* The *${chosenSlot.displayTime}* time slot was just booked and all slots on *${formatDateFriendly(context.bookingDate)}* are now fully occupied.\n\nPlease reply with another date (e.g. 'Tomorrow' or 'Monday') to find an open time:\n`;

        return reply(
          exhaustedMsg +
          `↩️ Reply *0* or *BACK* to change service | Reply *MENU* for main menu.`,
          'SELECT_DATE',
          context
        );
      }
    }

    context.chosenSlot = chosenSlot;
    if (!context.selectedDoctor && chosenSlot.doctorId) {
      context.selectedDoctor = await getQuery('SELECT * FROM doctors WHERE id = ?', [chosenSlot.doctorId]);
    }

    const patient = context.selectedPatient;
    const patientName = patient ? patient.full_name : (client ? client.registered_name : 'Patient');
    const patientRelation = patient && patient.relationship ? ` (${patient.relationship})` : '';
    const doctorName = context.selectedDoctor ? context.selectedDoctor.name : chosenSlot.doctorName;
    const service = context.selectedService;
    const dateFriendly = formatDateFriendly(context.bookingDate);
    const tzLabel = getTzLabel(settings);

    return reply(
      `📋 *Please confirm your appointment details:*\n\n` +
      `👤 Patient: *${patientName}*${patientRelation}\n` +
      `📱 Booked by: *${client.registered_name}* (${cleanPhone})\n` +
      `👨‍⚕️ Doctor: *${doctorName}*\n` +
      `🩺 Service: *${service.name}*\n` +
      `🗓️ Date: *${dateFriendly}*\n` +
      `⏰ Time: *${chosenSlot.displayTime} - ${chosenSlot.displayEnd} (${tzLabel})*\n` +
      `💳 Fee: *${formatPrice(service.price, settings)}*\n` +
      `📍 Location: ${settings.address}\n\n` +
      `⏳ *Hold Active:* This time slot is reserved exclusively for you for 10 minutes so no one else can book it.\n\n` +
      `Reply *CONFIRM* to finalize your booking.\n` +
      `↩️ Reply *0* or *BACK* to change time slot (releases hold)\n` +
      `❌ Reply *CANCEL* to discard and release this reservation.`,
      'CONFIRM_FINAL_BOOKING',
      context
    );
  }

  // --- REQUIREMENT 2: CONFIRM FINAL BOOKING (With Atomic Double-Booking Conflict Check) ---
  if (state === 'CONFIRM_FINAL_BOOKING') {
    if (lowerMsg === 'confirm' || lowerMsg === 'yes' || lowerMsg === '1' || lowerMsg === 'ok' || lowerMsg === 'i confirm') {
      const doctor = context.selectedDoctor;
      const service = context.selectedService;
      const slot = context.chosenSlot;
      const bookingDate = context.bookingDate;

      // ATOMIC CHECK: verify no confirmed/tentative booking has been made in the meantime
      const conflict = await checkSlotConflict(doctor.id, bookingDate, slot.startTime, slot.endTime, cleanPhone);
      if (conflict.conflict && conflict.type === 'booked') {
        await releaseSlotHold(cleanPhone);
        return reply(
          `⚠️ *Booking Conflict:* We apologize, but this slot was just confirmed for another patient. Let's find you another available slot:\n\n` +
          `Reply *1* or *BOOK* to view open times.`,
          'IDLE',
          {}
        );
      }

      const aptId = generateAppointmentId();
      let patient = context.selectedPatient;

      // Defensive fallback if patient is missing
      if (!patient || !patient.full_name) {
        const fallback = await getQuery('SELECT * FROM patients WHERE client_phone = ? ORDER BY id ASC LIMIT 1', [cleanPhone]);
        patient = fallback || { id: null, full_name: client.registered_name, relationship: 'Self' };
      }

      await runQuery(`
        INSERT INTO appointments (
          id, doctor_id, doctor_name, doctor_phone, client_phone, patient_id,
          patient_name, service_id, service_name, date, start_time, end_time,
          fee, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)
      `, [
        aptId,
        doctor.id,
        doctor.name,
        doctor.personal_phone,
        cleanPhone,
        patient.id,
        patient.full_name,
        service.id,
        service.name,
        bookingDate,
        slot.startTime,
        slot.endTime,
        service.price,
        `Booked via WhatsApp by ${client.registered_name}`
      ]);

      // Release hold immediately now that appointment is confirmed!
      await releaseSlotHold(cleanPhone);

      const patientRel = patient.relationship ? ` (${patient.relationship})` : '';

      const tzLabel = getTzLabel(settings);
      const doctorAlert = `🚨 [NEW PATIENT BOOKING] Hello ${doctor.name}!\n` +
        `• Appointment ID: ${aptId}\n` +
        `• Patient: ${patient.full_name}${patientRel}\n` +
        `• Booked by: ${client.registered_name} (${cleanPhone})\n` +
        `• Service: ${service.name} (${formatPrice(service.price, settings)})\n` +
        `• Schedule: ${formatDateFriendly(bookingDate)} at ${slot.displayTime} - ${slot.displayEnd} (${tzLabel})\n` +
        `• Contact: ${cleanPhone}`;

      await runQuery(
        'INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message) VALUES (?, ?, ?, ?, ?)',
        [doctor.id, 'new_booking', aptId, cleanPhone, doctorAlert]
      );

      if (doctor.personal_phone) {
        try {
          const { sendWhatsAppMessage } = require('./whatsappService');
          await sendWhatsAppMessage(doctor.personal_phone, doctorAlert);
        } catch (e) {
          console.error('Doctor alert WhatsApp error:', e.message);
        }
      }

      return reply(
        `🎉 *Your appointment has been successfully booked!* 🎉\n\n` +
        `📌 *Appointment ID:* ${aptId}\n` +
        `👤 *Patient:* ${patient.full_name}${patientRel}\n` +
        `📱 *Booked by:* ${client.registered_name}\n` +
        `👨‍⚕️ *Doctor:* ${doctor.name} (${doctor.specialty})\n` +
        `🩺 *Service:* ${service.name}\n` +
        `🗓️ *Date:* ${formatDateFriendly(bookingDate)}\n` +
        `⏰ *Time:* ${slot.displayTime} - ${slot.displayEnd} (${tzLabel})\n` +
        `💳 *Fee:* ${formatPrice(service.price, settings)}\n` +
        `📍 *Address:* ${settings.address}\n\n` +
        `ℹ️ *Arrival Instructions:* ${settings.custom_instructions}\n\n` +
        `🔔 *Reminders:* We will send you an automated check 24 hours prior to confirm. You can view, reschedule, or cancel anytime by texting *MY BOOKINGS*.\n\n` +
        `Thank you for choosing ${settings.business_name}!`,
        'IDLE',
        {}
      );
    } else {
      await releaseSlotHold(cleanPhone);
      return reply(
        `Booking cancelled and discarded. Your reserved time slot has been released back to the calendar.\n` +
        `Reply *1* or *BOOK* anytime to start over!`,
        'IDLE',
        {}
      );
    }
  }

  // --- OPTIONAL NEBIUS TOKEN FACTORY / NEBIUS AI CLOUD (NVIDIA OPEN-SOURCE MODEL) ---
  if (state === 'IDLE' && rawMsg && rawMsg.trim().length > 3 && !['hi', 'hello', 'hey', 'start', 'menu', '0', '1', '2', '3', '4', '5'].includes(lowerMsg)) {
    const nebiusReply = await callNebiusNvidiaModel(rawMsg.trim(), settings);
    if (nebiusReply) {
      return reply(
        `${nebiusReply}\n\n` +
        `💡 *Reply 1 or BOOK whenever you would like to schedule an appointment with our physicians!*\n` +
        `↩️ Reply *0* or *MENU* for main menu.`,
        'IDLE',
        {}
      );
    }
  }

  // Fallback greeting
  return reply(getMainGreeting(), 'IDLE', {});
}

// ----------------------------------------------------
// NEBIUS TOKEN FACTORY & NEBIUS AI CLOUD (NVIDIA NEMOTRON INTEGRATION)
// ----------------------------------------------------
async function callNebiusNvidiaModel(userMessage, settings = {}) {
  const apiKey = process.env.NEBIUS_API_KEY;
  const baseUrl = (process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, '');
  const model = process.env.NEBIUS_MODEL || 'nvidia/Llama-3.1-Nemotron-70B-Instruct';

  const hasLocalEndpoint = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || baseUrl.includes('10.') || baseUrl.includes('192.168.');
  if (!apiKey && !hasLocalEndpoint) {
    return null;
  }

  try {
    const docs = await allQuery('SELECT name, specialty, bio FROM doctors WHERE is_active = 1');
    const docSummary = (docs || []).map(d => `${d.name} (${d.specialty})`).join(', ');

    const systemPrompt = `You are ${settings.persona_name || 'Dr. Maya'}, the AI Care Coordinator for ${settings.business_name || 'Apex Specialized Medical Center'}.
Clinic Details:
- Address: ${settings.address || 'Medical Center'}
- Hours: Monday - Saturday 8:00 AM - 6:00 PM
- Physicians: ${docSummary || 'Multi-specialty physicians'}
- Tone: ${settings.persona_tone || 'warm, professional, empathetic, and concise'}

Guidelines:
1. Provide a direct, compassionate, and helpful answer to the patient's inquiry.
2. If discussing symptoms or medications, give safe general context and recommend scheduling a formal consultation with one of our doctors.
3. Keep the response concise (under 90 words) and formatted clearly for WhatsApp messaging.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.3,
        max_tokens: 280
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content.trim();
    }
    return null;
  } catch (err) {
    // Graceful fallback to deterministic engine
    return null;
  }
}

module.exports = {
  processIncomingMessage,
  parseNaturalDate,
  callNebiusNvidiaModel
};
