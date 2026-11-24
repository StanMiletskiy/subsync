// Optional real-container integration check. Run with Node and FFmpeg/FFprobe on PATH.
// Set FFMPEG and FFPROBE to absolute executable paths when they are installed elsewhere.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatTime, parse } = require('../studio/srt.js');
const { align } = require('../studio/align.js');
const directory = mkdtempSync(join(tmpdir(), 'subtitle-media-fixtures-'));
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
const sampleRate = 16000;
const duration = 200;
const pcm = Buffer.alloc(sampleRate * duration * 2);
const dialogue = [
  ['I left it by the door.', 'Я оставил это у двери.'], ['What time is it?', 'Который час?'],
  ['Can you see the river?', '你看得见河吗？'], ['I see two lights.', 'أرى ضوءين.'],
];
const cues = [];
let state = 2417;
function random() {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 2 ** 32;
}
for (let start = 6200; start < 190000;) {
  const end = start + Math.round(450 + random() * 2200);
  const pitch = 150 + random() * 110;
  for (let n = start * 16; n < end * 16; n++) {
    const time = (n - start * 16) / sampleRate;
    const phase = 2 * Math.PI * time * pitch;
    const syllable = Math.min(1, time * 70) * (0.69 + 0.31 * Math.sin(time * 21));
    pcm.writeInt16LE(Math.round((Math.sin(phase) + 0.4 * Math.sin(3 * phase)) * syllable * 7600), n * 2);
  }
  cues.push({start, end});
  start = end + Math.round(850 + random() * 5100);
}
function makeSrt(column, offset) {
  return cues.map(({start,end}, i) => [
    String(i + 1), formatTime(start + offset) + ' --> ' + formatTime(end + offset), dialogue[i % dialogue.length][column], '',
  ].join('\n')).join('\n');
}
writeFileSync(join(directory, 'reference.s16le'), pcm);
writeFileSync(join(directory, 'reference.en.srt'), makeSrt(0, 0));
writeFileSync(join(directory, 'reference.mixed.srt'), makeSrt(1, 0));
writeFileSync(join(directory, 'early.mixed.srt'), makeSrt(1, -4000));
const early = parse(makeSrt(1, -4000));
for (const ext of ['mp4', 'mkv']) {
  const filename = 'reference.' + ext;
  const subtitleCodec = ext === 'mp4' ? 'mov_text' : 'srt';
  const audioCodec = ext === 'mp4' ? 'aac' : 'libopus';
  execFileSync(ffmpeg, [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:size=128x72:rate=1:duration=' + duration,
    '-f', 's16le', '-ac', '1', '-ar', String(sampleRate), '-i', 'reference.s16le',
    '-i', 'reference.en.srt', '-i', 'reference.mixed.srt', '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s',
    '-c:v', 'mpeg4', '-c:a', audioCodec, '-b:a', '24k', '-c:s', subtitleCodec,
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=mul', filename,
  ], {cwd: directory});
  const expected = JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-select_streams', 's:0', '-show_entries', 'packet=pts_time,duration_time,size', '-of', 'json', filename,
  ], {cwd: directory})).packets.filter(packet => Number(packet.size) > 2).map(packet => {
    const start = Math.round(1000 * Number(packet.pts_time));
    return { start, end: start + Math.round(1000 * Number(packet.duration_time)) };
  });
  assert.deepEqual(expected, cues);
  const api = require('../studio/' + ext + '.js');
  const file = new Blob([readFileSync(join(directory, filename))]);
  const tracks = (await api.listTracks(file)).filter(t => t.kind !== 'audio');
  assert.equal(tracks.length, 2);
  for (const [i, track] of tracks.entries()) {
    const extracted = await api.readCues(file, track.id);
    assert.deepEqual(extracted, cues.map((cue, ix) => ({...cue, text: dialogue[ix % dialogue.length][i]})));
    const result = align(early.cues, extracted);
    assert.equal(result.reliable, true);
    assert.equal(result.scale, 1);
    assert.equal(result.offsetMs, 4000);
  }
  console.log(filename, tracks.length, 'subtitle tracks matched at +4.000 seconds');
}
console.log('Generated browser-test fixtures in', directory);
