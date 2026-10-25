'use strict';

// TEST TOOLS. REMOVE BEFORE LAUNCH (delete this whole file, the "Test tools" block in beta147/admin.html,
// and the netlify.toml note if one is added).
//
// Lets the admin account (mitch@mitchnewman.com, checked on the server) load a complete sample individual
// story into a TEST account, or reset the saved analysis on it, so the journey can be tested without
// retyping an intake. It can only touch accounts whose email looks like a test address, and never an
// account that belongs to a couple. A normal user cannot call it: the sign in token must be the admin's.

const { verifyFirebaseUser } = require('../lib/firebase-auth');
const { corsHeaders } = require('../lib/stripe-common');
const { COACH_EMAIL } = require('../lib/coach');
const admin = require('../lib/firestore-admin');

const TEST_EMAIL = new RegExp(process.env.TEST_ACCOUNT_PATTERN || '^mitch\\+[a-z0-9._-]+@wearecapglobal\\.com$', 'i');

function reply(CORS, status, obj) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

// Sam and Dana, a money fight about a $400 drone. Character A is Sam, character B is Dana.
const SAMPLE_LINES = [
  { type: 'line', char: 'B', beat: 'evenly', dialogue: "Hey. There's a box on the porch with your name on it." },
  { type: 'line', char: 'A', beat: 'casual', dialogue: "Oh, that. It's the drone. I told you I was looking at one." },
  { type: 'line', char: 'B', beat: 'guarded', dialogue: "You looked at one. You never said you were buying it." },
  { type: 'line', char: 'A', beat: 'defensive', dialogue: "It was four hundred dollars. It's not like it's the rent." },
  { type: 'line', char: 'B', beat: 'dismissive', dialogue: "Four hundred dollars we said we'd put toward the car." },
  { type: 'line', char: 'A', beat: 'frustrated', dialogue: "I work too. I'm allowed to spend something on myself." },
  { type: 'line', char: 'B', beat: 'sarcastic', dialogue: "Sure. And I'm allowed to find out from a box on the porch." },
  { type: 'line', char: 'A', beat: 'sharp', dialogue: "Here we go. Every time I buy anything it's a trial." },
  { type: 'line', char: 'B', beat: 'hurt', dialogue: "It isn't a trial. I just want to be included." },
  { type: 'line', char: 'A', beat: 'flat', dialogue: "You'd say no. So I didn't ask." },
  { type: 'line', char: 'B', beat: 'pleading', dialogue: "That's the whole problem, Sam. You decided I'd say no." },
  { type: 'line', char: 'A', beat: 'worn out', dialogue: "I'm tired of being the one who's always wrong about money." },
  { type: 'line', char: 'B', beat: 'going quiet', dialogue: "I'm tired too." },
  { type: 'direction', text: "Sam's phone buzzes on the counter. He looks at it and walks out to the porch." }
];
const SAMPLE = {
  name: 'Sam', partnerName: 'Dana', fightName: 'The Drone Fight',
  scene: 'The kitchen, a weeknight. A delivery box sits by the front door.',
  storyThinking: 'Dana thinks I am careless with money and that I only think about my own toys. She thinks I hid the drone on purpose.',
  storyFeeling: 'I think she feels scared about our finances, shut out of decisions, and tired of being the one who worries.'
};
// The new interview answers for the same story, so one tap tests the whole path. Dana is the partner (character B),
// Sam is the person (character A). Dana starts Calm and ends Cold; Sam starts Casual and ends Snappy.
const SAMPLE_INTAKE = {
  fightTopic: 'Buying a drone without talking first',
  fightTrigger: 'A package arriving that nobody talked about',
  whoStartsIt: 'Dana asks what is in the box and how much it was',
  setting: 'The kitchen',
  fightLocation: 'The kitchen',
  startingMoment: "There's a box on the porch with your name on it.",
  heardWhenTheySayThat: "I'm being watched, I'm not trusted",
  speedsUpAt: '"You always"',
  cue: 'heavy sigh',
  cuePlacement: 'Nobody asked you to.',
  interruption: 'Dana leaves the room',
  nonverbalCue: 'heavy sigh',
  pauseMoment: 'Dana leaves the room',
  energy: JSON.stringify({
    me: { energyStart: 'Casual', energyEnd: 'Snappy', sameWholeTime: false, other: '' },
    partner: { energyStart: 'Calm', energyEnd: 'Cold', sameWholeTime: false, other: '' }
  }),
  stopBelief: "If Dana would really listen, I'd stay calmer",
  partnerStopGuess: "If I stopped getting defensive",
  oneThingToSay: 'I just want to be included in the decision.',
  triggerLine: 'Nobody asked you to.',
  privateStory: 'Dana thinks I am careless with money and that I only think about my own toys. She thinks I hid the drone on purpose.'
};

async function findTestUser(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!TEST_EMAIL.test(e)) return { error: 'That is not a test account address. Test tools only work on addresses like mitch+test7@wearecapglobal.com.' };
  if (e === COACH_EMAIL) return { error: 'The admin account is not a test account.' };
  const users = await admin.listAll('users', 20000);
  const u = users.filter(function(x) { return String(x.email || '').toLowerCase() === e; })[0];
  if (!u) return { error: 'No account with that email exists yet. Create it first on the build with "Start on your own", then come back.' };
  if (u.coupleId || (u.accountType && u.accountType !== 'solo')) return { error: 'That account belongs to a couple. Test tools only work on individual accounts.' };
  return { uid: u.id, email: e };
}

exports.handler = async function(event) {
  const CORS = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const who = await verifyFirebaseUser(event);
  if (who === 'unavailable') return reply(CORS, 503, { error: 'Sign-in check unavailable.', code: 'auth_unavailable' });
  if (!who) return reply(CORS, 401, { error: 'Please sign in.', code: 'unauthorized' });
  if ((who.email || '').toLowerCase() !== COACH_EMAIL) return reply(CORS, 403, { error: 'Only the admin account can use test tools.', code: 'forbidden' });
  if (!admin.configured()) return reply(CORS, 503, { error: 'The server key is not set up yet (FIREBASE_SERVICE_ACCOUNT).', code: 'not_configured' });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return reply(CORS, 400, { error: 'Invalid JSON', code: 'bad_request' }); }
  const action = body.action;
  if (['load_sample', 'rerun_analysis', 'view_scene'].indexOf(action) === -1) return reply(CORS, 400, { error: 'Unknown action', code: 'bad_request' });

  try {
    const t = await findTestUser(body.email);
    if (t.error) return reply(CORS, 400, { error: t.error, code: 'bad_target' });
    const now = new Date().toISOString();

    if (action === 'view_scene') {
      // Shows the saved Witness scene beats next to the script lines, with the evidence and reason for each beat.
      const sa = await admin.getDoc('solo-analysis/' + t.uid);
      const sc = await admin.getDoc('scripts/' + t.uid);
      let map = {}; try { map = sa && sa.witness ? JSON.parse(sa.witness) : {}; } catch (e) { map = {}; }
      let raw = []; try { raw = sc && sc.lines ? JSON.parse(sc.lines) : []; } catch (e) { raw = []; }
      const items = [];
      raw.forEach(function(l) {
        if (l.type === 'line' && String(l.dialogue || '').trim()) items.push({ speaker: String(l.char).toUpperCase() === 'B' ? 'partner' : 'you', text: String(l.dialogue).trim(), tone: l.beat || '' });
        else if (l.type === 'direction' && String(l.text || '').trim()) items.push({ speaker: 'direction', text: String(l.text).trim(), tone: '' });
      });
      const scenes = Object.keys(map).map(function(k) {
        return { hash: k, createdAt: map[k].createdAt, input: map[k].input || null, beats: (map[k].beats || []).map(function(b) {
          return { lines: b.lines, texts: b.lines.map(function(i) { return items[i] ? items[i].text : '(missing)'; }), speaker: b.speaker, move: b.move, temp: b.temp, evidence: b.evidence, reason: b.reason, actor: b.actor || '' };
        }) };
      });
      return reply(CORS, 200, { ok: true, email: t.email, action, scenes, lineCount: items.length });
    }

    if (action === 'load_sample') {
      await admin.setFields('users/' + t.uid, {
        name: SAMPLE.name, partnerName: SAMPLE.partnerName, fightName: SAMPLE.fightName,
        accountType: 'solo', soloCurrentStep: '1', readyForReview: 'true', submittedAt: now
      });
      await admin.setFields('scripts/' + t.uid, {
        scene: SAMPLE.scene, lines: JSON.stringify(SAMPLE_LINES), userId: t.uid, updatedAt: now,
        scriptPath: 'b', handoffSeen: true,
        storyThinking: SAMPLE.storyThinking, storyFeeling: SAMPLE.storyFeeling,
        storySent: true, submitted: true, submittedAt: now,
        pathChosen: 'b', fightName: SAMPLE.fightName
      });
      await admin.setFields('scripts/' + t.uid, SAMPLE_INTAKE);
      await admin.setFields('warmup/' + t.uid, { completed: true });
    } else {
      const s = await admin.getDoc('scripts/' + t.uid);
      if (!s || s.submitted !== true) return reply(CORS, 400, { error: 'That account has no submitted script yet. Use "Load sample story" first.', code: 'not_submitted' });
      await admin.setFields('users/' + t.uid, { soloCurrentStep: '1' });
    }
    // Start the analysis and the conversation from nothing, so the next look is a fresh one.
    await admin.setFields('solo-analysis/' + t.uid, { analysis: '', analysisReady: false, witness: '', witnessSeen: false });
    await admin.setFields('step3/' + t.uid, { messages: '[]', savedAt: now, uid: t.uid });
    return reply(CORS, 200, { ok: true, email: t.email, action });
  } catch (err) {
    console.error('Test tools failed:', err.message);
    return reply(CORS, 502, { error: 'Could not write the test data. Try again.', code: 'write_failed' });
  }
};
exports._SAMPLE_LINES = SAMPLE_LINES;
