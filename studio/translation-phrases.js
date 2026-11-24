/* SPDX-License-Identifier: GPL-3.0-or-later */
(function () {
  'use strict';

  const compact = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const closed = /[.!?…‥。！？؟۔।॥]["'»”’」』）)\]]*$/u;
  const pause = /[,;:，、；：،؛]$/u;
  const opening = /[\p{Ps}\p{Pi}“‘「『]$/u;
  const closing = /^[\p{Pe}\p{Pf}。．，、！？；：,.!?;:%…」』]/u;
  const separator = /^\s+$/u;
  const lexical = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
  const cache = new Map();

  function segmenter(language, granularity) {
    const locale = language || undefined, key = String(locale) + '/' + granularity;
    if (!cache.has(key)) {
      let value = null;
      if (typeof Intl.Segmenter === 'function') {
        try { value = new Intl.Segmenter(locale, {granularity}); }
        catch { value = new Intl.Segmenter(undefined, {granularity}); }
      }
      cache.set(key, value);
    }
    return cache.get(key);
  }

  function joinText(left, right, language) {
    const tail = Array.from(left).at(-1), head = Array.from(right)[0];
    const noSpace = compact.test(tail) && compact.test(head) ||
      (/^(?:zh|ja|th|lo|km|my)(?:-|$)/i.test(language || '') &&
        (compact.test(head) && /[\p{P}]/u.test(tail) || compact.test(tail) && closing.test(head)));
    return left + (noSpace || closing.test(head) || opening.test(tail) || /[-\u00ad‐]$/u.test(tail) ? '' : ' ') + right;
  }

  function continues(previous, next) {
    const a = previous.phrase, b = next.phrase;
    if (!a || !b || a.isolated || b.isolated || b.turnStart || a.settings !== b.settings || a.style !== b.style) return false;
    const end = previous.text.trim(), start = next.text.trim();
    if (!end || !start || closed.test(end) || /^[«“「『"]/u.test(start)) return false;
    if (previous.cue === next.cue) return b.lineIndex === a.lineIndex + 1;
    const gap = b.startMs - a.endMs;
    if (next.cue !== previous.cue + 1 || a.lineIndex !== a.lineCount - 1 || b.lineIndex !== 0 ||
        !Number.isFinite(gap) || gap < 0 || gap > 1200) return false;
    // Across a cue boundary, the text should itself support a continuation.
    // A new capitalized sentence or unmarked dialogue turn can otherwise get merged.
    return pause.test(end) || /^\p{Ll}/u.test(start) ||
      (gap <= 600 && /^\p{Lo}/u.test(start) && /\p{Lo}[\p{M}]*$/u.test(end));
  }

  function plan(units, sourceLanguage) {
    const phrases = [];
    for (const unit of units) {
      const prev = phrases.at(-1);
      if (prev && prev.units.length < 6 && unit.cue - prev.cue < 3 &&
          prev.text.length + unit.text.length < 480 && continues(prev.units.at(-1), unit)) {
        prev.text = joinText(prev.text, unit.text, sourceLanguage);
        prev.units.push(unit);
      } else {
        phrases.push({id:unit.id, cue:unit.cue, text:unit.text, units:[unit]});
      }
    }
    return phrases;
  }

  // Select language-appropriate typesetting boundaries. A Latin word never
  // gets cut in two to fill a slot. Chinese and Japanese also permit breaks
  // between graphemes when dictionary boundaries cannot fill every slot.
  function boundaries(text, language, graphemes) {
    const words = segmenter(language,'word');
    const starts = new Set();
    if (words && compact.test(text)) {
      for (const part of words.segment(text)) if (part.isWordLike) starts.add(part.index);
    }
    const cuts = [];
    let count = 0;
    for (let i = 1; i < graphemes.length; i++) {
      const left = graphemes[i-1].segment, right = graphemes[i].segment;
      if (lexical.test(left)) count++;
      const space = separator.test(right), following = graphemes[i + (space ? 1 : 0)];
      const after = following?.segment;
      if (!after || !count || separator.test(left) || closing.test(after) || opening.test(left) ||
          (/^[-–—―]/u.test(after) && !/^-\p{Nd}/u.test(text.slice(following.index))) ||
          /^[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶー々]/u.test(after)) continue;
      let cost;
      if (space) cost = 0.015;
      else if ((compact.test(left) || compact.test(right)) && starts.has(graphemes[i].index)) cost = 0.025;
      else if (cjk.test(left) && cjk.test(right)) cost = 10; // Fallback only when word cuts cannot fill every slot.
      else continue;
      const clause = /[,;:，、；：،؛.!?…。！？؟۔।॥]["'»”’」』）)]*$/u.test(text.slice(Math.max(0,graphemes[i].index-8),graphemes[i].index));
      if (clause) cost = 0;
      cuts.push({at:graphemes[i].index, fraction:i / graphemes.length, count, cost, clause});
    }
    return {cuts, total:count + (lexical.test(graphemes.at(-1).segment) ? 1 : 0)};
  }

  // A word may move freely across visual lines displayed at the same instant.
  // Across different cue times, preserve each cue's numbers and distinctive
  // names that appear in both languages. Refuse an impossible assignment.
  function timedCuts(units, text, cuts) {
    if (units.every(u => u.cue === units[0].cue)) return [];
    const digits = value => Array.from(value.normalize('NFKC'), ch => {
      const code = ch.codePointAt(0);
      let zero = code;
      while (zero && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
      return (code - zero) % 10;
    }).join('');
    const numbers = value => Array.from(value.matchAll(/[\-−]?\p{Nd}+/gu), m => ({
      key:(/^[−-]/u.test(m[0]) ? '-' : '') + digits(m[0].replace(/^[−-]/u,'')), at:m.index, end:m.index+m[0].length,
    }));
    const sourceNumbers = units.map(u => numbers(u.text));
    const target = numbers(text);
    const keys = values => values.map(n => n.key).sort().join('/');
    if (sourceNumbers.some(list => list.length) && keys(sourceNumbers.flat()) !== keys(target)) return null;

    // Only a uniquely repeated spelling is evidence. Transliterations, names
    // with changing inflections, and generic sentence-opening capitals are not guessed.
    const words = value => Array.from(value.matchAll(/[\p{L}\p{M}’'-]+/gu));
    const spelling = word => word.normalize('NFC').toLowerCase();
    const sourceWords = units.flatMap((unit,slot) => words(unit.text).map(m => ({word:m[0],slot,at:m.index})));
    const targetWords = words(text);
    const names = [];
    for (const w of sourceWords) {
      if (!/^\p{Lu}[\p{L}\p{M}’'-]{2,}$/u.test(w.word) || (w.slot === 0 && !w.at)) continue;
      const key = spelling(w.word), found = targetWords.filter(m => spelling(m[0]) === key);
      if (found.length === 1 && sourceWords.filter(other => spelling(other.word) === key).length === 1) {
        names.push({slot:w.slot,at:found[0].index,end:found[0].index+found[0][0].length});
      }
    }
    const rules = [];
    for (let k = 1; k < units.length; k++) {
      if (units[k-1].cue === units[k].cue) continue;
      const left = sourceNumbers.slice(0,k).flat();
      if (keys(left) !== keys(target.slice(0,left.length))) return null;
      let min = left.length ? target[left.length-1].end : 0;
      let max = sourceNumbers.some(list => list.length) && left.length < target.length ? target[left.length].at : text.length;
      for (const name of names) {
        if (name.slot < k) min = Math.max(min,name.end);
        else max = Math.min(max,name.at);
      }
      if (min > max) return null;
      const range = cuts.filter(c => c.at >= min && c.at <= max);
      if (!range.length) return null;
      let clauseOnly = false;
      if (pause.test(units[k-1].text.trim())) {
        clauseOnly = range.some(c => c.clause);
        // A source clause break with no corresponding punctuation or lexical
        // landmarks is a poor place to guess a new cue time.
        if (!clauseOnly && min === 0 && max === text.length) return null;
      }
      rules[k] = {min,max,clauseOnly};
    }
    return rules;
  }

  function redistribute(phrase, translation, targetLanguage) {
    if (typeof translation !== 'string') return null;
    const text = translation.trim();
    if (!text || /[\r\n]/u.test(text) || !phrase.units.length) return null;
    if (phrase.units.length === 1) return [text];
    const grapheme = segmenter(targetLanguage,'grapheme');
    if (!grapheme) return null;
    const gs = Array.from(grapheme.segment(text));
    const {cuts, total} = boundaries(text, targetLanguage, gs);
    const slots = phrase.units.length;
    if (total < slots || cuts.length < slots - 1) return null;
    const timed = timedCuts(phrase.units,text,cuts);
    if (!timed) return null;
    const weights = phrase.units.map(u=>Array.from(u.text).length);
    const length = weights.reduce((sum, n)=>sum+n,0);
    let consumed = 0, prior = [];
    const stages = [];
    // Dynamic programming in slots × candidates. A strictly increasing count of
    // meaningful graphemes ensures that an isolated quote or comma never fills a cue.
    for (let k = 1; k < slots; k++) {
      consumed += weights[k-1];
      const desired = consumed / length;
      let scan = 0, best = -1;
      const scores = [], parents = [];
      for (let j = 0; j < cuts.length; j++) {
        const cut = cuts[j];
        while (scan < j && cuts[scan].count < cut.count) {
          if (k > 1 && Number.isFinite(prior[scan]) && (best < 0 || prior[scan] < prior[best])) best = scan;
          scan++;
        }
        const distance = Math.abs(cut.fraction - desired);
        const rule = timed[k];
        const allowed = !rule || (cut.at >= rule.min && cut.at <= rule.max && (!rule.clauseOnly || cut.clause));
        scores.push(!allowed || cut.count < k || total - cut.count < slots - k || (k > 1 && best < 0) ? Infinity :
          (k === 1 ? 0 : prior[best]) + distance + cut.cost);
        parents.push(best);
      }
      stages.push(parents);
      prior = scores;
    }
    let best = -1;
    prior.forEach((score,i)=>{if (Number.isFinite(score) && (best < 0 || score < prior[best])) best = i;});
    if (best < 0) return null;
    const selected = [text.length];
    for (let k = stages.length - 1; k >= 0; k--) {
      selected.unshift(cuts[best].at);
      best = stages[k][best];
    }
    let from = 0;
    return selected.map(to=>{
      const piece = text.slice(from,to).trim();
      from = to;
      return piece;
    });
  }

  const api = {plan, redistribute};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.CueTranslationPhrases = api;
})();
