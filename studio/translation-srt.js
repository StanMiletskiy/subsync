/* SPDX-License-Identifier: GPL-3.0-or-later */
(function () {
  'use strict';

  const srt = typeof module !== 'undefined' && module.exports ? require('./srt') : globalThis.SyncSrt;
  // Match within one physical line. Literal layout never enters a translation request.
  const html = String.raw`(?:<!--[^\r\n]*?-->|<\/?[a-z][\w:.-]*(?:[^<>"'\r\n]|"[^"\r\n]*"|'[^'\r\n]*')*>)`;
  const overrides = String.raw`\{(?:\\|[a-z]+:)[^{}\r\n]*\}`;
  const bbcode = String.raw`\[\/?(?:i|b|u|s|font|size|color)(?=[= \t\]])[^\]\r\n]*\]`;
  const tag = '(?:' + html + '|' + overrides + '|' + bbcode + ')';
  const speaker = String.raw`^[ \t]*(?:` + tag + String.raw`[ \t]*)*[-–—―](?=[ \t]|\p{L})[ \t]*`;
  const controls = new RegExp(speaker + '|' + tag +
    String.raw`|[\[\]]|[♪♫♬]+|\\[Nnh]| {2,}|\t+|[\u00a0\u2007\u202f]|&(?:nbsp|#160|#x0*a0);`, 'giu');
  const entities = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'"};
  const markup = new RegExp(tag, 'iu');
  const htmlTokens = new RegExp(html, 'giu');
  const assOverrides = new RegExp(overrides, 'iu');
  const simpleStyle = /^\s*(<(i|b|u|s|font)\b(?:\s+(?:[a-z]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|[^\s<>"'=]+)))*\s*>)([^<>]*)<\/\2\s*>\s*$/iu;

  function sharedStyle(text) {
    if (assOverrides.test(text) || /[\[\]♪♫♬]|\\[Nnh]|[\u202a-\u202e\u2066-\u2069]/u.test(text)) return null;
    if (!markup.test(text)) return /[<>]/u.test(text) ? null : '';
    const envelope = segment => {
      const match = simpleStyle.exec(segment);
      if (!match) return null;
      const attributes = match[1].matchAll(/\s+([a-z]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu);
      for (const attr of attributes) {
        if (match[2].toLowerCase() !== 'font' || !/^(?:face|color|size)$/iu.test(attr[1])) return null;
      }
      return match[1];
    };
    const whole = envelope(text);
    if (whole) return whole;
    const styles = text.split(/\r\n|[\r\n]/).map(envelope);
    return styles[0] && styles.every(style => style === styles[0]) ? styles[0] : null;
  }

  function readable(text) {
    return text.replace(/&(amp|lt|gt|quot|apos);/gi, (_, name) => entities[name.toLowerCase()]);
  }

  const dialogueDash = /^[-–—―](?:[ \t]+(?=[^\s\p{N}])|(?=\p{L}))/u;
  const openingQuote = /^["«“„「『]/u;
  const stylePair = /^<(i|b|u|s|font)(?:\s[^<>]*)?>([\s\S]*)<\/\1>$/iu;
  const bbPair = /^\[(i|b|u|s|font|color|size)(?:=[^\]]+)?\]([\s\S]*)\[\/\1\]$/iu;

  function inputText(value, unit) {
    // Ignore stand-alone joining marks and directional controls when checking
    // for visible content; leave them intact within real words and emoji.
    if (typeof value !== 'string' || !value.replace(/[\s\p{Mark}\p{Format}\p{Default_Ignorable_Code_Point}]/gu, '')) {
      throw Object.assign(Error('No translation was returned for cue ' + unit.cue + '.'), {cueNumber:unit.cue, unitId:unit.id});
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
        /(?:^|[\r\n])[ \t]*\d+:[\d:.,]+[ \t]*-->/.test(value) || /\{\\|\\[Nnh]/.test(value)) {
      throw Object.assign(Error('The translation for cue ' + unit.cue + ' contains subtitle controls.'), {cueNumber:unit.cue, unitId:unit.id});
    }
    return value.trim().replace(/\s+/gu, ' ');
  }

  function encodedText(text, unit, firstOnLine) {
    // An editor may use brackets within a sentence, e.g. “register [A]”.
    // A newly wrapped caption or a new speaker turn is a layout change.
    if ((firstOnLine && dialogueDash.test(text) && !dialogueDash.test(unit.text)) ||
        /^\[[^\]]*\]$/u.test(text) || /^[♪♫♬]|[♪♫♬]$/u.test(text)) {
      throw Object.assign(Error('The translation would change subtitle formatting in cue ' + unit.cue + '.'), {cueNumber:unit.cue, unitId:unit.id});
    }
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(new RegExp(bbcode, 'giu'), token=>'&#91;' + token.slice(1,-1) + '&#93;');
  }

  function generatedText(value, unit, firstOnLine) {
    let text = inputText(value, unit);
    // These wrappers were never sent to the model. Restore layout exclusively
    // from the source, keeping content (including internal punctuation) intact.
    let previous;
    do {
      previous = text;
      const style = stylePair.exec(text) || bbPair.exec(text);
      if (style) text = style[2].trim();
      else if (/^\[[^\[\]]+\]$/u.test(text)) text = text.slice(1,-1).trim();
      else text = text.replace(/^[♪♫♬]+\s*|\s*[♪♫♬]+$/gu, '').trim();
    } while (text !== previous);
    if (firstOnLine && dialogueDash.test(text) && !dialogueDash.test(unit.text)) {
      text = text.replace(dialogueDash, '').trimStart();
      // A translated line can replace an opening quote with a speaker dash.
      // Its closing quote may be several physical lines away.
      if (openingQuote.test(unit.text) && !openingQuote.test(text)) text = unit.text[0] + text;
    }
    return inputText(text, unit);
  }

  function inspect(parsed, addUnit, spans) {
    let cursor = 0, next = 0;
    const layout = [];
    for (const [index, cue] of parsed.cues.entries()) {
      layout.push(parsed.text.slice(cursor, cue.bodyStart));
      const cueLayout = [];
      for (const row of cue.text.matchAll(/([^\r\n]*)(\r\n|[\r\n]|$)/g)) {
        if (!row[0]) continue;
        const line = row[1], base = cue.bodyStart + row.index;
        let from = 0;
        if (addUnit) {
          for (const token of line.matchAll(controls)) {
            addUnit(line.slice(from, token.index), base + from, index + 1, base);
            from = token.index + token[0].length;
          }
          addUnit(line.slice(from), base + from, index + 1, base);
        } else {
          // Compare every literal between writable spans, including dashes, tags,
          // separators and whitespace. Never reclassify a source-owned character
          // by inspecting the adjacent first letter of the translated text.
          const literal = [];
          while (next < spans.length && spans[next].start < base + line.length) {
            const span = spans[next++];
            if (span.start < base + from || span.end > base + line.length) throw Error('Invalid subtitle formatting boundaries.');
            literal.push(line.slice(from, span.start - base));
            from = span.end - base;
          }
          literal.push(line.slice(from));
          cueLayout.push([row[2], literal]);
        }
      }
      layout.push(cueLayout);
      cursor = cue.bodyEnd;
    }
    if (!addUnit && next !== spans.length) throw Error('Invalid subtitle formatting boundaries.');
    layout.push(parsed.text.slice(cursor));
    return JSON.stringify(layout);
  }

  function reviewCues(parsed, units, spans) {
    let headerStart = parsed.text.charCodeAt(0) === 0xfeff ? 1 : 0;
    let next = 0;
    return parsed.cues.map((cue, index) => {
      // The parsed cue body starts either just after the timing line's terminator
      // or at its very end for an empty cue. Keep the identifier and timing verbatim.
      const header = parsed.text.slice(headerStart, cue.bodyStart).replace(/(?:\r\n|[\r\n])$/, '');
      const rows = header.split(/\r\n|[\r\n]/);
      const timing = rows.pop();
      const previous = rows.at(-1);
      const identifier = previous !== undefined && !/^[ \t]*$/.test(previous) ? previous : null;
      headerStart = cue.bodyEnd;
      const lines = [];
      for (const row of cue.text.matchAll(/[^\r\n]+/g)) {
        const lineStart = cue.bodyStart + row.index;
        const lineEnd = lineStart + row[0].length;
        const fragments = [];
        let cursor = lineStart;
        while (next < units.length && units[next].line === lineStart) {
          const span = spans[next], unit = units[next++];
          if (span.start > cursor) fragments.push({text:parsed.text.slice(cursor, span.start), unitId:null});
          fragments.push({text:unit.text, unitId:unit.id});
          cursor = span.end;
        }
        if (cursor < lineEnd) fragments.push({text:parsed.text.slice(cursor, lineEnd), unitId:null});
        lines.push(fragments);
      }
      // A phrase may cross plain subtitle lines, but moving words between
      // distinct style, position or speaker spans can change their meaning.
      const style = sharedStyle(cue.text);
      const afterArrow = timing.indexOf('-->') + 3;
      const settings = timing.slice(timing.indexOf(cue.endToken, afterArrow) + cue.endToken.length).trim();
      for (const [lineIndex, line] of lines.entries()) {
        const editable = line.filter(part => part.unitId !== null);
        const visible = part => part.unitId !== null ? part.text : part.text.replace(htmlTokens, '');
        const plain = line.map(visible).join('').trim();
        const turnStart = /^[-–—―](?=[ \t]|\p{L})/u.test(plain) ||
          /^\p{L}[\p{L}\p{M}.'’ -]{0,28}[:：]/u.test(plain);
        const isolated = style === null || editable.length !== 1 || /^[（(].*[）)]$/u.test(plain) ||
          line.some(part => part.unitId === null && /[^\s\-–—―]/u.test(visible(part)));
        for (const part of editable) {
          units[part.unitId].phrase = {startMs:cue.start, endMs:cue.end, lineIndex, lineCount:lines.length, settings, style, turnStart, isolated};
        }
      }
      return {number:index + 1, identifier, timing, original:cue.text, lines};
    });
  }

  function prepare(decodedText) {
    const parsed = srt.parse(decodedText);
    const units = [], spans = [];
    inspect(parsed, (text, offset, cue, line) => {
      const raw = text.trim();
      if (!/\p{L}/u.test(raw)) return;
      const start = offset + text.length - text.trimStart().length;
      units.push({id:units.length, cue, line, text:readable(raw)});
      spans.push({start, end:start + raw.length, raw});
    });
    // Sample across the file since a title card or a credit may use a different language.
    const samples = [], count = Math.min(units.length, 24);
    for (let i = 0; i < count; i++) samples.push(units[Math.floor((i + 0.5) * units.length / count)].text);
    const originalLayout = inspect(parsed, null, spans);
    const cues = reviewCues(parsed, units, spans);
    const atStart = i => i === 0 || units[i].line !== units[i-1].line;

    function normalizeGenerated(strings) {
      if (!Array.isArray(strings) || strings.length !== units.length) throw Error('The translation is incomplete.');
      const lines = strings.slice();
      let firstError;
      for (const [i, unit] of units.entries()) {
        if (lines[i] === unit.text) continue;
        try {
          lines[i] = generatedText(lines[i], unit, atStart(i));
          encodedText(lines[i], unit, atStart(i));
        } catch (error) {
          if (!firstError) firstError = error;
          if (typeof lines[i] !== 'string') lines[i] = '';
        }
      }
      if (firstError) throw Object.assign(firstError, {reviewLines:lines});
      return lines;
    }

    function render(strings) {
      if (!Array.isArray(strings) || strings.length !== units.length) throw Error('The translation is incomplete.');
      const result = [], outputSpans = [];
      let cursor = 0, delta = 0;
      for (let i = 0; i < units.length; i++) {
        const span = spans[i], unit = units[i];
        const replacement = strings[i] === unit.text ? span.raw : encodedText(inputText(strings[i], unit), unit, atStart(i));
        const start = span.start + delta;
        outputSpans.push({start, end:start + replacement.length});
        delta += replacement.length - span.raw.length;
        result.push(decodedText.slice(cursor, span.start), replacement);
        cursor = span.end;
      }
      result.push(decodedText.slice(cursor));
      const output = result.join('');
      const outputLayout = inspect(srt.parse(output), null, outputSpans);
      if (outputLayout !== originalLayout) {
        // Header/body entries alternate in the signatures. Locate the first damaged
        // cue only on failure so valid downloads do not pay for per-cue comparisons.
        const before = JSON.parse(originalLayout), after = JSON.parse(outputLayout);
        const mismatch = before.findIndex((value, i) => JSON.stringify(value) !== JSON.stringify(after[i]));
        const part = mismatch < 0 ? before.length - 1 : mismatch;
        const cue = cues[Math.min(Math.floor(part / 2), cues.length - 1)];
        const error = Object.assign(Error('The translation would change subtitle formatting in cue ' + cue.number + '. No file was exported.'), {cueNumber:cue.number});
        if (part % 2 === 1 && Array.isArray(after[part])) {
          const line = before[part].findIndex((value, i) => JSON.stringify(value) !== JSON.stringify(after[part][i]));
          const changed = (cue.lines[line] || []).filter(f => f.unitId !== null && strings[f.unitId] !== f.text);
          if (changed.length === 1) error.unitId = changed[0].unitId;
        }
        throw error;
      }
      return output;
    }
    return {units, cues, normalizeGenerated, render,
      cueCount:parsed.cues.length, sample:samples.join(' ').slice(0, 1800)};
  }

  const api = {prepare};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.CueTranslationSrt = api;
})();
