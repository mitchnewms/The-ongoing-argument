'use strict';

// TEMPORARY, ADMIN ONLY. Writes ONE draft for ONE case of the draft model test, then saves it with its plain checks.
// It is a background function (the name ends in -background), so it may run for several minutes. Delete it afterwards.
const { verifyFirebaseUser } = require('../lib/firebase-auth');
const { COACH_EMAIL } = require('../lib/coach');
const admin = require('../lib/firestore-admin');
const core = require('../lib/draft-test-core');

exports.handler = async function(event) {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405 };
    const who = await verifyFirebaseUser(event);
    if (!who || who === 'unavailable' || (who.email || '').toLowerCase() !== COACH_EMAIL) return { statusCode: 403 };
    if (!admin.configured() || !process.env.ANTHROPIC_API_KEY) return { statusCode: 503 };
    let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400 }; }
    const runId = String(body.runId || ''), caseId = String(body.caseId || '');
    if (!/^run[a-z0-9]+$/.test(runId) || !/^c\d\d$/.test(caseId)) return { statusCode: 400 };
    const meta = await admin.getDoc('draftTests/' + runId + '_meta');
    if (!meta) return { statusCode: 404 };
    const c = JSON.parse(meta.cases).filter(function(x) { return x.caseId === caseId; })[0];
    if (!c) return { statusCode: 404 };
    const setup = core.SETUPS.filter(function(s) { return s.id === c.setupId; })[0];
    const base = { caseId: caseId, story: c.story, letter: c.letter, run: c.run, model: setup.model, setupId: setup.id };
    let ctx = c.story === 'R' ? JSON.parse(meta.ctxR) : core.storyCtx(c.story);
    if (ctx.error) { await admin.setFields('draftTests/' + runId + '_' + caseId, Object.assign({}, base, { status: 'error', error: ctx.error })); return { statusCode: 200 }; }
    const instruction = core.buildDraftInstruction(ctx);
    const res = await core.callModel(setup, instruction, process.env.ANTHROPIC_API_KEY);
    if (res.error) { await admin.setFields('draftTests/' + runId + '_' + caseId, Object.assign({}, base, { status: 'error', error: res.error })); return { statusCode: 200 }; }
    const u = res.usage || {};
    const checks = core.analyze(res.text, ctx);
    await admin.setFields('draftTests/' + runId + '_' + caseId, Object.assign({}, base, {
      status: 'done', draft: res.text, raw: res.raw || '', stopReason: res.stopReason || '', checks: JSON.stringify(checks),
      inTok: u.input_tokens || 0, outTok: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
      cost: core.costOf(setup.model, u), seconds: res.seconds
    }));
    return { statusCode: 200 };
  } catch (e) {
    console.error('draft-test-background failed:', e.message);
    try {
      const b = JSON.parse(event.body || '{}');
      if (/^run[a-z0-9]+$/.test(String(b.runId)) && /^c\d\d$/.test(String(b.caseId))) await admin.setFields('draftTests/' + b.runId + '_' + b.caseId, { caseId: b.caseId, status: 'error', error: 'The test step stopped: ' + e.message });
    } catch (x) { /* nothing more to do */ }
    return { statusCode: 500 };
  }
};
