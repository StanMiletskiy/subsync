// Retiming edits spans in the original text. Dialogue and cue metadata never pass through a serializer.
(function () {
  'use strict';

  const stamp = '(\\d+:\\d{2}:\\d{2}[,.]\\d{1,3})';
  const timingLine = new RegExp('^([ \\t]*)' + stamp + '([ \\t]*-->[ \\t]*)' + stamp + '(?:[ \\t].*)?$');

  function decode(buffer, encoding = 'auto') {
    const bytes = ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
    const auto = !encoding || encoding.trim().toLowerCase() === 'auto';
    if (auto) {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
      else encoding = 'utf-8';
    }
    let decoded;
    try {
      decoded = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      if (auto) throw new Error('Choose the file’s text encoding. It is not valid UTF-8 and has no usable Unicode encoding signature.');
      throw new Error('Cannot decode this file with the selected encoding (' + encoding + '). Choose the encoding used by this subtitle.');
    }
    if (decoded.includes('\0')) {
      throw new Error('Unexpected NUL characters. Choose the file’s text encoding, such as UTF-16LE, or select a text subtitle.');
    }
    return decoded;
  }

  // Short inputs are convenient when entering anchors, e.g. "83.4" or "1:23,4".
  function parseTime(value) {
    const input = String(value).trim();
    const parts = input.replace(',', '.').split(':');
    if (parts.length > 3 || !/^\d+(?:\.\d{1,3})?$/.test(parts[parts.length - 1])
      || parts.slice(0, -1).some(part => !/^\d+$/.test(part))) {
      throw new Error('Enter a time such as 00:02:34,550, 2:34.55, or 154.55.');
    }
    const [seconds, fraction = ''] = parts.pop().split('.');
    if (parts.length && Number(seconds) >= 60 || parts.length === 2 && Number(parts[1]) >= 60) {
      throw new Error('Minutes and seconds in a clock time must be below 60.');
    }
    const whole = parts.reduce((sum, part) => sum * 60 + Number(part), 0) * 60 + Number(seconds);
    const ms = whole * 1000 + Number(fraction.padEnd(3, '0'));
    if (!Number.isSafeInteger(ms)) throw new Error('Time is outside the supported range.');
    return ms;
  }

  function clockFields(ms) {
    const time = Math.round(ms);
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('A subtitle time must be finite and nonnegative.');
    return [
      String(Math.floor(time / 3600000)),
      String(Math.floor(time / 60000) % 60).padStart(2, '0'),
      String(Math.floor(time / 1000) % 60).padStart(2, '0'),
      String(time % 1000).padStart(3, '0'),
    ];
  }

  function formatTime(ms) {
    const [hours, minutes, seconds, fraction] = clockFields(ms);
    return hours.padStart(2, '0') + ':' + minutes + ':' + seconds + ',' + fraction;
  }

  function formatLike(ms, original) {
    const [hours, minutes, seconds, fraction] = clockFields(ms);
    const delimiter = original.includes(',') ? ',' : '.';
    const precision = Math.max(original.split(delimiter)[1].length, fraction.replace(/0+$/, '').length);
    return hours.padStart(original.indexOf(':'), '0') + ':' + minutes + ':' + seconds + delimiter + fraction.slice(0, precision);
  }

  function parse(text) {
    if (typeof text !== 'string') throw new Error('Select an SRT text file.');
    const cues = [];
    let block = [];
    function readBlock() {
      if (!block.length) return;
      let row = 0;
      let tokens = timingLine.exec(block[0].line);
      if (!tokens && block.length > 1) {
        row = 1;
        tokens = timingLine.exec(block[row].line);
      }
      if (!tokens) throw new Error('Invalid SRT timing near line ' + block[0].number + '. Expected 00:00:01,000 --> 00:00:02,000.');
      const timing = block[row];
      const start = parseTime(tokens[2]);
      const end = parseTime(tokens[4]);
      if (end <= start) throw new Error('The subtitle at line ' + timing.number + ' must end after it starts.');
      const body = block.slice(row + 1);
      for (let i = 1; i < body.length; i++) {
        if (/^\s*\d+\s*$/.test(body[i - 1].line) && timingLine.test(body[i].line)) {
          throw new Error('Missing blank line before the cue at line ' + body[i].number + '.');
        }
      }
      const startAt = timing.at + tokens[1].length;
      const endAt = startAt + tokens[2].length + tokens[3].length;
      const last = block[block.length - 1];
      cues.push({
        start, end,
        text: body.length ? text.slice(body[0].at, last.at + last.line.length) : '',
        startAt, endAt, startToken: tokens[2], endToken: tokens[4],
      });
      block = [];
    }
    // Starting after a Unicode BOM keeps its original location, including on an index-less first cue.
    const lines = /([^\r\n]*)(?:\r\n|\r|\n|$)/g;
    lines.lastIndex = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    let number = 0;
    let line;
    while ((line = lines.exec(text)) && line[0].length) {
      number++;
      if (/^[ \t]*$/.test(line[1])) readBlock();
      else block.push({ line: line[1], at: line.index, number });
    }
    readBlock();
    if (!cues.length) throw new Error('No subtitle cues found. Select an SRT file.');
    return { text, cues };
  }

  // A source-only opening title can fall entirely before zero after a valid automatic
  // correction. Relocate the opening block only when its full original span fits.
  function fitOpening(cues, map) {
    let firstTitle = Infinity, lastTitle = -Infinity;
    let nextSource = Infinity, nextStart = Infinity, crossesZero = false;
    for (const cue of cues) {
      const start = Math.round(map(cue.start)), end = Math.round(map(cue.end));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return map;
      if (end <= 0) {
        firstTitle = Math.min(firstTitle, cue.start);
        lastTitle = Math.max(lastTitle, cue.end);
      } else if (start < 0) {
        crossesZero = true;
      } else {
        nextStart = Math.min(nextStart, start);
        nextSource = Math.min(nextSource, cue.start);
      }
    }
    if (lastTitle === -Infinity) return crossesZero ? time => Math.max(0, map(time)) : map;
    // A cue crossing zero already occupies the opening. An absent or earlier source
    // neighbour also means there is no verified empty interval for this block.
    if (crossesZero || !Number.isFinite(nextStart) || lastTitle >= nextSource ||
        lastTitle - firstTitle > nextStart) return map;
    return time => time >= firstTitle && time <= lastTitle ? time - firstTitle : map(time);
  }

  function render(parsed, map) {
    const chunks = [];
    let cursor = 0;
    for (const [i, cue] of parsed.cues.entries()) {
      const start = Math.round(map(cue.start));
      const end = Math.round(map(cue.end));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        throw new Error('Cue ' + (i + 1) + ' has an invalid corrected time. Check the timing correction.');
      }
      if (start < 0) {
        throw new Error('Cue ' + (i + 1) + ' would start before 00:00:00,000. Adjust the correction or edit that cue before exporting.');
      }
      if (end <= start) throw new Error('Cue ' + (i + 1) + ' would have zero or negative duration. Adjust the correction before exporting.');
      chunks.push(parsed.text.slice(cursor, cue.startAt), formatLike(start, cue.startToken),
        parsed.text.slice(cue.startAt + cue.startToken.length, cue.endAt), formatLike(end, cue.endToken));
      cursor = cue.endAt + cue.endToken.length;
    }
    chunks.push(parsed.text.slice(cursor));
    return chunks.join('');
  }

  function anchors(points) {
    if (!Array.isArray(points) || !points.length) throw new Error('Add at least one pair of matching times.');
    const pairs = points.map(({ source, target }, i) => {
      if (![source, target].every(value => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error('Anchor ' + (i + 1) + ' needs two nonnegative times.');
      }
      return { source, target };
    });
    for (let i = 1; i < pairs.length; i++) {
      if (pairs[i].source <= pairs[i - 1].source || pairs[i].target <= pairs[i - 1].target) {
        throw new Error('Add anchors in increasing order in both timelines. Check anchor ' + (i + 1) + '.');
      }
    }
    if (pairs.length === 1) {
      const shift = pairs[0].target - pairs[0].source;
      return time => time + shift;
    }
    return time => {
      // Use the nearest segment outside the anchor range so drift continues through the end credits.
      let left = 0, right = pairs.length - 1;
      while (right - left > 1) {
        const middle = Math.floor((left + right) / 2);
        if (time < pairs[middle].source) right = middle;
        else left = middle;
      }
      const a = pairs[left], b = pairs[right];
      return a.target + (time - a.source) * (b.target - a.target) / (b.source - a.source);
    };
  }

  const api = { decode, parse, parseTime, formatTime, render, anchors, fitOpening };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.SyncSrt = api;
})();
