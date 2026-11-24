/* SPDX-License-Identifier: GPL-3.0-or-later */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SyncSrt = require('../studio/srt.js');
const {align, mapTime} = require('../studio/align.js');

// Exercise the normal controls and exported Blob without a browser dependency.
class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = {};
  }
  setAttribute(key, value) { this[key] = value; }
  removeAttribute(key) { delete this[key]; }
  append(...items) { this.children.push(...items); }
  replaceChildren() { this.children.length = 0; }
  get firstElementChild() { return this.children[0]; }
  add(item) { this.append(item); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  async fire(type) { for (const fn of this.listeners[type] || []) await fn({target:this}); }
  click() { return this.fire('click'); }
  load() { this.currentSrc = this.src; }
  pause() {}
  async play() {}
  remove() {}
}

function studio(answer = align) {
  const html = fs.readFileSync(require.resolve('../studio/index.html'), 'utf8');
  const app = fs.readFileSync(require.resolve('../studio/app.js'), 'utf8');
  const nodes = Object.fromEntries([...html.matchAll(/ id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  const positions = ['first', 'middle', 'last'].map(position => {
    const button = new Element();
    button.dataset.position = position;
    return button;
  });
  const document = {
    getElementById: id => nodes[id],
    querySelectorAll: () => positions.concat(nodes['section-list'].children.map(row => row.firstElementChild)),
    createElement: () => new Element(),
    createDocumentFragment: () => new Element(),
    body: new Element(),
  };
  const state = {nodes, positions, html, app, parsedFiles: 0};
  const context = vm.createContext({
    document, AbortController, Blob, Option: Element, setTimeout() {},
    SyncSrt: {...SyncSrt, parse(text) { state.parsedFiles++; return SyncSrt.parse(text); }},
    URL: {
      createObjectURL(blob) { if (blob.type.startsWith('application/x-subrip')) state.download = blob; return 'blob:test'; },
      revokeObjectURL() {},
    },
    SyncAlign: {mapTime, align(cues, reference) { state.cues = cues; return answer(cues, reference); }},
  });
  vm.runInContext(fs.readFileSync(require.resolve('../studio/reference-cache.js'), 'utf8'), context);
  vm.runInContext(app, context);
  return state;
}

async function chooseSubtitle(ui, slot) {
  const reference = slot === 'ref';
  let start = reference ? 4400 : 2000;
  const blocks = Array.from({length: 55}, (_, i) => {
    const end = start + 600 + (i * 137) % 1900;
    const timing = SyncSrt.formatTime(start) + ' --> ' + SyncSrt.formatTime(end);
    start = end + 400 + (i * i * 149) % 4100;
    return [i + 1, timing, (reference ? 'Ligne ' : '字幕 ') + (i + 1)].join('\n');
  });
  const input = ui.nodes[slot + '-file'];
  input.files = [new File([blocks.join('\n\n') + '\n'], slot + '.srt')];
  await input.fire('change');
  // The change handler starts an async file read. Wait for its UI completion.
  const meta = ui.nodes[slot + '-meta'];
  const deadline = Date.now() + 3000;
  while (meta.textContent === 'Reading file…' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(meta.textContent, '55 cues · SRT');
}

test('startup contains no sample and enables preview and export as local files are loaded', async () => {
  const ui = studio();
  const n = ui.nodes;
  assert.doesNotMatch(ui.html, /Load (?:the )?demo|Example timing|id="demo"/i);
  assert.doesNotMatch(ui.app, /platform\.ar\.srt|platform\.reference\.fr\.srt|وصل القطار قبل الفجر|Le train est arrivé avant le jour/);
  assert.equal(ui.parsedFiles, 0);
  assert.equal(n['preview-empty'].hidden, false);
  assert.equal(n['preview-content'].hidden, true);
  assert.equal(n['preview-type'].hidden, true);
  assert.equal(n['cue-list'].children.length, 0);
  for (const id of ['estimate-title', 'estimate-info', 'range-time']) assert.equal(n[id].textContent || '', '');
  assert.equal(n.run.disabled, true);
  assert.equal(n.export.disabled, true);
  assert.equal(n.run.textContent, 'Correct Timings');
  assert.match(ui.html, /<button\b[^>]*id="run"[^>]*>Correct Timings<\/button>/);

  await chooseSubtitle(ui, 'source');
  assert.equal(n['preview-empty'].hidden, true);
  assert.equal(n['preview-content'].hidden, false);
  assert.equal(n['cue-list'].firstElementChild.firstElementChild.firstElementChild.textContent, '字幕 1');
  assert.equal(n.run.disabled, true);
  await chooseSubtitle(ui, 'ref');
  assert.equal(ui.parsedFiles, 2);
  assert.equal(n.run.disabled, false);
  assert.equal(n.export.disabled, true);
  await n.run.click();
  assert.equal(n.export.disabled, false);
  await n.export.click();
  const exported = SyncSrt.parse(await ui.download.text()).cues;
  assert.equal(exported.length, 55);
  assert.equal(exported[0].text, '字幕 1');
  assert.equal(exported[0].start, 4400);
  assert.equal(exported.at(-1).start, ui.cues.at(-1).start + 2400);
});

const fit = {offsetMs:2400, scale:1, score:0.95, reliable:true};

test('ordinary matches keep the compact preview; a later correction reaches both SRT endpoints and playback', async () => {
  let addEdit = false;
  const ui = studio(cues => ({...fit, edits:addEdit ? [{sourceMs:cues[40].start, deltaMs:8000}] : []}));
  const n = ui.nodes;
  await chooseSubtitle(ui, 'source');
  await chooseSubtitle(ui, 'ref');
  await n.run.click();
  assert.equal(n['timing-sections'].hidden, true);
  assert.equal(n['estimate-title'].textContent, 'Offset +2.400 s');
  addEdit = true;
  await n.run.click();
  assert.equal(n.export.disabled, false);
  assert.equal(n['estimate-title'].textContent, 'Starting offset +2.400 s');
  const [button, note] = n['section-list'].firstElementChild.children;
  assert.match(note.textContent, /8\.000 s later/);
  n['play-file'].files = [new File([], 'movie.mp4')];
  await n['play-file'].fire('change');
  n.player.duration = 1000;
  await n.player.fire('loadedmetadata');
  await button.click();
  assert.equal(button['aria-pressed'], 'true');
  assert.equal(n['cue-list'].children.filter(row => row.className === 'section-cue').length, 1);
  assert.equal(n.player.currentTime, (ui.cues[40].start + 10400) / 1000);
  await n.export.click();
  const exported = SyncSrt.parse(await ui.download.text()).cues;
  assert.equal(exported.length, ui.cues.length);
  for (const [i, cue] of exported.entries()) {
    const shift = i < 40 ? 2400 : 10400;
    assert.equal(cue.start, ui.cues[i].start + shift);
    assert.equal(cue.end, ui.cues[i].end + shift);
  }
});

test('a supported automatic match with a local mismatch exports all cues without a review prompt', async () => {
  const ui = studio(cues => ({
    offsetMs:14910, scale:1.00099, score:0.84, reliable:true,
    reviewRanges:[{startMs:cues[14].start, endMs:cues[17].end, reason:'Local mismatch.'}],
  }));
  const n = ui.nodes;
  await chooseSubtitle(ui, 'source');
  await chooseSubtitle(ui, 'ref');
  await n.run.click();
  assert.equal(n.export.disabled, false);
  assert.equal(n['timing-sections'].hidden, true);
  assert.equal(n['section-list'].children.length, 0);
  assert.doesNotMatch(n.status.textContent, /review|flagged|check|mismatch/i);
  assert.match(n.status.textContent, /export/i);
  assert.match(n.status.textContent, /all 55 cues included/i);
  assert.match(n['estimate-info'].textContent, /timing match score 84%/i);
  assert.equal(n['preview-type'].textContent, 'Adjusted');
  await n.export.click();
  const exported = SyncSrt.parse(await ui.download.text()).cues;
  assert.equal(exported.length, ui.cues.length);
  for (const [i, cue] of exported.entries()) {
    assert.equal(cue.start, Math.round(ui.cues[i].start * 1.00099 + 14910));
    assert.equal(cue.end, Math.round(ui.cues[i].end * 1.00099 + 14910));
    assert.equal(cue.text, '字幕 ' + (i + 1));
  }
});

test('reports verified cue timing matches and reserves 100% for an exact timeline', async () => {
  let result = {...fit, score:0.9974, matchedTimings:52, exactTimings:false};
  const ui = studio(() => result);
  await chooseSubtitle(ui, 'source');
  await chooseSubtitle(ui, 'ref');
  await ui.nodes.run.click();
  assert.equal(ui.nodes['estimate-title'].textContent, 'Matched subtitle timings');
  assert.match(ui.nodes['estimate-info'].textContent, /99\.7% · 52 of 55 cues matched by timing/);
  assert.equal(ui.nodes.export.disabled, false);
  result = {...fit, score:0.9998};
  await ui.nodes.run.click();
  assert.match(ui.nodes['estimate-info'].textContent, />99\.9%/);
  result = {...fit, score:1, matchedTimings:55, exactTimings:true};
  await ui.nodes.run.click();
  assert.match(ui.nodes['estimate-info'].textContent, /100% · 55 of 55 cues matched by timing/);
});

test('unsupported ranges disable export, jump to their own cues, and clear with a mode change', async () => {
  const ui = studio(cues => ({...fit, reliable:false, reason:'No supported timing map.', reviewRanges:[14, 45].map(i => ({
    startMs:cues[i].start + 1, endMs:cues[i+1].end, reason:'No matching cue in this section.',
  }))}));
  const n = ui.nodes;
  await chooseSubtitle(ui, 'source');
  await chooseSubtitle(ui, 'ref');
  await n.run.click();
  assert.equal(n.export.disabled, true);
  assert.equal(n['section-list'].children.length, 2);
  for (const [i, row] of n['section-list'].children.entries()) {
    await row.firstElementChild.click();
    const selected = n['cue-list'].children.find(cue => cue.className === 'section-cue');
    assert.equal(selected.children[1].textContent, SyncSrt.formatTime(ui.cues[[14,45][i]].start));
  }
  await n.export.click();
  assert.equal(ui.download, undefined);
  await n.manual.click();
  assert.equal(n.run.textContent, 'Correct Timings');
  assert.equal(n['timing-sections'].hidden, true);
  assert.equal(ui.positions[0]['aria-pressed'], 'true');
});

test('an ambiguous new result cannot export a previous successful correction', async () => {
  let ambiguous = false;
  const ui = studio(() => ambiguous
    ? {...fit, reliable:false, reason:'Several timings fit this pattern.'}
    : fit);
  const n = ui.nodes;
  await chooseSubtitle(ui, 'source');
  await chooseSubtitle(ui, 'ref');
  await n.run.click();
  assert.equal(n.export.disabled, false);
  ambiguous = true;
  await n.run.click();
  assert.equal(n.export.disabled, true);
  assert.match(n.status.textContent, /Several timings/);
  await n.export.click();
  assert.equal(ui.download, undefined);
});
