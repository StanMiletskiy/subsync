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

  function readable(text) {
    return text.replace(/&(amp|lt|gt|quot|apos);/gi, (_, name) => entities[name.toLowerCase()]);
  }

  function safeText(value, cue) {
    if (typeof value !== 'string' || !value.trim()) throw Error('No translation was returned for cue ' + cue + '.');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
        /(?:^|[\r\n])[ \t]*\d+:[\d:.,]+[ \t]*-->/.test(value) || /\{\\|\\[Nnh]/.test(value)) {
      throw Error('The translation for cue ' + cue + ' contains subtitle controls.');
    }
    return value.trim().replace(/\s+/gu, ' ')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inspect(parsed, addUnit) {
    let cursor = 0;
    const layout = [];
    for (const [index, cue] of parsed.cues.entries()) {
      // This includes the preceding separator, identifier, timing tokens and settings.
      layout.push(parsed.text.slice(cursor, cue.bodyStart));
      const cueLayout = [];
      const lines = /([^\r\n]*)(\r\n|[\r\n]|$)/g;
      for (const row of cue.text.matchAll(lines)) {
        if (!row[0]) continue;
        const line = row[1], base = cue.bodyStart + row.index;
        const marks = [];
        let from = 0;
        for (const token of line.matchAll(controls)) {
          if (addUnit) addUnit(line.slice(from, token.index), base + from, index + 1);
          marks.push(token[0]);
          from = token.index + token[0].length;
        }
        if (addUnit) addUnit(line.slice(from), base + from, index + 1);
        cueLayout.push([row[2], /^\s*/u.exec(line)[0], /\s*$/u.exec(line)[0], marks]);
      }
      layout.push(cueLayout);
      cursor = cue.bodyEnd;
    }
    layout.push(parsed.text.slice(cursor));
    return JSON.stringify(layout);
  }

  function prepare(decodedText) {
    const parsed = srt.parse(decodedText);
    const units = [], spans = [];
    const originalLayout = inspect(parsed, (text, offset, cue) => {
      const raw = text.trim();
      if (!/\p{L}/u.test(raw)) return;
      const start = offset + text.length - text.trimStart().length;
      units.push({id:units.length, cue, text:readable(raw)});
      spans.push({start, end:start + raw.length, raw});
    });
    // Sample across the file since a title card or a credit may use a different language.
    const samples = [], count = Math.min(units.length, 24);
    for (let i = 0; i < count; i++) samples.push(units[Math.floor((i + 0.5) * units.length / count)].text);

    function render(strings) {
      if (!Array.isArray(strings) || strings.length !== units.length) throw Error('The translation is incomplete.');
      const result = [];
      let cursor = 0;
      for (let i = 0; i < units.length; i++) {
        const span = spans[i], unit = units[i];
        const replacement = strings[i] === unit.text ? span.raw : safeText(strings[i], unit.cue);
        result.push(decodedText.slice(cursor, span.start), replacement);
        cursor = span.end;
      }
      result.push(decodedText.slice(cursor));
      const output = result.join('');
      if (inspect(srt.parse(output)) !== originalLayout) {
        throw Error('The translation would change subtitle formatting. No file was exported.');
      }
      return output;
    }
    return {units, render, cueCount:parsed.cues.length, sample:samples.join(' ').slice(0, 1800)};
  }

  const api = {prepare};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.CueTranslationSrt = api;
})();
