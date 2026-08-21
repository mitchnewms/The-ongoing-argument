'use strict';

const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'ai-prompt.txt'),
  'utf8'
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { messages, step } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'messages required' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Configuration error' }) };
  }

  // Step 2 (dual-script analysis) and step b (Path B draft) get more tokens
  const maxTokens = (step === '2' || step === 'b') ? 8000 : 4000;

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
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: messages
      })
    });
  } catch (err) {
    console.error('Fetch error:', err.message);
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'AI service unreachable' }) };
  }

  if (!apiResponse.ok) {
    const errText = await apiResponse.text().catch(() => '');
    console.error('Anthropic API error', apiResponse.status, errText.slice(0, 200));
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'AI service error' }) };
  }

  let data;
  try {
    data = await apiResponse.json();
  } catch {
    return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid AI response' }) };
  }

  const text = (data.content && data.content[0] && data.content[0].text) || '';

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  };
};
