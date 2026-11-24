const test = require("node:test");
const assert = require("node:assert/strict");
const { listTracks, readCues, readAudioPackets } = require("../studio/mkv.js");

// Small EBML builder. Each fixture controls element order, widths, lacing, and timing explicitly.
const cat = (...parts) => Buffer.concat(parts);
const hex = s => Buffer.from(s, "hex");
function size(n, width = 1) {
  while (n >= 2 ** (7 * width) - 1) width++;
  const out = Buffer.alloc(width);
  out.writeUIntBE(n, 0, width);
  out[0] |= 1 << (8 - width);
  return out;
}
function element(id, ...children) {
  const data = cat(...children);
  return cat(hex(id), size(data.length), data);
}
function uint(id, v) {
  const width = Math.max(1, Math.ceil(Math.log2(v + 1) / 8));
  const value = Buffer.alloc(width); value.writeUIntBE(v, 0, width);
  return element(id, value);
}
function float(id, v) {
  const value = Buffer.alloc(8); value.writeDoubleBE(v);
  return element(id, value);
}
const str = (id, s) => element(id, Buffer.from(s));
const track = (id, type, codec, ...rest) =>
  element("ae", uint("d7", id), uint("83", type), str("86", codec), ...rest);
const block = (tag, id, rel, flags, bytes) => {
  const header = Buffer.alloc(3); header.writeInt16BE(rel); header[2] = flags;
  return element(tag, size(id), header, Buffer.from(bytes));
};
const group = (id, rel, len, text) => element("a0", uint("9b", len), block("a1", id, rel, 0, text));
const unknown = (id, ...body) => cat(hex(id), hex("01ffffffffffffff"), ...body);
const file = (...elems) => new Blob([element("1a45dfa3"), unknown("18538067", ...elems)]);
const info = scale => element("1549a966", uint("2ad7b1", scale));

test("enumerates supported tracks, skips bitmap tracks, honors language priority and clean ASS text", async () => {
  const tracks = element("1654ae6b", track(1, 1, "V_AV1"), track(2, 17, "S_HDMV/PGS"),
    track(130, 17, "S_TEXT/ASS", str("536e", "Full"), str("22b59d", "ru-RU"), str("22b59c", "rus"), float("23314f", 0.5)),
    track(4, 17, "S_TEXT/WEBVTT"));
  const src = file(tracks, info(2000000),
    unknown("1f43b675", group(130, -100, 50, "0,0,Default,,0,0,0,,{\\i1}Да,\\Nещё"),
      uint("e7", 1000), group(4, 15, 75, "hello <b>there</b>")),
    unknown("1f43b675", uint("e7", 2000), group(130, 0, 20, "1,0,Default,,0,0,0,,Всё.")));
  const choices = await listTracks(src);
  assert.deepEqual(choices.map(t => [t.id, t.language, t.kind]), [[130, "ru-RU", "text"], [4, "eng", "text"]]);
  assert.match(choices[0].label, /Full/);
  const progress = [];
  assert.deepEqual(await readCues(src, "130", { onProgress: n => progress.push(n) }), [
    { start: 1900, end: 1950, text: "Да,\nещё" }, { start: 4000, end: 4020, text: "Всё." },
  ]);
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), 1);
  assert.deepEqual(await readCues(src, 4), [{ start: 2030, end: 2180, text: "hello <b>there</b>" }]);
});

test("uses DefaultDuration, next timestamp, and codec delay without manufacturing final cue ends", async () => {
  const tracks = element("1654ae6b", track(1, 17, "S_TEXT/UTF8", uint("23e383", 150000000), uint("56aa", 100000000)),
    track(2, 17, "S_TEXT/UTF8"));
  const src = file(info(1000000), tracks, element("1f43b675", uint("e7", 100),
    block("a3", 1, -50, 0, "A"), block("a3", 2, -10, 0, "B"), block("a3", 2, 10, 0, "C")));
  assert.deepEqual(await readCues(src, 1), [{ start: 0, end: 100, text: "A" }]);
  assert.deepEqual(await readCues(src, 2), [{ start: 90, end: 110, text: "B" }]);
});
test("strips WebM VTT cue ID and layout without losing multiline text", async () => {
  const src = file(info(1000000), element("1654ae6b", track(1,17,"D_WEBVTT/CAPTIONS")),
    element("1f43b675", uint("e7",0), group(1,10,50,"scene-2\nalign:start\nFirst\nSecond")));
  assert.deepEqual(await readCues(src,1), [{start:10,end:60,text:"First\nSecond"}]);
});

test("looks past unknown-size clusters before Tracks and seeks across large video blocks", async () => {
  const src = file(info(1000000), unknown("1f43b675", uint("e7", 200),
    block("a3", 1, 0, 0, Buffer.alloc(5 * 1024 * 1024)), group(2, 0, 175, "a")),
    element("1654ae6b", track(2, 17, "S_TEXT/UTF8")));
  let totalBytes = 0, maxRead = 0;
  const instrumented = { size: src.size, slice(a, b) {
    const part = src.slice(a,b); totalBytes += part.size; maxRead = Math.max(part.size, maxRead); return part;
  } };
  const list = await listTracks(instrumented);
  assert.deepEqual(await readCues(instrumented, list[0].id), [{ start: 200, end: 375, text: "a" }]);
  assert.ok(maxRead <= 256 * 1024); assert.ok(totalBytes < 2 * 1024 * 1024);
});
test("explains unsupported, empty, malformed and cancelled inputs", async () => {
  const pgs = file(element("1654ae6b", track(1,17,"S_HDMV/PGS")));
  await assert.rejects(listTracks(pgs), /PGS/);
  const invalid = file(element("1654ae6b", track(1,17,"S_TEXT\/UTF8")), hex("a31fffffff"));
  await assert.rejects(readCues(invalid, 1), /truncated/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listTracks(pgs,{signal:controller.signal}), {name:"AbortError"});
  const empty = file(element("1654ae6b", track(1,17,"S_TEXT/UTF8")));
  await assert.rejects(readCues(empty,1), /no readable subtitle cues/);
});
const audioTrack = () => track(2, 2, "A_AAC", element("63a2", hex("1190")),
  element("e1", float("b5", 48000), uint("9f", 2)));
test("streams AAC-LC with fixed, EBML and Xiph lacing; honors decoder backpressure", async () => {
  const bytes = ["aabb", "ccdd", "e0e1", "a0a1", "b0b1b2", "c0", "ff", "0102", "39"];
  const src = file(info(1000000), element("1654ae6b", audioTrack()),
    element("1f43b675", uint("e7", 1000),
      block("a3", 2, -100, 4, hex("02aabbccdde0e1")),
      block("a3", 2, 100, 6, hex("0282c0a0a1b0b1b2c0")),
      block("a3", 2, 200, 2, hex("020102ff010239"))));
  const [t] = await listTracks(src); assert.equal(t.kind,"audio");
  const output = []; let configured = false;
  await readAudioPackets(src,t,{ async onConfig(c) { await Promise.resolve(); configured=true;
    assert.deepEqual([c.codec,c.numberOfChannels,c.sampleRate],["mp4a.40.2",2,48000]); },
    async onPacket(p) { await Promise.resolve(); assert.equal(configured,true); output.push(p); } });
  assert.deepEqual(output.map(p=>Buffer.from(p.data).toString("hex")), bytes);
  assert.deepEqual(output.map(p=>p.timestamp), [900000,921333,942667,1100000,1121333,1142667,1200000,1221333,1242667]);
  assert.ok(output.every(p=>p.type==="key" && p.duration===21333));
});

test("emits Opus variable packet timings and rejects malformed audio lacing", async () => {
  const opr = track(5,2,"A_OPUS",element("63a2",cat(Buffer.from("OpusHead"),hex("0101380180bb0000000000"))),
    element("e1",float("b5",48000),uint("9f",1)));
  const src = file(info(1000000), element("1654ae6b",opr),element("1f43b675",uint("e7",0),
    block("a3",5,0,2,hex("0201020080005303"))));
  const durations=[];
  await readAudioPackets(src,5,{onConfig:c=>assert.equal(c.codec,"opus"),
    onPacket:p=>durations.push([p.timestamp,p.duration])});
  assert.deepEqual(durations,[[0,10000],[10000,2500],[12500,120000]]);
  const invalid = file(info(1000000), element("1654ae6b",audioTrack()),
    element("1f43b675",uint("e7",0),block("a3",2,0,4,hex("02aabb"))));
  await assert.rejects(readAudioPackets(invalid,2,{onConfig(){}, onPacket(){}}), /truncated/);
});
