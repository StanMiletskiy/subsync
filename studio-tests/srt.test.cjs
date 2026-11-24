const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, render, decode, anchors, formatTime, parseTime } = require('../studio/srt.js');

const sample = '\uFEFF\r\n007\n 0:00:04.3\t-->   00:00:05,040 X1:32 X2:145\r\n- <i>Привет!</i>\n- 你好！\r\n \t\r\n99\r00:00:10,000-->00:00:12,000\r\u200fمرحبًا \u200f\r';

test('timestamp substitution preserves indices, ASS/HTML, cue options, BOM, whitespace and mixed newlines', () => {
  const p = parse(sample);
  assert.equal(p.cues.length, 2);
  assert.deepEqual(p.cues.slice(0, 1).map(c => [c.start, c.end, c.text]), [[4300, 5040, '- <i>Привет!</i>\n- 你好！']]);
  assert.equal(render(p, x => x), sample);
  assert.equal(render(p, x => x + 20), sample.replace('04.3', '04.32').replace('05,040', '05,060').replace('10,000', '10,020').replace('12,000', '12,020'));
});

test('supports missing cue IDs, meaningful digits in text and no final newline', () => {
  const s = '\uFEFF00:00:01,000 --> 00:00:03,000\n111\n{\\an8}12:00 --> 13:00';
  assert.equal(render(parse(s), x => x + 3000), s.replace('01,000', '04,000').replace('03,000', '06,000'));
});

test('malformed and collapsed cues are identified, not silently lost', () => {
  assert.throws(() => parse('123\n00:60:00,000 --> 00:61:00,000\nfoo'), /below 60/);
  assert.throws(() => parse('123\n00:01:00,000 --> 00:00:04,000\nfoo'), /end after/);
  assert.throws(() => parse('junk'), /Invalid SRT/);
  assert.throws(() => parse(''), /No subtitle/);
  assert.throws(() => parse('1\n00:00:00,000 --> 00:00:01,000\na\n2\n00:00:02,000 --> 00:00:03,000\nb'), /Missing blank line/);
  assert.throws(() => render(parse(sample), x => x - 5000), /Cue 1 would start before/);
  assert.throws(() => render(parse(sample), () => 20), /zero or negative duration/);
  assert.throws(() => render(parse(sample), () => NaN), /invalid corrected time/);
});

test('manual time entries support plain seconds, minute clock and full stamps', () => {
  for (const stamp of ['01:02:03,456', '62:03.456', '3723.456']) assert.equal(parseTime(stamp), 3723456);
  assert.equal(parseTime('00:00:01,1'), 1100);
  assert.equal(formatTime(3599999.7), '01:00:00,000');
  assert.equal(formatTime(parseTime('112:15:44,000')), '112:15:44,000');
  for (const invalid of ['', '-2', '.5', '1:60', '1::30', '2:67:00', 'hello', '3.1250']) assert.throws(() => parseTime(invalid));
});

test('single anchor shifts; several anchors interpolate and extrapolate with local drift', () => {
  assert.equal(anchors([{ source: 8000, target: 2000 }])(7000), 1000);
  const map = anchors([{ source: 2000, target: 4000 }, { source: 4000, target: 6100 }, { source: 6000, target: 10100 }]);
  assert.equal(map(0), 1900);
  assert.equal(map(2000), 4000);
  assert.equal(map(3000), 5050);
  assert.equal(map(5000), 8100);
  assert.equal(map(7000), 12100);
  assert.throws(() => anchors([{ source: 1, target: 1 }, { source: 1, target: 1000 }]), /increasing order/);
  assert.throws(() => anchors([{ source: 1, target: 2 }, { source: 2, target: 1 }]), /increasing order/);
  assert.throws(() => anchors([]), /at least one/);
});

test('decoder keeps UTF BOM, accepts UTF-16BE/LE and deliberately selected legacy languages', () => {
  assert.equal(decode(new TextEncoder().encode(sample)), sample);
  assert.equal(decode(Buffer.from('\uFEFF\u200fمرحبا 你好 한국어', 'utf16le')), '\uFEFF\u200fمرحبا 你好 한국어');
  assert.equal(decode(Uint8Array.of(0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d)), '\uFEFF你好');
  assert.equal(decode(Uint8Array.of(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2), 'windows-1251'), 'Привет');
  assert.equal(decode(Uint8Array.of(0x63, 0x61, 0x66, 0xe9), 'windows-1252'), 'café');
  assert.throws(() => decode(Uint8Array.of(0xcf, 0xf0, 0xe8)), /Choose the file’s text encoding/);
  assert.throws(() => decode(Uint8Array.of(0x31, 0, 0x2e, 0)), /NUL characters/);
  const view = new Uint8Array([0, 65, 66, 0]).subarray(1, 3);
  assert.equal(decode(view), 'AB');
});

test('automatic mapping fits a whole pre-zero title block while keeping source spacing and corrected dialogue', () => {
  const {fitOpening} = require('../studio/srt.js');
  const p = parse('17\n00:00:00,000 --> 00:00:00,450\nOpening\n\n18\n00:00:00,620 --> 00:00:01,200\n第二句\n\n20\n00:00:12,000 --> 00:00:13,000\nDialogue');
  const correction = time => time * 1.001 - 9000;
  const map = fitOpening(p.cues, correction);
  const output = parse(render(p, map));
  assert.deepEqual(output.cues.map(c => [c.start,c.end,c.text]),
    [[0,450,'Opening'],[620,1200,'第二句'],[3012,4013,'Dialogue']]);
  for (let i = 0; i < p.cues.length; i++) {
    const {start,end} = p.cues[i];
    assert.deepEqual([Math.round(map(start)),Math.round(map(end))],[output.cues[i].start,output.cues[i].end]);
  }
  assert.throws(() => render(p, correction), /Cue 1 would start before/); // Manual correction stays strict.
});

test('automatic mapping trims only the part of a crossing cue that is before time zero', () => {
  const {fitOpening} = require('../studio/srt.js');
  const shift = time => time - 9000;
  const cues = [{start:8000,end:9500}, {start:12000,end:14500}];
  const map = fitOpening(cues,shift);
  assert.deepEqual(cues.map(c=>[map(c.start),map(c.end)]),[[0,500],[3000,5500]]);
  assert.equal(fitOpening(cues.slice(1),shift),shift);
});

test('automatic mapping refuses to move titles without enough empty opening time', () => {
  const {fitOpening} = require('../studio/srt.js');
  const shift = time => time - 9000;
  const title = {start:0,end:1200};
  assert.equal(fitOpening([title,{start:9500,end:12000}],shift),shift);
  assert.equal(fitOpening([title,{start:8900,end:11000}],shift),shift);
  assert.equal(fitOpening([title],shift),shift);
  const touching = fitOpening([title,{start:10200,end:12200}],shift);
  assert.equal(touching(title.end),1200);
  assert.equal(touching(10200),1200);
});
