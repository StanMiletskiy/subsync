/* Original browser rewrite. SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';

  const MAX_METADATA = 48 * 1024 * 1024;
  const MAX_SAMPLES = 2000000;
  const MAX_BATCH = 256 * 1024;
  const cache = new WeakMap();
  const invalid = (message) => new Error('MP4: ' + message);
  const fourCC = (view, pos) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + pos, 4));
  const uint = (view, pos) => view.getUint32(pos);

  function checkAbort(signal) {
    if (signal && signal.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  }

  function safe(value) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw invalid('a file offset or timestamp exceeds the supported range.');
    return number;
  }

  function bounds(pos, length, end) {
    if (pos < 0 || length < 0 || !Number.isSafeInteger(pos + length) || pos + length > end) {
      throw invalid('a box or sample table is truncated.');
    }
  }

  async function read(file, pos, size) {
    bounds(pos, size, file.size);
    const data = await file.slice(pos, pos + size).arrayBuffer();
    if (data.byteLength !== size) throw invalid('could not read the complete file section.');
    return new DataView(data);
  }

  function boxes(view, start, end) {
    const result = [];
    for (let pos = start; pos < end;) {
      bounds(pos, 8, end);
      const type = fourCC(view, pos + 4);
      let header = 8;
      let size = uint(view, pos);
      if (size === 1) {
        bounds(pos, 16, end);
        size = safe(view.getBigUint64(pos + 8));
        header = 16;
      } else if (size === 0) size = end - pos;
      if (size < header) throw invalid('invalid box size.');
      bounds(pos, size, end);
      if (result.length >= 32000) throw invalid('too many metadata boxes.');
      result.push({type, start: pos + header, end: pos + size});
      pos += size;
    }
    return result;
  }

  function child(nodes, type, required = true) {
    const box = nodes.find(item => item.type === type);
    if (!box && required) throw invalid('missing ' + type + ' metadata.');
    return box;
  }

  function children(view, box) {
    return boxes(view, box.start, box.end);
  }

  function field(view, box, at, size) {
    const pos = box.start + at;
    bounds(pos, size, box.end);
    return pos;
  }

  function version(view, box) {
    const v = view.getUint8(field(view, box, 0, 4));
    if (v > 1) throw invalid('unsupported ' + box.type + ' version.');
    return v;
  }

  function headerValue(view, box) {
    return uint(view, field(view, box, version(view, box) ? 20 : 12, 4));
  }

  function table(view, box, rowSize) {
    const count = uint(view, field(view, box, 4, 4));
    if (count > MAX_SAMPLES) throw invalid('sample table exceeds the supported size.');
    field(view, box, 8, count * rowSize);
    return {pos: box.start + 8, count};
  }

  function editWindow(view, trackBoxes, movieScale, mediaScale) {
    const edts = child(trackBoxes, 'edts', false);
    if (!edts) return null;
    const elst = child(children(view, edts), 'elst');
    const long = version(view, elst) === 1;
    const stride = long ? 20 : 12;
    const {pos, count} = table(view, elst, stride);
    if (!count) return null;
    let cursor = 0;
    let window = null;
    for (let i = 0; i < count; i++) {
      const p = pos + i * stride;
      const duration = long ? safe(view.getBigUint64(p)) : uint(view, p);
      const media = long ? safe(view.getBigInt64(p + 8)) : view.getInt32(p + 4);
      if (view.getInt32(p + stride - 4) !== 65536 || media < -1) throw invalid('unsupported edit rate or media start.');
      if (media >= 0) {
        if (window) throw invalid('this track has multiple media edits. Export it as a timed SRT first.');
        window = {start: media, length: duration / movieScale * mediaScale, movieStartMs: cursor / movieScale * 1000};
      }
      cursor = safe(cursor + duration);
    }
    if (!window) throw invalid('this track contains only empty edits.');
    return window;
  }

  function trackInfo(view, trak) {
    const top = children(view, trak);
    const mdia = children(view, child(top, 'mdia'));
    const handler = child(mdia, 'hdlr');
    const type = fourCC(view, field(view, handler, 8, 4));
    const audio = type === 'soun';
    if (!audio && !['sbtl', 'subt', 'text'].includes(type)) return null;
    const minf = children(view, child(mdia, 'minf'));
    const stbl = children(view, child(minf, 'stbl'));
    const stsd = child(stbl, 'stsd');
    const count = uint(view, field(view, stsd, 4, 4));
    const formats = boxes(view, stsd.start + 8, stsd.end);
    if (formats.length !== count) throw invalid('invalid sample description count.');
    const format = formats.find(f => audio ? ['mp4a', 'Opus'].includes(f.type) : f.type === 'tx3g');
    if (!format) return null;
    const codec = audio ? (format.type === 'Opus' ? 'opus' : 'aac') : 'tx3g';
    const kind = audio ? 'audio' : 'text';

    const mdhd = child(mdia, 'mdhd');
    const mediaScale = headerValue(view, mdhd);
    const langCode = view.getUint16(field(view, mdhd, version(view, mdhd) ? 32 : 20, 2));
    const rawLanguage = String.fromCharCode(...[10,5,0].map(shift => 96 + ((langCode >> shift) & 31)));
    const language = /^[a-z]{3}$/.test(rawLanguage) ? rawLanguage : 'und';
    const id = headerValue(view, child(top, 'tkhd'));
    if (!id || !mediaScale) throw invalid('track ID or timescale is zero.');
    const name = audio ? (codec === 'aac' ? 'AAC audio' : 'Opus audio') : 'Timed text';
    return {id, language, label: name + ' · ' + language + ' · track ' + id, codec, kind, mediaScale, top, minf, stbl, formats, format};
  }

  async function indexFile(file) {
    let metadata;
    const mediaRanges = [];
    let count = 0;
    for (let pos = 0; pos < file.size;) {
      if (++count > 10000) throw invalid('too many top-level boxes.');
      const h = await read(file, pos, 8);
      let size = uint(h, 0), header = 8;
      const type = fourCC(h, 4);
      if (size === 1) {
        size = safe((await read(file, pos + 8, 8)).getBigUint64(0));
        header = 16;
      } else if (size === 0) size = file.size - pos;
      if (size < header) throw invalid('invalid top-level box size.');
      bounds(pos, size, file.size);
      if (type === 'moof') throw invalid('fragmented MP4 is unsupported. Export a subtitle track as SRT.');
      if (type === 'moov') {
        if (metadata || size > MAX_METADATA) throw invalid('duplicate or oversized movie metadata.');
        metadata = await read(file, pos + header, size - header);
      }
      if (type === 'mdat') mediaRanges.push([pos + header, pos + size]);
      pos += size;
    }
    if (!metadata) throw invalid('movie metadata was not found.');
    const nodes = boxes(metadata, 0, metadata.byteLength);
    if (child(nodes, 'mvex', false)) throw invalid('fragmented MP4 is unsupported. Export a subtitle track as SRT.');
    if (child(nodes, 'cmov', false)) throw invalid('compressed QuickTime metadata is unsupported.');
    const movieScale = headerValue(metadata, child(nodes, 'mvhd'));
    if (!movieScale) throw invalid('movie timescale is zero.');
    const tracks = nodes.filter(n => n.type === 'trak').map(n => trackInfo(metadata, n)).filter(Boolean);
    if (new Set(tracks.map(t => t.id)).size !== tracks.length) throw invalid('duplicate subtitle track IDs.');
    return {metadata, mediaRanges, movieScale, tracks};
  }

  function index(file) {
    if (!cache.has(file)) cache.set(file, indexFile(file).catch(error => { cache.delete(file); throw error; }));
    return cache.get(file);
  }

  async function listTracks(file) {
    const {tracks} = await index(file);
    return tracks.map(({id, label, language, codec, kind}) => ({id, label, language, codec, kind}));
  }

  function durations(view, box, count, composition) {
    const v = version(view, box);
    if (!composition && v) throw invalid('unsupported time-to-sample table version.');
    const entries = table(view, box, 8);
    const values = new Float64Array(count);
    let index = 0;
    for (let i = 0; i < entries.count; i++) {
      const pos = entries.pos + 8 * i;
      const length = uint(view, pos);
      if (!length || length > count - index) throw invalid('inconsistent subtitle sample times.');
      values.fill(composition && v ? view.getInt32(pos + 4) : uint(view, pos + 4), index, index + length);
      index += length;
    }
    if (index !== count) throw invalid('incomplete subtitle sample times.');
    return values;
  }

  function* planSamples(data, track) {
    const {metadata: view, mediaRanges, movieScale} = data;
    const {stbl, mediaScale} = track;
    const stsz = child(stbl, 'stsz', false);
    if (!stsz) throw invalid('missing standard media sample sizes.');
    const fixed = uint(view, field(view, stsz, 4, 4));
    const count = uint(view, field(view, stsz, 8, 4));
    if (count > MAX_SAMPLES) throw invalid('too many media samples.');
    if (!count) return;
    if (!fixed) field(view, stsz, 12, count * 4);
    const offsets = child(stbl, 'stco', false) || child(stbl, 'co64');
    const wide = offsets.type === 'co64';
    const chunks = table(view, offsets, wide ? 8 : 4);
    const groups = table(view, child(stbl, 'stsc'), 12);
    const times = durations(view, child(stbl, 'stts'), count, false);
    const ctts = child(stbl, 'ctts', false);
    const shifts = ctts && durations(view, ctts, count, true);
    const edits = editWindow(view, track.top, movieScale, mediaScale);
    const dinf = child(track.minf, 'dinf');
    const dref = child(children(view, dinf), 'dref');
    const refCount = uint(view, field(view, dref, 4, 4));
    const refs = boxes(view, dref.start + 8, dref.end);
    if (refs.length !== refCount) throw invalid('invalid data reference count.');
    let n = 0;
    let dts = 0;
    for (let g = 0; g < groups.count; g++) {
      const p = groups.pos + 12 * g;
      const first = uint(view, p);
      const end = g + 1 === groups.count ? chunks.count + 1 : uint(view, p + 12);
      const perChunk = uint(view, p + 4);
      const format = track.formats[uint(view, p + 8) - 1];
      if (format !== track.format) throw invalid('tracks that switch sample descriptions are unsupported.');
      const ref = refs[view.getUint16(field(view, format, 6, 2)) - 1];
      if (!ref || ref.type !== 'url ' || !(uint(view, field(view, ref, 0, 4)) & 1)) {
        throw invalid('external media data references are unsupported.');
      }
      if ((!g && first !== 1) || first >= end || end > chunks.count + 1 || !perChunk ||
          (end - first) * perChunk > count - n) throw invalid('inconsistent sample-to-chunk table.');
      for (let chunk = first - 1; chunk < end - 1; chunk++) {
        const pos = chunks.pos + chunk * (wide ? 8 : 4);
        let offset = wide ? safe(view.getBigUint64(pos)) : uint(view, pos);
        const region = mediaRanges.find(([start, end]) => offset >= start && offset < end);
        if (!region) throw invalid('subtitle chunk points outside media data.');
        for (let k = 0; k < perChunk; k++) {
          const size = fixed || uint(view, stsz.start + 12 + 4 * n);
          if (size > MAX_BATCH) throw invalid('oversized media sample.');
          bounds(offset, size, region[1]);
          const duration = times[n], pts = safe(dts + (shifts ? shifts[n] : 0));
          const relative = pts - (edits ? edits.start : 0);
          const relativeEnd = relative + duration;
          const end = edits ? Math.min(edits.length, relativeEnd) : relativeEnd;
          const origin = edits ? edits.movieStartMs : 0;
          const sample = {offset, size, progress: ++n / count};
          if (track.kind === 'audio') {
            sample.timestamp = Math.round((origin + relative * 1000 / mediaScale) * 1000);
            sample.duration = Math.round(duration * 1000000 / mediaScale);
            // Include preroll, including negative movie times, to initialize the decoder.
            sample.enabled = !edits || relative < edits.length;
          } else {
            sample.start = Math.round(origin + Math.max(0, relative) * 1000 / mediaScale);
            sample.end = Math.round(origin + end * 1000 / mediaScale);
          }
          yield sample;
          offset += size;
          dts = safe(dts + duration);
        }
      }
    }
    if (n !== count) throw invalid('incomplete sample-to-chunk table.');
  }

  function sampleText(view, pos, size) {
    if (size === 0) return '';
    bounds(pos, 2, pos + size);
    const length = view.getUint16(pos);
    bounds(pos + 2, length, pos + size);
    if (!length) return '';
    const bom = length >= 2 && view.getUint16(pos + 2);
    const codec = bom === 0xfeff ? 'utf-16be' : bom === 0xfffe ? 'utf-16le' : 'utf-8';
    return new TextDecoder(codec, {fatal: true}).decode(new Uint8Array(view.buffer, view.byteOffset + pos + 2, length))
      .replace(/\r\n?/g, '\n');
  }

  async function* sampleBatches(file, data, track, signal) {
    const iterator = planSamples(data, track);
    let next = iterator.next();
    while (!next.done) {
      checkAbort(signal);
      const list = [next.value];
      const from = next.value.offset;
      let size = next.value.size;
      while (!(next = iterator.next()).done && next.value.offset === from + size &&
             size + next.value.size <= MAX_BATCH && list.length < 2048) {
        list.push(next.value);
        size += next.value.size;
      }
      const view = await read(file, from, size);
      checkAbort(signal);
      yield {list, view, from};
    }
  }

  function selectTrack(data, selected, kind) {
    const id = selected && typeof selected === 'object' ? selected.id : selected;
    const track = data.tracks.find(item => item.kind === kind && String(item.id) === String(id));
    if (!track) throw invalid('the selected ' + kind + ' track was not found.');
    return track;
  }

  async function readCues(file, id, {onProgress, signal} = {}) {
    checkAbort(signal);
    const data = await index(file);
    const track = selectTrack(data, id, 'text');
    const output = [];
    for await (const {list, view, from} of sampleBatches(file, data, track, signal)) {
      for (const {offset, size, start, end} of list) {
        if (end <= start) continue;
        const text = sampleText(view, offset - from, size);
        if (text.trim()) output.push({start, end, text});
      }
      if (onProgress) onProgress(list[list.length - 1].progress);
    }
    checkAbort(signal);
    return output.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function descriptor(view, pos, end, expected) {
    bounds(pos, 1, end);
    if (view.getUint8(pos++) !== expected) throw invalid('unsupported AAC descriptor.');
    let length = 0;
    for (let i = 0; i < 4; i++) {
      bounds(pos, 1, end);
      const value = view.getUint8(pos++);
      length = length * 128 + (value & 127);
      if (!(value & 128)) {
        bounds(pos, length, end);
        return {start: pos, end: pos + length};
      }
    }
    throw invalid('invalid AAC descriptor size.');
  }

  function aacConfig(view, nodes) {
    const wave = child(nodes, 'wave', false);
    const esds = child(nodes, 'esds', false) || (wave && child(children(view, wave), 'esds', false));
    if (!esds) throw invalid('AAC codec configuration was not found.');
    const es = descriptor(view, field(view, esds, 4, 2), esds.end, 3);
    const flags = view.getUint8(field(view, es, 2, 1));
    let pos = es.start + 3 + (flags & 128 ? 2 : 0);
    if (flags & 64) {
      bounds(pos, 1, es.end);
      pos += 1 + view.getUint8(pos);
    }
    if (flags & 32) pos += 2;
    const decoder = descriptor(view, pos, es.end, 4);
    if (view.getUint8(field(view, decoder, 0, 13)) !== 0x40) throw invalid('only MPEG-4 AAC-LC audio is supported.');
    const config = descriptor(view, decoder.start + 13, decoder.end, 5);
    const bits = view.getUint16(field(view, config, 0, 2));
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const sampleRate = rates[(bits >> 7) & 15];
    const numberOfChannels = [0, 1, 2, 3, 4, 5, 6, 8][(bits >> 3) & 15];
    if ((bits >> 11) !== 2 || !sampleRate || !numberOfChannels) {
      throw invalid('unsupported AAC profile, sample rate or channel layout. Choose AAC-LC or export PCM WAV.');
    }
    return {codec: 'mp4a.40.2', sampleRate, numberOfChannels,
      description: new Uint8Array(view.buffer.slice(view.byteOffset + config.start, view.byteOffset + config.end))};
  }

  function opusConfig(view, nodes) {
    const dops = child(nodes, 'dOps');
    const p = field(view, dops, 0, 11);
    const channels = view.getUint8(p + 1), mapping = view.getUint8(p + 10);
    if (view.getUint8(p) !== 0 || !channels || (mapping !== 0 && mapping !== 1) ||
        (!mapping && channels > 2)) throw invalid('unsupported Opus configuration.');
    const extra = mapping ? 2 + channels : 0;
    field(view, dops, 11, extra);
    const head = new Uint8Array(19 + extra);
    head.set(new TextEncoder().encode('OpusHead'));
    head[8] = 1;
    head[9] = channels;
    const h = new DataView(head.buffer);
    h.setUint16(10, view.getUint16(p + 2), true);
    h.setUint32(12, uint(view, p + 4), true);
    h.setInt16(16, view.getInt16(p + 8), true);
    head[18] = mapping;
    if (extra) head.set(new Uint8Array(view.buffer, view.byteOffset + p + 11, extra), 19);
    return {codec: 'opus', sampleRate: 48000, numberOfChannels: channels, description: head};
  }

  function audioConfig(data, track) {
    const view = data.metadata, entry = track.format;
    const v = view.getUint16(field(view, entry, 8, 2));
    if (v > 1) throw invalid('unsupported QuickTime audio sample description.');
    const offset = v ? 44 : 28;
    const nodes = boxes(view, field(view, entry, offset, 0), entry.end);
    return track.codec === 'aac' ? aacConfig(view, nodes) : opusConfig(view, nodes);
  }

  async function readAudioPackets(file, id, {onConfig, onPacket, onProgress, signal} = {}) {
    checkAbort(signal);
    const data = await index(file);
    const track = selectTrack(data, id, 'audio');
    checkAbort(signal);
    const edits = editWindow(data.metadata, track.top, data.movieScale, track.mediaScale);
    const window = edits ? {startUs: Math.round(edits.movieStartMs * 1000),
      endUs: Math.round((edits.movieStartMs + edits.length * 1000 / track.mediaScale) * 1000)} : undefined;
    await onConfig(audioConfig(data, track), window);
    for await (const {list, view, from} of sampleBatches(file, data, track, signal)) {
      for (const {offset, size, timestamp, duration, enabled} of list) {
        checkAbort(signal);
        if (enabled && size) await onPacket({timestamp, duration, type: 'key',
          data: new Uint8Array(view.buffer, view.byteOffset + offset - from, size)});
      }
      if (onProgress) onProgress(list[list.length - 1].progress);
    }
    checkAbort(signal);
  }

  const api = {listTracks, readCues, readAudioPackets};
  root.SyncMp4 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
