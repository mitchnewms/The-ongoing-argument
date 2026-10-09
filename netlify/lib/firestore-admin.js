'use strict';

const crypto = require('crypto');

// Server-only Firestore access using a Firebase service account. The account's JSON key lives in the
// Netlify environment variable FIREBASE_SERVICE_ACCOUNT and never reaches the browser. This is how the
// server records that a couple has paid, so no browser can ever set paidStatus itself.

let cached = null; // { token, exp }

function account() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) return null;
  try {
    const a = JSON.parse(raw);
    if (a.client_email && a.private_key && a.project_id) return a;
  } catch (e) { /* fall through */ }
  console.error('FIREBASE_SERVICE_ACCOUNT is set but is not a valid service account key');
  return null;
}

function configured() { return !!account(); }

function b64url(x) { return Buffer.from(x).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

async function accessToken() {
  const a = account();
  if (!a) throw new Error('not_configured');
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now && cached.email === a.client_email) return cached.token;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: a.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(a.private_key);
  const jwt = head + '.' + claim + '.' + b64url(sig);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt)
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error('token_failed');
  cached = { token: d.access_token, exp: now + (d.expires_in || 3600), email: a.client_email };
  return cached.token;
}

function base(a) { return 'https://firestore.googleapis.com/v1/projects/' + a.project_id + '/databases/(default)/documents/'; }

function toFields(obj) {
  const f = {};
  Object.keys(obj).forEach(function(k) {
    const v = obj[k];
    if (typeof v === 'boolean') f[k] = { booleanValue: v };
    else if (typeof v === 'number') f[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else f[k] = { stringValue: String(v) };
  });
  return f;
}

function fromFields(fields) {
  const o = {};
  Object.keys(fields || {}).forEach(function(k) {
    const v = fields[k];
    if ('stringValue' in v) o[k] = v.stringValue;
    else if ('booleanValue' in v) o[k] = v.booleanValue;
    else if ('integerValue' in v) o[k] = Number(v.integerValue);
    else if ('doubleValue' in v) o[k] = v.doubleValue;
    else if ('timestampValue' in v) o[k] = v.timestampValue;
  });
  return o;
}

// Returns the document as a plain object, or null when it does not exist.
async function getDoc(path) {
  const a = account(); const t = await accessToken();
  const r = await fetch(base(a) + path, { headers: { Authorization: 'Bearer ' + t } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('read_failed');
  return fromFields((await r.json()).fields);
}

// Merges the given fields into the document (creates it when missing).
async function setFields(path, obj) {
  const a = account(); const t = await accessToken();
  const mask = Object.keys(obj).map(function(k) { return 'updateMask.fieldPaths=' + encodeURIComponent(k); }).join('&');
  const r = await fetch(base(a) + path + '?' + mask, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(obj) })
  });
  if (!r.ok) throw new Error('write_failed');
}

// Adds a document with an automatic id.
async function addDoc(collection, obj) {
  const a = account(); const t = await accessToken();
  const r = await fetch(base(a) + collection, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(obj) })
  });
  if (!r.ok) throw new Error('write_failed');
}

// Every document in a collection as plain objects (with an id), up to maxDocs.
async function listAll(collection, maxDocs) {
  const a = account(); const t = await accessToken();
  const out = []; let pageToken = '';
  do {
    const r = await fetch(base(a) + collection + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), { headers: { Authorization: 'Bearer ' + t } });
    if (!r.ok) throw new Error('read_failed');
    const d = await r.json();
    (d.documents || []).forEach(function(doc) {
      const o = fromFields(doc.fields); o.id = doc.name.split('/').pop(); out.push(o);
    });
    pageToken = d.nextPageToken || '';
  } while (pageToken && out.length < (maxDocs || 20000));
  return out;
}

module.exports = { configured, getDoc, setFields, addDoc, listAll };
