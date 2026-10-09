'use strict';

const { verifyFirebaseUser } = require('../lib/firebase-auth');
const { corsHeaders } = require('../lib/stripe-common');
const { COACH_EMAIL } = require('../lib/coach');
const admin = require('../lib/firestore-admin');

function reply(CORS, status, obj) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

const TZ = 'America/Los_Angeles';
function dayKey(iso) { return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }); }
const r4 = function(x) { return Math.round(x * 10000) / 10000; };

function summarize(usage, users, couples, step11) {
  const reached = {}; step11.forEach(function(d) { if (d.reachedAt) reached[d.id] = true; });
  const userById = {}; users.forEach(function(u) { userById[u.id] = u; });
  const coupleById = {}; couples.forEach(function(c) { coupleById[c.id] = c; });

  const today = dayKey(new Date().toISOString());
  const weekStart = dayKey(new Date(Date.now() - 6 * 86400000).toISOString());
  let total = 0, todayTotal = 0, weekTotal = 0;
  const byAccount = {}, byGroup = {}, bySteps = {};
  usage.forEach(function(u) {
    const c = u.costUsd || 0; total += c;
    if (u.ts) { const k = dayKey(u.ts); if (k === today) todayTotal += c; if (k >= weekStart) weekTotal += c; }
    const a = byAccount[u.uid] || (byAccount[u.uid] = { uid: u.uid, cost: 0, calls: 0, coupleId: u.coupleId || '' });
    a.cost += c; a.calls++; if (u.coupleId) a.coupleId = u.coupleId;
    const gk = u.coupleId ? 'couple:' + u.coupleId : 'solo:' + u.uid;
    byGroup[gk] = (byGroup[gk] || 0) + c;
    const st = bySteps[u.step] || (bySteps[u.step] = { step: u.step, calls: 0, cost: 0, inTok: 0, outTok: 0, accounts: {} });
    st.calls++; st.cost += c; st.inTok += u.inputTokens || 0; st.outTok += u.outputTokens || 0; st.accounts[u.uid] = true;
  });

  // Completed: a person who reached Step 11, or a couple where both partners did.
  const completedSolo = [], completedCouples = [];
  Object.keys(byGroup).forEach(function(gk) {
    const kind = gk.slice(0, gk.indexOf(':')), id = gk.slice(gk.indexOf(':') + 1);
    if (kind === 'solo') { if (reached[id]) completedSolo.push(byGroup[gk]); }
    else {
      const c = coupleById[id];
      if (c && c.partnerAId && c.partnerBId && reached[c.partnerAId] && reached[c.partnerBId]) completedCouples.push(byGroup[gk]);
    }
  });
  const avg = function(a) { return a.length ? r4(a.reduce(function(x, y) { return x + y; }, 0) / a.length) : null; };
  const soloAll = Object.keys(byGroup).filter(function(k) { return k.indexOf('solo:') === 0; }).map(function(k) { return byGroup[k]; });
  const coupleAll = Object.keys(byGroup).filter(function(k) { return k.indexOf('couple:') === 0; }).map(function(k) { return byGroup[k]; });

  const steps = Object.keys(bySteps).map(function(k) {
    const s = bySteps[k]; const n = Object.keys(s.accounts).length;
    return { step: s.step, calls: s.calls, accounts: n, totalCost: r4(s.cost), avgPerCall: r4(s.cost / s.calls), avgPerAccount: r4(s.cost / n),
      avgInputTokens: Math.round(s.inTok / s.calls), avgOutputTokens: Math.round(s.outTok / s.calls) };
  }).sort(function(a, b) { return b.totalCost - a.totalCost; });

  const top = Object.keys(byAccount).map(function(k) { return byAccount[k]; })
    .sort(function(a, b) { return b.cost - a.cost; }).slice(0, 5).map(function(a) {
      const u = userById[a.uid] || {};
      return { name: u.name || '', email: u.email || '', coupleId: a.coupleId, cost: r4(a.cost), calls: a.calls };
    });

  return {
    timezone: TZ, calls: usage.length,
    spend: { today: r4(todayTotal), last7Days: r4(weekTotal), allTime: r4(total) },
    average: {
      individual: { completed: completedSolo.length, avgCompleted: avg(completedSolo), accountsSoFar: soloAll.length, avgSoFar: avg(soloAll) },
      couple: { completed: completedCouples.length, avgCompleted: avg(completedCouples), couplesSoFar: coupleAll.length, avgSoFar: avg(coupleAll) }
    },
    steps, topAccounts: top
  };
}

exports.handler = async function(event) {
  const CORS = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const who = await verifyFirebaseUser(event);
  if (who === 'unavailable') return reply(CORS, 503, { error: 'Sign-in check unavailable.', code: 'auth_unavailable' });
  if (!who) return reply(CORS, 401, { error: 'Please sign in.', code: 'unauthorized' });
  if ((who.email || '').toLowerCase() !== COACH_EMAIL) return reply(CORS, 403, { error: 'This page is only for the coach login.', code: 'forbidden' });
  if (!admin.configured()) return reply(CORS, 503, { error: 'The server key is not set up yet (FIREBASE_SERVICE_ACCOUNT).', code: 'not_configured' });

  const view = (event.queryStringParameters && event.queryStringParameters.view) || '';
  try {
    if (view === 'waitlist') {
      const list = await admin.listAll('waitlist', 20000);
      list.sort(function(a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
      return reply(CORS, 200, { count: list.length, entries: list.map(function(x) { return { email: x.email, createdAt: x.createdAt }; }) });
    }
    if (view === 'usage') {
      const usage = await admin.listAll('aiUsage', 30000);
      const parts = await Promise.all([admin.listAll('users', 20000), admin.listAll('couples', 20000), admin.listAll('step11', 20000)]);
      const out = summarize(usage, parts[0], parts[1], parts[2]);
      out.truncated = usage.length >= 30000;
      return reply(CORS, 200, out);
    }
    return reply(CORS, 400, { error: 'Unknown view', code: 'bad_request' });
  } catch (err) {
    console.error('Admin read failed:', err.message);
    return reply(CORS, 502, { error: 'Could not read the data.', code: 'read_failed' });
  }
};
exports._summarize = summarize;
