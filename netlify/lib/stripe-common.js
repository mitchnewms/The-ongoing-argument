'use strict';

const ALLOWED_ORIGINS = [
  'https://theongoingargument.com',
  'https://www.theongoingargument.com',
  'https://mitchnewman.com',
  'https://www.mitchnewman.com',
  'https://imaginative-starburst-a1bbd9.netlify.app'
];
const DEFAULT_ORIGIN = 'https://theongoingargument.com';

// PLACEHOLDER price, used only in Stripe test mode when no STRIPE_PRICE_ID is set.
// The real price is chosen in Stripe (a Price ID) before going live.
const PLACEHOLDER = { amount: 4900, currency: 'usd', name: 'The Ongoing Argument, couple process (placeholder price)' };

function corsHeaders(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const h = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin'
  };
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

// The site this request came from, if it is one of ours. Anything else gets the main domain.
function safeOrigin(event) {
  const h = event.headers || {};
  let o = h.origin || h.Origin || '';
  if (!o && (h.referer || h.Referer)) { try { o = new URL(h.referer || h.Referer).origin; } catch (e) { o = ''; } }
  return ALLOWED_ORIGINS.indexOf(o) !== -1 ? o : DEFAULT_ORIGIN;
}

// 'test', 'live', or 'unconfigured', from the secret key's prefix.
function stripeMode(key) {
  if (/^(sk|rk)_test_/.test(key || '')) return 'test';
  if (/^(sk|rk)_live_/.test(key || '')) return 'live';
  return 'unconfigured';
}

// Real charges need two deliberate steps: a live key AND this switch.
function liveAllowed() { return process.env.ALLOW_LIVE_PAYMENTS === 'yes'; }

module.exports = { ALLOWED_ORIGINS, DEFAULT_ORIGIN, PLACEHOLDER, corsHeaders, safeOrigin, stripeMode, liveAllowed };
