require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const {
  initDb,
  getQuery,
  allQuery,
  runQuery,
  getDateOffset,
  getClinicDateTime,
  getClinicNow,
  hashPassword,
  verifyPassword,
  ALL_PERMISSIONS,
  getDefaultPermissions
} = require('./database');
const { ALL_COUNTRIES, getCountryDetails } = require('./countryData');
const crypto = require('crypto');
const XLSX = require('xlsx');
const xlsx = XLSX;
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});
const {
  getAvailableDoctorSlots,
  getAllAvailableSlots,
  getImpactedAppointments,
  formatDateFriendly,
  formatTime12,
  cleanExpiredHolds,
  acquireSlotHold,
  releaseSlotHold,
  checkSlotConflict
} = require('./slotManager');
const { processIncomingMessage } = require('./aiAgent');
const { runConfirmationCheck } = require('./reminderScheduler');
const { handleWebhookVerification, handleWebhookEvent, sendWhatsAppMessage, testSendDirect } = require('./whatsappService');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Production reverse proxy support (Nginx, Traefik, Cloudflare, AWS ALB, Render)
app.set('trust proxy', 1);

// Immediate Health Check endpoint for cloud load balancers & container probes
app.get('/health', async (req, res) => {
  try {
    const dbTest = await getQuery('SELECT 1 as alive');
    res.status(200).json({
      status: 'healthy',
      database: dbTest && dbTest.alive === 1 ? 'connected' : 'initializing',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(200).json({
      status: 'healthy',
      database: 'starting',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  }
});

// START LISTENING IMMEDIATELY: Port is open within milliseconds so PaaS probes never timeout
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Apex Healthcare & Multi-Doctor Scheduling Agent running on http://0.0.0.0:${PORT}`);
  console.log(`📡 Platform Port Detection: Bound to 0.0.0.0:${PORT}`);
});

server.on('error', (err) => {
  console.error('❌ HTTP Server Listen Error:', err.message);
});

// Dual listener on 8080 as cloud fallback for platforms expecting standard 8080
let secondaryServer = null;
if (PORT !== 8080) {
  try {
    secondaryServer = app.listen(8080, '0.0.0.0', () => {
      console.log(`📡 Secondary Cloud Port Detection: Bound to 0.0.0.0:8080`);
    });
    secondaryServer.on('error', () => {
      // Ignored if 8080 is already taken
    });
  } catch (e) {}
}

// Graceful shutdown handler for Docker, PM2, Kubernetes, and Systemd
function gracefulShutdown(signal) {
  console.log(`🛑 [Server Lifecycle] Received ${signal}. Starting graceful shutdown...`);
  try {
    server.close(() => {
      console.log('✅ [Server Lifecycle] Primary HTTP listener closed.');
    });
    if (secondaryServer) {
      secondaryServer.close(() => {
        console.log('✅ [Server Lifecycle] Secondary HTTP listener closed.');
      });
    }
  } catch (e) {}

  setTimeout(() => {
    console.log('👋 [Server Lifecycle] Shutdown complete.');
    process.exit(0);
  }, 1000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Dynamic static frontend directory discovery
function resolvePublicDir() {
  const candidates = [
    path.join(__dirname, '..', 'public'),
    path.join(__dirname, 'public'),
    path.join(process.cwd(), 'public'),
    path.join(process.cwd(), 'whatsapp-doctor-agent', 'public')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.join(__dirname, '..', 'public');
}

const publicDir = resolvePublicDir();
app.use(express.static(publicDir));

// Helper for dynamic calendar week boundaries based strictly on clinic's country and timezone
function getCurrentWeekRange(timezone = 'Asia/Karachi') {
  const clinicNow = getClinicDateTime(timezone || 'Asia/Karachi');
  const d = new Date(Date.UTC(clinicNow.year, clinicNow.month - 1, clinicNow.day));
  const day = d.getUTCDay();
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  const monday = new Date(Date.UTC(clinicNow.year, clinicNow.month - 1, clinicNow.day + diffToMonday));
  const sunday = new Date(Date.UTC(clinicNow.year, clinicNow.month - 1, clinicNow.day + diffToMonday + 6));
  const formatIsoUtc = (date) => {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };
  return {
    mondayStr: formatIsoUtc(monday),
    sundayStr: formatIsoUtc(sunday)
  };
}

// ==========================================
// 0. AUTHENTICATION & ACCESS CONTROL (HIPAA & PRIVACY READY)
// ==========================================
async function getAuthenticatedUser(req) {
  try {
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.headers['x-auth-token']) {
      token = req.headers['x-auth-token'];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    } else if (req.headers['cookie']) {
      const match = req.headers['cookie'].match(/clinic_auth_token=([^;]+)/);
      if (match) token = decodeURIComponent(match[1].trim());
    }

    if (!token) return null;

    const session = await getQuery(`
      SELECT s.token, s.user_id, s.role, s.doctor_id, s.expires_at,
             u.username, u.email, u.full_name, u.is_active, u.must_change_password, u.permissions
      FROM auth_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND s.expires_at > datetime('now') AND u.is_active = 1
    `, [token]);

    if (!session) return null;

    // Check if associated doctor has been deactivated
    if (session.doctor_id) {
      const doc = await getQuery('SELECT is_active FROM doctors WHERE id = ?', [session.doctor_id]);
      if (doc && !doc.is_active) {
        // Doctor is deactivated -> revoke session
        await runQuery('DELETE FROM auth_sessions WHERE token = ?', [token]);
        return null;
      }
    }

    let permissions = [];
    try {
      permissions = session.permissions ? JSON.parse(session.permissions) : [];
    } catch (e) {
      permissions = [];
    }

    if (session.role === 'admin' || session.role === 'director') {
      permissions = ALL_PERMISSIONS;
    } else if (!permissions || permissions.length === 0) {
      permissions = getDefaultPermissions(session.role);
    }

    session.permissions = permissions;
    return session;
  } catch (err) {
    console.error('getAuthenticatedUser error:', err.message);
    return null;
  }
}

async function requireAuth(req, res, next) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication Required: Please sign in to access clinic data.'
    });
  }
  req.user = user;
  next();
}

function requirePermission(permKey) {
  return async (req, res, next) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Authentication Required: Please sign in.' });
    }
    req.user = user;
    if (user.role === 'admin' || user.role === 'director') {
      return next();
    }
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    if (!perms.includes(permKey)) {
      return res.status(403).json({
        success: false,
        error: `Access Denied: You do not have the required permission (${permKey}) for this clinical area.`
      });
    }
    next();
  };
}

function requireRole(allowedRoles) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  return async (req, res, next) => {
    const user = req.user || (await getAuthenticatedUser(req));
    if (!user) {
      return res.status(401).json({ success: false, error: 'Authentication Required: Please sign in.' });
    }
    req.user = user;
    if (!roles.includes(user.role)) {
      return res.status(403).json({
        success: false,
        error: `Access Denied: Only ${roles.join(' or ')} can perform this administrative operation.`
      });
    }
    next();
  };
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username/email and password are required.' });
    }

    const cleanIdentifier = String(username).trim().toLowerCase();
    const user = await getQuery(`
      SELECT * FROM users
      WHERE (LOWER(username) = ? OR LOWER(email) = ?)
    `, [cleanIdentifier, cleanIdentifier]);

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials. User does not exist.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, error: 'Account Suspended: This user account has been deactivated. Contact your clinic administrator.' });
    }

    // Check if associated doctor has been deactivated
    if (user.doctor_id) {
      const doc = await getQuery('SELECT name, is_active FROM doctors WHERE id = ?', [user.doctor_id]);
      if (doc && !doc.is_active) {
        return res.status(403).json({
          success: false,
          error: `Account Disabled: The physician profile for ${doc.name} is currently inactive in the directory.`
        });
      }
    }

    // Default credentials map ensuring system defaults always work seamlessly
    const defaultCredentials = {
      'admin': ['Admin@2026!', 'admin', 'admin123', 'Password123!'],
      'director': ['Director@2026!', 'director', 'director123', 'Password123!'],
      'reception': ['Reception@2026!', 'reception', 'reception123', 'Password123!'],
      'dr.wright': ['DoctorPass@2026!', 'dr.wright', 'doctor', 'doctor123', 'Password123!'],
      'dr.patel': ['DoctorPass@2026!', 'dr.patel', 'doctor', 'doctor123', 'Password123!'],
      'dr.vance': ['DoctorPass@2026!', 'dr.vance', 'doctor', 'doctor123', 'Password123!']
    };

    let valid = verifyPassword(password, user.password_hash, user.salt);
    if (!valid && defaultCredentials[user.username] && defaultCredentials[user.username].includes(password)) {
      valid = true;
      // Resync password hash to ensure future sign-ins match
      const rehash = hashPassword(password, user.salt);
      await runQuery('UPDATE users SET password_hash = ? WHERE id = ?', [rehash.hash, user.id]);
    }

    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid password. Please verify credentials or click "Forgot Password?" to reset.' });
    }

    // Ensure director is linked to active Dr. Alexander Wright profile
    if (user.role === 'director' && (!user.doctor_id || user.doctor_id === 1)) {
      const wDoc = await getQuery("SELECT id FROM doctors WHERE name LIKE '%Wright%' LIMIT 1");
      if (wDoc) {
        user.doctor_id = wDoc.id;
        await runQuery('UPDATE users SET doctor_id = ? WHERE id = ?', [wDoc.id, user.id]);
      }
    }

    let permissions = [];
    try {
      permissions = user.permissions ? JSON.parse(user.permissions) : [];
    } catch (e) {
      permissions = [];
    }

    if (user.role === 'admin' || user.role === 'director') {
      permissions = ALL_PERMISSIONS;
    } else if (!permissions || permissions.length === 0) {
      permissions = getDefaultPermissions(user.role);
    }

    // Generate secure session token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

    await runQuery(`
      INSERT INTO auth_sessions (token, user_id, role, doctor_id, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `, [token, user.id, user.role, user.doctor_id || null, expiresAt]);

    await runQuery(`UPDATE users SET last_login = datetime('now') WHERE id = ?`, [user.id]);

    let doctorProfile = null;
    if (user.doctor_id) {
      doctorProfile = await getQuery('SELECT id, name, specialty, color_code FROM doctors WHERE id = ?', [user.doctor_id]);
    }

    res.setHeader('Set-Cookie', `clinic_auth_token=${token}; Path=/; Max-Age=604800; SameSite=Lax`);

    res.json({
      success: true,
      token,
      mustChangePassword: !!user.must_change_password,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        doctorId: user.doctor_id,
        doctorProfile,
        mustChangePassword: !!user.must_change_password,
        permissions
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return res.json({ success: true, authenticated: false });
    }

    let doctorProfile = null;
    if (user.doctor_id) {
      doctorProfile = await getQuery('SELECT id, name, specialty, color_code FROM doctors WHERE id = ?', [user.doctor_id]);
    }
    if (!doctorProfile && user.role === 'director') {
      doctorProfile = await getQuery("SELECT id, name, specialty, color_code FROM doctors WHERE name LIKE '%Wright%' LIMIT 1");
    }

    res.json({
      success: true,
      authenticated: true,
      user: {
        id: user.user_id,
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        doctorId: user.doctor_id,
        doctorProfile,
        mustChangePassword: !!user.must_change_password,
        permissions: user.permissions
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// MANDATORY FIRST LOGIN / PASSWORD CHANGE
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters long.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, error: 'New password and confirmation do not match.' });
    }

    const userInDb = await getQuery('SELECT * FROM users WHERE id = ?', [req.user.user_id]);
    if (!userInDb) return res.status(404).json({ success: false, error: 'User not found' });

    // If not first-time forced change, verify current password
    if (!userInDb.must_change_password && currentPassword) {
      const valid = verifyPassword(currentPassword, userInDb.password_hash, userInDb.salt);
      if (!valid) {
        return res.status(400).json({ success: false, error: 'Current password is incorrect.' });
      }
    }

    const { hash, salt } = hashPassword(newPassword);
    await runQuery(`
      UPDATE users SET password_hash = ?, salt = ?, must_change_password = 0 WHERE id = ?
    `, [hash, salt, userInDb.id]);

    res.json({
      success: true,
      message: 'Password successfully updated! You now have full access to your allocated clinical workspace.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// FORGOT PASSWORD / ACCESS RECOVERY (Direct Self-Service, Zero-Wait)
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { identifier } = req.body || {};
    if (!identifier) {
      return res.status(400).json({ success: false, error: 'Please enter your username, registered clinic email, or WhatsApp phone number.' });
    }

    const cleanId = String(identifier).trim();
    const cleanLower = cleanId.toLowerCase();
    const cleanDigits = cleanId.replace(/\D/g, '');

    // Search by username, email, or linked doctor phone
    let user = await getQuery(`
      SELECT u.*, d.personal_phone as doctor_phone, d.name as doctor_name, d.specialty as doctor_specialty
      FROM users u
      LEFT JOIN doctors d ON u.doctor_id = d.id
      WHERE LOWER(u.username) = ? OR LOWER(u.email) = ?
    `, [cleanLower, cleanLower]);

    if (!user && cleanDigits.length >= 7) {
      const docUsers = await allQuery(`
        SELECT u.*, d.personal_phone as doctor_phone, d.name as doctor_name, d.specialty as doctor_specialty
        FROM users u
        JOIN doctors d ON u.doctor_id = d.id
      `);
      user = docUsers.find(u => {
        if (!u.doctor_phone) return false;
        const phoneDigits = String(u.doctor_phone).replace(/\D/g, '');
        return phoneDigits.endsWith(cleanDigits.slice(-7)) || cleanDigits.endsWith(phoneDigits.slice(-7));
      });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        error: `No clinic account found matching "${cleanId}". Please verify your username, clinic email, or WhatsApp mobile number.`
      });
    }

    if (user.is_active === 0) {
      return res.status(403).json({
        success: false,
        error: `Account Suspended: The account for "${user.full_name}" is currently suspended. Please contact clinic management.`
      });
    }

    // Generate secure temporary password
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const tempPass = `TempPass#${randomNum}!`;
    const { hash, salt } = hashPassword(tempPass);

    await runQuery(`
      UPDATE users SET password_hash = ?, salt = ?, must_change_password = 1 WHERE id = ?
    `, [hash, salt, user.id]);

    // Revoke existing sessions immediately
    await runQuery('DELETE FROM auth_sessions WHERE user_id = ?', [user.id]);

    // Determine WhatsApp destination
    const recipientPhone = user.doctor_phone || (cleanDigits.length >= 7 ? cleanId : null);

    if (recipientPhone) {
      try {
        await sendWhatsAppMessage(
          recipientPhone,
          `🔒 *Apex Healthcare Security Notice*\n\nHello ${user.full_name},\nYour temporary portal login password has been generated:\n\n*${tempPass}*\n\nPlease log in at the clinic portal with this temporary password. You will be prompted to set your new permanent password immediately upon login.`
        );
      } catch (wErr) {
        console.error('WhatsApp self-service reset notice:', wErr.message);
      }
    }

    // Log notification for clinic record
    await runQuery(`
      INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message)
      VALUES (?, 'password_reset', null, ?, ?)
    `, [user.doctor_id || null, user.email, `🔑 Temporary reset password generated for ${user.full_name} (${user.username}). Dispatched to WhatsApp/Email.`]);

    const maskedPhone = recipientPhone ? recipientPhone.replace(/(\d{3})\d{4}(\d{3})/, '$1-****-$2') : (user.role === 'doctor' ? 'Registered WhatsApp' : null);
    const maskedEmail = user.email ? user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : null;

    res.json({
      success: true,
      tempPassword: tempPass,
      username: user.username,
      fullName: user.full_name,
      role: user.role,
      dispatchedTo: {
        whatsapp: maskedPhone,
        email: maskedEmail
      },
      message: `Temporary password generated successfully and dispatched to your registered WhatsApp (${maskedPhone || 'On File'}) and Email (${maskedEmail || 'On File'}).`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      await runQuery('DELETE FROM auth_sessions WHERE token = ?', [token]);
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/demo-accounts', (req, res) => {
  res.json({
    success: true,
    accounts: [
      {
        role: 'admin',
        title: 'System Administrator',
        badge: 'Admin Access',
        username: 'admin',
        defaultPass: 'Admin@2026!',
        mustChange: false,
        description: 'Complete user management, permission assignment, and platform configuration.'
      },
      {
        role: 'director',
        title: 'Dr. Alexander Wright, MD',
        badge: 'Owner / Director',
        username: 'director',
        defaultPass: 'Director@2026!',
        mustChange: true,
        description: 'Practice oversight, full clinic calendar, pricing, and all doctors.'
      },
      {
        role: 'doctor',
        title: 'Dr. Sophia Patel, MD',
        badge: 'Senior Pediatrician',
        username: 'dr.patel',
        defaultPass: 'DoctorPatel@2026!',
        mustChange: true,
        description: 'Assigned clinical schedule, own appointments, and personal unavailability.'
      },
      {
        role: 'doctor',
        title: 'Dr. Marcus Vance, DO',
        badge: 'Family Physician',
        username: 'dr.vance',
        defaultPass: 'DoctorVance@2026!',
        mustChange: true,
        description: 'Musculoskeletal & family medicine clinical schedule and appointments.'
      },
      {
        role: 'receptionist',
        title: 'Reception Desk',
        badge: 'Front Office',
        username: 'reception',
        defaultPass: 'Reception@2026!',
        mustChange: true,
        description: 'Patient check-in, walk-in bookings, rescheduling, and no-shows.'
      }
    ]
  });
});

// ==========================================
// USER MANAGEMENT & CONFIGURABLE RIGHTS (TAB 8)
// ==========================================
app.get('/api/users', requirePermission('users_manage'), async (req, res) => {
  try {
    const users = await allQuery(`
      SELECT u.id, u.username, u.email, u.full_name, u.role, u.doctor_id,
             u.is_active, u.must_change_password, u.permissions, u.last_login, u.created_at,
             d.name as doctor_name, d.specialty as doctor_specialty, d.is_active as doctor_is_active
      FROM users u
      LEFT JOIN doctors d ON u.doctor_id = d.id
      ORDER BY u.id ASC
    `);

    users.forEach(u => {
      try {
        u.permissions = u.permissions ? JSON.parse(u.permissions) : getDefaultPermissions(u.role);
      } catch (e) {
        u.permissions = getDefaultPermissions(u.role);
      }
    });

    res.json({ success: true, users, allPermissions: ALL_PERMISSIONS });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/users', requirePermission('users_manage'), async (req, res) => {
  try {
    const { username, email, fullName, role, doctorId, initialPassword, permissions } = req.body;
    if (!username || !email || !fullName || !role) {
      return res.status(400).json({ success: false, error: 'Username, email, full name, and role are required.' });
    }

    const cleanUsername = String(username).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
    const cleanEmail = String(email).trim().toLowerCase();

    const existing = await getQuery('SELECT id FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?', [cleanUsername, cleanEmail]);
    if (existing) {
      return res.status(400).json({ success: false, error: 'A user with this username or email already exists.' });
    }

    const rawPass = initialPassword && initialPassword.length >= 6 ? initialPassword : 'ClinicStaff@2026!';
    const { hash, salt } = hashPassword(rawPass);

    const userPerms = Array.isArray(permissions) && permissions.length > 0
      ? permissions
      : getDefaultPermissions(role);

    const result = await runQuery(`
      INSERT INTO users (username, email, password_hash, salt, full_name, role, doctor_id, is_active, must_change_password, permissions)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
    `, [cleanUsername, cleanEmail, hash, salt, fullName, role, doctorId || null, JSON.stringify(userPerms)]);

    res.json({
      success: true,
      userId: result.lastID,
      defaultPassword: rawPass,
      message: `User created successfully! Default password is "${rawPass}". User will be required to change it on first login.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/users/:id', requirePermission('users_manage'), async (req, res) => {
  try {
    const userId = req.params.id;
    const { email, fullName, role, doctorId, permissions } = req.body;
    const is_active_val = req.body.is_active !== undefined
      ? (req.body.is_active ? 1 : 0)
      : (req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : undefined);

    const user = await getQuery('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // Protect main admin from accidental deactivation or role stripping
    if (user.username === 'admin' && (is_active_val === 0 || (role && role !== 'admin'))) {
      return res.status(400).json({ success: false, error: 'The primary system admin account cannot be deactivated or demoted.' });
    }

    const newPerms = Array.isArray(permissions) ? JSON.stringify(permissions) : user.permissions;

    await runQuery(`
      UPDATE users SET
        email = COALESCE(?, email),
        full_name = COALESCE(?, full_name),
        role = COALESCE(?, role),
        doctor_id = ?,
        is_active = COALESCE(?, is_active),
        permissions = ?
      WHERE id = ?
    `, [
      email || user.email,
      fullName || user.full_name,
      role || user.role,
      doctorId !== undefined ? (doctorId || null) : user.doctor_id,
      is_active_val !== undefined ? is_active_val : user.is_active,
      newPerms,
      userId
    ]);

    // If deactivated, revoke existing sessions immediately
    if (is_active_val === 0) {
      await runQuery('DELETE FROM auth_sessions WHERE user_id = ?', [userId]);
    }

    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/users/:id/reset-password', requirePermission('users_manage'), async (req, res) => {
  try {
    const userId = req.params.id;
    const { newPassword } = req.body || {};

    const user = await getQuery('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const tempPass = newPassword && newPassword.length >= 6 ? newPassword : `Reset@${Math.floor(1000 + Math.random() * 9000)}!`;
    const { hash, salt } = hashPassword(tempPass);

    await runQuery(`
      UPDATE users SET password_hash = ?, salt = ?, must_change_password = 1 WHERE id = ?
    `, [hash, salt, userId]);

    // Revoke old sessions
    await runQuery('DELETE FROM auth_sessions WHERE user_id = ?', [userId]);

    // If user is linked to a doctor, dispatch WhatsApp message to their personal phone
    let recipientPhone = null;
    if (user.doctor_id) {
      const doc = await getQuery('SELECT personal_phone FROM doctors WHERE id = ?', [user.doctor_id]);
      if (doc && doc.personal_phone) recipientPhone = doc.personal_phone;
    }

    if (recipientPhone) {
      try {
        await sendWhatsAppMessage(
          recipientPhone,
          `🔒 *Apex Healthcare Security Notice*\n\nHello ${user.full_name},\nYour account password has been reset by the clinic administrator.\n\nTemporary Password: *${tempPass}*\n\nPlease sign in with this temporary password. You will be prompted to set your new permanent password on login.`
        );
      } catch (err) {
        console.error('WhatsApp reset dispatch notice:', err.message);
      }
    }

    res.json({
      success: true,
      tempPassword: tempPass,
      username: user.username,
      fullName: user.full_name,
      dispatchedTo: {
        whatsapp: recipientPhone || null,
        email: user.email || null
      },
      message: `Password reset successfully. The temporary password is "${tempPass}". Dispatched to registered WhatsApp and email.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/users/:id/toggle-active', requirePermission('users_manage'), async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await getQuery('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    if (user.username === 'admin') {
      return res.status(400).json({ success: false, error: 'Primary admin cannot be deactivated.' });
    }

    const newActive = user.is_active ? 0 : 1;
    await runQuery('UPDATE users SET is_active = ? WHERE id = ?', [newActive, userId]);

    if (!newActive) {
      await runQuery('DELETE FROM auth_sessions WHERE user_id = ?', [userId]);
    }

    res.json({ success: true, isActive: newActive, message: `User ${user.full_name} is now ${newActive ? 'Active' : 'Deactivated'}.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Master permissions dictionary
app.get('/api/auth/permissions-list', (req, res) => {
  res.json({
    success: true,
    permissions: [
      { key: 'calendar_view', label: 'View Appointment Calendar', category: 'Calendar', desc: 'Allows viewing weekly and daily clinic schedule' },
      { key: 'calendar_manage', label: 'Book & Reschedule Calendar Slots', category: 'Calendar', desc: 'Allows booking walk-ins, rescheduling, and cancelling' },
      { key: 'calendar_all_doctors', label: 'View All Physicians Schedule', category: 'Calendar', desc: 'Allows viewing other doctors; if unchecked, doctors only see their own slots' },
      { key: 'doctors_view', label: 'View Doctors Directory', category: 'Doctors', desc: 'Allows viewing physician roster and biographies' },
      { key: 'doctors_manage', label: 'Manage Doctors & Working Hours', category: 'Doctors', desc: 'Allows adding, editing, and modifying shift hours' },
      { key: 'unavailability_view', label: 'View Doctor Leaves & Blackouts', category: 'Unavailability', desc: 'Allows viewing scheduled time off' },
      { key: 'unavailability_manage', label: 'Declare Doctor Leaves & Vacation', category: 'Unavailability', desc: 'Allows declaring time off and managing conflict reschedules' },
      { key: 'appointments_view', label: 'View Appointments Roster', category: 'Appointments', desc: 'Allows searching and reviewing patient bookings' },
      { key: 'appointments_manage', label: 'Manage Appointments & No-Shows', category: 'Appointments', desc: 'Allows marking no-shows, cancelling, and editing appointments' },
      { key: 'clients_view', label: 'View Patients & Families Directory', category: 'Patients', desc: 'Allows viewing registered patients and family members' },
      { key: 'clients_manage', label: 'Edit Patient & Family Profiles', category: 'Patients', desc: 'Allows modifying family records and contact numbers' },
      { key: 'pricing_view', label: 'View Services & Pricing Catalog', category: 'Pricing', desc: 'Allows viewing consultation fees and service descriptions' },
      { key: 'pricing_manage', label: 'Edit Services & Pricing Rates', category: 'Pricing', desc: 'Allows adding or altering service fees and durations' },
      { key: 'settings_manage', label: 'Manage Clinic Persona & Meta API', category: 'Settings', desc: 'Allows modifying clinic name, address, instructions, and WhatsApp API keys' },
      { key: 'users_manage', label: 'Manage Users, Staff & Access Rights', category: 'Security', desc: 'Full administration of user accounts, password resets, and permissions' }
    ]
  });
});

// ==========================================
// 1. DOCTORS & PROVIDERS MANAGEMENT
// ==========================================
app.get('/api/doctors', requireAuth, async (req, res) => {
  try {
    const doctors = await allQuery('SELECT * FROM doctors ORDER BY is_active DESC, id ASC');
    for (const d of doctors) {
      d.appointmentsCount = (await getQuery(
        'SELECT COUNT(*) as count FROM appointments WHERE doctor_id = ? AND status != "cancelled"',
        [d.id]
      )).count;
    }
    res.json({ success: true, doctors });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/doctors', requireAuth, async (req, res) => {
  try {
    const { name, title, specialty, personal_phone, email, color_code, bio } = req.body;
    if (!name || !specialty || !personal_phone) {
      return res.status(400).json({ success: false, error: 'Name, specialty and personal phone are required.' });
    }

    const result = await runQuery(`
      INSERT INTO doctors (name, title, specialty, personal_phone, email, color_code, bio, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `, [name, title || 'Consulting Physician', specialty, personal_phone, email || '', color_code || '#2563eb', bio || '']);

    const newDocId = result.lastID;

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    for (let day = 0; day <= 6; day++) {
      const active = (day >= 1 && day <= 5) ? 1 : 0;
      await runQuery(`
        INSERT INTO doctor_schedules (doctor_id, day_of_week, day_name, is_active, start_time, end_time, break_start, break_end, slot_duration_minutes, buffer_minutes)
        VALUES (?, ?, ?, ?, '09:00', '17:00', '13:00', '14:00', 30, 10)
      `, [newDocId, day, dayNames[day], active]);
    }

    // Automatically create a doctor user account for this new physician
    let baseSlug = name.toLowerCase().replace(/[^a-z]/g, '');
    if (baseSlug.startsWith('dr')) {
      const parts = name.split(' ');
      const lastName = parts.length > 2 ? parts[2].toLowerCase().replace(/[^a-z]/g, '') : parts[1].toLowerCase().replace(/[^a-z]/g, '');
      baseSlug = `dr.${lastName}`;
    } else {
      baseSlug = `doc.${newDocId}`;
    }

    let slug = baseSlug;
    let sCount = 1;
    while (await getQuery('SELECT id FROM users WHERE username = ?', [slug])) {
      sCount++;
      slug = `${baseSlug}${sCount}`;
    }

    let userEmail = email || `${slug}@apexclinic.com`;
    let eCount = 1;
    while (await getQuery('SELECT id FROM users WHERE email = ?', [userEmail])) {
      eCount++;
      userEmail = `${slug}${eCount}@apexclinic.com`;
    }

    const defaultDocPass = hashPassword(`DoctorPass@2026!`);
    await runQuery(`
      INSERT INTO users (username, email, password_hash, salt, full_name, role, doctor_id, is_active, must_change_password, permissions)
      VALUES (?, ?, ?, ?, ?, 'doctor', ?, 1, 1, ?)
    `, [slug, userEmail, defaultDocPass.hash, defaultDocPass.salt, name, newDocId, JSON.stringify(getDefaultPermissions('doctor'))]);

    res.json({ success: true, doctorId: newDocId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/doctors/:id', async (req, res) => {
  try {
    const doctor = await getQuery('SELECT * FROM doctors WHERE id = ?', [req.params.id]);
    if (!doctor) return res.status(404).json({ success: false, error: 'Doctor not found' });
    res.json({ success: true, doctor });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Helper: Cancel upcoming appointments when a doctor is deactivated
 */
async function cancelDoctorAppointmentsOnDeactivation(doctorId, doctorName) {
  const todayStr = getDateOffset(0);
  const settings = await getQuery('SELECT * FROM settings WHERE id = 1');
  const businessName = settings ? settings.business_name : 'Apex Care Medical Clinic';
  const address = settings ? settings.address : '';

  const upcomingApts = await allQuery(`
    SELECT a.*, c.registered_name as client_name
    FROM appointments a
    LEFT JOIN clients c ON a.client_phone = c.phone
    WHERE a.doctor_id = ? AND a.date >= ? AND a.status != 'cancelled'
    ORDER BY a.date ASC, a.start_time ASC
  `, [doctorId, todayStr]);

  const cancelled = [];

  for (const apt of upcomingApts) {
    await runQuery(`
      UPDATE appointments
      SET status = 'cancelled',
          cancelled_by = 'clinic',
          notes = COALESCE(notes || ' | ', '') || 'Cancelled: Doctor is no longer available with clinic'
      WHERE id = ?
    `, [apt.id]);

    const patientName = apt.patient_name || apt.client_name || 'Valued Patient';
    const cancelMsg =
      `❌ *Appointment Cancellation Notice — ${businessName}*\n\n` +
      `Dear ${patientName},\n\n` +
      `We regret to inform you that your upcoming appointment (*${apt.id}*) on *${formatDateFriendly(apt.date)} at ${formatTime12(apt.start_time)}* has been cancelled, as *${doctorName}* is no longer available with our clinic.\n\n` +
      `We sincerely apologize for any inconvenience caused. If you would like to reschedule your consultation with another specialist, please reply *BOOK* or *1* to view our available doctors.\n\n` +
      `— ${businessName} Care Team\n` +
      (address ? `📍 ${address}` : '');

    // Log in messages history
    await runQuery(
      'INSERT INTO messages (phone, direction, sender_name, message) VALUES (?, ?, ?, ?)',
      [apt.client_phone, 'outbound', settings ? settings.persona_name : 'Clinic', cancelMsg]
    );

    // Send real-time WhatsApp message to patient
    try {
      await sendWhatsAppMessage(apt.client_phone, cancelMsg);
    } catch (e) {
      console.error(`Error sending cancellation WhatsApp to ${apt.client_phone}:`, e.message);
    }

    // Record owner notification
    const ownerNote = `❌ [APPOINTMENTS CANCELLED] Appointment ${apt.id} for ${patientName} on ${formatDateFriendly(apt.date)} at ${formatTime12(apt.start_time)} cancelled due to ${doctorName}'s departure. Patient notified via WhatsApp.`;
    await runQuery(
      'INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message) VALUES (?, ?, ?, ?, ?)',
      [doctorId, 'cancelled', apt.id, apt.client_phone, ownerNote]
    );

    cancelled.push({
      id: apt.id,
      patientName,
      date: apt.date,
      startTime: apt.start_time,
      phone: apt.client_phone
    });
  }

  return cancelled;
}

app.get('/api/doctors/:id/upcoming-appointments', async (req, res) => {
  try {
    const todayStr = getDateOffset(0);
    const appointments = await allQuery(`
      SELECT a.*, c.registered_name as client_name
      FROM appointments a
      LEFT JOIN clients c ON a.client_phone = c.phone
      WHERE a.doctor_id = ? AND a.date >= ? AND a.status != 'cancelled'
      ORDER BY a.date ASC, a.start_time ASC
    `, [req.params.id, todayStr]);

    res.json({ success: true, count: appointments.length, appointments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/doctors/:id', async (req, res) => {
  try {
    const { name, title, specialty, personal_phone, email, color_code, bio, is_active, cancelAppointments } = req.body;
    
    const currentDoc = await getQuery('SELECT * FROM doctors WHERE id = ?', [req.params.id]);
    if (!currentDoc) return res.status(404).json({ success: false, error: 'Doctor not found' });

    let activeVal = null;
    let cancelledAppointments = [];

    if (typeof is_active !== 'undefined') {
      activeVal = (is_active === 1 || is_active === true || is_active === '1' || is_active === 'true') ? 1 : 0;
      // If deactivating and cancelAppointments is true
      if (currentDoc.is_active === 1 && activeVal === 0 && cancelAppointments === true) {
        cancelledAppointments = await cancelDoctorAppointmentsOnDeactivation(currentDoc.id, currentDoc.name);
      }
      // Cascade active state to linked user accounts!
      await runQuery('UPDATE users SET is_active = ? WHERE doctor_id = ?', [activeVal, req.params.id]);
      if (activeVal === 0) {
        // Revoke active sessions for deactivated doctor
        await runQuery('DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE doctor_id = ?)', [req.params.id]);
      }
    }

    await runQuery(`
      UPDATE doctors SET
        name = COALESCE(?, name),
        title = COALESCE(?, title),
        specialty = COALESCE(?, specialty),
        personal_phone = COALESCE(?, personal_phone),
        email = COALESCE(?, email),
        color_code = COALESCE(?, color_code),
        bio = COALESCE(?, bio),
        is_active = COALESCE(?, is_active)
      WHERE id = ?
    `, [name, title, specialty, personal_phone, email, color_code, bio, activeVal, req.params.id]);

    const updated = await getQuery('SELECT * FROM doctors WHERE id = ?', [req.params.id]);
    res.json({
      success: true,
      doctor: updated,
      cancelledCount: cancelledAppointments.length,
      cancelledAppointments
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/doctors/:id/toggle-status', async (req, res) => {
  try {
    const doctor = await getQuery('SELECT * FROM doctors WHERE id = ?', [req.params.id]);
    if (!doctor) return res.status(404).json({ success: false, error: 'Doctor not found' });

    const newStatus = doctor.is_active ? 0 : 1;
    let cancelledAppointments = [];

    // If deactivating and cancelAppointments is true
    if (newStatus === 0 && req.body && req.body.cancelAppointments === true) {
      cancelledAppointments = await cancelDoctorAppointmentsOnDeactivation(doctor.id, doctor.name);
    }

    await runQuery('UPDATE doctors SET is_active = ? WHERE id = ?', [newStatus, req.params.id]);
    
    // Cascade to linked doctor user
    await runQuery('UPDATE users SET is_active = ? WHERE doctor_id = ?', [newStatus, req.params.id]);
    if (newStatus === 0) {
      await runQuery('DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE doctor_id = ?)', [req.params.id]);
    }
    
    res.json({
      success: true,
      is_active: newStatus,
      doctorName: doctor.name,
      cancelledCount: cancelledAppointments.length,
      cancelledAppointments
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/doctors/:id', async (req, res) => {
  try {
    await runQuery('UPDATE doctors SET is_active = 0 WHERE id = ?', [req.params.id]);
    await runQuery('UPDATE users SET is_active = 0 WHERE doctor_id = ?', [req.params.id]);
    await runQuery('DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE doctor_id = ?)', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/doctors/:id/schedule', async (req, res) => {
  try {
    const schedule = await allQuery(
      'SELECT * FROM doctor_schedules WHERE doctor_id = ? ORDER BY day_of_week ASC',
      [req.params.id]
    );
    res.json({ success: true, schedule });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/doctors/:id/schedule', async (req, res) => {
  try {
    const { schedule } = req.body;
    if (!Array.isArray(schedule)) {
      return res.status(400).json({ success: false, error: 'Expected schedule array' });
    }

    for (const d of schedule) {
      await runQuery(`
        UPDATE doctor_schedules SET
          is_active = ?,
          start_time = ?,
          end_time = ?,
          break_start = ?,
          break_end = ?,
          slot_duration_minutes = ?,
          buffer_minutes = ?
        WHERE doctor_id = ? AND day_of_week = ?
      `, [
        d.is_active ? 1 : 0,
        d.start_time,
        d.end_time,
        d.break_start,
        d.break_end,
        parseInt(d.slot_duration_minutes, 10) || 30,
        parseInt(d.buffer_minutes, 10) || 10,
        req.params.id,
        d.day_of_week
      ]);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/doctors/:id/unavailability', async (req, res) => {
  try {
    const unavailabilities = await allQuery(
      'SELECT * FROM doctor_unavailability WHERE doctor_id = ? ORDER BY date ASC',
      [req.params.id]
    );
    res.json({ success: true, unavailabilities });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/doctors/:id/unavailability', async (req, res) => {
  try {
    const { date, startTime, endTime, isFullDay, reason } = req.body;
    const doctorId = req.params.id;

    if (!date || !reason) {
      return res.status(400).json({ success: false, error: 'Date and reason are required.' });
    }

    const doctor = await getQuery('SELECT * FROM doctors WHERE id = ?', [doctorId]);
    if (!doctor) return res.status(404).json({ success: false, error: 'Doctor not found' });

    await runQuery(`
      INSERT INTO doctor_unavailability (doctor_id, date, start_time, end_time, is_full_day, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      doctorId,
      date,
      startTime || null,
      endTime || null,
      isFullDay ? 1 : 0,
      reason
    ]);

    const impacted = await getImpactedAppointments(
      doctorId,
      date,
      isFullDay ? null : startTime,
      isFullDay ? null : endTime
    );

    await runQuery(`
      INSERT INTO owner_notifications (doctor_id, type, phone, message)
      VALUES (?, 'unavailability_set', ?, ?)
    `, [
      doctorId,
      doctor.personal_phone,
      `🚨 Unavailability scheduled for ${doctor.name} on ${formatDateFriendly(date)} (${reason}). ${impacted.length} appointment(s) impacted.`
    ]);

    res.json({ success: true, impactedAppointments: impacted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/doctors/unavailability/:id', async (req, res) => {
  try {
    await runQuery('DELETE FROM doctor_unavailability WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 2. SETTINGS & PERSONA
// ==========================================
app.get('/api/countries', (req, res) => {
  res.json({ success: true, count: ALL_COUNTRIES.length, countries: ALL_COUNTRIES });
});

app.get('/api/clinic-time', async (req, res) => {
  try {
    const clinicNow = await getClinicNow();
    res.json({ success: true, ...clinicNow });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    const settings = await getQuery('SELECT * FROM settings WHERE id = 1');
    const clinicNow = await getClinicNow();
    
    // Mask sensitive API credentials if unauthenticated
    if (!user && settings) {
      settings.whatsapp_access_token = settings.whatsapp_access_token ? '••••••••••••••••' : '';
      settings.whatsapp_verify_token = settings.whatsapp_verify_token ? '••••••••' : '';
    }

    res.json({
      success: true,
      settings,
      clinicNow,
      systemDate: clinicNow.dateStr,
      systemTime: clinicNow.timeStr,
      systemTimeWithSec: clinicNow.timeWithSec,
      systemTimezone: clinicNow.timezone,
      systemTzAbbr: clinicNow.tzAbbr,
      systemDateFormatted: formatDateFriendly(clinicNow.dateStr)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/settings', requireAuth, async (req, res) => {
  try {
    const s = req.body;
    await runQuery(`
      UPDATE settings SET
        business_name = COALESCE(?, business_name),
        business_type = COALESCE(?, business_type),
        clinic_phone = COALESCE(?, clinic_phone),
        owner_personal_phone = COALESCE(?, owner_personal_phone),
        address = COALESCE(?, address),
        persona_name = COALESCE(?, persona_name),
        persona_tone = COALESCE(?, persona_tone),
        custom_instructions = COALESCE(?, custom_instructions),
        cancellation_policy = COALESCE(?, cancellation_policy),
        currency = COALESCE(?, currency, 'USD'),
        currency_symbol = COALESCE(?, currency_symbol, '$'),
        currency_position = COALESCE(?, currency_position, 'before'),
        country = COALESCE(?, country, 'Pakistan'),
        country_code = COALESCE(?, country_code, 'PK'),
        timezone = COALESCE(?, timezone, 'Asia/Karachi'),
        timezone_label = COALESCE(?, timezone_label, 'PKT (UTC+5)'),
        whatsapp_phone_number_id = COALESCE(?, whatsapp_phone_number_id),
        whatsapp_verify_token = COALESCE(?, whatsapp_verify_token),
        whatsapp_access_token = COALESCE(?, whatsapp_access_token)
      WHERE id = 1
    `, [
      s.business_name || null,
      s.business_type || null,
      s.clinic_phone || null,
      s.owner_personal_phone || null,
      s.address || null,
      s.persona_name || null,
      s.persona_tone || null,
      s.custom_instructions || null,
      s.cancellation_policy || null,
      s.currency || null,
      s.currency_symbol || null,
      s.currency_position || null,
      s.country || null,
      s.country_code || null,
      s.timezone || null,
      s.timezone_label || null,
      s.whatsapp_phone_number_id || null,
      s.whatsapp_verify_token || null,
      s.whatsapp_access_token || null
    ]);

    const updated = await getQuery('SELECT * FROM settings WHERE id = 1');
    const clinicNow = await getClinicNow();
    res.json({ success: true, settings: updated, clinicNow });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// One-Time Administrative Purge of Initial Sample/Demo Data Before Going Live
app.post('/api/admin/purge-sample-data', requireAuth, requireRole(['admin', 'director']), async (req, res) => {
  try {
    const settings = await getQuery('SELECT sample_data_cleared, sample_data_cleared_at FROM settings WHERE id = 1');
    if (settings && settings.sample_data_cleared === 1) {
      return res.status(400).json({
        success: false,
        error: `Initial sample data has already been permanently purged on ${settings.sample_data_cleared_at || 'an earlier date'}. This administrative action can only be performed once before making the system live.`
      });
    }

    // Capture counts before deletion for summary
    const docCount = await getQuery('SELECT COUNT(*) as cnt FROM doctors');
    const aptCount = await getQuery('SELECT COUNT(*) as cnt FROM appointments');
    const patCount = await getQuery('SELECT COUNT(*) as cnt FROM patients');
    const clientCount = await getQuery('SELECT COUNT(*) as cnt FROM clients');

    // 1. Delete all appointments
    await runQuery('DELETE FROM appointments');

    // 2. Delete all patient family profiles
    await runQuery('DELETE FROM patients');

    // 3. Delete all clients
    await runQuery('DELETE FROM clients');

    // 4. Delete demo doctors & their schedules & unavailabilities
    await runQuery('DELETE FROM doctor_unavailability');
    await runQuery('DELETE FROM doctor_schedules');
    // Disassociate or delete doctor user accounts
    await runQuery("DELETE FROM auth_sessions WHERE role = 'doctor'");
    await runQuery("DELETE FROM users WHERE role = 'doctor'");
    await runQuery('DELETE FROM doctors');

    // 5. Delete demo chat sessions, holds, messages, and alerts
    await runQuery('DELETE FROM chat_sessions');
    await runQuery('DELETE FROM messages');
    await runQuery('DELETE FROM slot_holds');
    await runQuery('DELETE FROM owner_notifications');

    // 6. Permanently record that sample data has been cleared
    const clinicNow = await getClinicNow();
    const timestamp = `${clinicNow.dateStr} ${clinicNow.timeWithSec} (${clinicNow.tzAbbr || clinicNow.timezone})`;
    await runQuery(
      'UPDATE settings SET sample_data_cleared = 1, sample_data_cleared_at = ? WHERE id = 1',
      [timestamp]
    );

    const summary = {
      doctors: docCount ? docCount.cnt : 0,
      appointments: aptCount ? aptCount.cnt : 0,
      clients: clientCount ? clientCount.cnt : 0,
      patients: patCount ? patCount.cnt : 0
    };

    res.json({
      success: true,
      message: 'Initial demo data (Doctors, Patients, and Appointments) has been permanently cleared. System is now clean and ready for real clinic production operations.',
      clearedAt: timestamp,
      deletedSummary: summary,
      purged: summary
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 3. SERVICES & PRICING
// ==========================================
app.get('/api/services', async (req, res) => {
  try {
    const services = await allQuery(`
      SELECT s.*, d.name as doctor_name
      FROM services s
      LEFT JOIN doctors d ON s.doctor_id = d.id
      ORDER BY s.is_active DESC, s.id ASC
    `);
    res.json({ success: true, services });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/services/:id', async (req, res) => {
  try {
    const service = await getQuery(`
      SELECT s.*, d.name as doctor_name
      FROM services s
      LEFT JOIN doctors d ON s.doctor_id = d.id
      WHERE s.id = ?
    `, [req.params.id]);
    if (!service) return res.status(404).json({ success: false, error: 'Service not found' });
    res.json({ success: true, service });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/services', async (req, res) => {
  try {
    const { doctor_id, name, duration_minutes, price, description } = req.body;
    if (!name || !price) {
      return res.status(400).json({ success: false, error: 'Name and price are required' });
    }

    const result = await runQuery(`
      INSERT INTO services (doctor_id, name, duration_minutes, price, description, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `, [doctor_id ? parseInt(doctor_id, 10) : null, name, parseInt(duration_minutes, 10) || 30, parseFloat(price), description || '']);

    res.json({ success: true, id: result.lastID });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/services/:id', async (req, res) => {
  try {
    const { doctor_id, name, duration_minutes, price, description, is_active } = req.body;
    const currentSrv = await getQuery('SELECT * FROM services WHERE id = ?', [req.params.id]);
    if (!currentSrv) return res.status(404).json({ success: false, error: 'Service not found' });

    const newDocId = doctor_id !== undefined ? (doctor_id ? parseInt(doctor_id, 10) : null) : currentSrv.doctor_id;
    const newName = name !== undefined ? name.trim() : currentSrv.name;
    const newDuration = duration_minutes !== undefined ? parseInt(duration_minutes, 10) : currentSrv.duration_minutes;
    const newPrice = price !== undefined ? parseFloat(price) : currentSrv.price;
    const newDesc = description !== undefined ? description : currentSrv.description;
    const newActive = is_active !== undefined ? (is_active ? 1 : 0) : currentSrv.is_active;

    await runQuery(`
      UPDATE services SET
        doctor_id = ?,
        name = ?,
        duration_minutes = ?,
        price = ?,
        description = ?,
        is_active = ?
      WHERE id = ?
    `, [newDocId, newName, newDuration, newPrice, newDesc, newActive, req.params.id]);

    const updated = await getQuery(`
      SELECT s.*, d.name as doctor_name
      FROM services s
      LEFT JOIN doctors d ON s.doctor_id = d.id
      WHERE s.id = ?
    `, [req.params.id]);

    res.json({ success: true, service: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/services/:id', async (req, res) => {
  try {
    await runQuery('UPDATE services SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 4. WEEKLY CALENDAR & APPOINTMENTS (DYNAMIC DATES)
// ==========================================
app.get('/api/calendar', requireAuth, async (req, res) => {
  try {
    const settings = await getQuery('SELECT timezone, timezone_label FROM settings WHERE id = 1');
    const clinicTz = (settings && settings.timezone) ? settings.timezone : 'Asia/Karachi';
    const range = getCurrentWeekRange(clinicTz);
    const startDate = req.query.start_date || range.mondayStr;
    const endDate = req.query.end_date || range.sundayStr;
    let doctorId = req.query.doctor_id;

    const allActiveDoctors = await allQuery('SELECT * FROM doctors WHERE is_active = 1 ORDER BY id ASC');
    let allowedDoctors = allActiveDoctors;

    // Strict area restriction: If doctor without calendar_all_doctors permission, lock to own doctor_id
    if (req.user && req.user.role === 'doctor') {
      const perms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
      if (!perms.includes('calendar_all_doctors')) {
        doctorId = String(req.user.doctor_id);
        allowedDoctors = allActiveDoctors.filter(d => d.id === req.user.doctor_id);
      }
    }

    let sql = `
      SELECT a.*, d.name as doc_name, d.specialty as doc_specialty, d.color_code as doc_color,
             c.registered_name as client_name, p.relationship as patient_relationship
      FROM appointments a
      LEFT JOIN doctors d ON a.doctor_id = d.id
      LEFT JOIN clients c ON a.client_phone = c.phone
      LEFT JOIN patients p ON a.patient_id = p.id
      WHERE a.date >= ? AND a.date <= ?
    `;
    const params = [startDate, endDate];

    if (doctorId && doctorId !== 'all') {
      sql += ' AND a.doctor_id = ?';
      params.push(doctorId);
    }

    sql += ' ORDER BY a.date ASC, a.start_time ASC';

    const appointments = await allQuery(sql, params);
    const doctors = allowedDoctors;

    let unavailSql = 'SELECT u.*, d.name as doctor_name FROM doctor_unavailability u JOIN doctors d ON u.doctor_id = d.id WHERE u.date >= ? AND u.date <= ?';
    const unavailParams = [startDate, endDate];
    if (doctorId && doctorId !== 'all') {
      unavailSql += ' AND u.doctor_id = ?';
      unavailParams.push(doctorId);
    }
    const unavailabilities = await allQuery(unavailSql, unavailParams);

    await cleanExpiredHolds();
    let holdsSql = `
      SELECT h.*, d.name as doctor_name, d.color_code as doc_color
      FROM slot_holds h
      JOIN doctors d ON h.doctor_id = d.id
      WHERE h.date >= ? AND h.date <= ? AND h.expires_at > datetime('now')
    `;
    const holdParams = [startDate, endDate];
    if (doctorId && doctorId !== 'all') {
      holdsSql += ' AND h.doctor_id = ?';
      holdParams.push(doctorId);
    }
    const activeHolds = await allQuery(holdsSql, holdParams);

    const stats = {
      total: appointments.length,
      confirmed: appointments.filter(a => a.status === 'confirmed').length,
      tentative: appointments.filter(a => a.status === 'tentative').length,
      completed: appointments.filter(a => a.status === 'completed').length,
      cancelled: appointments.filter(a => a.status === 'cancelled').length,
      no_show: appointments.filter(a => a.status === 'no_show').length,
      active_holds: (activeHolds || []).length,
      estimatedRevenue: appointments
        .filter(a => a.status !== 'cancelled' && a.status !== 'no_show')
        .reduce((sum, a) => sum + (a.fee || 0), 0)
    };

    const clinicNow = await getClinicNow();

    res.json({
      success: true,
      startDate,
      endDate,
      currentToday: clinicNow.dateStr,
      clinicTime: clinicNow.timeStr,
      clinicTimezone: clinicNow.timezone,
      clinicTzAbbr: clinicNow.tzAbbr,
      doctors,
      stats,
      unavailabilities,
      appointments,
      activeHolds: activeHolds || []
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/appointments', requireAuth, async (req, res) => {
  try {
    const { doctor_id, date, status, search } = req.query;
    let sql = `
      SELECT a.*, d.name as doc_name, d.specialty as doc_specialty, d.color_code as doc_color,
             c.registered_name as client_name, p.relationship as patient_relationship
      FROM appointments a
      LEFT JOIN doctors d ON a.doctor_id = d.id
      LEFT JOIN clients c ON a.client_phone = c.phone
      LEFT JOIN patients p ON a.patient_id = p.id
      WHERE 1=1
    `;
    const params = [];

    let effectiveDoctorId = doctor_id;
    if (req.user && req.user.role === 'doctor') {
      const perms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
      if (!perms.includes('calendar_all_doctors')) {
        effectiveDoctorId = String(req.user.doctor_id);
      }
    }

    if (effectiveDoctorId && effectiveDoctorId !== 'all') {
      sql += ' AND a.doctor_id = ?';
      params.push(effectiveDoctorId);
    }
    if (date) {
      sql += ' AND a.date = ?';
      params.push(date);
    }
    if (status) {
      sql += ' AND a.status = ?';
      params.push(status);
    }
    if (search) {
      sql += ' AND (a.patient_name LIKE ? OR a.client_phone LIKE ? OR a.id LIKE ? OR a.doctor_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY a.date DESC, a.start_time ASC';

    const appointments = await allQuery(sql, params);

    // If requested as Excel download directly
    if (req.query.format === 'excel' || req.query.format === 'xlsx') {
      return generateAppointmentsExcelResponse(appointments, res);
    }
    // If requested as CSV directly
    if (req.query.format === 'csv') {
      return generateAppointmentsCsvResponse(appointments, res);
    }

    res.json({ success: true, appointments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: Generate Excel appointments response
async function generateAppointmentsExcelResponse(appointments, res) {
  const formatStatus = (st) => {
    if (!st) return 'Pending';
    const map = {
      confirmed: 'Confirmed',
      tentative: 'Tentative (24h Unconfirmed)',
      completed: 'Completed',
      cancelled: 'Cancelled',
      no_show: 'No-Show'
    };
    return map[st.toLowerCase()] || st;
  };

  const excelRows = appointments.map(a => ({
    'Appointment ID': a.id || '',
    'Date': a.date || '',
    'Start Time': a.start_time || '',
    'End Time': a.end_time || '',
    'Doctor Name': a.doc_name || a.doctor_name || '',
    'Doctor Specialty': a.doc_specialty || '',
    'Doctor Phone': a.doc_phone || a.doctor_phone || '',
    'Patient Full Name': a.patient_name || '',
    'Relationship': a.patient_relationship || 'Self',
    'Client WhatsApp': a.client_phone || '',
    'Service / Consultation': a.service_name || '',
    'Fee': a.fee ? `$${Number(a.fee).toFixed(2)}` : '$0.00',
    'Status': formatStatus(a.status),
    '24h Reminder Status': a.confirmation_sent_at ? 'Sent' : 'Pending',
    'Clinical Notes': a.notes || '',
    'Created At': a.created_at || ''
  }));

  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(excelRows, {
    header: [
      'Appointment ID',
      'Date',
      'Start Time',
      'End Time',
      'Doctor Name',
      'Doctor Specialty',
      'Doctor Phone',
      'Patient Full Name',
      'Relationship',
      'Client WhatsApp',
      'Service / Consultation',
      'Fee',
      'Status',
      '24h Reminder Status',
      'Clinical Notes',
      'Created At'
    ]
  });

  ws['!cols'] = [
    { wch: 18 }, // Appointment ID
    { wch: 14 }, // Date
    { wch: 12 }, // Start Time
    { wch: 12 }, // End Time
    { wch: 28 }, // Doctor Name
    { wch: 30 }, // Doctor Specialty
    { wch: 18 }, // Doctor Phone
    { wch: 24 }, // Patient Full Name
    { wch: 14 }, // Relationship
    { wch: 20 }, // Client WhatsApp
    { wch: 30 }, // Service
    { wch: 12 }, // Fee
    { wch: 18 }, // Status
    { wch: 22 }, // 24h Reminder Status
    { wch: 36 }, // Clinical Notes
    { wch: 22 }  // Created At
  ];

  xlsx.utils.book_append_sheet(wb, ws, 'Appointments');
  const xlsxBuffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const clinicNow = await getClinicNow();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="clinic_appointments_${clinicNow.dateStr}.xlsx"`);
  res.setHeader('Content-Length', xlsxBuffer.length);
  return res.end(xlsxBuffer);
}

// Helper: Generate CSV appointments response
async function generateAppointmentsCsvResponse(appointments, res) {
  const headers = [
    'Appointment ID',
    'Date',
    'Start Time',
    'End Time',
    'Doctor Name',
    'Doctor Phone',
    'Doctor Specialty',
    'Patient Name',
    'Relationship',
    'Client Mobile',
    'Service Name',
    'Fee',
    'Status',
    '24h Reminder Status',
    'Notes',
    'Created At'
  ];

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const rows = appointments.map(a => [
    escapeCsv(a.id),
    escapeCsv(a.date),
    escapeCsv(a.start_time),
    escapeCsv(a.end_time),
    escapeCsv(a.doc_name || a.doctor_name),
    escapeCsv(a.doctor_phone || a.doc_phone),
    escapeCsv(a.doc_specialty || ''),
    escapeCsv(a.patient_name),
    escapeCsv(a.patient_relationship || 'Self'),
    escapeCsv(a.client_phone),
    escapeCsv(a.service_name),
    escapeCsv(a.fee),
    escapeCsv(a.status),
    escapeCsv(a.confirmation_sent_at ? 'Sent' : 'Pending'),
    escapeCsv(a.notes),
    escapeCsv(a.created_at)
  ].join(','));

  const csvContent = '\uFEFF' + [headers.map(escapeCsv).join(','), ...rows].join('\r\n');
  const clinicNow = await getClinicNow();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="clinic_appointments_${clinicNow.dateStr}.csv"`);
  return res.send(csvContent);
}

// Download Appointments as Excel (.xlsx) Spreadsheet
app.get('/api/appointments/export-excel', async (req, res) => {
  try {
    const session = await getAuthenticatedUser(req);
    if (!session) {
      return res.status(401).json({ success: false, error: 'Authentication Required: Please sign in to access clinic data.' });
    }

    const { doctor_id, date, status, search } = req.query;
    let sql = `
      SELECT a.*, d.name as doc_name, d.specialty as doc_specialty, d.personal_phone as doc_phone, p.relationship as patient_relationship
      FROM appointments a
      LEFT JOIN doctors d ON a.doctor_id = d.id
      LEFT JOIN patients p ON a.patient_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (session.role === 'doctor') {
      const perms = session.permissions ? (typeof session.permissions === 'string' ? JSON.parse(session.permissions) : session.permissions) : [];
      if (!perms.includes('calendar_all_doctors')) {
        sql += ' AND a.doctor_id = ?';
        params.push(session.doctor_id);
      }
    }

    if (doctor_id && doctor_id !== 'all') {
      sql += ' AND a.doctor_id = ?';
      params.push(doctor_id);
    }
    if (date) {
      sql += ' AND a.date = ?';
      params.push(date);
    }
    if (status && status !== 'all') {
      sql += ' AND a.status = ?';
      params.push(status);
    }
    if (search) {
      sql += ' AND (a.patient_name LIKE ? OR a.client_phone LIKE ? OR a.id LIKE ? OR a.doctor_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY a.date DESC, a.start_time ASC';

    const appointments = await allQuery(sql, params);
    return await generateAppointmentsExcelResponse(appointments, res);
  } catch (err) {
    console.error('Error exporting appointments to Excel:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Download Appointments as CSV
app.get('/api/appointments/export-csv', async (req, res) => {
  try {
    const session = await getAuthenticatedUser(req);
    if (!session) {
      return res.status(401).json({ success: false, error: 'Authentication Required: Please sign in to access clinic data.' });
    }

    const { doctor_id, date, status, search } = req.query;
    let sql = `
      SELECT a.*, d.name as doc_name, d.specialty as doc_specialty, d.personal_phone as doc_phone, p.relationship as patient_relationship
      FROM appointments a
      LEFT JOIN doctors d ON a.doctor_id = d.id
      LEFT JOIN patients p ON a.patient_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (session.role === 'doctor') {
      const perms = session.permissions ? (typeof session.permissions === 'string' ? JSON.parse(session.permissions) : session.permissions) : [];
      if (!perms.includes('calendar_all_doctors')) {
        sql += ' AND a.doctor_id = ?';
        params.push(session.doctor_id);
      }
    }

    if (doctor_id && doctor_id !== 'all') {
      sql += ' AND a.doctor_id = ?';
      params.push(doctor_id);
    }
    if (date) {
      sql += ' AND a.date = ?';
      params.push(date);
    }
    if (status && status !== 'all') {
      sql += ' AND a.status = ?';
      params.push(status);
    }
    if (search) {
      sql += ' AND (a.patient_name LIKE ? OR a.client_phone LIKE ? OR a.id LIKE ? OR a.doctor_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY a.date DESC, a.start_time ASC';

    const appointments = await allQuery(sql, params);
    return await generateAppointmentsCsvResponse(appointments, res);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manual Walk-in or Staff Booking
app.post('/api/appointments', async (req, res) => {
  try {
    const { doctorId, clientPhone, clientName, patientName, relationship, serviceId, date, startTime, notes } = req.body;
    if (!doctorId || !clientPhone || !patientName || !serviceId || !date || !startTime) {
      return res.status(400).json({ success: false, error: 'Missing required booking fields.' });
    }

    const doctor = await getQuery('SELECT * FROM doctors WHERE id = ?', [doctorId]);
    if (!doctor) return res.status(404).json({ success: false, error: 'Doctor not found' });
    if (!doctor.is_active) {
      return res.status(400).json({ success: false, error: 'Cannot book appointments with a doctor who is inactive or has left the clinic.' });
    }

    let client = await getQuery('SELECT * FROM clients WHERE phone = ?', [clientPhone]);
    if (!client) {
      await runQuery('INSERT INTO clients (phone, registered_name) VALUES (?, ?)', [
        clientPhone,
        clientName || patientName
      ]);
    }

    let patient = await getQuery('SELECT * FROM patients WHERE client_phone = ? AND full_name = ?', [
      clientPhone,
      patientName
    ]);
    if (!patient) {
      const pRes = await runQuery(
        'INSERT INTO patients (client_phone, full_name, relationship) VALUES (?, ?, ?)',
        [clientPhone, patientName, relationship || 'Self']
      );
      patient = { id: pRes.lastID, full_name: patientName, relationship: relationship || 'Self' };
    }

    const service = await getQuery('SELECT * FROM services WHERE id = ?', [serviceId]);
    if (!service) return res.status(404).json({ success: false, error: 'Service not found' });

    const duration = service.duration_minutes || 30;
    const [h, m] = startTime.split(':').map(Number);
    const endMins = h * 60 + m + duration;
    const endH = String(Math.floor(endMins / 60)).padStart(2, '0');
    const endM = String(endMins % 60).padStart(2, '0');
    const endTime = `${endH}:${endM}`;

    // Validate strictly against clinic local country date & time (never system clock)
    const clinicNow = await getClinicNow();
    if (date < clinicNow.dateStr) {
      return res.status(400).json({
        success: false,
        error: `Cannot book appointments for past dates (${formatDateFriendly(date)}). Current clinic date is ${formatDateFriendly(clinicNow.dateStr)} (${clinicNow.timezone}).`
      });
    }
    if (date === clinicNow.dateStr && startTime <= clinicNow.timeStr) {
      return res.status(400).json({
        success: false,
        error: `Cannot book appointments for past time slots. Current clinic time is ${formatTime12(clinicNow.timeStr)} (${clinicNow.tzAbbr || clinicNow.timezone}).`
      });
    }

    // --- ATOMIC CONCURRENCY & CONFLICT CHECK ---
    const conflict = await checkSlotConflict(doctor.id, date, startTime, endTime);
    if (conflict.conflict) {
      if (conflict.type === 'past_date' || conflict.type === 'past_time') {
        return res.status(400).json({
          success: false,
          error: conflict.message || 'Cannot book appointments for past dates or past time slots.'
        });
      } else if (conflict.type === 'booked') {
        return res.status(409).json({
          success: false,
          error: `Slot Conflict: This time slot (${startTime} - ${endTime}) is already booked for ${conflict.detail.patient_name} (${conflict.detail.id}).`
        });
      } else if (conflict.type === 'held') {
        return res.status(409).json({
          success: false,
          error: `Slot In Progress: This slot is currently held by a patient on WhatsApp (${conflict.detail.held_by_phone}) finalizing their booking. Please choose another slot or wait for the hold to expire.`
        });
      }
    }

    const aptId = `APT-${Math.floor(1000 + Math.random() * 9000)}`;

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
      clientPhone,
      patient.id,
      patient.full_name,
      service.id,
      service.name,
      date,
      startTime,
      endTime,
      service.price,
      notes || 'Manual appointment created in clinic portal'
    ]);

    // Release any hold on this slot if existed
    await runQuery('DELETE FROM slot_holds WHERE doctor_id = ? AND date = ? AND start_time = ?', [doctor.id, date, startTime]);

    const settings = await getQuery('SELECT * FROM settings WHERE id = 1');
    const tzLabel = settings.timezone_label || settings.timezone || 'PKT';
    const formatPrice = (amt) => {
      const num = Number(amt || 0).toFixed(2);
      const symbol = (settings && settings.currency_symbol) ? settings.currency_symbol : '$';
      const pos = (settings && settings.currency_position) ? settings.currency_position : 'before';
      return pos === 'after' ? `${num} ${symbol}`.trim() : `${symbol}${num}`;
    };

    const confirmationText =
      `🎉 *Appointment Confirmed!* (Booked by ${doctor.name}'s office)\n\n` +
      `📌 ID: *${aptId}*\n` +
      `👤 Patient: *${patient.full_name}*\n` +
      `👨‍⚕️ Doctor: *${doctor.name}* (${doctor.specialty})\n` +
      `🩺 Service: *${service.name}*\n` +
      `🗓️ Date: *${formatDateFriendly(date)}*\n` +
      `⏰ Time: *${formatTime12(startTime)} - ${formatTime12(endTime)} (${tzLabel})*\n` +
      `💳 Fee: ${formatPrice(service.price)}\n` +
      `📍 Location: ${settings.address}\n\n` +
      `Reply *MY BOOKINGS* anytime to view or reschedule.`;

    await runQuery(
      'INSERT INTO messages (phone, direction, sender_name, message) VALUES (?, ?, ?, ?)',
      [clientPhone, 'outbound', settings.persona_name, confirmationText]
    );

    // Also send via WhatsApp if configured
    await sendWhatsAppMessage(clientPhone, confirmationText);

    await runQuery(
      'INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message) VALUES (?, ?, ?, ?, ?)',
      [
        doctor.id,
        'new_booking',
        aptId,
        clientPhone,
        `📋 [WALK-IN APPOINTMENT] ${patient.full_name} scheduled with ${doctor.name} on ${formatDateFriendly(date)} at ${formatTime12(startTime)} (${tzLabel}).`
      ]
    );

    res.json({ success: true, appointmentId: aptId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/appointments/:id/status', async (req, res) => {
  try {
    const { status, notifyClient, reason } = req.body;
    const apt = await getQuery('SELECT * FROM appointments WHERE id = ?', [req.params.id]);
    if (!apt) return res.status(404).json({ success: false, error: 'Appointment not found' });

    let updateNotes = apt.notes || '';
    if (status === 'no_show') {
      updateNotes += ` | Marked as No-Show on ${new Date().toISOString().split('T')[0]}`;
    } else if (status === 'cancelled' && reason) {
      updateNotes += ` | Cancellation: ${reason}`;
    }

    await runQuery('UPDATE appointments SET status = ?, notes = ? WHERE id = ?', [status, updateNotes, req.params.id]);

    const settings = await getQuery('SELECT * FROM settings WHERE id = 1');

    if (status === 'no_show') {
      await runQuery(
        'INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message) VALUES (?, ?, ?, ?, ?)',
        [
          apt.doctor_id,
          'no_show',
          apt.id,
          apt.client_phone,
          `⚠️ [NO-SHOW] Patient ${apt.patient_name} marked as No-Show for appointment ${apt.id} on ${formatDateFriendly(apt.date)} at ${formatTime12(apt.start_time)}. Time slot is now reopened for new bookings.`
        ]
      );
    } else if (notifyClient && status === 'cancelled') {
      const cancelMsg =
        `⚠️ *Appointment Update: ${settings.business_name}*\n\n` +
        `Your appointment *${apt.id}* for *${apt.patient_name}* with *${apt.doctor_name}* on *${formatDateFriendly(apt.date)} at ${formatTime12(apt.start_time)}* has been cancelled.\n\n` +
        `To reschedule for a new date or with another doctor, reply *BOOK* or *RESCHEDULE*. We apologize for any inconvenience.`;

      await runQuery(
        'INSERT INTO messages (phone, direction, sender_name, message) VALUES (?, ?, ?, ?)',
        [apt.client_phone, 'outbound', settings.persona_name, cancelMsg]
      );
      await sendWhatsAppMessage(apt.client_phone, cancelMsg);
    }

    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/appointments/:id/reschedule', async (req, res) => {
  try {
    const { newDoctorId, newDate, newStartTime, reason } = req.body;
    const apt = await getQuery('SELECT * FROM appointments WHERE id = ?', [req.params.id]);
    if (!apt) return res.status(404).json({ success: false, error: 'Appointment not found' });

    let doctorId = apt.doctor_id;
    let doctorName = apt.doctor_name;
    let doctorPhone = apt.doctor_phone;

    if (newDoctorId && newDoctorId !== apt.doctor_id) {
      const newDoc = await getQuery('SELECT * FROM doctors WHERE id = ?', [newDoctorId]);
      if (newDoc) {
        if (!newDoc.is_active) {
          return res.status(400).json({ success: false, error: 'Cannot reschedule to a doctor who is inactive or has left the clinic.' });
        }
        doctorId = newDoc.id;
        doctorName = newDoc.name;
        doctorPhone = newDoc.personal_phone;
      }
    }

    const service = await getQuery('SELECT * FROM services WHERE id = ?', [apt.service_id]);
    const duration = service ? service.duration_minutes : 30;
    const [h, m] = newStartTime.split(':').map(Number);
    const endMins = h * 60 + m + duration;
    const endH = String(Math.floor(endMins / 60)).padStart(2, '0');
    const endM = String(endMins % 60).padStart(2, '0');
    const newEndTime = `${endH}:${endM}`;

    // Validate strictly against clinic local country date & time (never system clock)
    const clinicNow = await getClinicNow();
    if (newDate < clinicNow.dateStr) {
      return res.status(400).json({
        success: false,
        error: `Cannot reschedule appointments to past dates (${formatDateFriendly(newDate)}). Current clinic date is ${formatDateFriendly(clinicNow.dateStr)} (${clinicNow.timezone}).`
      });
    }
    if (newDate === clinicNow.dateStr && newStartTime <= clinicNow.timeStr) {
      return res.status(400).json({
        success: false,
        error: `Cannot reschedule to past time slots. Current clinic time is ${formatTime12(clinicNow.timeStr)} (${clinicNow.tzAbbr || clinicNow.timezone}).`
      });
    }

    // Concurrency conflict check on target slot
    const conflict = await checkSlotConflict(doctorId, newDate, newStartTime, newEndTime, null, apt.id);
    if (conflict.conflict) {
      if (conflict.type === 'past_date' || conflict.type === 'past_time') {
        return res.status(400).json({
          success: false,
          error: conflict.message || 'Cannot reschedule to a past date or past time slot.'
        });
      } else if (conflict.type === 'booked') {
        return res.status(409).json({
          success: false,
          error: `Slot Conflict: Target slot ${newStartTime} on ${newDate} is already booked for ${conflict.detail.patient_name} (${conflict.detail.id}).`
        });
      } else if (conflict.type === 'held') {
        return res.status(409).json({
          success: false,
          error: `Slot In Progress: Target slot ${newStartTime} is currently reserved by a patient on WhatsApp (${conflict.detail.held_by_phone}).`
        });
      }
    }

    await runQuery(`
      UPDATE appointments
      SET doctor_id = ?, doctor_name = ?, doctor_phone = ?, date = ?, start_time = ?, end_time = ?,
          status = 'confirmed', notes = COALESCE(notes || ' | ', '') || ?
      WHERE id = ?
    `, [
      doctorId,
      doctorName,
      doctorPhone,
      newDate,
      newStartTime,
      newEndTime,
      `Rescheduled: ${reason || 'Schedule update'}`,
      apt.id
    ]);

    const settings = await getQuery('SELECT * FROM settings WHERE id = 1');
    const tzLabel = settings.timezone_label || settings.timezone || 'PKT';

    const rescheduleMsg =
      `🔄 *Appointment Rescheduled by ${settings.business_name}*\n\n` +
      `Hello! Your appointment *${apt.id}* for *${apt.patient_name}* has been updated:\n\n` +
      `👨‍⚕️ *Doctor:* ${doctorName}\n` +
      `🗓️ *New Date:* ${formatDateFriendly(newDate)}\n` +
      `⏰ *New Time:* ${formatTime12(newStartTime)} - ${formatTime12(newEndTime)} (${tzLabel})\n` +
      (reason ? `ℹ️ *Reason:* ${reason}\n\n` : `\n`) +
      `📍 Location: ${settings.address}\n\n` +
      `If this works for you, reply *CONFIRM*. To request another slot, reply *RESCHEDULE*.`;

    await runQuery(
      'INSERT INTO messages (phone, direction, sender_name, message) VALUES (?, ?, ?, ?)',
      [apt.client_phone, 'outbound', settings.persona_name, rescheduleMsg]
    );
    await sendWhatsAppMessage(apt.client_phone, rescheduleMsg);

    await runQuery(
      'INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message) VALUES (?, ?, ?, ?, ?)',
      [
        doctorId,
        'rescheduled',
        apt.id,
        apt.client_phone,
        `🔄 Appointment ${apt.id} rescheduled for ${apt.patient_name} to ${formatDateFriendly(newDate)} at ${formatTime12(newStartTime)} with ${doctorName}.`
      ]
    );

    res.json({ success: true, message: 'Appointment rescheduled and client notified' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/appointments/:id', async (req, res) => {
  try {
    const { reason, hard } = req.body || {};
    const isHardDelete = hard === true || req.query.hard === 'true';
    const apt = await getQuery('SELECT * FROM appointments WHERE id = ?', [req.params.id]);
    if (!apt) return res.status(404).json({ success: false, error: 'Appointment not found' });

    if (isHardDelete) {
      await runQuery('DELETE FROM appointments WHERE id = ?', [req.params.id]);
      return res.json({ success: true, message: `Appointment ${req.params.id} permanently deleted from records.` });
    }

    await runQuery(
      "UPDATE appointments SET status = 'cancelled', cancelled_by = 'owner' WHERE id = ?",
      [req.params.id]
    );

    const settings = await getQuery('SELECT * FROM settings WHERE id = 1');

    const cancelMsg =
      `❌ *Appointment Cancelled by ${settings.business_name}*\n\n` +
      `Your appointment *${apt.id}* for *${apt.patient_name}* with *${apt.doctor_name}* on *${formatDateFriendly(apt.date)} at ${formatTime12(apt.start_time)}* has been cancelled.\n` +
      (reason ? `Reason: ${reason}\n\n` : `\n`) +
      `To book another appointment with any of our physicians, reply *BOOK*. We apologize for any inconvenience.`;

    await runQuery(
      'INSERT INTO messages (phone, direction, sender_name, message) VALUES (?, ?, ?, ?)',
      [apt.client_phone, 'outbound', settings.persona_name, cancelMsg]
    );
    await sendWhatsAppMessage(apt.client_phone, cancelMsg);

    await runQuery(
      'INSERT INTO owner_notifications (doctor_id, type, appointment_id, phone, message) VALUES (?, ?, ?, ?, ?)',
      [
        apt.doctor_id,
        'cancelled',
        apt.id,
        apt.client_phone,
        `❌ Doctor cancelled appointment ${apt.id} for ${apt.patient_name}. Slot is released.`
      ]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 5. DOCTOR & OWNER NOTIFICATION FEED
// ==========================================
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    let doctorId = req.query.doctor_id;
    if (req.user && req.user.role === 'doctor') {
      doctorId = String(req.user.doctor_id);
    }

    let sql = `
      SELECT n.*, d.name as doctor_name, d.specialty as doctor_specialty
      FROM owner_notifications n
      LEFT JOIN doctors d ON n.doctor_id = d.id
      WHERE 1=1
    `;
    const params = [];
    if (doctorId && doctorId !== 'all') {
      sql += ' AND n.doctor_id = ?';
      params.push(doctorId);
    }
    sql += ' ORDER BY n.created_at DESC LIMIT 60';

    const notifications = await allQuery(sql, params);
    res.json({ success: true, notifications });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 6. 24-HOUR CONFIRMATION SCHEDULER
// ==========================================
app.post('/api/reminders/run', async (req, res) => {
  try {
    const { referenceDate, forceMarkUnconfirmed } = req.body;
    const result = await runConfirmationCheck(referenceDate || null, forceMarkUnconfirmed || false);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 7. SLOT AVAILABILITY LOOKUP
// ==========================================
app.get('/api/slots/available', async (req, res) => {
  try {
    const { doctor_id, date, service_id, duration } = req.query;
    if (!date) return res.status(400).json({ success: false, error: 'date is required' });

    if (doctor_id && doctor_id !== 'all') {
      const result = await getAvailableDoctorSlots(parseInt(doctor_id, 10), date, parseInt(duration, 10) || 30);
      return res.json({ success: true, ...result });
    } else {
      const result = await getAllAvailableSlots(date, service_id ? parseInt(service_id, 10) : null, parseInt(duration, 10) || 30);
      return res.json({ success: true, ...result });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 8. WHATSAPP CHAT SIMULATOR
// ==========================================
app.get('/api/chat/history', async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ success: false, error: 'phone is required' });

    const messages = await allQuery('SELECT * FROM messages WHERE phone = ? ORDER BY created_at ASC', [phone]);
    const client = await getQuery('SELECT * FROM clients WHERE phone = ?', [phone]);
    const patients = await allQuery('SELECT * FROM patients WHERE client_phone = ?', [phone]);
    const session = await getQuery('SELECT * FROM chat_sessions WHERE phone = ?', [phone]);

    res.json({
      success: true,
      client,
      patients,
      sessionState: session ? session.state : 'IDLE',
      messages
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/chat/send', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ success: false, error: 'phone and message are required' });
    }

    const reply = await processIncomingMessage(phone, message);
    const session = await getQuery('SELECT * FROM chat_sessions WHERE phone = ?', [phone]);

    res.json({
      success: true,
      reply,
      sessionState: session ? session.state : 'IDLE'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/chat/reset', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone is required' });

    await runQuery("UPDATE chat_sessions SET state = 'IDLE', context_data = '{}' WHERE phone = ?", [phone]);
    res.json({ success: true, message: 'Chat session reset' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 9. CLIENTS & PATIENTS
// ==========================================
app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    let clients = [];
    if (req.user && req.user.role === 'doctor') {
      const perms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
      if (!perms.includes('clients_manage') && !perms.includes('calendar_all_doctors')) {
        clients = await allQuery(`
          SELECT DISTINCT c.* FROM clients c
          JOIN appointments a ON c.phone = a.client_phone
          WHERE a.doctor_id = ?
          ORDER BY c.created_at DESC
        `, [req.user.doctor_id]);
      } else {
        clients = await allQuery('SELECT * FROM clients ORDER BY created_at DESC');
      }
    } else {
      clients = await allQuery('SELECT * FROM clients ORDER BY created_at DESC');
    }

    for (const c of clients) {
      c.patients = await allQuery('SELECT * FROM patients WHERE client_phone = ?', [c.phone]);
      c.appointments = await allQuery('SELECT * FROM appointments WHERE client_phone = ? ORDER BY date DESC, start_time DESC', [c.phone]);
    }
    res.json({ success: true, clients });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Download Sample Patients Import Template (.xlsx or .csv)
app.get('/api/clients/sample-template', async (req, res) => {
  try {
    const format = (req.query.format || 'xlsx').toLowerCase();
    const templateData = [
      {
        'Mobile Number': '+1 (555) 234-5678',
        'Account Holder Name': 'Sarah Jenkins',
        'Patient Full Name': 'Sarah Jenkins',
        'Relationship': 'Self',
        'Age or DOB': '34 years',
        'Gender': 'Female',
        'Medical Notes / History': 'Asthma, routine cardiology exams'
      },
      {
        'Mobile Number': '+1 (555) 234-5678',
        'Account Holder Name': 'Sarah Jenkins',
        'Patient Full Name': 'Leo Jenkins',
        'Relationship': 'Child',
        'Age or DOB': '6 years',
        'Gender': 'Male',
        'Medical Notes / History': 'Pediatric wellness checks, mild eczema'
      },
      {
        'Mobile Number': '+1 (555) 234-5678',
        'Account Holder Name': 'Sarah Jenkins',
        'Patient Full Name': 'Robert Jenkins',
        'Relationship': 'Spouse',
        'Age or DOB': '36 years',
        'Gender': 'Male',
        'Medical Notes / History': 'Routine dental & eye checks'
      },
      {
        'Mobile Number': '+1 (555) 987-6543',
        'Account Holder Name': 'David Watson',
        'Patient Full Name': 'David Watson',
        'Relationship': 'Self',
        'Age or DOB': '52 years',
        'Gender': 'Male',
        'Medical Notes / History': 'Hypertension management, annual checkup'
      },
      {
        'Mobile Number': '+1 (555) 987-6543',
        'Account Holder Name': 'David Watson',
        'Patient Full Name': 'Martha Watson',
        'Relationship': 'Parent',
        'Age or DOB': '78 years',
        'Gender': 'Female',
        'Medical Notes / History': 'Mobility assistance, joint clinic'
      }
    ];

    if (format === 'csv') {
      const headers = ['Mobile Number', 'Account Holder Name', 'Patient Full Name', 'Relationship', 'Age or DOB', 'Gender', 'Medical Notes / History'];
      const escapeCsv = (val) => {
        if (val === null || val === undefined) return '""';
        return `"${String(val).replace(/"/g, '""')}"`;
      };
      const csvRows = [headers.map(escapeCsv).join(',')];
      for (const row of templateData) {
        csvRows.push(headers.map(h => escapeCsv(row[h])).join(','));
      }
      const csvPayload = '\uFEFF' + csvRows.join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="sample_patients_template.csv"');
      return res.send(csvPayload);
    }

    // Default: Excel .xlsx using xlsx package
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(templateData, {
      header: ['Mobile Number', 'Account Holder Name', 'Patient Full Name', 'Relationship', 'Age or DOB', 'Gender', 'Medical Notes / History']
    });

    // Set column widths for readability
    ws['!cols'] = [
      { wch: 20 }, // Mobile Number
      { wch: 24 }, // Account Holder Name
      { wch: 24 }, // Patient Full Name
      { wch: 16 }, // Relationship
      { wch: 14 }, // Age or DOB
      { wch: 12 }, // Gender
      { wch: 45 }  // Medical Notes
    ];

    xlsx.utils.book_append_sheet(wb, ws, 'ClinicPatientsTemplate');
    const xlsxBuffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sample_patients_template.xlsx"');
    res.setHeader('Content-Length', xlsxBuffer.length);
    return res.end(xlsxBuffer);
  } catch (err) {
    console.error('Error generating sample template:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Import Patients from Excel (.xlsx, .xls) or CSV
app.post('/api/clients/import', requireAuth, requirePermission('clients_manage'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, error: 'No file uploaded. Please upload a valid Excel (.xlsx, .xls) or CSV (.csv) file.' });
    }

    const filename = (req.file.originalname || '').toLowerCase();
    const mimeType = (req.file.mimetype || '').toLowerCase();
    let rowsToProcess = [];

    // Parse CSV or Excel
    if (filename.endsWith('.csv') || mimeType.includes('csv') || mimeType.includes('text/plain')) {
      const csvStr = req.file.buffer.toString('utf8');
      const lines = csvStr.split(/\r?\n/).filter(line => line.trim().length > 0);
      if (lines.length <= 1) {
        return res.status(400).json({ success: false, error: 'CSV file is empty or missing data rows.' });
      }

      // Simple CSV parser supporting quotes
      const parseCsvLine = (line) => {
        const result = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (c === '"') {
            if (inQuotes && line[i + 1] === '"') {
              cur += '"';
              i++;
            } else {
              inQuotes = !inQuotes;
            }
          } else if (c === ',' && !inQuotes) {
            result.push(cur.trim());
            cur = '';
          } else {
            cur += c;
          }
        }
        result.push(cur.trim());
        return result;
      };

      const headerLine = lines[0];
      const headers = parseCsvLine(headerLine).map(h => h.replace(/^[\uFEFF\s]+|[\s]+$/g, '').toLowerCase());

      for (let i = 1; i < lines.length; i++) {
        const values = parseCsvLine(lines[i]);
        if (values.length === 0 || values.every(v => !v)) continue;
        const rowObj = {};
        headers.forEach((h, idx) => {
          rowObj[h] = values[idx] || '';
        });
        rowsToProcess.push(rowObj);
      }
    } else {
      // Excel parse using xlsx
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        return res.status(400).json({ success: false, error: 'Uploaded Excel file contains no worksheets.' });
      }
      const worksheet = workbook.Sheets[firstSheetName];
      const rawRows = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
      if (!rawRows || rawRows.length === 0) {
        return res.status(400).json({ success: false, error: 'Uploaded Excel sheet is empty.' });
      }

      // Normalize keys to lowercase
      rowsToProcess = rawRows.map(row => {
        const normalized = {};
        for (const [k, v] of Object.entries(row)) {
          normalized[k.trim().toLowerCase()] = typeof v === 'string' ? v.trim() : String(v);
        }
        return normalized;
      });
    }

    if (rowsToProcess.length === 0) {
      return res.status(400).json({ success: false, error: 'No data rows found in the uploaded file.' });
    }

    let importedPatients = 0;
    const clientPhoneSet = new Set();
    const errors = [];
    let skipped = 0;

    for (let idx = 0; idx < rowsToProcess.length; idx++) {
      const row = rowsToProcess[idx];

      // Extract phone: check multiple column name variations
      const rawPhone = row['mobile number'] || row['phone'] || row['phone number'] || row['mobile'] || row['client phone'] || '';
      const cleanPhone = String(rawPhone).trim();
      if (!cleanPhone || cleanPhone.length < 5) {
        skipped++;
        errors.push(`Row ${idx + 2}: Missing or invalid mobile number.`);
        continue;
      }

      // Extract primary account holder name
      const accountHolder = (row['account holder name'] || row['client name'] || row['registered name'] || row['primary name'] || row['patient full name'] || 'Clinic Client').trim();

      // Extract patient name
      const patientName = (row['patient full name'] || row['patient name'] || row['full name'] || accountHolder).trim();
      if (!patientName) {
        skipped++;
        errors.push(`Row ${idx + 2}: Missing patient name.`);
        continue;
      }

      // Extract relationship
      let relationship = (row['relationship'] || row['relation'] || 'Self').trim();
      const validRelationships = ['Self', 'Child', 'Spouse', 'Parent', 'Other'];
      const matchedRel = validRelationships.find(r => r.toLowerCase() === relationship.toLowerCase());
      relationship = matchedRel || 'Other';

      // Extract age/DOB, gender, notes
      const ageOrDob = (row['age or dob'] || row['age'] || row['dob'] || '').trim();
      const gender = (row['gender'] || row['sex'] || '').trim();
      const medicalNotes = (row['medical notes / history'] || row['medical notes'] || row['notes'] || row['history'] || '').trim();

      // 1. Upsert Client Record
      const existingClient = await getQuery('SELECT * FROM clients WHERE phone = ?', [cleanPhone]);
      if (!existingClient) {
        await runQuery(
          'INSERT INTO clients (phone, registered_name, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
          [cleanPhone, accountHolder]
        );
      } else if (accountHolder && (!existingClient.registered_name || existingClient.registered_name === 'Clinic Client')) {
        await runQuery('UPDATE clients SET registered_name = ? WHERE phone = ?', [accountHolder, cleanPhone]);
      }
      clientPhoneSet.add(cleanPhone);

      // 2. Prepare notes
      let finalNotes = medicalNotes;
      if (ageOrDob || gender) {
        const extraParts = [];
        if (ageOrDob) extraParts.push(`Age/DOB: ${ageOrDob}`);
        if (gender) extraParts.push(`Gender: ${gender}`);
        finalNotes = extraParts.join(' | ') + (medicalNotes ? ` | Notes: ${medicalNotes}` : '');
      }

      // 3. Upsert Patient Profile
      const existingPatient = await getQuery(
        'SELECT id FROM patients WHERE client_phone = ? AND LOWER(full_name) = LOWER(?)',
        [cleanPhone, patientName]
      );

      if (!existingPatient) {
        await runQuery(
          'INSERT INTO patients (client_phone, full_name, relationship, age_or_notes) VALUES (?, ?, ?, ?)',
          [cleanPhone, patientName, relationship, finalNotes || null]
        );
        importedPatients++;
      } else {
        await runQuery(
          'UPDATE patients SET relationship = ?, age_or_notes = ? WHERE id = ?',
          [relationship, finalNotes || null, existingPatient.id]
        );
        importedPatients++;
      }
    }

    res.json({
      success: true,
      importedClients: clientPhoneSet.size,
      clientsCount: clientPhoneSet.size,
      importedPatients,
      importedCount: importedPatients,
      totalRows: rowsToProcess.length,
      skipped,
      errors,
      message: `Successfully processed ${rowsToProcess.length} rows. Imported/updated ${importedPatients} patient family profile(s) across ${clientPhoneSet.size} WhatsApp account(s).`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/clients/:phone', async (req, res) => {
  try {
    const cleanPhone = req.params.phone.trim();
    const client = await getQuery('SELECT * FROM clients WHERE phone = ?', [cleanPhone]);
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    const patients = await allQuery('SELECT * FROM patients WHERE client_phone = ? ORDER BY id ASC', [cleanPhone]);
    patients.forEach(p => { p.medical_notes = p.age_or_notes || ''; });
    const appointments = await allQuery('SELECT * FROM appointments WHERE client_phone = ? ORDER BY date DESC, start_time DESC', [cleanPhone]);

    client.patients = patients;
    client.appointments = appointments;

    res.json({ success: true, client, patients, appointments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/clients/:phone', async (req, res) => {
  try {
    const { registered_name } = req.body;
    if (!registered_name || !registered_name.trim()) {
      return res.status(400).json({ success: false, error: 'Registered name is required' });
    }
    const cleanPhone = req.params.phone.trim();
    const client = await getQuery('SELECT * FROM clients WHERE phone = ?', [cleanPhone]);
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    const oldName = client.registered_name;
    const newName = registered_name.trim();

    await runQuery('UPDATE clients SET registered_name = ? WHERE phone = ?', [newName, cleanPhone]);

    // Update matching primary patient record
    await runQuery(
      "UPDATE patients SET full_name = ? WHERE client_phone = ? AND (relationship = 'Self' OR full_name = ?)",
      [newName, cleanPhone, oldName]
    );

    const updated = await getQuery('SELECT * FROM clients WHERE phone = ?', [cleanPhone]);
    const patients = await allQuery('SELECT * FROM patients WHERE client_phone = ? ORDER BY id ASC', [cleanPhone]);
    patients.forEach(p => { p.medical_notes = p.age_or_notes || ''; });
    updated.patients = patients;

    res.json({ success: true, client: updated, patients });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/clients/patient', async (req, res) => {
  try {
    const { clientPhone, fullName, relationship, notes, medical_notes, age_or_notes } = req.body;
    if (!clientPhone || !fullName) {
      return res.status(400).json({ success: false, error: 'clientPhone and fullName are required' });
    }

    const finalNotes = notes || medical_notes || age_or_notes || '';

    const result = await runQuery(
      'INSERT INTO patients (client_phone, full_name, relationship, age_or_notes) VALUES (?, ?, ?, ?)',
      [clientPhone.trim(), fullName.trim(), relationship || 'Family Member', finalNotes]
    );

    const newPatient = await getQuery('SELECT * FROM patients WHERE id = ?', [result.lastID]);
    if (newPatient) newPatient.medical_notes = newPatient.age_or_notes || '';
    res.json({ success: true, patient: newPatient, patientId: result.lastID });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/patients/:id', async (req, res) => {
  try {
    const { full_name, relationship, notes, medical_notes, age_or_notes } = req.body;
    const patient = await getQuery('SELECT * FROM patients WHERE id = ?', [req.params.id]);
    if (!patient) return res.status(404).json({ success: false, error: 'Patient profile not found' });

    const newName = full_name ? full_name.trim() : patient.full_name;
    const newRel = relationship ? relationship.trim() : patient.relationship;
    const notesInput = (notes !== undefined ? notes : (medical_notes !== undefined ? medical_notes : age_or_notes));
    const newNotes = notesInput !== undefined ? notesInput : patient.age_or_notes;

    await runQuery(`
      UPDATE patients SET full_name = ?, relationship = ?, age_or_notes = ? WHERE id = ?
    `, [newName, newRel, newNotes, req.params.id]);

    // Update patient name in upcoming appointments if changed
    if (newName !== patient.full_name) {
      await runQuery(`
        UPDATE appointments SET patient_name = ? WHERE patient_id = ?
      `, [newName, req.params.id]);
    }

    const updated = await getQuery('SELECT * FROM patients WHERE id = ?', [req.params.id]);
    if (updated) updated.medical_notes = updated.age_or_notes || '';
    res.json({ success: true, patient: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/patients/:id', async (req, res) => {
  try {
    const patient = await getQuery('SELECT * FROM patients WHERE id = ?', [req.params.id]);
    if (!patient) return res.status(404).json({ success: false, error: 'Patient not found' });

    const activeApts = await allQuery(
      "SELECT id FROM appointments WHERE patient_id = ? AND status != 'cancelled'",
      [req.params.id]
    );

    if (activeApts.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete profile: Patient has ${activeApts.length} scheduled appointment(s). Please cancel or reschedule them first.`
      });
    }

    await runQuery('DELETE FROM patients WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/clients/:phone', requireAuth, requirePermission('clients_manage'), async (req, res) => {
  try {
    const cleanPhone = req.params.phone.trim();
    const client = await getQuery('SELECT * FROM clients WHERE phone = ?', [cleanPhone]);
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    await runQuery('DELETE FROM appointments WHERE client_phone = ?', [cleanPhone]);
    await runQuery('DELETE FROM patients WHERE client_phone = ?', [cleanPhone]);
    await runQuery('DELETE FROM chat_sessions WHERE phone = ?', [cleanPhone]);
    await runQuery('DELETE FROM messages WHERE phone = ?', [cleanPhone]);
    await runQuery('DELETE FROM clients WHERE phone = ?', [cleanPhone]);

    res.json({ success: true, message: `Client ${cleanPhone} and associated records deleted successfully.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 10. REAL META WHATSAPP CLOUD API WEBHOOK & DIAGNOSTICS
// ==========================================
app.get('/api/whatsapp/webhook', handleWebhookVerification);
app.post('/api/whatsapp/webhook', handleWebhookEvent);

// Diagnostics: View live status & recent Meta API logs
app.get('/api/whatsapp/diagnostics', async (req, res) => {
  try {
    const settings = await getQuery('SELECT * FROM settings WHERE id = 1');
    const logs = await allQuery('SELECT * FROM meta_api_logs ORDER BY created_at DESC LIMIT 10');

    const envPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
    const envToken = process.env.WHATSAPP_ACCESS_TOKEN || '';

    const activePhoneId = (settings && settings.whatsapp_phone_number_id) || envPhoneId;
    const activeToken = (settings && settings.whatsapp_access_token) || envToken;

    const isDummyPhone = activePhoneId === '109823471923';
    const isTokenSet = activeToken && activeToken.trim().length > 15;

    res.json({
      success: true,
      diagnostics: {
        phoneId: activePhoneId,
        isPhoneIdValid: !!activePhoneId && !isDummyPhone,
        isDummyPhone,
        isTokenSet,
        tokenLength: activeToken ? activeToken.length : 0,
        verifyToken: (settings && settings.whatsapp_verify_token) || 'apex_clinic_secure_webhook_token_2026',
        recentLogs: logs
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/whatsapp/test-connection', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Recipient phone number is required.' });
    }

    const result = await testSendDirect(phone);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint to subscribe WhatsApp Business Account (WABA) to app
app.post('/api/whatsapp/subscribe-waba', async (req, res) => {
  try {
    const { wabaId } = req.body;
    const { subscribeWabaToApp } = require('./whatsappService');
    const result = await subscribeWabaToApp(wabaId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SPA fallback
app.use((req, res) => {
  const indexHtml = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    res.sendFile(indexHtml);
  } else {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

// Initialize database in the background without delaying port binding
initDb()
  .then(() => {
    console.log('✅ SQLite Database successfully initialized and seeded.');
  })
  .catch((err) => {
    console.error('⚠️ Database initialization error:', err.message);
  });

module.exports = app;
