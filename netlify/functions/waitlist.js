'use strict';

const crypto = require('crypto');
const admin = require('../lib/firestore-admin');
const { corsHeaders } = require('../lib/stripe-common');

const { sendNotice } = require('../lib/waitlist-notice');

function reply(CORS, status, obj) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// Sends the notice and writes down whether it worked, so a failure can be seen on the admin page
// (no email address is kept in that note). A failed notice never stops the signup.
async function noticeAndRecord(id, email, when) {
  const n = await sendNotice(email, when);
  if (!n.ok) console.error('WAITLIST NOTICE FAILED: ' + n.reason);
  if (id) {
    try { await admin.setFields('waitlist/' + id, { noticeSent: n.ok, noticeError: n.ok ? '' : n.reason }); }
    catch (e) { console.error('Could not record the notice result:', e.message); }
  }
  return n.ok;
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
    const sent = await noticeAndRecord(null, email, when);
    return sent ? reply(CORS, 200, { ok: true }) : reply(CORS, 503, { error: 'Not set up yet.', code: 'not_configured' });
  }

  try {
    const existing = await admin.getDoc('waitlist/' + id);
    if (existing) return reply(CORS, 200, { ok: true }); // already on the list, no second notice
    await admin.setFields('waitlist/' + id, { email, createdAt: when, source: 'front-page' });
  } catch (err) {
    console.error('Waiting list save failed:', err.message);
    const sent = await noticeAndRecord(null, email, when);
    return sent ? reply(CORS, 200, { ok: true }) : reply(CORS, 502, { error: 'Could not save.', code: 'save_failed' });
  }
  await noticeAndRecord(id, email, when);
  return reply(CORS, 200, { ok: true });
};
