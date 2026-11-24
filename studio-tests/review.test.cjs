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

test('flagged ranges disable export, jump to their own cues, and clear with a mode change', async () => {
  const ui = studio(cues => ({...fit, reviewRanges:[14, 45].map(i => ({
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
  assert.equal(n['timing-sections'].hidden, true);
  assert.equal(ui.positions[0]['aria-pressed'], 'true');
});
