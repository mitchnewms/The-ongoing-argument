'use strict';

const admin = require('./firestore-admin');
const { estimateCost, categoryOf } = require('./ai-costs');
const { recordSpend } = require('./ai-limits');

// Remembers who belongs to which couple for a few minutes so each AI call does not need an extra read.
const WHO = {};
async function whoIs(uid) {
  const hit = WHO[uid];
  if (hit && Date.now() - hit.t < 600000) return hit.v;
  let v = { coupleId: '', accountType: '' };
  try {
    const u = await admin.getDoc('users/' + encodeURIComponent(uid));
    if (u) v = { coupleId: u.coupleId || '', accountType: u.accountType || '' };
  } catch (e) { /* the log is still written without the couple */ }
  WHO[uid] = { t: Date.now(), v };
  return v;
}

// Writes one usage record. Numbers and labels only: never the messages, scripts or answers.
// Never throws and never holds the person up for long.
async function logUsage(uid, step, model, maxTokens, usage) {
  const rec = {
    uid: uid,
    step: String(step || 'unknown').slice(0, 40),
    category: categoryOf(step),
    model: model,
    maxTokens: maxTokens,
    inputTokens: (usage && usage.input_tokens) || 0,
    outputTokens: (usage && usage.output_tokens) || 0,
    cacheReadTokens: (usage && usage.cache_read_input_tokens) || 0,
    cacheWriteTokens: (usage && usage.cache_creation_input_tokens) || 0,
    costUsd: estimateCost(model, usage),
    ts: new Date().toISOString()
  };
  console.log('AI_USAGE ' + JSON.stringify(rec));
  if (!admin.configured()) return;
  try {
    await Promise.race([
      (async function() {
        const w = await whoIs(uid);
        rec.coupleId = w.coupleId; rec.accountType = w.accountType;
        await admin.addDoc('aiUsage', rec);
        await recordSpend(rec.costUsd);
      })(),
      new Promise(function(res) { setTimeout(res, 2500); })
    ]);
  } catch (e) { console.error('Could not save AI usage record:', e.message); }
}

module.exports = { logUsage };
