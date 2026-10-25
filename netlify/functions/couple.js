'use strict';

const admin = require('../lib/firestore-admin');
const claude = require('../lib/claude');
const { verifyFirebaseUser } = require('../lib/firebase-auth');
const { corsHeaders } = require('../lib/stripe-common');
const { LIMIT_MESSAGE } = require('../lib/ai-costs');
const { checkLimits } = require('../lib/ai-limits');
const { logUsage } = require('../lib/ai-usage');
const { buildStep2Prompt, scriptDataToText, normalize } = require('../lib/couple-text');

// Everything in the couple flow that needs the OTHER partner's private script happens here, on the server.
// A browser never reads the partner's script. What a partner may see is only what each person chose to share at
// the sharing moment (the shared copy), and the joint analysis, which is stored in the shared couple record.
//
// actions:  status  analyze  share  ai
function reply(CORS, status, obj) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}
const LOCK_MS = 180000;

// Who is asking, which couple they belong to, and who their partner is. The couple always comes from the
// server's own records, never from anything the browser sends.
async function context(uid) {
  const u = await admin.getDoc('users/' + encodeURIComponent(uid));
  if (!u || !u.coupleId) return { error: 'no_couple' };
  const c = await admin.getDoc('couples/' + encodeURIComponent(u.coupleId));
  if (!c) return { error: 'no_couple' };
  let partnerUid = '';
  if (c.partnerAId === uid) partnerUid = c.partnerBId || '';
  else if (c.partnerBId === uid) partnerUid = c.partnerAId || '';
  else return { error: 'not_a_member' };
  return { u: u, c: c, coupleId: u.coupleId, partnerUid: partnerUid };
}

exports.handler = async function(event) {
  const CORS = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  const who = await verifyFirebaseUser(event);
  if (who === 'unavailable') return reply(CORS, 503, { error: 'Sign-in check unavailable.', code: 'auth_unavailable' });
  if (!who) return reply(CORS, 401, { error: 'Please sign in.', code: 'unauthorized' });
  if ((event.body || '').length > 300000) return reply(CORS, 413, { error: 'Too large', code: 'too_large' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(CORS, 400, { error: 'Invalid JSON', code: 'bad_request' }); }
  if (!admin.configured()) return reply(CORS, 503, { error: 'The server key is not set up yet.', code: 'not_configured' });
  const action = String(body.action || '');
  if (['status', 'analyze', 'share', 'ai'].indexOf(action) === -1) return reply(CORS, 400, { error: 'Unknown action', code: 'bad_request' });

  let cx;
  try { cx = await context(who.uid); } catch (e) { console.error('couple: context failed', e.message); return reply(CORS, 502, { error: 'Could not read your couple record.', code: 'read_failed' }); }
  if (cx.error) return reply(CORS, 403, { error: 'This is only for linked couples.', code: cx.error });
  const myName = cx.u.name || 'Partner A';
  const partnerName = cx.u.partnerName || 'Partner B';
  const fightName = cx.c.fightName || cx.u.fightName || 'The Ongoing Argument';

  try {
    // ---- Step 2: has the other partner submitted? Returns yes or no and nothing else about them.
    if (action === 'status' || action === 'analyze') {
      const mine = await admin.getDoc('scripts/' + encodeURIComponent(who.uid));
      const theirs = cx.partnerUid ? await admin.getDoc('scripts/' + encodeURIComponent(cx.partnerUid)) : null;
      const both = !!(mine && mine.submitted === true && theirs && theirs.submitted === true);
      if (action === 'status') return reply(CORS, 200, { bothSubmitted: both, analysisReady: !!cx.c.analysisReady });
      if (!both) return reply(CORS, 200, { bothSubmitted: false, analysisReady: !!cx.c.analysisReady });
      if (cx.c.analysisReady) return reply(CORS, 200, { bothSubmitted: true, analysisReady: true });
      if (cx.c.analysisLockAt && Date.now() - Date.parse(cx.c.analysisLockAt) < LOCK_MS) return reply(CORS, 200, { bothSubmitted: true, analysisReady: false, pending: true });
      if (!claude.ready()) return reply(CORS, 500, { error: 'The AI is not set up on the server.', code: 'config' });
      const limited = await checkLimits(who.uid, who.email, false);
      if (limited) return reply(CORS, 429, { error: LIMIT_MESSAGE, code: 'daily_limit' });
      await admin.setFields('couples/' + encodeURIComponent(cx.coupleId), { analysisLockAt: new Date().toISOString() });
      let warmup = null; try { warmup = await admin.getDoc('warmup/' + encodeURIComponent(who.uid)); } catch (e) { warmup = null; }
      const prompt = buildStep2Prompt({ myData: normalize(mine), partnerData: normalize(theirs), myName: myName, partnerName: partnerName, fightName: fightName, warmup: warmup });
      let out;
      try { out = await claude.ask([{ role: 'user', content: prompt }], 8000); }
      catch (e) {
        console.error('couple: analysis failed', e.code || e.message);
        try { await admin.setFields('couples/' + encodeURIComponent(cx.coupleId), { analysisLockAt: '' }); } catch (x) { /* the lock runs out by itself */ }
        return reply(CORS, 502, { error: 'The analysis could not be made.', code: e.code || 'ai_failed' });
      }
      await logUsage(who.uid, '2', claude.MODEL, 8000, out.usage);
      if (!out.text || out.text.trim().length < 40) {
        try { await admin.setFields('couples/' + encodeURIComponent(cx.coupleId), { analysisLockAt: '' }); } catch (x) { /* ok */ }
        return reply(CORS, 502, { error: 'The analysis came back empty.', code: 'empty' });
      }
      await admin.setFields('couples/' + encodeURIComponent(cx.coupleId), { analysis: out.text, analysisReady: true, analysisAt: new Date().toISOString(), currentStep: '3', analysisLockAt: '' });
      return reply(CORS, 200, { bothSubmitted: true, analysisReady: true, created: true });
    }

    // ---- The sharing moment (continuing from Step 4 to Step 5): write the shared copy of this person's script.
    // Only the script lines, the scene line, the name of the fight and the names. Nothing else is ever copied.
    if (action === 'share') {
      const mine = await admin.getDoc('scripts/' + encodeURIComponent(who.uid));
      if (!mine || mine.submitted !== true) return reply(CORS, 409, { error: 'Your script has not been submitted yet.', code: 'not_submitted' });
      if (!cx.c.analysisReady) return reply(CORS, 409, { error: 'The analysis is not ready yet.', code: 'not_ready' });
      let lines = mine.lines;
      if (typeof lines === 'string') { try { lines = JSON.parse(lines); } catch (e) { lines = []; } }
      lines = (Array.isArray(lines) ? lines : []).map(function(l) {
        return l.type === 'line'
          ? { type: 'line', char: String(l.char || ''), beat: String(l.beat || ''), aiTone: l.aiTone === true, dialogue: String(l.dialogue || '') }
          : { type: 'direction', text: String(l.text || '') };
      });
      await admin.setFields('sharedScripts/' + encodeURIComponent(who.uid), {
        userId: who.uid, coupleId: cx.coupleId, authorName: myName, partnerName: partnerName, fightName: fightName,
        scene: String(mine.scene || ''), lines: JSON.stringify(lines), sharedAt: new Date().toISOString()
      });
      return reply(CORS, 200, { ok: true });
    }

    // ---- Step 3 conversation: the AI is given the partner's script here, on the server, and the browser never sees it.
    // The page writes the token [[PARTNER_SCRIPT]] where that script belongs.
    if (action === 'ai') {
      const step = String(body.step || '3');
      if (step !== '3') return reply(CORS, 400, { error: 'Unknown step', code: 'bad_request' });
      const messages = body.messages;
      if (!Array.isArray(messages) || !messages.length || messages.length > 200 || !messages.every(function(m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; })) return reply(CORS, 400, { error: 'messages required', code: 'bad_request' });
      if (!claude.ready()) return reply(CORS, 500, { error: 'The AI is not set up on the server.', code: 'config' });
      const limited = await checkLimits(who.uid, who.email, false);
      if (limited) return reply(CORS, 429, { error: LIMIT_MESSAGE, code: 'daily_limit' });
      let partnerText = '';
      if (messages.some(function(m) { return m.content.indexOf('[[PARTNER_SCRIPT]]') !== -1; })) {
        const theirs = cx.partnerUid ? await admin.getDoc('scripts/' + encodeURIComponent(cx.partnerUid)) : null;
        partnerText = theirs ? scriptDataToText(theirs, 'your partner', myName) : '(your partner has not written a script yet)';
      }
      const filled = messages.map(function(m) { return { role: m.role, content: m.role === 'user' ? m.content.split('[[PARTNER_SCRIPT]]').join(partnerText) : m.content }; });
      let out;
      try { out = await claude.ask(filled, 4000); }
      catch (e) { console.error('couple: ai failed', e.code || e.message); return reply(CORS, 502, { error: 'AI service error', code: e.code || 'ai_failed' }); }
      await logUsage(who.uid, '3', claude.MODEL, 4000, out.usage);
      return reply(CORS, 200, { text: out.text });
    }
  } catch (err) {
    console.error('couple: ' + action + ' failed:', err.message);
    return reply(CORS, 502, { error: 'Something went wrong on the server.', code: 'server_error' });
  }
};
