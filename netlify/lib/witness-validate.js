'use strict';

const MOVES = ['none', 'blame', 'dismiss', 'defend', 'push', 'bid', 'withdraw', 'exit'];

function norm(t) {
  return String(t || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Pulls the first JSON object out of the AI's reply.
function parseReply(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

// lines: [{ i, speaker, text }] in order. Returns { ok: true, beats } or { ok: false, why }.
function validateBeats(obj, lines) {
  if (!obj || !Array.isArray(obj.beats)) return { ok: false, why: 'no beats list' };
  const n = lines.length;
  if (!n) return { ok: false, why: 'no script lines' };
  const beats = obj.beats;
  const wantMin = n < 8 ? n : 8, wantMax = n < 8 ? n : Math.min(12, n);
  if (beats.length < wantMin || beats.length > wantMax) return { ok: false, why: 'beat count ' + beats.length + ' is outside ' + wantMin + ' to ' + wantMax };
  const byIndex = {}; lines.forEach(function(l) { byIndex[l.i] = l; });
  let last = -1; const out = [];
  for (let k = 0; k < beats.length; k++) {
    const b = beats[k] || {};
    if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 2) return { ok: false, why: 'beat ' + k + ' has bad lines' };
    const idx = b.lines.map(Number);
    if (idx.some(function(x) { return !Number.isInteger(x) || !byIndex[x]; })) return { ok: false, why: 'beat ' + k + ' cites a line that does not exist' };
    if (idx.length === 2 && idx[1] !== idx[0] + 1) return { ok: false, why: 'beat ' + k + ' cites lines that are not consecutive' };
    if (idx[0] <= last) return { ok: false, why: 'beats are out of order or overlap at ' + k };
    last = idx[idx.length - 1];
    const spk = byIndex[idx[0]].speaker;
    if (idx.some(function(x) { return byIndex[x].speaker !== spk; })) return { ok: false, why: 'beat ' + k + ' mixes speakers' };
    if (b.speaker !== spk) return { ok: false, why: 'beat ' + k + ' names the wrong speaker' };
    if (MOVES.indexOf(b.move) === -1) return { ok: false, why: 'beat ' + k + ' has an unknown move' };
    const temp = Number(b.temp);
    if (!Number.isInteger(temp) || temp < 0 || temp > 3) return { ok: false, why: 'beat ' + k + ' has a bad temp' };
    const ev = norm(b.evidence);
    if (ev.length < 2) return { ok: false, why: 'beat ' + k + ' has no evidence' };
    const hay = ' ' + idx.map(function(x) { return norm(byIndex[x].text); }).join(' ') + ' ';
    if (hay.indexOf(' ' + ev + ' ') === -1) return { ok: false, why: 'beat ' + k + ' evidence is not found in the cited line' };
    const nb = { lines: idx, speaker: spk, move: b.move, temp: temp, evidence: String(b.evidence).slice(0, 400), reason: String(b.reason || '').slice(0, 240) };
    if (spk === 'direction' && (b.actor === 'you' || b.actor === 'partner')) nb.actor = b.actor;
    out.push(nb);
  }
  if (out[0].lines[0] !== lines[0].i) return { ok: false, why: 'the first line is not included' };
  if (out[out.length - 1].lines[out[out.length - 1].lines.length - 1] !== lines[n - 1].i) return { ok: false, why: 'the last line is not included' };
  return { ok: true, beats: out };
}

module.exports = { MOVES, norm, parseReply, validateBeats };
