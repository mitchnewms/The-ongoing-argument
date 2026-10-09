'use strict';

// ONE PLACE FOR AI PRICES. Dollars per one million tokens. Update these when Anthropic changes prices
// or when the model in ai.js changes. Check https://www.anthropic.com/pricing for the current numbers.
const MODEL = 'claude-sonnet-4-6';
const RATES = {
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 }
};
const FALLBACK_RATE = RATES['claude-sonnet-4-6'];

// usage is the "usage" object the Anthropic API returns with every reply.
// input_tokens does not include cached tokens, so the three input kinds are priced separately.
function estimateCost(model, usage) {
  const r = RATES[model] || FALLBACK_RATE;
  const u = usage || {};
  const inTok = u.input_tokens || 0, outTok = u.output_tokens || 0;
  const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  const usd = (inTok * r.input + outTok * r.output + cr * r.cacheRead + cw * r.cacheWrite) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

module.exports = { MODEL, RATES, estimateCost };
