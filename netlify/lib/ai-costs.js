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

// DAILY LIMITS. Days run on Pacific time. Change the numbers here, or set AI_CALLS_PER_DAY and
// AI_DOLLARS_PER_DAY in Netlify. The coach login is not held to these, so you can always test.
const LIMITS = {
  callsPerAccountPerDay: Number(process.env.AI_CALLS_PER_DAY) || 60,
  dollarsPerDay: Number(process.env.AI_DOLLARS_PER_DAY) || 40
};
const LIMIT_MESSAGE = "You've reached today's limit. Your work is saved. Please come back tomorrow.";

// What kind of call this was, for the cost page. The browser sends the step label.
//   script  = script help: reading your notes (b-scan), first draft (b-draft), edits (b-edit)
//   safety  = the quiet safety check on each answer
//   journey = every other step of the journey
function categoryOf(step) {
  const s = String(step || '');
  if (s === 'b' || s.indexOf('b-') === 0) return 'script';
  if (s.indexOf('safety') === 0) return 'safety';
  return 'journey';
}

module.exports = { MODEL, RATES, LIMITS, LIMIT_MESSAGE, estimateCost, categoryOf };
