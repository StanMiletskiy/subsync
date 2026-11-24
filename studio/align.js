/* Original browser rewrite. SPDX-License-Identifier: GPL-3.0-or-later */
// All times are in milliseconds.
(function (root) {
  "use strict";

  const commonRates = [1, 24 / 25, 25 / 24, 24000 / 25025, 25025 / 24000, 1000 / 1001, 1001 / 1000];
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const failure = reason => ({ offsetMs: 0, scale: 1, score: 0, reliable: false, edits: [], reviewRanges: [], reason });

  function ordered(cues) {
    return cues.filter(c => c && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
      .sort((a, b) => a.start - b.start);
  }

  function extent(cues) {
    return [cues[0].start, cues.reduce((v, c) => Math.max(v, c.end), cues[0].end)];
  }

  function cueActivity(cues, step) {
    const [origin, end] = extent(cues);
    const values = new Float32Array(Math.ceil((end - origin) / step) + 1);
    const delta = new Int32Array(values.length + 1);
    for (const cue of cues) {
      const a = (cue.start - origin) / step, b = (cue.end - origin) / step;
      const i = Math.floor(a), j = Math.floor(b);
      if (i === j) {
        values[i] += b - a;
        continue;
      }
      values[i] += i + 1 - a;
      values[j] += b - j;
      delta[i + 1]++;
      delta[j]--;
    }
    let active = 0;
    for (let i = 0; i < values.length; i++) {
      active += delta[i];
      values[i] = Math.min(1, active + values[i]);
    }
    return { values, origin };
  }

  function audioActivity(ref, step) {
    const width = step / ref.stepMs;
    if (width === 1) return { values: ref.activity, origin: 0 };
    const values = new Float32Array(Math.ceil(ref.activity.length / width));
    for (let i = 0; i < values.length; i++) {
      const a = i * width, b = Math.min((i + 1) * width, ref.activity.length);
      for (let j = Math.floor(a); j < b; j++) {
        values[i] += ref.activity[j] * (Math.min(b, j + 1) - Math.max(a, j)) / (b - a);
      }
    }
    return { values, origin: 0 };
  }

  // A regularly repeated motif cannot identify a unique release offset.
  function hasRepeatingPattern(cues) {
    for (let lag = 1; lag <= Math.min(12, Math.floor((cues.length - 1) / 3)); lag++) {
      let matches = 0;
      const count = cues.length - lag - 1;
      for (let i = 0; i < count; i++) {
        const a = cues[i], b = cues[i + lag];
        const gapA = cues[i + 1].start - a.start, gapB = cues[i + lag + 1].start - b.start;
        if (Math.abs(gapA - gapB) < 80 && Math.abs((a.end - a.start) - (b.end - b.start)) < 80) matches++;
      }
      if (matches / count >= 0.95) return true;
    }
    return false;
  }

  // Radix-2 FFT. One transform of the entire reference is shared by all windows.
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size >> 1, theta = (inverse ? 2 : -2) * Math.PI / size;
      const c = Math.cos(theta), s = Math.sin(theta);
      for (let base = 0; base < n; base += size) {
        let wr = 1, wi = 0;
        for (let j = 0; j < half; j++) {
          const a = base + j, b = a + half;
          const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const nr = wr * c - wi * s;
          wi = wr * s + wi * c; wr = nr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) re[i] /= n;
  }

  function findWindows(cues, source, ref, step) {
    // A short excerpt stays identifiable even with an unknown 24/25 fps conversion.
    const length = Math.min(ref.values.length, Math.max(1, Math.min(
      Math.round(37000 / step), Math.round(source.values.length * 0.52))));
    if (length < 12) return [];
    const n = 2 ** Math.ceil(Math.log2(ref.values.length + length));
    const reRef = new Float64Array(n), imRef = new Float64Array(n);
    const sum = new Float64Array(ref.values.length + 1), sq = new Float64Array(sum.length);
    for (let i = 0; i < ref.values.length; i++) {
      const v = ref.values[i];
      reRef[i] = v; sum[i + 1] = sum[i] + v; sq[i + 1] = sq[i] + v * v;
    }
    fft(reRef, imRef, false);
    const windows = [];
    let previous = -Infinity;
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let k = 0; k < 11; k++) {
      const center = cues[Math.floor((cues.length - 1) * k / 10)];
      const expected = ((center.start + center.end) / 2 - source.origin) / step;
      const left = clamp(Math.round(expected - length / 2), 0, source.values.length - length);
      if (left - previous < Math.max(3, length / 7)) continue;
      previous = left;
      let avg = 0;
      for (let j = 0; j < length; j++) avg += source.values[left + j] / length;
      re.fill(0); im.fill(0);
      let variance = 0;
      for (let j = 0; j < length; j++) {
        const v = source.values[left + j] - avg;
        re[length - 1 - j] = v; variance += v * v;
      }
      if (variance < 0.018 * length) continue;
      fft(re, im, false);
      for (let i = 0; i < n; i++) {
        const real = re[i] * reRef[i] - im[i] * imRef[i];
        im[i] = re[i] * imRef[i] + im[i] * reRef[i]; re[i] = real;
      }
      fft(re, im, true);
      const peaks = [];
      const separation = Math.max(3, Math.ceil(1600 / step));
      let best = null;
      for (let i = 0; i + length <= ref.values.length; i++) {
        const total = sum[i + length] - sum[i];
        const energy = sq[i + length] - sq[i] - total * total / length;
        const value = energy > 1e-9 ? re[i + length - 1] / Math.sqrt(variance * energy) : 0;
        if (best && i - best.pos > separation) { peaks.push(best); best = null; }
        if (value >= 0.18 && (!best || value > best.value)) best = { pos: i, value };
      }
      if (best) peaks.push(best);
      peaks.sort((a, b) => b.value - a.value);
      const strong = [];
      for (const p of peaks) {
        if (strong.some(q => Math.abs(q.pos - p.pos) < separation)) continue;
        strong.push(p);
        if (strong.length === 12) break;
      }
      if (strong.length) windows.push({
        x: source.origin + (left + length / 2) * step,
        peaks: strong.map(p => ({ y: ref.origin + (p.pos + length / 2) * step, r: p.value }))
      });
    }
    return windows;
  }

  function propose(windows, first, span) {
    const ranked = [];
    function add(scale, offset) {
      if (scale < 0.94 || scale > 1.06) return;
      let vote = 0;
      for (const w of windows) {
        const y = w.x * scale + offset;
        let top = 0;
        for (const p of w.peaks) {
          const error = Math.abs(p.y - y);
          if (error < 1300) top = Math.max(top, p.r * Math.exp(-error * error / 620000));
        }
        vote += top;
      }
      ranked.push({ scale, offset, vote });
    }
    for (let i = 0; i < windows.length; i++) {
      const a = windows[i];
      for (const p of a.peaks) {
        for (const scale of commonRates) add(scale, p.y - scale * a.x);
        for (let j = i + 1; j < windows.length; j++) {
          const b = windows[j];
          if (b.x - a.x < span * 0.18) continue;
          for (const q of b.peaks) {
            const scale = (q.y - p.y) / (b.x - a.x);
            add(scale, p.y - scale * a.x);
          }
        }
      }
    }
    ranked.sort((a, b) => b.vote - a.vote);
    const finalists = [];
    for (const c of ranked) {
      if (finalists.some(f => distance(f, c, first, span) < 600)) continue;
      finalists.push(c);
      if (finalists.length === 24) break;
    }
    return finalists;
  }

  // Difference in predicted release time measured near both ends of the source.
  function distance(a, b, first, span) {
    const d = (a.scale - b.scale) * first + (a.offset - b.offset);
    return Math.max(Math.abs(d), Math.abs(d + span * (a.scale - b.scale)));
  }

  function evaluate(source, ref, step, c, stride, segments) {
    const x = source.values, y = ref.values;
    const base = (c.scale * (source.origin + step / 2) + c.offset - ref.origin) / step - 0.5;
    const scores = [];
    let observations = 0, total = 0, weakest = 1;
    let editIndex = 0, editBins = 0;
    for (let g = 0; g < segments; g++) {
      let sx = 0, sy = 0, xx = 0, yy = 0, xy = 0, n = 0;
      const lo = Math.floor(x.length * g / segments), hi = Math.floor(x.length * (g + 1) / segments);
      for (let i = lo; i < hi; i += stride) {
        let partialBins = 0;
        if (c.edits) {
          const time = source.origin + (i + 0.5) * step;
          while (editIndex < c.edits.length && c.edits[editIndex].sourceMs <= time) {
            const edit = c.edits[editIndex];
            if (edit.bridge && time < edit.bridge.endMs) {
              partialBins = bridgeOffset(edit, time) / step;
              break;
            }
            editBins += edit.deltaMs / step;
            editIndex++;
          }
        }
        const u = i * c.scale + base + editBins + partialBins, j = Math.floor(u);
        if (j < 0 || j >= y.length - 1) continue;
        const a = x[i], b = y[j] + (y[j + 1] - y[j]) * (u - j);
        sx += a; sy += b; xx += a * a; yy += b * b; xy += a * b; n++;
      }
      const available = Math.ceil((hi - lo) / stride);
      total += available; observations += n;
      if (n < Math.max(6, available * 0.5)) continue;
      const variance = Math.max(0, xx - sx * sx / n) * Math.max(0, yy - sy * sy / n);
      const r = variance > 1e-8 ? (xy - sx * sy / n) / Math.sqrt(variance) : 0;
      weakest = Math.min(weakest, r);
      scores.push(r);
    }
    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const coverage = observations / Math.max(1, total);
    return { r: mean * Math.sqrt(coverage), weakest, coverage, segments: scores.length };
  }

  function refine(source, ref, step, c, span, stride, segments) {
    let current = c, best = evaluate(source, ref, step, c, stride, segments).r;
    for (const delta of [400, 160, 65, 25]) {
      const seed = current;
      for (const left of [-delta, 0, delta]) {
        for (const right of [-delta, 0, delta]) {
          const ds = (right - left) / span, scale = seed.scale + ds;
          if (scale < 0.94 || scale > 1.06) continue;
          const trial = { offset: seed.offset + left - source.origin * ds, scale };
          const score = evaluate(source, ref, step, trial, stride, segments).r;
          if (score > best) { best = score; current = trial; }
        }
      }
    }
    return current;
  }

  function lowerBound(sorted, t) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function nearest(sorted, t) {
    const lo = lowerBound(sorted, t);
    const a = sorted[Math.max(0, lo - 1)], b = sorted[Math.min(lo, sorted.length - 1)];
    return Math.abs(t - a) < Math.abs(t - b) ? a : b;
  }

  // Restore millisecond precision when two language tracks share actual cue boundaries.
  function snapToBoundaries(cues, refCues, c) {
    const starts = refCues.map(x => x.start), ends = refCues.map(x => x.end).sort((a, b) => a - b);
    let candidate = c;
    for (const tolerance of [260, 100, 40]) {
      const pairs = [];
      const stride = Math.max(1, Math.floor(cues.length / 4000));
      for (let i = 0; i < cues.length; i += stride) {
        for (const [x, list] of [[cues[i].start, starts], [cues[i].end, ends]]) {
          const expected = x * candidate.scale + candidate.offset, y = nearest(list, expected);
          if (Math.abs(y - expected) <= tolerance) pairs.push([x, y]);
        }
      }
      if (pairs.length < Math.max(6, 2 * Math.ceil(cues.length / stride) * 0.54)) return c;
      let mx = 0, my = 0;
      for (const [x, y] of pairs) { mx += x / pairs.length; my += y / pairs.length; }
      let xx = 0, xy = 0;
      for (const [x, y] of pairs) { xx += (x - mx) ** 2; xy += (x - mx) * (y - my); }
      if (!xx) return c;
      const scale = xy / xx;
      if (scale < 0.94 || scale > 1.06) return c;
      candidate = { scale, offset: my - scale * mx };
    }
    return candidate;
  }

  function bridgeOffset(edit, ms) {
    let elapsed = 0;
    for (const gap of edit.bridge.gaps) {
      if (ms <= gap.start) break;
      elapsed += Math.min(ms, gap.end) - gap.start;
    }
    return edit.deltaMs * elapsed / edit.bridge.silenceMs;
  }

  function mapTime(fit, ms) {
    let time = ms * fit.scale + fit.offsetMs;
    for (const edit of fit.edits || []) {
      if (ms < edit.sourceMs) break;
      if (edit.bridge && ms < edit.bridge.endMs) return time + bridgeOffset(edit, ms);
      time += edit.deltaMs;
    }
    return time;
  }

  function median(values) {
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  }

  function matchesCue(cue, starts, ends, scale, offset, tolerance) {
    const start = cue.start * scale + offset, end = cue.end * scale + offset;
    return Math.abs(nearest(starts, start) - start) < tolerance &&
      Math.abs(nearest(ends, end) - end) < tolerance;
  }

  // A landmark must agree with several surrounding cues. A shared duration or
  // one similar line on its own is much too common to identify a cut.
  function textLandmarks(cues, reference, starts, ends, fit) {
    const landmarks = [];
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i], expected = cue.start * fit.scale + fit.offsetMs;
      const duration = (cue.end - cue.start) * fit.scale;
      let best = null, runnerUp = -Infinity;
      const lo = lowerBound(starts, expected - 120000), hi = lowerBound(starts, expected + 120000);
      // Very dense tracks can contain thousands of simultaneous overlays.
      if (hi - lo > 450) continue;
      for (let j = lo; j < hi; j++) {
        const match = reference[j];
        if (Math.abs((match.end - match.start) - duration) > 400) continue;
        const offset = match.start - cue.start * fit.scale;
        let score = 0, hits = 0;
        for (let k = Math.max(0, i - 5); k < Math.min(cues.length, i + 6); k++) {
          if (i === k) continue;
          const t = cues[k].start * fit.scale + offset, e = cues[k].end * fit.scale + offset;
          const error = Math.max(Math.abs(nearest(starts, t) - t), Math.abs(nearest(ends, e) - e));
          if (error < 420) { score += 1 - error / 560; hits++; }
        }
        if (hits < 4 || score < 3.3) continue;
        if (!best || score > best.score) {
          if (best) runnerUp = Math.max(runnerUp, best.score);
          best = { i, x: cue.start, y: match.start, score };
        } else runnerUp = Math.max(runnerUp, score);
      }
      if (best && best.score - runnerUp > 1.15) landmarks.push(best);
    }
    return landmarks;
  }

  function plateaus(points) {
    // A median of local slopes largely ignores pairs that straddle an edit.
    const slopes = [];
    for (let i = 4; i < points.length; i++) {
      const a = points[Math.max(0, i - 12)], b = points[i];
      const elapsed = b.x - a.x;
      if (elapsed >= 12000 && elapsed < 240000) slopes.push((b.y - a.y) / elapsed);
    }
    if (!slopes.length) return [];
    const rate = median(slopes);
    if (rate < 0.94 || rate > 1.06) return [];
    const runs = [];
    for (const p of points) {
      const offset = p.y - rate * p.x;
      const last = runs.at(-1);
      if (last && Math.abs(offset - last.meanOffset) < 800) {
        last.points.push(p);
        last.meanOffset += (offset - last.meanOffset) / last.points.length;
      } else runs.push({ points: [p], meanOffset: offset });
    }
    // Isolated landmarks cannot establish a section. Rejoin stable runs
    // separated by a stray landmark, then refit the shared frame-rate slope.
    const stable = [];
    for (const run of runs) {
      if (run.points.length < 4 || run.points.at(-1).x - run.points[0].x < 5000) continue;
      const last = stable.at(-1);
      if (last && Math.abs(last.meanOffset - run.meanOffset) < 800) {
        for (const point of run.points) last.points.push(point);
      } else stable.push(run);
    }
    return stable;
  }

  function sharedRate(runs) {
    let xx = 0, xy = 0;
    for (const {points} of runs) {
      let mx = 0, my = 0;
      for (const p of points) { mx += p.x / points.length; my += p.y / points.length; }
      for (const p of points) { xx += (p.x - mx) ** 2; xy += (p.x - mx) * (p.y - my); }
    }
    return xy / xx;
  }

  function review(startMs, endMs, reason) {
    return { startMs, endMs: Math.max(startMs + 1, endMs), reason };
  }

  // A review interval describes uncertainty in the exported timing. Only the
  // evidence for the complete mapping decides whether it can be exported.
  function withRanges(fit, ranges) {
    if (!ranges.length) return fit;
    const merged = [];
    for (const range of [...fit.reviewRanges, ...ranges].sort((a, b) => a.startMs - b.startMs)) {
      const last = merged.at(-1);
      if (last && range.startMs <= last.endMs + 1000) last.endMs = Math.max(last.endMs, range.endMs);
      else merged.push({ ...range });
    }
    return { ...fit, reviewRanges: merged };
  }

  // Two or three cues at an edge can have precise evidence for a different
  // offset while still being too short for an automatic correction.
  function shortEdgeReview(cues, starts, ends, fit) {
    if (!fit.reliable || fit.score < 0.7) return null;
    const ranges = [];
    for (const direction of [1, -1]) {
      const run = [];
      let i = direction > 0 ? 0 : cues.length - 1;
      while (run.length <= 6 && i >= 0 && i < cues.length) {
        const cue = cues[i], offset = mapTime(fit, cue.start) - cue.start * fit.scale;
        if (matchesCue(cue, starts, ends, fit.scale, offset, 450)) break;
        run.push(cue);
        i += direction;
      }
      if (run.length < 2 || run.length > 6) continue;
      const seed = run[0], expected = mapTime(fit, seed.start);
      const lo = lowerBound(starts, expected - 120000), hi = lowerBound(starts, expected + 120000);
      if (hi - lo > 450) continue;
      for (let j = lo; j < hi; j++) {
        const offset = starts[j] - seed.start * fit.scale;
        if (Math.abs(starts[j] - expected) < 1000) continue;
        if (run.every(cue => matchesCue(cue, starts, ends, fit.scale, offset, 90))) {
          const first = direction > 0 ? seed : run.at(-1), last = direction > 0 ? run.at(-1) : seed;
          ranges.push(review(first.start, last.end, "These edge cues match a different offset. Check their timing."));
          break;
        }
      }
    }
    return ranges.length ? withRanges(fit, ranges) : null;
  }

  function transition(cues, left, right, rate, starts, ends) {
    let lo = left.points.at(-1).i, hi = right.points[0].i;
    // Narrow the transition only when the available edges support one side
    // exclusively. A line removed from this release has no safe target time.
    while (lo + 1 < hi && matchesCue(cues[lo + 1], starts, ends, rate, left.offset, 430) &&
        !matchesCue(cues[lo + 1], starts, ends, rate, right.offset, 430)) lo++;
    while (hi - 1 > lo && matchesCue(cues[hi - 1], starts, ends, rate, right.offset, 430) &&
        !matchesCue(cues[hi - 1], starts, ends, rate, left.offset, 430)) hi--;
    let lastEnd = cues[lo].end;
    // Earlier overlapping cues may extend across this boundary too.
    for (let i = 0; i < lo; i++) lastEnd = Math.max(lastEnd, cues[i].end);
    const delta = right.offset - left.offset;
    const sourceGap = cues[hi].start - lastEnd;
    if (lo + 1 === hi && sourceGap > 0 && sourceGap * rate + delta >= 0)
      return { edit: { sourceMs: cues[hi].start, deltaMs: delta }, gapMs: sourceGap * rate };
    // Preserve the duration of every source cue. Only silence between the
    // verified endpoints absorbs the offset difference across unmatched cues.
    const rangeReason = "Some lines at this edit overlap or have no clear counterpart in the reference.";
    const range = review(cues[lo].start, cues[hi].end, rangeReason);
    const maxExpansion = hi === lo + 1 ? 2 : 0;
    for (let expansion = 0; expansion <= maxExpansion; expansion++) {
      const a = lo - expansion, b = hi + expansion;
      if (a < 0 || b >= cues.length || b - a > 30 || cues[b].start - cues[a].end > 150000) break;
      if (b - a < 2) continue;
      // Leave the middle of each established section intact even when cuts
      // on both of its sides need a bridge.
      if (expansion && (a < left.points[Math.floor(left.points.length / 2)].i ||
          b > right.points[Math.floor((right.points.length - 1) / 2)].i ||
          !matchesCue(cues[a], starts, ends, rate, left.offset, 430) ||
          !matchesCue(cues[b], starts, ends, rate, right.offset, 430))) continue;
      let occupiedUntil = cues[a].end;
      for (let i = 0; i < a; i++) occupiedUntil = Math.max(occupiedUntil, cues[i].end);
      const gaps = [];
      let silenceMs = 0;
      for (let i = a + 1; i <= b; i++) {
        if (cues[i].start > occupiedUntil) {
          gaps.push({ start: occupiedUntil, end: cues[i].start });
          silenceMs += cues[i].start - occupiedUntil;
        }
        occupiedUntil = Math.max(occupiedUntil, cues[i].end);
      }
      const silence = silenceMs * rate;
      if (silence > 0 && delta >= -0.75 * silence && delta <= Math.max(10000, 2 * silence)) {
        const bridge = { gaps, silenceMs, endMs: gaps.at(-1).end };
        return { range: review(cues[a].start, cues[b].end, rangeReason),
          edit: { sourceMs: gaps[0].start, deltaMs: delta, bridge }, gapMs: silence };
      }
    }
    return { range };
  }

  // At an unresolved cut the exported offset must carry straight through.
  // Find the sequence of confirmed cuts supported by the most independently
  // matched landmarks. At most one candidate per distinct section offset is
  // needed after each boundary.
  function compatibleEdits(groups, transitions) {
    let paths = groups.map(g => ({ offsetMs: g.offset, edits: [], support: 0 }));
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i], next = groups[i + 1], boundary = transitions[i];
      let bestChange = null;
      for (let j = 0; j < paths.length; j++) {
        const path = paths[j], offset = groups[j].offset;
        if (Math.abs(offset - group.offset) > 200) continue;
        path.support += group.points.length;
        if (!boundary?.edit) continue;
        const deltaMs = next.offset - offset;
        if (boundary.gapMs + deltaMs < 0) continue;
        if (!bestChange || path.support > bestChange.support) bestChange = {
          offsetMs: path.offsetMs, support: path.support,
          edits: [...path.edits, { ...boundary.edit, deltaMs }]
        };
      }
      if (bestChange && bestChange.support > paths[i + 1].support) paths[i + 1] = bestChange;
    }
    return paths.reduce((a, b) => a.support >= b.support ? a : b);
  }

  function textEdits(cues, reference, fit, competingFit) {
    const starts = reference.map(c => c.start), ends = reference.map(c => c.end).sort((a, b) => a - b);
    let unmatched = 0, longest = 0, hits = 0;
    const absent = [];
    for (let i = 0; i <= cues.length; i++) {
      if (i < cues.length && !matchesCue(cues[i], starts, ends, fit.scale, fit.offsetMs, 450)) {
        unmatched++;
        longest = Math.max(longest, unmatched);
      } else {
        if (unmatched >= 6) absent.push(review(cues[i - unmatched].start, cues[i - 1].end,
          "These cues do not have clear matching times in the reference."));
        unmatched = 0;
        if (i < cues.length) hits++;
      }
    }
    if (cues.length < 16 || (fit.reliable && longest < 3)) {
      return longest >= 2 ? shortEdgeReview(cues, starts, ends, fit) || fit : fit;
    }
    const points = textLandmarks(cues, reference, starts, ends, fit);
    if (points.length < 12 || points.length < cues.length * 0.3) return null;
    const groups = plateaus(points);
    if (groups.length < 2) {
      const edges = shortEdgeReview(cues, starts, ends, fit);
      if (fit.reliable && absent.length && hits >= cues.length * 0.65) return withRanges(edges || fit, absent);
      return edges;
    }
    if (groups.length > 20 || competingFit) return null;
    let rate = sharedRate(groups);
    if (!(rate >= 0.94 && rate <= 1.06)) return null;
    for (const group of groups) {
      group.offset = median(group.points.map(p => p.y - rate * p.x));
    }
    // Jitter can split a long section during the preliminary slope estimate.
    // Reunite neighboring sections that share an offset at the fitted rate.
    const originalCount = groups.length;
    for (let i = groups.length - 1; i > 0; i--) {
      if (Math.abs(groups[i - 1].offset - groups[i].offset) >= 850) continue;
      for (const p of groups[i].points) groups[i - 1].points.push(p);
      groups.splice(i, 1);
    }
    if (groups.length < 2) return null;
    if (groups.length !== originalCount) {
      rate = sharedRate(groups);
      if (!(rate >= 0.94 && rate <= 1.06)) return null;
      for (const group of groups) group.offset = median(group.points.map(p => p.y - rate * p.x));
    }
    const transitions = [], ranges = [];
    for (let i = 1; i < groups.length; i++) {
      const left = groups[i - 1], right = groups[i];
      if (Math.abs(right.offset - left.offset) < 850) return null;
      const boundary = transition(cues, left, right, rate, starts, ends);
      transitions.push(boundary);
      if (boundary.range) ranges.push(boundary.range);
    }
    const { offsetMs, edits } = transitions.some(t => !t.edit) ? compatibleEdits(groups, transitions) :
      { offsetMs: groups[0].offset, edits: transitions.map(t => t.edit) };
    const proposed = edits.length ? { ...fit, scale: rate, offsetMs, edits } : fit;
    let misses = 0, startMiss = 0;
    function finishRun(last) {
      if (misses >= 6) ranges.push(review(cues[startMiss].start, cues[last].end,
        "These cues do not have clear matching times in the reference."));
      misses = 0;
    }
    let extendedConflict = false;
    for (let group = 0; group < groups.length; group++) {
      const from = group ? groups[group].points[0].i : 0;
      const to = group + 1 === groups.length ? cues.length : groups[group + 1].points[0].i;
      const points = groups[group].points;
      const mismatches = points.filter(p => Math.abs(mapTime(proposed, p.x) - (rate * p.x + groups[group].offset)) >= 450);
      const matchesSection = mismatches.length < points.length / 2;
      if (!matchesSection) {
        ranges.push(review(cues[from].start, cues[to - 1].end,
          "This section has a different offset, but its exact boundary is uncertain."));
        if (mismatches.length >= 12 && mismatches.at(-1).x - mismatches[0].x > 90000) extendedConflict = true;
      }
      let hits = 0;
      for (let i = from; i < to; i++) {
        const c = cues[i], offset = mapTime(proposed, c.start) - proposed.scale * c.start;
        if (matchesCue(c, starts, ends, proposed.scale, offset, 450)) {
          hits++;
          finishRun(i - 1);
        } else {
          if (!misses) startMiss = i;
          misses++;
        }
      }
      if (matchesSection && edits.length && hits < (to - from) * 0.55) return null;
    }
    finishRun(cues.length - 1);
    if (extendedConflict) return withRanges({ ...proposed, reliable: false,
      reason: "A sustained section needs a different offset and its cut cannot be placed safely." }, ranges);
    if (!edits.length) return withRanges(fit, ranges);
    return withRanges({ ...proposed, reliable: true,
      reason: "Timing changes are supported by matching cue boundaries on each side." }, ranges);
  }

  function localPattern(source, ref, step, fit, start, end) {
    const x = source.values, y = ref.values;
    const lo = clamp(Math.floor((start - source.origin) / step), 0, x.length - 1);
    const hi = clamp(Math.ceil((end - source.origin) / step), lo + 1, x.length);
    const stride = Math.max(1, Math.ceil((hi - lo) / 320));
    const indexes = [], values = [];
    for (let i = lo; i < hi; i += stride) {
      indexes.push(Math.round((mapTime(fit, source.origin + (i + 0.5) * step) - ref.origin) / step - 0.5));
      values.push(x[i]);
    }
    return shift => {
      let n = 0, sx = 0, sy = 0, xx = 0, yy = 0, xy = 0;
      for (let i = 0; i < values.length; i++) {
        const j = indexes[i] + shift;
        if (j < 0 || j >= y.length) continue;
        const a = values[i], b = y[j];
        n++; sx += a; sy += b; xx += a * a; yy += b * b; xy += a * b;
      }
      if (n < values.length * 0.75) return -1;
      const variance = (xx - sx * sx / n) * (yy - sy * sy / n);
      return variance > 1e-6 ? (xy - sx * sy / n) / Math.sqrt(variance) : 0;
    };
  }

  // An acoustic tail needs a repeated, unambiguous alternative and a definite
  // cut between neighbouring cues. A strong tail alone cannot place the cut.
  function audioTail(cues, source, ref, step, fit, windows, width) {
    const shift = windows.at(-1).shift;
    if (!shift || !fit.reliable) return null;
    let first = windows.length - 1;
    while (first && Math.abs((windows[first - 1].shift ?? Infinity) - shift) <= 2) first--;
    const tail = windows.slice(first);
    if (tail[0].from < cues.length * 0.7 || tail.length < 5 || tail.at(-1).end - tail[0].start < 90000) return null;
    const delta = Math.round(median(tail.map(w => w.shift)));
    const radius = Math.min(width, 64);
    const left = Math.max(0, tail[0].from - radius), right = Math.min(cues.length - 1, tail[0].from + radius);
    const before = [], after = [];
    for (let i = left; i <= right; i++) {
      const cue = cues[i], corr = localPattern(source, ref, step, fit, cue.start - 500, cue.end + 500);
      before.push(corr(0));
      after.push(corr(delta));
    }
    // The change of cumulative local correlation identifies the best partition
    // without repeatedly scoring the whole film.
    let gain = 0, best = -Infinity, second = -Infinity, split = 0;
    for (let i = 1; i < before.length; i++) {
      gain += before[i - 1] - after[i - 1];
      if (gain > best) { second = best; best = gain; split = i; }
      else second = Math.max(second, gain);
    }
    const conflict = { ...fit, reliable: false, reason: "A sustained audio section needs a different offset and its cut cannot be placed safely." };
    const index = left + split, cut = cues[index].start, deltaMs = delta * step;
    let occupied = cues[0].end;
    for (let i = 1; i < index; i++) occupied = Math.max(occupied, cues[i].end);
    if (split < 2 || split >= before.length - 1 || best - second < 0.32 ||
        before[split - 1] < 0.67 || after[split] < 0.67 || cut <= occupied ||
        (cut - occupied) * fit.scale + deltaMs < 0) return conflict;
    const edits = [{ sourceMs: cut, deltaMs }];
    const full = evaluate(source, ref, step, { offset: fit.offsetMs, scale: fit.scale, edits }, 1, 4);
    if (full.segments !== 4 || full.coverage < 0.9 || full.weakest < 0.6 || full.r < fit.score + 0.025) return conflict;
    return { ...fit, edits, score: clamp(full.r, 0, 1), reason: "The audio activity supports a timing change near the end." };
  }

  // Record weak local patterns even when only the global alignment is supported.
  function checkLocalActivity(cues, source, ref, step, fit, audio) {
    if (fit.score < 0.32) return fit;
    const windows = [];
    const width = Math.min(cues.length, Math.max(16, Math.ceil(cues.length / 180)));
    for (let from = 0; ; from = Math.min(from + Math.ceil(width / 2), cues.length - width)) {
      const to = Math.min(from + width, cues.length);
      const start = cues[from].start, end = cues[to - 1].end;
      const corr = localPattern(source, ref, step, fit, start, end);
      const base = corr(0);
      const win = {from, start, end, base, suspicious: false};
      windows.push(win);
      if (base < Math.min(0.55, fit.score - 0.13)) {
        let best = base, runnerUp = -1, bestShift = 0;
        const separation = Math.ceil(1800 / step), hop = Math.max(1, Math.round(350 / step));
        const limit = Math.round(120000 / step), scores = [];
        for (let shift = -limit; shift <= limit; shift += hop) {
          const r = corr(shift);
          scores.push(r);
          if (r > best) {best = r; bestShift = shift;}
        }
        for (let i = 0; i < scores.length; i++) {
          if (Math.abs(i * hop - limit - bestShift) > separation) runnerUp = Math.max(runnerUp, scores[i]);
        }
        win.suspicious = Math.abs(bestShift * step) >= 1000 && best - base > 0.22 &&
          best > (audio ? 0.48 : 0.6) && best - runnerUp > 0.075;
        if (audio && win.suspicious && best > 0.74 && best - runnerUp > 0.17) {
          const peak = bestShift;
          for (let shift = peak - hop; shift <= peak + hop; shift++) {
            const score = corr(shift);
            if (score > best) { best = score; bestShift = shift; }
          }
          win.shift = bestShift;
        }
      }
      if (to === cues.length) break;
    }
    if (!windows.some(w => w.base >= (audio ? 0.48 : 0.6))) return fit;
    const tail = audio ? audioTail(cues, source, ref, step, fit, windows, width) : null;
    const ranges = [];
    for (const w of windows) {
      if (tail?.reliable && w.end >= tail.edits[0].sourceMs) continue;
      // A whole run of cues without the expected pattern can also be missing
      // dialogue. Require strong evidence elsewhere before reporting this.
      const weak = w.base < 0.10 && fit.score >= (audio ? 0.70 : 0.75);
      if (!w.suspicious && !weak) continue;
      const last = ranges.at(-1);
      if (last && w.start <= last.endMs + 5000) last.endMs = Math.max(last.endMs, w.end);
      else ranges.push(review(w.start, w.end, "The local timing differs from the rest of this release."));
    }
    return withRanges(tail || fit, ranges);
  }

  function align(input, reference, options = {}) {
    if (!Array.isArray(input)) return failure("Choose a subtitle track to sync.");
    const cues = ordered(input);
    if (cues.length < 4) return failure("At least four dialogue cues are needed for automatic matching.");
    if (hasRepeatingPattern(cues)) return failure("The cue pattern repeats. Use matching dialogue lines as manual anchors.");
    const audio = !Array.isArray(reference);
    const refCues = audio ? null : ordered(reference);
    if (audio && (!reference || !reference.activity || !(reference.stepMs > 0) || !reference.activity.length))
      return failure("The audio reference has no usable activity.");
    if (refCues && refCues.length < 4) return failure("The reference has too few dialogue cues for automatic matching.");
    const [first, last] = extent(cues), span = last - first;
    const refBounds = audio ? [0, reference.stepMs * reference.activity.length] : extent(refCues);
    const maxSpan = Math.max(span, refBounds[1] - refBounds[0]);
    if (!Number.isFinite(maxSpan) || maxSpan <= 0) return failure("The track duration is invalid.");
    const step = Math.max(100, Math.ceil(maxSpan / 120000), audio ? reference.stepMs : 0);
    const source = cueActivity(cues, step), ref = audio ? audioActivity(reference, step) : cueActivity(refCues, step);
    const windows = findWindows(cues, source, ref, step);
    if (!windows.length) return failure("No clear dialogue pattern was found in the reference.");
    const candidates = propose(windows, first, span);
    if (!candidates.length) return failure("The reference did not yield a consistent timing match.");
    const stride = Math.max(1, Math.floor(source.values.length / 16000));
    const segments = span >= 180000 && cues.length >= 25 ? 4 : 1;
    for (const c of candidates) c.r = evaluate(source, ref, step, c, stride, segments).r;
    candidates.sort((a, b) => b.r - a.r);
    let best = refine(source, ref, step, candidates[0], span, stride, segments);
    if (refCues) best = snapToBoundaries(cues, refCues, best);
    // Sampling speeds up the search; the selected mapping is always checked
    // against every activity bin, including the beginning and end.
    const result = evaluate(source, ref, step, best, 1, segments);
    const rival = candidates.find(c => distance(c, best, first, span) > 1900 && c.r > result.r - 0.055);
    const votes = windows.filter(w => w.peaks.some(p => Math.abs(w.x * best.scale + best.offset - p.y) < 1100)).length;
    const supported = votes >= Math.max(2, Math.ceil(windows.length * 0.45));
    const continuous = result.segments === segments && result.weakest > (audio ? 0.14 : 0.25);
    const score = clamp(result.r, 0, 1);
    // Short tracks contain fewer independent pauses; chance fits are much more common.
    let minimumScore = audio ? 0.39 : 0.50;
    if (cues.length < 8) minimumScore = 0.90;
    else if (cues.length < 18) minimumScore = 0.78;
    else if (cues.length < 30) minimumScore = 0.62;
    const reliable = score >= minimumScore && result.coverage >= 0.76 && supported && continuous && !rival;
    let reason = "The overall offset and playback rate are supported by the dialogue timing.";
    if (!reliable) {
      reason = rival ? "Several timings fit this pattern. Check the proposed timing or set manual anchors."
        : "The tracks do not show a consistent dialogue match. Try another reference or set manual anchors.";
    }
    const fit = { offsetMs: Math.round(best.offset), scale: best.scale, score, reliable, reason, edits: [], reviewRanges: [] };
    if (refCues) {
      const local = textEdits(cues, refCues, fit, !!rival && score > 0.75);
      if (local) {
        if (local.reliable && local.edits.length) {
          const corrected = evaluate(source, ref, step, { scale: local.scale, offset: local.offsetMs, edits: local.edits }, 1, segments);
          local.score = clamp(corrected.r, 0, 1);
          if (local.score < minimumScore || corrected.coverage < 0.76 || corrected.segments !== segments ||
              corrected.weakest < 0.25 || (fit.reliable && local.score + 0.01 < fit.score)) {
            return checkLocalActivity(cues, source, ref, step, fit, false);
          }
          const starts = refCues.map(c => c.start), ends = refCues.map(c => c.end).sort((a, b) => a - b);
          return shortEdgeReview(cues, starts, ends, local) || local;
        }
        return local;
      }
    }
    return checkLocalActivity(cues, source, ref, step, fit, audio);
  }

  const api = { align, mapTime };
  root.SyncAlign = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
