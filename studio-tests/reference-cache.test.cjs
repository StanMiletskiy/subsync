/* SPDX-License-Identifier: GPL-3.0-or-later */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createCache} = require('../studio/reference-cache.js');

const controller = () => new AbortController();
const noProgress = () => {};
const file = () => new File(['bytes'], 'same-name.mkv', {lastModified: 1});

// Run the real classic worker entry with browser message cloning/transfer semantics.
function harness() {
  const reads = {wav: 0, audio: 0, text: 0};
  const requests = [];
  const audio = () => ({activity: new Float32Array([0, 0.75, 0.1]), stepMs: 100});
  async function dispatch(job) {
    requests.push({receivedFile: !!job.file, receivedReference: !!job.reference});
    const demux = {async readCues() { reads.text++; return [{start: 1500, end: 2000, text: 'Dialogue'}]; }};
    let reply;
    const self = {postMessage(data, transfer) {
      if (data.type === 'result') reply = structuredClone(data.value, {transfer});
      if (data.type === 'failure') throw Error(data.message);
    }};
    const scope = vm.createContext({
      self, DOMException,
      SyncAudio: {async readWavActivity() { reads.wav++; return audio(); }},
      SyncMovieAudio: {async readMovieActivity() { reads.audio++; return audio(); }},
      SyncMp4: demux, SyncMkv: demux,
      SyncAlign: {align(cues, ref) {
        return {start: cues[0].start, sample: ref.activity?.[1] ?? ref[0].start};
      }},
    });
    for (const module of ['reference-cache.js', 'app.js']) {
      const src = fs.readFileSync(require.resolve('../studio/' + module), 'utf8');
      vm.runInContext(src, scope);
    }
    await self.onmessage({data: structuredClone(job)});
    return reply;
  }
  return {reads, requests, dispatch};
}

function cues(start) { return [{start, end: start + 400}]; }

test('successive subtitle files reuse transferred WAV activity, while every source is aligned separately', async () => {
  const cache = createCache(), worker = harness();
  const reference = file();
  for (const time of [1000, 5000, 9000]) {
    const job = {kind: 'wav', file: reference, cues: cues(time)};
    const answer = await cache.run(job, noProgress, controller().signal, worker.dispatch);
    assert.deepEqual(answer, {start: time, sample: 0.75});
  }
  assert.equal(worker.reads.wav, 1);
  assert.deepEqual(worker.requests.map(request => request.receivedFile), [true, false, false]);
});

test('changing selected track, track type, or file evicts only the previous reference', async () => {
  const cache = createCache(), worker = harness();
  const first = file(), second = file();
  async function run(reference, kind, id) {
    return cache.run({kind: 'mkv', cues: cues(100), file: reference, track: {kind, id}},
      noProgress, controller().signal, worker.dispatch);
  }
  await run(first, 'audio', 1);
  await run(first, 'audio', 1);
  await run(first, 'audio', 2);
  assert.equal((await run(first, 'text', 2)).sample, 1500);
  await run(first, 'text', 2);
  await run(second, 'text', 2);
  await run(first, 'audio', 1);
  cache.clear();
  await run(first, 'audio', 1);
  assert.deepEqual(worker.reads, {audio: 4, text: 2, wav: 0});
});

test('an aborted, rejected or replaced read cannot populate the cache', async () => {
  const worker = harness(), cache = createCache();
  const job = {kind: 'wav', file: file(), cues: cues(0)};
  let finish;
  const slow = () => new Promise(resolve => { finish = () => resolve({answer: {}, prepared: {activity: [42]}}); });
  const cancellation = controller();
  const pending = cache.run(job, noProgress, cancellation.signal, slow);
  cancellation.abort();
  finish();
  await assert.rejects(pending, {name: 'AbortError'});
  await assert.rejects(cache.run(job, noProgress, controller().signal, async () => {throw Error('read failed');}), /read failed/);
  const old = cache.run(job, noProgress, controller().signal, slow);
  cache.clear();
  const fresh = await cache.run(job, noProgress, controller().signal, worker.dispatch);
  finish();
  await assert.rejects(old, {name: 'AbortError'});
  const hit = await cache.run(job, noProgress, controller().signal, worker.dispatch);
  assert.deepEqual(fresh, hit);
  assert.equal(worker.reads.wav, 1);
  assert.deepEqual(worker.requests.map(request => request.receivedFile), [true, false]);
});
