const { test } = require("node:test");
const assert = require("node:assert/strict");
const { align } = require("../studio/align.js");

function random(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function dialogue(count, seed = 42, first = 1500) {
  const next = random(seed);
  const cues = [];
  let start = first;
  for (let i = 0; i < count; i++) {
    const end = start + Math.round(650 + next() * 2680);
    cues.push({ start, end, text: "Original line " + i });
    start = end + Math.round(140 + next() ** 2 * 2700 + (i % 15 === 0 ? next() * 4300 : 0));
  }
  return cues;
}

function mapped(cues, scale, offset) {
  return cues.map(c => ({ start: Math.round(scale * c.start + offset), end: Math.round(scale * c.end + offset), text: "Другая реплика" }));
}

function check(result, cues, scale, offset, tolerance = 10) {
  assert.equal(result.reliable, true, JSON.stringify(result));
  for (const t of [cues[0].start, cues.at(-1).end]) {
    const err = Math.abs(result.scale * t + result.offsetMs - (scale * t + offset));
    assert.ok(err <= tolerance, "Error " + err + " ms: " + JSON.stringify(result));
  }
}

test("recovers a positive offset to the millisecond across languages", () => {
  const cues = dialogue(45);
  check(align(cues, mapped(cues, 1, 223121)), cues, 1, 223121, 1);
});

test("recovers 23.976/25 conversion and a large negative offset", () => {
  const cues = dialogue(210, 82, 398000);
  const scale = 25025 / 24000, offset = -300000;
  check(align(cues, mapped(cues, scale, offset)), cues, scale, offset, 2);
});

test("different segmentation and missing reference cues still give accurate drift", () => {
  const cues = dialogue(160, 283);
  const scale = 1.01347, offset = 78600;
  const ref = mapped(cues, scale, offset).flatMap((c, i) => {
    if (i % 8 === 0) return [];
    if (i % 3 !== 0) return [c];
    const mid = Math.floor((c.start + c.end) / 2);
    return [{ start: c.start, end: mid - 60 }, { start: mid + 60, end: c.end }];
  });
  check(align(cues, ref), cues, scale, offset, 50);
});

test("matches a part inside a larger SRT with a misleading intro", () => {
  const cues = dialogue(120, 85);
  const ref = [...dialogue(55, 106), ...mapped(cues, 1.00077, 310000)];
  check(align(cues, ref), cues, 1.00077, 310000, 5);
});

test("syncs feature-length audio activity with noisy starts, pauses and music bursts", () => {
  const cues = dialogue(1950, 217);
  const scale = 0.97777, offset = 63569, stepMs = 100;
  const ref = mapped(cues, scale, offset), next = random(108);
  const activity = Float32Array.from({ length: Math.ceil(ref.at(-1).end / stepMs) + 60 }, () => 0.1 + next() * 0.32);
  for (const [i, c] of ref.entries()) {
    if (i % 15 === 0) continue;
    for (let j = Math.ceil((c.start + 100) / stepMs); j < (c.end - 120) / stepMs; j++) {
      activity[j] += 0.12 + next() * 0.40;
    }
  }
  for (let i = 0; i < activity.length; i++) if (i % 299 < 19) activity[i] = 0.92;
  check(align(cues, { activity, stepMs }), cues, scale, offset, 210);
});

test("declines silence, unrelated releases, and strictly recurring cues", () => {
  const cues = dialogue(120, 9);
  assert.equal(align(cues, { activity: new Float32Array(9000), stepMs: 100 }).reliable, false);
  assert.equal(align(cues, dialogue(140, 48)).reliable, false);
  const repeated = Array.from({ length: 65 }, (_, i) => ({ start: i * 3800, end: i * 3800 + 1700 }));
  assert.equal(align(repeated, mapped(repeated, 1, 15000)).reliable, false);
  assert.equal(align([], []).reliable, false);
});

test("declines two equally good occurrences of the same passage", () => {
  const cues = dialogue(45, 174);
  const refs = [...mapped(cues, 1, 5800), ...mapped(cues, 1, 250000)];
  assert.equal(align(cues, refs).reliable, false);
});

test("flags a cut in the middle instead of accepting just the matching section", () => {
  const cues = dialogue(300, 58);
  const ref = [...mapped(cues.slice(0, 200), 1, 15000), ...mapped(cues.slice(200), 1, 49000)];
  assert.equal(align(cues, ref).reliable, false);
});

test("short excerpts require a much stronger match than film-length subtitles", () => {
  for (const length of [4, 8, 12]) {
    for (let i = 0; i < 12; i++) {
      const cues = dialogue(length, 9124 + i * 6741);
      assert.equal(align(cues, dialogue(length, 65646 + i * 24621)).reliable, false);
      check(align(cues, mapped(cues, 1, 4700)), cues, 1, 4700, 2);
    }
  }
});
