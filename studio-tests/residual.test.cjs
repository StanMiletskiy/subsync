const { test } = require("node:test");
const assert = require("node:assert/strict");
const { align, mapTime } = require("../studio/align.js");

function tracks(shift, transform = cues => cues) {
  let seed = 12, time = 0;
  const random = () => ((seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) / 4294967296);
  const source = Array.from({ length: 270 }, () => {
    time += 850 + Math.round(random() * 4000);
    const start = time;
    time += 900 + Math.round(random() * 2600);
    return { start, end: time };
  });
  const target = source.map(({ start, end }, i) => {
    const offset = 3000 + shift(i);
    return { start: start + offset, end: end + offset };
  });
  return { source, target, reference: transform(target) };
}

test("independently confirmed subsecond sections improve actual cue boundaries across languages", () => {
  for (const delta of [450, -390]) {
    const { source, reference, target } = tracks(i => i >= 81 && i < 151 ? delta : 0, cues =>
      cues.flatMap((cue, i) => {
        if (i === 98 || i === 127) return [];
        if (i === 116) {
          const mid = Math.round((cue.start + cue.end) / 2);
          return [{ start: cue.start, end: mid - 35 }, { start: mid + 35, end: cue.end }];
        }
        return [cue];
      }));
    const fit = align(source, reference);
    assert.equal(fit.reliable, true);
    assert.deepEqual(fit.edits.map(edit => edit.sourceMs), [source[81].start, source[151].start]);
    assert.deepEqual(fit.reviewRanges, []);
    assert.ok(fit.score > 0.98);
    for (const [i, cue] of source.entries()) {
      for (const edge of ["start", "end"]) {
        assert.ok(Math.abs(mapTime(fit, cue[edge]) - target[i][edge]) <= 2);
      }
    }
  }
});

test("isolated disagreements, alternate-cue offsets and duplicated reference cues cannot establish a shift", () => {
  const inSection = i => i >= 81 && i < 151;
  const cases = [
    tracks(i => i === 100 ? 450 : 0),
    tracks(i => inSection(i) && i % 2 === 0 ? 450 : 0),
    tracks(i => inSection(i) ? 450 : 0, cues => cues.flatMap((c, i) => inSection(i) ?
      [c, { start: c.start + 25, end: c.end + 25 }] : [c])),
    tracks(i => i % 9 === 0 ? 340 : i % 5 === 0 ? -280 : 0),
  ];
  for (const {source, reference} of cases) {
    const fit = align(source, reference);
    assert.equal(fit.reliable, true);
    assert.deepEqual(fit.edits, []);
  }
});
