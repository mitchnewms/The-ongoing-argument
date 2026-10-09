'use strict';

const fs = require('fs');
const path = require('path');
const { MODEL } = require('../lib/ai-costs');
const { logUsage } = require('../lib/ai-usage');

// Load the master prompt without ever throwing at startup. A crash here makes every
// request fail with no explanation, so a missing file is reported on each request instead.
let SYSTEM_PROMPT = '';
let PROMPT_PROBLEM = '';
(function loadPrompt() {
  const roots = [__dirname, process.env.LAMBDA_TASK_ROOT, process.cwd()].filter(Boolean);
  const names = ['ai-prompt.txt', path.join('netlify', 'functions', 'ai-prompt.txt')];
  const tried = [];
  for (const root of roots) {
    for (const name of names) {
      const file = path.join(root, name);
      if (tried.indexOf(file) !== -1) continue;
      tried.push(file);
      try {
        const text = fs.readFileSync(file, 'utf8');
        if (text.length > 1000) { SYSTEM_PROMPT = text; return; }
      } catch (err) { /* try the next location */ }
    }
  }
  PROMPT_PROBLEM = 'ai-prompt.txt not found. Looked in: ' + tried.join(', ');
  console.error(PROMPT_PROBLEM);
})();

// Public web API key for the Firebase project (it is also in the page source).
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyBAuVl_ZdnBiuN4BbtBp01z_n-2f-lJVys';

const ALLOWED_ORIGINS = [
  'https://theongoingargument.com',
  'https://www.theongoingargument.com',
  'https://mitchnewman.com',
  'https://www.mitchnewman.com',
  'https://imaginative-starburst-a1bbd9.netlify.app'
];

const MAX_BODY_CHARS = 300000;
const MAX_MESSAGES = 200;

function corsHeaders(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

// Confirms the Firebase ID token with Google. Returns { uid, email }, null for a bad
// token, or 'unavailable' when Google could not be reached (so the caller can retry).
async function verifyFirebaseUser(event) {
  const header = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const idToken = m[1].trim();
  if (idToken.length < 20 || idToken.length > 4096) return null;
  let r;
  try {
    r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });
  } catch (err) {
    console.error('Auth lookup unreachable:', err.message);
    return 'unavailable';
  }
  if (r.status >= 500) return 'unavailable';
  if (!r.ok) return null;
  let d;
  try { d = await r.json(); } catch { return null; }
  const u = d && d.users && d.users[0];
  if (!u || u.disabled) return null;
  return { uid: u.localId, email: u.email || '' };
}

exports.handler = async function(event) {
  const CORS_HEADERS = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  // Only signed-in users may use the AI. This runs before anything else is parsed or paid for.
  const who = await verifyFirebaseUser(event);
  if (who === 'unavailable') {
    return { statusCode: 503, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Sign-in check unavailable. Please try again.', code: 'auth_unavailable' }) };
  }
  if (!who) {
    console.warn('AI request rejected: missing or invalid sign-in token');
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Please sign in to use this.', code: 'unauthorized' }) };
  }

  if ((event.body || '').length > MAX_BODY_CHARS) {
    return { statusCode: 413, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Request too large', code: 'too_large' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON', code: 'bad_request' }) };
  }

  const { messages, step } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES ||
      !messages.every(function(m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; })) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'messages required', code: 'bad_request' }) };
  }

  if (!SYSTEM_PROMPT) {
    console.error('AI request failed: ' + PROMPT_PROBLEM);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'The AI is not set up correctly on the server.', code: 'config_prompt' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Configuration error', code: 'config' }) };
  }

  // Step 2 (dual-script analysis) and step b (Path B draft) get more tokens
  const isSafetyCheck = typeof step === 'string' && step.indexOf('safety') === 0;
  const maxTokens = isSafetyCheck ? 300 : ((step === '2' || step === 'b') ? 8000 : 4000);

  let apiResponse;
  try {
    apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: messages
      })
    });
  } catch (err) {
    console.error('Fetch error:', err.message);
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'AI service unreachable', code: 'anthropic_unreachable' }) };
  }

  if (!apiResponse.ok) {
    const errText = await apiResponse.text().catch(() => '');
    console.error('Anthropic API error', apiResponse.status, errText.slice(0, 200));
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'AI service error', code: 'anthropic_' + apiResponse.status }) };
  }

  let data;
  try {
    data = await apiResponse.json();
  } catch {
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid AI response', code: 'bad_response' }) };
  }

  const text = (data.content && data.content[0] && data.content[0].text) || '';
  await logUsage(who.uid, step, MODEL, maxTokens, data.usage);
  if (text.indexOf('[[COACH_FLAG') !== -1) console.warn('SAFETY FLAG raised for user ' + who.uid + ' at step ' + step);

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  };
};
