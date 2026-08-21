'use strict';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

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

  const { coupleId, uid, fightName } = body;
  if (!coupleId || !uid) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'coupleId and uid required' }) };
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!stripeKey || !priceId) {
    console.error('Stripe env vars not set');
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Configuration error' }) };
  }

  const origin = event.headers && (event.headers.origin || event.headers.referer)
    ? (event.headers.origin || new URL(event.headers.referer).origin)
    : 'https://theongoingargument.com';

  const params = new URLSearchParams({
    'payment_method_types[]': 'card',
    mode: 'payment',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'metadata[coupleId]': coupleId,
    'metadata[uid]': uid,
    'metadata[fightName]': (fightName || '').slice(0, 200),
    success_url: origin + '/?payment_success=1&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: origin + '/?payment_cancelled=1'
  });

  let stripeRes;
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(stripeKey + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
  } catch (err) {
    console.error('Stripe fetch error:', err.message);
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Payment service unreachable' }) };
  }

  let data;
  try {
    data = await stripeRes.json();
  } catch {
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid Stripe response' }) };
  }

  if (!stripeRes.ok || data.error) {
    console.error('Stripe error:', JSON.stringify(data.error || data).slice(0, 200));
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Could not create checkout session' }) };
  }

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: data.url })
  };
};
