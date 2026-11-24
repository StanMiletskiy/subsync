/* Original browser rewrite. SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';

  const STEP_MS = 100;
  const READ_BYTES = 1024 * 1024;
  const WAV_HELP = 'Choose a PCM WAV file, or export the dialogue track as a mono, 16 kHz PCM WAV.';

  function checkAbort(signal) {
    if (signal && signal.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
  }

  function fourCC(view, pos) {
    return String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + pos, 4));
  }

  async function read(file, from, length, signal) {
    checkAbort(signal);
    const buffer = await file.slice(from, from + length).arrayBuffer();
    checkAbort(signal);
    if (buffer.byteLength !== length) throw new Error('The WAV file is incomplete.');
    return new DataView(buffer);
  }

  function parseFormat(view) {
    if (view.byteLength < 16) throw new Error('The WAV format header is incomplete.');
    let tag = view.getUint16(0, true);
    const channels = view.getUint16(2, true);
    const rate = view.getUint32(4, true);
    const stride = view.getUint16(12, true);
    const bits = view.getUint16(14, true);
    let mask = 0;
    if (tag === 0xfffe) {
      if (view.byteLength < 40 || view.getUint16(16, true) < 22) throw new Error('The extended WAV format header is incomplete.');
      const suffix = [0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
      if (!suffix.every((value, i) => value === view.getUint8(28 + i))) throw new Error(WAV_HELP);
      tag = view.getUint32(24, true);
      mask = view.getUint32(20, true);
    }

    if (channels < 1 || rate < 1000 || rate > 768000 || stride !== channels * bits / 8) throw new Error(WAV_HELP);
    const validBits = tag === 1 ? [8, 16, 24, 32] : tag === 3 ? [32, 64] : [];
    if (!validBits.includes(bits)) throw new Error(WAV_HELP);
    return {tag, channels, rate, stride, bits, mask};
  }

  function readSize64(view, offset) {
    const n = Number(view.getBigUint64(offset, true));
    if (!Number.isSafeInteger(n)) throw new Error('The WAV file size is too large.');
    return n;
  }

  async function inspect(file, signal) {
    if (!file || typeof file.slice !== 'function' || file.size < 12) throw new Error(WAV_HELP);
    const header = await read(file, 0, 12, signal);
    const riff = fourCC(header, 0);
    if ((riff !== 'RIFF' && riff !== 'RF64') || fourCC(header, 8) !== 'WAVE') throw new Error(WAV_HELP);
    const declared = header.getUint32(4, true);
    let end = declared === 0xffffffff ? file.size : declared + 8;
    if (end > file.size) throw new Error('The WAV file is incomplete.');
    let format;
    const chunks = [];
    let rf64DataSize;
    // Skip metadata using headers only. Embedded cover art can be larger than the audio read buffer.
    for (let at = 12; at + 8 <= end;) {
      const chunk = await read(file, at, 8, signal);
      const name = fourCC(chunk, 0);
      let size = chunk.getUint32(4, true);
      at += 8;
      if (size === 0xffffffff) {
        if (name !== 'data' || rf64DataSize === undefined) throw new Error('This WAV has no finalized length. ' + WAV_HELP);
        size = rf64DataSize;
      }
      if (at + size > end) throw new Error('The WAV file is incomplete.');
      if (name === 'fmt ') format = parseFormat(await read(file, at, Math.min(size, 40), signal));
      if (name === 'ds64' && riff === 'RF64' && size >= 28) {
        const sizes = await read(file, at, 28, signal);
        end = readSize64(sizes, 0) + 8;
        if (end > file.size) throw new Error('The WAV file is incomplete.');
        rf64DataSize = readSize64(sizes, 8);
      }
      if (name === 'data' && size) chunks.push({offset: at, size});
      at += size + (size % 2);
    }
    if (!format || !chunks.length) throw new Error('The WAV file contains no readable audio. ' + WAV_HELP);
    if (chunks.some(chunk => chunk.size % format.stride !== 0)) throw new Error('The WAV file ends in a partial sample frame.');
    return {format, chunks};
  }

  function sampleReader(format) {
    if (format.tag === 3) {
      const method = format.bits === 32 ? 'getFloat32' : 'getFloat64';
      return (view, pos) => {
        const value = view[method](pos, true);
        return Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;
      };
    }
    switch (format.bits) {
      case 8: return (view, pos) => (view.getUint8(pos) - 128) / 128;
      case 16: return (view, pos) => view.getInt16(pos, true) / 32768;
      case 24: return (view, pos) => (view.getUint16(pos, true) + 65536 * view.getInt8(pos + 2)) / 8388608;
      case 32: return (view, pos) => view.getInt32(pos, true) / 2147483648;
    }
  }

  function mixReader(format) {
    const sample = sampleReader(format);
    if (format.channels === 1) return sample;
    const bytes = format.bits / 8;
    // WAV speaker-mask channels follow ascending bit order (front left, right, then centre).
    const hasFrontThree = format.mask ? (format.mask & 7) === 7 : format.channels === 3 || format.channels >= 5;
    if (hasFrontThree) {
      return (view, at) => 0.60 * sample(view, at + 2 * bytes) + 0.22 * sample(view, at) + 0.18 * sample(view, at + bytes);
    }
    // An asymmetric mix also retains dialogue in opposite-phase stereo recordings.
    return (view, at) => 0.60 * sample(view, at) + 0.40 * sample(view, at + bytes);
  }

  function quantile(histogram, count, fraction) {
    let target = Math.max(1, Math.ceil(count * fraction));
    for (let level = 0; level < histogram.length; level++) {
      target -= histogram[level];
      if (target <= 0) return level;
    }
    return 0;
  }

  function activityFromLevels(levels, quality) {
    const histogram = new Uint32Array(97);
    for (const level of levels) histogram[level]++;
    const globalFloor = quantile(histogram, levels.length, 0.25);
    const activity = new Float32Array(levels.length);
    const radius = 100; // Ten seconds on either side follows changes in scene loudness.
    histogram.fill(0);
    let left = 0;
    let right = 0;
    for (let i = 0; i < levels.length; i++) {
      while (right < levels.length && right <= i + radius) histogram[levels[right++]]++;
      while (left < i - radius) histogram[levels[left++]]--;
      const floor = Math.min(globalFloor + 8, quantile(histogram, right - left, 0.15));
      const contrast = (levels[i] - Math.max(15, floor) - 2) / 11;
      activity[i] = Math.max(0, Math.min(1, contrast)) * quality[i] / 255;
    }
    return activity;
  }

  function createBandMeter(rate) {
    const hpMix = 1 - Math.exp(-2 * Math.PI * 160 / rate);
    const lpMix = 1 - Math.exp(-2 * Math.PI * Math.min(3300, rate * 0.40) / rate);
    let low = 0, low2 = 0, band = 0, energy = 0, broad = 0;
    return {
      sample(x) {
        // Two high-pass stages attenuate rumble. The low-pass stage attenuates hiss.
        low += hpMix * (x - low);
        const first = x - low;
        low2 += hpMix * (first - low2);
        band += lpMix * (first - low2 - band);
        energy += band * band;
        broad += x * x;
      },
      writeBin(levels, quality, bin, frames) {
        const power = energy / frames;
        levels[bin] = Math.min(96, Math.max(0, Math.round(96 + 10 * Math.log10(power + 1e-14))));
        quality[bin] = Math.round(255 * Math.min(1, 4 * energy / (broad + 1e-12)));
        energy = 0;
        broad = 0;
      },
      resetFilter() { low = 0; low2 = 0; band = 0; }
    };
  }

  async function readWavActivity(file, {onProgress, signal} = {}) {
    const {format, chunks} = await inspect(file, signal);
    const {rate, stride} = format;
    const frames = chunks.reduce((sum, c) => sum + c.size / stride, 0);
    const count = Math.ceil(frames * 10 / rate);
    const levels = new Uint8Array(count);
    const quality = new Uint8Array(count);
    const mix = mixReader(format);
    const meter = createBandMeter(rate);
    let frame = 0, bin = 0, start = 0;
    let boundary = Math.ceil(rate / 10);
    const readFrames = Math.max(1, Math.floor(READ_BYTES / stride));
    const record = () => {
      meter.writeBin(levels, quality, bin, frame - start);
      start = frame;
      bin++;
      boundary = Math.ceil((bin + 1) * rate / 10);
    };

    if (onProgress) onProgress(0);
    for (const chunk of chunks) {
      for (let offset = 0; offset < chunk.size;) {
        const size = Math.min(readFrames * stride, chunk.size - offset);
        const view = await read(file, chunk.offset + offset, size, signal);
        for (let at = 0; at < size; at += stride) {
          meter.sample(mix(view, at));
          frame++;
          if (frame === boundary) record();
        }
        offset += size;
        if (onProgress) onProgress(frame / frames);
      }
    }
    checkAbort(signal);
    if (frame > start) record();
    return {activity: activityFromLevels(levels, quality), stepMs: STEP_MS};
  }

  const api = {readWavActivity, createBandMeter, activityFromLevels};
  root.SyncAudio = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
