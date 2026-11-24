/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../studio/movie-audio.js');

function nativeMocks(t, {supported = true, stall = false, failAt = -1} = {}) {
  const stats = {peak: 0, decoded: 0, closed: 0, framesClosed: 0, flushed: 0};
  const oldDecoder = global.AudioDecoder;
  const oldChunk = global.EncodedAudioChunk;
  class MockDecoder extends EventTarget {
    state = 'unconfigured';
    decodeQueueSize = 0;
    queue = [];
    scheduled = false;
    static async isConfigSupported(config) { return {supported, config}; }
    constructor(cbs) { super(); this.cbs = cbs; }
    configure(config) { this.state = 'configured'; this.config = config; }
    decode(packet) {
      assert.equal(this.state, 'configured');
      this.queue.push(packet);
      stats.peak = Math.max(stats.peak, ++this.decodeQueueSize);
      if (!stall && !this.scheduled) {
        this.scheduled = true;
        setImmediate(() => this.drain());
      }
    }
    drain() {
      this.scheduled = false;
      if (this.state === 'closed') return;
      while (this.queue.length) {
        const packet = this.queue.shift();
        this.decodeQueueSize--;
        if (++stats.decoded === failAt) { this.cbs.error(new Error('invalid payload')); break; }
        const frames = Math.round(packet.duration * this.config.sampleRate / 1e6);
        this.cbs.output({
          numberOfFrames: frames, numberOfChannels: this.config.numberOfChannels, sampleRate: this.config.sampleRate, timestamp: packet.timestamp,
          copyTo(target, {planeIndex, format}) {
            assert.equal(format, 'f32-planar');
            for (let i = 0; i < frames; i++) target[i] = packet.data[0] && planeIndex === packet.data[1] ? 0.5 * Math.sin(i * 0.4) : 0;
          },
          close() { stats.framesClosed++; }
        });
      }
      this.dispatchEvent(new Event('dequeue'));
    }
    async flush() { stats.flushed++; this.drain(); }
    close() { this.state = 'closed'; stats.closed++; }
  }
  global.AudioDecoder = MockDecoder;
  global.EncodedAudioChunk = class { constructor(props) { Object.assign(this, props); } };
  t.after(() => {
    if (oldDecoder === undefined) delete global.AudioDecoder; else global.AudioDecoder = oldDecoder;
    if (oldChunk === undefined) delete global.EncodedAudioChunk; else global.EncodedAudioChunk = oldChunk;
  });
  return stats;
}

function demux(packets, channels = 1) {
  return {
    async readAudioPackets(_file, track, {onConfig, onPacket, onProgress}) {
      assert.equal(track.kind, 'audio');
      await onConfig({codec: 'opus', sampleRate: 48000, numberOfChannels: channels});
      for (let i = 0; i < packets.length; ++i) {
        await onPacket(packets[i]);
        if (onProgress) onProgress((i + 1) / packets.length);
      }
    }
  };
}

const track = {id: 9, kind: 'audio'};
const packet = (timestamp, duration, voice = true, channel = 0) => ({timestamp, duration, data: new Uint8Array([Number(voice), channel])});

test('preserves delayed starts, gaps and centre-channel speech; output is released', async t => {
  const stats = nativeMocks(t);
  const parts = [packet(2e6, 500000, true, 2), packet(2.5e6, 500000, false), packet(5.01e6, 500000, true, 2)];
  const progress = [];
  const {activity, stepMs} = await api.readMovieActivity({}, track, demux(parts, 6), {onProgress: p => progress.push(p)});
  assert.equal(stepMs, 100);
  assert.equal(activity.length, 56);
  assert.ok(activity.slice(0,20).every(x => x === 0));
  assert.ok(activity.slice(20,25).every(x => x > .9));
  assert.ok(activity.slice(31,50).every(x => x === 0));
  assert.ok(activity[52] > .9);
  assert.equal(stats.framesClosed, 3);
  assert.equal(stats.closed, 1);
  assert.equal(progress.at(-1), 1);
});

test('crops negative preroll and trims repeated samples at edit overlaps', async t => {
  nativeMocks(t);
  const parts = [packet(-600000, 300000), packet(-200000, 400000), packet(0, 200000, false), packet(300000, 700000, false)];
  const {activity} = await api.readMovieActivity({}, track, demux(parts));
  assert.equal(activity.length, 10);
  assert.ok(activity[0] > .9 && activity[1] > .9);
  assert.ok(activity.slice(3).every(x => x === 0));
});

test('enforces backpressure without midstream decoder flushes; rounded AAC timestamps remain contiguous', async t => {
  const stats = nativeMocks(t);
  const parts = Array.from({length: 220}, (_, i) => packet(Math.round(i * 1024e3 / 48000) * 1000, 1024e6 / 48000, i >= 50 && i < 100));
  const {activity} = await api.readMovieActivity({}, track, demux(parts));
  assert.equal(stats.flushed, 1);
  assert.equal(stats.peak, 24);
  assert.equal(stats.framesClosed, 220);
  assert.equal(activity.length, Math.ceil(220 * 1024 / 4800));
  assert.ok(activity[12] > .9);
});

test('cancellation during a queue wait closes the decoder and releases the wait', async t => {
  const stats = nativeMocks(t, {stall: true});
  const ctrl = new AbortController();
  const parts = Array.from({length: 31}, (_, i) => packet(i * 20000, 20000));
  setImmediate(() => ctrl.abort());
  await assert.rejects(api.readMovieActivity({}, track, demux(parts), {signal: ctrl.signal}), {name:'AbortError'});
  assert.equal(stats.peak, 24);
  assert.equal(stats.closed, 1);
});

test('codec failures interrupt backpressure with actionable feedback', async t => {
  nativeMocks(t, {failAt: 2});
  const parts = Array.from({length:32}, (_, i) => packet(i * 20000, 20000));
  await assert.rejects(api.readMovieActivity({}, track, demux(parts)), /invalid payload.*PCM WAV/);
});

test('unsupported browser codecs produce a fallback before fetching audio packets', async t => {
  nativeMocks(t, {supported:false});
  await assert.rejects(api.readMovieActivity({}, track, demux([packet(0, 20000)])), /cannot decode opus.*PCM WAV/);
});

test('rejects corrupt timestamps without allocating an unbounded timeline', async t => {
  nativeMocks(t);
  await assert.rejects(api.readMovieActivity({}, track, demux([packet(1e13, 20000)])), /48-hour/);
});

test('MP4 empty edit plus trimmed media crops decoded preroll and the trailing frame', async t => {
  nativeMocks(t);
  const parser = {
    async readAudioPackets(_file, _track, {onConfig, onPacket}) {
      await onConfig({codec: 'mp4a.40.2', sampleRate: 16000, numberOfChannels: 1}, {startUs: 2000000, endUs: 2520000});
      await onPacket(packet(1500000, 600000));
      await onPacket(packet(2100000, 900000));
    }
  };
  const {activity} = await api.readMovieActivity({}, track, parser);
  assert.equal(activity.length, 26);
  assert.ok(activity.slice(0, 20).every(x => x === 0));
  assert.ok(activity.slice(20, 25).every(x => x > .90));
});
