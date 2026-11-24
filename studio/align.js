/* Original browser rewrite. SPDX-License-Identifier: GPL-3.0-or-later */
// All times are in milliseconds.
(function (root) {
  "use strict";

  const commonRates = [1, 24 / 25, 25 / 24, 24000 / 25025, 25025 / 24000, 1000 / 1001, 1001 / 1000];
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const failure = reason => ({ offsetMs: 0, scale: 1, score: 0, reliable: false, reason });

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
    for (let g = 0; g < segments; g++) {
      let sx = 0, sy = 0, xx = 0, yy = 0, xy = 0, n = 0;
      const lo = Math.floor(x.length * g / segments), hi = Math.floor(x.length * (g + 1) / segments);
      for (let i = lo; i < hi; i += stride) {
        const u = i * c.scale + base, j = Math.floor(u);
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

  function nearest(sorted, t) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] < t) lo = mid + 1; else hi = mid;
    }
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
    const result = evaluate(source, ref, step, best, stride, segments);
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
    let reason = "Dialogue timing matches across the track. Check the beginning and end before exporting.";
    if (!reliable) {
      reason = rival ? "Several timings fit this pattern. Check the proposed timing or set manual anchors."
        : "The tracks do not show a consistent dialogue match. Try another reference or set manual anchors.";
    }
    return { offsetMs: Math.round(best.offset), scale: best.scale, score, reliable, reason };
  }

  const api = { align };
  root.SyncAlign = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
