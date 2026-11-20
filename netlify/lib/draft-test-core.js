'use strict';

// TEMPORARY, ADMIN ONLY. A test of which model and which prompt writes the best draft script.
// Nothing here is used by the live site. To delete the test afterwards, see DELETE ME at the bottom of the report:
// remove netlify/functions/draft-test.js, netlify/functions/draft-test-background.js, this file, the two entries in
// netlify.toml, and the "Draft model test" block in beta147/admin.html.

const fs = require('fs');
const path = require('path');

// ---------- the five setups ----------
const MODELS = { s46: 'claude-sonnet-4-6', s55: 'claude-sonnet-5-5', o55: 'claude-opus-5-5' };
const SETUPS = [
  { id: 'S46_FULL', model: MODELS.s46, prompt: 'full', name: 'claude-sonnet-4-6 with the full master prompt (what the live site does today)' },
  { id: 'S55_FULL', model: MODELS.s55, prompt: 'full', name: 'claude-sonnet-5-5 with the full master prompt' },
  { id: 'O55_FULL', model: MODELS.o55, prompt: 'full', name: 'claude-opus-5-5 with the full master prompt' },
  { id: 'S55_SHORT', model: MODELS.s55, prompt: 'short', name: 'claude-sonnet-5-5 with the short draft only prompt' },
  { id: 'O55_SHORT', model: MODELS.o55, prompt: 'short', name: 'claude-opus-5-5 with the short draft only prompt' }
];
const MAX_TOKENS = 8000;   // the same as the live draft step. No temperature is sent, as on the live site.

// Dollars per million tokens. Only claude-sonnet-4-6 is the site's own number (netlify/lib/ai-costs.js). The other two are
// ASSUMED, not checked against Anthropic's price list: change them here if they are wrong.
const RATES = {
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75, assumed: false },
  'claude-sonnet-5-5': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75, assumed: true },
  'claude-opus-5-5': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25, assumed: true }
};
function costOf(model, u) {
  const r = RATES[model] || RATES['claude-sonnet-4-6']; u = u || {};
  const usd = ((u.input_tokens || 0) * r.input + (u.output_tokens || 0) * r.output + (u.cache_read_input_tokens || 0) * r.cacheRead + (u.cache_creation_input_tokens || 0) * r.cacheWrite) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

// ---------- the master prompt, loaded the way the live function loads it ----------
let MASTER = '';
(function load() {
  const roots = [__dirname, path.join(__dirname, '..', 'functions'), process.env.LAMBDA_TASK_ROOT, process.cwd()].filter(Boolean);
  const names = ['ai-prompt.txt', path.join('netlify', 'functions', 'ai-prompt.txt')];
  for (const root of roots) for (const name of names) {
    try { const t = fs.readFileSync(path.join(root, name), 'utf8'); if (t.length > 1000) { MASTER = t; return; } } catch (e) { /* next */ }
  }
})();
function masterPrompt() { return MASTER; }

// ---------- the short, draft only prompt (no master prompt) ----------
const SHORT_PROMPT = [
"You write first draft argument scripts for The Ongoing Argument, a tool that helps one person see their own recurring argument on the page. You are an AI. In this step your only job is to turn one person's account and answers into a screenplay.",
"",
"FORMAT. Output only the script, starting with SCENE: and a brief location. Then, for each spoken line: the character name in capitals, a tone note in parentheses on its own line, then what they say. For a stage direction: DIRECTION: and a short description. No title, no preamble, no commentary, no explanation.",
"",
"FAITHFUL, NOT FLATTERING. You format and you do not fix. Keep each person's words as close to what was actually said as possible. Never make either person more reasonable, more articulate or more emotionally aware than they were. Do not soften, polish or rebalance. If something harsh was said, it stays harsh.",
"",
"NEVER INVENT. Do not add a line, event, look, gesture or feeling the person did not describe. Where the account shows a line, use the person's own words for it. The lines each person says every time are theirs: use them where the account shows them, never as a stock to trade back and forth.",
"",
"TONE NOTES. Give every line a short tone note of one to three plain words, for both people. Each person's tone follows their own energy: begin at the energy they gave for the start of the argument and move step by step to the energy they gave for the end. Never give one character the same note on more than two lines in a row. When unsure, use a neutral note such as (evenly) or (plainly).",
"",
"THE RISE. A real argument builds. Let the script rise as far as the person's own account and answers show, and no further. Put a short stage direction at the moment they named as the one that sends it into overdrive, in their own words. Place the look or silence that gets to them right after the line they said it follows.",
"",
"THE ENDING. These arguments do not end, they get interrupted. End on an interruption the person described, such as someone leaving the room or going quiet. Never end on peace, agreement or resolution.",
"",
"WORDS. Plain words. Never use em dashes or en dashes. Say \"argument\", never \"fight\", in anything you write. A person's own words stay exactly as they said them.",
"",
"SAFETY. Look for the shape of fear rather than the shape of anger. Anger sounds loud, mutual, escalating in both directions. Fear sounds different. One person's language orients entirely around managing the other's reaction, what will happen if I say this, what mood will this trigger, what I have learned not to bring up. Look for control described as concern. Isolation described as closeness. Consequences described as consistency. Look for one person's account containing no version where they are safe to disagree. One heated fight, even a cruel one, is not this. When you recognize this pattern, include the flag [[COACH_FLAG: Safety Pattern]] anywhere in your response. This is a silent signal to the platform. It will not be shown to the person you are speaking with."
].join('\n');

// ---------- the draft instruction, exactly as the live page builds it (copied from pbBuildPrompt, then checked against the page) ----------
function pbVoiced(sp) {
  return !/\b(she|her|hers|herself|he|him|his|himself|they|them|their)\b/i.test(String(sp.text || ''));
}
function buildDraftInstruction(ctx) {
  var nameA = ctx.nameA ? ctx.nameA : 'Person A';
  var nameB = ctx.nameB ? String(ctx.nameB).trim() : 'Person B';
  var A = function(k) { return ctx.answers[k] || ''; };
  var told = ctx.story ? ctx.story : '';
  var pbSpoken = ctx.spoken || [], pbPronoun = ctx.pronoun || '';
  var reportedAny = false;
  var spoken = pbSpoken.length
    ? pbSpoken.map(function(l, i) {
        var rep = !pbVoiced(l);
        if (rep) reportedAny = true;
        return (i + 1) + '. ' + (l.who === 'me' ? nameA : nameB).toUpperCase() + (rep ? ' [REPORTED]' : '') + ': ' + l.text;
      }).join('\n')
    : '';
  var reportedNote = reportedAny
    ? 'Lines marked [REPORTED] are only reported in the story, in the voice of the person telling it, not spoken in that person\'s own words. In a report, "I" and "me" mean ' + nameA + ' (the person telling the story) and "she", "he" or "her" mean ' + nameB + '. Write each one as the named speaker saying it in their own first person to the other person. Example: "' + nameB + ' says I hide things and then she is the bad guy" becomes ' + nameB.toUpperCase() + ' saying "You hide things and then I\'m the bad guy."\n\n'
    : '';
  var energyBlock = A('q6')
    ? 'ENERGY ARC. This is what can be heard, in their words, as if listening from the next room. It is not a feeling. For each person it gives the energy at the start and at the end. Let each person\'s tone notes move along their arc across the lines, from the start energy to the end energy, in steps that follow the lines.\n' + A('q6') + '\n\n'
    : '';
  var cueBlock = A('q9')
    ? 'A NONVERBAL CUE that gets to ' + nameA + ' more than the words: ' + nameB + ' ' + A('q9') + '. ' + (A('cueAfter') ? 'It usually happens after the line: "' + A('cueAfter') + '". Put it in the script as a DIRECTION right after that line, or after the closest matching line. ' : 'They are not sure where it falls, so place it once, where it fits best. ') + 'Use exactly this cue. Do not add any other looks or gestures.\n\n'
    : '';
  var notesBlock = (A('notes') && A('notes').length)
    ? 'ADDED ALONG THE WAY, in their words. Each was written while answering the question named in brackets. Put every one of them into the script in the right place, using what they said. Never drop one because it came from a different question.\n' + A('notes').join('\n') + '\n\n'
    : '';
  var fightLabel = ctx.fightLabel || '';

  return 'Write a first-draft script of an argument between two partners, built only from this person\'s own account. The argument ' + (fightLabel ? 'is called "' + fightLabel + '"' : 'has no name yet') + '. ' + nameA + ' is Character A, the person telling the story; ' + nameB + ' is Character B. Refer to ' + nameB + ' by name' + (pbPronoun ? ' (' + pbPronoun + ')' : '') + '.\n\n' +
    'YOU FORMAT. YOU DO NOT FIX. Keep each person\'s words as close to what was actually said as possible. You may remove filler ("um," "like," repeated starts) and split long speech into separate lines, but never change meaning, tone, or intensity. Never add lines or reactions the person did not describe. Never soften, polish, or rebalance what was said. If something harsh was said, the script keeps it harsh. Seeing the real fight on the page is where the work begins, and a softened script removes that.\n\n' +
    'FAITHFUL, NOT FLATTERING. Do not make either person more reasonable, more emotionally aware or more articulate than they actually were. If someone was sarcastic, defensive, dismissive, controlling or unreasonable, that stays in the script. Keep each person\'s remembered words exactly as given instead of turning them into polished language. Do not invent a feeling, a look, a gesture or a line the person did not describe; when you are unsure, stay neutral. Do not give the script a title.\n\n' +
    'THE OPENING. The script begins where their account begins. Put the first beats of their story on the page in the order they told them, with the specific details they named (what the thing was, an amount, a place), before any later line. The topic and what set it off must be clear in the first few lines. Never open in the middle of the fight.\n\n' +
    (told ? 'THEIR OWN ACCOUNT, in their words:\n"""\n' + told + '\n"""\n\n' : '') +
    (spoken ? 'EVERY SPOKEN LINE FOUND IN THEIR ACCOUNT, in the order it was said. Every one of these must appear in the script, in this order, as its own line or as part of a line. The first one may belong to ' + nameB + ': start the script with whoever speaks first.\n' + spoken + '\n\n' + reportedNote : '') +
    'WHAT THEY CONFIRMED OR ADDED (use these for the scene, directions and beats; never as a source of new dialogue):\n\n' +
    'What the fight is about: ' + A('q1') + '\n\n' +
    (A('q2') ? 'What usually sets it off: ' + A('q2') + '\n\n' : '') +
    (A('q4b') ? 'Who usually starts it: ' + A('q4b') + '\n\n' : '') +
    'Physical setting: ' + A('q3') + '\n\n' +
    'The first line or moment that starts it: ' + A('q4') + '\n\n' +
    'Lines they hear every time:\n' + A('q7b') + '\n\n' +
    (A('heard') ? 'What ' + nameA + ' hears when ' + nameB + ' says that, in their words. Use it only for the tone and subtext of the lines, never as a new line: ' + A('heard') + '\n\n' : '') +
    (A('q7') ? 'A word or tone where it speeds up: ' + A('q7') + '\n\n' : '') +
    energyBlock + cueBlock +
    'What usually interrupts it: ' + A('q8') + '\n\n' +
    notesBlock +
    'Format the script exactly as follows. Start with:\nSCENE: [brief location from the setting described above]\n\n' +
    'For each line of dialogue:\n[CHARACTER NAME IN CAPS]\n([emotional beat or tone in parentheses])\n[What they say]\n\n' +
    'For stage directions:\nDIRECTION: [brief description]\n\n' +
    'Include every exchange the person described and no others. Let the script rise as far as the person\'s own account and answers show, and no further. A DIRECTION is only for a physical action, a change of setting, or the overdrive moment described in THE RISE. Place each repeated line where the account shows it. Do not take turns between the two people\'s lists. If a repeated line has no place in the account, you may use it at the moment the person says it speeds up, or leave it out. A line that appears in their account is the same line: never put the same line in the script twice. ' +
    'TONE NOTES. Give every line a short tone note in parentheses, one to three words, chosen from that specific line and from the energy arc the person gave for each of them. Use the real range of an argument, for example casual, calm, measured, guarded, defensive, sarcastic, dismissive, hurt, pleading, frustrated, flat, worn out, going quiet. Follow the shape of a real fight: the first line is usually measured, the feeling rises, then it falls or goes quiet. Never give one character the same tone note on more than two lines in a row. Do not invent a feeling the person did not signal; when you are unsure, use a neutral note such as (evenly) or (plainly). ' +
    'THE RISE. Shape the rise from the person\'s own answers. They told you each person\'s energy at the start and at the end, the word or moment that sends the argument into overdrive (in their own words), the line after which it usually happens, and the look or silence that gets to them. Make each person\'s tone notes move from their start energy to their end energy across the script. Put a short stage direction at the overdrive moment, using the person\'s own words. Place the cue where they said it happens. Do not add any line or event they did not describe. ' +
    'THE ENDING. These fights do not end, they get interrupted. If the script needs a closing DIRECTION, make it an interruption, for example someone leaves the room, someone goes quiet, a phone rings. Never end on peace, agreement, resolution or a settled moment such as silence settling over the day. If the person described how it ends, use that, in their words. ' +
    'Use the actual names ' + nameA + ' (Character A) and ' + nameB + ' (Character B) in all caps as character headers. ' +
    'Output only the script itself, starting with SCENE:. No preamble, no commentary, no explanation.';
}

// ---------- turning saved interview answers into the answers the draft reads (copied from ivToLegacy) ----------
const IV_NONE = ['not sure', 'nothing in particular'];
function ivReal(v, mode) {
  const parts = String(v || '').split(mode === 'line' ? /\n/ : /\n|,\s*(?=[A-Za-z"'])/).map(function(x) { return x.trim(); }).filter(Boolean);
  return parts.filter(function(x) { return IV_NONE.indexOf(x.toLowerCase()) === -1; }).join(mode === 'line' ? '\n' : ', ');
}
function ivEnergyText(iv, w, nameB) {
  const e = (iv.energy || {})[w] || {}, who = w === 'me' ? 'You' : nameB;
  const bits = e.same ? 'the energy stays the same the whole time' : (e.start && e.end ? 'starts ' + e.start.toLowerCase() + ', ends ' + e.end.toLowerCase() : (e.start ? 'starts ' + e.start.toLowerCase() : (e.end ? 'ends ' + e.end.toLowerCase() : '')));
  const other = String(e.other || '').trim();
  return (bits || other) ? who + ': ' + [bits, other ? 'also "' + other + '"' : ''].filter(Boolean).join(', ') : '';
}
const IV_HEAVY = ['loud', 'cold', 'sarcastic', 'beaten down', 'worn out'];
function ivHeavy(iv) {
  let hit = false; const en = iv.energy || {};
  ['me', 'partner'].forEach(function(w) { const e = en[w] || {}; [e.start, e.end, e.other].forEach(function(x) { if (x && IV_HEAVY.indexOf(String(x).toLowerCase().trim()) !== -1) hit = true; }); });
  return hit;
}
function ivHeading(iv, key, N) {
  switch (key) {
    case 'here': return "Here's what I heard";
    case 'about': return 'What is this argument usually about?';
    case 'trigger': return 'What usually sets it off?';
    case 'starter': return 'Who usually starts it?';
    case 'setting': return 'Where does it usually happen?';
    case 'sayme': return 'The lines you say every time';
    case 'saythem': return 'The lines ' + N + ' says every time';
    case 'heard': return 'What do you hear when ' + N + ' says those things?';
    case 'energyp': case 'energym': return "What's the energy?";
    case 'speedup': return 'Is there a moment where it turns for you, or a word or phrase that gets under your skin and takes this to another level?';
    case 'cue': return 'Is there a look, gesture or silence that gets to you more than the words do?';
    case 'cueplace': return 'After which line does that usually happen?';
    case 'interrupt': return ivHeavy(iv) ? 'How does the argument usually get interrupted?' : "What's the 'to be continued' moment?";
    case 'review': return "Here's everything I heard";
  }
  return '';
}
function ivNoteLabel(iv, key, N) { return (key === 'energyp' || key === 'energym' || key === 'energy') ? 'the energy' : ivHeading(iv, key, N).replace(/\?$/, '').toLowerCase(); }
function toAnswers(iv, spoken, nameA, nameB) {
  const rep = [];
  const themLines = ivReal(iv.sayThem, 'line'), meLines = ivReal(iv.sayMe, 'line');
  if (themLines) rep.push(nameB + ' says: ' + themLines.replace(/\n/g, ' / '));
  if (meLines) rep.push(nameA + ' says: ' + meLines.replace(/\n/g, ' / '));
  const notes = [];
  Object.keys(iv.notes || {}).forEach(function(k) { if (iv.notes[k] && String(iv.notes[k]).trim()) notes.push('[' + ivNoteLabel(iv, k, nameB) + '] ' + String(iv.notes[k]).replace(/\n/g, ' / ')); });
  if (iv.extra) notes.push('[at the end] ' + String(iv.extra).replace(/\n/g, ' / '));
  const energy = [ivEnergyText(iv, 'partner', nameB), ivEnergyText(iv, 'me', nameB)].filter(Boolean).join('\n');
  const cue = ivReal(iv.cue), after = ivReal(iv.cueAfter);
  const here = iv.here || {};
  return {
    q1: ivReal(iv.about) || here.topic || '', q2: ivReal(iv.trigger), q3: ivReal(iv.setting) || here.where || '', q4: here.first || '', q4b: ivReal(iv.starter),
    sayMe: meLines, sayThem: themLines, q6: energy, q7: ivReal(iv.speedup), q7b: rep.join('\n'), q8: ivReal(iv.interrupt), q9: cue, q9b: '',
    cueAfter: cue ? after : '', heard: ivReal(iv.heard), notes: notes
  };
}

// ---------- the two written stories ----------
const STORY_M = "Okay so you won't believe the night I had. I got home around six, tired, and walked into the kitchen and the sink was full again. Dishes from breakfast, dishes from lunch, the pan from last night. Casey was on the couch with the laptop. I said, \"Are you kidding me with this sink?\" and Casey said, \"I was going to do it later.\" Later. It's always later. I said, \"You said that Sunday.\" And Casey said, \"Can you not start the second you walk in the door?\" which, fine, but I had been on my feet all day. So I started loading the dishwasher, kind of loud, and Casey looked up and said, \"You don't have to make a show of it.\" I said, \"Somebody has to do it.\" That's when Casey closed the laptop pretty hard and said, \"Here we go. You always make me the bad guy.\" And I said, \"I'm not making you anything. I'm asking for one thing.\" And Casey just stood there and let out that long sigh, the one that gets me every time, and then walked to the bedroom and shut the door. I stood in the kitchen with a wet pan in my hand and I felt so stupid and so mad at the same time. It's not even the dishes. It's that I feel like I'm the only one who sees the mess. We did the same thing last month with the laundry. I just wanted Casey to say, you're right, I'll handle it.";
const STORY_T = "Dev's mother is coming for two weeks and he said yes without asking me. I found out when she called to tell me which flight. I said, \"You didn't ask me.\" He said, \"She's my mother.\" I said, \"That's not the point.\" He said I was being dramatic. Then he went to the garage. This happens every time his family wants something. I just want to be part of the decision.";

const STORIES = {
  R: { id: 'R', title: 'Story R (rich): the drone story from the real test account' },
  M: {
    id: 'M', title: 'Story M (medium): chores', nameA: 'Jordan', nameB: 'Casey', pronoun: '', fightLabel: 'The Chores Argument', story: STORY_M,
    spoken: [
      { who: 'me', text: 'Are you kidding me with this sink?' }, { who: 'partner', text: 'I was going to do it later.' }, { who: 'me', text: 'You said that Sunday.' },
      { who: 'partner', text: 'Can you not start the second you walk in the door?' }, { who: 'partner', text: "You don't have to make a show of it." }, { who: 'me', text: 'Somebody has to do it.' },
      { who: 'partner', text: 'Here we go. You always make me the bad guy.' }, { who: 'me', text: "I'm not making you anything. I'm asking for one thing." }
    ],
    iv: {
      theme: { pick: 'chores', text: '' }, here: { where: 'The kitchen', topic: 'Dishes left in the sink', first: 'Are you kidding me with this sink?' },
      trigger: 'A task left undone', starter: 'I start it', setting: '',
      sayMe: "You said that Sunday.\nSomebody has to do it.\nI'm asking for one thing.",
      sayThem: "I was going to do it later.\nCan you not start the second you walk in the door?\nHere we go. You always make me the bad guy.",
      heard: "I'm being blamed",
      energy: { me: { start: 'Tired', end: 'Snappy', same: false, other: '' }, partner: { start: 'Casual', end: 'Cold', same: false, other: '' } },
      speedup: '"You always"', cue: 'heavy sigh', cueAfter: "I'm asking for one thing.", interrupt: 'Casey leaves the room', notes: {}, extra: ''
    }
  },
  T: {
    id: 'T', title: 'Story T (thin): in laws', nameA: 'Priya', nameB: 'Dev', pronoun: 'he', fightLabel: 'The In-Laws Argument', story: STORY_T,
    spoken: [
      { who: 'me', text: "You didn't ask me." }, { who: 'partner', text: "She's my mother." }, { who: 'me', text: "That's not the point." }, { who: 'partner', text: "You're being dramatic." }
    ],
    iv: {
      theme: { pick: 'inlaws', text: '' }, here: { where: '', topic: 'His mother staying for two weeks', first: "You didn't ask me." },
      trigger: 'A visit coming up', starter: 'Dev starts it', setting: '',
      sayMe: "You didn't ask me.\nThat's not the point.", sayThem: "She's my mother.\nYou're being dramatic.", heard: "I'm not being heard",
      energy: { me: { start: 'Calm', end: 'Firm', same: false, other: '' }, partner: { start: 'Casual', end: 'Cold', same: false, other: '' } },
      speedup: 'When he says "She\'s my mother"', cue: 'goes quiet', cueAfter: "You're being dramatic.", interrupt: 'Dev goes to the garage', notes: {}, extra: ''
    }
  }
};

// Story R: read from the real test account, never written to. Tries wendy3 first (if it has a finished story), then wendy1.
async function loadStoryR(admin) {
  const users = await admin.listAll('users', 20000);
  const emails = ['mitch+wendy3@mitchnewman.com', 'mitch+wendy1@mitchnewman.com'];
  const notes = [];
  for (const email of emails) {
    const u = users.filter(function(x) { return String(x.email || '').toLowerCase() === email; })[0];
    if (!u) { notes.push(email + ': no such account'); continue; }
    const priv = await admin.getDoc('private/' + encodeURIComponent(u.id));
    const sc = await admin.getDoc('scripts/' + encodeURIComponent(u.id));
    let prog = null;
    try { prog = priv && priv.intake ? (typeof priv.intake === 'string' ? JSON.parse(priv.intake) : priv.intake) : null; } catch (e) { prog = null; }
    const story = (priv && priv.initialRetelling) || (prog && prog.story) || '';
    const finished = !!(story && sc && (sc.submitted === true || sc.submitted === 'true' || (prog && prog.state === 'done')));
    if (!story) { notes.push(email + ': no saved story'); continue; }
    if (email.indexOf('wendy3') !== -1 && !finished) { notes.push(email + ': found, but its story is not finished, so wendy1 is used'); continue; }
    const nameA = u.name || 'Person A', nameB = String(u.partnerName || (prog && prog.iv && '') || '').trim() || 'Person B';
    const fightLabel = (u.fightName && u.fightName !== 'The Ongoing Argument') ? String(u.fightName).trim() : '';
    let ctx;
    if (prog && prog.iv && prog.iv.v === 2) {
      ctx = { nameA, nameB, story, spoken: prog.spoken || [], pronoun: prog.pronoun || '', fightLabel, answers: toAnswers(prog.iv, prog.spoken || [], nameA, nameB), iv: prog.iv, source: email + ' (saved interview and story)' };
    } else if (sc) {
      // Older save: rebuild from the fields written at draft time. The spoken line list was not kept in that case.
      let energy = null; try { energy = typeof sc.energy === 'string' ? JSON.parse(sc.energy) : sc.energy; } catch (e) { energy = null; }
      const iv = { energy: energy ? { me: { start: energy.me && energy.me.energyStart, end: energy.me && energy.me.energyEnd, same: !!(energy.me && energy.me.sameWholeTime), other: energy.me && energy.me.other }, partner: { start: energy.partner && energy.partner.energyStart, end: energy.partner && energy.partner.energyEnd, same: !!(energy.partner && energy.partner.sameWholeTime), other: energy.partner && energy.partner.other } } : {},
        here: { topic: sc.fightTopic || '', where: sc.setting || '', first: sc.startingMoment || '' }, trigger: sc.fightTrigger || '', starter: sc.whoStartsIt || '', setting: sc.setting || '', sayMe: sc.sayEveryTime || '', sayThem: sc.theySayEveryTime || '', heard: sc.heardWhenTheySayThat || '', speedup: sc.speedsUpAt || '', cue: sc.cue || '', cueAfter: sc.cuePlacement || '', interrupt: sc.interruption || '', notes: {}, extra: '' };
      ctx = { nameA, nameB, story, spoken: [], pronoun: '', fightLabel, answers: toAnswers(iv, [], nameA, nameB), iv, source: email + ' (rebuilt from the saved script record; the spoken line list was not saved)' };
    } else { notes.push(email + ': story found but no interview answers'); continue; }
    ctx.title = STORIES.R.title; ctx.id = 'R'; ctx.skipped = notes;
    return ctx;
  }
  return { id: 'R', error: 'Story R could not be loaded. ' + notes.join('; ') };
}

function storyCtx(id) {
  const s = STORIES[id];
  return { id, title: s.title, nameA: s.nameA, nameB: s.nameB, story: s.story, spoken: s.spoken, pronoun: s.pronoun, fightLabel: s.fightLabel, iv: s.iv, answers: toAnswers(s.iv, s.spoken, s.nameA, s.nameB), source: 'written for this test' };
}

// ---------- the plain, factual checks under each draft ----------
function norm(t) { return String(t || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
const STOP = ['that', 'this', 'with', 'from', 'they', 'them', 'then', 'than', 'what', 'when', 'where', 'there', 'their', 'have', 'been', 'were', 'will', 'would', 'about', 'into', 'just', 'your', 'you', 'the', 'and', 'for', 'but', 'not', 'are', 'was', 'his', 'her', 'she', 'him', 'out', 'over', 'back', 'down', 'again'];
function words(t) { return norm(t).split(' ').filter(function(w) { return w.length >= 4 && STOP.indexOf(w) === -1; }); }

function parseDraft(text, nameA, nameB) {
  const A = String(nameA || '').toUpperCase(), B = String(nameB || '').toUpperCase();
  const raw = String(text || '').split('\n'), out = { scene: '', items: [] };
  let i = 0;
  for (; i < raw.length; i++) { const l = raw[i].trim(); if (/^SCENE:/i.test(l)) { out.scene = l.replace(/^SCENE:\s*/i, ''); i++; break; } }
  while (i < raw.length) {
    const line = raw[i].trim();
    if (!line) { i++; continue; }
    if (/^DIRECTION:/i.test(line)) { out.items.push({ type: 'direction', text: line.replace(/^DIRECTION:\s*/i, '').trim() }); i++; continue; }
    const up = line.toUpperCase().replace(/:$/, '');
    if (up === A || up === B) {
      i++; let beat = '';
      if (i < raw.length && /^\(.*\)$/.test(raw[i].trim())) { beat = raw[i].trim().slice(1, -1); i++; }
      const d = [];
      while (i < raw.length && raw[i].trim() && !/^DIRECTION:/i.test(raw[i].trim()) && raw[i].trim().toUpperCase().replace(/:$/, '') !== A && raw[i].trim().toUpperCase().replace(/:$/, '') !== B) { d.push(raw[i].trim()); i++; }
      out.items.push({ type: 'line', who: up === A ? 'A' : 'B', name: up === A ? nameA : nameB, beat: beat, text: d.join(' ') });
      continue;
    }
    i++;
  }
  return out;
}
function stem(w) { return String(w || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 4); }

function analyze(draftText, ctx) {
  const p = parseDraft(draftText, ctx.nameA, ctx.nameB);
  const lines = p.items.filter(function(x) { return x.type === 'line'; }), dirs = p.items.filter(function(x) { return x.type === 'direction'; });
  const iv = ctx.iv || {};
  // 1. the person's own lines, word for word (case and punctuation ignored)
  function listed(who) {
    const set = [], push = function(t) { const n = norm(t); if (n && set.map(function(s) { return s.n; }).indexOf(n) === -1) set.push({ n: n, t: String(t).trim() }); };
    (ctx.spoken || []).filter(function(l) { return l.who === who; }).forEach(function(l) { push(l.text); });
    String(iv[who === 'me' ? 'sayMe' : 'sayThem'] || '').split('\n').forEach(function(t) { if (t.trim() && IV_NONE.indexOf(t.trim().toLowerCase()) === -1) push(t); });
    return set;
  }
  function own(who) {
    const L = listed(who), spk = who === 'me' ? 'A' : 'B', texts = lines.filter(function(l) { return l.who === spk; }).map(function(l) { return norm(l.text); });
    const hit = L.filter(function(s) { return texts.some(function(t) { return t.indexOf(s.n) !== -1; }); });
    return { name: who === 'me' ? ctx.nameA : ctx.nameB, found: hit.length, of: L.length, missing: L.filter(function(s) { return hit.indexOf(s) === -1; }).map(function(s) { return s.t; }) };
  }
  const ownA = own('me'), ownB = own('partner');
  // 2. does each person's tone move from the start energy to the end energy
  function tone(who) {
    const e = (iv.energy || {})[who] || {}, spk = who === 'me' ? 'A' : 'B', name = who === 'me' ? ctx.nameA : ctx.nameB;
    const notes = lines.filter(function(l) { return l.who === spk; }).map(function(l) { return String(l.beat || '').toLowerCase(); });
    if (!notes.length) return { name: name, ok: false, why: 'no lines for this person' };
    const first = notes.slice(0, 2).join(' '), last = notes.slice(-2).join(' ');
    if (e.same) { const distinct = Object.keys(notes.reduce(function(o, n) { o[n] = 1; return o; }, {})).length; return { name: name, ok: distinct <= 2, why: 'wanted the same energy the whole time; ' + distinct + ' different tone note' + (distinct === 1 ? '' : 's') + ' used' }; }
    if (!e.start && !e.end) return { name: name, ok: null, why: 'no energy words were given' };
    const okStart = !e.start || first.indexOf(stem(e.start)) !== -1, okEnd = !e.end || last.indexOf(stem(e.end)) !== -1;
    return { name: name, ok: okStart && okEnd, why: 'starts "' + (notes[0] || '') + '" (wanted ' + (e.start || 'none') + (okStart ? ', matches' : ', no match') + '); ends "' + (notes[notes.length - 1] || '') + '" (wanted ' + (e.end || 'none') + (okEnd ? ', matches' : ', no match') + ')' };
  }
  const toneA = tone('me'), toneB = tone('partner');
  // 3. the overdrive word or moment
  const od = String(iv.speedup || '').replace(/^"|"$/g, '').replace(/["“”]/g, '');
  let overdrive = { given: od, where: 'none given' };
  if (od && IV_NONE.indexOf(od.toLowerCase()) === -1) {
    const nod = norm(od), ow = words(od); let found = null;
    p.items.forEach(function(x, k) {
      if (found) return; const t = norm(x.text + ' ' + (x.beat || ''));
      if (t.indexOf(nod) !== -1 || (ow.length && ow.filter(function(w) { return t.indexOf(w) !== -1; }).length / ow.length >= 0.6)) found = { index: k, x: x };
    });
    const dirHit = dirs.filter(function(d) { const t = norm(d.text); return t.indexOf(nod) !== -1 || (ow.length && ow.filter(function(w) { return t.indexOf(w) !== -1; }).length / ow.length >= 0.6); })[0];
    overdrive = { given: od, where: found ? (found.x.type === 'direction' ? 'in a stage direction' : 'in ' + found.x.name + "'s line") + ' at item ' + (found.index + 1) + ' of ' + p.items.length : 'not found in the script', stageDirection: dirHit ? dirHit.text : '' };
  }
  // 4. lines and events not in the story or the answers (word match; a flag is a thing to look at, not a verdict)
  const sourceText = norm([ctx.story, ctx.answers.q1, ctx.answers.q2, ctx.answers.q3, ctx.answers.q4, ctx.answers.q4b, ctx.answers.q6, ctx.answers.q7, ctx.answers.q7b, ctx.answers.q8, ctx.answers.q9, ctx.answers.cueAfter, ctx.answers.heard, (ctx.answers.notes || []).join(' ')].join(' '));
  const invented = [];
  p.items.forEach(function(x, k) {
    if (x.type === 'line') {
      const n = norm(x.text); if (!n) return;
      if (sourceText.indexOf(n) !== -1) return;
      const w = words(x.text); const frac = w.length ? w.filter(function(t) { return sourceText.indexOf(t) !== -1; }).length / w.length : 1;
      if (frac < 0.8) invented.push('line ' + (k + 1) + ' (' + x.name + '): "' + x.text + '"');
    } else {
      const w = words(x.text); const frac = w.length ? w.filter(function(t) { return sourceText.indexOf(t) !== -1; }).length / w.length : 1;
      if (frac < 0.5) invented.push('stage direction ' + (k + 1) + ': "' + x.text + '"');
    }
  });
  return { lines: lines.length, directions: dirs.length, items: p.items.length, ownA: ownA, ownB: ownB, toneA: toneA, toneB: toneB, overdrive: overdrive, notInStory: invented, scene: p.scene };
}

// ---------- the call to the model (the same shape as the live function) ----------
async function callModel(setup, instruction, apiKey) {
  const system = setup.prompt === 'full' ? [{ type: 'text', text: MASTER, cache_control: { type: 'ephemeral' } }] : [{ type: 'text', text: SHORT_PROMPT }];
  const body = JSON.stringify({ model: setup.model, max_tokens: MAX_TOKENS, system: system, messages: [{ role: 'user', content: instruction }] });
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const t0 = Date.now();
    let r;
    try { r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: body }); }
    catch (e) { last = { error: 'could not reach the AI service: ' + e.message }; await new Promise(function(res) { setTimeout(res, 2000 * (attempt + 1)); }); continue; }
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    if (r.ok) {
      const d = await r.json();
      // A newer model may send several blocks (for example a thinking block first, then the text). The draft is ALL the text blocks,
      // not just the first block. The raw blocks are kept so nothing is ever hidden.
      const blocks = Array.isArray(d.content) ? d.content : [];
      const text = blocks.filter(function(b) { return b && b.type === 'text' && typeof b.text === 'string'; }).map(function(b) { return b.text; }).join('');
      const raw = JSON.stringify(blocks.map(function(b) { const o = { type: b && b.type }; Object.keys(b || {}).forEach(function(k) { if (typeof b[k] === 'string' && k !== 'signature' && k !== 'type') o[k] = b[k].slice(0, 60000); }); return o; })).slice(0, 300000);
      return { text: text, raw: raw, stopReason: d.stop_reason || '', usage: d.usage || {}, seconds: seconds };
    }
    const errText = await r.text().catch(function() { return ''; });
    last = { error: 'the AI service said ' + r.status + ': ' + errText.slice(0, 300), status: r.status };
    if (r.status === 429 || r.status >= 500) { await new Promise(function(res) { setTimeout(res, 4000 * (attempt + 1)); }); continue; }
    break;
  }
  return last || { error: 'unknown failure' };
}

// ---------- the 30 cases, blind letters ----------
function seededShuffle(arr, seed) {
  let s = 0; for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  const rnd = function() { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a;
}
function makePlan(runId) {
  const letters = ['A', 'B', 'C', 'D', 'E'], order = seededShuffle(SETUPS.map(function(s) { return s.id; }), runId);
  const key = {}; order.forEach(function(sid, i) { key[letters[i]] = sid; });
  const cases = []; let n = 0;
  ['R', 'M', 'T'].forEach(function(story) { letters.forEach(function(L) { [1, 2].forEach(function(run) { n++; cases.push({ caseId: 'c' + (n < 10 ? '0' + n : n), story: story, letter: L, setupId: key[L], run: run }); }); }); });
  return { key: key, cases: cases };
}

module.exports = { SETUPS, MODELS, RATES, MAX_TOKENS, SHORT_PROMPT, masterPrompt, buildDraftInstruction, toAnswers, STORIES, STORY_M, STORY_T, storyCtx, loadStoryR, analyze, parseDraft, costOf, callModel, makePlan, seededShuffle };
