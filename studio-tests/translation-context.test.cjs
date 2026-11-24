// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../studio/translation-context');

function film(count, replacements) {
  return Array.from({length:count}, (_, i) => ({cue:i + 1, text:replacements[i] || 'We will see.'}));
}

test('retrieves grounded earlier and later terminology across a feature, excluding unrelated future dialogue', () => {
  const records = film(1400, {
    4:'The Arven relay has a red indicator.',
    710:'Arven relay, do you read?',
    1373:'Keep the Arven relay on the emergency channel.',
    1398:'The missing sister moved overseas.'
  });
  const context = create(records, 'en');
  context.remember(4, 'У ретранслятора Арвен красный индикатор.');
  const evidence = context.forUnit(710);
  assert.deepEqual(evidence.related.map(x=>x.index), [4,1373]);
  assert.equal(evidence.related[0].translation, 'У ретранслятора Арвен красный индикатор.');
  assert.equal(evidence.related[1].translation, undefined);
  assert.ok(evidence.recurringTerms.some(t => t.toLowerCase() === 'arven relay'));
  assert.doesNotMatch(JSON.stringify(evidence), /sister|overseas/);
  assert.deepEqual(context.forUnit(10), {related:[],recurringTerms:[]});
});

test('uses word boundaries for unspaced scripts and finds later context before translation has started', () => {
  const records = film(100, {0:'青葉駅で待ってください。', 98:'次の電車は青葉駅に止まります。'});
  const context = create(records, 'ja');
  const [later] = context.forUnit(0).related;
  assert.equal(later.index, 98);
  assert.equal(later.source, records[98].text);
  assert.equal(later.position,'later');
  assert.equal(later.translation,undefined);
});

test('caps evidence and avoids fabricating a target or pairing fragments from long lines', () => {
  const records = film(82, {12:'We checked the Minaret vault.', 60:'Unrelated preamble. '.repeat(20) +
    'The Minaret vault needs the other lock.' + ' A long unrelated ending.'.repeat(15)});
  const context = create(records,'en');
  context.remember(60,'Слишком ранний результат.');
  const ahead = context.forUnit(12);
  assert.equal(ahead.related.length,1);
  assert.ok(Array.from(ahead.related[0].source).length <=120);
  assert.match(ahead.related[0].source,/Minaret vault/);
  assert.equal(ahead.related[0].translation,undefined);
  context.remember(12, 'Очень длинная строка. '.repeat(20));
  assert.equal(context.forUnit(60).related[0].translation,undefined);
  assert.deepEqual(context.forUnit(-1), {related:[],recurringTerms:[]});
});

test('reuses an accepted whole phrase only in the same substantial exchange, and declines conflicting precedents', () => {
  const before = 'Is the east gate still locked?', line = 'Please bring the spare key.', after = 'The caretaker has it.';
  const records = film(70, {3:before,4:line,5:after, 16:'What do we need?',17:line,18:after,
    21:before,22:'Yes.',23:after, 29:before,30:'Yes.',31:after,
    44:before,45:line,46:after, 62:before,63:line,64:after});
  const context = create(records,'en');
  assert.equal(context.reuse(45), null);
  context.remember(4,'Принеси запасной ключ.');
  assert.equal(context.reuse(17), null);
  assert.equal(context.reuse(45),'Принеси запасной ключ.');
  context.remember(22,'Да.');
  assert.equal(context.reuse(30),null);
  context.remember(45,'Принесите запасной ключ.');
  assert.equal(context.reuse(63),null);
});

test('a rare combination of common words and occasional sentence capitals cannot link unrelated distant scenes', () => {
  const records = Array.from({length:80}, (_,i) => ({text:i % 2 ? 'Do you know?' : 'We both know.'}));
  records[4] = {text:'You know what? Here we go.'};
  records[54] = {text:'Do you know what the message says?'};
  const context = create(records,'en');
  assert.deepEqual(context.forUnit(4), {related:[],recurringTerms:[]});
});
