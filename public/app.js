// Global State Store
let state = {
  currentTab: 'calendar',
  currentWeekStart: '', // Initialized dynamically based on clinic local time below
  currentUser: null,
  doctors: [],
  services: [],
  settings: {},
  calendarData: null,
  activeSimPhone: '+15551234567',
  isSimulatorOpen: true
};

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ==========================================
// CLINIC TIMEZONE & LOCALIZATION (STRICT CLINIC CLOCK)
// All bookings, slot availability, hold expirations, and calendar dates
// are strictly governed by the clinic's configured country and timezone.
// ==========================================
function getActiveClinicTimezone() {
  if (state && state.currentTab === 'persona') {
    const customInp = document.getElementById('cfgCustomTimezone');
    const tzSel = document.getElementById('cfgTimezone');
    if (tzSel && tzSel.value === 'CUSTOM' && customInp && customInp.value.trim()) {
      return customInp.value.trim();
    }
    if (tzSel && tzSel.value && tzSel.value !== 'CUSTOM') {
      return tzSel.value;
    }
  }
  return (state && state.settings && state.settings.timezone) ? state.settings.timezone : 'Asia/Karachi';
}

function getActiveClinicTzLabel() {
  if (state && state.currentTab === 'persona') {
    const lblInp = document.getElementById('cfgTimezoneLabel');
    if (lblInp && lblInp.value.trim()) {
      return lblInp.value.trim();
    }
  }
  return (state && state.settings && state.settings.timezone_label) ? state.settings.timezone_label : 'PKT';
}

function getLocalClinicTime(tz) {
  const targetTz = tz || getActiveClinicTimezone();
  try {
    const now = new Date();
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: targetTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const formatted = dtf.format(now);
    const parts = formatted.includes(', ') ? formatted.split(', ') : formatted.split(' ');
    const dateStr = parts[0];
    const timeStr = parts[1];
    const [h, m, s] = timeStr.split(':');

    let hNum = parseInt(h, 10);
    const ampm = hNum >= 12 ? 'PM' : 'AM';
    const h12 = hNum % 12 || 12;
    const time12 = `${String(h12).padStart(2, '0')}:${m}:${s} ${ampm}`;
    const time12Short = `${String(h12).padStart(2, '0')}:${m} ${ampm}`;

    const dtfFriendly = new Intl.DateTimeFormat('en-US', {
      timeZone: targetTz,
      weekday: 'long',
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    const friendlyDate = dtfFriendly.format(now);

    return {
      dateStr,
      timeStr: `${h}:${m}`,
      timeWithSec: timeStr,
      time12,
      time12Short,
      friendlyDate,
      timezone: targetTz
    };
  } catch (err) {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return {
      dateStr: `${yyyy}-${mm}-${dd}`,
      timeStr: now.toISOString().slice(11, 16),
      timeWithSec: now.toISOString().slice(11, 19),
      time12: now.toUTCString().slice(17, 25) + ' UTC',
      time12Short: now.toUTCString().slice(17, 22) + ' UTC',
      friendlyDate: now.toUTCString().slice(0, 16),
      timezone: 'UTC'
    };
  }
}

// Always derived strictly from the clinic's selected timezone
function getTodayStr() {
  return getLocalClinicTime().dateStr;
}

function getTomorrowStr() {
  const clinicInfo = getLocalClinicTime();
  const [y, m, d] = clinicInfo.dateStr.split('-').map(Number);
  const nextDate = new Date(Date.UTC(y, m - 1, d + 1));
  const yyyy = nextDate.getUTCFullYear();
  const mm = String(nextDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(nextDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getCurrentMonday() {
  const clinicInfo = getLocalClinicTime();
  const [y, m, d] = clinicInfo.dateStr.split('-').map(Number);
  const clinicDate = new Date(Date.UTC(y, m - 1, d));
  const day = clinicDate.getUTCDay();
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  const monday = new Date(Date.UTC(y, m - 1, d + diffToMonday));
  const yyyy = monday.getUTCFullYear();
  const mm = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(monday.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

state.currentWeekStart = getCurrentMonday();

const CURRENCY_PRESETS = {
  USD: { name: 'US Dollar', symbol: '$', position: 'before' },
  EUR: { name: 'Euro', symbol: '€', position: 'before' },
  GBP: { name: 'British Pound', symbol: '£', position: 'before' },
  PKR: { name: 'Pakistani Rupee', symbol: 'Rs ', position: 'before' },
  INR: { name: 'Indian Rupee', symbol: '₹', position: 'before' },
  AED: { name: 'UAE Dirham', symbol: 'AED ', position: 'before' },
  SAR: { name: 'Saudi Riyal', symbol: 'SAR ', position: 'before' },
  CAD: { name: 'Canadian Dollar', symbol: 'CA$', position: 'before' },
  AUD: { name: 'Australian Dollar', symbol: 'AU$', position: 'before' },
  SGD: { name: 'Singapore Dollar', symbol: 'SG$', position: 'before' },
  MYR: { name: 'Malaysian Ringgit', symbol: 'RM ', position: 'before' },
  ZAR: { name: 'South African Rand', symbol: 'R ', position: 'before' },
  BRL: { name: 'Brazilian Real', symbol: 'R$ ', position: 'before' },
  NGN: { name: 'Nigerian Naira', symbol: '₦', position: 'before' },
  EGP: { name: 'Egyptian Pound', symbol: 'EGP ', position: 'before' },
  KES: { name: 'Kenyan Shilling', symbol: 'KSh ', position: 'before' },
  PHP: { name: 'Philippine Peso', symbol: '₱', position: 'before' },
  JPY: { name: 'Japanese Yen', symbol: '¥', position: 'before' },
  CHF: { name: 'Swiss Franc', symbol: 'CHF ', position: 'before' },
  NZD: { name: 'New Zealand Dollar', symbol: 'NZ$', position: 'before' },
  QAR: { name: 'Qatari Riyal', symbol: 'QAR ', position: 'before' },
  KWD: { name: 'Kuwaiti Dinar', symbol: 'KWD ', position: 'before' },
  BHD: { name: 'Bahraini Dinar', symbol: 'BHD ', position: 'before' },
  OMR: { name: 'Omani Rial', symbol: 'OMR ', position: 'before' },
  CUSTOM: { name: 'Custom Currency', symbol: '', position: 'before' }
};

function formatPrice(amount, allowZero = true) {
  if (amount === null || amount === undefined || (amount === 0 && !allowZero)) return '';
  const num = Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = (state.settings && state.settings.currency_symbol) ? state.settings.currency_symbol : '$';
  const pos = (state.settings && state.settings.currency_position) ? state.settings.currency_position : 'before';
  return pos === 'after' ? `${num} ${symbol}`.trim() : `${symbol}${num}`;
}

function getCurrencySymbol() {
  return (state.settings && state.settings.currency_symbol) ? state.settings.currency_symbol : '$';
}

function getCurrencyCode() {
  return (state.settings && state.settings.currency) ? state.settings.currency : 'USD';
}

function updateCurrencyUIElements() {
  const code = getCurrencyCode();
  const symbol = getCurrencySymbol();

  const badge = document.getElementById('pricingCurrencyBadge');
  if (badge) {
    badge.textContent = `Currency: ${code} (${symbol.trim() || code})`;
  }

  const th = document.getElementById('thServiceFee');
  if (th) {
    th.textContent = `Consultation Fee (${symbol.trim() || code})`;
  }

  const srvLabel = document.getElementById('srvPriceLabel');
  if (srvLabel) {
    srvLabel.textContent = `Price / Fee (${symbol.trim() || code}) *`;
  }
  const editSrvLabel = document.getElementById('editSrvPriceLabel');
  if (editSrvLabel) {
    editSrvLabel.textContent = `Price / Fee (${symbol.trim() || code}) *`;
  }
}

function onCurrencySelectChange() {
  const select = document.getElementById('cfgCurrency');
  if (!select) return;
  const val = select.value;
  const preset = CURRENCY_PRESETS[val];
  if (preset && val !== 'CUSTOM') {
    const symInp = document.getElementById('cfgCurrencySymbol');
    const posInp = document.getElementById('cfgCurrencyPosition');
    if (symInp) symInp.value = preset.symbol;
    if (posInp) posInp.value = preset.position || 'before';
  }
  updateCurrencyPreview();
}

function updateCurrencyPreview() {
  const symEl = document.getElementById('cfgCurrencySymbol');
  const posEl = document.getElementById('cfgCurrencyPosition');
  const symbol = (symEl ? symEl.value : '$') || '$';
  const pos = (posEl ? posEl.value : 'before') || 'before';
  const previewEl = document.getElementById('currencyPreviewText');
  if (previewEl) {
    previewEl.textContent = pos === 'after' ? `95.00 ${symbol}`.trim() : `${symbol}95.00`;
  }
}

// Country & Timezone Lookup Helper (supports all 230+ sovereign countries)
function lookupCountryData(countryName) {
  if (!countryName) return null;
  const key = countryName.trim().toLowerCase();
  if (window.COUNTRY_BY_NAME && window.COUNTRY_BY_NAME[key]) {
    return window.COUNTRY_BY_NAME[key];
  }
  const cSel = document.getElementById('cfgCountry');
  if (cSel) {
    for (let i = 0; i < cSel.options.length; i++) {
      const opt = cSel.options[i];
      if (opt.value.toLowerCase() === key) {
        return {
          name: opt.value,
          code: opt.getAttribute('data-code'),
          tz: opt.getAttribute('data-tz'),
          label: opt.getAttribute('data-label')
        };
      }
    }
  }
  return null;
}

function filterCountryDropdown() {
  const searchInp = document.getElementById('cfgCountrySearch');
  const cSel = document.getElementById('cfgCountry');
  if (!searchInp || !cSel) return;
  const term = searchInp.value.trim().toLowerCase();

  for (let i = 0; i < cSel.options.length; i++) {
    const opt = cSel.options[i];
    if (opt.value === 'CUSTOM') {
      opt.style.display = '';
      continue;
    }
    const txt = (opt.textContent || opt.value).toLowerCase();
    const code = (opt.getAttribute('data-code') || '').toLowerCase();
    if (!term || txt.includes(term) || code === term) {
      opt.style.display = '';
    } else {
      opt.style.display = 'none';
    }
  }

  // If the currently selected option is hidden by the filter, auto-select first match
  if (term && cSel.selectedOptions.length > 0 && cSel.selectedOptions[0].style.display === 'none') {
    for (let i = 0; i < cSel.options.length; i++) {
      if (cSel.options[i].style.display !== 'none' && cSel.options[i].value !== 'CUSTOM') {
        cSel.selectedIndex = i;
        onCountrySelectChange();
        break;
      }
    }
  }
}

function onCountrySelectChange() {
  const cSel = document.getElementById('cfgCountry');
  if (!cSel) return;
  const cVal = cSel.value;
  if (cVal === 'CUSTOM') {
    const customGroup = document.getElementById('cfgCustomTimezoneGroup');
    if (customGroup) customGroup.style.display = 'block';
    updateClinicClockDisplay();
    return;
  }
  const mapping = lookupCountryData(cVal);
  if (mapping) {
    const cCodeInp = document.getElementById('cfgCountryCode');
    if (cCodeInp && mapping.code) cCodeInp.value = mapping.code;

    const tzSel = document.getElementById('cfgTimezone');
    const customGroup = document.getElementById('cfgCustomTimezoneGroup');
    const customTzInp = document.getElementById('cfgCustomTimezone');

    if (tzSel && mapping.tz) {
      let matched = false;
      for (let i = 0; i < tzSel.options.length; i++) {
        if (tzSel.options[i].value === mapping.tz) {
          tzSel.selectedIndex = i;
          matched = true;
          break;
        }
      }
      if (matched) {
        if (customGroup) customGroup.style.display = 'none';
      } else {
        tzSel.value = 'CUSTOM';
        if (customGroup) customGroup.style.display = 'block';
        if (customTzInp) customTzInp.value = mapping.tz;
      }
    }
    const tzLbl = document.getElementById('cfgTimezoneLabel');
    if (tzLbl && mapping.label) tzLbl.value = mapping.label;
  }
  updateClinicClockDisplay();
}

function onTimezoneSelectChange() {
  const tzSel = document.getElementById('cfgTimezone');
  if (!tzSel) return;
  const tzVal = tzSel.value;
  const customGroup = document.getElementById('cfgCustomTimezoneGroup');
  if (tzVal === 'CUSTOM') {
    if (customGroup) customGroup.style.display = 'block';
  } else {
    if (customGroup) customGroup.style.display = 'none';
    const opt = tzSel.options[tzSel.selectedIndex];
    const label = opt ? opt.getAttribute('data-label') : '';
    if (label) {
      const lblInp = document.getElementById('cfgTimezoneLabel');
      if (lblInp) lblInp.value = label;
    }
  }
  updateClinicClockDisplay();
}

function onCustomTzInput() {
  updateClinicClockDisplay();
}

function updateClinicClockDisplay() {
  const clinicInfo = getLocalClinicTime();
  const tzLabel = getActiveClinicTzLabel();

  // Header badges
  const hTime = document.getElementById('headerClinicTime');
  if (hTime) hTime.textContent = clinicInfo.time12Short;
  const hTz = document.getElementById('headerClinicTzBadge');
  if (hTz) hTz.textContent = tzLabel;

  const simDate = document.getElementById('currentSimulatedDate');
  if (simDate) simDate.textContent = clinicInfo.friendlyDate;

  // Persona tab preview
  const liveTime = document.getElementById('cfgLiveClockTime');
  if (liveTime) liveTime.textContent = clinicInfo.time12;
  const liveDate = document.getElementById('cfgLiveClockDate');
  if (liveDate) liveDate.textContent = clinicInfo.friendlyDate;
  const liveZone = document.getElementById('cfgLiveClockZone');
  if (liveZone) liveZone.textContent = `${clinicInfo.timezone} (${tzLabel})`;
  const liveNote = document.getElementById('cfgLiveClockNote');
  if (liveNote) {
    liveNote.textContent = `Slots on or before ${clinicInfo.time12Short} today (${clinicInfo.dateStr}) are prohibited from booking.`;
  }

  // Walk-in modal
  const wbClock = document.getElementById('wbClinicClock');
  if (wbClock) wbClock.textContent = clinicInfo.time12Short;
  const wbTz = document.getElementById('wbClinicTz');
  if (wbTz) wbTz.textContent = tzLabel;
}

// Start ticking clock every 1000ms
setInterval(updateClinicClockDisplay, 1000);

// ==========================================
// AUTHENTICATION & ACCESS CONTROL HELPERS
// ==========================================
const nativeFetch = typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : fetch;
const originalFetch = nativeFetch; // Backwards compatibility

window.fetch = async function (url, options = {}) {
  options = options || {};
  options.headers = options.headers || {};
  const token = localStorage.getItem('clinic_auth_token');
  if (token) {
    if (options.headers instanceof Headers) {
      if (!options.headers.has('Authorization')) {
        options.headers.set('Authorization', `Bearer ${token}`);
      }
    } else if (Array.isArray(options.headers)) {
      options.headers.push(['Authorization', `Bearer ${token}`]);
    } else {
      if (!options.headers['Authorization'] && !options.headers['authorization']) {
        options.headers['Authorization'] = `Bearer ${token}`;
      }
    }
  }
  const response = await nativeFetch(url, options);
  if (response.status === 401 && !url.includes('/api/auth/')) {
    localStorage.removeItem('clinic_auth_token');
    state.currentUser = null;
    showLoginView('Your session has expired. Please sign in again.');
  }
  return response;
};

function hasPermission(permKey) {
  if (!state.currentUser) return false;
  if (state.currentUser.role === 'admin' || state.currentUser.role === 'director') return true;
  const perms = Array.isArray(state.currentUser.permissions) ? state.currentUser.permissions : [];
  return perms.includes(permKey);
}

function showLoginView(errorMsg = '') {
  const loginView = document.getElementById('loginView');
  const appWorkspace = document.getElementById('appWorkspace');
  if (loginView) loginView.style.display = 'flex';
  if (appWorkspace) appWorkspace.style.display = 'none';

  const pInput = document.getElementById('loginPassword');
  if (pInput) pInput.value = '';

  const errAlert = document.getElementById('loginErrorAlert');
  if (errAlert) {
    if (errorMsg) {
      errAlert.textContent = errorMsg;
      errAlert.style.display = 'block';
    } else {
      errAlert.style.display = 'none';
    }
  }
  const successAlert = document.getElementById('loginSuccessAlert');
  if (successAlert) successAlert.style.display = 'none';
}

function showAppWorkspace() {
  const loginView = document.getElementById('loginView');
  const appWorkspace = document.getElementById('appWorkspace');
  if (loginView) loginView.style.display = 'none';
  if (appWorkspace) appWorkspace.style.display = 'block';
}

async function checkAuthStatus() {
  try {
    const token = localStorage.getItem('clinic_auth_token');
    if (!token) {
      showLoginView();
      return false;
    }
    document.cookie = `clinic_auth_token=${encodeURIComponent(token)}; path=/; max-age=604800; SameSite=Lax`;
    const res = await nativeFetch('/api/auth/me', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    const data = await res.json();
    if (data.success && data.authenticated && data.user) {
      state.currentUser = data.user;
      updateUserHeaderUI(data.user);
      
      if (data.user.mustChangePassword) {
        showAppWorkspace();
        openChangePasswordModal();
        return false;
      }

      showAppWorkspace();
      applyTabPermissions();
      return true;
    } else {
      showLoginView();
      return false;
    }
  } catch (err) {
    console.error('checkAuthStatus error:', err);
    showLoginView();
    return false;
  }
}

function fillLoginCredentials(username, password) {
  const uInput = document.getElementById('loginUsername');
  const pInput = document.getElementById('loginPassword');
  if (uInput) uInput.value = username;
  if (pInput) pInput.value = password;
  const errAlert = document.getElementById('loginErrorAlert');
  if (errAlert) errAlert.style.display = 'none';
  const succAlert = document.getElementById('loginSuccessAlert');
  if (succAlert) succAlert.style.display = 'none';
}

async function handleLoginSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('btnLoginSubmit');
  const errAlert = document.getElementById('loginErrorAlert');
  const succAlert = document.getElementById('loginSuccessAlert');

  if (!username || !password) return;

  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Verifying clinical credentials...';
  if (errAlert) errAlert.style.display = 'none';
  if (succAlert) succAlert.style.display = 'none';

  try {
    const res = await nativeFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (data.success && data.token) {
      localStorage.setItem('clinic_auth_token', data.token);
      document.cookie = `clinic_auth_token=${encodeURIComponent(data.token)}; path=/; max-age=604800; SameSite=Lax`;
      state.currentUser = data.user;
      updateUserHeaderUI(data.user);

      if (data.mustChangePassword) {
        showAppWorkspace();
        openChangePasswordModal();
      } else {
        showAppWorkspace();
        applyTabPermissions();
        showToast(`Welcome, ${data.user.fullName}!`, 'success');
        await loadAllClinicData();
      }
    } else {
      if (errAlert) {
        errAlert.textContent = data.error || 'Invalid credentials. Please verify your username and password.';
        errAlert.style.display = 'block';
      }
    }
  } catch (err) {
    if (errAlert) {
      errAlert.textContent = 'Connection error: ' + err.message;
      errAlert.style.display = 'block';
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>🔐</span> Sign In to Clinical Workspace';
  }
}

async function handleSignOut() {
  const confirmed = confirm('Are you sure you want to sign out of the clinic portal? Any unsaved edits will be discarded.');
  if (!confirmed) return;

  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {}
  localStorage.removeItem('clinic_auth_token');
  document.cookie = 'clinic_auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax';
  state.currentUser = null;
  const header = document.getElementById('authUserHeader');
  if (header) header.style.display = 'none';
  const banner = document.getElementById('doctorSessionBanner');
  if (banner) banner.style.display = 'none';
  showLoginView('Signed out successfully. Session closed.');
  showToast('You have been signed out safely.', 'info');
}

function updateUserHeaderUI(user) {
  const header = document.getElementById('authUserHeader');
  const nameEl = document.getElementById('currentUserName');
  const roleEl = document.getElementById('currentUserRoleBadge');

  // Determine displayed physician/user name
  let displayName = user.fullName || user.username;
  if (user.role === 'doctor' && user.doctorProfile && user.doctorProfile.name) {
    displayName = user.doctorProfile.name;
  }

  if (header && user) {
    header.style.display = 'inline-flex';
    if (nameEl) nameEl.textContent = displayName;
    if (roleEl) {
      roleEl.textContent = user.role.toUpperCase();
      if (user.role === 'admin') {
        roleEl.style.background = '#dc2626';
      } else if (user.role === 'director') {
        roleEl.style.background = '#4338ca';
      } else if (user.role === 'doctor') {
        roleEl.style.background = '#0284c7';
      } else {
        roleEl.style.background = '#7e22ce';
      }
    }
  }

  // Populate and show the Doctor / Staff Session Banner
  const banner = document.getElementById('doctorSessionBanner');
  if (banner && user) {
    banner.style.display = 'flex';
    const bannerDocName = document.getElementById('bannerDoctorName');
    const bannerDocDetail = document.getElementById('bannerDoctorDetail');
    const bannerRolePrefix = document.getElementById('bannerRolePrefix');
    const bannerRoleTag = document.getElementById('bannerRoleTag');
    const bannerRoleIcon = document.getElementById('bannerRoleIcon');

    if (user.role === 'doctor') {
      if (bannerRoleIcon) bannerRoleIcon.textContent = '👨‍⚕️';
      if (bannerRolePrefix) bannerRolePrefix.textContent = 'Attending Physician:';
      if (bannerDocName) bannerDocName.textContent = user.doctorProfile ? user.doctorProfile.name : displayName;
      if (bannerRoleTag) {
        bannerRoleTag.textContent = 'ATTENDING PHYSICIAN';
        bannerRoleTag.className = 'badge-role-tag doctor';
      }
      if (bannerDocDetail) {
        const specialty = user.doctorProfile ? user.doctorProfile.specialty : 'Clinical Medicine';
        bannerDocDetail.textContent = `Specialty: ${specialty} • Calendar slots & patient records segregated to your practice`;
      }
    } else if (user.role === 'director') {
      if (bannerRoleIcon) bannerRoleIcon.textContent = '🏥';
      if (bannerRolePrefix) bannerRolePrefix.textContent = 'Medical Director & Owner:';
      if (bannerDocName) bannerDocName.textContent = user.fullName || 'Medical Director';
      if (bannerRoleTag) {
        bannerRoleTag.textContent = 'CLINIC DIRECTOR';
        bannerRoleTag.className = 'badge-role-tag director';
      }
      if (bannerDocDetail) {
        bannerDocDetail.textContent = 'Executive clinical oversight across all providers, calendars, services, and WhatsApp bookings';
      }
    } else if (user.role === 'receptionist') {
      if (bannerRoleIcon) bannerRoleIcon.textContent = '📋';
      if (bannerRolePrefix) bannerRolePrefix.textContent = 'Front Desk Reception:';
      if (bannerDocName) bannerDocName.textContent = user.fullName || 'Front Desk Staff';
      if (bannerRoleTag) {
        bannerRoleTag.textContent = 'FRONT DESK';
        bannerRoleTag.className = 'badge-role-tag reception';
      }
      if (bannerDocDetail) {
        bannerDocDetail.textContent = 'Walk-in bookings, patient registrations, rescheduling, and desk check-ins across all doctors';
      }
    } else {
      if (bannerRoleIcon) bannerRoleIcon.textContent = '👑';
      if (bannerRolePrefix) bannerRolePrefix.textContent = 'System Administrator:';
      if (bannerDocName) bannerDocName.textContent = user.fullName || 'Administrator';
      if (bannerRoleTag) {
        bannerRoleTag.textContent = 'SYSTEM ADMIN';
        bannerRoleTag.className = 'badge-role-tag admin';
      }
      if (bannerDocDetail) {
        bannerDocDetail.textContent = 'Full administration: User RBAC access rights, clinic persona parameters, and Meta WhatsApp Cloud API credentials';
      }
    }
  }
}

function applyTabPermissions() {
  if (!state.currentUser) return;
  const user = state.currentUser;

  const tabCalendar = document.getElementById('tabBtnCalendar');
  const tabDoctors = document.getElementById('tabBtnDoctors');
  const tabUnavail = document.getElementById('tabBtnUnavailability');
  const tabApts = document.getElementById('tabBtnAppointments');
  const tabClients = document.getElementById('tabBtnClients');
  const tabPricing = document.getElementById('tabBtnPricing');
  const tabPersona = document.getElementById('tabBtnPersona');
  const tabUsers = document.getElementById('tabBtnUsers');
  const tabNotifs = document.getElementById('tabBtnNotifications');

  if (tabCalendar) tabCalendar.style.display = hasPermission('calendar_view') ? 'inline-block' : 'none';
  if (tabDoctors) tabDoctors.style.display = hasPermission('doctors_view') ? 'inline-block' : 'none';
  if (tabUnavail) tabUnavail.style.display = hasPermission('unavailability_view') ? 'inline-block' : 'none';
  if (tabApts) tabApts.style.display = hasPermission('appointments_view') ? 'inline-block' : 'none';
  if (tabClients) tabClients.style.display = hasPermission('clients_view') ? 'inline-block' : 'none';
  if (tabPricing) tabPricing.style.display = hasPermission('pricing_view') ? 'inline-block' : 'none';
  if (tabPersona) tabPersona.style.display = hasPermission('settings_manage') ? 'inline-block' : 'none';
  if (tabUsers) tabUsers.style.display = hasPermission('users_manage') ? 'inline-block' : 'none';
  if (tabNotifs) tabNotifs.style.display = 'inline-block';

  // Strict Calendar Doctor Filtering for Doctors
  const docFilter = document.getElementById('calendarDoctorFilter');
  const editDocBtn = document.getElementById('btnEditSelectedDoctor');
  if (user.role === 'doctor' && !hasPermission('calendar_all_doctors') && user.doctorId) {
    if (docFilter) {
      docFilter.innerHTML = `<option value="${user.doctorId}">${escapeHtml(user.doctorProfile ? user.doctorProfile.name : user.fullName)} (My Schedule)</option>`;
      docFilter.disabled = true;
    }
    if (editDocBtn) editDocBtn.style.display = 'none';
  } else {
    if (docFilter) docFilter.disabled = false;
    if (editDocBtn) editDocBtn.style.display = 'inline-flex';
  }

  // Ensure current active tab is allowed, otherwise switch
  const allowedTabs = [];
  if (hasPermission('calendar_view')) allowedTabs.push('calendar');
  if (hasPermission('appointments_view')) allowedTabs.push('appointments');
  if (hasPermission('unavailability_view')) allowedTabs.push('unavailability');
  if (hasPermission('doctors_view')) allowedTabs.push('doctors');
  if (hasPermission('clients_view')) allowedTabs.push('clients');
  if (hasPermission('pricing_view')) allowedTabs.push('pricing');
  if (hasPermission('settings_manage')) allowedTabs.push('persona');
  if (hasPermission('users_manage')) allowedTabs.push('users');
  allowedTabs.push('notifications');

  if (!allowedTabs.includes(state.currentTab) && allowedTabs.length > 0) {
    switchTab(allowedTabs[0]);
  }
}

// Mandatory First Login Password Modal
function openChangePasswordModal() {
  const modal = document.getElementById('changePasswordModal');
  if (modal) modal.style.display = 'flex';
  const alert = document.getElementById('changePassErrorAlert');
  if (alert) alert.style.display = 'none';

  const userDisplay = document.getElementById('changePassUserDisplay');
  if (userDisplay && state.currentUser) {
    userDisplay.textContent = `${state.currentUser.fullName || state.currentUser.username} (@${state.currentUser.username} • ${state.currentUser.role.toUpperCase()})`;
  }

  const p1 = document.getElementById('newFirstPassword');
  if (p1) p1.value = '';
  const p2 = document.getElementById('confirmFirstPassword');
  if (p2) p2.value = '';
}

async function skipPasswordChangeForDemo() {
  const modal = document.getElementById('changePasswordModal');
  if (modal) modal.style.display = 'none';
  showToast('Entered clinical workspace in preview mode.', 'info');
  applyTabPermissions();
  await loadAllClinicData();
}

function cancelPasswordChangeAndLogout() {
  const modal = document.getElementById('changePasswordModal');
  if (modal) modal.style.display = 'none';
  handleSignOut();
}

async function handleForcePasswordChangeSubmit(e) {
  e.preventDefault();
  const newPass = document.getElementById('newFirstPassword').value;
  const confirmPass = document.getElementById('confirmFirstPassword').value;
  const btn = document.getElementById('btnChangePassSubmit');
  const alertEl = document.getElementById('changePassErrorAlert');

  if (newPass.length < 6) {
    alertEl.textContent = 'Password must be at least 6 characters.';
    alertEl.style.display = 'block';
    return;
  }
  if (newPass !== confirmPass) {
    alertEl.textContent = 'Passwords do not match.';
    alertEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Updating password...';

  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: newPass, confirmPassword: confirmPass })
    });
    const data = await res.json();

    if (data.success) {
      document.getElementById('changePasswordModal').style.display = 'none';
      showToast('Password updated! Clinical workspace unlocked.', 'success');
      if (state.currentUser) state.currentUser.mustChangePassword = false;
      applyTabPermissions();
      await loadAllClinicData();
    } else {
      alertEl.textContent = data.error || 'Failed to update password.';
      alertEl.style.display = 'block';
    }
  } catch (err) {
    alertEl.textContent = 'Error: ' + err.message;
    alertEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>🔒</span> Save New Password & Unlock Portal';
  }
}

// Forgot Password Drawer
function toggleForgotPasswordBox() {
  const box = document.getElementById('forgotPasswordBox');
  if (!box) return;
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
  const resMsg = document.getElementById('forgotResultMsg');
  if (resMsg) resMsg.style.display = 'none';
  const input = document.getElementById('forgotIdentifier');
  if (input && box.style.display !== 'none') {
    setTimeout(() => input.focus(), 50);
  }
}

async function handleForgotPasswordSubmit() {
  const identifier = document.getElementById('forgotIdentifier').value.trim();
  const msgEl = document.getElementById('forgotResultMsg');
  const btn = document.getElementById('btnForgotSubmit');
  if (!identifier) {
    showToast('Please enter your username, clinic email, or WhatsApp mobile number.', 'warning');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Dispatching...';
  }

  try {
    const res = await nativeFetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier })
    });
    const data = await res.json();

    if (data.success && data.tempPassword) {
      if (msgEl) {
        msgEl.style.display = 'block';
        msgEl.innerHTML = `
          <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 14px; margin-top: 10px;">
            <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: #166534; font-size: 0.88rem; margin-bottom: 6px;">
              <span>✅</span> <span>Temporary Password Generated & Dispatched!</span>
            </div>
            <div style="font-size: 0.78rem; color: #15803d; line-height: 1.4; margin-bottom: 10px;">
              Dispatched to: <strong>WhatsApp (${escapeHtml(data.dispatchedTo.whatsapp || 'Registered mobile')})</strong> and <strong>Email (${escapeHtml(data.dispatchedTo.email || 'Registered email')})</strong>.
            </div>
            <div style="background: #ffffff; border: 1px dashed #22c55e; border-radius: 6px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
              <div>
                <div style="font-size: 0.68rem; color: #64748b; text-transform: uppercase; font-weight: 700;">Temporary Sign-In Password:</div>
                <div style="font-family: monospace; font-size: 1.15rem; font-weight: 800; color: #0f172a; letter-spacing: 0.5px;">${escapeHtml(data.tempPassword)}</div>
              </div>
              <button type="button" class="btn-primary" style="background: #16a34a; border-color: #15803d; font-size: 0.78rem; padding: 7px 12px; font-weight: 700;" onclick="applyTempPassword('${escapeHtml(data.username)}', '${escapeHtml(data.tempPassword)}')">
                📋 Auto-Fill & Sign In
              </button>
            </div>
            <div style="font-size: 0.72rem; color: #475569; margin-top: 8px;">
              ℹ️ Click the button above to automatically sign in with your new temporary password.
            </div>
          </div>
        `;
      }
      showToast('Temporary password generated and dispatched to your WhatsApp/Email!', 'success');
    } else {
      if (msgEl) {
        msgEl.style.display = 'block';
        msgEl.innerHTML = `
          <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 10px 12px; color: #b91c1c; font-size: 0.8rem;">
            ❌ ${escapeHtml(data.error || 'Failed to generate temporary password.')}
          </div>
        `;
      }
    }
  } catch (err) {
    if (msgEl) {
      msgEl.style.display = 'block';
      msgEl.innerHTML = `
        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 10px 12px; color: #b91c1c; font-size: 0.8rem;">
          ❌ Connection error: ${escapeHtml(err.message)}
        </div>
      `;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Get Temp Password';
    }
  }
}

function applyTempPassword(username, tempPass) {
  const uEl = document.getElementById('loginUsername');
  const pEl = document.getElementById('loginPassword');
  if (uEl) uEl.value = username;
  if (pEl) pEl.value = tempPass;
  toggleForgotPasswordBox();
  showToast('Credentials filled! Signing in now...', 'success');
  handleLoginSubmit();
}

async function loadAllClinicData() {
  await loadSettings();
  await loadDoctors();
  await loadServices();
  await loadCalendar();
  await loadDoctorsList();
  updateCalendarDoctorEditBtn();
  await loadSimulatorChat();
  await loadNotifications();
  await loadMetaDiagnostics();
  if (hasPermission('users_manage')) {
    await loadUsersTable();
  }
}

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
  // Set dynamic today's date in header strictly based on clinic local time
  const clinicNow = getLocalClinicTime();
  const dateEl = document.getElementById('currentSimulatedDate');
  if (dateEl) dateEl.textContent = clinicNow.friendlyDate;

  // Set default date inputs to today/tomorrow dynamically strictly based on clinic local time
  const wbDateEl = document.getElementById('wbDate');
  if (wbDateEl) wbDateEl.value = getTomorrowStr();

  const unavailDateEl = document.getElementById('unavailDate');
  if (unavailDateEl) unavailDateEl.value = getTomorrowStr();

  // Set webhook URL in UI
  const webhookUrl = `${window.location.origin}/api/whatsapp/webhook`;
  const el = document.getElementById('cfgWebhookUrl');
  if (el) el.value = webhookUrl;

  // Close modal when clicking on backdrop
  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay') && e.target.id !== 'loginModal') {
      e.target.style.display = 'none';
    }
  });

  // Bind login form submit event explicitly
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLoginSubmit);
  }

  // Check authentication before loading protected medical data
  const authenticated = await checkAuthStatus();
  if (authenticated) {
    await loadAllClinicData();
  }

  // Poll notifications and Meta logs periodically
  setInterval(() => {
    if (state.currentUser) {
      loadNotifications();
      loadMetaDiagnostics();
    }
  }, 12000);
});

// Robust JSON Fetch helper that prevents "Unexpected non-whitespace character" errors
async function safeFetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(`Server returned status ${res.status}: ${text.slice(0, 100) || 'Non-JSON response'}`);
  }
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// Toast notification helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  const icon = type === 'success' ? '✅' : (type === 'error' ? '❌' : (type === 'warning' ? '⚠️' : 'ℹ️'));
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}

// Horizontal Tab Scroll Helper
function scrollTabs(direction) {
  const container = document.getElementById('navTabsContainer');
  if (!container) return;
  const scrollAmount = 220;
  container.scrollBy({
    left: direction === 'left' ? -scrollAmount : scrollAmount,
    behavior: 'smooth'
  });
}

// Tab Switching with Auto-Scroll & Data-Tab Selector
function switchTab(tabId) {
  state.currentTab = tabId;
  document.querySelectorAll('.nav-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(pane => pane.style.display = 'none');

  let activeBtn = document.querySelector(`.nav-tab-btn[data-tab="${tabId}"]`);
  if (!activeBtn) {
    activeBtn = Array.from(document.querySelectorAll('.nav-tab-btn')).find(b => b.textContent.toLowerCase().includes(tabId));
  }

  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }

  const pane = document.getElementById(`tab-${tabId}`);
  if (pane) {
    pane.style.display = 'block';
  }

  // Smoothly scroll content-area back to top on tab switch
  const contentArea = document.querySelector('.content-area');
  if (contentArea) contentArea.scrollTo({ top: 0, behavior: 'smooth' });

  if (tabId === 'calendar') loadCalendar();
  if (tabId === 'doctors') loadDoctorsList();
  if (tabId === 'unavailability') loadUnavailabilityTable();
  if (tabId === 'appointments') loadAppointmentsTable();
  if (tabId === 'clients') loadClientsTable();
  if (tabId === 'pricing') loadServicesTable();
  if (tabId === 'persona') { fillPersonaForm(); loadMetaDiagnostics(); }
  if (tabId === 'notifications') loadNotifications();
  if (tabId === 'users') loadUsersTable();
}

// Toggle Simulator Drawer
function toggleSimulator() {
  state.isSimulatorOpen = !state.isSimulatorOpen;
  const drawer = document.getElementById('simulatorDrawer');
  const toggleBtn = document.getElementById('btnToggleSimulator');

  if (state.isSimulatorOpen) {
    if (drawer) {
      drawer.style.display = 'flex';
      drawer.classList.add('open');
    }
    if (toggleBtn) toggleBtn.textContent = '📱 Hide WhatsApp Simulator';
  } else {
    if (drawer) {
      drawer.style.display = 'none';
      drawer.classList.remove('open');
    }
    if (toggleBtn) toggleBtn.textContent = '📱 Open WhatsApp Simulator';
  }
}

// Modal Helpers
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// ----------------------------------------------------
// 1. SETTINGS & PERSONA
// ----------------------------------------------------
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success && data.settings) {
      state.settings = data.settings;
      state.currentWeekStart = getCurrentMonday();
      document.getElementById('headerBusinessName').textContent = data.settings.business_name;
      document.getElementById('headerPersonaName').textContent = data.settings.persona_name;
      document.getElementById('simClinicTitle').textContent = `${data.settings.persona_name} (${data.settings.business_name.split(' ')[0]})`;
      updateCurrencyUIElements();
      updateClinicClockDisplay();
      updateSampleDataPurgeUI();
    }
  } catch (e) {
    console.error('Error loading settings:', e);
  }
}

function updateSampleDataPurgeUI() {
  const s = state.settings;
  const card = document.getElementById('purgeSampleDataCard');
  const btn = document.getElementById('btnPurgeSampleData');
  const badge = document.getElementById('sampleDataStatusBadge');
  const note = document.getElementById('sampleDataClearedNote');
  const timeSpan = document.getElementById('sampleDataClearedAtText');

  if (!card) return;

  const isCleared = s && (s.sample_data_cleared === 1 || s.sample_data_cleared === true || s.sample_data_cleared === '1');

  if (isCleared) {
    if (badge) {
      badge.textContent = 'Production Mode (Demo Purged)';
      badge.className = 'apt-badge confirmed';
    }
    if (note) {
      note.style.display = 'block';
      if (timeSpan) timeSpan.textContent = s.sample_data_cleared_at || 'earlier';
    }
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.55';
      btn.style.cursor = 'not-allowed';
      btn.innerHTML = '<span>🔒</span> Demo Data Cleared (Doctors, Patients & Appointments Purged)';
    }
  } else {
    if (badge) {
      badge.textContent = 'Demo Data Active';
      badge.className = 'apt-badge tentative';
    }
    if (note) {
      note.style.display = 'none';
    }
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      btn.innerHTML = '<span>🗑️</span> Purge Demo Doctors, Patients & Appointments';
    }
  }
}

function openPurgeSampleDataModal() {
  const s = state.settings;
  if (s && (s.sample_data_cleared === 1 || s.sample_data_cleared === true || s.sample_data_cleared === '1')) {
    showToast('Initial demo data has already been permanently purged for this clinic.', 'info');
    return;
  }
  openModal('purgeSampleModal');
}

async function handleConfirmPurgeSampleData() {
  try {
    const btn = document.getElementById('btnConfirmPurgeSample');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Purging Demo Records...';
    }

    const res = await fetch('/api/admin/purge-sample-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();

    if (data.success) {
      closeModal('purgeSampleModal');
      showToast(data.message || 'Demo Doctors, Patients & Appointments successfully purged!', 'success');
      await loadSettings();
      updateSampleDataPurgeUI();
      if (typeof loadDoctors === 'function') await loadDoctors();
      if (typeof loadDoctorsList === 'function') await loadDoctorsList();
      if (typeof loadUsersList === 'function') await loadUsersList();
      if (typeof loadAppointmentsTable === 'function') await loadAppointmentsTable();
      if (typeof loadClientsTable === 'function') await loadClientsTable();
      if (typeof loadCalendar === 'function') await loadCalendar();
      if (typeof loadNotifications === 'function') await loadNotifications();
    } else {
      showToast(data.error || 'Failed to purge demo data.', 'error');
    }
  } catch (err) {
    showToast('Error purging demo data: ' + err.message, 'error');
  } finally {
    const btn = document.getElementById('btnConfirmPurgeSample');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Yes, Permanently Purge Demo Data';
    }
  }
}

function fillPersonaForm() {
  const s = state.settings;
  if (!s) return;
  document.getElementById('cfgBusinessName').value = s.business_name || '';
  document.getElementById('cfgBusinessType').value = s.business_type || '';
  document.getElementById('cfgAddress').value = s.address || '';
  document.getElementById('cfgClinicPhone').value = s.clinic_phone || '';
  document.getElementById('cfgOwnerPersonalPhone').value = s.owner_personal_phone || '';
  document.getElementById('cfgPersonaName').value = s.persona_name || '';
  document.getElementById('cfgPersonaTone').value = s.persona_tone || '';
  document.getElementById('cfgInstructions').value = s.custom_instructions || '';
  document.getElementById('cfgCancellationPolicy').value = s.cancellation_policy || '';
  document.getElementById('cfgVerifyToken').value = s.whatsapp_verify_token || '';
  document.getElementById('cfgPhoneId').value = s.whatsapp_phone_number_id || '1351164651405799';
  document.getElementById('cfgWabaId').value = '2231026294424950';
  document.getElementById('cfgAccessToken').value = s.whatsapp_access_token || '';

  // Country & Timezone
  const cSel = document.getElementById('cfgCountry');
  if (cSel) {
    cSel.value = s.country || 'Pakistan';
    if (!cSel.value) cSel.value = 'CUSTOM';
  }
  const cCode = document.getElementById('cfgCountryCode');
  if (cCode) cCode.value = s.country_code || 'PK';

  const tzSel = document.getElementById('cfgTimezone');
  const customGroup = document.getElementById('cfgCustomTimezoneGroup');
  const customTzInp = document.getElementById('cfgCustomTimezone');
  if (tzSel) {
    tzSel.value = s.timezone || 'Asia/Karachi';
    if (!tzSel.value) {
      tzSel.value = 'CUSTOM';
      if (customGroup) customGroup.style.display = 'block';
      if (customTzInp) customTzInp.value = s.timezone || '';
    } else {
      if (customGroup) customGroup.style.display = 'none';
    }
  }
  const tzLbl = document.getElementById('cfgTimezoneLabel');
  if (tzLbl) tzLbl.value = s.timezone_label || 'PKT (UTC+5)';

  const currSel = document.getElementById('cfgCurrency');
  if (currSel) {
    currSel.value = s.currency || 'USD';
    if (!currSel.value) currSel.value = 'CUSTOM';
  }
  const currSym = document.getElementById('cfgCurrencySymbol');
  if (currSym) currSym.value = s.currency_symbol || '$';
  const currPos = document.getElementById('cfgCurrencyPosition');
  if (currPos) currPos.value = s.currency_position || 'before';

  updateCurrencyPreview();
  updateCurrencyUIElements();
  updateClinicClockDisplay();
  updateSampleDataPurgeUI();
}

async function saveClinicSettings() {
  try {
    const tzVal = document.getElementById('cfgTimezone') ? document.getElementById('cfgTimezone').value : 'Asia/Karachi';
    const customTz = document.getElementById('cfgCustomTimezone') ? document.getElementById('cfgCustomTimezone').value.trim() : '';
    const effectiveTz = (tzVal === 'CUSTOM' && customTz) ? customTz : (tzVal || 'Asia/Karachi');

    const payload = {
      business_name: document.getElementById('cfgBusinessName').value,
      business_type: document.getElementById('cfgBusinessType').value,
      address: document.getElementById('cfgAddress').value,
      clinic_phone: document.getElementById('cfgClinicPhone').value,
      owner_personal_phone: document.getElementById('cfgOwnerPersonalPhone').value,
      persona_name: document.getElementById('cfgPersonaName').value,
      persona_tone: document.getElementById('cfgPersonaTone').value,
      custom_instructions: document.getElementById('cfgInstructions').value,
      cancellation_policy: document.getElementById('cfgCancellationPolicy').value,
      currency: document.getElementById('cfgCurrency') ? document.getElementById('cfgCurrency').value : 'USD',
      currency_symbol: document.getElementById('cfgCurrencySymbol') ? document.getElementById('cfgCurrencySymbol').value : '$',
      currency_position: document.getElementById('cfgCurrencyPosition') ? document.getElementById('cfgCurrencyPosition').value : 'before',
      country: document.getElementById('cfgCountry') ? document.getElementById('cfgCountry').value : 'Pakistan',
      country_code: document.getElementById('cfgCountryCode') ? document.getElementById('cfgCountryCode').value : 'PK',
      timezone: effectiveTz,
      timezone_label: document.getElementById('cfgTimezoneLabel') ? document.getElementById('cfgTimezoneLabel').value : 'PKT',
      whatsapp_verify_token: document.getElementById('cfgVerifyToken').value,
      whatsapp_phone_number_id: document.getElementById('cfgPhoneId').value,
      whatsapp_access_token: document.getElementById('cfgAccessToken').value
    };

    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      state.settings = data.settings;
      state.currentWeekStart = getCurrentMonday();
      document.getElementById('headerBusinessName').textContent = data.settings.business_name;
      document.getElementById('headerPersonaName').textContent = data.settings.persona_name;
      updateCurrencyUIElements();
      updateClinicClockDisplay();
      showToast(`Clinic settings & timezone (${data.settings.timezone_label || data.settings.timezone}) saved!`, 'success');
      loadMetaDiagnostics();
      loadServicesTable();
      if (typeof loadAppointmentsTable === 'function') loadAppointmentsTable();
      if (typeof loadCalendar === 'function') loadCalendar();
    } else {
      showToast(data.error || 'Failed to save settings', 'error');
    }
  } catch (e) {
    showToast('Failed to save settings: ' + e.message, 'error');
  }
}

// ----------------------------------------------------
// 2. META CLOUD API DIAGNOSTICS & LIVE TEST
// ----------------------------------------------------
async function loadMetaDiagnostics() {
  const container = document.getElementById('metaDiagnosticsContainer');
  if (!container) return;

  try {
    const res = await fetch('/api/whatsapp/diagnostics');
    const data = await res.json();

    if (data.success && data.diagnostics) {
      const d = data.diagnostics;

      const phoneStatus = d.isPhoneIdValid
        ? `<span class="apt-badge confirmed">Valid (ID: ${d.phoneId})</span>`
        : (d.isDummyPhone ? `<span class="apt-badge tentative">⚠️ Dummy Placeholder ID (${d.phoneId})</span>` : `<span class="apt-badge cancelled">Missing Phone ID</span>`);

      const tokenStatus = d.isTokenSet
        ? `<span class="apt-badge confirmed">Configured (${d.tokenLength} chars)</span>`
        : `<span class="apt-badge cancelled">❌ Missing / Empty Token</span>`;

      let logRows = '';
      if (d.recentLogs && d.recentLogs.length > 0) {
        logRows = d.recentLogs.map(l => {
          const isOut = l.direction === 'outbound';
          const dirBadge = isOut ? '<span class="apt-badge confirmed">Outbound</span>' : '<span class="apt-badge tentative">Inbound</span>';
          let statusLabel = l.status_code ? `HTTP ${l.status_code}` : 'Received';
          let color = l.status_code === 200 ? 'var(--success)' : (l.status_code ? 'var(--danger)' : 'var(--neutral-700)');

          let errorMsg = '';
          try {
            const resp = JSON.parse(l.response || '{}');
            if (resp.error) errorMsg = ` | <span style="color:var(--danger)">Error: ${resp.error.message} (Code ${resp.error.code})</span>`;
          } catch (e) {}

          return `
            <div style="font-size: 0.75rem; padding: 6px 0; border-bottom: 1px solid var(--neutral-200); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;">
              <div>${dirBadge} <strong>${l.recipient || 'Webhook'}</strong> <span style="color: ${color}; font-weight: 700;">${statusLabel}</span>${errorMsg}</div>
              <div style="color: var(--neutral-500); font-size: 0.7rem;">${l.created_at}</div>
            </div>
          `;
        }).join('');
      } else {
        logRows = '<div style="font-size: 0.75rem; color: var(--neutral-500); padding: 8px 0;">No Meta API requests logged yet. Send a test message below or text your bot!</div>';
      }

      container.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-bottom: 10px;">
          <div style="background: #ffffff; padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--neutral-200);">
            <div style="font-size: 0.72rem; color: var(--neutral-600); font-weight: 600;">PHONE NUMBER ID</div>
            <div>${phoneStatus}</div>
          </div>
          <div style="background: #ffffff; padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--neutral-200);">
            <div style="font-size: 0.72rem; color: var(--neutral-600); font-weight: 600;">META ACCESS TOKEN</div>
            <div>${tokenStatus}</div>
          </div>
          <div style="background: #ffffff; padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--neutral-200);">
            <div style="font-size: 0.72rem; color: var(--neutral-600); font-weight: 600;">WEBHOOK VERIFY TOKEN</div>
            <div style="font-family: monospace; font-size: 0.75rem; color: var(--primary-dark); font-weight: 700;">${d.verifyToken}</div>
          </div>
        </div>

        <div style="background: #ffffff; padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--neutral-200);">
          <div style="font-size: 0.75rem; font-weight: 700; color: var(--neutral-700); margin-bottom: 6px;">
            📡 Live Meta Webhook & Outbound Dispatch Logs:
          </div>
          ${logRows}
        </div>
      `;
    }
  } catch (e) {
    console.error('Error loading diagnostics:', e);
  }
}

async function subscribeWaba() {
  const wabaId = document.getElementById('cfgWabaId').value.trim() || '2231026294424950';
  if (!wabaId) {
    alert('Please enter your WhatsApp Business Account ID (WABA ID).');
    return;
  }

  showToast('Subscribing WABA to Webhook...', 'info');

  try {
    await saveClinicSettings();

    const res = await fetch('/api/whatsapp/subscribe-waba', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wabaId })
    });
    const data = await res.json();

    if (data.success) {
      alert('🎉 SUCCESS! Meta WhatsApp Business Account (WABA) is now subscribed to your app!\n\nIncoming WhatsApp messages sent to +1 (555) 159-5073 will now be delivered directly to your server!');
      showToast('WABA subscribed successfully to webhook!', 'success');
      loadMetaDiagnostics();
    } else {
      alert('❌ Meta Response: ' + JSON.stringify(data.data || data.error));
    }
  } catch (err) {
    showToast('Failed to subscribe WABA: ' + err.message, 'error');
  }
}

async function testMetaWhatsAppConnection() {
  const phone = document.getElementById('testRecipientPhone').value.trim();
  if (!phone) {
    alert('Please enter your mobile phone number with country code (e.g. +1234567890).');
    return;
  }

  showToast('Calling Meta WhatsApp Graph API...', 'info');

  try {
    await saveClinicSettings();

    const res = await fetch('/api/whatsapp/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();

    await loadMetaDiagnostics();

    if (data.success && data.result) {
      if (data.result.error) {
        alert(`❌ Meta API Error!\nMessage: ${data.result.error.message}\nError Code: ${data.result.error.code}\nType: ${data.result.error.type}\n\nTip: If code is 131030, add your phone to the allowed list in Meta Developer Portal. If code is 190, your access token is expired.`);
      } else if (data.result.messages) {
        showToast('🎉 Success! Live WhatsApp message delivered to your phone.', 'success');
      } else if (data.result.simulated) {
        alert('⚠️ ' + data.result.message + '\n\nPlease enter your real Meta Phone Number ID and Access Token in the boxes above, then click "Save All Changes"!');
      }
    } else {
      showToast('Meta test failed: ' + (data.error || 'Check logs'), 'error');
    }
  } catch (err) {
    showToast('Network error calling Meta API: ' + err.message, 'error');
  }
}

// ----------------------------------------------------
// 3. DOCTORS & AVAILABILITY
// ----------------------------------------------------
async function loadDoctors() {
  try {
    const res = await fetch('/api/doctors');
    const data = await res.json();
    if (data.success) {
      state.doctors = data.doctors;
      populateDoctorFilters();
    }
  } catch (e) {
    console.error('Error loading doctors:', e);
  }
}

function populateDoctorFilters() {
  const calSelect = document.getElementById('calendarDoctorFilter');
  const rosterSelect = document.getElementById('filterDoctor');
  const walkinSelect = document.getElementById('wbDoctor');
  const unavailSelect = document.getElementById('unavailDoctorSelect');
  const srvSelect = document.getElementById('srvDoctor');
  const rsDocSelect = document.getElementById('rsDoctorSelect');

  const allOptions = state.doctors.map(d => `<option value="${d.id}">${d.name} (${d.specialty})${d.is_active === 0 ? ' [Inactive]' : ''}</option>`).join('');
  const activeOptions = state.doctors.filter(d => d.is_active === 1).map(d => `<option value="${d.id}">${d.name} (${d.specialty})</option>`).join('');

  if (calSelect) {
    const curr = calSelect.value;
    calSelect.innerHTML = `<option value="all">👨‍⚕️ All Doctors</option>` + allOptions;
    if (curr) calSelect.value = curr;
    updateCalendarDoctorEditBtn();
  }
  if (rosterSelect) {
    const curr = rosterSelect.value;
    rosterSelect.innerHTML = `<option value="all">All Doctors</option>` + allOptions;
    if (curr) rosterSelect.value = curr;
  }
  if (walkinSelect) walkinSelect.innerHTML = activeOptions;
  if (unavailSelect) unavailSelect.innerHTML = activeOptions;
  if (rsDocSelect) rsDocSelect.innerHTML = activeOptions;
  if (srvSelect) srvSelect.innerHTML = `<option value="">All Available Physicians</option>` + activeOptions;
  const editSrvSelect = document.getElementById('editSrvDoctor');
  if (editSrvSelect) {
    const curr = editSrvSelect.value;
    editSrvSelect.innerHTML = `<option value="">All Available Physicians</option>` + activeOptions;
    if (curr) editSrvSelect.value = curr;
  }
}

function updateCalendarDoctorEditBtn() {
  const select = document.getElementById('calendarDoctorFilter');
  const editBtn = document.getElementById('btnEditSelectedDoctor');
  if (!select || !editBtn) return;

  const val = select.value;
  if (val && val !== 'all') {
    const doc = state.doctors.find(d => String(d.id) === String(val));
    if (doc) {
      const shortName = doc.name.split(',')[0].replace('Dr. ', '');
      editBtn.innerHTML = `✏️ Edit Dr. ${shortName}`;
      editBtn.style.color = '#1d4ed8';
      editBtn.style.borderColor = '#93c5fd';
      editBtn.style.background = '#eff6ff';
      return;
    }
  }
  editBtn.innerHTML = `✏️ Edit Doctor`;
  editBtn.style.color = '';
  editBtn.style.borderColor = '';
  editBtn.style.background = '';
}

function handleEditSelectedDoctorFromCalendar() {
  const select = document.getElementById('calendarDoctorFilter');
  const val = select ? select.value : 'all';
  if (val && val !== 'all') {
    openEditDoctorModal(parseInt(val, 10));
  } else {
    // If "All Doctors" is selected, navigate to the Doctors tab where the directory table is clearly visible
    switchTab('doctors');
    showToast('Click "✏️ Edit Profile" next to any doctor below.', 'info');
  }
}

async function loadDoctorsList() {
  await loadDoctors();

  // 1. Render Top Quick Directory Table
  const tableBody = document.getElementById('doctorsDirectoryTableBody');
  if (tableBody) {
    if (!state.doctors || state.doctors.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--neutral-500);">No doctors registered yet. Click "Add New Doctor" to get started.</td></tr>`;
    } else {
      tableBody.innerHTML = state.doctors.map(doc => {
        const isActive = (doc.is_active === 1);
        return `
          <tr style="${!isActive ? 'opacity: 0.8; background: #fafafa;' : ''}">
            <td style="padding: 12px 14px;">
              <div style="font-weight: 700; color: var(--neutral-900); display: flex; align-items: center; gap: 8px;">
                <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${doc.color_code || '#2563eb'};"></span>
                <span style="font-size: 0.95rem;">${doc.name}</span>
              </div>
              <div style="font-size: 0.78rem; color: var(--neutral-600); margin-left: 18px;">${doc.title || 'Consultant'}</div>
            </td>
            <td style="padding: 12px 14px;">
              <span class="badge" style="background: #e0f2fe; color: #0369a1; font-weight: 600; font-size: 0.8rem; padding: 3px 8px; border-radius: 4px;">${doc.specialty}</span>
            </td>
            <td style="padding: 12px 14px;">
              <div style="font-weight: 600; font-size: 0.85rem; color: var(--neutral-900);">📱 ${doc.personal_phone}</div>
              <div style="font-size: 0.72rem; color: var(--neutral-500);">WhatsApp Alerts & Agenda</div>
            </td>
            <td style="padding: 12px 14px;">
              <span style="font-size: 0.82rem; color: var(--neutral-700);">${doc.email || '—'}</span>
            </td>
            <td style="padding: 12px 14px;">
              ${isActive 
                ? `<span style="font-size: 0.75rem; font-weight: 700; padding: 3px 10px; border-radius: 999px; background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; display: inline-flex; align-items: center; gap: 4px;">🟢 Active</span>`
                : `<span style="font-size: 0.75rem; font-weight: 700; padding: 3px 10px; border-radius: 999px; background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; display: inline-flex; align-items: center; gap: 4px;">🔴 Inactive</span>`
              }
            </td>
            <td style="text-align: right; padding: 12px 14px;">
              <div style="display: flex; gap: 8px; justify-content: flex-end; align-items: center;">
                <button class="btn-primary" style="padding: 6px 14px; font-size: 0.8rem; font-weight: 600; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);" onclick="openEditDoctorModal(${doc.id})">
                  ✏️ Edit Profile
                </button>
                ${isActive
                  ? `<button class="btn-secondary" style="padding: 6px 12px; font-size: 0.8rem; color: #b91c1c; border-color: #fca5a5;" onclick="handleDoctorStatusToggleClick(${doc.id})">
                      🚫 Deactivate
                    </button>`
                  : `<button class="btn-secondary" style="padding: 6px 12px; font-size: 0.8rem; color: #15803d; border-color: #86efac;" onclick="handleDoctorStatusToggleClick(${doc.id})">
                      ✅ Reactivate
                    </button>`
                }
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  // 2. Render Working Hours and Shift Cards
  const container = document.getElementById('doctorsListContainer');
  if (!container) return;

  container.innerHTML = '';

  for (const doc of state.doctors) {
    let schedule = [];
    try {
      const schedRes = await fetch(`/api/doctors/${doc.id}/schedule`);
      if (schedRes.ok) {
        const schedData = await schedRes.json();
        schedule = schedData.schedule || [];
      }
    } catch (e) {
      console.warn('Failed to load schedule for doctor', doc.id, e);
    }
    const isActive = (doc.is_active === 1);

    const card = document.createElement('div');
    const borderLeftColor = isActive ? (doc.color_code || '#2563eb') : '#9ca3af';
    const bgStyle = isActive ? '#ffffff' : '#f8fafc';
    const opacityStyle = isActive ? '1' : '0.85';

    card.style = `border: 1px solid var(--neutral-200); border-radius: var(--radius-md); padding: 16px; background: ${bgStyle}; opacity: ${opacityStyle}; border-left: 5px solid ${borderLeftColor}; margin-bottom: 16px;`;

    let schedRowsHtml = schedule.map(d => `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--neutral-100); font-size: 0.8rem;">
        <span style="font-weight: 600; width: 90px;">${d.day_name}</span>
        <label style="display: flex; align-items: center; gap: 4px; font-size: 0.75rem;">
          <input type="checkbox" id="schedActive_${doc.id}_${d.day_of_week}" ${d.is_active ? 'checked' : ''} ${!isActive ? 'disabled' : ''}> Open
        </label>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span>Shift:</span>
          <input type="time" id="schedStart_${doc.id}_${d.day_of_week}" value="${d.start_time}" ${!isActive ? 'disabled' : ''} style="font-size: 0.75rem; padding: 2px 4px; border: 1px solid var(--neutral-300); border-radius: 4px;">
          <span>to</span>
          <input type="time" id="schedEnd_${doc.id}_${d.day_of_week}" value="${d.end_time}" ${!isActive ? 'disabled' : ''} style="font-size: 0.75rem; padding: 2px 4px; border: 1px solid var(--neutral-300); border-radius: 4px;">
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span>Break:</span>
          <input type="time" id="schedBreakStart_${doc.id}_${d.day_of_week}" value="${d.break_start}" ${!isActive ? 'disabled' : ''} style="font-size: 0.75rem; padding: 2px 4px; border: 1px solid var(--neutral-300); border-radius: 4px;">
          <span>to</span>
          <input type="time" id="schedBreakEnd_${doc.id}_${d.day_of_week}" value="${d.break_end}" ${!isActive ? 'disabled' : ''} style="font-size: 0.75rem; padding: 2px 4px; border: 1px solid var(--neutral-300); border-radius: 4px;">
        </div>
      </div>
    `).join('');

    card.innerHTML = `
      <div style="display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 12px;">
        <div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="font-size: 1.1rem; font-weight: 700; color: var(--neutral-900);">${doc.name}</div>
            ${isActive 
              ? `<span style="font-size: 0.7rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0;">Active</span>`
              : `<span style="font-size: 0.7rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca;">Inactive / Left Clinic</span>`
            }
          </div>
          <div style="font-size: 0.82rem; color: var(--primary-dark); font-weight: 600; margin-top: 2px;">${doc.specialty} • ${doc.title || 'Specialist'}</div>
          <div style="font-size: 0.78rem; color: var(--neutral-600); margin-top: 2px;">
            📱 Alerts Phone: <strong style="color: var(--neutral-900);">${doc.personal_phone}</strong> ${doc.email ? `| ✉️ ${doc.email}` : ''} | Active Bookings: <strong>${doc.appointmentsCount || 0}</strong>
          </div>
          ${!isActive ? `
            <div style="font-size: 0.78rem; color: #b91c1c; background: #fff1f2; border: 1px solid #fecdd3; border-radius: 4px; padding: 5px 10px; margin-top: 6px;">
              🚫 <strong>Deactivated Doctor:</strong> This provider will <em>not</em> appear in WhatsApp patient menus, slot searches, or walk-in appointment forms. Past records and calendar history are preserved.
            </div>
          ` : ''}
        </div>
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
          <button class="btn-primary" style="padding: 6px 12px; font-size: 0.8rem;" onclick="openEditDoctorModal(${doc.id})">
            ✏️ Edit Profile
          </button>
          ${isActive 
            ? `<button class="btn-secondary" style="padding: 6px 12px; font-size: 0.8rem; color: #b91c1c; border-color: #fca5a5;" onclick="handleDoctorStatusToggleClick(${doc.id})">
                🚫 Deactivate
               </button>`
            : `<button class="btn-secondary" style="padding: 6px 12px; font-size: 0.8rem; color: #15803d; border-color: #86efac;" onclick="handleDoctorStatusToggleClick(${doc.id})">
                ✅ Reactivate
               </button>`
          }
          ${isActive ? `
            <button class="btn-secondary" style="padding: 6px 12px; font-size: 0.8rem;" onclick="saveDoctorSchedule(${doc.id})">
              💾 Save Hours
            </button>
          ` : ''}
        </div>
      </div>

      <div style="margin-top: 10px; background: var(--neutral-50); border: 1px solid var(--neutral-200); border-radius: var(--radius-sm); padding: 10px;">
        <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: var(--neutral-600); margin-bottom: 6px;">
          Weekly Working Hours & Lunch Breaks ${!isActive ? '(Disabled while inactive)' : ''}
        </div>
        ${schedRowsHtml}
      </div>
    `;

    container.appendChild(card);
  }
}

async function openEditDoctorModal(doctorId) {
  const doc = state.doctors.find(d => d.id === doctorId);
  if (!doc) return;

  document.getElementById('editDocId').value = doc.id;
  document.getElementById('editDocName').value = doc.name || '';
  document.getElementById('editDocTitle').value = doc.title || '';
  document.getElementById('editDocSpecialty').value = doc.specialty || '';
  document.getElementById('editDocPersonalPhone').value = doc.personal_phone || '';
  document.getElementById('editDocEmail').value = doc.email || '';
  document.getElementById('editDocColor').value = doc.color_code || '#0284c7';
  document.getElementById('editDocBio').value = doc.bio || '';
  document.getElementById('editDocActive').checked = (doc.is_active === 1);

  openModal('editDoctorModal');
}

// Global pending deactivation tracker
let pendingDeactivationContext = null;

async function handleDoctorStatusToggleClick(doctorId) {
  const doc = state.doctors.find(d => d.id === doctorId);
  if (!doc) return;

  if (doc.is_active === 0) {
    // Doctor is inactive, reactivate immediately
    try {
      const res = await fetch(`/api/doctors/${doctorId}/toggle-status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelAppointments: false })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`${doc.name} has been reactivated!`, 'success');
        await loadDoctors();
        await loadDoctorsList();
        loadCalendar();
      } else {
        showToast('Error reactivating doctor: ' + (data.error || 'Failed'), 'error');
      }
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
    return;
  }

  // Doctor is currently active, initiate deactivation check
  await initiateDoctorDeactivation(doctorId);
}

async function initiateDoctorDeactivation(doctorId, pendingProfileUpdate = null) {
  const doc = state.doctors.find(d => d.id === doctorId);
  if (!doc) return;

  try {
    const res = await fetch(`/api/doctors/${doctorId}/upcoming-appointments`);
    const data = await res.json();
    const upcomingApts = data.appointments || [];

    if (upcomingApts.length === 0) {
      // No upcoming appointments, confirm simple deactivation
      const confirmed = confirm(
        `Are you sure you want to deactivate ${doc.name}?\n\n` +
        `• They currently have 0 upcoming appointments scheduled.\n` +
        `• They will stop appearing in WhatsApp booking menus.\n` +
        `• Past calendar records and appointments are preserved.`
      );
      if (!confirmed) return;

      if (pendingProfileUpdate) {
        await executeDoctorProfileUpdate(pendingProfileUpdate, false);
      } else {
        await executeDoctorToggleCall(doctorId, false);
      }
      return;
    }

    // Has scheduled appointments! Show confirmation modal
    pendingDeactivationContext = {
      doctorId,
      docName: doc.name,
      appointments: upcomingApts,
      pendingProfileUpdate
    };

    const promptEl = document.getElementById('deactivateDocPrompt');
    if (promptEl) {
      promptEl.innerHTML = `<strong>${doc.name}</strong> has <span style="color: #b91c1c; font-weight: 700;">${upcomingApts.length} active scheduled appointment(s)</span> in the system. Would you like to cancel them and notify the patients?`;
    }

    const previewEl = document.getElementById('deactivateAptsPreview');
    if (previewEl) {
      previewEl.innerHTML = upcomingApts.map(a => `
        <div style="padding: 6px 0; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong>${a.id}</strong> — 👤 ${a.patient_name} (${a.service_name})
            <div style="color: #6b7280; font-size: 0.78rem;">🗓️ ${a.date} at ${formatTime12(a.start_time)} | 📱 ${a.client_phone}</div>
          </div>
          <span style="font-size: 0.72rem; padding: 2px 6px; border-radius: 4px; background: #fef3c7; color: #92400e; font-weight: 600;">${a.status.toUpperCase()}</span>
        </div>
      `).join('');
    }

    openModal('deactivateDoctorModal');
  } catch (err) {
    showToast('Failed to check doctor appointments: ' + err.message, 'error');
  }
}

async function executeDoctorDeactivation(cancelAppointments) {
  if (!pendingDeactivationContext) return;
  const { doctorId, pendingProfileUpdate } = pendingDeactivationContext;

  closeModal('deactivateDoctorModal');

  try {
    if (pendingProfileUpdate) {
      await executeDoctorProfileUpdate(pendingProfileUpdate, cancelAppointments);
    } else {
      await executeDoctorToggleCall(doctorId, cancelAppointments);
    }
  } catch (err) {
    showToast('Error executing deactivation: ' + err.message, 'error');
  } finally {
    pendingDeactivationContext = null;
  }
}

async function executeDoctorToggleCall(doctorId, cancelAppointments) {
  const doc = state.doctors.find(d => d.id === doctorId);
  const docName = doc ? doc.name : 'Doctor';

  const res = await fetch(`/api/doctors/${doctorId}/toggle-status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancelAppointments })
  });
  const data = await res.json();
  if (data.success) {
    if (cancelAppointments && data.cancelledCount > 0) {
      showToast(`${docName} deactivated. ${data.cancelledCount} appointment(s) cancelled and patients notified via WhatsApp!`, 'success');
    } else {
      showToast(`${docName} deactivated. Existing appointments kept in calendar.`, 'info');
    }
    await loadDoctors();
    await loadDoctorsList();
    loadCalendar();
    if (typeof loadAppointmentsTable === 'function') loadAppointmentsTable();
  } else {
    showToast('Error: ' + (data.error || 'Failed to deactivate doctor'), 'error');
  }
}

async function executeDoctorProfileUpdate(payload, cancelAppointments) {
  const docId = payload.id;
  const res = await fetch(`/api/doctors/${docId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, cancelAppointments })
  });
  const data = await res.json();
  if (data.success) {
    closeModal('editDoctorModal');
    if (cancelAppointments && data.cancelledCount > 0) {
      showToast(`${payload.name} updated & deactivated. ${data.cancelledCount} appointment(s) cancelled and patients notified via WhatsApp!`, 'success');
    } else {
      showToast(`Doctor ${payload.name} information updated!`, 'success');
    }
    await loadDoctors();
    await loadDoctorsList();
    loadCalendar();
    if (typeof loadAppointmentsTable === 'function') loadAppointmentsTable();
  } else {
    showToast('Error updating doctor: ' + (data.error || 'Failed'), 'error');
  }
}

async function handleDoctorUpdateSubmit(e) {
  e.preventDefault();
  const docId = parseInt(document.getElementById('editDocId').value, 10);
  const currentDoc = state.doctors.find(d => d.id === docId);
  const targetActive = document.getElementById('editDocActive').checked ? 1 : 0;

  const payload = {
    id: docId,
    name: document.getElementById('editDocName').value.trim(),
    title: document.getElementById('editDocTitle').value.trim(),
    specialty: document.getElementById('editDocSpecialty').value.trim(),
    personal_phone: document.getElementById('editDocPersonalPhone').value.trim(),
    email: document.getElementById('editDocEmail').value.trim(),
    color_code: document.getElementById('editDocColor').value,
    bio: document.getElementById('editDocBio').value.trim(),
    is_active: targetActive
  };

  // If doctor was previously active and user is now unchecking active:
  if (currentDoc && currentDoc.is_active === 1 && targetActive === 0) {
    closeModal('editDoctorModal');
    await initiateDoctorDeactivation(docId, payload);
    return;
  }

  // Otherwise, standard update
  try {
    const res = await fetch(`/api/doctors/${docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      closeModal('editDoctorModal');
      showToast(`Doctor ${payload.name} information updated!`, 'success');
      await loadDoctors();
      await loadDoctorsList();
      loadCalendar();
    } else {
      showToast('Error updating doctor: ' + (data.error || 'Failed'), 'error');
    }
  } catch (err) {
    showToast('Failed to update doctor: ' + err.message, 'error');
  }
}

async function saveDoctorSchedule(doctorId) {
  const schedule = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  for (let day = 0; day <= 6; day++) {
    const active = document.getElementById(`schedActive_${doctorId}_${day}`).checked;
    const start = document.getElementById(`schedStart_${doctorId}_${day}`).value;
    const end = document.getElementById(`schedEnd_${doctorId}_${day}`).value;
    const bStart = document.getElementById(`schedBreakStart_${doctorId}_${day}`).value;
    const bEnd = document.getElementById(`schedBreakEnd_${doctorId}_${day}`).value;

    schedule.push({
      day_of_week: day,
      day_name: dayNames[day],
      is_active: active ? 1 : 0,
      start_time: start,
      end_time: end,
      break_start: bStart,
      break_end: bEnd,
      slot_duration_minutes: 30,
      buffer_minutes: 10
    });
  }

  try {
    const res = await fetch(`/api/doctors/${doctorId}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Doctor schedule updated! Slot availability updated in WhatsApp agent.', 'success');
      loadCalendar();
    }
  } catch (e) {
    showToast('Failed to update schedule: ' + e.message, 'error');
  }
}

function openAddDoctorModal() {
  openModal('doctorModal');
}

async function handleDoctorSubmit(e) {
  e.preventDefault();
  const nameInput = document.getElementById('docName');
  const titleInput = document.getElementById('docTitle');
  const specialtyInput = document.getElementById('docSpecialty');
  const phoneInput = document.getElementById('docPersonalPhone');
  const emailInput = document.getElementById('docEmail');
  const colorInput = document.getElementById('docColor');
  const bioInput = document.getElementById('docBio');

  const payload = {
    name: nameInput ? nameInput.value.trim() : '',
    title: (titleInput && titleInput.value.trim()) ? titleInput.value.trim() : 'Consulting Physician',
    specialty: specialtyInput ? specialtyInput.value.trim() : '',
    personal_phone: phoneInput ? phoneInput.value.trim() : '',
    email: emailInput ? emailInput.value.trim() : '',
    color_code: colorInput ? colorInput.value : '#2563eb',
    bio: bioInput ? bioInput.value.trim() : ''
  };

  if (!payload.name || !payload.specialty || !payload.personal_phone) {
    showToast('Doctor name, specialty, and personal phone are required.', 'warning');
    return;
  }

  try {
    const { ok, status, data } = await safeFetchJson('/api/doctors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (ok && data.success) {
      closeModal('doctorModal');
      showToast(`Doctor ${payload.name} registered successfully!`, 'success');
      // Reset inputs
      if (nameInput) nameInput.value = '';
      if (titleInput) titleInput.value = '';
      if (specialtyInput) specialtyInput.value = '';
      if (phoneInput) phoneInput.value = '';
      if (emailInput) emailInput.value = '';
      if (bioInput) bioInput.value = '';

      await loadDoctors();
      await loadDoctorsList();
      loadCalendar();
    } else {
      showToast('Failed to add doctor: ' + (data && data.error ? data.error : `HTTP ${status}`), 'error');
    }
  } catch (err) {
    showToast('Failed to add doctor: ' + err.message, 'error');
  }
}

// ----------------------------------------------------
// 4. DOCTOR UNAVAILABILITY & LEAVE
// ----------------------------------------------------
async function loadUnavailabilityTable() {
  const tbody = document.getElementById('unavailabilityTableBody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">Loading unavailability records...</td></tr>';

  let allUnavail = [];
  for (const doc of state.doctors) {
    const res = await fetch(`/api/doctors/${doc.id}/unavailability`);
    const data = await res.json();
    if (data.success && data.unavailabilities) {
      data.unavailabilities.forEach(u => u.doctor_name = doc.name);
      allUnavail.push(...data.unavailabilities);
    }
  }

  if (allUnavail.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--neutral-500);">No doctor leaves or blackouts currently scheduled.</td></tr>';
    return;
  }

  tbody.innerHTML = allUnavail.map(u => {
    const timeLabel = u.is_full_day ? '🏖️ Full Day Leave' : `⏱️ ${u.start_time} - ${u.end_time}`;
    return `
      <tr>
        <td><strong>${u.doctor_name}</strong></td>
        <td>${u.date}</td>
        <td><span class="apt-badge tentative">${timeLabel}</span></td>
        <td>${u.reason}</td>
        <td><span style="font-size: 0.8rem; color: #b45309;">Automated WhatsApp alert active</span></td>
        <td>
          <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem; color: var(--danger);" onclick="deleteUnavailability(${u.id})">
            Remove
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function openAddUnavailabilityModal() {
  const clinicDate = getLocalClinicTime().dateStr;
  const unavailDateEl = document.getElementById('unavailDate');
  if (unavailDateEl) {
    unavailDateEl.min = clinicDate;
    unavailDateEl.value = getTomorrowStr();
  }
  openModal('unavailModal');
}

function toggleUnavailTimes() {
  const isFull = document.getElementById('unavailFullDay').checked;
  document.getElementById('unavailTimeRow').style.display = isFull ? 'none' : 'grid';
}

async function handleUnavailabilitySubmit(e) {
  e.preventDefault();
  const doctorId = document.getElementById('unavailDoctorSelect').value;
  const isFullDay = document.getElementById('unavailFullDay').checked;

  const payload = {
    date: document.getElementById('unavailDate').value,
    isFullDay,
    startTime: isFullDay ? null : document.getElementById('unavailStartTime').value,
    endTime: isFullDay ? null : document.getElementById('unavailEndTime').value,
    reason: document.getElementById('unavailReason').value
  };

  try {
    const res = await fetch(`/api/doctors/${doctorId}/unavailability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      closeModal('unavailModal');
      const impactedCount = (data.impactedAppointments || []).length;
      if (impactedCount > 0) {
        showToast(`Unavailability saved! ⚠️ ${impactedCount} appointment(s) impacted. Patients flagged for WhatsApp rescheduling.`, 'warning');
      } else {
        showToast('Doctor unavailability recorded with no booking conflicts.', 'success');
      }
      loadUnavailabilityTable();
      loadCalendar();
    }
  } catch (err) {
    showToast('Failed to schedule leave: ' + err.message, 'error');
  }
}

async function deleteUnavailability(id) {
  if (!confirm('Remove this unavailability record?')) return;
  try {
    await fetch(`/api/doctors/unavailability/${id}`, { method: 'DELETE' });
    showToast('Unavailability record removed.', 'info');
    loadUnavailabilityTable();
    loadCalendar();
  } catch (e) {
    showToast('Error removing: ' + e.message, 'error');
  }
}

// ----------------------------------------------------
// 5. WEEKLY CALENDAR VIEW (DYNAMIC DATES)
// ----------------------------------------------------
function navigateWeek(daysOffset) {
  if (daysOffset === 0) {
    state.currentWeekStart = getCurrentMonday(); // Reset to current week
  } else {
    const [y, m, d] = state.currentWeekStart.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + daysOffset));
    state.currentWeekStart = date.toISOString().split('T')[0];
  }
  loadCalendar();
}

async function loadCalendar() {
  const startStr = state.currentWeekStart;
  const [y, m, d] = startStr.split('-').map(Number);
  const startDate = new Date(Date.UTC(y, m - 1, d));
  const endDate = new Date(Date.UTC(y, m - 1, d + 6));
  const endStr = endDate.toISOString().split('T')[0];

  const docFilter = document.getElementById('calendarDoctorFilter') ? document.getElementById('calendarDoctorFilter').value : 'all';

  document.getElementById('weekRangeLabel').textContent = `${formatDateShort(startDate)} - ${formatDateShort(endDate)}`;

  try {
    const res = await fetch(`/api/calendar?start_date=${startStr}&end_date=${endStr}&doctor_id=${docFilter}`);
    const data = await res.json();

    if (data.success) {
      state.calendarData = data;
      renderCalendarStats(data.stats);
      renderCalendarGrid(startDate, data.appointments, data.unavailabilities || [], data.activeHolds || []);
    }
  } catch (e) {
    console.error('Error loading calendar:', e);
  }
}

function formatDateShort(dateObj) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[dateObj.getUTCMonth()]} ${dateObj.getUTCDate()}, ${dateObj.getUTCFullYear()}`;
}

function renderCalendarStats(stats) {
  document.getElementById('statTotalWeek').textContent = stats.total || 0;
  document.getElementById('statConfirmedWeek').textContent = stats.confirmed || 0;
  document.getElementById('statTentativeWeek').textContent = stats.tentative || 0;
  document.getElementById('statCompletedWeek').textContent = stats.completed || 0;
  const noShowEl = document.getElementById('statNoShowWeek');
  if (noShowEl) noShowEl.textContent = stats.no_show || 0;
  const holdsEl = document.getElementById('statHoldsWeek');
  if (holdsEl) holdsEl.textContent = stats.activeHoldsCount || 0;
  document.getElementById('statRevenueWeek').textContent = formatPrice(stats.estimatedRevenue || 0);
}

function renderCalendarGrid(startDateObj, appointments, unavailabilities, activeHolds = []) {
  const grid = document.getElementById('weekCalendarGrid');
  grid.innerHTML = '';

  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const todayIso = getTodayStr(); // DYNAMIC REAL TODAY!

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(Date.UTC(
      startDateObj.getUTCFullYear(),
      startDateObj.getUTCMonth(),
      startDateObj.getUTCDate() + i
    ));
    const dayIso = dayDate.toISOString().split('T')[0];
    const isToday = dayIso === todayIso;

    const col = document.createElement('div');
    col.className = `day-column ${isToday ? 'today' : ''}`;

    const dayApts = appointments.filter(a => a.date === dayIso);
    const dayUnavails = unavailabilities.filter(u => u.date === dayIso);
    const dayHolds = (activeHolds || []).filter(h => h.date === dayIso);

    let cardsHtml = '';

    dayUnavails.forEach(u => {
      cardsHtml += `
        <div class="unavail-banner">
          🚫 ${u.doctor_name}: ${u.reason}
        </div>
      `;
    });

    dayHolds.forEach(h => {
      const expiresMin = Math.max(1, Math.round((new Date(h.expires_at).getTime() - Date.now()) / 60000));
      cardsHtml += `
        <div class="apt-card hold-card" title="WhatsApp session in progress. Slot is held exclusively to prevent double booking.">
          <div class="apt-time">
            <span>${formatTime12(h.start_time)}</span>
            <span class="apt-badge hold">⏳ HELD</span>
          </div>
          <div class="apt-patient" style="font-weight: 600; color: #92400e;">WhatsApp In-Progress</div>
          <div class="apt-doctor" style="color: #78350f;">👨‍⚕️ ${escapeHtml(h.doctor_name || 'Physician')}</div>
          <div class="apt-service" style="font-size: 0.72rem; color: #b45309;">Lock expires in ~${expiresMin}m</div>
        </div>
      `;
    });

    if (dayApts.length === 0 && dayUnavails.length === 0 && dayHolds.length === 0) {
      cardsHtml += `<div class="empty-day-notice">No bookings</div>`;
    } else {
      dayApts.forEach(apt => {
        const statusClass = apt.status || 'confirmed';
        const docColor = apt.doc_color || '#2563eb';
        cardsHtml += `
          <div class="apt-card ${statusClass}" style="border-left-color: ${docColor};" onclick="openRescheduleModal('${apt.id}')">
            <div class="apt-time">
              <span>${formatTime12(apt.start_time)}</span>
              <span class="apt-badge ${statusClass}">${apt.status}</span>
            </div>
            <div class="apt-patient">${escapeHtml(apt.patient_name)}</div>
            <div class="apt-doctor">👨‍⚕️ ${escapeHtml(apt.doc_name || apt.doctor_name)}</div>
            <div class="apt-service">${escapeHtml(apt.service_name)} • ${formatPrice(apt.fee)}</div>
          </div>
        `;
      });
    }

    col.innerHTML = `
      <div class="day-header">
        <div class="day-name">${dayNames[i]}</div>
        <div class="day-date">${dayDate.getUTCDate()}</div>
      </div>
      <div class="day-slots-list">
        ${cardsHtml}
      </div>
    `;

    grid.appendChild(col);
  }
}

// ----------------------------------------------------
// 6. APPOINTMENTS ROSTER
// ----------------------------------------------------
async function loadAppointmentsTable() {
  const docFilter = document.getElementById('filterDoctor').value;
  const statusFilter = document.getElementById('filterStatus').value;
  const searchFilter = document.getElementById('filterSearch').value;

  let url = `/api/appointments?doctor_id=${docFilter}&status=${statusFilter}&search=${encodeURIComponent(searchFilter)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const tbody = document.getElementById('appointmentsTableBody');
    if (!tbody) return;

    if (!data.success || data.appointments.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding: 20px; color: var(--neutral-500);">No appointments found matching your criteria.</td></tr>';
      return;
    }

    tbody.innerHTML = data.appointments.map(a => {
      const reminderSent = a.confirmation_sent_at ? 'Sent' : 'Pending';
      const isActive = a.status === 'confirmed' || a.status === 'tentative';
      const canManage = hasPermission('appointments_manage');
      const deleteBtn = canManage ? `
        <button class="btn-secondary" style="padding: 3px 6px; font-size: 0.72rem; color: #dc2626; border-color: #fca5a5;" onclick="deleteAppointment('${a.id}')" title="Permanently delete appointment record">
          Delete
        </button>
      ` : '';

      let actionButtons = '';

      if (isActive) {
        actionButtons = `
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            <button class="btn-secondary" style="padding: 3px 6px; font-size: 0.72rem;" onclick="openRescheduleModal('${a.id}')" title="Reschedule slot">
              Reschedule
            </button>
            <button class="btn-secondary" style="padding: 3px 6px; font-size: 0.72rem; color: #7e22ce; border-color: #d8b4fe;" onclick="markAppointmentNoShow('${a.id}', '${escapeHtml(a.patient_name)}')" title="Mark as No-Show and reopen slot">
              No-Show
            </button>
            <button class="btn-secondary" style="padding: 3px 6px; font-size: 0.72rem; color: var(--danger); border-color: #fca5a5;" onclick="cancelAppointment('${a.id}')" title="Cancel booking and reopen slot">
              Cancel
            </button>
            ${deleteBtn}
          </div>
        `;
      } else if (a.status === 'no_show') {
        actionButtons = `
          <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
            <span style="font-size: 0.72rem; color: #7e22ce; font-weight: 600;">Slot Reopened</span>
            ${deleteBtn}
          </div>
        `;
      } else if (a.status === 'cancelled') {
        actionButtons = `
          <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
            <span style="font-size: 0.72rem; color: var(--danger); font-weight: 600;">Slot Reopened</span>
            ${deleteBtn}
          </div>
        `;
      } else {
        actionButtons = `
          <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
            <span style="font-size: 0.72rem; color: var(--neutral-500); font-weight: 600;">Completed</span>
            ${deleteBtn}
          </div>
        `;
      }

      return `
        <tr>
          <td><strong>${a.id}</strong></td>
          <td>
            <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${a.doc_color || '#2563eb'}; margin-right: 4px;"></span>
            ${a.doc_name || a.doctor_name}
          </td>
          <td>
            <strong>${a.patient_name}</strong>
            <span style="font-size: 0.72rem; color: var(--neutral-500);">(${a.patient_relationship || 'Self'})</span>
          </td>
          <td>${a.client_phone}</td>
          <td>${a.service_name}</td>
          <td>
            <strong>${a.date}</strong><br>
            <span style="font-size: 0.75rem; color: var(--neutral-600);">${formatTime12(a.start_time)} - ${formatTime12(a.end_time)}</span>
          </td>
          <td><strong style="color: var(--primary-dark);">${formatPrice(a.fee)}</strong></td>
          <td>
            <span class="apt-badge ${a.status}">${a.status === 'no_show' ? 'No-Show' : a.status}</span>
          </td>
          <td>
            <span style="font-size: 0.75rem; color: ${a.confirmation_sent_at ? 'var(--success)' : 'var(--neutral-500)'}; font-weight: 600;">
              ${reminderSent}
            </span>
          </td>
          <td>
            ${actionButtons}
          </td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.error('Error loading appointments roster:', e);
  }
}

async function exportAppointmentsExcel() {
  try {
    showToast('Generating Excel appointments spreadsheet (.xlsx)...', 'info');
    const docFilter = document.getElementById('filterDoctor') ? document.getElementById('filterDoctor').value : 'all';
    const statusFilter = document.getElementById('filterStatus') ? document.getElementById('filterStatus').value : 'all';
    const searchFilter = document.getElementById('filterSearch') ? document.getElementById('filterSearch').value : '';
    const token = localStorage.getItem('clinic_auth_token') || '';

    const exportUrl = `/api/appointments/export-excel?doctor_id=${encodeURIComponent(docFilter)}&status=${encodeURIComponent(statusFilter)}&search=${encodeURIComponent(searchFilter)}&token=${encodeURIComponent(token)}`;
    const res = await fetch(exportUrl);

    if (!res.ok) {
      const errText = await res.text();
      showToast('Excel export failed: ' + (errText || res.statusText), 'error');
      return;
    }

    const blob = await res.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const todayStr = getTodayStr();
    link.href = downloadUrl;
    link.download = `clinic_appointments_${todayStr}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(downloadUrl);

    showToast('Appointments Excel (.xlsx) file downloaded successfully!', 'success');
  } catch (err) {
    console.error('Export Excel error:', err);
    showToast('Excel export failed: ' + err.message, 'error');
  }
}

async function exportAppointmentsCSV() {
  try {
    showToast('Preparing appointments CSV export...', 'info');
    const docFilter = document.getElementById('filterDoctor') ? document.getElementById('filterDoctor').value : 'all';
    const statusFilter = document.getElementById('filterStatus') ? document.getElementById('filterStatus').value : 'all';
    const searchFilter = document.getElementById('filterSearch') ? document.getElementById('filterSearch').value : '';
    const token = localStorage.getItem('clinic_auth_token') || '';

    // Direct fetch from authenticated CSV endpoint
    const exportUrl = `/api/appointments/export-csv?doctor_id=${encodeURIComponent(docFilter)}&status=${encodeURIComponent(statusFilter)}&search=${encodeURIComponent(searchFilter)}&token=${encodeURIComponent(token)}`;
    const res = await fetch(exportUrl);
    
    if (!res.ok) {
      const errText = await res.text();
      showToast('Export failed: ' + (errText || res.statusText), 'error');
      return;
    }

    const blob = await res.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const todayStr = getTodayStr();
    link.href = downloadUrl;
    link.download = `clinic_appointments_${todayStr}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(downloadUrl);

    showToast('Appointments CSV exported and downloaded successfully!', 'success');
  } catch (err) {
    console.error('Export CSV error:', err);
    showToast('Export failed: ' + err.message, 'error');
  }
}

// ----------------------------------------------------
// PATIENT IMPORT & SAMPLE TEMPLATES (EXCEL & CSV)
// ----------------------------------------------------
let selectedPatientImportFile = null;

function downloadSamplePatientsTemplate(format = 'xlsx') {
  const token = localStorage.getItem('clinic_auth_token') || '';
  const url = `/api/clients/sample-template?format=${encodeURIComponent(format)}&token=${encodeURIComponent(token)}`;
  window.open(url, '_blank');
}

function openImportPatientsModal() {
  clearSelectedImportFile();
  openModal('importPatientsModal');
  setupDropZonePatients();
}

function handleFileSelectedForImport(event) {
  const file = event.target && event.target.files && event.target.files[0];
  if (file) {
    setImportFile(file);
  }
}

function setImportFile(file) {
  selectedPatientImportFile = file;
  const preview = document.getElementById('importFilePreview');
  const nameEl = document.getElementById('importFileName');
  const metaEl = document.getElementById('importFileMeta');
  const btn = document.getElementById('btnStartPatientImport');
  if (preview && nameEl && metaEl && btn) {
    preview.style.display = 'block';
    nameEl.textContent = file.name;
    const sizeKb = (file.size / 1024).toFixed(1);
    metaEl.textContent = `Size: ${sizeKb} KB • Ready for import`;
    btn.disabled = false;
  }
}

function clearSelectedImportFile() {
  selectedPatientImportFile = null;
  const input = document.getElementById('filePatientImport');
  if (input) input.value = '';
  const preview = document.getElementById('importFilePreview');
  if (preview) preview.style.display = 'none';
  const btn = document.getElementById('btnStartPatientImport');
  if (btn) btn.disabled = true;
}

function setupDropZonePatients() {
  const dropZone = document.getElementById('dropZonePatients');
  if (!dropZone || dropZone._dropInitialized) return;
  dropZone._dropInitialized = true;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.borderColor = '#0284c7';
      dropZone.style.background = '#f0f9ff';
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.borderColor = '#94a3b8';
      dropZone.style.background = '#fafafa';
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files[0]) {
      setImportFile(dt.files[0]);
    }
  }, false);
}

async function handleConfirmImportPatients() {
  if (!selectedPatientImportFile) {
    showToast('Please select an Excel or CSV file to import.', 'warning');
    return;
  }

  const btn = document.getElementById('btnStartPatientImport');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> Parsing & Importing Records...';
  }

  try {
    const formData = new FormData();
    formData.append('file', selectedPatientImportFile);

    const token = localStorage.getItem('clinic_auth_token') || '';
    const res = await fetch(`/api/clients/import?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (data.success) {
      closeModal('importPatientsModal');
      clearSelectedImportFile();
      showToast(data.message || `Imported ${data.importedCount} patients successfully!`, 'success');
      if (typeof loadClientsTable === 'function') await loadClientsTable();
      if (typeof loadAppointmentsTable === 'function') await loadAppointmentsTable();
    } else {
      showToast(data.error || 'Failed to import patient records.', 'error');
    }
  } catch (err) {
    console.error('Import error:', err);
    showToast('Error during import: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Start Import';
    }
  }
}

async function deleteAppointment(id) {
  if (!confirm(`Are you sure you want to permanently delete appointment ${id} from the database? This cannot be undone.`)) {
    return;
  }
  try {
    const res = await fetch(`/api/appointments/${encodeURIComponent(id)}?hard=true`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Appointment ${id} permanently deleted.`, 'success');
      loadAppointmentsTable();
      if (typeof loadCalendar === 'function') loadCalendar();
    } else {
      showToast(data.error || 'Failed to delete appointment', 'error');
    }
  } catch (e) {
    showToast('Error deleting appointment: ' + e.message, 'error');
  }
}

async function deleteClient(phone, name) {
  if (!confirm(`Are you sure you want to delete client "${name || phone}" (${phone}) and all associated family patient profiles?`)) {
    return;
  }
  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(phone)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Client ${name || phone} deleted successfully.`, 'success');
      loadClientsTable();
      if (typeof loadAppointmentsTable === 'function') loadAppointmentsTable();
      if (typeof loadCalendar === 'function') loadCalendar();
    } else {
      showToast(data.error || 'Failed to delete client', 'error');
    }
  } catch (e) {
    showToast('Error deleting client: ' + e.message, 'error');
  }
}

// ----------------------------------------------------
// 7. CLIENTS & PATIENTS
// ----------------------------------------------------
async function loadClientsTable() {
  const tbody = document.getElementById('clientsTableBody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/clients');
    const data = await res.json();

    if (!data.success || !data.clients || data.clients.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">No registered clients found.</td></tr>';
      return;
    }

    tbody.innerHTML = data.clients.map(c => {
      const patientTags = (c.patients || []).map(p => `
        <span style="background: var(--neutral-100); border: 1px solid var(--neutral-300); padding: 3px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; display: inline-flex; align-items: center; gap: 4px; margin: 2px 2px;">
          👤 ${escapeHtml(p.full_name)} <small style="color: var(--primary-dark); font-weight: 700;">(${escapeHtml(p.relationship || 'Self')})</small>
        </span>
      `).join(' ');

      const canManageClients = hasPermission('clients_manage');
      const deleteClientBtn = canManageClients ? `
        <button class="btn-secondary" style="padding: 4px 10px; font-size: 0.75rem; font-weight: 600; color: #dc2626; border-color: #fca5a5;" onclick="deleteClient('${escapeHtml(c.phone)}', '${escapeHtml(c.registered_name)}')">
          🗑️ Delete
        </button>
      ` : '';

      return `
        <tr>
          <td><strong style="color: var(--neutral-900);">📱 ${escapeHtml(c.phone)}</strong></td>
          <td><span style="font-weight: 600; color: var(--neutral-900);">${escapeHtml(c.registered_name)}</span></td>
          <td style="max-width: 340px;">${patientTags || '<em style="color: #94a3b8;">No profiles</em>'}</td>
          <td><strong>${(c.appointments || []).length}</strong> booking(s)</td>
          <td style="font-size: 0.75rem; color: var(--neutral-500);">${c.created_at ? c.created_at.split(' ')[0] : 'Registered'}</td>
          <td>
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
              <button class="btn-primary" style="padding: 4px 10px; font-size: 0.75rem; font-weight: 600;" onclick="openEditClientModal('${escapeHtml(c.phone)}')">
                ✏️ Edit Profile & Family
              </button>
              ${deleteClientBtn}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.error('Error loading clients:', e);
  }
}

async function openEditClientModal(phone) {
  try {
    const { ok, status, data } = await safeFetchJson(`/api/clients/${encodeURIComponent(phone)}`);
    if (!ok || !data.success) {
      showToast('Could not load client details (HTTP ' + status + ')', 'error');
      return;
    }

    const client = data.client;
    const patients = data.patients || [];
    const appointments = data.appointments || [];

    document.getElementById('editClientPhone').value = client.phone || '';
    document.getElementById('editClientName').value = client.registered_name || '';
    const phoneInfo = document.getElementById('editClientDisplayPhone');
    if (phoneInfo) {
      phoneInfo.textContent = `Mobile: ${client.phone} • Registered: ${client.created_at || 'Active'}`;
    }

    // Render family member list
    renderClientModalPatients(patients);

    // Hide inline add box
    const addBox = document.getElementById('inlineAddPatientBox');
    if (addBox) addBox.style.display = 'none';

    openModal('editClientModal');
  } catch (err) {
    showToast('Error opening client editor: ' + err.message, 'error');
  }
}

function renderClientModalPatients(patients) {
  const container = document.getElementById('editClientPatientsList');
  if (!container) return;

  if (!patients || patients.length === 0) {
    container.innerHTML = '<div style="text-align: center; color: var(--neutral-500); padding: 16px; background: var(--neutral-50); border-radius: 8px;">No individual patient profiles registered yet.</div>';
    return;
  }

  container.innerHTML = patients.map(p => `
    <div class="patient-card" id="patientCard_${p.id}" style="border: 1px solid var(--neutral-300); border-radius: 8px; padding: 12px 14px; background: white; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.03);">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 220px;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px;">
            <span style="font-weight: 700; color: var(--neutral-900); font-size: 0.95rem;">👤 ${escapeHtml(p.full_name)}</span>
            <span style="background: var(--neutral-100); border: 1px solid var(--neutral-300); color: var(--primary-dark); font-weight: 600; font-size: 0.72rem; padding: 2px 8px; border-radius: 12px;">
              ${escapeHtml(p.relationship || 'Self')}
            </span>
            ${p.medical_notes ? '<span style="font-size: 0.7rem; background: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 4px; font-weight: 600;">📋 Notes attached</span>' : ''}
          </div>
          <div style="font-size: 0.75rem; color: var(--neutral-500);">
            Profile ID: #${p.id} ${p.created_at ? '• Added: ' + p.created_at.split(' ')[0] : ''}
            ${p.medical_notes ? `<div style="margin-top: 4px; font-size: 0.75rem; color: var(--neutral-700); background: #f8fafc; padding: 4px 8px; border-radius: 4px; border: 1px solid #e2e8f0;"><strong>Notes:</strong> ${escapeHtml(p.medical_notes)}</div>` : ''}
          </div>
        </div>
        <div style="display: flex; gap: 6px; align-self: flex-start;">
          <button type="button" class="btn-secondary" style="padding: 4px 10px; font-size: 0.75rem; font-weight: 600;" onclick="togglePatientEditRow(${p.id})">
            ✏️ Edit
          </button>
          <button type="button" class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem; color: var(--danger); border-color: #fca5a5;" onclick="deletePatientProfile(${p.id}, '${escapeHtml(p.full_name)}')">
            🗑️ Delete
          </button>
        </div>
      </div>

      <!-- Expandable inline edit row -->
      <div id="patientEditRow_${p.id}" style="display: none; border-top: 1px dashed var(--neutral-300); padding-top: 10px; margin-top: 10px; background: var(--neutral-50); border-radius: 6px; padding: 10px 12px;">
        <div style="font-weight: 600; font-size: 0.8rem; margin-bottom: 8px; color: var(--neutral-800);">Edit Profile Details:</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 8px;">
          <div>
            <label style="display: block; font-size: 0.72rem; font-weight: 600; margin-bottom: 3px; color: var(--neutral-600);">Full Patient Name *</label>
            <input type="text" id="patientName_${p.id}" value="${escapeHtml(p.full_name)}" style="width: 100%; font-size: 0.85rem; padding: 6px 8px; border: 1px solid var(--neutral-300); border-radius: 6px;" />
          </div>
          <div>
            <label style="display: block; font-size: 0.72rem; font-weight: 600; margin-bottom: 3px; color: var(--neutral-600);">Relationship</label>
            <input type="text" id="patientRel_${p.id}" value="${escapeHtml(p.relationship || 'Self')}" placeholder="e.g. Self, Spouse, Child, Parent" style="width: 100%; font-size: 0.85rem; padding: 6px 8px; border: 1px solid var(--neutral-300); border-radius: 6px;" />
          </div>
        </div>
        <div style="margin-bottom: 8px;">
          <label style="display: block; font-size: 0.72rem; font-weight: 600; margin-bottom: 3px; color: var(--neutral-600);">Medical Notes / Allergies / Context</label>
          <input type="text" id="patientNotes_${p.id}" value="${escapeHtml(p.medical_notes || '')}" placeholder="Optional medical history, allergies, or notes" style="width: 100%; font-size: 0.85rem; padding: 6px 8px; border: 1px solid var(--neutral-300); border-radius: 6px;" />
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn-secondary" style="padding: 4px 10px; font-size: 0.75rem;" onclick="togglePatientEditRow(${p.id})">Cancel</button>
          <button type="button" class="btn-primary" style="padding: 4px 14px; font-size: 0.75rem;" onclick="savePatientProfileUpdate(${p.id})">💾 Save Profile Changes</button>
        </div>
      </div>
    </div>
  `).join('');
}

function togglePatientEditRow(patientId) {
  const row = document.getElementById(`patientEditRow_${patientId}`);
  if (row) {
    row.style.display = row.style.display === 'none' ? 'block' : 'none';
  }
}

function toggleInlineAddPatient() {
  const box = document.getElementById('inlineAddPatientBox');
  if (box) {
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
    if (box.style.display === 'block') {
      const nameInp = document.getElementById('newMemberName');
      if (nameInp) nameInp.focus();
    }
  }
}

async function saveClientPrimaryName() {
  const phone = document.getElementById('editClientPhone').value;
  const newName = document.getElementById('editClientName').value.trim();

  if (!newName) {
    showToast('Primary account holder name cannot be empty', 'error');
    return;
  }

  try {
    const { ok, status, data } = await safeFetchJson(`/api/clients/${encodeURIComponent(phone)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registered_name: newName })
    });

    if (ok && data.success) {
      showToast('Primary account holder name updated!', 'success');
      await openEditClientModal(phone);
      await loadClientsTable();
      if (typeof loadAppointmentsTable === 'function') loadAppointmentsTable();
      if (typeof loadCalendar === 'function') loadCalendar();
    } else {
      showToast('Failed to update client name: ' + (data && data.error ? data.error : `HTTP ${status}`), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function savePatientProfileUpdate(patientId) {
  const fullName = document.getElementById(`patientName_${patientId}`).value.trim();
  const relationship = document.getElementById(`patientRel_${patientId}`).value.trim();
  const medicalNotes = document.getElementById(`patientNotes_${patientId}`).value.trim();

  if (!fullName) {
    showToast('Patient name cannot be empty', 'error');
    return;
  }

  try {
    const { ok, status, data } = await safeFetchJson(`/api/patients/${patientId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: fullName,
        relationship: relationship || 'Family Member',
        medical_notes: medicalNotes
      })
    });

    if (ok && data.success) {
      showToast(`Profile for "${fullName}" updated!`, 'success');
      const phone = document.getElementById('editClientPhone').value;
      await openEditClientModal(phone);
      await loadClientsTable();
      if (typeof loadAppointmentsTable === 'function') loadAppointmentsTable();
      if (typeof loadCalendar === 'function') loadCalendar();
    } else {
      showToast('Failed to update patient: ' + (data && data.error ? data.error : `HTTP ${status}`), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function saveNewPatientToClient() {
  const phone = document.getElementById('editClientPhone').value;
  const fullName = document.getElementById('newMemberName').value.trim();
  const relationship = document.getElementById('newMemberRel').value.trim() || 'Family Member';
  const medicalNotes = document.getElementById('newMemberNotes').value.trim();

  if (!fullName) {
    showToast('Please enter the family member name', 'error');
    return;
  }

  try {
    const { ok, status, data } = await safeFetchJson('/api/clients/patient', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientPhone: phone,
        fullName: fullName,
        relationship: relationship,
        medical_notes: medicalNotes
      })
    });

    if (ok && data.success) {
      showToast(`Family member "${fullName}" added!`, 'success');
      document.getElementById('newMemberName').value = '';
      document.getElementById('newMemberRel').value = '';
      document.getElementById('newMemberNotes').value = '';
      document.getElementById('inlineAddPatientBox').style.display = 'none';

      await openEditClientModal(phone);
      await loadClientsTable();
    } else {
      showToast('Failed to add member: ' + (data && data.error ? data.error : `HTTP ${status}`), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function deletePatientProfile(patientId, patientName) {
  if (!confirm(`Are you sure you want to delete the profile for "${patientName}"? This action cannot be undone.`)) {
    return;
  }

  try {
    const { ok, status, data } = await safeFetchJson(`/api/patients/${patientId}`, {
      method: 'DELETE'
    });

    if (ok && data.success) {
      showToast(`Profile for "${patientName}" deleted.`, 'info');
      const phone = document.getElementById('editClientPhone').value;
      await openEditClientModal(phone);
      await loadClientsTable();
    } else {
      showToast(data && data.error ? data.error : `Failed to delete (HTTP ${status})`, 'error');
    }
  } catch (err) {
    showToast('Error deleting profile: ' + err.message, 'error');
  }
}

// ----------------------------------------------------
// 8. SERVICES & PRICING
// ----------------------------------------------------
async function loadServices() {
  try {
    const res = await fetch('/api/services');
    const data = await res.json();
    if (data.success) {
      state.services = data.services;
    }
  } catch (e) {
    console.error('Error loading services:', e);
  }
}

async function loadServicesTable() {
  await loadServices();
  const tbody = document.getElementById('servicesTableBody');
  if (!tbody) return;

  if (!state.services || state.services.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 20px;">No services in catalog.</td></tr>';
    return;
  }

  tbody.innerHTML = state.services.map(s => {
    const isActive = (s.is_active === 1);
    return `
      <tr style="${!isActive ? 'opacity: 0.7; background: #fafafa;' : ''}">
        <td><strong>${escapeHtml(s.name)}</strong></td>
        <td>${s.doctor_name ? '👨‍⚕️ ' + escapeHtml(s.doctor_name) : '<span style="color: var(--neutral-600);">🌐 All Physicians</span>'}</td>
        <td>${s.duration_minutes} mins</td>
        <td><strong style="color: var(--primary-dark);">${formatPrice(s.price)}</strong></td>
        <td style="font-size: 0.8rem; color: var(--neutral-600); max-width: 220px;">${escapeHtml(s.description || '—')}</td>
        <td>
          ${isActive 
            ? '<span style="font-size: 0.72rem; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0;">Active</span>' 
            : '<span style="font-size: 0.72rem; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca;">Inactive</span>'
          }
        </td>
        <td>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button class="btn-primary" style="padding: 4px 10px; font-size: 0.75rem; font-weight: 600;" onclick="openEditServiceModal(${s.id})">
              ✏️ Edit
            </button>
            ${isActive ? `
              <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem; color: var(--danger); border-color: #fca5a5;" onclick="deleteService(${s.id})">
                Deactivate
              </button>
            ` : `
              <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem; color: var(--success); border-color: #86efac;" onclick="reactivateService(${s.id})">
                Reactivate
              </button>
            `}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function openAddServiceModal() {
  updateCurrencyUIElements();
  openModal('serviceModal');
}

async function openEditServiceModal(serviceId) {
  updateCurrencyUIElements();
  let srv = state.services.find(s => s.id === serviceId);
  if (!srv) {
    try {
      const { ok, data } = await safeFetchJson(`/api/services/${serviceId}`);
      if (ok && data.success && data.service) {
        srv = data.service;
      }
    } catch (e) {
      console.error(e);
    }
  }

  if (!srv) {
    showToast('Could not load service details', 'error');
    return;
  }

  document.getElementById('editSrvId').value = srv.id;
  document.getElementById('editSrvName').value = srv.name || '';
  document.getElementById('editSrvDoctor').value = srv.doctor_id || '';
  document.getElementById('editSrvDuration').value = srv.duration_minutes || 30;
  document.getElementById('editSrvPrice').value = srv.price !== undefined ? srv.price : 0;
  document.getElementById('editSrvDesc').value = srv.description || '';
  document.getElementById('editSrvActive').checked = (srv.is_active === 1);

  openModal('editServiceModal');
}

async function handleServiceSubmit(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('srvName').value.trim(),
    doctor_id: document.getElementById('srvDoctor').value || null,
    duration_minutes: parseInt(document.getElementById('srvDuration').value, 10),
    price: parseFloat(document.getElementById('srvPrice').value),
    description: document.getElementById('srvDesc').value.trim()
  };

  try {
    const res = await fetch('/api/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      closeModal('serviceModal');
      showToast(`Service "${payload.name}" added to catalog!`, 'success');
      await loadServices();
      loadServicesTable();
    } else {
      showToast('Failed to add service: ' + (data.error || 'Server error'), 'error');
    }
  } catch (err) {
    showToast('Failed to add service: ' + err.message, 'error');
  }
}

async function handleServiceUpdateSubmit(e) {
  e.preventDefault();
  const srvId = document.getElementById('editSrvId').value;
  const payload = {
    name: document.getElementById('editSrvName').value.trim(),
    doctor_id: document.getElementById('editSrvDoctor').value || null,
    duration_minutes: parseInt(document.getElementById('editSrvDuration').value, 10),
    price: parseFloat(document.getElementById('editSrvPrice').value),
    description: document.getElementById('editSrvDesc').value.trim(),
    is_active: document.getElementById('editSrvActive').checked ? 1 : 0
  };

  if (!payload.name) {
    showToast('Service name is required', 'error');
    return;
  }

  try {
    const { ok, status, data } = await safeFetchJson(`/api/services/${srvId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (ok && data.success) {
      closeModal('editServiceModal');
      showToast(`Service "${payload.name}" updated successfully!`, 'success');
      await loadServices();
      loadServicesTable();
    } else {
      showToast('Failed to update service: ' + (data && data.error ? data.error : `HTTP ${status}`), 'error');
    }
  } catch (err) {
    showToast('Error updating service: ' + err.message, 'error');
  }
}

async function deleteService(id) {
  if (!confirm('Deactivate this service from the catalog?')) return;
  try {
    await fetch(`/api/services/${id}`, { method: 'DELETE' });
    showToast('Service deactivated.', 'info');
    await loadServices();
    loadServicesTable();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function reactivateService(serviceId) {
  try {
    const { ok, data } = await safeFetchJson(`/api/services/${serviceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: 1 })
    });
    if (ok && data.success) {
      showToast('Service reactivated!', 'success');
      await loadServices();
      loadServicesTable();
    }
  } catch (err) {
    showToast('Error reactivating service: ' + err.message, 'error');
  }
}

// ----------------------------------------------------
// 9. DOCTOR PERSONAL ALERTS FEED
// ----------------------------------------------------
async function loadNotifications() {
  try {
    const res = await fetch('/api/notifications');
    const data = await res.json();

    if (data.success && data.notifications) {
      document.getElementById('notifCountBadge').textContent = data.notifications.length;
      const container = document.getElementById('notificationsContainer');
      if (!container) return;

      if (data.notifications.length === 0) {
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--neutral-500);">No doctor personal alerts yet.</div>';
        return;
      }

      container.innerHTML = data.notifications.map(n => {
        let typeBadge = '';
        if (n.type === 'new_booking') typeBadge = '<span class="apt-badge confirmed">New Booking</span>';
        else if (n.type === 'rescheduled') typeBadge = '<span class="apt-badge tentative">Rescheduled</span>';
        else if (n.type === 'cancelled') typeBadge = '<span class="apt-badge cancelled">Cancelled</span>';
        else if (n.type === 'confirmation_update') typeBadge = '<span class="apt-badge confirmed">24h Confirmed</span>';
        else typeBadge = '<span class="apt-badge tentative">24h Ping Dispatched</span>';

        return `
          <div style="background: #ffffff; border: 1px solid var(--neutral-200); border-radius: var(--radius-md); padding: 12px 16px; box-shadow: var(--shadow-sm); display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;">
            <div>
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                ${typeBadge}
                <span style="font-size: 0.75rem; color: var(--neutral-500);">${n.created_at}</span>
              </div>
              <div style="font-size: 0.85rem; color: var(--neutral-900); font-weight: 500;">
                ${n.message}
              </div>
            </div>
            <div style="font-size: 0.75rem; color: var(--neutral-500); text-align: right; white-space: nowrap;">
              📱 Sent to Doctor's Phone
            </div>
          </div>
        `;
      }).join('');
    }
  } catch (e) {
    console.error('Error loading notifications:', e);
  }
}

// ----------------------------------------------------
// 10. 24-HOUR CONFIRMATION ENGINE TRIGGER
// ----------------------------------------------------
async function trigger24HourCheck(forceMarkUnconfirmed = false) {
  try {
    showToast('Executing 24-Hour AI Confirmation routine...', 'info');
    const res = await fetch('/api/reminders/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceDate: null, forceMarkUnconfirmed })
    });
    const data = await res.json();

    if (data.success) {
      const actions = data.result.actions || [];
      if (actions.length === 0) {
        showToast('All upcoming appointments already checked or confirmed.', 'info');
      } else {
        const sent = actions.filter(a => a.type === 'reminder_sent').length;
        const tentative = actions.filter(a => a.type === 'marked_tentative').length;
        showToast(`24h Scan Complete: ${sent} reminders dispatched, ${tentative} marked tentative.`, 'success');
      }
      loadCalendar();
      loadAppointmentsTable();
      loadNotifications();
      loadSimulatorChat();
    }
  } catch (e) {
    showToast('24h check failed: ' + e.message, 'error');
  }
}

// ----------------------------------------------------
// 11. WALK-IN / MANUAL BOOKING MODAL
// ----------------------------------------------------
function openWalkinModal() {
  populateDoctorFilters();
  handleDoctorChangeInWalkin();
  const clinicInfo = getLocalClinicTime();
  const wbDateEl = document.getElementById('wbDate');
  if (wbDateEl) {
    wbDateEl.min = clinicInfo.dateStr;
    wbDateEl.value = clinicInfo.dateStr;
  }
  const wbClock = document.getElementById('wbClinicClock');
  if (wbClock) wbClock.textContent = clinicInfo.time12Short;
  const wbTz = document.getElementById('wbClinicTz');
  if (wbTz) wbTz.textContent = getActiveClinicTzLabel();
  updateWalkinSlots();
  openModal('walkinModal');
}

function handleDoctorChangeInWalkin() {
  const docId = document.getElementById('wbDoctor').value;
  const srvSelect = document.getElementById('wbService');

  const docServices = state.services.filter(s => !s.doctor_id || String(s.doctor_id) === String(docId));
  srvSelect.innerHTML = docServices.map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${s.duration_minutes} min - ${formatPrice(s.price)})</option>`).join('');
  updateWalkinSlots();
}

async function updateWalkinSlots() {
  const docId = document.getElementById('wbDoctor').value;
  const date = document.getElementById('wbDate').value;
  const slotSelect = document.getElementById('wbSlot');
  slotSelect.innerHTML = '<option>Loading available slots...</option>';

  if (!docId || !date) return;

  try {
    const res = await fetch(`/api/slots/available?doctor_id=${docId}&date=${date}`);
    const data = await res.json();

    if (data.success && data.slots && data.slots.length > 0) {
      slotSelect.innerHTML = data.slots.map(s => `
        <option value="${s.startTime}">${s.displayTime} - ${s.displayEnd}</option>
      `).join('');
    } else {
      slotSelect.innerHTML = `<option value="">No slots open (${data.reason || 'Closed / All Passed'})</option>`;
    }
  } catch (e) {
    slotSelect.innerHTML = '<option value="">Error loading slots</option>';
  }
}

async function handleManualBooking(e) {
  e.preventDefault();
  const payload = {
    doctorId: document.getElementById('wbDoctor').value,
    clientPhone: document.getElementById('wbClientPhone').value,
    patientName: document.getElementById('wbPatientName').value,
    relationship: document.getElementById('wbRelationship').value,
    serviceId: document.getElementById('wbService').value,
    date: document.getElementById('wbDate').value,
    startTime: document.getElementById('wbSlot').value,
    notes: document.getElementById('wbNotes').value
  };

  if (!payload.startTime) {
    showToast('Please select a valid upcoming time slot.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      closeModal('walkinModal');
      showToast(`Appointment ${data.appointmentId} booked! WhatsApp confirmation dispatched to client.`, 'success');
      loadCalendar();
      loadAppointmentsTable();
      loadNotifications();
      loadSimulatorChat();
    } else {
      showToast(data.error || 'Failed to create booking', 'error');
    }
  } catch (err) {
    showToast('Failed to create booking: ' + err.message, 'error');
  }
}

// ----------------------------------------------------
// 12. RESCHEDULE & CANCEL WORKFLOWS
// ----------------------------------------------------
async function openRescheduleModal(appointmentId) {
  const res = await fetch(`/api/appointments?search=${appointmentId}`);
  const data = await res.json();

  if (!data.success || data.appointments.length === 0) {
    alert('Appointment not found.');
    return;
  }

  const apt = data.appointments[0];
  document.getElementById('rsAptId').value = apt.id;
  document.getElementById('rsCurrentSummary').innerHTML = `
    <strong>${apt.id}</strong> — Patient: <strong>${apt.patient_name}</strong><br>
    Doctor: <strong>${apt.doc_name || apt.doctor_name}</strong> | Service: <strong>${apt.service_name}</strong><br>
    Current Date: <strong>${apt.date}</strong> at <strong>${formatTime12(apt.start_time)}</strong>
  `;

  document.getElementById('rsDoctorSelect').value = apt.doctor_id;
  const clinicDate = getLocalClinicTime().dateStr;
  const rsDateInp = document.getElementById('rsNewDate');
  if (rsDateInp) {
    rsDateInp.min = clinicDate;
    rsDateInp.value = apt.date < clinicDate ? clinicDate : apt.date;
  }

  await updateRescheduleSlots();
  openModal('rescheduleModal');
}

async function updateRescheduleSlots() {
  const docId = document.getElementById('rsDoctorSelect').value;
  const date = document.getElementById('rsNewDate').value;
  const aptId = document.getElementById('rsAptId').value;
  const slotSelect = document.getElementById('rsNewSlot');

  slotSelect.innerHTML = '<option>Loading slots...</option>';

  try {
    const res = await fetch(`/api/slots/available?doctor_id=${docId}&date=${date}&excludeId=${aptId}`);
    const data = await res.json();

    if (data.success && data.slots && data.slots.length > 0) {
      slotSelect.innerHTML = data.slots.map(s => `
        <option value="${s.startTime}">${s.displayTime} - ${s.displayEnd}</option>
      `).join('');
    } else {
      slotSelect.innerHTML = `<option value="">No slots open (${data.reason || 'Closed'})</option>`;
    }
  } catch (e) {
    slotSelect.innerHTML = '<option value="">Error loading slots</option>';
  }
}

async function handleRescheduleSubmit(e) {
  e.preventDefault();
  const aptId = document.getElementById('rsAptId').value;
  const newDoctorId = document.getElementById('rsDoctorSelect').value;
  const newDate = document.getElementById('rsNewDate').value;
  const newStartTime = document.getElementById('rsNewSlot').value;
  const reason = document.getElementById('rsReason').value;

  if (!newStartTime) {
    alert('Please choose an open time slot.');
    return;
  }

  try {
    const res = await fetch(`/api/appointments/${aptId}/reschedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newDoctorId, newDate, newStartTime, reason })
    });
    const data = await res.json();

    if (data.success) {
      closeModal('rescheduleModal');
      showToast(`Appointment ${aptId} rescheduled! Client notified via WhatsApp.`, 'success');
      loadCalendar();
      loadAppointmentsTable();
      loadNotifications();
      loadSimulatorChat();
    } else {
      showToast(data.error || 'Failed to reschedule appointment', 'error');
    }
  } catch (err) {
    showToast('Failed to reschedule: ' + err.message, 'error');
  }
}

async function handleModalNoShow() {
  const aptId = document.getElementById('rsAptId').value;
  if (!aptId) return;
  closeModal('rescheduleModal');
  await markAppointmentNoShow(aptId);
}

async function handleModalCancel() {
  const aptId = document.getElementById('rsAptId').value;
  if (!aptId) return;
  closeModal('rescheduleModal');
  await cancelAppointment(aptId);
}

async function markAppointmentNoShow(appointmentId, patientName) {
  const confirmMsg = patientName
    ? `Mark patient "${patientName}" (Appointment ${appointmentId}) as NO-SHOW?\n\nThis preserves their historical record with status 'no_show' and immediately reopens this time slot for other patients to book.`
    : `Mark appointment ${appointmentId} as NO-SHOW?\n\nThis preserves their historical record with status 'no_show' and immediately reopens this time slot for other patients to book.`;

  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch(`/api/appointments/${appointmentId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'no_show', notifyClient: false })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Appointment ${appointmentId} marked as No-Show. Slot reopened for bookings!`, 'warning');
      loadCalendar();
      loadAppointmentsTable();
      loadNotifications();
      loadSimulatorChat();
    } else {
      showToast('Failed to update status: ' + (data.error || 'Server error'), 'error');
    }
  } catch (err) {
    showToast('Failed to mark No-Show: ' + err.message, 'error');
  }
}

async function cancelAppointment(appointmentId) {
  const reason = prompt('Please enter the cancellation reason (sent to client via WhatsApp):', 'Doctor scheduling conflict');
  if (reason === null) return;

  try {
    const res = await fetch(`/api/appointments/${appointmentId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Appointment ${appointmentId} cancelled. Client notified and slot released.`, 'info');
      loadCalendar();
      loadAppointmentsTable();
      loadNotifications();
      loadSimulatorChat();
    }
  } catch (err) {
    showToast('Failed to cancel: ' + err.message, 'error');
  }
}

// ----------------------------------------------------
// 13. WHATSAPP LIVE SIMULATOR
// ----------------------------------------------------
function switchSimulatorUser() {
  state.activeSimPhone = document.getElementById('simSenderSelect').value;
  loadSimulatorChat();
}

async function loadSimulatorChat() {
  const container = document.getElementById('simMessagesContainer');
  if (!container) return;

  try {
    const res = await fetch(`/api/chat/history?phone=${encodeURIComponent(state.activeSimPhone)}`);
    const data = await res.json();

    if (data.success) {
      const messages = data.messages || [];
      if (messages.length === 0) {
        container.innerHTML = `
          <div style="text-align: center; color: #667781; font-size: 0.78rem; margin-top: 40px; background: rgba(255,255,255,0.7); padding: 12px; border-radius: 8px;">
            🔒 End-to-end encrypted.<br>
            Send a message to begin chatting with <strong>${state.settings.persona_name || 'Aria'}</strong>.
          </div>
        `;
        return;
      }

      container.innerHTML = messages.map(m => {
        const isOutbound = m.direction === 'outbound';
        const sender = isOutbound ? (state.settings.persona_name || 'Apex Assistant') : (m.sender_name || 'You');
        const time = m.created_at ? m.created_at.split(' ')[1]?.slice(0, 5) || '' : '';

        return `
          <div class="chat-bubble ${m.direction}">
            <div style="font-size: 0.68rem; font-weight: 700; color: ${isOutbound ? 'var(--primary-dark)' : '#166534'}; margin-bottom: 2px;">
              ${sender}
            </div>
            <div>${formatWhatsAppMarkdown(m.message)}</div>
            <div class="bubble-meta">${time} ✓✓</div>
          </div>
        `;
      }).join('');

      container.scrollTop = container.scrollHeight;
    }
  } catch (e) {
    console.error('Error loading chat:', e);
  }
}

function formatWhatsAppMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*([^\*]+)\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

async function handleSimSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('simInputField');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  await sendSimulatorMessage(message);
}

function sendSimQuick(text) {
  sendSimulatorMessage(text);
}

async function sendSimulatorMessage(text) {
  const container = document.getElementById('simMessagesContainer');

  const tempBubble = document.createElement('div');
  tempBubble.className = 'chat-bubble inbound';
  tempBubble.innerHTML = `<div>${text}</div><div class="bubble-meta">Sending...</div>`;
  container.appendChild(tempBubble);
  container.scrollTop = container.scrollHeight;

  try {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: state.activeSimPhone, message: text })
    });
    const data = await res.json();

    if (data.success) {
      await loadSimulatorChat();
      loadCalendar();
      loadAppointmentsTable();
      loadNotifications();
      loadClientsTable();
    }
  } catch (e) {
    showToast('Failed to send WhatsApp message: ' + e.message, 'error');
  }
}

async function resetSimChat() {
  try {
    await fetch('/api/chat/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: state.activeSimPhone })
    });
    showToast('Chat conversation state reset to main menu.', 'info');
    loadSimulatorChat();
  } catch (e) {
    showToast('Failed to reset: ' + e.message, 'error');
  }
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

// ==========================================
// USER MANAGEMENT & RBAC IMPLEMENTATION
// ==========================================
let allSystemPermissions = [];

async function loadUsersTable() {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 24px; color: var(--neutral-500);">Loading staff & physician accounts...</td></tr>`;

  try {
    const res = await fetch('/api/users');
    if (!res.ok) {
      if (res.status === 403) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 24px; color: #dc2626;">Access Denied. You do not have permissions to manage users.</td></tr>`;
        return;
      }
      throw new Error(`Server returned status ${res.status}`);
    }
    const data = await res.json();
    state.users = data.users || [];

    if (state.users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 24px; color: var(--neutral-500);">No user accounts found.</td></tr>`;
      return;
    }

    tbody.innerHTML = state.users.map(u => {
      let roleBadge = '';
      if (u.role === 'admin') {
        roleBadge = `<span class="badge" style="background:#dc2626; color:white; font-weight:700;">ADMIN</span>`;
      } else if (u.role === 'director') {
        roleBadge = `<span class="badge" style="background:#4338ca; color:white; font-weight:700;">DIRECTOR</span>`;
      } else if (u.role === 'doctor') {
        roleBadge = `<span class="badge" style="background:#2563eb; color:white; font-weight:700;">DOCTOR</span>`;
      } else {
        roleBadge = `<span class="badge" style="background:#7e22ce; color:white; font-weight:700;">RECEPTION</span>`;
      }

      const activeBadge = u.is_active
        ? `<span class="badge badge-confirmed">Active</span>`
        : `<span class="badge badge-cancelled">Suspended</span>`;

      const passBadge = u.must_change_password
        ? `<span class="badge badge-tentative" title="Must change password upon next sign-in">⚠️ Must Change</span>`
        : `<span class="badge" style="background:#ecfdf5; color:#065f46; border:1px solid #a7f3d0;">✅ Established</span>`;

      const rightsCount = (u.role === 'admin' || u.role === 'director')
        ? `<span style="font-weight:600; color:#1e40af;">All Rights (Superuser)</span>`
        : `<span style="font-weight:600;">${(u.permissions || []).length} / 15 Rights</span>`;

      const lastLogin = u.last_login_at
        ? new Date(u.last_login_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : `<span style="color:#94a3b8;">Never</span>`;

      const docLinked = u.doctor_name
        ? `<span style="font-weight:600; color:#0f766e;">👨‍⚕️ ${escapeHtml(u.doctor_name)}</span>`
        : `<span style="color:#94a3b8;">—</span>`;

      return `
        <tr>
          <td>
            <div style="font-weight:700; color:var(--neutral-900);">${escapeHtml(u.username)}</div>
            <div style="margin-top:2px;">${roleBadge}</div>
          </td>
          <td>
            <div style="font-weight:600;">${escapeHtml(u.full_name)}</div>
            <div style="font-size:0.75rem; color:var(--neutral-500);">${escapeHtml(u.email || '')}</div>
          </td>
          <td>${docLinked}</td>
          <td>${activeBadge}</td>
          <td>${passBadge}</td>
          <td>
            ${rightsCount}
            ${(u.role !== 'admin' && u.role !== 'director') ? `<div><button class="btn-secondary" style="padding: 2px 6px; font-size: 0.7rem; margin-top: 4px;" onclick="openPermissionsModal(${u.id})">🛡️ Edit Rights</button></div>` : ''}
          </td>
          <td style="font-size:0.78rem; color:var(--neutral-600);">${lastLogin}</td>
          <td style="text-align: right; white-space: nowrap;">
            <div style="display: inline-flex; gap: 4px;">
              <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="openEditUserModal(${u.id})" title="Edit Details">✏️</button>
              <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="resetUserPassword(${u.id}, '${escapeHtml(u.username)}')" title="Reset Password">🔄 Reset</button>
              ${u.id !== 1 ? `
                <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem; color: ${u.is_active ? '#dc2626' : '#16a34a'};" onclick="toggleUserActive(${u.id}, ${u.is_active})" title="${u.is_active ? 'Deactivate User' : 'Activate User'}">
                  ${u.is_active ? '🚫 Suspend' : '✅ Activate'}
                </button>
              ` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 24px; color: #dc2626;">Error loading users: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function openAddUserModal() {
  const modal = document.getElementById('userModal');
  if (!modal) return;
  document.getElementById('userModalTitle').textContent = '➕ Add New Staff / Doctor Account';
  const idEl = document.getElementById('userId') || document.getElementById('editUserId');
  if (idEl) idEl.value = '';
  const uInput = document.getElementById('userUsername');
  if (uInput) {
    uInput.value = '';
    uInput.disabled = false;
  }
  const fnInput = document.getElementById('userFullName');
  if (fnInput) fnInput.value = '';
  const emInput = document.getElementById('userEmail');
  if (emInput) emInput.value = '';
  const rInput = document.getElementById('userRole');
  if (rInput) rInput.value = 'doctor';
  const passGrp = document.getElementById('userPasswordGroup');
  if (passGrp) passGrp.style.display = 'block';
  const initPass = document.getElementById('userInitialPassword');
  if (initPass) initPass.value = 'DoctorPass@2026!';
  const actInput = document.getElementById('userIsActive');
  if (actInput) actInput.checked = true;

  populateDoctorSelectDropdown();
  onUserRoleChange();
  modal.style.display = 'flex';
}

function openEditUserModal(userId) {
  const user = (state.users || []).find(u => Number(u.id) === Number(userId));
  if (!user) {
    showToast('User account not found: ID ' + userId, 'error');
    return;
  }

  const modal = document.getElementById('userModal');
  if (!modal) return;
  document.getElementById('userModalTitle').textContent = `✏️ Edit Account: ${user.full_name || user.username} (@${user.username})`;
  const idEl = document.getElementById('userId') || document.getElementById('editUserId');
  if (idEl) idEl.value = user.id;

  const uInput = document.getElementById('userUsername');
  if (uInput) {
    uInput.value = user.username;
    uInput.disabled = true; // Username cannot be modified
  }
  const fnInput = document.getElementById('userFullName');
  if (fnInput) fnInput.value = user.full_name || '';
  const emInput = document.getElementById('userEmail');
  if (emInput) emInput.value = user.email || '';
  const rInput = document.getElementById('userRole');
  if (rInput) rInput.value = user.role;
  const passGrp = document.getElementById('userPasswordGroup');
  if (passGrp) passGrp.style.display = 'none'; // Password is not changed here (use Reset)
  const actInput = document.getElementById('userIsActive');
  if (actInput) actInput.checked = !!user.is_active;

  populateDoctorSelectDropdown(user.doctor_id);
  onUserRoleChange();
  modal.style.display = 'flex';
}

function populateDoctorSelectDropdown(selectedDocId = null) {
  const select = document.getElementById('userDoctorSelect') || document.getElementById('userDoctorId');
  if (!select) return;
  select.innerHTML = '<option value="">-- Choose Doctor from System Directory --</option>';
  (state.doctors || []).forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.name} (${d.specialty})`;
    if (selectedDocId && Number(selectedDocId) === Number(d.id)) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

function onUserRoleChange() {
  const roleEl = document.getElementById('userRole');
  if (!roleEl) return;
  const role = roleEl.value;
  const docGroup = document.getElementById('userDoctorSelectGroup') || document.getElementById('userDoctorGroup');
  if (docGroup) {
    docGroup.style.display = (role === 'doctor') ? 'block' : 'none';
  }
}

async function handleUserSubmit(e) {
  e.preventDefault();
  const idEl = document.getElementById('userId') || document.getElementById('editUserId');
  const userId = idEl ? idEl.value : '';
  const username = document.getElementById('userUsername').value.trim();
  const fullName = document.getElementById('userFullName').value.trim();
  const email = document.getElementById('userEmail').value.trim();
  const role = document.getElementById('userRole').value;
  const docSelect = document.getElementById('userDoctorSelect') || document.getElementById('userDoctorId');
  const doctorId = (role === 'doctor' && docSelect) ? (docSelect.value || null) : null;
  const isActive = document.getElementById('userIsActive').checked ? 1 : 0;
  const initPassEl = document.getElementById('userInitialPassword');
  const initialPassword = initPassEl ? initPassEl.value : 'DoctorPass@2026!';

  const btn = document.getElementById('btnSaveUser');
  btn.disabled = true;
  btn.innerHTML = 'Saving...';

  try {
    let res;
    if (userId) {
      res = await fetch(`/api/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, email, role, doctorId, is_active: isActive, isActive })
      });
    } else {
      res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, fullName, email, role, doctorId, password: initialPassword, is_active: isActive, isActive })
      });
    }

    const data = await res.json();
    if (data.success) {
      closeModal('userModal');
      showToast(userId ? 'User updated successfully!' : 'New user created successfully!', 'success');
      await loadUsersTable();
    } else {
      showToast(data.error || 'Failed to save user.', 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Save User Account';
  }
}

async function resetUserPassword(userId, username) {
  if (!confirm(`Are you sure you want to reset the password for "${username}"?\n\nA new temporary password will be automatically generated and dispatched directly to their registered WhatsApp and Email.`)) {
    return;
  }

  try {
    const res = await fetch(`/api/users/${userId}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();

    if (data.success && data.tempPassword) {
      state.lastGeneratedTempPass = data.tempPassword;

      const targetUserEl = document.getElementById('resetModalTargetUser');
      if (targetUserEl) {
        targetUserEl.textContent = `Staff Account: ${data.fullName || username} (@${data.username || username})`;
      }
      const dispEl = document.getElementById('resetModalDispatchedTo');
      if (dispEl) {
        const waText = data.dispatchedTo && data.dispatchedTo.whatsapp ? data.dispatchedTo.whatsapp : 'Registered WhatsApp on file';
        const emText = data.dispatchedTo && data.dispatchedTo.email ? data.dispatchedTo.email : 'Clinic email';
        dispEl.textContent = `Dispatched to: WhatsApp (${waText}) • Email (${emText})`;
      }
      const tempPassEl = document.getElementById('resetModalTempPass');
      if (tempPassEl) {
        tempPassEl.textContent = data.tempPassword;
      }

      const resetModal = document.getElementById('userResetPassModal');
      if (resetModal) {
        resetModal.style.display = 'flex';
      } else {
        alert(`✅ Temporary Password for "${username}":\n\n${data.tempPassword}\n\nDispatched to WhatsApp and Email. The user must change it upon their next sign-in.`);
      }

      showToast('Password reset! Temporary password dispatched.', 'success');
      await loadUsersTable();
    } else {
      showToast(data.error || 'Failed to reset password.', 'error');
    }
  } catch (err) {
    showToast('Error resetting password: ' + err.message, 'error');
  }
}

function copyResetTempPassword() {
  const passEl = document.getElementById('resetModalTempPass');
  if (!passEl) return;
  const text = passEl.textContent.trim();
  navigator.clipboard.writeText(text).then(() => {
    showToast('Temporary password copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Password: ' + text, 'info');
  });
}

async function toggleUserActive(userId, currentActive) {
  const action = currentActive ? 'suspend' : 'activate';
  if (!confirm(`Are you sure you want to ${action} this user account?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/users/${userId}/toggle-active`, {
      method: 'POST'
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
      await loadUsersTable();
    } else {
      showToast(data.error || 'Failed to toggle status.', 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function openPermissionsModal(userId) {
  const user = (state.users || []).find(u => u.id === userId);
  if (!user) return;

  state.currentEditingUserId = userId;
  state.currentEditingUser = user;

  const summaryEl = document.getElementById('permUserSummary');
  if (summaryEl) {
    summaryEl.textContent = `User: ${user.full_name} (@${user.username}) • Role: ${user.role.toUpperCase()}`;
  }

  document.getElementById('permUserId').value = userId;

  // Load permissions definitions if not already cached
  if (!allSystemPermissions || allSystemPermissions.length === 0) {
    try {
      const res = await fetch('/api/auth/permissions-list');
      const data = await res.json();
      allSystemPermissions = data.permissions || [];
    } catch (e) {
      console.error('Failed to load permissions list:', e);
    }
  }

  renderPermissionsCheckboxes(user);
  document.getElementById('permissionsModal').style.display = 'flex';
}

function renderPermissionsCheckboxes(user) {
  const container = document.getElementById('permissionsCategoriesContainer');
  if (!container) return;

  const userPerms = Array.isArray(user.permissions) ? user.permissions : [];
  const isSuper = (user.role === 'admin' || user.role === 'director');

  const categories = {
    'Weekly Calendar & Schedule': ['calendar_view', 'calendar_all_doctors', 'calendar_edit'],
    'Appointments & Booking Operations': ['appointments_view', 'appointments_manage', 'appointments_cancel'],
    'Doctor Profiles & Clinical Settings': ['doctors_view', 'doctors_manage', 'unavailability_view', 'unavailability_manage'],
    'Patient Records & Pricing': ['clients_view', 'pricing_view', 'pricing_manage'],
    'Clinic Administration & RBAC': ['settings_manage', 'users_manage']
  };

  let html = '';
  for (const [catName, keys] of Object.entries(categories)) {
    html += `
      <div style="margin-bottom: 16px; background: white; border: 1px solid var(--neutral-200); border-radius: var(--radius-sm); padding: 12px;">
        <div style="font-weight: 700; font-size: 0.85rem; color: var(--primary-700); margin-bottom: 8px; border-bottom: 1px solid var(--neutral-100); padding-bottom: 4px;">
          📁 ${catName}
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 8px;">
    `;

    keys.forEach(k => {
      const pDef = (allSystemPermissions || []).find(p => p.key === k) || { key: k, label: k, description: '' };
      const checked = (isSuper || userPerms.includes(k)) ? 'checked' : '';
      const disabled = isSuper ? 'disabled' : '';

      html += `
        <label style="display: flex; align-items: flex-start; gap: 8px; font-size: 0.8rem; cursor: pointer; padding: 4px; border-radius: 4px;" class="perm-checkbox-item">
          <input type="checkbox" class="perm-checkbox" value="${pDef.key}" ${checked} ${disabled} style="margin-top: 2px;">
          <div>
            <div style="font-weight: 600; color: var(--neutral-900);">${escapeHtml(pDef.label)}</div>
            <div style="font-size: 0.72rem; color: var(--neutral-500); line-height: 1.3;">${escapeHtml(pDef.description)}</div>
          </div>
        </label>
      `;
    });

    html += `
        </div>
      </div>
    `;
  }

  if (isSuper) {
    html = `<div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: var(--radius-sm); padding: 10px; margin-bottom: 12px; font-size: 0.8rem; color: #1e40af;">
      ℹ️ This user has role <strong>${user.role.toUpperCase()}</strong> which inherently possesses all system permissions. Individual toggles are locked.
    </div>` + html;
  }

  container.innerHTML = html;
}

function selectAllPermissions(select = true) {
  if (state.currentEditingUser && (state.currentEditingUser.role === 'admin' || state.currentEditingUser.role === 'director')) {
    return;
  }
  document.querySelectorAll('.perm-checkbox').forEach(cb => {
    if (!cb.disabled) cb.checked = select;
  });
}

function resetPermissionsToRoleDefault() {
  if (!state.currentEditingUser) return;
  const role = state.currentEditingUser.role;

  const roleDefaults = {
    admin: ['calendar_view', 'calendar_all_doctors', 'calendar_edit', 'appointments_view', 'appointments_manage', 'appointments_cancel', 'doctors_view', 'doctors_manage', 'unavailability_view', 'unavailability_manage', 'clients_view', 'pricing_view', 'pricing_manage', 'settings_manage', 'users_manage'],
    director: ['calendar_view', 'calendar_all_doctors', 'calendar_edit', 'appointments_view', 'appointments_manage', 'appointments_cancel', 'doctors_view', 'doctors_manage', 'unavailability_view', 'unavailability_manage', 'clients_view', 'pricing_view', 'pricing_manage', 'settings_manage', 'users_manage'],
    doctor: ['calendar_view', 'calendar_edit', 'appointments_view', 'appointments_manage', 'unavailability_view', 'unavailability_manage', 'clients_view', 'pricing_view'],
    receptionist: ['calendar_view', 'calendar_all_doctors', 'calendar_edit', 'appointments_view', 'appointments_manage', 'appointments_cancel', 'doctors_view', 'unavailability_view', 'clients_view', 'pricing_view']
  };

  const defaults = roleDefaults[role] || [];
  document.querySelectorAll('.perm-checkbox').forEach(cb => {
    if (!cb.disabled) {
      cb.checked = defaults.includes(cb.value);
    }
  });
}

async function saveUserPermissions() {
  const userId = state.currentEditingUserId;
  if (!userId) return;

  const checkedPerms = Array.from(document.querySelectorAll('.perm-checkbox:checked')).map(cb => cb.value);

  try {
    const res = await fetch(`/api/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: checkedPerms })
    });
    const data = await res.json();
    if (data.success) {
      closeModal('permissionsModal');
      showToast('Permissions configuration updated successfully!', 'success');
      await loadUsersTable();

      // If user is editing their own rights, update state and re-apply tabs
      if (state.currentUser && state.currentUser.id === userId) {
        state.currentUser.permissions = checkedPerms;
        applyTabPermissions();
      }
    } else {
      showToast(data.error || 'Failed to save permissions.', 'error');
    }
  } catch (err) {
    showToast('Error saving permissions: ' + err.message, 'error');
  }
}

// Global scope bindings for inline HTML handlers
if (typeof window !== 'undefined') {
  window.handleLoginSubmit = handleLoginSubmit;
  window.handleSignOut = handleSignOut;
  window.toggleForgotPasswordBox = toggleForgotPasswordBox;
  window.handleForgotPasswordSubmit = handleForgotPasswordSubmit;
  window.applyTempPassword = applyTempPassword;
  window.handleForcePasswordChangeSubmit = handleForcePasswordChangeSubmit;
  window.skipPasswordChangeForDemo = skipPasswordChangeForDemo;
  window.cancelPasswordChangeAndLogout = cancelPasswordChangeAndLogout;
  window.fillLoginCredentials = fillLoginCredentials;
}

