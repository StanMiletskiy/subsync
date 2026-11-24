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

test("exports a confirmed correction alongside a separate run of absent lines", () => {
  const source = movie(410);
  const expected = timeline(source, i => i >= 200 ? 8400 : 0);
  const fit = align(source, expected.filter((_, i) => i < 285 || i > 298));
  checkRange(fit, source[285], source[298]);
  checkAll(source, expected, fit);
});

test("rejects an impossible scene removal and bridges a shared cue endpoint", () => {
  const source = movie(560), cut = 510, last = cut + 9;
  const jump = Math.round((source[last + 1].start - source[cut].start) * 1.001);
  const trimmed = timeline(source, i => i > last ? -jump : 0).filter((_, i) => i < cut || i > last);
  const removal = align(source, trimmed);
  assert.equal(removal.reliable, false);
  assert.deepEqual(removal.edits, []);
  checkRange(removal, source[cut], source.at(-1));
  const contiguous = source.map((c, i) => i === cut - 1 ? { ...c, end: source[cut].start } : c);
  const fit = align(contiguous, timeline(contiguous, i => i >= cut ? 8000 : 0));
  assert.equal(fit.reliable, true);
  assert.equal(fit.edits.length, 1);
  assert.ok(fit.edits[0].bridge);
  checkRange(fit, contiguous[cut - 1], contiguous[cut]);
});

test("checks a short run at either edge even after correcting a larger edit", () => {
  const source = movie(590);
  for (const middleEdit of [false, true]) {
    for (const head of [true, false]) {
      const ref = timeline(source, i => (middleEdit && i >= 310 ? 8500 : 0) +
        ((head ? i < 2 : i >= source.length - 3) ? 7200 : 0));
      const first = head ? 0 : source.length - 3, last = head ? 1 : source.length - 1;
      const fit = align(source, ref);
      assert.equal(fit.reliable, true);
      assert.equal(fit.edits.length, middleEdit ? 1 : 0);
      checkRange(fit, source[first], source[last]);
    }
  }
  const reference = timeline(source, () => 0).slice(1);
  assert.equal(align(source, reference).reliable, true);
});

function audioFrom(cues) {
  const activity = new Float32Array(Math.ceil(cues.at(-1).end / 100) + 40);
  for (const {start, end} of cues) activity.fill(1, Math.ceil(start / 100), Math.floor(end / 100));
  return { activity, stepMs: 100 };
}

test("a sustained audio tail corrects every cue across a well-supported cut", () => {
  const cut = 575;
  for (const jump of [8100, -8300]) {
    const source = movie(650).map((c, i) => i < cut || jump > 0 ? c : {start: c.start + 12000, end: c.end + 12000});
    const expected = timeline(source, i => i >= cut ? jump : 0);
    const fit = align(source, audioFrom(expected));
    assert.equal(fit.reliable, true);
    assert.equal(fit.edits.length, 1);
    assert.equal(fit.edits[0].sourceMs, source[cut].start);
    assert.ok(fit.score > 0.95);
    for (const [i, cue] of source.entries()) {
      for (const edge of ["start", "end"]) assert.ok(Math.abs(mapTime(fit, cue[edge]) - expected[i][edge]) < 150);
    }
  }
});

test("an unplaceable sustained audio cut is declined while brief mismatches remain exportable", () => {
  const cut = 575, source = movie(650);
  const overlapping = timeline(source, i => i >= cut ? -8300 : 0);
  const unsafe = align(source, audioFrom(overlapping));
  assert.equal(unsafe.reliable, false);
  assert.deepEqual(unsafe.edits, []);
  const temporary = timeline(source, i => i >= 575 && i < 582 || i >= 647 ? 8100 : 0);
  const brief = align(source, audioFrom(temporary));
  assert.equal(brief.reliable, true);
  assert.deepEqual(brief.edits, []);
});

test("keeps every supported section before and after a cut with a shared endpoint", () => {
  const source = movie(850);
  for (const early of [true, false]) {
    const uncertain = early ? 19 : 812, clear = early ? 610 : 340;
    const copied = source.map((c, i) => i === uncertain - 1 ? { ...c, end: source[uncertain].start } : c);
    const expected = timeline(copied, i => (i >= uncertain ? 6300 : 0) + (i >= clear ? 8900 : 0));
    const fit = align(copied, expected);
    assert.equal(fit.reliable, true, JSON.stringify(fit));
    assert.deepEqual(fit.edits.filter(e => !e.bridge).map(e => e.sourceMs), [copied[clear].start]);
    assert.equal(fit.edits.filter(e => e.bridge).length, 1);
    checkRange(fit, copied[uncertain - 1], copied[uncertain]);
    for (const [i, cue] of copied.entries()) {
      const duration = mapTime(fit, cue.end) - mapTime(fit, cue.start);
      assert.ok(Math.abs(duration - (cue.end - cue.start) * fit.scale) < 0.01);
      if (i >= uncertain - 3 && i <= uncertain + 2) continue;
      for (const edge of ["start", "end"])
        assert.ok(Math.abs(mapTime(fit, cue[edge]) - expected[i][edge]) < 2);
    }
  }
});

test("bridges both offset directions across missing boundary dialogue in real gaps only", () => {
  const source = movie(800), cut = 660;
  for (const change of [-6400, 8900]) {
    const expected = timeline(source, i => (i >= 300 ? 8400 : 0) + (i >= cut ? change : 0));
    const fit = align(source, expected.filter((_, i) => i < cut - 4 || i > cut + 4));
    assert.equal(fit.reliable, true, JSON.stringify(fit));
    assert.deepEqual(fit.edits.map(e => Math.round(e.deltaMs)), [8400, change]);
    assert.ok(fit.edits[1].bridge);
    let previousEnd = 0;
    for (const [i, cue] of source.entries()) {
      const start = mapTime(fit, cue.start), end = mapTime(fit, cue.end);
      assert.ok(start >= previousEnd);
      assert.ok(Math.abs(end - start - (cue.end - cue.start) * fit.scale) < 0.01);
      previousEnd = end;
      if (i >= cut - 4 && i <= cut + 4) continue;
      assert.ok(Math.abs(start - expected[i].start) < 2 && Math.abs(end - expected[i].end) < 2);
    }
  }
});

test("retains a late edit across split captions, a missing boundary line and subtitle jitter", () => {
  const source = movie(950), cut = 805;
  const expected = timeline(source, i => i >= cut ? 8400 : 0);
  const reference = expected.flatMap((c, i) => {
    if (i === cut - 1 || i % 31 === 0) return [];
    const delta = Math.round(150 * Math.sin(i * 12.23));
    const start = c.start + delta, end = c.end + delta;
    if (i % 7) return [{ start, end }];
    const mid = Math.floor((start + end) / 2);
    return [{ start, end: mid - 60 }, { start: mid + 60, end }];
  });
  const fit = align(source, reference);
  assert.equal(fit.reliable, true, JSON.stringify(fit));
  assert.equal(fit.edits.length, 1);
  for (const [i, cue] of source.entries()) {
    if (i >= cut - 1 && i <= cut + 1) {
      checkRange(fit, cue, cue);
      continue;
    }
    assert.ok(Math.abs(mapTime(fit, cue.start) - expected[i].start) < 150);
    assert.ok(Math.abs(mapTime(fit, cue.end) - expected[i].end) < 150);
  }
});

test("one identifiable part cannot qualify an otherwise unrelated full track", () => {
  const source = movie(520), expected = timeline(source, () => 0);
  const reference = expected.map((c, i) => i < 120 ? c : {
    start: c.start + Math.round((0.5 + Math.sin(i * 8.31)) * 5700),
    end: c.start + Math.round((0.5 + Math.sin(i * 8.31)) * 5700) + 940
  });
  assert.equal(align(source, reference).reliable, false);
});
