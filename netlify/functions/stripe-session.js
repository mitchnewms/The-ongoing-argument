'use strict';

const { verifyFirebaseUser } = require('../lib/firebase-auth');
const { PLACEHOLDER, corsHeaders, safeOrigin, stripeMode, liveAllowed } = require('../lib/stripe-common');

function reply(CORS, status, obj) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async function(event) {
  const CORS = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return reply(CORS, 400, { error: 'Invalid JSON', code: 'bad_request' }); }

  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  const priceId = process.env.STRIPE_PRICE_ID || '';
  const mode = stripeMode(stripeKey);

  if (mode === 'unconfigured') {
    console.error('Stripe secret key not set');
    return reply(CORS, 500, { error: 'Checkout is not set up yet.', code: 'not_configured' });
  }
  // Real charges need a live key AND an explicit switch. Without both, nothing real can be charged.
  if (mode === 'live' && !liveAllowed()) {
    console.error('Live Stripe key present but ALLOW_LIVE_PAYMENTS is not "yes". Refusing.');
    return reply(CORS, 403, { error: 'Live payments are switched off.', code: 'live_blocked' });
  }

  const demo = body.demo === true;
  const metadata = {};
  let successPath, cancelPath;

  if (demo) {
    // A test checkout from the public price page. Test mode only, so no real money can move.
    if (mode !== 'test') return reply(CORS, 403, { error: 'The demo checkout only works in test mode.', code: 'demo_test_only' });
    metadata['metadata[demo]'] = 'true';
    successPath = '/pricing?paid=test';
    cancelPath = '/pricing?cancelled=1';
  } else {
    const { coupleId, uid, fightName } = body;
    if (!coupleId || !uid) return reply(CORS, 400, { error: 'coupleId and uid required', code: 'bad_request' });
    const who = await verifyFirebaseUser(event);
    if (who === 'unavailable') return reply(CORS, 503, { error: 'Sign-in check unavailable. Please try again.', code: 'auth_unavailable' });
    if (!who) return reply(CORS, 401, { error: 'Please sign in to pay.', code: 'unauthorized' });
    if (who.uid !== uid) return reply(CORS, 403, { error: 'That payment is for a different account.', code: 'wrong_account' });
    metadata['metadata[coupleId]'] = coupleId;
    metadata['metadata[uid]'] = uid;
    metadata['metadata[fightName]'] = (fightName || '').slice(0, 200);
    successPath = '/?payment_success=1&session_id={CHECKOUT_SESSION_ID}';
    cancelPath = '/?payment_cancelled=1';
  }

  const params = new URLSearchParams({
    'payment_method_types[]': 'card',
    mode: 'payment',
    'line_items[0][quantity]': '1',
    success_url: safeOrigin(event) + successPath,
    cancel_url: safeOrigin(event) + cancelPath
  });
  Object.keys(metadata).forEach(function(k) { params.set(k, metadata[k]); });

  if (priceId) {
    params.set('line_items[0][price]', priceId);
  } else if (mode === 'test') {
    // Placeholder price, test mode only.
    params.set('line_items[0][price_data][currency]', PLACEHOLDER.currency);
    params.set('line_items[0][price_data][unit_amount]', String(PLACEHOLDER.amount));
    params.set('line_items[0][price_data][product_data][name]', PLACEHOLDER.name);
  } else {
    console.error('Live mode needs STRIPE_PRICE_ID');
    return reply(CORS, 500, { error: 'No live price is set.', code: 'no_price' });
  }

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
    return reply(CORS, 502, { error: 'Payment service unreachable', code: 'stripe_unreachable' });
  }

  let data;
  try { data = await stripeRes.json(); }
  catch { return reply(CORS, 502, { error: 'Invalid Stripe response', code: 'stripe_bad_response' }); }

  if (!stripeRes.ok || data.error) {
    console.error('Stripe error:', JSON.stringify(data.error || data).slice(0, 200));
    return reply(CORS, 502, { error: 'Could not create checkout session', code: 'stripe_error' });
  }

  return reply(CORS, 200, { url: data.url, testMode: mode === 'test' });
};
