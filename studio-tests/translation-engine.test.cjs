/* SPDX-License-Identifier: GPL-3.0-or-later */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {plan, start} = require('../studio/translation-engine');

function environment({supported = ['en', 'es'], native = true, generate, makeNano, makeNative} = {}) {
  const calls = {creates: [], prompts: [], native: [], closes: [], options: []};
  const scope = {
    Translator: {
      availability: async () => native ? 'downloadable' : 'unavailable',
      create(options) {
        calls.creates.push('translator');
        if (makeNative) return makeNative(options);
        return {async translate(text) { calls.native.push(text); return 'T ' + text; },
          destroy() { calls.closes.push('translator'); }};
      },
    },
    LanguageModel: {
      async availability(options) {
        const codes = [...options.expectedInputs[0].languages, ...options.expectedOutputs[0].languages];
        return codes.every(code => supported.includes(code)) ? 'available' : 'unavailable';
      },
      create(options) {
        calls.creates.push('nano');
        calls.options.push(options);
        if (makeNano) return makeNano(options);
        return {async clone() {
          return {async prompt(raw, request) {
            const batch = JSON.parse(raw);
            calls.prompts.push({batch, request});
            return generate ? generate(batch) : JSON.stringify(batch.requested.map(({id, text}) => ({id, text: 'N ' + text})));
          }, destroy() { calls.closes.push('batch'); }};
        }, destroy() { calls.closes.push('nano'); }};
      },
    },
  };
  return {scope, calls};
}

const units = Array.from({length: 23}, (_, i) => ({id: i + 10, cue: i + 1, text: 'line ' + i}));

test('probes mode using local APIs and both languages, including future runtime languages', async () => {
  for (const [a, b, expected] of [
    ['en', 'es', 'context'], ['en', 'ru', 'prepare'], ['ru', 'es', 'review'], ['ru', 'th', 'standard'],
  ]) {
    const {scope} = environment();
    assert.equal((await plan(a, b, scope)).mode, expected);
  }
  assert.equal((await plan('en', 'ru', environment({supported: ['ru','en']}).scope)).mode, 'context');
  assert.equal((await plan('ru', 'th', {})).mode, 'unavailable');
  assert.equal((await plan('en', 'en', {})).mode, 'unavailable');
});

test('batches crop context, preserve IDs, and clone clean sessions per window', async () => {
  const {scope, calls} = environment();
  const selected = await plan('en', 'es', scope);
  const opened = start(selected, {scope});
  assert.deepEqual(calls.creates, ['translator','nano']);
  const engine = await opened;
  const progress = [];
  const result = await engine.translate(units, {onProgress: (...args) => progress.push(args)});
  assert.deepEqual(result, units.map(unit => 'N ' + unit.text));
  assert.deepEqual(progress.at(-1), [23,23]);
  assert.equal(calls.prompts.length, 3);
  const {batch,request} = calls.prompts[1];
  assert.equal(batch.before.length, 4);
  assert.deepEqual(batch.before[3], {...units[7], previousTranslation: 'N ' + units[7].text});
  assert.equal(batch.after[0].id, units[16].id);
  assert.equal(request.responseConstraint.items.properties.id.type, 'integer');
  assert.equal(calls.closes.filter(c => c === 'batch').length, 3);
  assert.ok(calls.options[0].initialPrompts[0].content.includes('certainty'));
  assert.ok(calls.options[0].expectedInputs[0].languages.includes('es'));
  engine.destroy(); engine.destroy();
  assert.deepEqual(calls.closes.slice(-2), ['nano','translator']);
});

test('context is prepared in the source language for Russian and reviewed in supported target languages', async () => {
  for (const [source, target, prefix, mode] of [['en','ru','T N ','prepare'],['ru','es','N T ','review']]) {
    const {scope, calls} = environment();
    const engine = await start(await plan(source, target, scope), {scope});
    const result = await engine.translate(units);
    assert.equal(engine.mode, mode);
    assert.deepEqual(result, units.map(unit => prefix + unit.text));
    const job = calls.prompts[1].batch;
    if (mode === 'prepare') assert.equal(job.before[0].previousTranslation, undefined);
    if (mode === 'review') {
      assert.ok(job.requested.every(r => r.text.startsWith('T ')));
      assert.ok(job.after.every(r => r.text.startsWith('T ')));
      assert.equal(calls.native.length, units.length);
    }
    engine.destroy();
  }
});

test('invalid JSON, swapped IDs, empty rows and injected line breaks fall back to local translation', async () => {
  for (const generate of [
    () => 'no subtitles',
    batch => JSON.stringify(batch.requested.slice(1)),
    batch => JSON.stringify(batch.requested.slice().reverse()),
    batch => JSON.stringify(batch.requested.map(({id})=>({id,text:''}))),
    batch => JSON.stringify(batch.requested.map(({id})=>({id,text:'cue\n900\n00:00:01,000 --> 00:00:02,000'}))),
  ]) {
    const {scope} = environment({generate});
    const engine = await start(await plan('en', 'es', scope), {scope});
    const modes = [];
    const result = await engine.translate(units, {onMode:(...args)=>modes.push(args)});
    assert.deepEqual(result, units.map(unit=>'T ' + unit.text));
    assert.deepEqual(modes, [['context',0],['standard',0]]);
    engine.destroy();
  }
});

test('reports a switch mid-file, including number of already contextualized units', async () => {
  let pass = 0;
  const {scope} = environment({generate: batch => ++pass === 2 ? '{}' : JSON.stringify(batch.requested)});
  const engine = await start(await plan('en','es',scope),{scope});
  const modes = [];
  const lines = await engine.translate(units,{onMode:(...args)=>modes.push(args)});
  assert.deepEqual(modes,[['context',0],['standard',8]]);
  assert.deepEqual(lines, units.map((x,i) => (i<8?'':'T ') + x.text));
  engine.destroy();
});

test('cancellation and model startup failures release resources without a partial result', async () => {
  const controller = new AbortController();
  const {scope, calls} = environment();
  const engine = await start(await plan('en','es',scope), {scope,signal:controller.signal});
  await assert.rejects(engine.translate(units, {onProgress:()=>controller.abort()}),{name:'AbortError'});
  engine.destroy();
  assert.ok(calls.closes.includes('translator'));
  const fallback = environment({makeNano() { throw Error('model unavailable'); }});
  const standard = await start(await plan('en','es',fallback.scope),{scope:fallback.scope});
  assert.equal(standard.mode,'standard');
  standard.destroy();
  const broken = environment({native:false, generate:()=> 'bad json'});
  const onlyNano = await start(await plan('en','es',broken.scope),{scope:broken.scope});
  await assert.rejects(onlyNano.translate(units));
  onlyNano.destroy();
  const failed = environment({makeNative() { throw Error('language pack offline'); }});
  await assert.rejects(start(await plan('en','ru',failed.scope),{scope:failed.scope}),/language pack offline/);
  assert.ok(failed.calls.closes.includes('nano'));
});

test('validates native fallback and detects a passage of untranslated source sentences', async () => {
  const sentences = ['Please leave the envelope on the table.', 'Have you seen the signs outside?', 'Wait by the window until I come back.']
    .map((text,id) => ({text,id,cue:id+1}));
  const env = environment({generate: batch => JSON.stringify(batch.requested)});
  const engine = await start(await plan('en','es',env.scope),{scope:env.scope});
  assert.deepEqual(await engine.translate(sentences), sentences.map(c => 'T '+c.text));
  assert.equal(engine.mode,'standard');
  engine.destroy();
  const broken = environment({supported:[],makeNative:()=>({translate:async ()=>'one\n\n2\n00:00:01,000 --> 00:00:02,000',destroy(){}})});
  const invalid = await start(await plan('ru','th',broken.scope),{scope:broken.scope});
  await assert.rejects(invalid.translate(units),/malformed subtitle/);
  invalid.destroy();
});

test('feature-length subtitles keep bounded prompt windows and stable progress through the final record', async () => {
  const {scope,calls} = environment();
  const engine = await start(await plan('en','es',scope),{scope});
  const film = Array.from({length:2051},(_,i)=>({id:i*2,cue:i+1,text:'This is dialogue in cue '+i+'.'}));
  let progress=0;
  const translated = await engine.translate(film,{onProgress:(done,total) => {
    assert.ok(done > progress && done<=total);progress=done;
  }});
  assert.equal(translated[2050], 'N '+film[2050].text);
  assert.equal(progress,2051);
  assert.equal(calls.prompts.length,257);
  assert.ok(calls.prompts.every(({batch})=>batch.before.length+batch.requested.length+batch.after.length<=16));
  engine.destroy();
});

test('a supported pair that Chrome cannot initialize has a retryable, language-specific error', async () => {
  const env = environment({makeNative() { throw new DOMException('Unable to create translator for the given source and target language.', 'NotSupportedError'); }});
  await assert.rejects(start(await plan('en','ru',env.scope),{scope:env.scope}), /English → Russian language pack.*retry/);
});

test('restores explicit terminal force only in the final language on all local routes', async () => {
  for (const [source, target, original, raw, want, mode] of [
    ['en','ru','Yes.','да','Да.','prepare'],
    ['en','es','Yes?','¿Sí!','¿Sí?','context'],
    ['ru','es','Правда?','«De verdad»','«De verdad?»','review'],
    ['ru','ar','Правда?','«حقاً»','«حقاً؟»','standard'],
    ['en','zh','Wait.','等等！','等等。','prepare'],
    ['en','ja','Wait...','「待って」','「待って…」','prepare'],
    ['en','hi','Yes.','हाँ','हाँ।','prepare'],
    ['en','ru','Close the door.','Закрой Дверь.','Закрой Дверь.','prepare'],
    ['en','ru','yes','да','да','prepare'],
    ['en','ru','No…','нет!','Нет…','prepare'],
    ['zh','en','等一下。','Wait。','Wait.','review'],
  ]) {
    const env = environment({
      generate: batch=>JSON.stringify(batch.requested.map(({id})=>({id,text:raw}))),
      makeNative:()=>({translate:async()=>raw,destroy(){}}),
    });
    const engine = await start(await plan(source,target,env.scope),{scope:env.scope});
    assert.equal(engine.mode,mode);
    assert.deepEqual(await engine.translate([{id:1,cue:1,text:original}]),[want]);
    engine.destroy();
  }
});
