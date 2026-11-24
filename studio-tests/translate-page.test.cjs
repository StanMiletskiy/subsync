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
function setup({detected = 'en', engine = {}, chrome = true, hasDetector = true, locale = 'en'} = {}) {
  const ids = Object.fromEntries([...template.matchAll(/ id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  const source = ids['source-language'];
  source.append(new Element());
  ids.translate.disabled = true; ids.export.disabled = true; ids['translation-output'].hidden = true;
  const state = {ids, destroyed:0, detects:0, starts:0, reads:0, pairs:[]};
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
    addEventListener() {},setTimeout(fn) { fn(); },
    URL:{createObjectURL(blob) { state.blob=blob; return 'blob:local'; },revokeObjectURL() {}},
  };
  if (hasDetector) scope.LanguageDetector = {create() {
    state.detects++;
    return Promise.resolve({detect:async () => [{detectedLanguage:detected,confidence:0.98}], destroy() {}});
  }};
  init(scope);
  const choose = (name = 'film.en.srt') => {
    ids['subtitle-file'].files = [{name, arrayBuffer:async () => {state.reads++;return new TextEncoder().encode(subtitle).buffer;}}];
    return ids['subtitle-file'].fire('change');
  };
  const select = (id, val) => {ids[id].value=val;return ids[id].fire('change');};
  return {state,ids,choose,select,doc};
}

test('automatic SRT translation chooses a different target and exports a complete local subtitle', async () => {
  const {state,ids,choose,doc} = setup();
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
  assert.equal(state.destroyed,1);
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
