'use strict';

const NOTICE_TO = process.env.WAITLIST_NOTICE_TO || 'mitch@theongoingargument.com';

// Sends Mitch a short notice through EmailJS. This runs on the server, so the EmailJS settings
// "Allow EmailJS API for non-browser applications" must be on, and if "Use Private Key" is on the
// private key must be stored in the Netlify variable EMAILJS_PRIVATE_KEY.
//
// Never throws. Returns { ok: true } or { ok: false, reason } where reason is a short plain label
// with no personal data in it, so it can be logged and shown on the admin page.
async function sendNotice(label, when) {
  const templateId = process.env.WAITLIST_TEMPLATE_ID || '';
  if (!templateId) return { ok: false, reason: 'no_template_id' };
  const payload = {
    service_id: process.env.EMAILJS_SERVICE_ID || 'service_k0ocp9f',
    template_id: templateId,
    user_id: process.env.EMAILJS_PUBLIC_KEY || '1HSruQu2MRIfbUF0B',
    template_params: { to_email: NOTICE_TO, signup_email: label, signup_time: when }
  };
  if (process.env.EMAILJS_PRIVATE_KEY) payload.accessToken = process.env.EMAILJS_PRIVATE_KEY;
  try {
    const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (r.ok) return { ok: true };
    const text = String(await r.text().catch(function() { return ''; })).replace(/\s+/g, ' ').slice(0, 140);
    return { ok: false, reason: 'emailjs_' + r.status + ': ' + text };
  } catch (err) {
    return { ok: false, reason: 'network: ' + String(err && err.message || err).slice(0, 80) };
  }
}

// What is configured, as yes or no only. Never returns a secret.
function noticeSetup() {
  return {
    templateIdSet: !!process.env.WAITLIST_TEMPLATE_ID,
    privateKeySet: !!process.env.EMAILJS_PRIVATE_KEY,
    serviceId: process.env.EMAILJS_SERVICE_ID || 'service_k0ocp9f',
    sendsTo: NOTICE_TO
  };
}

module.exports = { sendNotice, noticeSetup };
