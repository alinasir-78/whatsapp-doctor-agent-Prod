require('dotenv').config();
const { getQuery, runQuery } = require('./database');
const { processIncomingMessage } = require('./aiAgent');

/**
 * Handle Meta WhatsApp Cloud API Webhook verification (GET)
 */
async function handleWebhookVerification(req, res) {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const settings = await getQuery('SELECT whatsapp_verify_token FROM settings WHERE id = 1');
    const expectedToken = (settings && settings.whatsapp_verify_token) ||
                          process.env.WHATSAPP_VERIFY_TOKEN ||
                          'apex_clinic_secure_webhook_token_2026';

    console.log(`🔍 [WEBHOOK GET] Meta verification attempt. Mode: "${mode}", Token: "${token}"`);

    if (mode === 'subscribe' && token === expectedToken) {
      console.log('✅ [WEBHOOK GET] Webhook verified successfully by Meta!');
      return res.status(200).send(challenge);
    } else {
      console.warn(`❌ [WEBHOOK GET] Verification failed. Expected "${expectedToken}", got "${token}"`);
      return res.status(403).send('Forbidden: Token mismatch');
    }
  } catch (err) {
    console.error('Error verifying WhatsApp webhook:', err);
    return res.status(500).send('Internal Error');
  }
}

/**
 * Handle Meta WhatsApp Cloud API Inbound Events (POST)
 */
async function handleWebhookEvent(req, res) {
  try {
    const body = req.body;

    // Immediately return 200 OK so Meta never times out!
    res.status(200).send('EVENT_RECEIVED');

    // Log raw webhook event
    await runQuery(
      'INSERT INTO meta_api_logs (direction, endpoint, payload, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
      ['inbound', '/api/whatsapp/webhook', JSON.stringify(body)]
    );

    console.log('📥 [META WEBHOOK POST] Event received from Meta servers.');

    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;
          if (!value) continue;

          // Check if this is Meta's internal developer console test button
          if (value.messages && value.messages.length > 0) {
            for (const msg of value.messages) {
              const waId = msg.from; // e.g. "16315551181" (Meta's test number) or real user phone
              const formattedPhone = waId.startsWith('+') ? waId : `+${waId}`;

              // Special detection for Meta's Console Test Button
              if (waId === '16315551181' || waId.includes('1631555')) {
                console.log(`\n======================================================`);
                console.log(`🧪 [META CONSOLE TEST EVENT DETECTED]`);
                console.log(`Meta Developer Console clicked "Test" with dummy sender: ${waId}`);
                console.log(`🎉 YOUR WEBHOOK IS 100% OPERATIONAL & REACHABLE BY META!`);
                console.log(`======================================================\n`);
                return;
              }

              let text = '';
              if (msg.type === 'text' && msg.text) {
                text = msg.text.body;
              } else if (msg.type === 'interactive') {
                if (msg.interactive.type === 'button_reply') {
                  text = msg.interactive.button_reply.title || msg.interactive.button_reply.id;
                } else if (msg.interactive.type === 'list_reply') {
                  text = msg.interactive.list_reply.title || msg.interactive.list_reply.id;
                }
              }

              if (text) {
                console.log(`\n======================================================`);
                console.log(`📩 INCOMING WHATSAPP MESSAGE from ${formattedPhone}: "${text}"`);
                console.log(`======================================================`);

                // Generate AI agent response
                const agentReply = await processIncomingMessage(formattedPhone, text);

                console.log(`🤖 AGENT GENERATED REPLY:\n${agentReply}\n`);

                // Send reply back to user via Meta Graph API
                await sendWhatsAppMessage(formattedPhone, agentReply);
              }
            }
          } else if (value.statuses && value.statuses.length > 0) {
            for (const s of value.statuses) {
              console.log(`ℹ️ [MESSAGE STATUS UPDATE] Recipient: ${s.recipient_id}, Status: ${s.status}`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Error processing handleWebhookEvent:', err);
  }
}

/**
 * Send WhatsApp message using Meta Graph API (or simulated fallback)
 */
async function sendWhatsAppMessage(toPhone, messageText) {
  const settings = await getQuery('SELECT * FROM settings WHERE id = 1');

  let phoneNumberId = (settings && settings.whatsapp_phone_number_id) || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  let accessToken = (settings && settings.whatsapp_access_token) || process.env.WHATSAPP_ACCESS_TOKEN || '';

  if (phoneNumberId === '109823471923' && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  }

  let recipient = toPhone.replace(/\D/g, '').trim();
  recipient = recipient.replace(/^00/, '');

  if (recipient === '16315551181' || recipient.includes('5551181')) {
    console.log(`🧪 Skipping outbound dispatch to Meta dummy test recipient: ${recipient}`);
    return { skipped: true, reason: 'Dummy test number' };
  }

  console.log(`📤 Preparing outbound WhatsApp message to ${recipient}...`);

  if (accessToken && accessToken.trim().length > 10 && phoneNumberId && phoneNumberId.trim().length > 3 && phoneNumberId !== '109823471923') {
    console.log(`🚀 [OUTBOUND TO META] Calling Graph API -> Phone ID: ${phoneNumberId}, Recipient: ${recipient}`);

    const endpoint = `https://graph.facebook.com/v20.0/${phoneNumberId.trim()}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: {
        preview_url: false,
        body: messageText
      }
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      await runQuery(
        'INSERT INTO meta_api_logs (direction, endpoint, recipient, status_code, payload, response, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        ['outbound', endpoint, recipient, response.status, JSON.stringify(payload), JSON.stringify(data)]
      );

      if (response.ok) {
        console.log(`✅ [META DISPATCH SUCCESS] Delivered to ${recipient}! Message ID: ${data.messages && data.messages[0]?.id}`);
      } else {
        console.error(`\n❌ [META API ERROR] Meta rejected the message!`);
        console.error(`Status code: ${response.status}`);
        console.error(`Meta Error Details:`, JSON.stringify(data, null, 2));

        if (data.error && data.error.code === 131030) {
          console.error(`👉 CAUSE: The number +${recipient} is not on your allowed test list in Meta Developer Console!`);
        } else if (data.error && data.error.code === 190) {
          console.error(`👉 CAUSE: Your Meta Access Token has expired or is invalid. Copy a fresh token from WhatsApp -> API Setup.`);
        } else if (data.error && data.error.code === 100) {
          console.error(`👉 CAUSE: Invalid Phone Number ID (${phoneNumberId}). Verify your Phone Number ID in Meta Developer Console.`);
        }
      }
      return data;
    } catch (e) {
      console.error('❌ Network error calling Meta Graph API:', e.message);
      await runQuery(
        'INSERT INTO meta_api_logs (direction, endpoint, recipient, status_code, payload, response, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        ['outbound', endpoint, recipient, 500, JSON.stringify(payload), JSON.stringify({ error: e.message })]
      );
      return { error: e.message };
    }
  } else {
    console.warn(`\n⚠️ [META CREDENTIALS NOT CONFIGURED]`);
    return {
      simulated: true,
      message: 'Credentials missing in settings. Configured as simulated outbound.'
    };
  }
}

/**
 * Diagnostic tool: Test sending a message directly from the server to verify credentials
 */
async function testSendDirect(toPhone) {
  const testMsg = `👋 Test message from your WhatsApp AI Scheduling Agent! Your server is successfully connected to Meta WhatsApp Cloud API.`;
  return await sendWhatsAppMessage(toPhone, testMsg);
}

/**
 * Crucial Meta Graph API helper: Subscribes WABA (WhatsApp Business Account) to the app!
 * Endpoint: POST https://graph.facebook.com/v20.0/{WABA_ID}/subscribed_apps
 */
async function subscribeWabaToApp(wabaId) {
  const settings = await getQuery('SELECT * FROM settings WHERE id = 1');
  const accessToken = (settings && settings.whatsapp_access_token) || process.env.WHATSAPP_ACCESS_TOKEN || '';

  if (!accessToken) {
    return { success: false, error: 'Access token is required to subscribe WABA to app.' };
  }
  if (!wabaId) {
    return { success: false, error: 'WABA ID is required.' };
  }

  const endpoint = `https://graph.facebook.com/v20.0/${wabaId.trim()}/subscribed_apps`;
  console.log(`🔗 [WABA SUBSCRIPTION] Calling POST ${endpoint} ...`);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken.trim()}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    console.log(`🔗 [WABA SUBSCRIPTION RESPONSE]:`, data);

    await runQuery(
      'INSERT INTO meta_api_logs (direction, endpoint, recipient, status_code, payload, response, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
      ['outbound', endpoint, `WABA-${wabaId}`, response.status, JSON.stringify({ action: 'subscribed_apps' }), JSON.stringify(data)]
    );

    return { success: response.ok, status: response.status, data };
  } catch (err) {
    console.error('❌ Error subscribing WABA to app:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  handleWebhookVerification,
  handleWebhookEvent,
  sendWhatsAppMessage,
  testSendDirect,
  subscribeWabaToApp
};
