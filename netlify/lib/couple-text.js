'use strict';

// The couple analysis is built on the server so a browser never has to read the other partner's private script.
// These are the same text builders the page used, moved here word for word so the analysis reads the same.

function cueClean(raw) {
  const seen = {}, out = [];
  String(raw || '').replace(/[()]/g, ' ').split(',').forEach(function(x) {
    x = x.replace(/\balready\b\s*/gi, '').replace(/\s+/g, ' ').trim();
    if (x && !seen[x.toLowerCase()]) { seen[x.toLowerCase()] = 1; out.push(x); }
  });
  return out.join(', ');
}

// The script as text. A tone the AI guessed in an edit is never evidence about the person.
function scriptDataToText(data, personName, partnerName) {
  const parts = [];
  if (data.scene) parts.push('SCENE: ' + data.scene);
  if (data.lines) {
    let lines = data.lines;
    if (typeof lines === 'string') { try { lines = JSON.parse(lines); } catch (e) { lines = []; } }
    (Array.isArray(lines) ? lines : []).forEach(function(l) {
      if (l.type === 'line') {
        const speaker = String(l.char || '').toUpperCase() === 'A' ? personName : partnerName;
        let block = speaker.toUpperCase();
        if (l.beat && !l.aiTone) block += '\n(' + cueClean(l.beat) + ')';
        if (l.dialogue) block += '\n' + l.dialogue;
        parts.push(block);
      } else if (l.type === 'direction' && l.text) {
        parts.push('[' + l.text + ']');
      }
    });
  }
  return parts.length ? parts.join('\n\n') : '(no script content)';
}

function energyLines(en, myName, partnerName) {
  if (!en || typeof en !== 'object') return '';
  function one(e, who) {
    if (!e) return '';
    const bits = e.sameWholeTime ? 'stays the same the whole time' : [e.energyStart ? 'starts ' + String(e.energyStart).toLowerCase() : '', e.energyEnd ? 'ends ' + String(e.energyEnd).toLowerCase() : ''].filter(Boolean).join(', ');
    const other = e.other ? 'also "' + e.other + '"' : '';
    return (bits || other) ? who + ': ' + [bits, other].filter(Boolean).join(', ') : '';
  }
  return [one(en.partner, partnerName), one(en.me, myName)].filter(Boolean).join('; ');
}

function buildIntakeBlock(name, data, partnerName) {
  const pn = partnerName || 'their partner';
  const lines = ['--- ' + name + '\'s intake detail (Path B):'];
  if (data.fightName) lines.push('What they call this fight: ' + data.fightName);
  if (data.initialRetelling) lines.push('Their own retelling, as first told: ' + data.initialRetelling);
  if (data.fightTopic) lines.push('What they say the fight is about: ' + data.fightTopic);
  if (data.fightTrigger) lines.push('What usually sets it off: ' + data.fightTrigger);
  if (data.whoStartsIt) lines.push('Who usually starts it, and how: ' + data.whoStartsIt);
  if (data.setting || data.fightLocation) lines.push('Where it usually happens: ' + (data.setting || data.fightLocation));
  if (data.startingMoment) lines.push('The first line that starts it: ' + data.startingMoment);
  if (data.beatByBeat) lines.push('How it unfolds beat by beat: ' + data.beatByBeat);
  if (data.sayEveryTime) lines.push('What ' + name + ' says every time: ' + String(data.sayEveryTime).replace(/\n/g, ' / '));
  if (data.theySayEveryTime) lines.push('What ' + pn + ' says every time: ' + String(data.theySayEveryTime).replace(/\n/g, ' / '));
  if (data.heardWhenTheySayThat) lines.push('What they hear when ' + pn + ' says their usual line (their version, not what ' + pn + ' meant): ' + data.heardWhenTheySayThat);
  if (data.speedsUpAt || data.intensifyingTrigger) lines.push('A word or tone where it speeds up: ' + (data.speedsUpAt || data.intensifyingTrigger));
  const en = energyLines(data.energy, name, pn);
  if (en) lines.push('The energy as heard from the next room, start to end (' + en + ')');
  if (data.cue || data.nonverbalCue) lines.push('A look, tone or silence that gets to them more than the words: ' + pn + ' ' + (data.cue || data.nonverbalCue) + (data.cuePlacement ? ', usually after the line "' + data.cuePlacement + '"' : ''));
  if (data.interruption || data.pauseMoment) lines.push('What usually interrupts it (not resolves it): ' + (data.interruption || data.pauseMoment));
  if (data.nonverbalInterpretation) lines.push('What they believe that cue means: ' + data.nonverbalInterpretation);
  if (data.righteousnessBelief) lines.push('What they believe they are right about: ' + data.righteousnessBelief);
  const notes = data.intakeNotes;
  if (Array.isArray(notes) && notes.length) lines.push('Things they added along the way: ' + notes.join(' | '));
  lines.push('---');
  return lines.join('\n');
}

function buildWarmupBlock(name, wu) {
  if (!wu || (!wu.q1 && !wu.q2 && !wu.q3)) return '';
  const l = ['--- ' + name + '\'s emotional context (answered before writing their script) ---'];
  if (wu.q1) l.push('How they typically feel in this fight: ' + String(wu.q1).replace(/\|/g, ', '));
  if (wu.q2) l.push('What they want from this process: ' + String(wu.q2).replace(/\|/g, ', '));
  if (wu.q3) l.push('What they think needs to shift: ' + String(wu.q3).replace(/\|/g, ', '));
  l.push('---\n\n');
  return l.join('\n');
}

// The Step 2 analysis request, exactly as the page used to build it.
function buildStep2Prompt(o) {
  const my = o.myData, partner = o.partnerData, myName = o.myName, partnerName = o.partnerName;
  return 'The couple\'s fight is called: ' + o.fightName + '\n\n' +
    buildWarmupBlock(myName, o.warmup) +
    '— SCRIPT FROM ' + myName.toUpperCase() + ' —\n\n' + scriptDataToText(my, myName, partnerName) + '\n\n' +
    myName + '\'s story about what ' + partnerName + ' is thinking:\n' +
    (my.storyThinking || '(no answer provided)') + '\n\n' +
    myName + '\'s story about what ' + partnerName + ' is feeling:\n' +
    (my.storyFeeling || '(no answer provided)') +
    (my.pathChosen === 'b' ? '\n\n' + buildIntakeBlock(myName, my, partnerName) : '') + '\n\n' +
    '— SCRIPT FROM ' + partnerName.toUpperCase() + ' —\n\n' + scriptDataToText(partner, partnerName, myName) + '\n\n' +
    partnerName + '\'s story about what ' + myName + ' is thinking:\n' +
    (partner.storyThinking || '(no answer provided)') + '\n\n' +
    partnerName + '\'s story about what ' + myName + ' is feeling:\n' +
    (partner.storyFeeling || '(no answer provided)') +
    (partner.pathChosen === 'b' ? '\n\n' + buildIntakeBlock(partnerName, partner, myName) : '');
}

// The server reads documents as plain text values. The few fields the page saves as JSON are turned back into data here.
function normalize(d) {
  const o = {}; Object.keys(d || {}).forEach(function(k) { o[k] = d[k]; });
  ['energy', 'intakeNotes'].forEach(function(k) { if (typeof o[k] === 'string') { try { o[k] = JSON.parse(o[k]); } catch (e) { /* leave as text */ } } });
  return o;
}

module.exports = { normalize, cueClean, scriptDataToText, energyLines, buildIntakeBlock, buildWarmupBlock, buildStep2Prompt };
