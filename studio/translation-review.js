/* SPDX-License-Identifier: GPL-3.0-or-later */
(function () {
  'use strict';

  const pageSize = 25;
  const searchable = text => text.normalize('NFKC').toLowerCase();

  function create(section, {onDirtyChange = () => {}} = {}) {
    const doc = section.ownerDocument;
    const element = (tag, className, text) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const rows = section.querySelector('#review-rows'), search = section.querySelector('#review-search');
    const previous = section.querySelector('#review-prev'), next = section.querySelector('#review-next');
    const pageLabel = section.querySelector('#review-page');
    const snapshots = new WeakMap(), fields = new Map();
    let units = [];
    let cues = [], generated = [], current = [], saved = [], changed = new Set();
    let matches = [], page = 0, generation = 0;

    function reportChange(wasDirty) {
      const dirty = changed.size > 0;
      if (wasDirty !== dirty) onDirtyChange(dirty);
    }

    function edit(id, field) {
      const wasDirty = changed.size > 0;
      // Each field owns one physical subtitle fragment. Preserve every original
      // line separator, even when the editor pastes a multiline replacement.
      const value = field.value.replace(/[\r\n]+/g, ' ');
      if (value !== field.value) field.value = value;
      current[id] = value;
      if (value === saved[id]) changed.delete(id);
      else changed.add(id);
      reportChange(wasDirty);
    }

    function cueRow(cue) {
      const row = element('article', 'review-cue'), heading = element('h3', 'review-time');
      heading.tabIndex = -1;
      const label = 'Cue ' + (cue.identifier || cue.number);
      const marker = element('span', 'review-edited', 'Edited'), ids = [];
      function updateMarker() {
        const edited = ids.some(id => current[id] !== generated[id]);
        marker.hidden = !edited;
        row.classList.toggle('is-edited', edited);
      }
      heading.append(element('span', 'review-number', label), element('span', 'review-stamps', cue.timing), marker);
      const original = element('div', 'review-original'), translation = element('div', 'review-translation');
      original.setAttribute('aria-label', 'Original, ' + label);
      for (const [lineIndex, line] of cue.lines.entries()) {
        const sourceLine = element('div', 'review-line'), resultLine = element('div', 'review-line');
        sourceLine.dir = 'auto'; resultLine.dir = 'auto';
        let part = 0;
        for (const fragment of line) {
          const id = fragment.unitId;
          sourceLine.append(element('span', id === null ? 'review-literal' : '', fragment.text));
          if (id === null) {
            resultLine.append(element('span', 'review-literal', fragment.text));
            continue;
          }
          const input = element('textarea', 'review-input');
          fields.set(id, input); ids.push(id);
          input.required = true; input.dir = 'auto'; input.spellcheck = true; input.value = current[id];
          input.rows = Math.min(4, Math.max(1, Math.ceil(input.value.length / 48)));
          input.setAttribute('aria-label', 'Translation, ' + label + ', line ' + (lineIndex+1) + ', part ' + (++part));
          input.addEventListener('input', () => { edit(id, input); updateMarker(); });
          resultLine.append(input);
        }
        original.append(sourceLine); translation.append(resultLine);
      }
      if (!cue.lines.length) {
        original.append(element('span', 'review-literal', '—'));
        translation.append(element('span', 'review-literal', '—'));
      }
      updateMarker();
      row.append(heading, original, translation);
      return row;
    }

    function show() {
      const total = matches.length;
      page = Math.max(0, Math.min(page, Math.ceil(total / pageSize) - 1));
      const start = page * pageSize, end = Math.min(start + pageSize, total);
      fields.clear();
      rows.replaceChildren(...matches.slice(start, end).map(cueRow));
      previous.disabled = page === 0;
      next.disabled = end >= total;
      pageLabel.textContent = total ? (start+1) + '–' + end + ' of ' + total.toLocaleString() : 'No matching cues';
    }

    function filter() {
      const query = searchable(search.value.trim());
      if (!query) { matches = cues; return; }
      matches = cues.filter(cue => {
        if (searchable(cue.identifier || String(cue.number)).includes(query)) return true;
        const original = cue.lines.map(line => line.map(f => f.text).join('')).join(' ');
        if (searchable(original).includes(query)) return true;
        const translated = cue.lines.map(line => line.map(f => f.unitId === null ? f.text : current[f.unitId]).join('')).join(' ');
        return searchable(translated).includes(query);
      });
    }

    search.addEventListener('input', () => { page = 0; filter(); show(); });
    function navigate(delta) {
      page += delta; filter(); show();
      const heading = rows.querySelector('.review-time');
      if (heading) {
        heading.focus({preventScroll:true});
        heading.scrollIntoView({block:'start'});
      }
    }
    previous.addEventListener('click', () => navigate(-1));
    next.addEventListener('click', () => navigate(1));

    function focusUnit(id) {
      if (!Number.isInteger(id) || !units[id]) return false;
      const cue = cues[units[id].cue-1];
      let index = matches.indexOf(cue);
      if (index < 0) { search.value = ''; matches = cues; index = matches.indexOf(cue); }
      page = Math.floor(index / pageSize); show();
      const input = fields.get(id);
      if (!input) return false;
      input.focus();
      return true;
    }

    function focusInvalid(cueNumber) {
      const ids = units.filter(u => !cueNumber || u.cue === cueNumber).map(u => u.id);
      const first = ids.find(id => !current[id].trim()) ?? ids.find(id => changed.has(id));
      return focusUnit(first ?? (cueNumber ? ids[0] : undefined));
    }

    function linesCopy(lines, length) {
      if (!Array.isArray(lines) || lines.length !== length ||
          Array.from(lines).some(value => typeof value !== 'string')) throw Error('The translation is incomplete.');
      return lines.slice();
    }

    function load(prepared, generatedLines, savedLines = generatedLines) {
      const initial = linesCopy(generatedLines, prepared.units.length);
      const values = linesCopy(savedLines, prepared.units.length);
      const wasDirty = changed.size > 0;
      generation++;
      cues = prepared.cues; units = prepared.units;
      generated = initial; current = values; saved = values.slice(); changed.clear();
      search.value = ''; matches = cues; page = 0;
      section.hidden = false; show(); reportChange(wasDirty);
    }

    function clear() {
      const wasDirty = changed.size > 0;
      generation++;
      cues = []; units = []; generated = []; current = []; saved = []; changed.clear(); fields.clear();
      matches = []; page = 0;
      rows.replaceChildren(); search.value = ''; pageLabel.textContent = '';
      section.hidden = true; reportChange(wasDirty);
    }

    function getLines() {
      const snapshot = current.slice();
      snapshots.set(snapshot, generation);
      return snapshot;
    }

    function markSaved(snapshot) {
      if (snapshots.has(snapshot) && snapshots.get(snapshot) !== generation) return false;
      const wasDirty = changed.size > 0;
      saved = linesCopy(snapshot, current.length);
      changed.clear();
      current.forEach((value, i) => { if (value !== saved[i]) changed.add(i); });
      reportChange(wasDirty);
      return true;
    }

    return {load, clear, hasUnsaved: () => changed.size > 0, getLines, markSaved, focusUnit, focusInvalid};
  }

  const api = {create};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.CueTranslationReview = api;
})();
