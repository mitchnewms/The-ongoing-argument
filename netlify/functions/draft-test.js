'use strict';

// TEMPORARY, ADMIN ONLY. The control side of the draft model test: starts a run, hands back the results, and reveals
// the blind key. The drafts themselves are written by draft-test-background.js. Delete both afterwards.
const { verifyFirebaseUser } = require('../lib/firebase-auth');
const { corsHeaders } = require('../lib/stripe-common');
const { COACH_EMAIL } = require('../lib/coach');
const admin = require('../lib/firestore-admin');
const core = require('../lib/draft-test-core');

function reply(CORS, status, obj) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}
const num = function(v) { return Number(v) || 0; };

exports.handler = async function(event) {
  const CORS = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  const who = await verifyFirebaseUser(event);
  if (who === 'unavailable') return reply(CORS, 503, { error: 'Sign-in check unavailable.', code: 'auth_unavailable' });
  if (!who) return reply(CORS, 401, { error: 'Please sign in.', code: 'unauthorized' });
  if ((who.email || '').toLowerCase() !== COACH_EMAIL) return reply(CORS, 403, { error: 'Only the admin account can use this test.', code: 'forbidden' });
  if (!admin.configured()) return reply(CORS, 503, { error: 'The server key is not set up yet (FIREBASE_SERVICE_ACCOUNT).', code: 'not_configured' });
  if (!process.env.ANTHROPIC_API_KEY) return reply(CORS, 503, { error: 'ANTHROPIC_API_KEY is not set for this deploy.', code: 'no_ai_key' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(CORS, 400, { error: 'Invalid JSON', code: 'bad_request' }); }

  try {
    if (body.action === 'start') {
      const runId = 'run' + Date.now().toString(36);
      const plan = core.makePlan(runId);
      const R = await core.loadStoryR(admin);
      const ctxs = { R: R, M: core.storyCtx('M'), T: core.storyCtx('T') };
      await admin.setFields('draftTests/' + runId + '_meta', {
        runId: runId, createdAt: new Date().toISOString(), key: JSON.stringify(plan.key), cases: JSON.stringify(plan.cases),
        ctxR: JSON.stringify(R), master: core.masterPrompt() ? 'loaded' : 'MISSING'
      });
      const stories = {};
      Object.keys(ctxs).forEach(function(k) { const c = ctxs[k]; stories[k] = { title: c.title || (c.id + ''), source: c.source || '', error: c.error || '', story: c.story || '', answers: c.answers || null, notes: c.skipped || [], nameA: c.nameA, nameB: c.nameB }; });
      return reply(CORS, 200, { runId: runId, cases: plan.cases.map(function(c) { return { caseId: c.caseId, story: c.story, letter: c.letter, run: c.run }; }), stories: stories, masterLoaded: !!core.masterPrompt() });
    }

    const runId = String(body.runId || '');
    if (!/^run[a-z0-9]+$/.test(runId)) return reply(CORS, 400, { error: 'Bad run id', code: 'bad_request' });
    const meta = await admin.getDoc('draftTests/' + runId + '_meta');
    if (!meta) return reply(CORS, 404, { error: 'No such run.', code: 'not_found' });
    const cases = JSON.parse(meta.cases);

    if (body.action === 'results') {
      const all = await admin.listAll('draftTests', 500);
      const mine = {}; all.forEach(function(d) { if (d.id.indexOf(runId + '_c') === 0) mine[d.id.slice(runId.length + 1)] = d; });
      const out = cases.map(function(c) {
        const d = mine[c.caseId];
        if (!d) return { caseId: c.caseId, story: c.story, letter: c.letter, run: c.run, status: 'pending' };
        return { caseId: c.caseId, story: c.story, letter: c.letter, run: c.run, status: d.status, error: d.error || '', draft: d.draft || '', checks: d.checks ? JSON.parse(d.checks) : null,
          tokens: { input: num(d.inTok), output: num(d.outTok), cacheRead: num(d.cacheRead), cacheWrite: num(d.cacheWrite) }, cost: num(d.cost), seconds: num(d.seconds) };
      });
      return reply(CORS, 200, { runId: runId, results: out, done: out.filter(function(x) { return x.status === 'done' || x.status === 'error'; }).length, total: out.length });
    }
    if (body.action === 'key') {
      const key = JSON.parse(meta.key);
      const setups = {}; core.SETUPS.forEach(function(s) { setups[s.id] = { name: s.name, model: s.model, prompt: s.prompt, rate: core.RATES[s.model] }; });
      return reply(CORS, 200, { key: key, setups: setups, maxTokens: core.MAX_TOKENS });
    }
    return reply(CORS, 400, { error: 'Unknown action', code: 'bad_request' });
  } catch (e) {
    console.error('draft-test failed:', e.message);
    return reply(CORS, 500, { error: 'The test control step failed: ' + e.message, code: 'failed' });
  }
};
