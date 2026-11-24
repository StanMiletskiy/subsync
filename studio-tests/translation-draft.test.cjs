/* SPDX-License-Identifier: GPL-3.0-or-later */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {prepare} = require('../studio/translation-srt.js');
const js = fs.readFileSync(require.resolve('../studio/translation-draft.js'), 'utf8');

function page(indexedDB) {
  const scope = {indexedDB, crypto:require('node:crypto').webcrypto};
  vm.runInNewContext(js, scope);
  return scope.CueTranslationDraft;
}

// A write can fail after the individual request succeeds. Keep a staged copy
// until transaction completion so these tests distinguish saving from committing.
function storage() {
  const state = {exists:false, data:new Map(), blocked:false, failNextCommit:false, writes:0};
  let queue = Promise.resolve();
  state.open = () => {
    const request = {};
    queueMicrotask(() => {
      if (state.blocked) { request.onblocked(); return; }
      let aborted = false;
      request.transaction = {abort() { aborted = true; }};
      request.result = {
        createObjectStore() {},
        close() {},
        transaction() {
          let aborted = false;
          const transaction = {abort() { aborted = true; }};
          const operations = [];
          function run(action, write) {
            const req = {};
            operations.push({req, action, write});
            return req;
          }
          queue = queue.then(() => {
            const staged = new Map(state.data);
            let changed = false;
            // A successful read can add a write to this same exclusive transaction.
            for (const {req, action, write} of operations) {
              if (aborted) break;
              req.result = action(staged);
              changed ||= write;
              req.onsuccess?.();
            }
            if (aborted) return transaction.onabort();
            if (changed && state.failNextCommit) {
              state.failNextCommit = false;
              transaction.error = new DOMException('Storage is full.', 'QuotaExceededError');
              transaction.onabort();
            } else {
              if (changed) { state.data = staged; state.writes++; }
              transaction.oncomplete();
            }
          });
          transaction.objectStore = () => ({
            get: key => run(rows => structuredClone(rows.get(key)), false),
            put: (value,key) => run(rows => { rows.set(key, structuredClone(value)); return key; }, true),
            delete: key => run(rows => { rows.delete(key); }, true),
          });
          return transaction;
        },
      };
      if (!state.exists) {
        request.onupgradeneeded();
        if (aborted) {
          request.error = new DOMException('Upgrade aborted.', 'AbortError');
          request.onerror();
          return;
        }
        state.exists = true;
      }
      request.onsuccess();
    });
    return request;
  };
  return state;
}

const original = '\ufeff9\r\n00:00:01,200 --> 00:00:02,510 align:start\r\n- <i>Hello.</i>\r\n\r\n10\r\n00:00:03,000 --> 00:00:04,000\r\n- Thanks!\r\n';
function draft() {
  return {filename:'Кино.en.srt', sourceLanguage:'en', targetLanguage:'ru', sourceText:original,
    encoding:'utf-16le', generatedLines:['Здравствуйте.','Спасибо!'], editedLines:['Привет.','Спасибо!']};
}

test('only an explicit save creates a draft, and a fresh page can export the saved edits offline', async () => {
  const db = storage(), first = page(db);
  assert.equal(await first.load(), null);
  await first.clear();
  assert.equal(db.exists, false);
  const saved = await first.save(draft());
  assert.ok(Number.isSafeInteger(saved.savedAt));
  const restored = await page(db).load();
  assert.deepEqual(structuredClone(restored),structuredClone(saved));
  assert.equal(prepare(restored.sourceText).render(restored.editedLines),
    original.replace('Hello.', 'Привет.').replace('Thanks!', 'Спасибо!'));
  assert.equal(restored.encoding,'utf-16le');
  assert.equal(db.writes,1);
});

test('save captures values at the click and replaces only the single latest draft in call order', async () => {
  const db=storage(), api=page(db), first=draft(), second=draft();
  const pending=api.save(first);
  first.editedLines[0]='Later unsaved edit';
  assert.equal((await pending).editedLines[0],'Привет.');
  second.editedLines[0]='Второй вариант.';
  const newer=api.save(second);
  const read=api.load();
  await newer;
  assert.equal((await read).editedLines[0],'Второй вариант.');
  assert.equal(db.data.size,1);
  const deletion=api.clear();
  const after=api.load();
  await deletion;
  assert.equal(await after,null);
});

test('quota abort, blocked storage and invalid input leave the previous usable draft intact', async () => {
  const db=storage(), api=page(db);
  await api.save(draft());
  db.failNextCommit=true;
  await assert.rejects(api.save({...draft(), filename:'another.srt'}),{name:'QuotaExceededError'});
  assert.equal((await api.load()).filename,'Кино.en.srt');
  db.blocked=true;
  await assert.rejects(api.clear(),/blocking/);
  db.blocked=false;
  await assert.rejects(api.save({...draft(),editedLines:['incomplete']}),/incomplete/);
  assert.equal((await api.load()).editedLines[0],'Привет.');
  assert.equal(db.writes,1);
  await assert.rejects(page(undefined).load(),/unavailable/);
});

test('unknown or damaged snapshots are ignored and can be cleared', async () => {
  const db=storage(),api=page(db);
  db.exists=true;
  db.data.set('latest',{...draft(),version:2,savedAt:100});
  assert.equal(await api.load(),null);
  db.data.set('latest',{...draft(),version:1,savedAt:100,editedLines:new Array(2)});
  assert.equal(await api.load(),null);
  await api.clear();
  assert.equal(db.data.size,0);
});

test('only one of two tabs can replace the same revision and a stale tab cannot clear the winner', async () => {
  const db=storage(), tabA=page(db), tabB=page(db);
  const first=await tabA.save(draft(),null);
  await assert.rejects(tabB.save(draft(),null),{name:'DraftConflictError'});
  assert.equal((await tabB.load()).revision,first.revision);
  const competing=await Promise.allSettled([
    tabA.save({...draft(),filename:'A.srt'},first.revision),
    tabB.save({...draft(),filename:'B.srt'},first.revision),
  ]);
  assert.deepEqual(competing.map(out=>out.status).sort(),['fulfilled','rejected']);
  assert.equal(competing.find(out=>out.status==='rejected').reason.name,'DraftConflictError');
  const winner=competing.find(out=>out.status==='fulfilled').value;
  assert.notEqual(winner.revision,first.revision);
  await assert.rejects(tabB.clear(first.revision),{name:'DraftConflictError'});
  assert.equal((await tabA.load()).filename,winner.filename);
  await tabA.clear(winner.revision);
  await assert.rejects(tabB.save(draft(),winner.revision),{name:'DraftConflictError'});
  await assert.rejects(tabB.clear(winner.revision),{name:'DraftConflictError'});
});

test('revisionless legacy records can be loaded and updated without rewriting them on read', async () => {
  const db=storage(), api=page(db);
  db.exists=true;db.data.set('latest',{...draft(),version:1,savedAt:123});
  const legacy=await api.load();
  assert.equal(legacy.revision,'legacy-123');
  assert.equal(db.writes,0);
  const current=await api.save(draft(),legacy.revision);
  assert.notEqual(current.revision,legacy.revision);
  assert.equal((await api.load()).revision,current.revision);
});
