'use strict';

// Public web API key for the Firebase project (it is also in the page source).
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyBAuVl_ZdnBiuN4BbtBp01z_n-2f-lJVys';

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

module.exports = { verifyFirebaseUser };
