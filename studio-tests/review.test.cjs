/* SPDX-License-Identifier: GPL-3.0-or-later */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SyncSrt = require('../studio/srt.js');
const {mapTime} = require('../studio/align.js');

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

function studio(answer) {
  const html = fs.readFileSync(require.resolve('../studio/index.html'), 'utf8');
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
  const state = {nodes, positions};
  const context = vm.createContext({
    document, SyncSrt, AbortController, Blob, Option: Element, setTimeout() {},
    URL: {
      createObjectURL(blob) { if (blob.type.startsWith('application/x-subrip')) state.download = blob; return 'blob:test'; },
      revokeObjectURL() {},
    },
    SyncAlign: {mapTime, align(cues) { state.cues = cues; return answer(cues); }},
  });
  for (const filename of ['reference-cache.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(require.resolve('../studio/' + filename), 'utf8'), context);
  }
  return state;
}

const fit = {offsetMs:2400, scale:1, score:0.95, reliable:true};

test('ordinary matches keep the compact preview; a later correction reaches both SRT endpoints and playback', async () => {
  let addEdit = false;
  const ui = studio(cues => ({...fit, edits:addEdit ? [{sourceMs:cues[40].start, deltaMs:8000}] : []}));
  const n = ui.nodes;
  await n.demo.click();
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
  await n.demo.click();
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
