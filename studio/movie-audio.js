/* Original browser rewrite. SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';

  const audio = root.SyncAudio || (typeof require === 'function' && require('./audio.js'));
  const STEP_US = 100000;
  const MAX_BINS = 48 * 3600 * 10;
  const FALLBACK = 'Select a timed subtitle track or export a mono, 16 kHz PCM WAV from this soundtrack.';

  function available() {
    return typeof root.AudioDecoder === 'function' && typeof root.AudioDecoder.isConfigSupported === 'function' &&
      typeof root.EncodedAudioChunk === 'function';
  }

  function createTimeline() {
    let levels = new Uint8Array(2048);
    let quality = new Uint8Array(2048);
    let meter, rate, length = 0, currentBin = -1, binFrames = 0;
    let nextUs = 0, audibleStart = 0, audibleEnd = Infinity;
    const planes = [];

    function writeBin() {
      if (binFrames) meter.writeBin(levels, quality, currentBin, binFrames);
      binFrames = 0;
    }

    function reserve(bin) {
      if (bin < 0 || bin >= MAX_BINS) throw new Error('Audio timestamps exceed the supported 48-hour movie timeline.');
      if (bin < levels.length) return;
      const capacity = Math.min(MAX_BINS, Math.max(bin + 1, levels.length * 2));
      const nextLevels = new Uint8Array(capacity);
      const nextQuality = new Uint8Array(capacity);
      nextLevels.set(levels);
      nextQuality.set(quality);
      levels = nextLevels;
      quality = nextQuality;
    }

    function setWindow(window) {
      if (!window) return;
      if (!Number.isFinite(window.startUs) || !Number.isFinite(window.endUs) || window.startUs > window.endUs) {
        throw new Error('The movie track contains an invalid edit window.');
      }
      audibleStart = Math.max(0, window.startUs);
      audibleEnd = window.endUs;
    }

    function add(data) {
      const newRate = data.sampleRate;
      const frames = data.numberOfFrames;
      const channels = data.numberOfChannels;
      if (!Number.isFinite(data.timestamp) || !Number.isFinite(newRate) || newRate < 1000 || newRate > 768000 ||
          !Number.isInteger(frames) || frames < 0 || frames > newRate * 10 || !Number.isInteger(channels) || channels < 1) {
        throw new Error('The movie decoder returned an invalid audio frame.');
      }
      if (!frames) return;
      if (rate && newRate !== rate) throw new Error('The audio sample rate changes within this track. ' + FALLBACK);
      if (!meter) {
        rate = newRate;
        meter = audio.createBandMeter(rate);
      }

      // Account for rounded container timestamps. Larger jumps are real gaps or edit preroll.
      let startUs = data.timestamp;
      if (length && Math.abs(startUs - nextUs) <= 1100) startUs = nextUs;
      let pos = Math.max(0, Math.ceil((Math.max(audibleStart, nextUs) - startUs) * rate / 1e6 - 1e-6));
      const limit = Math.min(frames, Math.ceil((audibleEnd - startUs) * rate / 1e6 - 1e-6));
      if (pos >= limit) return;
      if (startUs > nextUs + 1100) meter.resetFilter();
      const used = channels === 1 ? 1 : channels === 3 || channels >= 5 ? 3 : 2;
      for (let ch = 0; ch < used; ch++) {
        if (!planes[ch] || planes[ch].length < frames) planes[ch] = new Float32Array(frames);
        data.copyTo(planes[ch], {planeIndex: ch, format: 'f32-planar'});
      }

      while (pos < limit) {
        const bin = Math.floor((startUs + pos * 1e6 / rate + 0.00001) / STEP_US);
        if (currentBin !== bin) {
          writeBin();
          reserve(bin);
          currentBin = bin;
        }
        const boundary = Math.ceil(((bin + 1) * STEP_US - startUs) * rate / 1e6 - 1e-6);
        const stop = Math.min(limit, Math.max(pos + 1, boundary));
        binFrames += stop - pos;
        for (; pos < stop; pos++) {
          let x;
          if (used === 1) x = planes[0][pos];
          else if (used === 2) x = 0.60 * planes[0][pos] + 0.40 * planes[1][pos];
          else x = 0.22 * planes[0][pos] + 0.18 * planes[1][pos] + 0.60 * planes[2][pos];
          meter.sample(Number.isFinite(x) ? x : 0);
        }
        length = Math.max(length, bin + 1);
      }
      nextUs = startUs + frames * 1e6 / rate;
    }

    function finish() {
      if (!length) throw new Error('The selected movie track produced no audio. ' + FALLBACK);
      writeBin();
      const activity = audio.activityFromLevels(levels.subarray(0, length), quality.subarray(0, length));
      return {activity, stepMs: STEP_US / 1000};
    }

    return {setWindow, add, finish};
  }

  async function readMovieActivity(file, track, demuxer, {onProgress, signal} = {}) {
    if (!available()) throw new Error('This browser does not provide local movie audio decoding. ' + FALLBACK);
    const timeline = createTimeline();
    let decoder, failure, wake, configured = false;
    const notify = () => { if (wake) wake(); };
    const check = () => {
      if (signal && signal.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
      if (failure) throw failure;
    };
    const close = () => {
      if (decoder && decoder.state !== 'closed') decoder.close();
      notify();
    };
    const fail = err => {
      failure = err;
      close();
    };
    if (signal) signal.addEventListener('abort', close, {once: true});
    try {
      check();
      const onConfig = async (config, window) => {
        timeline.setWindow(window);
        if (configured) throw new Error('The audio encoding changes within this movie track. ' + FALLBACK);
        const supported = await root.AudioDecoder.isConfigSupported(config).catch(() => ({supported: false}));
        check();
        if (!supported.supported) throw new Error('This browser cannot decode ' + config.codec + '. ' + FALLBACK);
        decoder = new root.AudioDecoder({
          output(data) {
            try { if (!failure && !signal?.aborted) timeline.add(data); }
            catch (err) { fail(err); }
            finally { data.close(); }
          },
          error(err) { fail(new Error('The movie soundtrack could not be decoded: ' + err.message + '. ' + FALLBACK)); }
        });
        decoder.addEventListener('dequeue', notify);
        decoder.configure(config);
        configured = true;
      };
      const onPacket = async packet => {
        check();
        if (!configured) throw new Error('The movie audio track is missing its codec configuration.');
        // Keep codec state continuous, including Opus/AAC priming, while bounding the input queue.
        while (decoder.decodeQueueSize >= 24) {
          await new Promise(resolve => { wake = resolve; });
          wake = undefined;
          check();
        }
        decoder.decode(new root.EncodedAudioChunk({type: 'key', ...packet}));
      };
      if (onProgress) onProgress(0);
      await demuxer.readAudioPackets(file, track, {
        signal, onConfig, onPacket, onProgress: onProgress && (value => onProgress(0.98 * value))
      });
      check();
      if (!configured) throw new Error('The selected movie track contains no decodable audio. ' + FALLBACK);
      try { await decoder.flush(); }
      catch (err) { check(); throw err; }
      check();
      const result = timeline.finish();
      if (onProgress) onProgress(1);
      return result;
    } finally {
      if (signal) signal.removeEventListener('abort', close);
      if (decoder) decoder.removeEventListener('dequeue', notify);
      close();
    }
  }

  const api = {available, readMovieActivity};
  root.SyncMovieAudio = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
