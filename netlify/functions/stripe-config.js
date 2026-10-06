'use strict';

const { PLACEHOLDER, corsHeaders, stripeMode, liveAllowed } = require('../lib/stripe-common');

// Tells the price page what to show. Never returns a secret.
exports.handler = async function(event) {
  const CORS = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const key = process.env.STRIPE_SECRET_KEY || '';
  const mode = stripeMode(key);
  const priceId = process.env.STRIPE_PRICE_ID || '';
  let out = {
    mode,
    liveBlocked: mode === 'live' && !liveAllowed(),
    amount: PLACEHOLDER.amount,
    currency: PLACEHOLDER.currency,
    placeholder: true
  };

  if (mode !== 'unconfigured' && priceId) {
    try {
      const r = await fetch('https://api.stripe.com/v1/prices/' + encodeURIComponent(priceId), {
        headers: { 'Authorization': 'Basic ' + Buffer.from(key + ':').toString('base64') }
      });
      const p = await r.json();
      if (r.ok && typeof p.unit_amount === 'number') {
        out.amount = p.unit_amount; out.currency = p.currency; out.placeholder = false;
      }
    } catch (err) { console.error('Price lookup failed:', err.message); }
  }

  return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(out) };
};
