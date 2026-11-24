/* SPDX-License-Identifier: GPL-3.0-or-later */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {init} = require('../studio/translate-page');
const SyncSrt = require('../studio/srt');
const CueTranslationSrt = require('../studio/translation-srt');

const template = readFileSync(require.resolve('../studio/translate.html'), 'utf8');
const subtitle = '7\r\n00:00:01,020 --> 00:00:02,110\r\nHello!\r\n';
class Element {
  constructor() {
    this.options = []; this.handlers = {}; this.dataset = {}; this.value = '';
    this.hidden = false; this.disabled = false; this.files = [];
    this.classList = {add() {},remove() {}};
  }
  append(node) { this.options.push(node); }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  fire(type, event = {}) { return this.handlers[type]?.(event); }
  removeAttribute(key) { delete this[key]; }
  click() { this.fire('click'); }
  remove() {}
}
const deferred = () => {
  let resolve; const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
};
function memoryDraft() {
  return {
    record:null, writes:0,
    async load() { return structuredClone(this.record); },
    async save(item, expected) {
      this.writes++;
      const snapshot = structuredClone(item);
      await this.beforeCommit?.();
      if (expected !== (this.record?.revision ?? null)) {
        const error = new Error('The saved draft changed in another tab.');
        error.name = 'DraftConflictError'; throw error;
      }
      snapshot.revision = String(this.writes);
      this.record = snapshot;
      return structuredClone(snapshot);
    },
    async clear() { this.record = null; },
  };
}
function editingReview(onDirtyChange) {
  let current = [], baseline = [];
  const hasUnsaved = () => current.some((line, i) => line !== baseline[i]);
  function replace(lines) {
    current = lines.slice(); baseline = lines.slice();
    onDirtyChange(false);
  }
  return {
    load(prepared, generated, edited = generated) {
      assert.equal(edited.length, prepared.units.length);
      replace(edited);
    },
    clear() { replace([]); },
    edit(i, value) { current[i] = value; onDirtyChange(hasUnsaved()); },
    getLines() { return current.slice(); },
    hasUnsaved,
    focusUnit(id) { this.focusedUnit = id; return Number.isInteger(id); },
    focusInvalid() { return false; },
    markSaved(lines) { baseline = lines.slice(); onDirtyChange(hasUnsaved()); },
  };
}
function setup({detected = 'en', engine = {}, chrome = true, hasDetector = true, locale = 'en',
  draft = memoryDraft(), confirm = () => false} = {}) {
  const ids = Object.fromEntries([...template.matchAll(/ id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  const source = ids['source-language'];
  source.append(new Element());
  ids.translate.disabled = true; ids.export.disabled = true; ids['translation-output'].hidden = true;
  const state = {ids, destroyed:0, detects:0, starts:0, reads:0, pairs:[], listeners:{}, confirmations:[]};
  const doc = {getElementById: key => ids[key], createElement: () => new Element(), body:new Element()};
  const driver = {
    plan:async (source, target) => { state.pairs.push([source,target]); return {source,target,mode:'standard'}; },
    start() { state.starts++; return Promise.resolve({mode:'standard',destroy() {state.destroyed++;},
      async translate(units,{onMode,onProgress}) {
        onMode('standard'); onProgress(units.length,units.length); return units.map(() => '¡Hola!');
      }}); },
    ...engine,
  };
  const scope = {
    document:doc, navigator:{languages:[locale],userAgent:'Mozilla Chrome/158.0',userAgentData:{brands:[{brand:chrome?'Google Chrome':'Chromium'}]}},
    Translator:{create() {}}, CueTranslationEngine:driver, SyncSrt, CueTranslationSrt,
    CueTranslationReview:{create(section, {onDirtyChange}) { return state.review = editingReview(onDirtyChange); }},
    CueTranslationDraft:draft,
    confirm(prompt) { state.confirmations.push(prompt); return confirm(prompt); },
    addEventListener(type, handler) { state.listeners[type] = handler; },setTimeout(fn) { fn(); },
    URL:{createObjectURL(blob) { state.blob=blob; return 'blob:local'; },revokeObjectURL() {}},
  };
  if (hasDetector) scope.LanguageDetector = {create() {
    state.detects++;
    return Promise.resolve({detect:async () => [{detectedLanguage:detected,confidence:0.98}], destroy() {}});
  }};
  init(scope);
  const choose = (name = 'film.en.srt', text = subtitle) => {
    ids['subtitle-file'].files = [{name, arrayBuffer:async () => {state.reads++;return new TextEncoder().encode(text).buffer;}}];
    return ids['subtitle-file'].fire('change');
  };
  const select = (id, val) => {ids[id].value=val;return ids[id].fire('change');};
  return {state,ids,choose,select,doc,draft};
}

test('automatic SRT translation chooses a different target and exports a complete local subtitle', async () => {
  const {state,ids,choose,doc,draft} = setup();
  await choose();
  assert.equal(ids['target-language'].options.length,13);
  assert.deepEqual(state.pairs,[['en','es']]); assert.equal(ids.translate.disabled,false);
  const running = ids.translate.fire('click');
  assert.equal(state.starts,1,'session creation starts in the click, without an asynchronous preflight');
  await running;
  assert.match(ids['translation-status'].textContent,/complete/i);
  assert.equal(ids.export.disabled,false);
  ids.export.click();
  assert.equal(doc.body.options.at(-1).download,'film.en.es.srt');
  assert.equal(await state.blob.text(),subtitle.replace('Hello!','¡Hola!'));
  assert.equal(state.destroyed,1); assert.equal(draft.writes,0); assert.equal(draft.record,null);
});
test('manual source recovers when detection is unavailable; a matching target blocks translation', async () => {
  const {ids,choose,select,state} = setup({hasDetector:false});
  await choose();
  assert.match(ids['translation-status'].textContent,/original language/); assert.equal(ids.translate.disabled,true);
  await select('source-language','fr'); assert.deepEqual(state.pairs.at(-1),['fr','en']);
  await select('target-language','fr'); assert.equal(ids.translate.disabled,true); assert.equal(state.reads,1);
});
test('automatic detection accepts languages beyond the destination shortlist', async () => {
  const {ids,choose,state} = setup({detected:'uk',locale:'th-TH'});
  await choose(); assert.deepEqual(state.pairs,[['uk','th']]);
  assert.match(ids['source-language'].options[0].textContent,/Ukrainian/);
});
test('changing target during generation aborts the old run and suppresses its late output', async () => {
  const translating = deferred(), entered = deferred(); let signal, releases = 0;
  const {ids,choose,select} = setup({engine:{start:async (plan,options) => {
    signal=options.signal;
    return {mode:'context',destroy(){releases++;},translate:() => {entered.resolve();return translating.promise;}};
  }}});
  await choose(); const pending = ids.translate.fire('click'); await entered.promise;
  await select('target-language','fr'); assert.equal(signal.aborted,true);
  translating.resolve(['stale']); await pending;
  assert.equal(ids.export.disabled,true); assert.equal(ids['translation-output'].hidden,true); assert.equal(releases,1);
  assert.equal(ids.translate.disabled,false);
});
test('failed setup can be retried and a canceled pending session cannot export', async () => {
  const creating = deferred(); let attempts=0,releases=0;
  const {ids,choose} = setup({engine:{start() {
    if (++attempts===1) throw Error('Language pack download failed.');
    return creating.promise;
  }}});
  await choose(); await ids.translate.fire('click');
  assert.match(ids['translation-status'].textContent,/download failed/); assert.equal(ids.translate.disabled,false);
  const pending = ids.translate.fire('click'); ids.cancel.click();
  creating.resolve({destroy(){releases++;}}); await pending;
  assert.equal(releases,1); assert.equal(ids.export.disabled,true); assert.equal(ids.translate.disabled,false);
});
test('unsupported desktop browsers show the compatibility message before file selection', () => {
  const {ids} = setup({chrome:false});
  assert.equal(ids['subtitle-file'].disabled,true);
  assert.equal(ids.translate.disabled,true);
  assert.match(ids['translation-status'].textContent,/Google Chrome/);
});

test('Unicode export preserves the input encoding, BOM and physical separators', async () => {
  const {outputEncoding,subtitleBlob} = require('../studio/translate-page');
  const original = '\ufeff91\r\n00:00:00,001 --> 00:00:03,084\r\n<i>Привет!</i>\r\n';
  for (const encoding of ['utf-8','utf-16le','utf-16be']) {
    const data = await subtitleBlob(original, encoding).arrayBuffer();
    assert.equal(outputEncoding(data, 'auto'), encoding);
    assert.equal(SyncSrt.decode(data), original);
  }
  assert.equal(outputEncoding(new Uint8Array([0xca]).buffer, 'windows-1251'),'utf-8');
});

const flush = () => new Promise(resolve => setImmediate(resolve));
const styledSubtitle = '\ufeff91\r\n00:00:01,003 --> 00:00:03,504 position:50%\r\n- <i>Hello!</i>\r\n- Bye!\r\n';
const styledOutput = edited => styledSubtitle.replace('Hello!', edited).replace('Bye!', '¡Hola!');

test('download includes current unsaved dialogue and preserves protected subtitle structure', async () => {
  const {ids, choose, state, draft} = setup();
  await choose('episode.srt', styledSubtitle);
  await ids.translate.fire('click');
  state.review.edit(0, 'Buenos días.');
  assert.equal(state.review.hasUnsaved(), true);
  assert.equal(ids['review-save'].disabled, false);
  ids.export.click();
  const data = await state.blob.arrayBuffer();
  assert.equal(SyncSrt.decode(data), styledOutput('Buenos días.'));
  assert.equal(draft.writes, 0);
  assert.equal(draft.record, null);
  assert.doesNotThrow(() => state.listeners.beforeunload({preventDefault() { assert.fail('Edits already downloaded'); }}));
});

test('explicit save restores the edited SRT after reload without reloading the source or translating again', async () => {
  const draft = memoryDraft();
  const old = setup({draft});
  await old.choose('episode.srt', styledSubtitle);
  await old.ids.translate.fire('click');
  old.state.review.edit(1, 'Adiós.');
  await old.ids['review-save'].fire('click');
  assert.equal(draft.writes, 1);
  assert.deepEqual(draft.record.generatedLines, ['¡Hola!', '¡Hola!']);
  assert.deepEqual(draft.record.editedLines, ['¡Hola!', 'Adiós.']);
  assert.equal(draft.record.sourceText, styledSubtitle);
  assert.equal(old.state.review.hasUnsaved(), false);

  const resumed = setup({draft});
  await flush();
  assert.equal(resumed.ids['saved-draft'].hidden, false);
  resumed.ids['resume-draft'].click();
  assert.equal(resumed.ids['translation-output'].hidden, false);
  assert.deepEqual(resumed.state.review.getLines(), draft.record.editedLines);
  resumed.ids.export.click();
  assert.equal(SyncSrt.decode(await resumed.state.blob.arrayBuffer()), styledSubtitle.replace('Hello!', '¡Hola!').replace('Bye!', 'Adiós.'));
  assert.equal(resumed.doc.body.options.at(-1).download, 'episode.es.srt');
  assert.equal(resumed.state.starts, 0);
  assert.equal(resumed.state.reads, 0);
  assert.equal(resumed.state.detects, 0);
  assert.equal(draft.writes, 1);
});

test('invalid edits cannot save or export and a quota failure preserves both the previous save and live edits', async () => {
  const {ids, choose, draft, state} = setup();
  await choose();
  await ids.translate.fire('click');
  await ids['review-save'].fire('click');
  state.review.edit(0, '');
  ids.export.click();
  await ids['review-save'].fire('click');
  assert.equal(state.blob, undefined);
  assert.equal(draft.writes, 1);
  assert.equal(state.review.hasUnsaved(), true);
  assert.match(ids['review-status'].textContent, /cue 1/i);
  state.review.edit(0, 'Una corrección.');
  draft.beforeCommit = async () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
  await ids['review-save'].fire('click');
  assert.match(ids['review-status'].textContent, /could not save/i);
  assert.equal(ids['review-save'].disabled, false);
  assert.deepEqual(draft.record.editedLines, ['¡Hola!']);
  assert.deepEqual(state.review.getLines(), ['Una corrección.']);
  ids.export.click();
  assert.equal(await state.blob.text(), subtitle.replace('Hello!', 'Una corrección.'));
});

test('changing files or target and retrying translation preserve unsaved edits when discard is declined', async () => {
  const {ids, choose, select, state,draft} = setup();
  await choose();
  await ids.translate.fire('click');
  state.review.edit(0, 'Revisado.');
  let protectedOnClose = false;
  state.listeners.beforeunload({preventDefault() { protectedOnClose = true; }});
  assert.equal(protectedOnClose, true);
  await select('target-language', 'fr');
  assert.equal(ids['target-language'].value, 'es');
  await choose('other.srt');
  await ids.translate.fire('click');
  assert.equal(state.confirmations.length, 3);
  assert.equal(ids['file-name'].textContent, 'film.en.srt');
  assert.deepEqual(state.review.getLines(), ['Revisado.']);
  assert.equal(state.reads, 1); assert.equal(state.starts, 1); assert.equal(draft.writes, 0);
});

test('a pending save captures the clicked revision and keeps later edits dirty', async () => {
  const entered = deferred(), finish = deferred();
  const {ids, choose, state, draft} = setup();
  draft.beforeCommit = () => { entered.resolve(); return finish.promise; };
  await choose();
  await ids.translate.fire('click');
  state.review.edit(0, 'Primera edición.');
  const saving = ids['review-save'].fire('click');
  await entered.promise;
  state.review.edit(0, 'Segunda edición.');
  finish.resolve(); await saving;
  assert.deepEqual(draft.record.editedLines, ['Primera edición.']);
  assert.deepEqual(state.review.getLines(), ['Segunda edición.']);
  assert.equal(state.review.hasUnsaved(), true);
  assert.equal(ids['review-save'].disabled, false);
  ids.export.click();
  assert.equal(await state.blob.text(), subtitle.replace('Hello!', 'Segunda edición.'));
});

test('a pending save for a previous file cannot mark an unrelated review as saved', async () => {
  const entered = deferred(), finish = deferred();
  const {ids, choose, state, draft} = setup({confirm: () => true});
  draft.beforeCommit = () => { entered.resolve(); return finish.promise; };
  await choose('first.srt');
  await ids.translate.fire('click');
  state.review.edit(0, 'Primera edición.');
  const saving = ids['review-save'].fire('click');
  await entered.promise;
  await choose('second.srt');
  await ids.translate.fire('click');
  state.review.edit(0, 'Nueva película.');
  finish.resolve(); await saving;
  assert.equal(draft.record.filename, 'first.srt');
  assert.equal(ids['saved-draft-name'].textContent, 'first.es.srt');
  assert.equal(ids['result-file'].textContent, 'second.es.srt');
  assert.deepEqual(state.review.getLines(), ['Nueva película.']);
  assert.equal(state.review.hasUnsaved(), true);
  assert.equal(ids['review-save'].disabled, false);
});

test('a save from a second tab cannot silently overwrite newer dialogue, and the losing tab can still download', async () => {
  const draft = memoryDraft();
  const first = setup({draft}), second = setup({draft});
  await Promise.all([first.choose(), second.choose()]);
  await Promise.all([first.ids.translate.fire('click'), second.ids.translate.fire('click')]);
  first.state.review.edit(0, 'Edición guardada.');
  await first.ids['review-save'].fire('click');
  second.state.review.edit(0, 'Mi otra edición.');
  await second.ids['review-save'].fire('click');
  assert.match(second.ids['review-status'].textContent, /another tab/i);
  assert.deepEqual(draft.record.editedLines, ['Edición guardada.']);
  assert.equal(second.state.review.hasUnsaved(), true);
  second.ids['review-download'].click();
  assert.equal(await second.state.blob.text(), subtitle.replace('Hello!', 'Mi otra edición.'));
  await second.ids['review-save'].fire('click');
  assert.deepEqual(draft.record.editedLines, ['Mi otra edición.']);
});

test('declining to replace another subtitle’s saved review keeps that saved copy and the open review', async () => {
  const {state, ids, choose, draft} = setup();
  await choose('first.srt');
  await ids.translate.fire('click');
  await ids['review-save'].fire('click');
  await choose('second.srt');
  await ids.translate.fire('click');
  state.review.edit(0, 'Una revisión.');
  await ids['review-save'].fire('click');
  assert.match(state.confirmations.at(-1), /first\.es\.srt/);
  assert.equal(draft.writes, 1);
  assert.equal(draft.record.filename, 'first.srt');
  assert.deepEqual(state.review.getLines(), ['Una revisión.']);
});

function generatedResult(lines) {
  return {start:async () => ({
    mode:'standard', destroy() {}, async translate() { return lines.slice(); }
  })};
}

test('newly generated dialogue is cleaned before review, while manual edits stay strict', async () => {
  const {state, ids, choose, draft} = setup({engine:generatedResult(['— ¡Hola!'])});
  await choose();
  await ids.translate.fire('click');
  assert.deepEqual(state.review.getLines(), ['¡Hola!']);
  ids.export.click();
  assert.equal(await state.blob.text(), subtitle.replace('Hello!', '¡Hola!'));
  state.blob = undefined;
  state.review.edit(0, '— Mi edición.');
  ids.export.click(); await ids['review-save'].fire('click');
  assert.equal(state.blob, undefined);
  assert.equal(draft.writes, 0);
  assert.deepEqual(state.review.getLines(), ['— Mi edición.']);
});

test('one invalid generated fragment opens the complete review; correcting it can save, reload and export without rerunning', async () => {
  const source = subtitle + '\r\n8\r\n00:00:03,000 --> 00:00:04,200\r\nSecond line.\r\n' +
    '\r\n9\r\n00:00:04,300 --> 00:00:05,600\r\nThird line.\r\n';
  const invalid = '00:00:01,010 --> 00:00:03,200';
  const draft = memoryDraft();
  const {state, ids, choose} = setup({draft, engine:generatedResult(['— ¡Hola!',invalid,'Tercera línea.'])});
  await choose('full.srt',source);
  await ids.translate.fire('click');
  assert.equal(ids['translation-output'].hidden, false);
  assert.equal(state.review.focusedUnit, 1);
  assert.deepEqual(state.review.getLines(), ['¡Hola!', invalid, 'Tercera línea.']);
  assert.match(ids['translation-status'].textContent, /highlighted dialogue/i);
  assert.match(ids['review-status'].textContent, /cue 2/i);
  ids.export.click(); await ids['review-save'].fire('click');
  assert.equal(state.blob, undefined); assert.equal(draft.writes, 0);
  state.review.edit(1, 'Segunda línea.');
  await ids['review-save'].fire('click');
  assert.equal(draft.writes, 1);
  assert.equal(draft.record.generatedLines[1], invalid);
  assert.equal(draft.record.editedLines[1], 'Segunda línea.');
  assert.match(ids['translation-status'].textContent, /ready to export/i);
  const reload = setup({draft});
  await flush(); reload.ids['resume-draft'].click();
  assert.equal(reload.ids['translation-output'].hidden, false);
  reload.ids.export.click();
  assert.equal(await reload.state.blob.text(), source.replace('Hello!', '¡Hola!')
    .replace('Second line.', 'Segunda línea.').replace('Third line.', 'Tercera línea.'));
  assert.equal(reload.state.starts, 0);
});

test('a truncated model result cannot be offered as a complete review or download', async () => {
  const {state, ids, choose, draft} = setup({engine:generatedResult([])});
  await choose();
  await ids.translate.fire('click');
  assert.equal(ids['translation-output'].hidden, true);
  assert.equal(ids.export.disabled, true);
  ids.export.click(); await ids['review-save'].fire('click');
  assert.equal(state.blob, undefined); assert.equal(draft.writes, 0);
});
