'use strict';

const admin = require('./firestore-admin');
const { LIMITS } = require('./ai-costs');
const { COACH_EMAIL } = require('./coach');

function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }

let warned = false;

// Returns null when the call may go ahead, or { which } when a daily limit has been reached.
// Safety checks and the coach login are never blocked. If the server key is missing or the counter
// cannot be reached, the call goes ahead (the limits fail open) and the problem is logged.
async function checkLimits(uid, email, isSafety) {
  if (isSafety || (email || '').toLowerCase() === COACH_EMAIL) return null;
  if (!admin.configured()) {
    if (!warned) { console.warn('Daily AI limits are NOT being enforced: FIREBASE_SERVICE_ACCOUNT is not set'); warned = true; }
    return null;
  }
  try {
    const day = today();
    const both = await Promise.all([
      admin.getDoc('aiDaily/' + day + '_total'),
      admin.increment('aiDaily/' + day + '_u_' + encodeURIComponent(uid), { calls: 1 })
    ]);
    if (both[0] && (both[0].costUsd || 0) >= LIMITS.dollarsPerDay) return { which: 'overall' };
    if (both[1].calls > LIMITS.callsPerAccountPerDay) return { which: 'account' };
    return null;
  } catch (err) {
    console.error('Daily limit check failed, letting the call through:', err.message);
    return null;
  }
}

// Adds the cost of a finished call to today's overall total.
async function recordSpend(costUsd) {
  if (!admin.configured()) return;
  try { await admin.increment('aiDaily/' + today() + '_total', { calls: 1, costUsd: costUsd || 0 }); }
  catch (err) { console.error('Could not update the daily total:', err.message); }
}

module.exports = { checkLimits, recordSpend, today };
