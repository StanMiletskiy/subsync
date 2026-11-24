/* SPDX-License-Identifier: GPL-3.0-or-later */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {plan, redistribute} = require('../studio/translation-phrases');
const {prepare} = require('../studio/translation-srt');

function pair(first, second, firstTime='00:00:01,000 --> 00:00:03,000', secondTime='00:00:03,200 --> 00:00:05,000') {
  return prepare('id-7\r\n'+firstTime+'\r\n'+first+'\r\n\r\n008\r\n'+secondTime+'\r\n'+second+'\r\n');
}

test('plans complete phrases across soft wraps and consecutive cues; source order and IDs survive',()=>{
  const p=pair('I wanted to\r\ntell you,','before we go.');
  const groups=plan(p.units,'en');
  assert.equal(groups.length,1);
  assert.equal(groups[0].text,'I wanted to tell you, before we go.');
  assert.equal(groups[0].id,0);
  assert.deepEqual(groups[0].units.map(u=>u.id),[0,1,2]);
  assert.equal(p.units[1].phrase.startMs,1000);
  assert.equal(p.units[2].phrase.endMs,5000);
  const parts=redistribute(groups[0],'Я хотел сказать тебе, пока мы здесь.','ru');
  assert.equal(parts.length,3);
  assert.equal(parts.join(' '),'Я хотел сказать тебе, пока мы здесь.');
  const output=p.render(p.normalizeGenerated(parts));
  assert.ok(output.includes('id-7\r\n00:00:01,000 --> 00:00:03,000'));
  assert.ok(output.includes('\r\n\r\n008\r\n00:00:03,200 --> 00:00:05,000'));
});

test('stops at speaker, gaps, overlapping cues, changed position, styling, SDH, and complete sentences',()=>{
  const cases=[
    pair('We still need to','— hurry.'),
    pair('We still need to','MAYA: hurry.'),
    pair('We still need to','hurry.','00:00:00,100 --> 00:00:01,000','00:00:03,000 --> 00:00:04,000'),
    pair('We still need to','hurry.','00:00:00,100 --> 00:00:03,100','00:00:03,000 --> 00:00:04,000'),
    pair('We still need to','hurry.','00:00:00,100 --> 00:00:03,000 X1:10','00:00:03,200 --> 00:00:04,000 X1:40'),
    pair('We still need to','<i>hurry.</i>'),
    pair('We still need to','[footsteps]'),
    pair('I saw her.','come here!'),
    pair('I saw her','Now you see.'),
  ];
  for (const sample of cases) assert.equal(plan(sample.units,'en').length,2,sample.units.map(u=>u.text).join('|'));
  const styled=pair('He <i>really</i> tried.','Still waiting.');
  assert.deepEqual(plan(styled.units,'en').map(g=>g.units.length),[1,1,1,1]);
  const speakers=pair('- I wanted to\r\ntell you.','- Wait.');
  assert.deepEqual(plan(speakers.units,'en').map(g=>g.units.length),[2,1]);
});

test('joins CJK wraps without spaces and prefers actual word boundaries in unspaced target scripts',()=>{
  const zh=pair('我们需要','马上离开。');
  assert.equal(plan(zh.units,'zh')[0].text,'我们需要马上离开。');
  const phrase=plan(pair('We should','finish this together.').units,'en')[0];
  for(const [target,locale] of [['一起完成这项工作。','zh'],['一緒に終わらせましょう。','ja'],['วันนี้ฉันไปตลาด','th']]){
    const parts=redistribute(phrase,target,locale);
    assert.equal(parts.length,2);
    assert.equal(parts.join(''),target);
    const words=Array.from(new Intl.Segmenter(locale,{granularity:'word'}).segment(target));
    assert.ok(words.some(w=>w.index===parts[0].length && w.isWordLike),JSON.stringify(parts));
  }
});

test('cannot split one Latin word, emoji cluster or a word plus punctuation into two fixed slots',()=>{
  const group=plan(pair('We should','finish this together.').units,'en')[0];
  for (const target of ['Oui.','👩‍🚀','сло́во!','Oui «…».','a\nline',null]) assert.equal(redistribute(group,target,'fr'),null,String(target));
  for (const target of ['Ещё минута.','👨‍👩‍👧 👩‍🚀','خانه‌ها اینجا', 'Cafe\u0301 noir','Temperature -3']) {
    const out=redistribute(group,target,'ru');
    assert.equal(out.length,2);
    assert.equal(out.join(' '),target);
  }
});

test('compact CJK may break between whole graphemes when a dictionary word spans several fixed slots',()=>{
  const p=prepare('1\n00:00:01,000 --> 00:00:04,000\nWe\nshould\ngo.');
  const g=plan(p.units,'en')[0];
  assert.equal(g.units.length,3);
  const out=redistribute(g,'大学生','ja');
  assert.deepEqual(out,['大','学','生']);
  assert.equal(redistribute(g,'学生','ja'),null);
});

test('legacy inputs remain standalone and every source ID is covered exactly once in bounded groups',()=>{
  const legacy=[{id:47,cue:4,text:'soft'},{id:48,cue:4,text:'wrap'}];
  assert.deepEqual(plan(legacy,'en').map(g=>g.id),[47,48]);
  const long=prepare('1\n00:00:01,000 --> 00:00:05,000\n'+Array(14).fill('one').join('\n'));
  const groups=plan(long.units,'en');
  assert.ok(groups.every(g=>g.units.length<=6));
  assert.deepEqual(groups.flatMap(g=>g.units.map(u=>u.id)),long.units.map(u=>u.id));
});

test('cross-cue redistribution preserves numbers at their original display times, including local digits',()=>{
  const groups=plan(pair('The door number is 17,','and the room number is 43.').units,'en');
  assert.equal(groups.length,1);
  const result=redistribute(groups[0],'Чтобы открыть дверь, введите на панели число 17. Номер комнаты — 43.','ru');
  assert.deepEqual(result,['Чтобы открыть дверь, введите на панели число 17.','Номер комнаты — 43.']);
  assert.deepEqual(redistribute(groups[0],'رقم الباب ١٧، ورقم الغرفة ٤٣.','ar'),['رقم الباب ١٧،','ورقم الغرفة ٤٣.']);
  assert.equal(redistribute(groups[0],'Комната 43. На двери написано 17.','ru'),null);
  assert.equal(redistribute(groups[0],'Дверь семнадцать. Комната сорок три.','ru'),null);
  const sameTime=plan(prepare('1\n00:00:00,100 --> 00:00:04,000\nThe door number is 17,\nand the room number is 43.').units,'en')[0];
  const reverse=redistribute(sameTime,'Комната 43. На двери написано 17.','ru');
  assert.equal(reverse.join(' '),'Комната 43. На двери написано 17.');
});

test('timed clauses use shared unique names and corresponding punctuation or defer to safer translation',()=>{
  const group=plan(pair('We passed Breda,','and stopped in Delft.').units,'en')[0];
  assert.deepEqual(redistribute(group,'Nous avons traversé le centre de la ville de Breda, puis rejoint Delft.','fr'),
    ['Nous avons traversé le centre de la ville de Breda,','puis rejoint Delft.']);
  assert.equal(redistribute(group,'Nous avons rejoint Delft, en venant de Breda.','fr'),null);
  const clause=plan(pair('We went outside,','and met our friends.').units,'en')[0];
  assert.equal(redistribute(clause,'Nous avons retrouvé nos amis dehors.','fr'),null);
});

test('uniform tags can span a whole phrase; emphasis, speaker, positions and style changes are boundaries',()=>{
  const scoped=(body)=>plan(prepare('1\n00:00:01,000 --> 00:00:03,000\n'+body).units,'en');
  for(const body of [
    '<i>She finally gave\nup the habit.</i>',
    '<i>She finally gave</i>\n<i>up the habit.</i>',
    '<font face="Test" color="red">She finally gave\nup the habit.</font>',
  ]){
    assert.deepEqual(scoped(body).map(g=>g.text),['She finally gave up the habit.']);
  }
  for(const body of [
    '<i>She finally gave</i>\nup the habit.',
    '<i>She</i> finally gave\nup the habit.',
    '<i>She finally gave\n<b>up</b> the habit.</i>',
    '<font color=red>She finally gave</font>\n<font color=blue>up the habit.</font>',
    '<font x=100>She finally gave\nup the habit.</font>',
    '<i>She finally gave\nup the habit.',
    '{\\an8}She finally gave\nup the habit.',
    '<i>- You tried</i>\n<i>- I did.</i>',
    '<i>MAYA: You tried</i>\n<i>ADA: I did.</i>',
    'מיה: את רוצה\nנועה: כן',
    'مريم: لنذهب الآن\nآدم: لن أبقى',
    'रमा: घर जाना\nमोहन: मुझे जाना',
    '민수: 또 가야\n은지: 벌써요?',
  ]){
    assert.ok(scoped(body).every(g=>g.units.length===1),body);
  }
});
