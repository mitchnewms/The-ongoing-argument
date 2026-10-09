'use strict';

const crypto = require('crypto');
const admin = require('../lib/firestore-admin');
const { corsHeaders } = require('../lib/stripe-common');

const NOTICE_TO = process.env.WAITLIST_NOTICE_TO || 'mitch@theongoingargument.com';

function reply(CORS, status, obj) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// Tells Mitch someone joined. Uses EmailJS from the server so no mail settings sit in the public page.
async function sendNotice(email, when) {
  const templateId = process.env.WAITLIST_TEMPLATE_ID || '';
  if (!templateId) { console.warn('WAITLIST_TEMPLATE_ID not set, so no notice email was sent'); return false; }
  const payload = {
    service_id: process.env.EMAILJS_SERVICE_ID || 'service_k0ocp9f',
    template_id: templateId,
    user_id: process.env.EMAILJS_PUBLIC_KEY || '1HSruQu2MRIfbUF0B',
    template_params: { to_email: NOTICE_TO, signup_email: email, signup_time: when }
  };
  if (process.env.EMAILJS_PRIVATE_KEY) payload.accessToken = process.env.EMAILJS_PRIVATE_KEY;
  try {
    const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!r.ok) { console.error('Waiting list notice failed:', r.status, (await r.text().catch(function() { return ''; })).slice(0, 160)); return false; }
    return true;
  } catch (err) { console.error('Waiting list notice error:', err.message); return false; }
}

exports.handler = async function(event) {
  const CORS = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  if ((event.body || '').length > 2000) return reply(CORS, 413, { error: 'Too large', code: 'too_large' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(CORS, 400, { error: 'Invalid JSON', code: 'bad_request' }); }

  // Bots fill the hidden field or submit faster than a person can. Say thanks and save nothing.
  if ((body.website && String(body.website).length) || (typeof body.elapsed === 'number' && body.elapsed < 800)) {
    return reply(CORS, 200, { ok: true });
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return reply(CORS, 400, { error: 'Please enter a valid email address.', code: 'bad_email' });
  }

  const when = new Date().toISOString();
  const id = crypto.createHash('sha256').update(email).digest('hex').slice(0, 40);

  if (!admin.configured()) {
    // Cannot save the list yet, but Mitch still hears about the signup.
    console.warn('FIREBASE_SERVICE_ACCOUNT not set: waiting list email was NOT saved: ' + email);
    const sent = await sendNotice(email, when);
    return sent ? reply(CORS, 200, { ok: true }) : reply(CORS, 503, { error: 'Not set up yet.', code: 'not_configured' });
  }

  try {
    const existing = await admin.getDoc('waitlist/' + id);
    if (existing) return reply(CORS, 200, { ok: true }); // already on the list, no second notice
    await admin.setFields('waitlist/' + id, { email, createdAt: when, source: 'front-page' });
  } catch (err) {
    console.error('Waiting list save failed:', err.message);
    const sent = await sendNotice(email, when);
    return sent ? reply(CORS, 200, { ok: true }) : reply(CORS, 502, { error: 'Could not save.', code: 'save_failed' });
  }
  await sendNotice(email, when);
  return reply(CORS, 200, { ok: true });
};
