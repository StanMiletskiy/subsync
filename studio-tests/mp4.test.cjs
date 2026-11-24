const { test } = require("node:test");
const assert = require("node:assert/strict");
const { listTracks, readCues, readAudioPackets } = require("../studio/mp4.js");

// Construct tiny unfragmented ISO BMFF files. Tables, movie/media timebases,
// edit lists, chunk layout, and sample bytes are independently specified here.
function number(bytes, value, signed = false) {
  const out = Buffer.alloc(bytes);
  if (bytes === 8) {
    if (signed) out.writeBigInt64BE(BigInt(value));
    else out.writeBigUInt64BE(BigInt(value));
  } else if (signed) out.writeIntBE(value, 0, bytes);
  else out.writeUIntBE(value, 0, bytes);
  return out;
}
const u16 = v => number(2, v);
const u32 = v => number(4, v);
const box = (type, ...payload) => {
  const contents = Buffer.concat(payload);
  return Buffer.concat([u32(8 + contents.length), Buffer.from(type), contents]);
};
const full = (type, v, ...payload) => box(type, u32(v * 16777216), ...payload);
const table = (type, v, rows) => full(type, v, u32(rows.length), ...rows.map(row => Buffer.concat(row)));
const textSample = x => {
  const bytes = Buffer.isBuffer(x) ? x : Buffer.from(x, "utf8");
  return Buffer.concat([u16(bytes.length), bytes]);
};
const tx3g = box("tx3g", Buffer.alloc(6), u16(1), Buffer.alloc(30));
const language = code => code.split("").reduce((v, ch) => v * 32 + ch.charCodeAt(0) - 96, 0);
const handler = kind => full("hdlr", 0, u32(0), Buffer.from(kind), Buffer.alloc(12));

function mediaTrack(id, lang, sizes, chunkOffsets, samplesPerChunk, timing, options = {}) {
  const tkhd = full("tkhd", 0, Buffer.alloc(8), u32(id), Buffer.alloc(64));
  const mdhd = full("mdhd", 0, Buffer.alloc(8), u32(options.scale || 20000), u32(70000), u16(language(lang)), u16(0));
  const stsd = full("stsd", 0, u32(1), options.format || tx3g);
  const stsz = full("stsz", 0, u32(options.fixed || 0), u32(sizes.length), ...(options.fixed ? [] : sizes.map(u32)));
  const wide = !!options.wide;
  const offsetTable = table(wide ? "co64" : "stco", 0, chunkOffsets.map(n => [number(wide ? 8 : 4, n)]));
  const stsc = table("stsc", 0, samplesPerChunk.map(([a, b]) => [u32(a), u32(b), u32(1)]));
  const stts = table("stts", 0, timing.map(([n, d]) => [u32(n), u32(d)]));
  const ctts = options.composition ? table("ctts", 1, options.composition.map(([n, t]) => [u32(n), number(4, t, true)])) : Buffer.alloc(0);
  const stbl = box("stbl", stsd, stsz, offsetTable, stsc, stts, ctts);
  const dref = full("dref", 0, u32(1), box("url ", u32(options.external ? 0 : 1)));
  const minf = box("minf", box("dinf", dref), stbl);
  const mdia = box("mdia", mdhd, handler(options.format ? "soun" : "sbtl"), minf);
  let edts = Buffer.alloc(0);
  if (options.edits) {
    const width = options.longEdits ? 8 : 4;
    edts = box("edts", table("elst", options.longEdits ? 1 : 0,
      options.edits.map(([duration, media]) => [number(width, duration), number(width, media, true), u32(65536)])));
  }
  return box("trak", tkhd, edts, mdia);
}

function fixture(opts = {}) {
  const ftyp = box("ftyp", Buffer.from("isom"), u32(0), Buffer.from("isom"));
  const intro = textSample("Не,\rсейчас.");
  const clear = textSample("");
  const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("Да.", "utf16le").swap16()]);
  const middle = textSample(bytes);
  const finish = opts.shortText ? Buffer.from([0, 12, 65]) : textSample("До свидания.");
  const other = textSample("Another speaker.");
  const gap = Buffer.alloc(opts.padding || 193);
  gap.set([21,22,23,31,32,33,34]);
  const payload = Buffer.concat([intro, clear, gap, other, middle, finish]);
  const base = ftyp.length + 8;
  const second = base + intro.length + clear.length + gap.length + other.length;
  const sizes = [intro.length, clear.length, middle.length, finish.length];
  const regularTiming = [[1, 20000], [1, 8000], [1, 30000], [1, 12000]];
  const firstTrack = mediaTrack(5, "rus", sizes, [opts.firstOffset ?? base, second],
    opts.groups || [[1, 2]], opts.timing || regularTiming, opts);
  const otherTrack = mediaTrack(8, "eng", [other.length], [second - other.length],
    [[1, 1]], [[1, 30000]], {fixed: other.length});
  const audioHead = Buffer.alloc(28);
  audioHead.writeUInt16BE(1, 6);
  audioHead.writeUInt16BE(2, 16);
  audioHead.writeUInt16BE(16, 18);
  audioHead.writeUInt32BE(48000 * 65536, 24);
  const opus = box("Opus", audioHead, box("dOps", Buffer.from([0,2]), u16(312), u32(48000), u16(0), Buffer.from([0])));
  const asc = Buffer.from(opts.badAsc ? [0x29, 0x90] : [0x11, 0x90]); // AAC-LC, 48 kHz, stereo.
  const descr = (tag, payload) => Buffer.concat([Buffer.from([tag, payload.length]), payload]);
  const dec = descr(4, Buffer.concat([Buffer.from([64, 21]), Buffer.alloc(11), descr(5, asc)]));
  const es = descr(3, Buffer.concat([Buffer.from([0, 1, 0]), dec]));
  const aac = box("mp4a", audioHead, full("esds", 0, es));
  const audio = mediaTrack(2, "ita", [3,4], [base + intro.length + clear.length], [[1,2]], [[2,960]],
    {format: opts.opus ? opus : aac, scale: 48000, edits: opts.audioEdits});
  const mvhd = full("mvhd", 0, Buffer.alloc(8), u32(2000), u32(12000), Buffer.alloc(80));
  const moov = box("moov", mvhd, audio, firstTrack, otherTrack);
  return new Blob([ftyp, box("mdat", payload), moov, ...(opts.fragmented ? [box("moof")] : [])]);
}

test("discovers both subtitle languages and an audio track, and selects the correct interleaved samples", async () => {
  const file = fixture({padding: 1024 * 1024});
  const ranges = [];
  const tracked = {size: file.size, slice(a, b) { ranges.push([a, b]); return file.slice(a, b); }};
  assert.deepEqual((await listTracks(tracked)).map(t => [t.id, t.language, t.codec]), [[2, "ita", "aac"], [5, "rus", "tx3g"], [8, "eng", "tx3g"]]);
  const progress = [];
  assert.deepEqual(await readCues(tracked, "5", {onProgress: p => progress.push(p)}), [
    {start: 0, end: 1000, text: "Не,\nсейчас."},
    {start: 1400, end: 2900, text: "Да."},
    {start: 2900, end: 3500, text: "До свидания."}
  ]);
  assert.deepEqual(await readCues(tracked, 8), [{start: 0, end: 1500, text: "Another speaker."}]);
  assert.equal(progress.at(-1), 1);
  assert.ok(ranges.every(([a,b]) => b - a < 2000), "read only metadata, headers and text, skipping bulk A/V data");
  await assert.rejects(readCues(tracked, 33), /not found/i);
});

test("32- and 64-bit edit lists with leading silence apply movie timescale and clip both ends", async () => {
  for (const longEdits of [false, true]) {
    const file = fixture({wide: true, longEdits, edits: [[2500, -1], [5000, 15000]]});
    assert.deepEqual(await readCues(file, 5), [
      {start: 1250, end: 1500, text: "Не,\nсейчас."},
      {start: 1900, end: 3400, text: "Да."},
      {start: 3400, end: 3750, text: "До свидания."}
    ]);
  }
});

test("applies signed CTTS offsets, with negative presentation clipped to zero", async () => {
  const file = fixture({wide: true, composition: [[1, -2000], [1, 0], [1, 4000], [1, 2000]]});
  const cues = await readCues(file, 5);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [[0,900], [1600,3100], [3000,3600]]);
});

test("rejects invalid ranges, sample counts, malformed text and external data", async () => {
  const cases = [
    [{firstOffset: 3}, /outside media data/],
    [{groups: [[1, 3]]}, /sample-to-chunk/],
    [{timing: [[3, 9000]]}, /incomplete subtitle sample times/],
    [{external: true}, /external .*data/],
    [{shortText: true}, /truncated/],
    [{edits: [[1000, 0], [2000, 40000]]}, /multiple media edits/]
  ];
  for (const [opts, error] of cases) await assert.rejects(readCues(fixture(opts), 5), error);
  const file = fixture();
  await assert.rejects(listTracks(file.slice(0, file.size - 3)), /truncated/);
  await assert.rejects(listTracks(fixture({fragmented: true})), /fragmented MP4/);
});

test("honors cancellation before accessing the file", async () => {
  const controller = new AbortController();
  controller.abort();
  const file = {size: 42, slice() { throw new Error("Unexpected read"); }};
  await assert.rejects(readCues(file, 5, {signal: controller.signal}), {name: "AbortError"});
});

test("demuxes AAC-LC and Opus configurations and packets with edited movie timestamps", async () => {
  for (const opus of [false, true]) {
    const file = fixture({opus, audioEdits: [[3000, -1], [60, 240]]});
    const [track] = await listTracks(file);
    assert.equal(track.kind, "audio");
    assert.equal(track.codec, opus ? "opus" : "aac");
    const packets = [];
    let config;
    await readAudioPackets(file, track, {onConfig: c => { config = c; }, onPacket: p => {
      packets.push([p.timestamp, p.duration, p.type, Array.from(p.data)]);
    }});
    assert.equal(config.sampleRate, 48000);
    assert.equal(config.numberOfChannels, 2);
    if (opus) {
      assert.equal(config.codec, "opus");
      const head = Buffer.from(config.description);
      assert.equal(head.toString("ascii",0,8), "OpusHead");
      assert.equal(head.readUInt16LE(10), 312);
    } else {
      assert.equal(config.codec, "mp4a.40.2");
      assert.deepEqual(Array.from(config.description), [0x11, 0x90]);
    }
    assert.deepEqual(packets, [[1495000,20000,"key",[21,22,23]], [1515000,20000,"key",[31,32,33,34]]]);
    await assert.rejects(readCues(file, track), /selected text track/);
  }
});

test("rejects unsupported AAC profile before delivering any packets", async () => {
  await assert.rejects(readAudioPackets(fixture({badAsc:true}), 2, {
    onConfig: () => assert.fail("unexpected config"),
    onPacket: () => assert.fail("unexpected packet")
  }), /unsupported AAC profile/);
});
