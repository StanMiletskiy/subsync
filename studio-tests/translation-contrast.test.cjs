/* SPDX-License-Identifier: GPL-3.0-or-later */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {inspect,recover} = require('../studio/translation-contrast');

function issue(source, target) { return inspect(source,target,'en','ru'); }
function responses(map, calls = []) {
  return async (input, {signal}) => {
    calls.push(input);
    signal?.throwIfAborted();
    return map[input] || 'Не удалось.';
  };
}

const labels = 'Can the apprentice explain the distinction between "fold" and "twist"?';
const nominal = 'Объяснит ли ученик разницу между «сгибом» и «сгибом»?';
const forms = {
  'Can the apprentice explain the distinction between "to fold" and "to twist"?':'Будут ли они различать? Нет.',
  'to fold':'сгибать','They can fold.':'Они могут сгибать.',
  'to twist':'крутить','They can twist.':'Они могут крутить.',
};
const full = 'Can the apprentice explain the distinction between "to fold" and "to twist"?';
const action = 'Can the locksmith distinguish a lock from a latch?';
const target = 'Разве слесарь сумеет отличить замок от замка?';
const quoted = 'Can the locksmith distinguish "a lock" from "a latch"?';
const native = {[quoted]:'Сможет ли мастер назвать "замок" от "защёлки"?','a latch':'Замок','with a latch':'С защёлкой'};

test('finds explicit contrasts, including case-inflected semantic duplicates', () => {
  assert.ok(issue(labels,nominal));
  assert.ok(issue(action,target));
  assert.ok(issue('Can you distinguish a carton from a packet?', 'Ты можешь отличить пакет от пакета?'));
  for (const [a,b] of [
    [action,'Разве слесарь сумеет отличить замок двери от замка сундука?'],
    [action,'Разве слесарь сумеет отличить щеколду от петли?'],
    ['Could you tell me from experience?',target],
    ['Can they tell a lock from the lock?',target],
    ['The words "lock" and "twist" appear here.',nominal],
    ['Can the apprentice explain the distinction between "twist" and "twist"?',nominal],
  ]) assert.equal(issue(a,b),null);
  assert.equal(inspect(labels,nominal,'fr','ru'),null);
  assert.equal(inspect(labels,nominal,'en','uk'),null);
});

test('quoted verb labels require local grammatical evidence and two independent Russian verb translations', async () => {
  const base = issue(labels,nominal);
  const translations = {...forms,[full]:'Мастер заметил разницу между «сгибать» и «крутить»?'};
  const run = (sourceContext, changes={}) => recover(base,{sourceContext,translate:responses({...translations,...changes})});
  const good = await run(['Several brass pins were twisted during assembly.']);
  assert.deepEqual(good,{text:'Объяснит ли ученик разницу между «сгибать» и «крутить»?',status:'recovered'});
  assert.deepEqual(await run([]),{text:nominal,status:'unresolved'});
  assert.equal((await run(['They can book the room.'])).status,'unresolved');
  assert.equal((await run(['Both wires were twisted.'],{'They can twist.':'Они могут говорить.'})).status,'unresolved');
  assert.equal((await run(['Both wires were twisted.'],{[full]:'Разве слесарь сумеет отличить сгибать от крутить?'})).status,'unresolved');
});

test('other ambiguous nouns do not become verbs solely because the model can translate both infinitives', async () => {
  const question = 'Can she tell "duck" from "goose"?', answer = 'Может ли она отличить «птицу» от «птицы»?';
  const translations = {
    'Can she tell "to duck" from "to goose"?':'Может ли она отличить «пригнуться» от «ущипнуть»?',
    'to duck':'пригнуться', 'They can duck.':'Они могут пригнуться.',
    'to goose':'ущипнуть','They can goose.':'Они могут ущипнуть.',
  };
  const run = await recover(issue(question,answer),{sourceContext:'We had ducked.', translate:responses(translations)});
  assert.deepEqual(run,{text:answer,status:'unresolved'});
});

test('uses a corroborated noun in the original grammatical slot and keeps the original clause and punctuation', async () => {
  const calls = [];
  const output = await recover(issue(action,target),{translate:responses(native,calls)});
  assert.deepEqual(output,{text:'Разве слесарь сумеет отличить замок от защёлки?',status:'recovered'});
  assert.deepEqual(calls,[quoted,'a latch','with a latch']);
});

test('non-film vocabulary works and nominative cannot be copied into an unquoted accusative slot', async () => {
  const a = 'Can you distinguish a carton from a packet?', b = 'Ты можешь отличить пакет от пакета?';
  const q = 'Can you distinguish "a carton" from "a packet"?';
  const map = {[q]:'Скажешь "коробку" от "пакета"?','a carton':'коробка'};
  assert.deepEqual(await recover(issue(a,b),{translate:responses(map)}),
    {text:'Ты можешь отличить коробку от пакета?',status:'recovered'});
  const wrong = {...map,[q]:'Скажешь "коробка" от "пакета"?','with a carton':'С коробкой','I see a carton.':'Я вижу коробку.'};
  assert.deepEqual(await recover(issue(a,b),{translate:responses(wrong)}),{text:b,status:'unresolved'});
});

test('unverified terms, swapped grammatical relations and incomplete alternative output leave the original intact', async () => {
  for (const changes of [
    {'with a latch':'С замком'},
    {[quoted]:'Может, между «замок» и «защёлка» есть разница?'},
    {[quoted]:'Сможет ли мастер назвать "замок" от "замка"?'},
    {[quoted]:'защёлки'}, {[quoted]:'<i>замок</i>'},
  ]) {
    assert.deepEqual(await recover(issue(action,target),{translate:responses({...native,...changes})}),
      {text:target,status:'unresolved'});
  }
  assert.deepEqual(await recover(issue(action,target), {translate:async()=>{throw Error('unavailable');}}),
    {text:target,status:'unresolved'});
});

test('cancelling an optional probe cancels the task', async () => {
  const c = new AbortController();
  await assert.rejects(recover(issue(action,target),{signal:c.signal,translate:async()=>{c.abort();return '';}}),{name:'AbortError'});
});
