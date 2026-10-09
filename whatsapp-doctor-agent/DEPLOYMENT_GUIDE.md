# 🚀 Multi-Doctor WhatsApp AI Scheduling Agent — Production Deployment Guide

This system is an enterprise-grade, multi-doctor appointment scheduling AI agent built for **WhatsApp Business Cloud API** with a real-time clinic management dashboard, dynamic doctor schedule configurator, 24-hour automated confirmation engine, multi-patient family registry, and instant doctor notifications.

---

## 🌟 Key Architecture & Capabilities

1. **Meta WhatsApp Cloud API Native Integration**
   - Official webhook endpoint at `/api/whatsapp/webhook`
   - Handles GET verification (`hub.challenge`, `hub.verify_token`)
   - Handles POST inbound events (text messages, quick replies, list selections)
   - Dispatches outbound WhatsApp messages via Meta Graph API v20.0

2. **Multi-Doctor Schedule & Availability Management**
   - Register unlimited doctors with custom specialties, colors, bios, and personal alert numbers.
   - Individual working days (Mon–Sun), shift hours, lunch breaks, slot durations, and buffer times.
   - Real-time slot calculator preventing double bookings across all doctors.

3. **Doctor Leave & Unavailability (Automated Patient Rescheduling)**
   - Doctors can report vacations, CME conferences, or urgent leave.
   - Automatically detects conflicting patient appointments and initiates 1-click or automated WhatsApp rescheduling.
   - Doctors can report unavailability directly from their personal WhatsApp numbers!

4. **Multi-Profile Registration (Multiple Names Under 1 WhatsApp Number)**
   - When a parent or family coordinator books, the agent asks:
     - *"Who is this appointment for? 1. Sarah (Self), 2. Leo (Child), 3. Robert (Spouse), or NEW family member"*
   - Remembers all family members permanently.

5. **24-Hour Automated Confirmation Engine**
   - Automated routine pings patients 24 hours prior to appointment.
   - If confirmed: status remains `🟢 Confirmed`.
   - If unconfirmed: automatically marked `🟡 Tentative` with visual indicators on the owner's weekly calendar.

6. **Instant Notifications on Doctor's Personal Phone**
   - Real-time alerts sent to the specific doctor's personal phone whenever a booking is created, rescheduled, or cancelled.

7. **Flexible for Any Business**
   - Easily adaptable for dental clinics, law firms, spas, wellness centers, therapy, and consultants via the Clinic Persona & Services settings.

---

## 🛠️ Local Run & Testing

```bash
# 1. Clone or navigate to the directory
cd /home/user/whatsapp-doctor-agent

# 2. Install dependencies
npm install

# 3. Start the application
npm start
# Default port is 3000 (http://localhost:3000)
```

---

## 🌐 Meta WhatsApp Cloud API Setup (Step-by-Step)

### Step 1: Create a Meta Developer App
1. Go to [developers.facebook.com](https://developers.facebook.com).
2. Create an App -> Choose **Business** type.
3. Under "Add products to your app", click **Set up** on **WhatsApp**.

### Step 2: Get Your Credentials
1. In the WhatsApp -> **API Setup** page:
   - Copy **Temporary Access Token** (or create a System User Permanent Token in Business Settings).
   - Copy **Phone Number ID**.
   - Note the Test WhatsApp number provided by Meta.

### Step 3: Configure Webhook & Subscribe WABA
1. Under WhatsApp -> **Configuration**:
   - Callback URL: `https://your-domain.com/api/whatsapp/webhook`
   - Verify Token: Enter your configured token (default in app: `apex_clinic_secure_webhook_token_2026`)
2. Click **Verify and Save**.
3. Under **Webhook fields**, click **Manage** and check `messages`.
4. **CRITICAL: Subscribe your WhatsApp Business Account (WABA) to the App**:
   By default in Meta Cloud API, webhooks are configured at the App level, but incoming messages from real WhatsApp users are routed through the WhatsApp Business Account (WABA).
   If your WABA is not subscribed, Meta will not forward incoming customer messages to your webhook URL!

   You can subscribe in either of two ways:
   - **Method A (Easiest - via Clinic Portal)**: Go to **⚙️ Clinic Persona & WhatsApp Setup** -> enter your **WABA ID** (`2231026294424950`) and **Access Token** -> click **"🔗 Subscribe WABA to Webhook"**.
   - **Method B (via curl)**:
     ```bash
     curl -X POST "https://graph.facebook.com/v20.0/2231026294424950/subscribed_apps" \
          -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>"
     ```
     You will receive `{"success": true}`. Real incoming messages from WhatsApp will now immediately hit your webhook!

### Step 4: Add Recipient Phone in Meta Test Sandbox (If in Development Mode)
If your Meta App is in **Development Mode** (Sandbox):
- WhatsApp requires you to add your personal phone number as an allowed recipient before Meta allows test conversations.
- In Meta App Dashboard -> **WhatsApp** -> **API Setup**:
  Look at **Step 1: Select phone numbers**. Under **"To"**, click the dropdown and choose **"Manage phone number list"**.
  Add your personal phone number and enter the 6-digit verification code Meta sends to your WhatsApp.
- Send the sample template message from Meta console to your phone to initiate the 24-hour customer service window, or send a message from your verified phone directly to the Meta phone number (`+1 555 159 5073`).

### Step 5: Add Credentials in the Admin Portal
1. Open the clinic dashboard -> **⚙️ Clinic Persona & WhatsApp Setup**.
2. Paste:
   - Phone Number ID (e.g., `1351164651405799`)
   - WhatsApp Business Account (WABA) ID (e.g., `2231026294424950`)
   - Meta Access Token
   - Webhook Verify Token
3. Click **Save All Changes**. Outbound WhatsApp messages will now be delivered to real WhatsApp phones!

---

## ☁️ Cloud & Server Deployment Options

### Option A: Production VPS (Ubuntu / Debian + PM2 + Nginx) — Recommended

```bash
# 1. Install Node.js 20+ & PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx
sudo npm install -g pm2

# 2. Deploy application code
git clone <your-repo> /var/www/whatsapp-doctor-agent
cd /var/www/whatsapp-doctor-agent
npm install --omit=dev

# 3. Start with PM2 using the included ecosystem.config.js
pm2 start ecosystem.config.js
pm2 startup
pm2 save

# 4. Configure Nginx Reverse Proxy
sudo cp nginx.conf /etc/nginx/sites-available/doctor-agent
# (Edit server_name in /etc/nginx/sites-available/doctor-agent to your clinic domain)
sudo ln -s /etc/nginx/sites-available/doctor-agent /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# 5. Enable free Let's Encrypt SSL
sudo certbot --nginx -d your-clinic-domain.com
```

---

### Option B: 1-Command Docker & Docker Compose

Deploy with persistent SQLite volume storage and automated health monitoring:

```bash
# 1. Clone repository
cd whatsapp-doctor-agent

# 2. Build and start container in background
docker compose up -d

# 3. View live server logs
docker compose logs -f
```

The SQLite database is automatically persisted to the `clinic_data` Docker volume (`/app/data/doctor_agent.db`).

---

### Option C: Native Linux Systemd Service

For bare-metal Ubuntu/Debian servers without PM2:

```bash
# 1. Copy the systemd service file
sudo cp whatsapp-doctor-agent.service /etc/systemd/system/

# 2. Reload daemon & start service
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-doctor-agent

# 3. Check status
sudo systemctl status whatsapp-doctor-agent
```

---

### Option D: Cloud PaaS (Render, Railway, Fly.io)

* **Render**: 1-click deploy using the included `render.yaml`. Set environment variables in the Render dashboard. For persistent storage, attach a Render Disk at `/app/data` and set `DB_PATH=/app/data/doctor_agent.db`.
* **Railway / Fly.io**: Add a volume mounted to `/app/data` with `DB_PATH=/app/data/doctor_agent.db`. The server automatically binds to `process.env.PORT` on `0.0.0.0`.
* **Health Check**: Automated container healthcheck endpoint available at `GET /health` verifying both server uptime and SQLite database connectivity.

---

## 🛡️ Clinical Security, RBAC & Physician Account Management

The system incorporates enterprise role-based access control (RBAC), granular permission matrices, and mandatory credential policies to protect clinical patient data:

### 1. Pre-Configured Baseline Accounts
| Role | Username | Default Password | Mandatory 1st Login Change | Access Scope |
| :--- | :--- | :--- | :--- | :--- |
| **System Admin** | `admin` | `Admin@2026!` (or `admin123`) | ⚠️ **Yes (Forced)** | Full global administration, settings & user RBAC |
| **Medical Director / Owner** | `director` | `Director@2026!` | ⚠️ **Yes (Forced)** | Superuser clinical oversight, all doctors, all logs |
| **Front Desk Reception** | `reception` | `Reception@2026!` | ⚠️ **Yes (Forced)** | Bookings, walk-ins, cancellations, patient records |
| **Dr. Alexander Wright, MD** | `dr.wright` | `DoctorPass@2026!` | ⚠️ **Yes (Forced)** | Cardiology schedule & assigned patients |
| **Dr. Sophia Patel, MD** | `dr.patel` | `DoctorPass@2026!` | ⚠️ **Yes (Forced)** | Pediatrics schedule & assigned patients |
| **Dr. Marcus Vance, DO** | `dr.vance` | `DoctorPass@2026!` | ⚠️ **Yes (Forced)** | Family medicine schedule & assigned patients |

### 2. Mandatory First-Login Password Change Policy
- Non-admin staff attempting to log in with their initial temporary password are immediately intercepted by an un-dismissible **Mandatory Password Change Dialog**.
- The portal workspace remains locked until the user sets a strong new password (minimum 6 characters).
- Once updated, `must_change_password` is set to `0` and session tokens are re-issued.

### 3. Granular 15-Permission Matrix
Each user account can have permissions assigned or de-assigned individually in the **👥 Clinic Staff & RBAC Management** tab:
- `calendar_view`, `calendar_manage`, `calendar_all_doctors`
- `doctors_view`, `doctors_manage`
- `unavailability_view`, `unavailability_manage`
- `appointments_view`, `appointments_manage`, `appointments_cancel`
- `clients_view`, `clients_manage`
- `pricing_view`, `pricing_manage`
- `settings_manage`, `users_manage`

*Note: For physicians without `calendar_all_doctors`, the calendar interface and backend APIs automatically restrict data so physicians can only view and interact with their own allocated patients.*

### 4. Dynamic Auto-Provisioning & Cascading Deactivation
- **Auto-Provisioning**: Creating a new physician in the **Physicians Directory** automatically creates a corresponding clinical user login account with a unique username, doctor profile link, and initial password.
- **Cascading Deactivation**: Deactivating or removing a physician in the directory immediately cascades to suspend the linked user account (`is_active = 0`) and revokes all active auth session tokens in real time.

---

## 🔒 Concurrency, WhatsApp Slot Holds & No-Show Reclamation

The platform features an enterprise-grade atomic locking and slot reclamation engine:

1. **WhatsApp Slot Holds (10-minute TTL)**:
   - When any patient selects a slot via WhatsApp, a temporary exclusive lock (`slot_holds`) is acquired.
   - Other simultaneous WhatsApp users querying that doctor/date have that held slot filtered out in real-time.
   - If an administrative walk-in or phone booking is attempted on that exact slot, the system returns `409 Conflict: Slot In Progress` preventing double-booking.
   - If the patient finishes and confirms, the hold converts to a confirmed booking.
   - If the patient cancels, presses BACK/MENU, or abandons the chat for 10 minutes, the hold auto-expires and reopens to the public.

2. **No-Show & Cancellation Slot Reclamation**:
   - Marking an appointment as **No-Show** (`no_show`) or **Cancelled** (`cancelled`) preserves the patient's record, notes, and booking history for auditing and billing.
   - The corresponding calendar time slot is immediately freed and reclaimed, making it available for other patients to book via WhatsApp or walk-in.

---

## 🔄 Automated 24-Hour Confirmation CRON Job & Engine Operations

The confirmation banner at the top of the clinic workspace controls the automated attendance verification routine:

### Clinical Objective & ROI
Patient no-shows cost medical practices an estimated $150B annually. This engine automates patient attendance verification 24 hours prior to visit, allowing clinics to confirm arrivals, detect cancellations early, and alert doctors to attendance risks.

### Button 1: "🚀 Run 24h Confirmation Scan" (`forceMarkUnconfirmed = false`)
- **Action**: Queries SQLite for all appointments scheduled for tomorrow's date (within 24 to 48 hours) where `confirmation_sent_at IS NULL`.
- **WhatsApp Dispatch**: Sends an interactive notification to the patient's WhatsApp with full appointment details (Physician name, specialty, date, time slot, and clinic address).
- **Interactive Prompts**: The message prompts the patient to reply:
  - `CONFIRM` -> keeps booking confirmed (`confirmed_at = CURRENT_TIMESTAMP`).
  - `RESCHEDULE` -> launches conversational AI rescheduling to choose a different doctor or date.
  - `CANCEL` -> cancels the booking and instantly frees the calendar slot for waiting patients.
- **Doctor Phone Copy**: Sends an alert to the attending physician's personal WhatsApp number (`owner_notifications`) letting them know the confirmation message was dispatched.
- **Audit Trail**: Sets `confirmation_sent_at` on the appointment record so reminders are never sent twice.

### Button 2: "⚠️ Mark Unconfirmed as Tentative" (`forceMarkUnconfirmed = true`)
- **Action**: Queries for appointments scheduled for tomorrow where a confirmation message was sent, but the patient *did not respond* within the 24-hour cutoff window (`confirmed_at IS NULL`).
- **Status Update**: Transitions the appointment status in SQLite from `confirmed` to `tentative`.
- **Live Weekly Calendar Impact**: The calendar slot immediately turns yellow with a pulsating visual warning badge (`🟡 Tentative`).
- **Doctor Alert**: Automatically dispatches a high-priority alert to the doctor's personal WhatsApp phone:
  `⚠️ [MARKED TENTATIVE] Dr. Patel, appointment for John Doe tomorrow at 10:00 AM marked TENTATIVE due to lack of client confirmation response.`
- **Operational Benefit**: Front desk receptionists can proactively contact unconfirmed patients or offer the slot to walk-in/urgent-care patients.

### Production Execution
You can schedule the confirmation check to run every hour using Linux cron:

```bash
# Run hourly scan
0 * * * * curl -s -X POST http://localhost:3000/api/reminders/run -H "Content-Type: application/json" -d '{"forceMarkUnconfirmed": false}' >> /var/log/doctor_agent_cron.log 2>&1
```

Or trigger it on-demand directly from the **AI 24-Hour Confirmation Banner** in the web dashboard!

---

## 🌍 Clinic Country & Time Zone Localization

The clinic's geographic location and operational timezone are fully configurable in the **⚙️ Setup & Persona** tab:

1. **Country & Time Zone Configuration**:
   - Admin can select the clinic's operating country (e.g., Pakistan, United States, United Kingdom, UAE, Saudi Arabia, Canada, Australia, India, etc.) or enter custom coordinates.
   - Standard IANA timezones (e.g., `Asia/Karachi`, `America/New_York`, `Europe/London`, `Asia/Dubai`, `Asia/Riyadh`, `Asia/Kolkata`, etc.) are mapped with daytime saving offsets and timezone abbreviations (`PKT`, `EDT`, `BST`, `GST`, `IST`, etc.).

2. **Prohibition of Past Slots for Today**:
   - Booking appointments for past calendar dates is strictly prohibited (`available: false`).
   - For today's date, the scheduling engine dynamically compares candidate timeslots against the current local time in the clinic's timezone. Any timeslot starting at or before current clinic time is automatically blocked.
   - Both the WhatsApp conversational agent and calendar walk-in booking enforce this rule, preventing accidental scheduling of expired hours.

3. **Live Time Display & Timezone In Confirmations**:
   - A real-time clinic clock ticks in the header badge, setup persona card, and walk-in modal so clinic staff always see the current local time.
   - All WhatsApp confirmations, doctor notifications, calendar walk-in receipts, and 24-hour reminder messages prominently display the clinic timezone label (e.g., `11:00 AM - 11:30 AM (PKT (UTC+5))`).

---

## ⚡ Running on Nebius Token Factory & Nebius AI Cloud (NVIDIA Open-Source Models)

This application supports running on **Nebius Token Factory** and **Nebius AI Cloud** with **NVIDIA open-source models** (e.g. `nvidia/Llama-3.1-Nemotron-70B-Instruct`, `nvidia/nemotron-3-super`, `nvidia/nemotron-4-340b`, or `nvidia/Mistral-NeMo-12B`).

### Architecture: Hybrid Two-Tier System
1. **Tier 1 (NVIDIA Nemotron on Nebius)**:
   - Handles free-form natural language questions, symptom queries, doctor background questions, arrival directions, preparation notes, and open-ended FAQ.
2. **Tier 2 (Deterministic Healthcare Booking Core)**:
   - Handles calendar timeslot math, atomic concurrency locking (10-minute temporary holds), past-time protection, SQLite transactions, and Meta WhatsApp Cloud API webhooks.
   - **Benefit**: Zero hallucination on appointment dates, times, prices, and doctor schedules, with frontier AI conversational intelligence.

---

### Option A: Nebius Token Factory (Serverless Inference API)

Nebius Token Factory provides high-throughput, managed inference endpoints with native OpenAI-compatible APIs for open-source models including NVIDIA Nemotron.

1. Obtain your API Key from the [Nebius Token Factory Console](https://tokenfactory.nebius.com).
2. Configure your environment variables in `.env`:
   ```bash
   NEBIUS_API_KEY="your_nebius_api_token"
   NEBIUS_BASE_URL="https://api.tokenfactory.nebius.com/v1"
   NEBIUS_MODEL="nvidia/Llama-3.1-Nemotron-70B-Instruct"
   ```
3. Start the application:
   ```bash
   npm start
   ```
   The scheduling agent automatically routes open-ended patient inquiries to NVIDIA Nemotron on Nebius Token Factory.

---

### Option B: Nebius AI Cloud (Dedicated GPU Compute with vLLM / TensorRT-LLM)

If you are hosting your own GPU clusters on Nebius AI Cloud (NVIDIA H100, H200, L40S, or Blackwell B200 instances):

1. **Deploy NVIDIA Nemotron on your GPU instance using vLLM**:
   ```bash
   docker run --gpus all \
     -v ~/.cache/huggingface:/root/.cache/huggingface \
     -p 8000:8000 \
     --ipc=host \
     vllm/vllm-openai:latest \
     --model nvidia/Llama-3.1-Nemotron-70B-Instruct \
     --max-model-len 8192 \
     --tensor-parallel-size 4
   ```

2. **Configure your WhatsApp scheduling app on the same instance or VPC**:
   ```bash
   NEBIUS_BASE_URL="http://localhost:8000/v1"
   NEBIUS_MODEL="nvidia/Llama-3.1-Nemotron-70B-Instruct"
   ```
   No external API key is required when connecting locally within your private Nebius AI Cloud VPC.

