const { test } = require("node:test");
const assert = require("node:assert/strict");
const { align, mapTime } = require("../studio/align.js");

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

test("aligns both sides of a clearly supported 34-second edit", () => {
  const cues = dialogue(300, 58);
  const ref = [...mapped(cues.slice(0, 200), 1, 15000), ...mapped(cues.slice(200), 1, 49000)];
  const result = align(cues, ref);
  assert.equal(result.reliable, true, JSON.stringify(result));
  for (const [i, cue] of cues.entries()) {
    assert.ok(Math.abs(mapTime(result, cue.start) - ref[i].start) <= 2);
    assert.ok(Math.abs(mapTime(result, cue.end) - ref[i].end) <= 2);
  }
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

// Two subtitle editions can say the same thing in different words and set each
// cue's in and out points independently. Only the test knows their correspondence.
function independentTrack(seed = 719) {
  const draw = random(seed), source = [], target = [];
  const clock = time => Math.round(15940 + 1.0011 * time);
  const jitter = () => Math.round((draw() - 0.5) * 740);
  let start = 7800;
  for (let i = 0; i < 180; i++) {
    const end = start + 1450 + Math.floor(draw() * 1600);
    source.push({start, end, text:"A source dialogue line."});
    target.push({start:clock(start) + jitter(), end:clock(end) + jitter(), text:"別の言語の台詞。"});
    const pause = i % 20 === 16 ? 6200 : 0;
    start = end + 1100 + Math.floor(draw() * 2100) + pause;
  }
  return {source, target, clock};
}

function boundaryErrors(fit, source, target, indices) {
  return indices.flatMap(i => ["start","end"].map(edge =>
    Math.abs(Math.round(mapTime(fit, source[i][edge])) - target[i][edge])));
}

function assertOrderedOutput(fit, source) {
  let previousEnd = -1;
  for (const cue of source) {
    const start = Math.round(mapTime(fit, cue.start)), end = Math.round(mapTime(fit, cue.end));
    assert.ok(start >= previousEnd && end > start, "Lost cue order or a positive duration");
    previousEnd = end;
  }
}

test("uses independently timed matching dialogue instead of leaving cross-language cue boundaries on the global clock", () => {
  const {source, target, clock} = independentTrack();
  const indices = source.map((_, i) => i);
  for (const [a, b] of [[source,target], [target,source]]) {
    const fit = align(a, b);
    assert.equal(fit.reliable, true);
    assertOrderedOutput(fit, a);
    for (const [t, step] of [[a[0].start,-1],[a.at(-1).end,1]]) {
      const change = (mapTime(fit,t + step) - mapTime(fit,t)) * step;
      assert.ok(change >= 0 && change <= 2, "Continue the timeline through either track edge");
    }
    const errors = boundaryErrors(fit, a, b, indices).sort((x,y) => x-y);
    const initial = indices.flatMap(i => ["start","end"].map(edge => Math.abs(clock(source[i][edge]) - target[i][edge])));
    assert.ok(initial.reduce((sum, e) => sum + e, 0) / initial.length > 140);
    assert.ok(errors[Math.floor(errors.length * 0.9)] <= 35, "Most verified in/out points should follow their reference");
    assert.ok(errors.reduce((sum, e) => sum + e, 0) / errors.length < 45, "Correct the timing itself");
  }
});

test("equal cue totals with compensating insertions and deletions do not shift subsequent dialogue by one slot", () => {
  const {source, target, clock} = independentTrack(240);
  const omitted = new Set([23,111]);
  const ref = target.flatMap((cue, i) => {
    if (omitted.has(i)) return [];
    if (i !== 56 && i !== 136) return [cue];
    return [cue,{start:cue.end + 1700, end:cue.end + 2900, text:"[doorbell]"}];
  });
  assert.equal(ref.length, source.length);
  const fit = align(source, ref);
  assert.equal(fit.reliable, true);
  assertOrderedOutput(fit, source);
  const interior = source.map((_,i) => i).filter(i => (i >= 27 && i <= 52) || (i >= 115 && i <= 132));
  const errors = boundaryErrors(fit, source, target, interior).sort((a,b) => a-b);
  assert.ok(errors[Math.floor(errors.length * 0.85)] <= 45, "Retain established correspondence across both insertions");
  for (const i of omitted) {
    for (const edge of ["start","end"]) assert.ok(Math.abs(mapTime(fit,source[i][edge])-clock(source[i][edge])) < 650);
  }
});

test("a merged pair and a split line cannot drag a source cue onto a partial or combined reference event", () => {
  const {source, target, clock} = independentTrack(820);
  const ref = target.flatMap((cue, i) => {
    if (i === 42) return [{...cue, end:target[43].end}];
    if (i === 43) return [];
    if (i !== 118) return [cue];
    const middle = Math.floor((cue.start + cue.end) / 2);
    return [{...cue, end:middle-45},{...cue, start:middle+45}];
  });
  assert.equal(source.length, ref.length);
  const fit = align(source, ref);
  assert.equal(fit.reliable, true);
  assertOrderedOutput(fit, source);
  for (const i of [42,43,118]) {
    for (const edge of ["start","end"]) assert.ok(Math.abs(mapTime(fit,source[i][edge])-clock(source[i][edge])) < 650,
      "A reference-only internal boundary or combined duration is not an identified source boundary");
  }
  const unaffected = source.map((_, i) => i).filter(i => i >= 50 && i < 110);
  const outside = boundaryErrors(fit, source, target, unaffected).sort((a,b) => a-b);
  assert.ok(outside[Math.floor(outside.length * 0.85)] <= 45, "Clear cues away from the split and merge still benefit");
  assert.ok(fit.score < 1, "Activity differs at the ambiguous cuts");
});

test("equal-length unrelated and strictly repetitive subtitle tracks cannot validate their own ordinal pairing", () => {
  const {source} = independentTrack(520);
  const different = dialogue(source.length, 126583, 35000).map(cue => ({...cue,text:"Чужой текст."}));
  assert.equal(align(source,different).reliable,false);
  const repeated = source.map((_,i) => ({start:3000+i*4600,end:5000+i*4600}));
  const jitter = random(53);
  const shifted = repeated.map(cue => ({start:17510+cue.start+Math.floor(jitter()*160),end:17510+cue.end+Math.floor(jitter()*160)}));
  assert.equal(align(repeated, shifted).reliable,false);
});

test("a reference-only near-duplicate cannot determine the time of its contested cue", () => {
  const {source, target} = independentTrack(948);
  const disputed = 80;
  const reference = target.flatMap((cue, i) => i === disputed ?
    [{...cue, start:cue.start - 45, end:cue.end - 45}, {...cue, start:cue.start + 45, end:cue.end + 45}] : [cue]);
  const fit = align(source, reference);
  assert.equal(fit.reliable, true);
  for (const edge of ["start","end"]) {
    const time = source[disputed][edge];
    // Both reference candidates have the same shape and nearly the same time.
    // The previously established clock is the only independent estimate here.
    assert.ok(Math.abs(mapTime(fit,time) - (fit.scale * time + fit.offsetMs)) <= 2);
  }
  const supported = source.map((_,i) => i).filter(i => Math.abs(i - disputed) > 3);
  const errors = boundaryErrors(fit, source, target, supported).sort((a,b) => a-b);
  assert.ok(errors[Math.floor(errors.length * 0.85)] <= 45);
  assertOrderedOutput(fit, source);
});

test("a perfect global offset earns 100% from the actual exported times without claiming local cue corrections", () => {
  const source = dialogue(90, 486);
  const reference = mapped(source, 1, 8937);
  const fit = align(source, reference);
  const indices = source.map((_,i) => i);
  assert.equal(fit.reliable, true);
  assert.ok(boundaryErrors(fit, source, reference, indices).every(error => error === 0));
  assert.equal(fit.score, 1);
  assert.equal(fit.exactTimings, true);
  assert.ok(!fit.matchedTimings, "A perfect global correction did not need per-cue adjustments");
  const duplicate = reference.flatMap((cue, i) => i === 24 ? [cue, {...cue}] : [cue]);
  assert.notEqual(align(source, duplicate).exactTimings, true, "Equal activity alone does not prove equal cue boundaries");
});
