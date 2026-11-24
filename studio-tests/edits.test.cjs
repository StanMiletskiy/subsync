const { test } = require("node:test");
const assert = require("node:assert/strict");
const { align, mapTime } = require("../studio/align.js");

function movie(count) {
  let state = 12673, start = 10000;
  const sample = () => ((state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: count }, () => {
    const cue = { start, end: start + Math.round(650 + sample() * 3200) };
    start = cue.end + Math.round(330 + sample() ** 2 * 7600);
    return cue;
  });
}

function timeline(source, extraOffset) {
  return source.map(({ start, end }, i) => {
    const offset = 14700 + extraOffset(i);
    return { start: Math.round(1.001 * start + offset), end: Math.round(1.001 * end + offset) };
  });
}

function checkAll(source, expected, fit) {
  assert.equal(fit.reliable, true, JSON.stringify(fit));
  for (let i = 0; i < source.length; i++) {
    for (const edge of ["start", "end"]) {
      assert.ok(Math.abs(mapTime(fit, source[i][edge]) - expected[i][edge]) < 2, 'Cue ' + i + ' ' + edge);
    }
  }
}

function checkRange(fit, first, last) {
  assert.equal(fit.reliable, false, JSON.stringify(fit));
  assert.ok(fit.reviewRanges.some(r => r.startMs <= first.start && r.endMs >= last.end), JSON.stringify(fit));
}

test("corrects a late cut in a feature with FPS drift, sparse omissions and split lines", () => {
  const source = movie(1450), boundary = 1327;
  const expected = timeline(source, i => i >= boundary ? 8000 : 0);
  const reference = expected.flatMap(({start, end}, i) => {
    if (i % 29 === 0) return [];
    if (i % 5) return [{start, end}];
    const mid = Math.floor((start + end) / 2);
    return [{start, end: mid - 50}, {start: mid + 50, end}];
  });
  const fit = align(source, reference);
  checkAll(source, expected, fit);
  assert.equal(fit.edits.length, 1);
  assert.equal(fit.edits[0].sourceMs, source[boundary].start);
  assert.ok(fit.score > 0.8);
  assert.deepEqual(structuredClone(fit), fit);
});

test("corrects a temporary offset, including its negative change across a silent gap", () => {
  const source = movie(450).map((c, i) => i < 290 ? c : { start: c.start + 13000, end: c.end + 13000 });
  const expected = timeline(source, i => i >= 265 && i < 290 ? 6500 : 0);
  const fit = align(source, expected);
  checkAll(source, expected, fit);
  assert.deepEqual(fit.edits.map(e => Math.round(e.deltaMs)), [6500, -6500]);
});

test("marks the whole run of absent source lines alongside a supported edit", () => {
  const source = movie(410);
  const ref = timeline(source, i => i >= 200 ? 8400 : 0).filter((_, i) => i < 285 || i > 298);
  checkRange(align(source, ref), source[285], source[298]);
});

test("flags missing dialogue at a removal and an edit at a shared cue endpoint", () => {
  const source = movie(560), cut = 435, last = cut + 9;
  const jump = Math.round((source[last + 1].start - source[cut].start) * 1.001);
  const trimmed = timeline(source, i => i > last ? -jump : 0).filter((_, i) => i < cut || i > last);
  checkRange(align(source, trimmed), source[cut], source[last]);
  const contiguous = source.map((c, i) => i === cut - 1 ? { ...c, end: source[cut].start } : c);
  const fit = align(contiguous, timeline(contiguous, i => i >= cut ? 8000 : 0));
  checkRange(fit, contiguous[cut - 1], contiguous[cut]);
});

test("checks a short run at either edge even after correcting a larger edit", () => {
  const source = movie(590);
  for (const middleEdit of [false, true]) {
    for (const head of [true, false]) {
      const ref = timeline(source, i => (middleEdit && i >= 310 ? 8500 : 0) +
        ((head ? i < 2 : i >= source.length - 3) ? 7200 : 0));
      const first = head ? 0 : source.length - 3, last = head ? 1 : source.length - 1;
      checkRange(align(source, ref), source[first], source[last]);
    }
  }
  const reference = timeline(source, () => 0).slice(1);
  assert.equal(align(source, reference).reliable, true);
});

test("uses a local warning for an audio-only edit near the end", () => {
  const source = movie(650), cut = 575, ref = timeline(source, i => i >= cut ? 8100 : 0);
  const activity = new Float32Array(Math.ceil(ref.at(-1).end / 100) + 40);
  for (const {start, end} of ref) activity.fill(1, Math.ceil(start / 100), Math.floor(end / 100));
  const fit = align(source, { activity, stepMs: 100 });
  assert.equal(fit.reliable, false);
  assert.ok(fit.reviewRanges.some(r => r.startMs < source[cut + 8].end && r.endMs >= source[cut].start));
});
