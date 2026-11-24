/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const {readWavActivity} = require('../studio/audio.js');

function chunk(tag, data) {
  const c = Buffer.alloc(8 + data.length + (data.length % 2));
  c.write(tag);
  c.writeUInt32LE(data.length, 4);
  data.copy(c, 8);
  return c;
}

function wav({rate = 16000, channels = 1, bits = 16, encoding = 1, ext = false, seconds = 6, sample, chunks = [], mask = 0, rf64 = false} = {}) {
  const frames = Math.round(rate * seconds);
  const stride = channels * bits / 8;
  const fmt = Buffer.alloc(ext ? 40 : 16);
  fmt.writeUInt16LE(ext ? 0xfffe : encoding);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * stride, 8);
  fmt.writeUInt16LE(stride, 12);
  fmt.writeUInt16LE(bits, 14);
  if (ext) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(bits, 18);
    fmt.writeUInt32LE(mask, 20);
    fmt.writeUInt32LE(encoding, 24);
    Buffer.from([0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]).copy(fmt, 28);
  }
  const data = Buffer.alloc(stride * frames);
  for (let n = 0; n < frames; n++) {
    for (let ch = 0; ch < channels; ch++) {
      const x = sample ? sample(n / rate, ch) : 0;
      const pos = n * stride + ch * bits / 8;
      if (encoding === 3 && bits === 32) data.writeFloatLE(x, pos);
      else if (encoding === 3 && bits === 64) data.writeDoubleLE(x, pos);
      else if (bits === 8) data[pos] = Math.round(x * 127 + 128);
      else data.writeIntLE(Math.round(x * (2 ** (bits - 1) - 1)), pos, bits / 8);
    }
  }
  const dataChunk = chunk('data', data);
  const prefix = [chunk('fmt ', fmt), ...chunks, dataChunk];
  const size = prefix.reduce((n, c) => n + c.length, 4) + (rf64 ? 36 : 0);
  const header = Buffer.alloc(12);
  header.write(rf64 ? 'RF64' : 'RIFF');
  header.writeUInt32LE(rf64 ? 0xffffffff : size, 4);
  header.write('WAVE', 8);
  if (rf64) {
    const ds = Buffer.alloc(28);
    ds.writeBigUInt64LE(BigInt(size));
    ds.writeBigUInt64LE(BigInt(data.length), 8);
    dataChunk.writeUInt32LE(0xffffffff, 4);
    prefix.unshift(chunk('ds64', ds));
  }
  return new Blob([header, ...prefix]);
}

const burst = t => t >= 1 && t < 3 ? 0.45 * Math.sin(t * 2 * Math.PI * 800) : 0;

test('detects a band-limited voice-like burst and keeps the WAV timeline', async () => {
  const input = wav({rate: 11025, seconds: 6.039, sample: burst, chunks: [chunk('JUNK', Buffer.from('abc'))]});
  const {activity, stepMs} = await readWavActivity(input);
  assert.equal(stepMs, 100);
  assert.equal(activity.length, 61);
  assert.ok(activity.slice(11, 29).every(x => x > 0.9));
  assert.ok(activity.slice(34).every(x => x === 0));
});

test('suppresses low-frequency rumble at the same amplitude as speech-band energy', async () => {
  const {activity} = await readWavActivity(wav({sample: t => t < 1 ? 0.45 * Math.sin(2 * Math.PI * 32 * t) : burst(t)}));
  assert.ok(activity[5] < 0.03);
  assert.ok(activity[15] > 0.9);
});

test('reads PCM8/16/24/32, float32/64, extensible centre audio, RF64 and stereo with opposite phase', async () => {
  for (const options of [{bits: 8}, {bits: 16}, {bits: 24}, {bits: 32}, {encoding: 3, bits: 32}, {encoding: 3, bits: 64}, {rf64: true}]) {
    const {activity} = await readWavActivity(wav({...options, sample: burst}));
    assert.ok(activity[20] > 0.9, JSON.stringify(options));
  }
  const centre = await readWavActivity(wav({ext: true, mask: 0x3f, channels: 6, sample: (t, ch) => ch === 2 ? burst(t) : 0}));
  assert.ok(centre.activity[19] > 0.9);
  const opposite = await readWavActivity(wav({channels: 2, sample: (t, ch) => (ch ? -1 : 1) * burst(t)}));
  assert.ok(opposite.activity[19] > 0.9);
});

test('reads in bounded slices, skips embedded art and reports increasing progress', async () => {
  const input = wav({seconds: 85, chunks: [chunk('JUNK', Buffer.alloc(1300000))]});
  const sizes = [];
  const progress = [];
  const traced = {
    size: input.size,
    slice(from, to) { sizes.push(to - from); return input.slice(from, to); }
  };
  const {activity} = await readWavActivity(traced, {onProgress: p => progress.push(p)});
  assert.equal(Math.max(...sizes), 1024 * 1024);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
  assert.ok(progress.length >= 4);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  assert.equal(activity.length, 850);
  assert.ok(activity.every(x => x === 0));
});

test('rejects invalid/truncated files and supports mid-run cancellation', async () => {
  await assert.rejects(readWavActivity(new Blob(['fake'])), /PCM WAV/);
  const valid = wav();
  await assert.rejects(readWavActivity(valid.slice(0, valid.size - 4)), /incomplete/);
  await assert.rejects(readWavActivity(wav({encoding: 6})), /PCM WAV/);
  const ctrl = new AbortController();
  await assert.rejects(readWavActivity(valid, {signal: ctrl.signal, onProgress: () => ctrl.abort()}), {name: 'AbortError'});
});
