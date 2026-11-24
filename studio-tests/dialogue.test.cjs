/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const {align, mapTime} = require('../studio/align');
const {parse, render, formatTime} = require('../studio/srt');

function tracks() {
  let start = 5000;
  const source = [], reference = [];
  for (let i = 0; i < 80; i++) {
    const end = start + 800 + (i * 303) % 950;
    const people = ['Anna', 'Daria', 'Vera', 'Eva', 'Sofia', 'Mila', 'Nora', 'Sam', 'Ben'];
    const places = ['the park', 'school', 'the café', 'the river', 'the pier', 'home', 'the woods', 'town', 'the lake'];
    const text = i % 9 === 3 ? 'Yes.' : people[i % 9] + ' is meeting us at ' + places[Math.floor(i / 9)] + '.';
    source.push({start, end, text});
    // Independent in/out edits deliberately cannot be corrected by one linear fit.
    reference.push({start: start + 2000 + i * 17, end: end + 2200 + i * 13, text});
    start = end + 800 + (i * 47) % 1200;
  }
  return {source, reference};
}

function serialized(cues) {
  return cues.map((c, i) => (i + 40) + '\r\n' + formatTime(c.start) + ' --> ' +
    formatTime(c.end) + ' position:1\r\n' + c.text).join('\r\n\r\n');
}

test('recognizes a revised subtitle, including bracketed repeat replies and markup, in either direction', () => {
  const {source, reference} = tracks();
  source[29].text = '<i>Voici la première\r\nréplique !</i>';
  reference[29].text = 'Voici la première réplique.';
  source[42].text = '這是故事裡的一段對話';
  reference[42].text = '這是故事裡的一段對話。';
  source[52].text = 'Could you change that one word please?';
  reference[52].text = 'Could you change this one word please?';
  for (const [input, ref] of [[source, reference], [reference, source]]) {
    const parsed = parse(serialized(input));
    const fit = align(parsed.cues, ref);
    assert.equal(fit.matchedLines, input.length);
    assert.equal(fit.exactTimings, true);
    assert.equal(fit.score, 1);
    const output = render(parsed, t => mapTime(fit, t));
    assert.equal(output, serialized(input.map((c, i) => ({...c, start:ref[i].start, end:ref[i].end}))));
  }
});

test('keeps an unmatched rewritten line between its neighbors, without adopting unrelated reference wording or timing', () => {
  const {source, reference} = tracks();
  source[38].text = 'Please wait near the entrance.';
  reference[38] = {...reference[38], start: reference[38].start + 500, text:'[A phone rings]'};
  const fit = align(source, reference);
  assert.equal(fit.matchedLines, source.length - 1);
  assert.equal(fit.exactTimings, false);
  assert.ok(fit.score < 1);
  const start = mapTime(fit, source[38].start), end = mapTime(fit, source[38].end);
  assert.ok(start > reference[37].end && end > start && end < reference[39].start);
  assert.ok(Math.abs(start - reference[38].start) > 300);
});

test('retains a source-only cue, a reference-only sound caption and a leading source title', () => {
  const {source, reference} = tracks();
  reference.splice(43, 1);
  reference.splice(55, 0, {start:reference[54].end + 10, end:reference[55].start - 10, text:'[Bell]'});
  source.unshift({start:200, end:1200, text:'Opening credit'});
  const fit = align(source, reference);
  assert.equal(fit.reliable, true);
  assert.equal(fit.matchedLines, source.length - 2);
  assert.equal(mapTime(fit, source[0].start), 2200);
  assert.ok(mapTime(fit, source[44].start) > reference[42].end);
  assert.ok(mapTime(fit, source[44].end) < reference[43].start);
});

test('falls back on sparse, conflicting or repeated-only dialogue and uncorroborated scene changes', () => {
  const {source, reference} = tracks();
  const clone = () => reference.map(c => ({...c}));
  const sparse = clone().map((c,i) => i % 3 ? {...c, text:'Другая речь.'} : c);
  const repeats = a => a.map(c => ({...c,text:'No.'}));
  const reordered = clone();
  [reordered[18].text, reordered[21].text] = [reordered[21].text, reordered[18].text];
  const longGap = clone();
  for (let i = 30; i < 39; i++) longGap[i].text = 'Completely new passage.';
  const partial = clone();
  partial.splice(0, 10);
  const doubled = reference.concat(reference.map(c => ({...c,start:c.start+300000,end:c.end+300000})));
  const conflict = clone();
  conflict[15].end = conflict[16].start + 30;
  for (const [a, b] of [[source,sparse], [repeats(source),repeats(reference)], [source,reordered],
    [source,longGap], [source,partial], [source,doubled], [source,conflict],
    [source,reference.map(({start,end})=>({start,end}))]]) {
    assert.equal(align(a, b).dialoguePoints, undefined);
  }
});

test('distinguishes dialogue written with different combining vowels and tone marks', () => {
  const devanagari = ['कल','काल','किल','कील','कुल','कूल','केल','कैल','कोल','कौल'];
  const thai = ['มา','ม่า','ม้า','ม๊า','ม๋า'];
  const words = [...devanagari, ...thai];
  const {source, reference} = tracks();
  const a = source.slice(0, words.length).map((c, i) => ({...c,text:words[i]}));
  const b = reference.slice(0, words.length).map((c, i) => ({...c,text:words[i]}));
  assert.equal(align(a, b).matchedLines, words.length);
  assert.equal(align(a, b).exactTimings, true);
});
