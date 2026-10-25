'use strict';

const fs = require('fs');
const path = require('path');
const { MODEL } = require('./ai-costs');

// The master prompt, loaded the same way the AI function loads it. It is never changed here.
let SYSTEM_PROMPT = '';
(function load() {
  const roots = [__dirname, path.join(__dirname, '..', 'functions'), process.env.LAMBDA_TASK_ROOT, process.cwd()].filter(Boolean);
  const names = ['ai-prompt.txt', path.join('netlify', 'functions', 'ai-prompt.txt')];
  for (const root of roots) {
    for (const name of names) {
      try { const t = fs.readFileSync(path.join(root, name), 'utf8'); if (t.length > 1000) { SYSTEM_PROMPT = t; return; } } catch (e) { /* next */ }
    }
  }
  console.error('ai-prompt.txt not found for the couple function');
})();

function ready() { return !!SYSTEM_PROMPT && !!process.env.ANTHROPIC_API_KEY; }

// One call to the model with the master prompt as the system prompt. Returns { text, usage } or throws with .code.
async function ask(messages, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }], messages: messages })
    });
  } catch (e) { const err = new Error('unreachable'); err.code = 'anthropic_unreachable'; throw err; }
  if (!r.ok) { const err = new Error('anthropic ' + r.status); err.code = 'anthropic_' + r.status; throw err; }
  const d = await r.json();
  return { text: (d.content && d.content[0] && d.content[0].text) || '', usage: d.usage };
}

module.exports = { ready, ask, MODEL };
