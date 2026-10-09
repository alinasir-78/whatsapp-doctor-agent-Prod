const { getQuery, allQuery, runQuery, getDateOffset, getClinicNow } = require('./database');

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatTime12(timeStr) {
  if (!timeStr) return '';
  const [hStr, mStr] = timeStr.split(':');
  let h = parseInt(hStr, 10);
  const m = mStr.padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  h = h ? h : 12;
  return `${String(h).padStart(2, '0')}:${m} ${ampm}`;
}

function formatDateFriendly(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${d}, ${y}`;
}

/**
 * Remove holds that have expired past their TTL
 */
async function cleanExpiredHolds() {
  try {
    await runQuery("DELETE FROM slot_holds WHERE expires_at <= datetime('now')");
  } catch (err) {
    console.warn('cleanExpiredHolds warning:', err.message);
  }
}

/**
 * Temporarily hold a slot for a patient finalizing booking via WhatsApp
 * Prevents any other user (WhatsApp or walk-in) from seeing or claiming the slot
 */
async function acquireSlotHold(doctorId, dateStr, startTime, endTime, phone, holdMinutes = 10) {
  await cleanExpiredHolds();
  const cleanPhone = (phone || '').trim();

  // Validate against clinic local date & time to prevent booking past slots
  const clinicNow = await getClinicNow();
  if (dateStr < clinicNow.dateStr) {
    return {
      success: false,
      reason: 'past_date',
      message: `Cannot reserve slots for past dates (${formatDateFriendly(dateStr)}). Current clinic date is ${formatDateFriendly(clinicNow.dateStr)}.`
    };
  }
  if (dateStr === clinicNow.dateStr && startTime <= clinicNow.timeStr) {
    return {
      success: false,
      reason: 'past_time',
      message: `Time slot ${formatTime12(startTime)} has already passed (Clinic time is ${formatTime12(clinicNow.timeStr)} ${clinicNow.tzAbbr}).`
    };
  }

  // 1. Check if slot already booked by an active confirmed/tentative appointment
  const booked = await getQuery(`
    SELECT id, patient_name FROM appointments
    WHERE doctor_id = ? AND date = ? AND start_time < ? AND end_time > ? AND status IN ('confirmed', 'tentative')
  `, [doctorId, dateStr, endTime, startTime]);

  if (booked) {
    return { success: false, reason: 'already_booked', detail: booked };
  }

  // 2. Check if slot is held by another user
  const held = await getQuery(`
    SELECT id, held_by_phone, expires_at FROM slot_holds
    WHERE doctor_id = ? AND date = ? AND start_time < ? AND end_time > ? AND expires_at > datetime('now') AND held_by_phone != ?
  `, [doctorId, dateStr, endTime, startTime, cleanPhone]);

  if (held) {
    return { success: false, reason: 'held_by_other', detail: held };
  }

  // 3. Clear any existing holds previously placed by this phone
  await runQuery('DELETE FROM slot_holds WHERE held_by_phone = ?', [cleanPhone]);

  // 4. Reserve new slot hold for holdMinutes
  await runQuery(`
    INSERT INTO slot_holds (doctor_id, date, start_time, end_time, held_by_phone, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' minutes'))
  `, [doctorId, dateStr, startTime, endTime, cleanPhone, holdMinutes]);

  return { success: true };
}

/**
 * Release an active slot hold when patient confirms, cancels, or changes selection
 */
async function releaseSlotHold(phone) {
  if (!phone) return;
  const cleanPhone = phone.trim();
  try {
    await runQuery('DELETE FROM slot_holds WHERE held_by_phone = ?', [cleanPhone]);
  } catch (err) {
    console.warn('releaseSlotHold warning:', err.message);
  }
}

/**
 * Check if a slot has a conflict with confirmed/tentative appointments or active holds
 */
async function checkSlotConflict(doctorId, dateStr, startTime, endTime, allowedPhone = null, excludeAppointmentId = null) {
  await cleanExpiredHolds();

  // Validate against clinic local date & time
  const clinicNow = await getClinicNow();
  if (dateStr < clinicNow.dateStr) {
    return {
      conflict: true,
      type: 'past_date',
      message: `Cannot book appointments for past dates (${formatDateFriendly(dateStr)}). Current clinic date is ${formatDateFriendly(clinicNow.dateStr)}.`
    };
  }
  if (dateStr === clinicNow.dateStr && startTime <= clinicNow.timeStr) {
    return {
      conflict: true,
      type: 'past_time',
      message: `Time slot ${formatTime12(startTime)} has already passed (Clinic time is ${formatTime12(clinicNow.timeStr)} ${clinicNow.tzAbbr}).`
    };
  }

  // 1. Check existing confirmed or tentative bookings
  let bookedSql = `
    SELECT id, patient_name, doctor_name FROM appointments
    WHERE doctor_id = ? AND date = ? AND start_time < ? AND end_time > ? AND status IN ('confirmed', 'tentative')
  `;
  const bookedParams = [doctorId, dateStr, endTime, startTime];
  if (excludeAppointmentId) {
    bookedSql += ' AND id != ?';
    bookedParams.push(excludeAppointmentId);
  }
  const booked = await getQuery(bookedSql, bookedParams);
  if (booked) {
    return { conflict: true, type: 'booked', detail: booked };
  }

  // 2. Check active slot holds (excluding hold owned by allowedPhone)
  let holdSql = `
    SELECT id, held_by_phone, expires_at FROM slot_holds
    WHERE doctor_id = ? AND date = ? AND start_time < ? AND end_time > ? AND expires_at > datetime('now')
  `;
  const holdParams = [doctorId, dateStr, endTime, startTime];
  if (allowedPhone) {
    holdSql += ' AND held_by_phone != ?';
    holdParams.push(allowedPhone.trim());
  }
  const hold = await getQuery(holdSql, holdParams);
  if (hold) {
    return { conflict: true, type: 'held', detail: hold };
  }

  return { conflict: false };
}

/**
 * Get available slots for a specific doctor on a specific date
 */
async function getAvailableDoctorSlots(doctorId, dateStr, durationMinutes = null, excludeAppointmentId = null, excludeHoldPhone = null) {
  await cleanExpiredHolds();

  const clinicNow = await getClinicNow();

  // Strictly prohibit past dates
  if (dateStr < clinicNow.dateStr) {
    return {
      available: false,
      doctor: null,
      dayName: '',
      dateFormatted: formatDateFriendly(dateStr),
      reason: `Cannot book appointments for past dates (${formatDateFriendly(dateStr)}). Current clinic date is ${formatDateFriendly(clinicNow.dateStr)}.`,
      slots: [],
      clinicTime: clinicNow.timeStr,
      clinicDate: clinicNow.dateStr,
      clinicTimezone: clinicNow.timezone,
      clinicTzAbbr: clinicNow.tzAbbr
    };
  }

  const doctor = await getQuery('SELECT * FROM doctors WHERE id = ? AND is_active = 1', [doctorId]);
  if (!doctor) {
    return {
      available: false,
      reason: 'Doctor not found or inactive.',
      slots: [],
      clinicTime: clinicNow.timeStr,
      clinicDate: clinicNow.dateStr,
      clinicTimezone: clinicNow.timezone,
      clinicTzAbbr: clinicNow.tzAbbr
    };
  }

  const [y, m, d] = dateStr.split('-').map(Number);
  const dateObj = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = dateObj.getUTCDay();

  // 1. Check doctor's working schedule
  const schedule = await getQuery(
    'SELECT * FROM doctor_schedules WHERE doctor_id = ? AND day_of_week = ?',
    [doctorId, dayOfWeek]
  );

  if (!schedule || !schedule.is_active) {
    return {
      available: false,
      doctor,
      dayName: schedule ? schedule.day_name : 'This Day',
      reason: `${doctor.name} does not have clinic hours on ${schedule ? schedule.day_name : 'this day'}.`,
      slots: []
    };
  }

  // 2. Check doctor's unavailability / blackout dates
  const unavailabilities = await allQuery(
    'SELECT * FROM doctor_unavailability WHERE doctor_id = ? AND date = ?',
    [doctorId, dateStr]
  );

  const fullDayBlock = unavailabilities.find(u => u.is_full_day === 1);
  if (fullDayBlock) {
    return {
      available: false,
      doctor,
      dayName: schedule.day_name,
      reason: `${doctor.name} is unavailable on ${formatDateFriendly(dateStr)} (${fullDayBlock.reason}).`,
      slots: []
    };
  }

  const slotDuration = durationMinutes || schedule.slot_duration_minutes || 30;
  const buffer = schedule.buffer_minutes || 0;

  const startMins = timeToMinutes(schedule.start_time);
  const endMins = timeToMinutes(schedule.end_time);
  const breakStartMins = timeToMinutes(schedule.break_start);
  const breakEndMins = timeToMinutes(schedule.break_end);

  // Blackout time ranges for partial unavailability
  const blackoutRanges = unavailabilities
    .filter(u => u.is_full_day === 0 && u.start_time && u.end_time)
    .map(u => ({
      start: timeToMinutes(u.start_time),
      end: timeToMinutes(u.end_time),
      reason: u.reason
    }));

  // Existing booked appointments (confirmed and tentative block slots; cancelled and no_show do NOT block)
  let bookedSql = `
    SELECT id, start_time, end_time, status
    FROM appointments
    WHERE doctor_id = ? AND date = ? AND status IN ('confirmed', 'tentative')
  `;
  const params = [doctorId, dateStr];
  if (excludeAppointmentId) {
    bookedSql += ' AND id != ?';
    params.push(excludeAppointmentId);
  }
  const bookedAppointments = await allQuery(bookedSql, params);

  const bookedRanges = bookedAppointments.map(b => ({
    start: timeToMinutes(b.start_time),
    end: timeToMinutes(b.end_time)
  }));

  // Active unexpired slot holds
  let holdsSql = `
    SELECT id, start_time, end_time, held_by_phone
    FROM slot_holds
    WHERE doctor_id = ? AND date = ? AND expires_at > datetime('now')
  `;
  const holdParams = [doctorId, dateStr];
  if (excludeHoldPhone) {
    holdsSql += ' AND held_by_phone != ?';
    holdParams.push(excludeHoldPhone.trim());
  }
  const activeHolds = await allQuery(holdsSql, holdParams);

  const holdRanges = activeHolds.map(h => ({
    start: timeToMinutes(h.start_time),
    end: timeToMinutes(h.end_time)
  }));

  const slots = [];
  let currentMins = startMins;

  while (currentMins + slotDuration <= endMins) {
    const slotEndMins = currentMins + slotDuration;
    const startStr = minutesToTime(currentMins);
    const endStr = minutesToTime(slotEndMins);

    // Dynamic past slot enforcement: Prohibit any slot that has already started/passed today in the clinic's local timezone
    const isPastToday = (dateStr === clinicNow.dateStr && startStr <= clinicNow.timeStr);

    const overlapsBreak = (currentMins < breakEndMins && slotEndMins > breakStartMins);
    const overlapsBlackout = blackoutRanges.some(b => currentMins < b.end && slotEndMins > b.start);
    const overlapsBooking = bookedRanges.some(b => currentMins < b.end && slotEndMins > b.start);
    const overlapsHold = holdRanges.some(h => currentMins < h.end && slotEndMins > h.start);

    if (!isPastToday && !overlapsBreak && !overlapsBlackout && !overlapsBooking && !overlapsHold) {
      slots.push({
        doctorId: doctor.id,
        doctorName: doctor.name,
        specialty: doctor.specialty,
        startTime: startStr,
        endTime: endStr,
        displayTime: formatTime12(startStr),
        displayEnd: formatTime12(endStr),
        label: `${formatTime12(startStr)} - ${formatTime12(endStr)}`
      });
    }

    currentMins += slotDuration + buffer;
  }

  let reason = null;
  if (slots.length === 0) {
    if (dateStr === clinicNow.dateStr) {
      reason = `All appointment slots for today (${formatDateFriendly(dateStr)}) have already passed or are fully booked. Please select a future date.`;
    } else {
      reason = `All slots for ${doctor.name} are fully booked on this date.`;
    }
  }

  return {
    available: slots.length > 0,
    doctor,
    dayName: schedule.day_name,
    dateFormatted: formatDateFriendly(dateStr),
    reason,
    slots,
    clinicTime: clinicNow.timeStr,
    clinicDate: clinicNow.dateStr,
    clinicTimezone: clinicNow.timezone,
    clinicTzAbbr: clinicNow.tzAbbr
  };
}

/**
 * Get available slots across all active doctors for a given date and service
 */
async function getAllAvailableSlots(dateStr, serviceId = null, durationMinutes = null, excludeHoldPhone = null) {
  const clinicNow = await getClinicNow();

  // Strictly prohibit past dates
  if (dateStr < clinicNow.dateStr) {
    return {
      date: dateStr,
      dateFormatted: formatDateFriendly(dateStr),
      service: null,
      doctorsAvailable: [],
      slots: [],
      reason: `Cannot book appointments for past dates (${formatDateFriendly(dateStr)}). Current clinic date is ${formatDateFriendly(clinicNow.dateStr)}.`,
      clinicTime: clinicNow.timeStr,
      clinicDate: clinicNow.dateStr,
      clinicTimezone: clinicNow.timezone,
      clinicTzAbbr: clinicNow.tzAbbr
    };
  }

  const doctors = await allQuery('SELECT * FROM doctors WHERE is_active = 1');

  let targetDuration = durationMinutes;
  let service = null;

  if (serviceId) {
    service = await getQuery('SELECT * FROM services WHERE id = ?', [serviceId]);
    if (service) {
      targetDuration = service.duration_minutes;
      if (service.doctor_id) {
        const specificResult = await getAvailableDoctorSlots(service.doctor_id, dateStr, targetDuration, null, excludeHoldPhone);
        return {
          date: dateStr,
          dateFormatted: formatDateFriendly(dateStr),
          service,
          doctorsAvailable: specificResult.slots.length > 0 ? [specificResult.doctor] : [],
          slots: specificResult.slots,
          reason: specificResult.reason,
          clinicTime: clinicNow.timeStr,
          clinicDate: clinicNow.dateStr,
          clinicTimezone: clinicNow.timezone,
          clinicTzAbbr: clinicNow.tzAbbr
        };
      }
    }
  }

  const allDoctorSlots = [];
  const doctorsAvailable = [];

  for (const doc of doctors) {
    const docResult = await getAvailableDoctorSlots(doc.id, dateStr, targetDuration || 30, null, excludeHoldPhone);
    if (docResult.available && docResult.slots.length > 0) {
      doctorsAvailable.push(doc);
      allDoctorSlots.push(...docResult.slots);
    }
  }

  allDoctorSlots.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

  let reason = null;
  if (allDoctorSlots.length === 0) {
    if (dateStr === clinicNow.dateStr) {
      reason = `All appointment slots for today (${formatDateFriendly(dateStr)}) have already passed or are fully booked. Please select a future date.`;
    } else {
      reason = `No physicians have open slots on ${formatDateFriendly(dateStr)}. Please try another date.`;
    }
  }

  return {
    date: dateStr,
    dateFormatted: formatDateFriendly(dateStr),
    service,
    doctorsAvailable,
    slots: allDoctorSlots,
    reason,
    clinicTime: clinicNow.timeStr,
    clinicDate: clinicNow.dateStr,
    clinicTimezone: clinicNow.timezone,
    clinicTzAbbr: clinicNow.tzAbbr
  };
}

/**
 * Find impacted appointments when a doctor sets an unavailability window
 */
async function getImpactedAppointments(doctorId, dateStr, startTime = null, endTime = null) {
  let sql = `
    SELECT a.*, c.registered_name as client_name, c.phone as client_phone
    FROM appointments a
    LEFT JOIN clients c ON a.client_phone = c.phone
    WHERE a.doctor_id = ? AND a.date = ? AND a.status IN ('confirmed', 'tentative')
  `;
  const params = [doctorId, dateStr];

  if (startTime && endTime) {
    sql += ' AND a.start_time < ? AND a.end_time > ?';
    params.push(endTime, startTime);
  }

  return await allQuery(sql, params);
}

module.exports = {
  timeToMinutes,
  minutesToTime,
  formatTime12,
  formatDateFriendly,
  cleanExpiredHolds,
  acquireSlotHold,
  releaseSlotHold,
  checkSlotConflict,
  getAvailableDoctorSlots,
  getAllAvailableSlots,
  getImpactedAppointments
};
