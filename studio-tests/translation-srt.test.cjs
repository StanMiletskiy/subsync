/* SPDX-License-Identifier: GPL-3.0-or-later */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {prepare} = require('../studio/translation-srt');
const {parse,decode} = require('../studio/srt');

test('one text unit per physical line; preserve cue controls, EOLs, BOM, styling and offsets', () => {
  const original = '\uFEFFcue-9\r\n00:00:01.5 --> 00:00:03.80 position:40%\r\n<i>- Tell me\r\nwhere you went.</i>\r\n—   Home!\r\n\r\n77\n00:00:04,000 --> 00:00:05,000\n{\\an8}[Door shuts]\n';
  const prepared = prepare(original);
  assert.deepEqual(prepared.units, [
    {id:0,cue:1,line:original.indexOf('<i>'),text:'Tell me'},
    {id:1,cue:1,line:original.indexOf('where'),text:'where you went.'},
    {id:2,cue:1,line:original.indexOf('—'),text:'Home!'},
    {id:3,cue:2,line:original.indexOf('{'),text:'Door shuts'},
  ]);
  assert.equal(prepared.cueCount, 2);
  assert.equal(prepared.render(prepared.units.map(x => x.text)), original);
  const text = prepared.render(['Dis-moi', 'où tu es allé.', 'Chez moi !', 'La porte se ferme']);
  assert.equal(text, original.replace('Tell me\r\nwhere you went.', 'Dis-moi\r\noù tu es allé.').replace('Home!', 'Chez moi !').replace('Door shuts','La porte se ferme'));
  const converted = parse(text), previous = parse(original);
  assert.deepEqual(converted.cues.map(c => [c.start,c.end]), previous.cues.map(c => [c.start,c.end]));
  for (const cue of converted.cues) assert.equal(text.slice(cue.bodyStart, cue.bodyEnd), cue.text);
});

test('hard breaks/inline markup and right-to-left text preserve formatting and cue boundaries', () => {
  const raw = '00:00:00,000 --> 00:00:02,000\r♪ Wait <b>here</b> with me ♪\r\r00:00:03,000 --> 00:00:05,000\r-שלום\r- בסדר\r';
  const result = prepare(raw);
  assert.deepEqual(result.units.map(x => x.text), ['Wait','here','with me','שלום','בסדר']);
  assert.equal(result.render(['Reste','ici','avec moi','Salut','Bien']), raw.replace('Wait','Reste').replace('here','ici').replace('with me','avec moi').replace('שלום','Salut').replace('בסדר','Bien'));
});

test('localized punctuation, entities, markup-like output and model line breaks remain plain cue text', () => {
  const raw = '7\n0:00:01,0 --> 0:00:02,0\nFish &amp; chips?\n';
  const p = prepare(raw);
  assert.deepEqual(p.units.map(x => x.text), ['Fish & chips?']);
  assert.equal(p.render(['<poisson> &\n\n frites ?']), raw.replace('Fish &amp; chips?', '&lt;poisson&gt; &amp; frites ?'));
  for (const result of ['', null, 'Hello\x00', '{\\an3}markup','hello\n2\n00:00:05,000 --> 00:00:06,000\nextra']) {
    assert.throws(() => p.render([result]), /cue 1/);
  }
  assert.throws(() => p.render([]), /incomplete/);
});

test('CJK line slots and punctuation remain independent; untranslatable cues remain byte-for-byte', () => {
  const raw = '1\n00:00:01,000 --> 00:00:02,000\nおはよう\nございます。\n\n2\n00:00:03,000 --> 00:00:04,000\n♪ 123 ♪\n\n3\n00:00:05,000 --> 00:00:06,000\n';
  const p = prepare(raw);
  assert.equal(p.cueCount, 3);
  assert.deepEqual(p.units.map(x => x.text), ['おはよう','ございます。']);
  assert.equal(p.render(['Good','morning.']), raw.replace('おはよう\nございます。','Good\nmorning.'));
  assert.equal(p.render(['おはよう','ございます。']), raw);
  const legacy = decode(Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nCaf\xe9\r\n', 'latin1'), 'windows-1252');
  assert.equal(prepare(legacy).units[0].text,'Café');
});

test('sample excludes identifiers and timestamps and an invalid file cannot export', () => {
  assert.throws(() => prepare('Hello world'), /Invalid SRT/);
  const empty = prepare('70\n00:00:01,000 --> 00:00:02,000\n1234\n');
  assert.equal(empty.sample,'');
  assert.deepEqual(empty.units,[]);
  assert.equal(empty.render([]),'70\n00:00:01,000 --> 00:00:02,000\n1234\n');
});

test('mixed sound captions and inline hard breaks never become model-generated formatting', () => {
  const text = '00:00:01,000 --> 00:00:05,000\n[Footsteps] Wait!\\NCome here.';
  const result = prepare(text);
  assert.deepEqual(result.units.map(unit => unit.text), ['Footsteps', 'Wait!', 'Come here.']);
  assert.equal(result.render(['Шаги', 'Стой!', 'Иди сюда.']), '00:00:01,000 --> 00:00:05,000\n[Шаги] Стой!\\NИди сюда.');
});

test('single-word translations keep all mixed physical line endings and adjacent layout bytes', () => {
  const original = '\uFEFF42\r\n00:00:01,400 --> 00:00:05,777  X1:30\r\n\t-   <i>  A rather long line  </i> \n   another clause\t\r—\u00a0Final commentary.  \r\n\r\n';
  const p = prepare(original);
  const expected = original.replace('A rather long line','Oui').replace('another clause','ici').replace('Final commentary.','Voilà.');
  assert.deepEqual(p.units.map(unit=>unit.text),['A rather long line','another clause','Final commentary.']);
  assert.equal(p.render(['Oui','ici','Voilà.']),expected);
  assert.equal(p.render(['Oui','ici','Voilà.']).split(/\r\n|[\r\n]/).length,original.split(/\r\n|[\r\n]/).length);
  assert.equal(p.render(p.units.map(unit=>unit.text)),original);
});

test('ASS, comments, quoted HTML attributes, BBCode, entities and spacing are immutable', () => {
  const original = "00:00:01,000 --> 00:00:05,000\n{\\an7\\pos(12,45)}[i] <font title='a > b'>  Hello </font> [/i]&nbsp;world.\n<!-- Caption note -->{y:i}  End.";
  const p = prepare(original);
  assert.deepEqual(p.units.map(unit=>unit.text),['Hello','world.','End.']);
  assert.equal(p.render(['Hola','mundo.','Fin.']),original.replace('Hello','Hola').replace('world.','mundo.').replace('End.','Fin.'));
});

test('rejects newly introduced speaker metadata or structural codes while preserving the source', () => {
  const original = 'a1\n00:00:01,000 --> 00:00:05,000\nHello friend.\nGoodbye.';
  const p = prepare(original);
  for (const value of ['— New speaker','[A new caption]','♪ New music ♪']) {
    assert.throws(() => p.render([value,'Bye.']),/formatting/);
  }
  assert.throws(() => p.render(['Only one word.']),/incomplete/);
  assert.equal(p.render(['Yes.','No.']),original.replace('Hello friend.','Yes.').replace('Goodbye.','No.'));
});

test('review exposes every cue, its exact metadata and only the writable text within each physical line', () => {
  const firstTiming = '  0:00:01.50  --> 00:00:04,750  X1:31';
  const original = '\uFEFF 009 \r\n' + firstTiming + '\r\n—  <i>Café &amp; thé</i> ♪\r\n\t(Спасибо!)\t\r\n\r\n' +
    '00:00:04,850 --> 00:00:06,500\n{\\an8}123♪\n\n' +
    'A09\r00:00:06,700 --> 00:00:08,000';
  const p = prepare(original);
  assert.equal(p.cues.length, p.cueCount);
  assert.deepEqual(p.cues[0], {
    number:1, identifier:' 009 ', timing:firstTiming, original:'—  <i>Café &amp; thé</i> ♪\r\n\t(Спасибо!)\t',
    lines:[
      [{text:'—  <i>',unitId:null},{text:'Café & thé',unitId:0},{text:'</i> ♪',unitId:null}],
      [{text:'\t',unitId:null},{text:'(Спасибо!)',unitId:1},{text:'\t',unitId:null}],
    ],
  });
  assert.deepEqual(p.cues[1], {
    number:2, identifier:null, timing:'00:00:04,850 --> 00:00:06,500',original:'{\\an8}123♪',
    lines:[[{text:'{\\an8}123♪',unitId:null}]],
  });
  assert.deepEqual(p.cues[2], {number:3,identifier:'A09',timing:'00:00:06,700 --> 00:00:08,000',original:'',lines:[]});
  const values = p.units.map(unit => unit.text);
  values[p.cues[0].lines[0][1].unitId] = 'Кофе и чай';
  assert.equal(p.render(values), original.replace('Café &amp; thé', 'Кофе и чай'));
});

test('review distinguishes an absent identifier from duplicate identifiers and maps repeated text independently', () => {
  const original = '\uFEFF00:00:00,100 --> 00:00:01,000\nはい！\n\n01\n00:00:01,100 --> 00:00:02,000\n[はい！]\n\n' +
    '01\n00:00:02,100 --> 00:00:03,000\n— はい！';
  const p = prepare(original);
  assert.deepEqual(p.cues.map(c=>c.identifier),[null,'01','01']);
  assert.deepEqual(p.cues.map(c=>c.number),[1,2,3]);
  assert.deepEqual(p.cues[0].lines,[[{text:'はい！',unitId:0}]]);
  assert.deepEqual(p.cues[1].lines,[[{text:'[',unitId:null},{text:'はい！',unitId:1},{text:']',unitId:null}]]);
  assert.deepEqual(p.cues[2].lines,[[{text:'— ',unitId:null},{text:'はい！',unitId:2}]]);
  assert.equal(p.render(['Да!','Точно!','Конечно!']),original.replace('はい！','Да!').replace('はい！','Точно!').replace('はい！','Конечно!'));
});

test('save errors identify the source cue and text field across arbitrarily numbered cues', () => {
  const source = Array.from({length:14}, (_,i) => 'same-id\n00:00:00,100 --> 00:00:01,000\n' +
    'First line.\n<i>Later line.</i>').join('\n\n');
  const p = prepare(source);
  const values = p.units.map(u=>'Bonjour.');
  assert.equal(p.cues[12].lines[1][1].unitId,25);
  for (const bad of ['', '{\\pos(2,3)}oops','[added caption]','♪ extra']) {
    values[25] = bad;
    assert.throws(() => p.render(values), error => error.cueNumber === 13 && error.unitId === 25 &&
      (!bad || bad.startsWith('{') || error.message.includes('formatting')));
  }
  values[25] = 'Au revoir.';
  assert.doesNotThrow(() => p.render(values));
});
