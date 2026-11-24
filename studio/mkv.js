// Local Matroska text-track reader. EBML element IDs are defined by the Matroska specification.
(function (root) {
  "use strict";
  const ID = {
    ebml: 0x1a45dfa3, segment: 0x18538067, info: 0x1549a966, timeScale: 0x2ad7b1,
    tracks: 0x1654ae6b, entry: 0xae, number: 0xd7, type: 0x83, codec: 0x86,
    audio: 0xe1, rate: 0xb5, channels: 0x9f, private: 0x63a2,
    name: 0x536e, lang: 0x22b59c, langIetf: 0x22b59d, defaultDuration: 0x23e383,
    trackScale: 0x23314f, codecDelay: 0x56aa, encodings: 0x6d80, cluster: 0x1f43b675,
    timestamp: 0xe7, simple: 0xa3, group: 0xa0, block: 0xa1, duration: 0x9b,
  };
  const topLevel = new Set([ID.segment, ID.cluster, ID.info, ID.tracks, 0x114d9b74,
    0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367]);
  const formats = new Map([["S_TEXT/UTF8", "SubRip"], ["S_TEXT/ASS", "ASS"],
    ["S_TEXT/SSA", "SSA"], ["S_TEXT/WEBVTT", "WebVTT"], ["D_WEBVTT/SUBTITLES", "WebVTT"],
    ["D_WEBVTT/CAPTIONS", "WebVTT captions"]]);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const WINDOW = 256 * 1024;
  const MAX_TEXT = 1024 * 1024;
  const metadataCache = new WeakMap();
  function malformed() { return new Error("Invalid or truncated Matroska file."); }
  function vint(data, pos, isId = false) {
    let marker = 128, width = 1;
    while (marker && !(data[pos] & marker)) { marker >>= 1; width++; }
    if (!marker || width > (isId ? 4 : 8) || pos + width > data.length) throw malformed();
    let value = isId ? data[pos] : data[pos] - marker;
    let unknown = !isId && value === marker - 1;
    for (let i = 1; i < width; i++) {
      const byte = data[pos + i];
      value = value * 256 + byte;
      unknown = unknown && byte === 255;
    }
    if (!unknown && !Number.isSafeInteger(value)) throw malformed();
    return { value, width, unknown };
  }
  class Reader {
    constructor(file, signal) {
      if (!Number.isSafeInteger(file?.size) || typeof file?.slice !== "function") throw new Error("Choose a local Matroska file.");
      this.file = file; this.signal = signal; this.offset = 0; this.window = new Uint8Array();
    }
    check() {
      if (this.signal?.aborted) throw new DOMException("Matroska import cancelled.", "AbortError");
    }
    async bytes(pos, length) {
      this.check();
      if (pos < 0 || length < 0 || pos + length > this.file.size) throw malformed();
      if (pos < this.offset || pos + length > this.offset + this.window.length) {
        this.window = new Uint8Array(await this.file.slice(pos, pos + Math.max(WINDOW, length)).arrayBuffer());
        this.offset = pos; this.check();
      }
      return this.window.subarray(pos - this.offset, pos - this.offset + length);
    }
    async header(pos, limit) {
      const prefix = await this.bytes(pos, Math.min(12, limit - pos));
      const id = vint(prefix, 0, true);
      const size = vint(prefix, id.width);
      const data = pos + id.width + size.width;
      const end = size.unknown ? limit : data + size.value;
      if (!Number.isSafeInteger(end) || end > limit) throw malformed();
      if (size.unknown && id.value !== ID.cluster && id.value !== ID.segment) throw malformed();
      return { id: id.value, data, end, unknown: size.unknown };
    }
    async *children(parent) {
      for (let pos = parent.data; pos < parent.end;) {
        const child = await this.header(pos, parent.end);
        yield child;
        pos = child.end;
      }
    }
    async uint(el) {
      const length = el.end - el.data;
      if (length > 8) throw malformed();
      let value = 0;
      for (const byte of await this.bytes(el.data, length)) value = value * 256 + byte;
      if (!Number.isSafeInteger(value)) throw malformed();
      return value;
    }
    async float(el) {
      const size = el.end - el.data;
      if (size !== 4 && size !== 8) throw malformed();
      const b = await this.bytes(el.data, size), view = new DataView(b.buffer, b.byteOffset, size);
      const value = size === 4 ? view.getFloat32(0) : view.getFloat64(0);
      if (!Number.isFinite(value) || value <= 0) throw malformed();
      return value;
    }
    async string(el) {
      if (el.end - el.data > MAX_TEXT) throw new Error("Embedded subtitle text exceeds 1 MiB per cue or field.");
      return decoder.decode(await this.bytes(el.data, el.end - el.data)).replace(/\0+$/, "");
    }
  }
  async function trackEntries(reader, parent) {
    const choices = [];
    const skipped = [];
    for await (const entry of reader.children(parent)) {
      if (entry.id !== ID.entry) continue;
      const t = { language: "eng", name: "", trackScale: 1, codecDelay: 0, defaultDuration: 0 };
      let ietf;
      for await (const el of reader.children(entry)) {
        switch (el.id) {
          case ID.number: t.id = await reader.uint(el); break;
          case ID.type: t.type = await reader.uint(el); break;
          case ID.codec: t.codec = await reader.string(el); break;
          case ID.name: t.name = await reader.string(el); break;
          case ID.lang: t.language = await reader.string(el); break;
          case ID.langIetf: ietf = await reader.string(el); break;
          case ID.defaultDuration: t.defaultDuration = (await reader.uint(el)) / 1e6; break;
          case ID.codecDelay: t.codecDelay = (await reader.uint(el)) / 1e6; break;
          case ID.trackScale: t.trackScale = await reader.float(el); break;
          case ID.private: t.privateEl = el; break;
          case ID.audio: {
            t.channels = 1; t.sampleRate = 8000;
            for await (const field of reader.children(el)) {
              if (field.id === ID.rate) t.sampleRate = await reader.float(field);
              if (field.id === ID.channels) t.channels = await reader.uint(field);
            }
            break;
          }
          case ID.encodings: t.encoded = true; break;
        }
      }
      if (t.type !== 17 && t.type !== 2) continue;
      if (!t.id || !t.codec) throw malformed();
      t.kind = t.type === 17 ? "text" : "audio";
      let format = t.kind === "text" ? formats.get(t.codec) : null;
      if (t.kind === "audio" && (t.codec === "A_OPUS" || t.codec.startsWith("A_AAC"))) {
        if (t.privateEl && t.privateEl.end - t.privateEl.data <= 65536 && t.sampleRate && t.channels) {
          const bytes = await reader.bytes(t.privateEl.data, t.privateEl.end - t.privateEl.data);
          t.description = bytes.slice();
          if (t.codec === "A_OPUS" && bytes.length >= 19 && new TextDecoder().decode(bytes.subarray(0, 8)) === "OpusHead") {
            format = "Opus"; t.webCodec = "opus"; t.sampleRate = 48000;
          } else if (t.codec.startsWith("A_AAC") && bytes.length >= 2 && (bytes[0] >> 3) === 2) {
            format = "AAC-LC"; t.webCodec = "mp4a.40.2";
            // GASpecificConfig follows the object, frequency, and channel configuration.
            const explicitRate = ((bytes[0] & 7) * 2 + (bytes[1] >> 7)) === 15;
            const flagByte = explicitRate ? 4 : 1;
            if (bytes.length <= flagByte) throw malformed();
            t.aacSamples = (bytes[flagByte] & 4) ? 960 : 1024;
          }
        }
      }
      if (!format || t.encoded) { skipped.push(t.codec + (t.encoded ? " (compressed or encrypted)" : "")); continue; }
      t.language = ietf || t.language;
      t.label = ["Track " + t.id, t.language, t.name, format + (t.kind === "audio" ? " audio" : " subtitles")].filter(Boolean).join(" · ");
      choices.push(t);
    }
    if (choices.length) return choices;
    const detail = skipped.length ? " Found " + [...new Set(skipped)].join(", ") + "." : "";
    throw new Error("No readable embedded text subtitles or supported audio tracks." + detail + " Use an external SRT or mono WAV reference. Image subtitles such as PGS require OCR.");
  }
  async function segment(reader) {
    const length = reader.file.size;
    if (!length || (await reader.header(0, length)).id !== ID.ebml) throw new Error("This file is not a Matroska container.");
    for await (const el of reader.children({ data: 0, end: length })) {
      if (el.id === ID.segment) return el;
    }
    throw malformed();
  }
  // Only Segment and Cluster can have an unknown size. A level-one sibling ends that Cluster.
  async function visitCluster(reader, cluster, visit) {
    for (let pos = cluster.data; pos < cluster.end;) {
      const el = await reader.header(pos, cluster.end);
      if (cluster.unknown && topLevel.has(el.id)) return pos;
      if (visit) await visit(el);
      pos = el.end;
    }
    return cluster.end;
  }
  async function metadata(reader) {
    reader.check();
    const cached = metadataCache.get(reader.file);
    if (cached) return cached;
    const container = await segment(reader);
    for (let pos = container.data; pos < container.end;) {
      const el = await reader.header(pos, container.end);
      if (el.id === ID.tracks) {
        const choices = await trackEntries(reader, el);
        const meta = { container, choices };
        metadataCache.set(reader.file, meta);
        return meta;
      }
      pos = el.unknown && el.id === ID.cluster ? await visitCluster(reader, el) : el.end;
    }
    throw new Error("The file contains no readable tracks. Use an external SRT or mono WAV reference.");
  }
  async function listTracks(file, { signal } = {}) {
    const { choices } = await metadata(new Reader(file, signal));
    return choices.map(({ id, label, language, name, codec, kind }) => ({ id, label, language, name, codec, kind }));
  }
  function dialogue(text, codec) {
    // WebM stores the identifier and settings on two lines before the cue payload.
    if (codec.startsWith("D_WEBVTT/")) {
      const first = text.indexOf("\n"), second = text.indexOf("\n", first + 1);
      if (first < 0 || second < 0) throw new Error("Invalid embedded WebM caption.");
      return text.slice(second + 1);
    }
    if (codec !== "S_TEXT/ASS" && codec !== "S_TEXT/SSA") return text;
    // Matroska maps eight ASS fields before the dialogue; commas in the text are literal.
    let pos = 0;
    for (let i = 0; i < 8; i++) {
      const comma = text.indexOf(",", pos);
      if (comma < 0) throw new Error("Invalid embedded ASS dialogue.");
      pos = comma + 1;
    }
    return text.slice(pos).replace(/\{\\[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ");
  }
  async function blockHeader(reader, el, track) {
    const prefix = await reader.bytes(el.data, Math.min(11, el.end - el.data));
    const number = vint(prefix, 0);
    if (number.value !== track.id) return null;
    const n = number.width;
    if (prefix.length < n + 3) throw malformed();
    const rawTime = prefix[n] * 256 + prefix[n + 1];
    return { relative: rawTime < 32768 ? rawTime : rawTime - 65536,
      lace: (prefix[n + 2] >> 1) & 3, data: el.data + n + 3, end: el.end };
  }
  async function scanCluster(reader, cluster, track, visit) {
    let timestamp;
    const pending = []; // Block offsets only, for muxers that put the timestamp after blocks.
    const end = await visitCluster(reader, cluster, async el => {
      if (el.id === ID.timestamp) {
        timestamp = await reader.uint(el);
        for (const b of pending) await visit(b, timestamp);
        pending.length = 0;
        return;
      }
      let block, duration;
      if (el.id === ID.simple) block = await blockHeader(reader, el, track);
      if (el.id === ID.group) {
        for await (const child of reader.children(el)) {
          if (child.id === ID.block) block = await blockHeader(reader, child, track);
          if (child.id === ID.duration) duration = await reader.uint(child);
        }
      }
      if (block) {
        block.duration = duration;
        if (timestamp === undefined) pending.push(block);
        else await visit(block, timestamp);
      }
    });
    if (pending.length) throw malformed();
    return end;
  }
  async function getScale(reader, container) {
    for (let pos = container.data; pos < container.end;) {
      const el = await reader.header(pos, container.end);
      if (el.id === ID.info) {
        for await (const child of reader.children(el)) {
          if (child.id !== ID.timeScale) continue;
          const scale = (await reader.uint(child)) / 1e6;
          if (!scale) throw malformed();
          return scale;
        }
        return 1;
      }
      pos = el.unknown && el.id === ID.cluster ? await visitCluster(reader, el) : el.end;
    }
    return 1;
  }
  async function scan(reader, container, track, visit, onProgress) {
    const msPerTick = await getScale(reader, container);
    let lastProgress = 0;
    onProgress?.(0);
    for (let pos = container.data; pos < container.end;) {
      const el = await reader.header(pos, container.end);
      if (el.id === ID.cluster) {
        pos = await scanCluster(reader, el, track, (b, clusterTime) => {
          const start = (clusterTime + b.relative * track.trackScale) * msPerTick - track.codecDelay;
          const duration = b.duration === undefined ? track.defaultDuration || null : b.duration * msPerTick * track.trackScale;
          return visit(b, start, duration);
        });
      } else pos = el.end;
      if (pos / container.end - lastProgress >= 0.005) {
        lastProgress = pos / container.end; onProgress?.(lastProgress);
      }
    }
    reader.check();
    if (lastProgress < 1) onProgress?.(1);
  }
  async function readCues(file, id, { onProgress, signal } = {}) {
    const reader = new Reader(file, signal);
    const { container, choices } = await metadata(reader);
    const track = choices.find(t => t.id === Number(id));
    if (!track || track.kind !== "text") throw new Error("Choose a readable subtitle track.");
    const blocks = [];
    await scan(reader, container, track, async (b, start, duration) => {
      if (b.lace) throw new Error("This embedded subtitle uses laced blocks. Use an external reference.");
      const text = dialogue(await reader.string(b), track.codec);
      blocks.push({ start, duration, text });
    }, onProgress);
    blocks.sort((a, b) => a.start - b.start);
    const cues = [];
    for (const [index, b] of blocks.entries()) {
      if (!b.text.trim()) continue;
      const start = Math.max(0, Math.round(b.start));
      // Without a duration or subsequent timestamp the last block has no reliable end.
      const endTime = b.duration !== null ? b.start + b.duration : blocks[index + 1]?.start;
      if (endTime !== undefined && Math.round(endTime) > start) {
        cues.push({ start, end: Math.round(endTime), text: b.text });
      }
    }
    if (!cues.length) throw new Error("This track contains no readable subtitle cues with usable timing.");
    return cues;
  }
  function packets(bytes, lace) {
    if (!bytes.length) throw malformed();
    if (!lace) return [bytes];
    const count = bytes[0] + 1;
    if (count < 2) throw malformed();
    let pos = 1;
    const sizes = [];
    for (let i = 0; i < count - 1; i++) {
      let size = 0;
      if (lace === 1) { // Xiph: each 255 byte extends the frame length.
        let part;
        do { if (pos >= bytes.length) throw malformed(); part = bytes[pos++]; size += part; } while (part === 255);
      } else if (lace === 2) size = (bytes.length - 1) / count;
      else { // EBML: the first length is absolute, subsequent lengths use signed deltas.
        const v = vint(bytes, pos);
        size = v.value; pos += v.width;
        if (i) size += sizes[i - 1] - (2 ** (7 * v.width - 1) - 1);
      }
      if (!Number.isSafeInteger(size) || size <= 0) throw malformed();
      sizes.push(size);
    }
    sizes.push(bytes.length - pos - sizes.reduce((a, b) => a + b, 0));
    if (sizes[sizes.length - 1] <= 0) throw malformed();
    return sizes.map(length => {
      const packet = bytes.subarray(pos, pos + length); pos += length; return packet;
    });
  }
  function opusDuration(packet) {
    const config = packet[0] >> 3;
    const frameMs = config < 12 ? [10, 20, 40, 60][config % 4]
      : config < 16 ? [10, 20][config % 2] : [2.5, 5, 10, 20][config % 4];
    const mode = packet[0] & 3;
    const count = mode === 0 ? 1 : mode < 3 ? 2 : (packet[1] & 63);
    if (!count || count * frameMs > 120) throw malformed();
    return frameMs * count;
  }
  async function readAudioPackets(file, idOrTrack, { onConfig, onPacket, onProgress, signal } = {}) {
    const reader = new Reader(file, signal);
    const { container, choices } = await metadata(reader);
    const track = choices.find(t => t.id === Number(idOrTrack?.id ?? idOrTrack) && t.kind === "audio");
    if (!track) throw new Error("Choose an AAC-LC or Opus audio track.");
    await onConfig({ codec: track.webCodec, sampleRate: track.sampleRate,
      numberOfChannels: track.channels, description: track.description.slice() });
    let count = 0;
    await scan(reader, container, track, async (b, start) => {
      if (b.end - b.data > 8 * 1024 * 1024) throw new Error("An embedded audio block exceeds 8 MiB.");
      const frames = packets(await reader.bytes(b.data, b.end - b.data), b.lace);
      for (const data of frames) {
        const duration = track.webCodec === "opus" ? opusDuration(data)
          : track.defaultDuration || 1000 * track.aacSamples / track.sampleRate;
        reader.check();
        await onPacket({ type: "key", timestamp: Math.round(start * 1000),
          duration: Math.round(duration * 1000), data });
        start += duration;
        count++;
      }
    }, onProgress);
    if (!count) throw new Error("This audio track is empty.");
  }
  const api = { listTracks, readCues, readAudioPackets };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SyncMkv = api;
})(globalThis);
