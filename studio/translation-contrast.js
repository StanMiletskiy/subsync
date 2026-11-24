// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  'use strict';

  // Work only on explicit, two-part English contrasts. Preserve every byte of
  // the surrounding Russian clause, changing only the verified term interiors.
  const quote = /"([^"\r\n]+)"|«([^«»\r\n]+)»|“([^“”\r\n]+)”|‘([^‘’\r\n]+)’|'([^'\r\n]+)'/gu;
  const term = /^[\p{L}\p{M}]+(?:[ -][\p{L}\p{M}]+){0,3}$/u;
  const letters = text => text.toLocaleLowerCase('ru').normalize('NFC').replace(/ё/g, 'е').match(/\p{L}+/gu) || [];
  const tokenEnd = /[.!?…,:;"'”»]*$/u;

  function slot(text, start) { return {text, start, end:start + text.length}; }
  function replaceSlots(text, slots, terms) {
    return text.slice(0, slots[0].start) + terms[0] + text.slice(slots[0].end, slots[1].start) +
      terms[1] + text.slice(slots[1].end);
  }
  function quoted(text) {
    return [...text.matchAll(quote)].map(m => slot(m[0].slice(1,-1), m.index + 1));
  }
  function sourcePair(text) {
    const q = quoted(text);
    if (q.length === 2 && q.every(x=>term.test(x.text))) {
      const pre = text.slice(0, q[0].start - 1), bridge = text.slice(q[0].end + 1, q[1].start - 1).trim();
      if ((/\b(?:difference|distinction)\s+between\s*$/i.test(pre) && /^and$/i.test(bridge)) ||
          (/\b(?:tell|distinguish|differentiate)\s*$/i.test(pre) && /^from$/i.test(bridge))) {
        return {terms:q, quoted:true};
      }
    }
    if (q.length) return null;
    const m = /\b(?:(?:difference|distinction)\s+between\s+(.+?)\s+and\s+|(?:tell|distinguish|differentiate)\s+(.+?)\s+from\s+)(.+?)[.!?…]*$/iu.exec(text);
    if (!m) return null;
    const left = m[1] ?? m[2], right = m[3];
    // Require two explicitly introduced noun groups. Unmarked "tell me from
    // experience" and clauses containing a conjunction are outside this rule.
    if (![left, right].every(s => /^(?:an?|the)\s/i.test(s) && term.test(s) &&
        !/\b(?:and|or|that|who|when|with)\b/i.test(s))) return null;
    const offset = m.index + m[0].indexOf(left);
    return {terms:[slot(left,offset),slot(right,text.lastIndexOf(right))], quoted:false};
  }

  function targetPair(text) {
    const q = quoted(text);
    if (q.length === 2 && q.every(x=>term.test(x.text))) {
      const pre = text.slice(0,q[0].start - 1), bridge = text.slice(q[0].end+1,q[1].start-1).trim().toLowerCase();
      if (bridge === 'от' || (bridge === 'и' && /между\s*$/iu.test(pre))) {
        return {terms:q, family:bridge==='от'?'from':'between', quoted:true};
      }
    }
    if (q.length) return null;
    const m = /(?:между\s+(.+?)\s+и\s+|(?:отлич|различ)[а-яё]+\s+(.+?)\s+от\s+)(.+?)[.!?…,:;"'”»]*$/iu.exec(text);
    if (!m) return null;
    const left = m[1] ?? m[2], right = m[3];
    if (![left,right].every(s=>term.test(s) && /^[а-яё\s-]+$/iu.test(s) &&
      !/(?:^|\s)(?:и|или|но|когда|если|ли|они|он|она|вы|ты|мы)(?:\s|$)/iu.test(s))) return null;
    const offset = m.index + m[0].indexOf(left);
    return {terms:[slot(left, offset),slot(right,text.lastIndexOf(right))],family:m[1] ? 'between':'from',quoted:false};
  }

  function stems(word) {
    const result = new Set([word]);
    const ending = /(?:иями|ами|ями|ого|его|ому|ему|ыми|ими|ах|ях|ам|ям|ом|ем|ою|ею|ой|ей|ов|ев|ым|им|ая|яя|ое|ее|ые|ие|ый|ий|ую|юю|а|я|ы|и|е|у|ю|о|ь|й)$/u.exec(word);
    if (ending && ending.index >= 3) result.add(word.slice(0,ending.index));
    // Fleeting vowels in Russian nouns, e.g. замок / замка, пакет / пакета.
    if (word.length >= 5 && /[ое]к$/u.test(word)) result.add(word.slice(0,-2) + 'к');
    return result;
  }
  function equivalent(a, b) {
    const x = letters(a), y = letters(b);
    if (!x.length || x.length !== y.length) return false;
    return x.every((word, i) => {
      const other = stems(y[i]);
      return [...stems(word)].some(v=>other.has(v));
    });
  }
  function inspect(sourceText, targetText, sourceLanguage, targetLanguage) {
    if (sourceLanguage?.split('-')[0] !== 'en' || targetLanguage?.split('-')[0] !== 'ru' ||
        typeof sourceText !== 'string' || typeof targetText !== 'string' ||
        sourceText.length > 360 || targetText.length > 500 || /[\r\n]/u.test(sourceText + targetText)) return null;
    const source = sourcePair(sourceText), target = targetPair(targetText);
    if (!source || !target || source.terms[0].text.toLowerCase().replace(/^(?:an?|the) /u,'') ===
        source.terms[1].text.toLowerCase().replace(/^(?:an?|the) /u,'') ||
        !equivalent(target.terms[0].text, target.terms[1].text)) return null;
    return {sourceText,targetText,source,target};
  }

  function verbContext(terms, context) {
    const text = (Array.isArray(context) ? context.join('\n') : String(context || '')).slice(0,4000);
    return terms.some(({text:word}) => {
      const base = word.toLowerCase();
      if (!/^[a-z]{2,20}$/u.test(base)) return false;
      const forms = base + '(?:s|ed|ing)?|' + (base.endsWith('e') ? base.slice(0,-1) : base) + '(?:ed|ing)|' +
        base + base.at(-1) + '(?:ed|ing)';
      // Use an actual auxiliary/modal construction from the film as lexical
      // evidence. The labels being repaired cannot supply their own evidence.
      return new RegExp('\\b(?:is|was|were|been|being|are|has|have|had|can|could|will|would|must|did|does|do)' +
        '\\s+(?:(?:not|never|really|also|he|she|they|you|it|we|i)\\s+){0,2}(?:' + forms + ')\\b','i').test(text);
    });
  }
  function matchesOriginalVerb(verb, nominal) {
    const root = verb.toLowerCase().replace(/(?:аться|иться|нуть|ить|еть|ать|ять)$/u,'');
    return root.length >= 3 && letters(nominal).length === 1 && stems(letters(nominal)[0]).has(root);
  }
  function grammaticalCase(proposed, witness, role, query) {
    // Quoted Russian labels sometimes remain in nominative. When restoring an
    // unquoted noun, corroborate its case as well as its lexical identity.
    const p = letters(proposed).at(-1), w = letters(witness).at(-1);
    if (!p || !w) return false;
    if (role === 'instrumental') return query === 'with' && p === w;
    if (role === 'genitive') {
      if (query === 'from' && p === w) return true;
      return /(?:а|я|ы|и|ей|ов|ев)$/u.test(p) && p !== w;
    }
    if (query === 'see' && p === w) return true;
    if (/(?:у|ю)$/u.test(p) && p !== w) return true;
    // Masculine inanimate nouns often share a nominative/accusative. An
    // explicit accusative witness is needed for other noun forms.
    return query === 'bare' && p === w && /[бвгджзклмнпрстфхцчшщ]$/u.test(p);
  }
  function probeTerm(text) {
    if (!text || /[\r\n<>\[\]{}]/u.test(text)) return null;
    const unwrapped = text.trim().replace(/^(?:это\s+(?:был[аои]?\s+)?|они\s+могут\s+|я\s+вижу\s+|(?:от|со|с)\s+)/iu,'')
      .replace(/^[«“"'‘]+/u,'').replace(tokenEnd,'').replace(/[’“]+$/u,'').trim();
    return term.test(unwrapped) && /^[а-яё -]+$/iu.test(unwrapped) ? unwrapped : null;
  }

  async function recover(issue, {translate,signal,sourceContext} = {}) {
    const original = {text:issue.targetText,status:'unresolved'};
    signal?.throwIfAborted();
    if (typeof translate !== 'function') return original;
    // The English probes use grammatical frames, never topic vocabulary.
    const {source,target,sourceText,targetText} = issue;
    const labels = source.terms.map(t=>t.text);
    const cache = new Map();
    async function ask(input) {
      signal?.throwIfAborted();
      if (!cache.has(input)) {
        const raw = await translate(input,{signal});
        signal?.throwIfAborted();
        cache.set(input,typeof raw === 'string' && raw.length <= 700 && !/[<>\r\n\[\]{}]/u.test(raw) ? raw.trim() : '');
      }
      return cache.get(input);
    }
    try {
      let terms;
      if (source.quoted && labels.every(x=>/^[a-z]{2,20}$/u.test(x)) &&
          target.quoted && verbContext(source.terms,sourceContext)) {
        const variant = replaceSlots(sourceText,source.terms,labels.map(t=>'to ' + t));
        const pair = targetPair(await ask(variant));
        if (pair?.family === target.family && pair.quoted) {
          const proposed = pair.terms.map(x=>x.text);
          const confirmed = [];
          for (const [i,word] of labels.entries()) {
            const bare = probeTerm(await ask('to ' + word));
            const framed = probeTerm(await ask('They can ' + word + '.'));
            confirmed.push(/(?:ть|ти|чь)(?:ся|сь)?$/iu.test(proposed[i]) && bare && framed &&
              equivalent(bare,proposed[i]) && equivalent(framed,proposed[i]) &&
              (verbContext([source.terms[i]],sourceContext) || matchesOriginalVerb(proposed[i],target.terms[i].text)));
          }
          if (confirmed.every(Boolean)) terms = proposed;
        }
      } else if (!source.quoted) {
        const variant = replaceSlots(sourceText,source.terms,labels.map(t=>'"' + t + '"'));
        const pair = targetPair(await ask(variant));
        if (!pair || pair.family !== target.family || equivalent(pair.terms[0].text,pair.terms[1].text)) return original;
        const proposed = pair.terms.map(x=>x.text), verified = [];
        for (const [i,word] of labels.entries()) {
          if (equivalent(proposed[i],target.terms[i].text)) { verified.push(true); continue; }
          // A native model may translate the surrounding predicate incorrectly
          // after quoting the terms. Transfer only a corroborated, case-matched
          // operand from the same Russian grammatical position.
          const role = target.family === 'between' ? 'instrumental' : i === 1 ? 'genitive' : 'accusative';
          const queries = [['bare',word], ['with','with ' + word]];
          if (role === 'genitive') queries.push(['from','from "' + word + '"']);
          if (role === 'accusative') queries.push(['see','I see ' + word + '.']);
          let matched = false;
          for (const [frame, query] of queries) {
            const witness = probeTerm(await ask(query));
            if (witness && equivalent(witness,proposed[i]) &&
                (target.quoted || grammaticalCase(proposed[i],witness,role,frame))) { matched = true; break; }
          }
          verified.push(matched);
        }
        if (verified.every(Boolean)) terms = proposed.map((t,i) =>
          equivalent(t,target.terms[i].text) ? target.terms[i].text : t);
      }
      if (!terms || equivalent(terms[0],terms[1])) return original;
      const text = replaceSlots(targetText,target.terms,terms);
      return {text,status:'recovered'};
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.name === 'AbortError') throw error;
      return original;
    }
  }

  const api = {inspect,recover};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.CueTranslationContrast = api;
})();
