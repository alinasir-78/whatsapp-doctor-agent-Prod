require('dotenv').config();
const path = require('path');
const fs = require('fs');

let DB_PATH = process.env.DATABASE_PATH || process.env.DB_PATH || path.join(__dirname, '..', 'doctor_agent.db');

// Ensure writable path on container/cloud environments (fallback to /tmp if app root is read-only)
try {
  const dir = path.dirname(DB_PATH);
  fs.accessSync(dir, fs.constants.W_OK);
} catch (e) {
  console.warn(`[DB WARNING] Directory ${path.dirname(DB_PATH)} is not writable. Falling back to /tmp/doctor_agent.db`);
  DB_PATH = path.join('/tmp', 'doctor_agent.db');
}

// Resilient multi-driver loader: Supports native sqlite3 AND Node 22 built-in node:sqlite
let driverType = 'sqlite3';
let dbInstance = null;
let nodeSqliteDb = null;

try {
  const sqlite3 = require('sqlite3').verbose();
  dbInstance = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.warn(`⚠️ SQLite open error with sqlite3 package on ${DB_PATH}:`, err.message);
    } else {
      console.log(`📦 SQLite Database active via sqlite3 driver at: ${DB_PATH}`);
    }
  });
  dbInstance.on('error', (err) => {
    console.warn('⚠️ SQLite Runtime Error:', err.message);
  });
} catch (err1) {
  console.warn('⚠️ Native sqlite3 module failed to load (common in Node 22 without build tools):', err1.message);
  try {
    // Node 22+ built-in zero-dependency SQLite
    const { DatabaseSync } = require('node:sqlite');
    nodeSqliteDb = new DatabaseSync(DB_PATH);
    driverType = 'node:sqlite';
    console.log(`📦 SQLite Database active via Node 22 built-in node:sqlite at: ${DB_PATH}`);
  } catch (err2) {
    console.warn('⚠️ Built-in node:sqlite also unavailable, using safe fallback:', err2.message);
    driverType = 'fallback';
  }
}

function runQuery(sql, params = []) {
  if (driverType === 'node:sqlite' && nodeSqliteDb) {
    return new Promise((resolve, reject) => {
      try {
        const stmt = nodeSqliteDb.prepare(sql);
        const result = stmt.run(...params);
        resolve({ lastID: Number(result.lastInsertRowid || 0), changes: Number(result.changes || 0) });
      } catch (err) {
        reject(err);
      }
    });
  }

  if (driverType === 'sqlite3' && dbInstance) {
    return new Promise((resolve, reject) => {
      dbInstance.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  return Promise.resolve({ lastID: 1, changes: 1 });
}

function getQuery(sql, params = []) {
  if (driverType === 'node:sqlite' && nodeSqliteDb) {
    return new Promise((resolve, reject) => {
      try {
        const stmt = nodeSqliteDb.prepare(sql);
        const row = stmt.get(...params);
        resolve(row || null);
      } catch (err) {
        reject(err);
      }
    });
  }

  if (driverType === 'sqlite3' && dbInstance) {
    return new Promise((resolve, reject) => {
      dbInstance.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  }

  return Promise.resolve(null);
}

function allQuery(sql, params = []) {
  if (driverType === 'node:sqlite' && nodeSqliteDb) {
    return new Promise((resolve, reject) => {
      try {
        const stmt = nodeSqliteDb.prepare(sql);
        const rows = stmt.all(...params);
        resolve(rows || []);
      } catch (err) {
        reject(err);
      }
    });
  }

  if (driverType === 'sqlite3' && dbInstance) {
    return new Promise((resolve, reject) => {
      dbInstance.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  return Promise.resolve([]);
}

// Helper to get local date & time in the clinic's configured timezone
function getClinicDateTime(timezone = 'Asia/Karachi') {
  const tz = timezone || 'Asia/Karachi';
  try {
    const now = new Date();
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
    const formatted = dtf.format(now);
    const [datePart, timePart] = formatted.split(', ');
    const [hour, minute, second] = timePart.split(':');

    let tzAbbr = '';
    try {
      const tzDtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
      const tzPart = tzDtf.formatToParts(now).find(p => p.type === 'timeZoneName');
      tzAbbr = tzPart ? tzPart.value : tz;
    } catch (e) {
      tzAbbr = tz;
    }

    return {
      dateStr: datePart, // YYYY-MM-DD
      timeStr: `${hour}:${minute}`, // HH:MM
      timeWithSec: timePart, // HH:MM:SS
      year: parseInt(datePart.split('-')[0], 10),
      month: parseInt(datePart.split('-')[1], 10),
      day: parseInt(datePart.split('-')[2], 10),
      hour: parseInt(hour, 10),
      minute: parseInt(minute, 10),
      second: parseInt(second, 10),
      timezone: tz,
      tzAbbr
    };
  } catch (err) {
    const now = new Date();
    const iso = now.toISOString();
    return {
      dateStr: iso.slice(0, 10),
      timeStr: iso.slice(11, 16),
      timeWithSec: iso.slice(11, 19),
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
      second: now.getUTCSeconds(),
      timezone: 'UTC',
      tzAbbr: 'UTC'
    };
  }
}

// Async helper to get current time dynamically configured for the clinic
async function getClinicNow() {
  try {
    const settings = await getQuery('SELECT country, country_code, timezone, timezone_label FROM settings WHERE id = 1');
    const tz = (settings && settings.timezone) ? settings.timezone : 'Asia/Karachi';
    const nowInfo = getClinicDateTime(tz);
    nowInfo.country = settings ? (settings.country || 'Pakistan') : 'Pakistan';
    nowInfo.countryCode = settings ? (settings.country_code || 'PK') : 'PK';
    nowInfo.timezoneLabel = settings && settings.timezone_label ? settings.timezone_label : `${nowInfo.tzAbbr} (${tz})`;
    return nowInfo;
  } catch (e) {
    return getClinicDateTime('Asia/Karachi');
  }
}

// Helper to get formatted date string YYYY-MM-DD offset from today in clinic's timezone
function getDateOffset(daysOffset = 0, timezone = 'Asia/Karachi') {
  const clinicNow = getClinicDateTime(timezone || 'Asia/Karachi');
  const d = new Date(Date.UTC(clinicNow.year, clinicNow.month - 1, clinicNow.day));
  d.setUTCDate(d.getUTCDate() + daysOffset);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function initDb() {
  try {
    // 1. Settings Table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        business_name TEXT NOT NULL,
        business_type TEXT NOT NULL,
        clinic_phone TEXT NOT NULL,
        owner_personal_phone TEXT NOT NULL,
        address TEXT NOT NULL,
        persona_name TEXT NOT NULL,
        persona_tone TEXT NOT NULL,
        custom_instructions TEXT NOT NULL,
        cancellation_policy TEXT NOT NULL,
        currency TEXT DEFAULT 'USD',
        currency_symbol TEXT DEFAULT '$',
        currency_position TEXT DEFAULT 'before',
        country TEXT DEFAULT 'Pakistan',
        country_code TEXT DEFAULT 'PK',
        timezone TEXT DEFAULT 'Asia/Karachi',
        timezone_label TEXT DEFAULT 'PKT (UTC+5)',
        sample_data_cleared INTEGER DEFAULT 0,
        sample_data_cleared_at TEXT DEFAULT NULL,
        whatsapp_phone_number_id TEXT NOT NULL,
        whatsapp_verify_token TEXT NOT NULL,
        whatsapp_access_token TEXT NOT NULL
      )
    `);

    // Self-healing migration for existing databases
    try { await runQuery(`ALTER TABLE settings ADD COLUMN currency TEXT DEFAULT 'USD'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE settings ADD COLUMN currency_symbol TEXT DEFAULT '$'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE settings ADD COLUMN currency_position TEXT DEFAULT 'before'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE settings ADD COLUMN country TEXT DEFAULT 'Pakistan'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE settings ADD COLUMN country_code TEXT DEFAULT 'PK'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE settings ADD COLUMN timezone TEXT DEFAULT 'Asia/Karachi'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE settings ADD COLUMN timezone_label TEXT DEFAULT 'PKT (UTC+5)'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE settings ADD COLUMN sample_data_cleared INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE settings ADD COLUMN sample_data_cleared_at TEXT DEFAULT NULL`); } catch (e) {}

        // 2. Doctors Table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS doctors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            title TEXT NOT NULL,
            specialty TEXT NOT NULL,
            personal_phone TEXT NOT NULL,
            email TEXT,
            color_code TEXT DEFAULT '#2563eb',
            bio TEXT,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // 3. Doctor Schedules Table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS doctor_schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doctor_id INTEGER NOT NULL,
            day_of_week INTEGER NOT NULL,
            day_name TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            break_start TEXT NOT NULL,
            break_end TEXT NOT NULL,
            slot_duration_minutes INTEGER DEFAULT 30,
            buffer_minutes INTEGER DEFAULT 10,
            FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE,
            UNIQUE(doctor_id, day_of_week)
          )
        `);

        // 4. Doctor Unavailability & Leave Table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS doctor_unavailability (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doctor_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            start_time TEXT,
            end_time TEXT,
            is_full_day INTEGER DEFAULT 1,
            reason TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
          )
        `);

        // 5. Services Table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doctor_id INTEGER,
            name TEXT NOT NULL,
            duration_minutes INTEGER NOT NULL,
            price REAL NOT NULL,
            description TEXT,
            is_active INTEGER DEFAULT 1,
            FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL
          )
        `);

        // 6. Clients Table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS clients (
            phone TEXT PRIMARY KEY,
            registered_name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // 7. Patients Table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS patients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_phone TEXT NOT NULL,
            full_name TEXT NOT NULL,
            relationship TEXT DEFAULT 'Self',
            age_or_notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (client_phone) REFERENCES clients(phone) ON DELETE CASCADE
          )
        `);

        // 8. Appointments Table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS appointments (
            id TEXT PRIMARY KEY,
            doctor_id INTEGER NOT NULL,
            doctor_name TEXT NOT NULL,
            doctor_phone TEXT NOT NULL,
            client_phone TEXT NOT NULL,
            patient_id INTEGER,
            patient_name TEXT NOT NULL,
            service_id INTEGER NOT NULL,
            service_name TEXT NOT NULL,
            date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            fee REAL NOT NULL,
            status TEXT CHECK(status IN ('confirmed', 'tentative', 'completed', 'cancelled')) DEFAULT 'confirmed',
            confirmation_sent_at DATETIME,
            confirmed_at DATETIME,
            cancelled_by TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (doctor_id) REFERENCES doctors(id)
          )
        `);

        // 9. Chat Sessions Table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS chat_sessions (
            phone TEXT PRIMARY KEY,
            state TEXT DEFAULT 'IDLE',
            context_data TEXT DEFAULT '{}',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // 10. Messages Table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT NOT NULL,
            direction TEXT CHECK(direction IN ('inbound', 'outbound')),
            sender_name TEXT,
            message TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // 11. Owner Notifications Table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS owner_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doctor_id INTEGER,
            type TEXT NOT NULL,
            appointment_id TEXT,
            phone TEXT,
            message TEXT NOT NULL,
            is_read INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // 12. Meta API Diagnostics & Activity Logs Table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS meta_api_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            direction TEXT CHECK(direction IN ('inbound', 'outbound')),
            endpoint TEXT,
            recipient TEXT,
            status_code INTEGER,
            payload TEXT,
            response TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // 13. Slot Holds & Concurrency Locks Table (Prevents double booking / simultaneous collisions)
        await runQuery(`
          CREATE TABLE IF NOT EXISTS slot_holds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doctor_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            held_by_phone TEXT NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
          )
        `);

        // 14. Clinic Staff & User Accounts Table (Role-Based Access Control)
        await runQuery(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            full_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'director', 'doctor', 'receptionist')),
            doctor_id INTEGER,
            is_active INTEGER DEFAULT 1,
            must_change_password INTEGER DEFAULT 0,
            permissions TEXT,
            last_login DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL
          )
        `);

        // Migration check for users table (if existed without must_change_password or permissions)
        try {
          const userCols = await allQuery('PRAGMA table_info(users)');
          const hasMustChange = userCols.some(c => c.name === 'must_change_password');
          const hasPermissions = userCols.some(c => c.name === 'permissions');
          if (!hasMustChange) {
            await runQuery('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
          }
          if (!hasPermissions) {
            await runQuery('ALTER TABLE users ADD COLUMN permissions TEXT');
          }
        } catch (mErr) {
          console.warn('Users migration note:', mErr.message);
        }

        // 15. Authenticated Sessions Table (Stateful, revocable tokens)
        await runQuery(`
          CREATE TABLE IF NOT EXISTS auth_sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            doctor_id INTEGER,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);

        await seedInitialData();
        console.log('✅ SQLite Database schema & seed verified.');
      } catch (err) {
        console.warn('⚠️ SQLite Init Warning:', err.message);
      }
}

const ALL_PERMISSIONS = [
  'calendar_view',
  'calendar_manage',
  'calendar_all_doctors',
  'doctors_view',
  'doctors_manage',
  'unavailability_view',
  'unavailability_manage',
  'appointments_view',
  'appointments_manage',
  'clients_view',
  'clients_manage',
  'pricing_view',
  'pricing_manage',
  'settings_manage',
  'users_manage'
];

function getDefaultPermissions(role) {
  if (role === 'admin' || role === 'director') {
    return ALL_PERMISSIONS;
  }
  if (role === 'receptionist') {
    return [
      'calendar_view',
      'calendar_manage',
      'calendar_all_doctors',
      'doctors_view',
      'unavailability_view',
      'unavailability_manage',
      'appointments_view',
      'appointments_manage',
      'clients_view',
      'clients_manage',
      'pricing_view'
    ];
  }
  if (role === 'doctor') {
    return [
      'calendar_view',
      'calendar_manage',
      'unavailability_view',
      'unavailability_manage',
      'appointments_view',
      'clients_view'
    ];
  }
  return ['calendar_view'];
}

async function seedInitialData() {
  const envPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  const envToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
  const envVerify = process.env.WHATSAPP_VERIFY_TOKEN || 'apex_clinic_secure_webhook_token_2026';

  const existingSettings = await getQuery('SELECT * FROM settings WHERE id = 1');
  if (!existingSettings) {
    await runQuery(`
      INSERT INTO settings (
        id, business_name, business_type, clinic_phone, owner_personal_phone,
        address, persona_name, persona_tone, custom_instructions,
        cancellation_policy, currency, currency_symbol, currency_position,
        country, country_code, timezone, timezone_label,
        whatsapp_phone_number_id, whatsapp_verify_token, whatsapp_access_token
      ) VALUES (
        1,
        'Apex Care Medical & Multi-Specialty Clinic',
        'Multi-Doctor Healthcare Practice',
        '+1 (555) 014-9988',
        '+1 (555) 019-8234',
        'Suite 402, Metro Health Plaza, 1200 Healthcare Blvd, Metro City',
        'Aria',
        'Professional, empathetic, and efficient healthcare coordinator',
        'Please arrive 10 minutes prior to your consultation with photo ID and any prescription history. For emergency care, call 911 immediately.',
        'Appointments may be rescheduled or cancelled with at least 4 hours notice at no charge.',
        'USD',
        '$',
        'before',
        'Pakistan',
        'PK',
        'Asia/Karachi',
        'PKT (UTC+5)',
        ?, ?, ?
      )
    `, [envPhoneId, envVerify, envToken]);
  } else {
    // If env has credentials, update settings if settings was empty
    if (envPhoneId && (!existingSettings.whatsapp_phone_number_id || existingSettings.whatsapp_phone_number_id === '109823471923')) {
      await runQuery('UPDATE settings SET whatsapp_phone_number_id = ? WHERE id = 1', [envPhoneId]);
    }
    if (envToken && !existingSettings.whatsapp_access_token) {
      await runQuery('UPDATE settings SET whatsapp_access_token = ? WHERE id = 1', [envToken]);
    }
  }

  // Check doctors: only auto-seed initial demo doctors if sample data has NOT been purged
  const curSettings = await getQuery('SELECT sample_data_cleared FROM settings WHERE id = 1');
  const isPurged = curSettings && (curSettings.sample_data_cleared === 1 || curSettings.sample_data_cleared === '1');
  const doctorsCount = (await getQuery('SELECT COUNT(*) as count FROM doctors')).count;
  if (doctorsCount === 0 && !isPurged) {
    const doctorList = [
      {
        name: 'Dr. Alexander Wright, MD',
        title: 'Lead Physician & Cardiologist',
        specialty: 'Cardiology & Internal Medicine',
        personal_phone: '+1 (555) 019-8234',
        email: 'dr.wright@apexclinic.com',
        color_code: '#2563eb',
        bio: 'Board-certified cardiologist with 14 years clinical experience specializing in heart health, hypertension, and preventative medicine.'
      },
      {
        name: 'Dr. Sophia Patel, MD',
        title: 'Senior Pediatrician',
        specialty: 'Pediatrics & Adolescent Medicine',
        personal_phone: '+1 (555) 018-7711',
        email: 'dr.patel@apexclinic.com',
        color_code: '#0d9488',
        bio: 'Dedicated pediatrician with special focus on developmental milestones, newborn care, and pediatric preventive health.'
      },
      {
        name: 'Dr. Marcus Vance, DO',
        title: 'Family Medicine & Sports Physician',
        specialty: 'Family Medicine & Musculoskeletal',
        personal_phone: '+1 (555) 017-4499',
        email: 'dr.vance@apexclinic.com',
        color_code: '#7c3aed',
        bio: 'Comprehensive family physician managing routine health, chronic care, injury rehabilitation, and general wellness.'
      }
    ];

    const doctorIds = [];
    for (const doc of doctorList) {
      const res = await runQuery(`
        INSERT INTO doctors (name, title, specialty, personal_phone, email, color_code, bio, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `, [doc.name, doc.title, doc.specialty, doc.personal_phone, doc.email, doc.color_code, doc.bio]);
      doctorIds.push(res.lastID);
    }

    // Seed individual schedules for each doctor
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (let day = 0; day <= 6; day++) {
      // Dr. Wright
      const wrightActive = (day >= 1 && day <= 5) ? 1 : 0;
      await runQuery(`
        INSERT INTO doctor_schedules (doctor_id, day_of_week, day_name, is_active, start_time, end_time, break_start, break_end, slot_duration_minutes, buffer_minutes)
        VALUES (?, ?, ?, ?, '09:00', '17:00', '13:00', '14:00', 30, 10)
      `, [doctorIds[0], day, dayNames[day], wrightActive]);

      // Dr. Patel
      const patelActive = (day >= 1 && day <= 4) ? 1 : (day === 6 ? 1 : 0);
      const patelStart = day === 6 ? '09:00' : '08:30';
      const patelEnd = day === 6 ? '13:00' : '16:30';
      await runQuery(`
        INSERT INTO doctor_schedules (doctor_id, day_of_week, day_name, is_active, start_time, end_time, break_start, break_end, slot_duration_minutes, buffer_minutes)
        VALUES (?, ?, ?, ?, ?, ?, '12:30', '13:30', 30, 10)
      `, [doctorIds[1], day, dayNames[day], patelActive, patelStart, patelEnd]);

      // Dr. Vance
      const vanceActive = (day >= 2 && day <= 6) ? 1 : 0;
      await runQuery(`
        INSERT INTO doctor_schedules (doctor_id, day_of_week, day_name, is_active, start_time, end_time, break_start, break_end, slot_duration_minutes, buffer_minutes)
        VALUES (?, ?, ?, ?, '10:00', '18:00', '14:00', '15:00', 30, 10)
      `, [doctorIds[2], day, dayNames[day], vanceActive]);
    }

    // Seed Unavailability (3 days from now)
    await runQuery(`
      INSERT INTO doctor_unavailability (doctor_id, date, start_time, end_time, is_full_day, reason)
      VALUES (?, ?, '14:00', '18:00', 0, 'Sports Medicine CME Conference')
    `, [doctorIds[2], getDateOffset(3)]);

    // Seed Services
    const defaultServices = [
      { doctor_id: doctorIds[0], name: 'Cardiology & ECG Review', duration: 45, price: 120.00, desc: 'Electrocardiogram, blood pressure review, and cardiac consultation with Dr. Wright.' },
      { doctor_id: doctorIds[0], name: 'Hypertension Management', duration: 30, price: 75.00, desc: 'Blood pressure optimization, lifestyle and prescription review with Dr. Wright.' },
      { doctor_id: doctorIds[1], name: 'Pediatric Health Check', duration: 30, price: 65.00, desc: 'Child wellness check, growth monitoring, and pediatric exam with Dr. Patel.' },
      { doctor_id: doctorIds[1], name: 'Newborn & Infant Consultation', duration: 40, price: 85.00, desc: 'Newborn assessment, infant feeding, and developmental check with Dr. Patel.' },
      { doctor_id: doctorIds[2], name: 'Family General Consultation', duration: 30, price: 60.00, desc: 'Routine general medical check, physical examination, and care plan with Dr. Vance.' },
      { doctor_id: doctorIds[2], name: 'Joint & Musculoskeletal Exam', duration: 40, price: 90.00, desc: 'Joint mobility, injury evaluation, and pain management with Dr. Vance.' },
      { doctor_id: null, name: 'Comprehensive Health Checkup', duration: 60, price: 150.00, desc: 'Full head-to-toe annual preventive exam available with any available physician.' }
    ];

    for (const s of defaultServices) {
      await runQuery(`
        INSERT INTO services (doctor_id, name, duration_minutes, price, description, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
      `, [s.doctor_id, s.name, s.duration, s.price, s.desc]);
    }

    // Seed Clients & Families
    await runQuery(`INSERT INTO clients (phone, registered_name) VALUES ('+15551234567', 'Sarah Jenkins')`);
    await runQuery(`INSERT INTO patients (client_phone, full_name, relationship, age_or_notes) VALUES ('+15551234567', 'Sarah Jenkins', 'Self', 'Adult, 34 years')`);
    await runQuery(`INSERT INTO patients (client_phone, full_name, relationship, age_or_notes) VALUES ('+15551234567', 'Leo Jenkins', 'Child', 'Son, 6 years old')`);
    await runQuery(`INSERT INTO patients (client_phone, full_name, relationship, age_or_notes) VALUES ('+15551234567', 'Robert Jenkins', 'Spouse', 'Adult, 36 years')`);

    await runQuery(`INSERT INTO clients (phone, registered_name) VALUES ('+15559876543', 'David Watson')`);
    await runQuery(`INSERT INTO patients (client_phone, full_name, relationship, age_or_notes) VALUES ('+15559876543', 'David Watson', 'Self', 'Adult, 52 years')`);
    await runQuery(`INSERT INTO patients (client_phone, full_name, relationship, age_or_notes) VALUES ('+15559876543', 'Emily Watson', 'Child', 'Daughter, 14 years old')`);

    // DYNAMIC SEED APPOINTMENTS (Centered on today's actual date!)
    const todayStr = getDateOffset(0);
    const yesterdayStr = getDateOffset(-1);
    const tomorrowStr = getDateOffset(1);
    const inTwoDaysStr = getDateOffset(2);

    const seedAppointments = [
      // Yesterday (Completed)
      {
        id: 'APT-1001',
        doctor_id: doctorIds[0],
        doctor_name: 'Dr. Alexander Wright, MD',
        doctor_phone: '+1 (555) 019-8234',
        client_phone: '+15551234567',
        patient_id: 1,
        patient_name: 'Sarah Jenkins',
        service_id: 1,
        service_name: 'Cardiology & ECG Review',
        date: yesterdayStr,
        start_time: '10:00',
        end_time: '10:45',
        fee: 120.00,
        status: 'completed',
        notes: 'Routine resting ECG normal. Blood pressure 122/80.'
      },
      // Today (Confirmed)
      {
        id: 'APT-1002',
        doctor_id: doctorIds[0],
        doctor_name: 'Dr. Alexander Wright, MD',
        doctor_phone: '+1 (555) 019-8234',
        client_phone: '+15559876543',
        patient_id: 4,
        patient_name: 'David Watson',
        service_id: 2,
        service_name: 'Hypertension Management',
        date: todayStr,
        start_time: '11:00',
        end_time: '11:30',
        fee: 75.00,
        status: 'confirmed',
        notes: 'Reviewing ACE inhibitor response.'
      },
      {
        id: 'APT-1003',
        doctor_id: doctorIds[1],
        doctor_name: 'Dr. Sophia Patel, MD',
        doctor_phone: '+1 (555) 018-7711',
        client_phone: '+15551234567',
        patient_id: 2,
        patient_name: 'Leo Jenkins',
        service_id: 3,
        service_name: 'Pediatric Health Check',
        date: todayStr,
        start_time: '14:30',
        end_time: '15:00',
        fee: 65.00,
        status: 'confirmed',
        notes: 'Growth tracking and seasonal allergy check.'
      },
      // Tomorrow (24h Confirmation Window!)
      {
        id: 'APT-1004',
        doctor_id: doctorIds[2],
        doctor_name: 'Dr. Marcus Vance, DO',
        doctor_phone: '+1 (555) 017-4499',
        client_phone: '+15551234567',
        patient_id: 3,
        patient_name: 'Robert Jenkins',
        service_id: 5,
        service_name: 'Family General Consultation',
        date: tomorrowStr,
        start_time: '10:30',
        end_time: '11:00',
        fee: 60.00,
        status: 'confirmed',
        confirmation_sent_at: `${todayStr} 09:00:00`,
        confirmed_at: `${todayStr} 09:12:00`,
        notes: 'Annual work physical and cholesterol check.'
      },
      {
        id: 'APT-1005',
        doctor_id: doctorIds[1],
        doctor_name: 'Dr. Sophia Patel, MD',
        doctor_phone: '+1 (555) 018-7711',
        client_phone: '+15559876543',
        patient_id: 5,
        patient_name: 'Emily Watson',
        service_id: 3,
        service_name: 'Pediatric Health Check',
        date: tomorrowStr,
        start_time: '11:30',
        end_time: '12:00',
        fee: 65.00,
        status: 'tentative', // Reminder dispatched, awaiting response -> Tentative!
        confirmation_sent_at: `${todayStr} 11:30:00`,
        notes: 'High school sports clearance physical.'
      },
      // Day after tomorrow
      {
        id: 'APT-1006',
        doctor_id: doctorIds[1],
        doctor_name: 'Dr. Sophia Patel, MD',
        doctor_phone: '+1 (555) 018-7711',
        client_phone: '+15551234567',
        patient_id: 1,
        patient_name: 'Sarah Jenkins',
        service_id: 7,
        service_name: 'Comprehensive Health Checkup',
        date: inTwoDaysStr,
        start_time: '10:00',
        end_time: '11:00',
        fee: 150.00,
        status: 'confirmed',
        notes: 'Annual wellness exam.'
      }
    ];

    for (const a of seedAppointments) {
      await runQuery(`
        INSERT INTO appointments (
          id, doctor_id, doctor_name, doctor_phone, client_phone, patient_id,
          patient_name, service_id, service_name, date, start_time, end_time,
          fee, status, confirmation_sent_at, confirmed_at, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        a.id, a.doctor_id, a.doctor_name, a.doctor_phone, a.client_phone,
        a.patient_id, a.patient_name, a.service_id, a.service_name, a.date,
        a.start_time, a.end_time, a.fee, a.status, a.confirmation_sent_at || null,
        a.confirmed_at || null, a.notes
      ]);
    }

    // Seed Doctor Notifications
    await runQuery(`
      INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message)
      VALUES (?, 'new_booking', 'APT-1004', '+15551234567', 'Dr. Vance, you have a new booking: Robert Jenkins for Family General Consultation.')
    `, [doctorIds[2]]);
  }

  // Seed Staff & User Accounts (Role-Based Access Control)
  // Ensure the 4 foundational roles exist: Admin, Director/Owner, Receptionist, and one user per Doctor defined in system
  const allDocs = await allQuery('SELECT * FROM doctors ORDER BY id ASC');

  // 1. Admin User
  const existingAdmin = await getQuery("SELECT * FROM users WHERE username = 'admin' OR role = 'admin'");
  if (!existingAdmin) {
    const adminPass = hashPassword('Admin@2026!');
    await runQuery(`
      INSERT INTO users (username, email, password_hash, salt, full_name, role, is_active, must_change_password, permissions)
      VALUES (?, ?, ?, ?, ?, 'admin', 1, 1, ?)
    `, ['admin', 'admin@apexclinic.com', adminPass.hash, adminPass.salt, 'System Administrator', JSON.stringify(ALL_PERMISSIONS)]);
  } else {
    // Enforce must_change_password = 1 for admin on first login
    const adminPass = hashPassword('Admin@2026!', existingAdmin.salt);
    await runQuery(`
      UPDATE users SET password_hash = ?, permissions = ?, must_change_password = 1 WHERE id = ?
    `, [adminPass.hash, JSON.stringify(ALL_PERMISSIONS), existingAdmin.id]);
  }

  // 2. Owner / Medical Director User
  const leadDoc = allDocs.find(d => d.name.includes('Wright')) || allDocs[0];
  const leadDocId = leadDoc ? leadDoc.id : null;
  const existingDirector = await getQuery("SELECT * FROM users WHERE username = 'director' OR role = 'director'");
  if (!existingDirector) {
    const directorPass = hashPassword('Director@2026!');
    await runQuery(`
      INSERT INTO users (username, email, password_hash, salt, full_name, role, doctor_id, is_active, must_change_password, permissions)
      VALUES (?, ?, ?, ?, ?, 'director', ?, 1, 1, ?)
    `, ['director', 'director@apexclinic.com', directorPass.hash, directorPass.salt, 'Dr. Alexander Wright, MD (Medical Director & Owner)', leadDocId, JSON.stringify(ALL_PERMISSIONS)]);
  } else {
    const dirPass = hashPassword('Director@2026!', existingDirector.salt);
    await runQuery(`
      UPDATE users SET role = 'director', doctor_id = ?, password_hash = ?, must_change_password = 1, permissions = ? WHERE id = ?
    `, [leadDocId, dirPass.hash, JSON.stringify(ALL_PERMISSIONS), existingDirector.id]);
  }

  // 3. Receptionist User
  const existingReception = await getQuery("SELECT * FROM users WHERE username = 'reception' OR role = 'receptionist'");
  if (!existingReception) {
    const recPass = hashPassword('Reception@2026!');
    await runQuery(`
      INSERT INTO users (username, email, password_hash, salt, full_name, role, is_active, must_change_password, permissions)
      VALUES (?, ?, ?, ?, ?, 'receptionist', 1, 1, ?)
    `, ['reception', 'reception@apexclinic.com', recPass.hash, recPass.salt, 'Front Desk Reception', JSON.stringify(getDefaultPermissions('receptionist'))]);
  } else {
    const recPass = hashPassword('Reception@2026!', existingReception.salt);
    await runQuery(`
      UPDATE users SET password_hash = ?, must_change_password = 1, permissions = ? WHERE id = ?
    `, [recPass.hash, JSON.stringify(getDefaultPermissions('receptionist')), existingReception.id]);
  }

  // 4. One User for EACH Doctor defined in the system
  for (const doc of allDocs) {
    const docUser = await getQuery('SELECT * FROM users WHERE doctor_id = ? AND role = "doctor"', [doc.id]);
    let slug = doc.name.toLowerCase().replace(/[^a-z]/g, '');
    if (slug.startsWith('dr')) {
      const parts = doc.name.split(' ');
      const lastName = parts.length > 2 ? parts[2].toLowerCase().replace(/[^a-z]/g, '') : parts[1].toLowerCase().replace(/[^a-z]/g, '');
      slug = `dr.${lastName}`;
    } else {
      slug = `doc.${doc.id}`;
    }
    const defaultDocPass = hashPassword('DoctorPass@2026!');

    if (!docUser) {
      await runQuery(`
        INSERT INTO users (username, email, password_hash, salt, full_name, role, doctor_id, is_active, must_change_password, permissions)
        VALUES (?, ?, ?, ?, ?, 'doctor', ?, ?, 1, ?)
      `, [slug, doc.email || `${slug}@apexclinic.com`, defaultDocPass.hash, defaultDocPass.salt, doc.name, doc.id, doc.is_active, JSON.stringify(getDefaultPermissions('doctor'))]);
    } else {
      // Sync active state from doctor, ensure password hash matches DoctorPass@2026! if not changed yet
      if (docUser.must_change_password) {
        const resetPass = hashPassword('DoctorPass@2026!', docUser.salt);
        await runQuery('UPDATE users SET password_hash = ?, is_active = ?, permissions = COALESCE(permissions, ?) WHERE id = ?', [
          resetPass.hash,
          doc.is_active,
          JSON.stringify(getDefaultPermissions('doctor')),
          docUser.id
        ]);
      } else {
        await runQuery('UPDATE users SET is_active = ?, permissions = COALESCE(permissions, ?) WHERE id = ?', [
          doc.is_active,
          JSON.stringify(getDefaultPermissions('doctor')),
          docUser.id
        ]);
      }
    }
  }
}

const crypto = require('crypto');

function hashPassword(password, salt = null) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const verify = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return verify === hash;
}

module.exports = {
  db: dbInstance || nodeSqliteDb,
  initDb,
  runQuery,
  getQuery,
  allQuery,
  getDateOffset,
  getClinicDateTime,
  getClinicNow,
  hashPassword,
  verifyPassword,
  ALL_PERMISSIONS,
  getDefaultPermissions
};
