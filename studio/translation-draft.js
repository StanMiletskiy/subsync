// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  'use strict';

  const databaseName = 'cueframe-subtitle-editor';
  const storeName = 'drafts';
  const key = 'latest';
  const encodings = new Set(['utf-8', 'utf-16le', 'utf-16be']);
  const language = /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i;
  let pending = Promise.resolve();

  function valid(record) {
    if (!record || record.version !== 1 || !Number.isSafeInteger(record.savedAt) || record.savedAt < 0 ||
        typeof record.filename !== 'string' || !record.filename.trim() ||
        typeof record.sourceText !== 'string' || !record.sourceText.length ||
        !encodings.has(record.encoding)) return false;
    for (const tag of [record.sourceLanguage, record.targetLanguage]) {
      if (typeof tag !== 'string' || !language.test(tag) || tag === 'und') return false;
    }
    if (!Array.isArray(record.generatedLines) || !Array.isArray(record.editedLines) ||
        record.generatedLines.length !== record.editedLines.length) return false;
    for (let i = 0; i < record.editedLines.length; i++) {
      if (typeof record.editedLines[i] !== 'string' || !record.editedLines[i].trim() ||
          typeof record.generatedLines[i] !== 'string' || !record.generatedLines[i].trim()) return false;
    }
    return true;
  }

  function open(create) {
    return new Promise((resolve, reject) => {
      const factory = globalThis.indexedDB;
      if (!factory) throw new Error('Local draft storage is unavailable in this browser.');
      const request = factory.open(databaseName, 1);
      let blocked = false, absent = false;
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Another tab is blocking local draft storage. Close other Cueframe tabs and try again.'));
      };
      request.onupgradeneeded = () => {
        // Reading an absent database must leave the origin without a new store.
        if (blocked || !create) {
          absent = !create;
          request.transaction.abort();
        } else request.result.createObjectStore(storeName);
      };
      request.onerror = () => {
        if (absent && request.error?.name === 'AbortError') resolve(null);
        else reject(request.error);
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }

  function serialize(action) {
    const next = pending.then(action);
    pending = next.catch(() => {});
    return next;
  }

  // Resolve on commit rather than request success. A later quota or transaction
  // failure must preserve the previous saved version and be reported to the UI.
  function transact(mode, create, operation) {
    return serialize(async () => {
      const db = await open(create);
      if (!db) return operation(null, undefined);
      try {
        return await new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, mode);
          let result, failure;
          transaction.oncomplete = () => resolve(result);
          transaction.onabort = () => reject(failure || transaction.error || new Error('Local draft storage could not finish.'));
          const store = transaction.objectStore(storeName);
          const read = store.get(key);
          // The comparison and mutation share the same active transaction in
          // every tab. Returning to the event loop between them would lose that guarantee.
          read.onsuccess = () => {
            try { result = operation(store, read.result); }
            catch (error) { failure = error; transaction.abort(); }
          };
        });
      } finally { db.close(); }
    });
  }

  function currentRevision(record) {
    if (!valid(record)) return null;
    return record.revision || 'legacy-' + record.savedAt;
  }

  function checkRevision(current, expected) {
    if (expected === undefined || currentRevision(current) === expected) return;
    const error = new Error('The saved draft changed in another tab.');
    error.name = 'DraftConflictError';
    throw error;
  }

  async function save(draft, expectedRevision) {
    // Snapshot editor values immediately, even if a previous click is still saving.
    const {filename, sourceLanguage, targetLanguage, encoding, sourceText, generatedLines, editedLines} = draft;
    const record = {version: 1, savedAt: Date.now(), filename, sourceLanguage, targetLanguage, encoding, sourceText,
      generatedLines: generatedLines?.slice(), editedLines: editedLines?.slice()};
    if (!valid(record)) throw new Error('The subtitle draft is incomplete.');
    record.revision = globalThis.crypto.randomUUID();
    await transact('readwrite', true, (store, current) => {
      checkRevision(current, expectedRevision);
      store.put(record, key);
    });
    return record;
  }

  async function load() {
    return transact('readonly', false, (_store, record) => {
      const revision = currentRevision(record);
      return revision === null ? null : {...record, revision};
    });
  }

  async function clear(expectedRevision) {
    await transact('readwrite', false, (store, current) => {
      checkRevision(current, expectedRevision);
      if (store) store.delete(key);
    });
  }

  const api = {load, save, clear};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.CueTranslationDraft = api;
})();
