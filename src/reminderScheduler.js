const { allQuery, runQuery, getQuery, getDateOffset, getClinicDateTime } = require('./database');
const { formatDateFriendly, formatTime12 } = require('./slotManager');

/**
 * Scan for upcoming appointments needing 24-hr confirmation check
 * @param {string} currentDateStr - reference date (defaults to today in clinic timezone)
 * @param {boolean} forceMarkUnconfirmed - if true, marks unconfirmed reminders as tentative
 */
async function runConfirmationCheck(currentDateStr = null, forceMarkUnconfirmed = false) {
  const settings = await getQuery('SELECT * FROM settings WHERE id = 1');
  if (!settings) return { processed: 0, actions: [] };

  const clinicNow = getClinicDateTime(settings.timezone || 'Asia/Karachi');
  const tzLabel = settings.timezone_label || clinicNow.tzAbbr || settings.timezone || 'PKT';

  // If no date passed, use today's actual date in clinic timezone
  const refDateStr = currentDateStr || clinicNow.dateStr;

  // Tomorrow's date in clinic timezone
  const [y, m, d] = refDateStr.split('-').map(Number);
  const targetDateObj = new Date(Date.UTC(y, m - 1, d + 1));
  const targetDateStr = targetDateObj.toISOString().split('T')[0];

  const actions = [];

  // 1. Find appointments for tomorrow where reminder has not yet been sent
  const pendingReminders = await allQuery(`
    SELECT a.*, c.registered_name as client_name
    FROM appointments a
    LEFT JOIN clients c ON a.client_phone = c.phone
    WHERE a.date = ? AND a.status IN ('confirmed', 'tentative') AND a.confirmation_sent_at IS NULL
  `, [targetDateStr]);

  for (const apt of pendingReminders) {
    const reminderMsg =
      `⏰ *${settings.business_name} — 24-Hour Confirmation Reminder*\n\n` +
      `Hello ${apt.client_name || apt.patient_name}! 👋\n` +
      `This is a friendly reminder that an appointment is scheduled for *${apt.patient_name}* tomorrow:\n\n` +
      `👨‍⚕️ Doctor: *${apt.doctor_name}*\n` +
      `🩺 Service: *${apt.service_name}*\n` +
      `🗓️ Date: *${formatDateFriendly(apt.date)}*\n` +
      `⏰ Time: *${formatTime12(apt.start_time)} - ${formatTime12(apt.end_time)} (${tzLabel})*\n` +
      `📍 Location: ${settings.address}\n\n` +
      `Please reply with:\n` +
      `👉 *CONFIRM* — to keep your appointment confirmed\n` +
      `👉 *RESCHEDULE* — to pick a different date or physician\n` +
      `👉 *CANCEL* — if you cannot make it\n\n` +
      `_If we do not receive your confirmation within 24 hours, this appointment will be marked tentative._`;

    await runQuery(
      'INSERT INTO messages (phone, direction, sender_name, message) VALUES (?, ?, ?, ?)',
      [apt.client_phone, 'outbound', settings.persona_name, reminderMsg]
    );

    await runQuery(
      'UPDATE appointments SET confirmation_sent_at = CURRENT_TIMESTAMP WHERE id = ?',
      [apt.id]
    );

    // Send WhatsApp reminder to client
    try {
      const { sendWhatsAppMessage } = require('./whatsappService');
      await sendWhatsAppMessage(apt.client_phone, reminderMsg);
    } catch (e) {
      console.error('Client reminder WhatsApp error:', e.message);
    }

    const alertMsg = `📢 [24H REMINDER SENT] Automated confirmation ping dispatched to ${apt.client_name || apt.patient_name} (${apt.client_phone}) for ${apt.patient_name} tomorrow at ${formatTime12(apt.start_time)} (${tzLabel}).`;
    await runQuery(
      'INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message) VALUES (?, ?, ?, ?, ?)',
      [apt.doctor_id, 'reminder_sent', apt.id, apt.client_phone, alertMsg]
    );

    // Send alert copy to doctor's personal phone
    if (apt.doctor_phone) {
      try {
        const { sendWhatsAppMessage } = require('./whatsappService');
        await sendWhatsAppMessage(apt.doctor_phone, alertMsg);
      } catch (e) {
        console.error('Doctor reminder alert WhatsApp error:', e.message);
      }
    }

    actions.push({
      type: 'reminder_sent',
      appointmentId: apt.id,
      patient: apt.patient_name,
      doctor: apt.doctor_name,
      phone: apt.client_phone,
      date: apt.date,
      time: apt.start_time
    });
  }

  // 2. Mark unconfirmed appointments as tentative
  if (forceMarkUnconfirmed) {
    const unconfirmedApts = await allQuery(`
      SELECT a.*, c.registered_name as client_name
      FROM appointments a
      LEFT JOIN clients c ON a.client_phone = c.phone
      WHERE a.date = ? AND a.status = 'confirmed' AND a.confirmation_sent_at IS NOT NULL AND a.confirmed_at IS NULL
    `, [targetDateStr]);

    for (const apt of unconfirmedApts) {
      await runQuery(`UPDATE appointments SET status = 'tentative' WHERE id = ?`, [apt.id]);

      const alertMsg = `⚠️ [MARKED TENTATIVE] ${apt.doctor_name}, appointment ${apt.id} for ${apt.patient_name} on ${apt.date} at ${formatTime12(apt.start_time)} (${tzLabel}) marked TENTATIVE due to lack of client confirmation response.`;
      await runQuery(
        'INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message) VALUES (?, ?, ?, ?, ?)',
        [apt.doctor_id, 'confirmation_update', apt.id, apt.client_phone, alertMsg]
      );

      if (apt.doctor_phone) {
        try {
          const { sendWhatsAppMessage } = require('./whatsappService');
          await sendWhatsAppMessage(apt.doctor_phone, alertMsg);
        } catch (e) {
          console.error('Doctor tentative alert WhatsApp error:', e.message);
        }
      }

      actions.push({
        type: 'marked_tentative',
        appointmentId: apt.id,
        patient: apt.patient_name,
        doctor: apt.doctor_name,
        phone: apt.client_phone,
        date: apt.date,
        time: apt.start_time
      });
    }
  }

  return {
    processed: actions.length,
    actions
  };
}

module.exports = {
  runConfirmationCheck
};
