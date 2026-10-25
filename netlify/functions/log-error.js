'use strict';

const admin = require('../lib/firestore-admin');
const { verifyFirebaseUser } = require('../lib/firebase-auth');
const { corsHeaders } = require('../lib/stripe-common');

// Records what really went wrong when a save or an AI step fails in the browser, so it can be read on the admin page.
// It stores the account id, where it failed, the status and the service's own message. It never stores what the person wrote.
function reply(CORS, status, obj) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
function clip(v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').slice(0, n); }

exports.handler = async function(event) {
  const CORS = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  if ((event.body || '').length > 6000) return reply(CORS, 413, { error: 'Too large', code: 'too_large' });
  const who = await verifyFirebaseUser(event);
  if (who === 'unavailable') return reply(CORS, 503, { error: 'Sign-in check unavailable.', code: 'auth_unavailable' });
  if (!who) return reply(CORS, 401, { error: 'Please sign in.', code: 'unauthorized' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(CORS, 400, { error: 'Invalid JSON', code: 'bad_request' }); }
  const info = (body.info && typeof body.info === 'object') ? body.info : {};
  const row = {
    uid: who.uid, email: clip(who.email, 80), at: new Date().toISOString(),
    kind: clip(body.kind, 40), where: clip(body.where, 80),
    status: clip(info.status, 12), code: clip(info.code, 60), message: clip(info.message, 300),
    detail: clip(info.detail, 400), fields: clip(info.fields, 600), page: clip(body.page, 80), agent: clip(body.agent, 120)
  };
  console.error('CLIENT FAILURE ' + JSON.stringify({ uid: row.uid, kind: row.kind, where: row.where, status: row.status, code: row.code, message: row.message, detail: row.detail }));
  if (!admin.configured()) return reply(CORS, 200, { ok: true, stored: false });
  try { await admin.addDoc('errorLog', row); return reply(CORS, 200, { ok: true, stored: true }); }
  catch (e) { console.error('Could not store the failure note:', e.message); return reply(CORS, 200, { ok: true, stored: false }); }
};
