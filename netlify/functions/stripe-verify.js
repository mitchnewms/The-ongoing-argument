'use strict';

const { verifyFirebaseUser } = require('../lib/firebase-auth');
const admin = require('../lib/firestore-admin');
const { corsHeaders, stripeMode, liveAllowed } = require('../lib/stripe-common');

function generateCoupleCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

exports.handler = async function(event) {
  const CORS_HEADERS = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { session_id } = body;
  if (!session_id) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'session_id required' }) };
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (stripeMode(stripeKey) === 'unconfigured') {
    console.error('STRIPE_SECRET_KEY not set');
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Configuration error', code: 'not_configured' }) };
  }
  if (stripeMode(stripeKey) === 'live' && !liveAllowed()) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Live payments are switched off.', code: 'live_blocked' }) };
  }

  // Paying for a couple needs the person who paid to be signed in.
  const who = await verifyFirebaseUser(event);
  if (who === 'unavailable') {
    return { statusCode: 503, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Sign-in check unavailable. Please try again.', code: 'auth_unavailable' }) };
  }
  if (!who) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Please sign in.', code: 'unauthorized' }) };
  }

  let stripeRes;
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(session_id), {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(stripeKey + ':').toString('base64')
      }
    });
  } catch (err) {
    console.error('Stripe fetch error:', err.message);
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Payment service unreachable' }) };
  }

  let session;
  try {
    session = await stripeRes.json();
  } catch {
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid Stripe response' }) };
  }

  if (!stripeRes.ok || session.error) {
    console.error('Stripe session error:', JSON.stringify(session.error || session).slice(0, 200));
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Could not verify payment' }) };
  }

  if (session.payment_status !== 'paid') {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: false })
    };
  }

  if (session.metadata && session.metadata.demo === 'true') {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: true, demo: true })
    };
  }

  if (!session.metadata || session.metadata.uid !== who.uid) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'That payment belongs to a different account.', code: 'wrong_account' }) };
  }

  const coupleId = session.metadata && session.metadata.coupleId;
  if (!coupleId) {
    console.error('No coupleId in session metadata');
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid session metadata' }) };
  }

  const json = (status, obj) => ({ statusCode: status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

  // Without the server key we cannot record payment safely. In test mode the browser still does it (the
  // beta way). In live mode we refuse, so a real payment can never be recorded by a browser.
  if (!admin.configured()) {
    if (stripeMode(stripeKey) === 'live') {
      console.error('Live payment seen but FIREBASE_SERVICE_ACCOUNT is not set. Refusing.');
      return json(500, { error: 'Payment recording is not set up.', code: 'server_not_configured' });
    }
    return json(200, { paid: true, coupleId, coupleCode: generateCoupleCode(), serverWrote: false });
  }

  try {
    const couple = await admin.getDoc('couples/' + encodeURIComponent(coupleId));
    if (!couple || couple.partnerAId !== who.uid) {
      return json(403, { error: 'That payment belongs to a different account.', code: 'wrong_account' });
    }
    // Checking twice must not make a second code: reuse the first one.
    if (couple.paidStatus === true && couple.coupleCode) {
      return json(200, { paid: true, coupleId, coupleCode: couple.coupleCode, serverWrote: true });
    }
    const coupleCode = generateCoupleCode();
    await admin.setFields('couples/' + encodeURIComponent(coupleId), {
      paidStatus: true, coupleCode, paidAt: new Date().toISOString(), partnerAConfirmed: true
    });
    await admin.setFields('joinCodes/' + coupleCode, {
      coupleId, partnerAId: who.uid, fightName: String(session.metadata.fightName || ''), used: false
    });
    return json(200, { paid: true, coupleId, coupleCode, serverWrote: true });
  } catch (err) {
    console.error('Recording payment failed:', err.message);
    return json(502, { error: 'Payment received but could not be recorded. Please try again.', code: 'record_failed' });
  }
};
