'use strict';

const fs = require('fs');
const path = require('path');
const { MODEL, LIMIT_MESSAGE } = require('../lib/ai-costs');
const { checkLimits } = require('../lib/ai-limits');
const { logUsage } = require('../lib/ai-usage');
const { verifyFirebaseUser } = require('../lib/firebase-auth');
const { corsHeaders } = require('../lib/stripe-common');
const admin = require('../lib/firestore-admin');
const { parseReply, validateBeats } = require('../lib/witness-validate');

// The "Witness scene" call: reads the saved script and marks what the words do between the two people.
// It has its own prompt file and never uses the master prompt.
let PROMPT = '';
(function load() {
  const roots = [__dirname, process.env.LAMBDA_TASK_ROOT, process.cwd()].filter(Boolean);
  for (const root of roots) {
    for (const name of ['witness-prompt.txt', path.join('netlify', 'functions', 'witness-prompt.txt')]) {
      try { const t = fs.readFileSync(path.join(root, name), 'utf8'); if (t.length > 500) { PROMPT = t; return; } } catch (e) { /* next */ }
    }
  }
  console.error('witness-prompt.txt not found');
})();

function reply(CORS, status, obj) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

async function hasSafetyFlag(uid) {
  if (!admin.configured()) return false;
  try { const flags = await admin.listAll('coachFlags', 5000); return flags.some(function(f) { return f.triggeredByUid === uid; }); }
  catch (e) { console.error('Witness: could not check safety flags:', e.message); return false; }
}

async function askOnce(apiKey, input, note) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2500, temperature: 0.2, system: PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(input) + (note ? '\n\nYour last answer was rejected: ' + note + '. Return the JSON again, fixing exactly that.' : '') }]
    })
  });
  if (!r.ok) { const e = new Error('anthropic ' + r.status); e.status = r.status; throw e; }
  return r.json();
}

exports.handler = async function(event) {
  const CORS = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const who = await verifyFirebaseUser(event);
  if (who === 'unavailable') return reply(CORS, 503, { error: 'Sign-in check unavailable.', code: 'auth_unavailable' });
  if (!who) return reply(CORS, 401, { error: 'Please sign in.', code: 'unauthorized' });
  if ((event.body || '').length > 60000) return reply(CORS, 413, { error: 'Too large', code: 'too_large' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return reply(CORS, 400, { error: 'Invalid JSON', code: 'bad_request' }); }

  const lines = Array.isArray(body.lines) ? body.lines.map(function(l) {
    return { i: Number(l.i), speaker: l.speaker, text: String(l.text || '').slice(0, 1500), tone: l.tone ? String(l.tone).slice(0, 100) : '', cue: l.cue ? String(l.cue).slice(0, 200) : '' };
  }) : [];
  if (!lines.length || lines.length > 80 || lines.some(function(l, k) { return l.i !== k || ['you', 'partner', 'direction'].indexOf(l.speaker) === -1 || !l.text; })) {
    return reply(CORS, 400, { error: 'The script lines were not in the expected form.', code: 'bad_request' });
  }
  if (!PROMPT) return reply(CORS, 500, { error: 'The scene is not set up on the server.', code: 'config_prompt' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return reply(CORS, 500, { error: 'Configuration error', code: 'config' });

  // A person who has a safety flag never gets the scene.
  if (await hasSafetyFlag(who.uid)) return reply(CORS, 200, { skipped: 'safety' });

  const limited = await checkLimits(who.uid, who.email, false);
  if (limited) return reply(CORS, 429, { error: LIMIT_MESSAGE, code: 'daily_limit' });

  const input = {
    you: String(body.you || 'you').slice(0, 40), partner: String(body.partner || 'your partner').slice(0, 40),
    lines: lines.map(function(l) { const o = { index: l.i, speaker: l.speaker, text: l.text }; if (l.tone) o.tone = l.tone; if (l.cue) o.cue = l.cue; return o; })
  };
  if (body.energy && typeof body.energy === 'object') input.energy_words = { you: String((body.energy.you || '')).slice(0, 120), partner: String((body.energy.partner || '')).slice(0, 120) };

  let note = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let data;
    try { data = await askOnce(apiKey, input, note); }
    catch (err) { console.error('Witness call failed:', err.message); return reply(CORS, 502, { error: 'The scene could not be made.', code: 'ai_failed' }); }
    await logUsage(who.uid, 'witness', MODEL, 2500, data.usage);
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    const v = validateBeats(parseReply(text), lines);
    if (v.ok) return reply(CORS, 200, { beats: v.beats });
    note = v.why; console.warn('Witness reply rejected (' + (attempt + 1) + '): ' + v.why);
  }
  return reply(CORS, 200, { skipped: 'invalid' });
};
