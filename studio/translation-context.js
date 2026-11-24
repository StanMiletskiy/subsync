// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  'use strict';

  const clean = text => typeof text === 'string' ? text.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
  const eastAsian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const hasLetter = /\p{L}/u;
  const size = text => Array.from(text).length;

  function wordReader(language) {
    let segmenter;
    if (typeof Intl.Segmenter === 'function') {
      try { segmenter = new Intl.Segmenter(language, {granularity:'word'}); }
      catch { segmenter = new Intl.Segmenter(undefined, {granularity:'word'}); }
    }
    return text => {
      const words = [];
      const parts = segmenter ? segmenter.segment(text) : text.matchAll(/[\p{L}\p{M}\p{N}]+/gu);
      for (const part of parts) {
        const word = segmenter ? part.segment : part[0];
        if ((segmenter && !part.isWordLike) || !hasLetter.test(word)) continue;
        words.push({text:word, key:word.toLowerCase(), start:part.index, end:part.index + word.length});
      }
      return words;
    };
  }

  function features(words, text) {
    const terms = new Map();
    for (const [i, word] of words.entries()) {
      const length = size(word.text), name = i > 0 && word.text !== word.key;
      const ideographic = eastAsian.test(word.text);
      if (length >= 4 || (length >= 3 && name) || (length >= 2 && ideographic)) {
        terms.set(word.key, {text:word.text, keys:[word.key]});
      }
      if (!i) continue;
      const prev = words[i-1];
      // Do not construct multiword terminology across sentence or clause boundaries.
      if (!/^[\s'’\-]*$/u.test(text.slice(prev.end, word.start))) continue;
      const term = text.slice(prev.start, word.end);
      if (size(term) <= 35 && size(prev.text) + length >= 5) {
        terms.set(prev.key + '\u0000' + word.key, {text:term, keys:[prev.key, word.key]});
      }
    }
    return terms;
  }

  function excerpt(text, term) {
    const chars = Array.from(text);
    if (chars.length <= 120) return text;
    const hit = text.toLowerCase().indexOf(term.toLowerCase());
    const at = hit < 0 ? 0 : size(text.slice(0, hit));
    const start = Math.max(0, Math.min(at - 35, chars.length - 118));
    const end = start + 118;
    return (start ? '…' : '') + chars.slice(start, end).join('') + (end < chars.length ? '…' : '');
  }

  function create(phrases, sourceLanguage) {
    const wordsOf = wordReader(sourceLanguage);
    const postings = new Map(), repeats = new Map(), frequency = new Map(), spellings = new Map(), accepted = [];
    const entries = phrases.map((phrase, index) => {
      const text = clean(phrase.text), words = wordsOf(text), terms = features(words, text);
      for (const key of new Set(words.map(w => w.key))) frequency.set(key, (frequency.get(key) || 0) + 1);
      for (let i = 1; i < words.length; i++) {
        const word = words[i];
        if (size(word.key) < 3 || /[.!?…:;。！？]/u.test(text.slice(words[i-1].end, word.start))) continue;
        const counts = spellings.get(word.key) || {upper:0, total:0};
        if (/^\p{Lu}[\p{L}\p{M}]*$/u.test(word.text)) counts.upper++;
        counts.total++;
        spellings.set(word.key, counts);
      }
      for (const key of terms.keys()) {
        if (!postings.has(key)) postings.set(key, []);
        postings.get(key).push(index);
      }
      if (!repeats.has(text)) repeats.set(text, []);
      repeats.get(text).push(index);
      return {text, terms, wordCount:words.length};
    });
    const common = Math.min(64, Math.max(3, Math.ceil(entries.length / 20)));

    function isName(key) {
      const counts = spellings.get(key);
      return counts && counts.upper > counts.total / 2;
    }
    function distinctive(key) {
      const length = size(key), named = isName(key), ideographic = eastAsian.test(key);
      const limit = !named && !ideographic && length < 6 ? Math.max(3, Math.ceil(entries.length/150)) : common;
      return frequency.get(key) <= limit && (length >= 4 || named || (ideographic && length >= 2));
    }

    function forUnit(index) {
      const item = entries[index];
      const empty = {related:[], recurringTerms:[]};
      if (!item) return empty;
      const ranked = [];
      for (const [key, term] of item.terms) {
        const hits = postings.get(key);
        if (hits.length < 2 || hits.length > common || size(term.text) > 35) continue;
        const linked = term.keys.filter(distinctive);
        if (!linked.length) continue;
        const named = linked.some(isName);
        const rare = linked.some(k => frequency.get(k) <= Math.max(3, Math.ceil(entries.length / 200)) &&
          (size(k) >= 9 || eastAsian.test(k)));
        // An isolated common word or a collocation such as "in the" is too
        // weak to justify bringing dialogue from a different scene into view.
        const strong = named || rare || new Set(linked).size > 1;
        const evidence = linked.length === 1 ? item.terms.get(linked[0]) || term : term;
        const weight = Math.log2((entries.length+1) / hits.length) * (strong ? 1.5 : 0.8);
        ranked.push({term:evidence, hits, linked, strong, weight});
      }
      ranked.sort((a,b) => b.weight - a.weight);
      const candidates = new Map();
      for (const {term, hits, linked, strong, weight} of ranked.slice(0, 8)) {
        for (const i of hits) {
          if (Math.abs(i-index) <= 4 || entries[i].text.toLowerCase() === item.text.toLowerCase()) continue;
          let candidate = candidates.get(i);
          if (!candidate) {
            candidate = {index:i,score:0,strong:false,words:new Set(),evidence:[]};
            candidates.set(i, candidate);
          }
          candidate.score += weight;
          candidate.strong ||= strong;
          for (const token of linked) candidate.words.add(token);
          candidate.evidence.push(term);
        }
      }
      const eligible = [...candidates.values()].filter(c => c.strong || c.words.size >= 2);
      for (const c of eligible) {
        // Favor an observed earlier translation over an equally relevant later
        // occurrence. Nearby cues are already supplied separately by the caller.
        if (c.index < index && accepted[c.index]) c.score *= 1.2;
      }
      eligible.sort((a,b) => b.score-a.score || Math.abs(index-a.index)-Math.abs(index-b.index));
      const first = eligible[0];
      if (!first) return empty;
      const other = eligible.slice(1).find(c => Math.abs(c.index-first.index) > 4 &&
        (index-c.index)*(index-first.index) < 0 && c.score >= first.score*0.65);
      const selected = other ? [first, other] : [first];
      const recurringTerms = [];
      const related = selected.map(c => {
        for (const {text} of c.evidence) {
          if (recurringTerms.length < 3 && !recurringTerms.some(t => t.toLowerCase().includes(text.toLowerCase()))) {
            recurringTerms.push(text);
          }
        }
        const text = entries[c.index].text;
        const example = {index:c.index,position:c.index < index ? 'earlier' : 'later',
          source:excerpt(text, c.evidence[0].text)};
        // Only pair complete source/target examples. An excerpt and a clipped
        // target could refer to two different parts of a long sentence.
        if (c.index < index && example.source === text && accepted[c.index] && size(accepted[c.index]) <= 120) {
          example.translation = accepted[c.index];
        }
        return example;
      });
      return {related, recurringTerms};
    }

    function remember(index, translation) {
      if (entries[index] && typeof translation === 'string' && translation.trim()) accepted[index] = translation;
    }

    function reuse(index) {
      const item = entries[index], before = entries[index-1], after = entries[index+1];
      if (!item || !before || !after || before.text === after.text || before.text === item.text ||
          after.text === item.text || item.wordCount < 2 ||
          size(item.text) < (eastAsian.test(item.text) ? 5 : 12) ||
          before.wordCount + after.wordCount < 5) return null;
      // A shared word or isolated "I know" can change gender or register in a
      // different scene. Only reuse a full phrase inside the same exact exchange.
      let result = null;
      for (const i of repeats.get(item.text)) {
        if (i >= index) break;
        if (!accepted[i] || entries[i-1]?.text !== before.text || entries[i+1]?.text !== after.text) continue;
        if (result !== null && result !== accepted[i]) return null;
        result = accepted[i];
      }
      return result;
    }

    return {forUnit, remember, reuse};
  }

  const api = {create};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.CueTranslationContext = api;
})();
