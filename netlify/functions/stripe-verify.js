'use strict';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function generateCoupleCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

exports.handler = async function(event) {
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
  if (!stripeKey) {
    console.error('STRIPE_SECRET_KEY not set');
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Configuration error' }) };
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

  const coupleId = session.metadata && session.metadata.coupleId;
  if (!coupleId) {
    console.error('No coupleId in session metadata');
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid session metadata' }) };
  }

  const coupleCode = generateCoupleCode();

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paid: true, coupleId, coupleCode })
  };
};
