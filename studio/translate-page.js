/* SPDX-License-Identifier: GPL-3.0-or-later */
(function () {
  'use strict';

  const languages = [
    ['ar', 'Arabic'], ['zh', 'Chinese'], ['en', 'English'], ['fr', 'French'],
    ['de', 'German'], ['hi', 'Hindi'], ['it', 'Italian'], ['ja', 'Japanese'],
    ['ko', 'Korean'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['es', 'Spanish'], ['th', 'Thai'],
  ];
  const modes = {
    context: 'Gemini Nano uses nearby dialogue for context.',
    review: 'Gemini Nano edits the translated dialogue alongside nearby translated lines.',
    standard: 'Chrome translates directly from the original dialogue.',
  };
  function outputEncoding(bytes, selected) {
    const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2));
    if (selected === 'utf-16le' || selected === 'utf-16be') return selected;
    if (selected === 'auto' && header[0] === 0xff && header[1] === 0xfe) return 'utf-16le';
    if (selected === 'auto' && header[0] === 0xfe && header[1] === 0xff) return 'utf-16be';
    return 'utf-8';
  }
  function subtitleBlob(text, encoding) {
    const type = 'application/x-subrip;charset=' + encoding;
    if (encoding === 'utf-8') return new Blob([text], {type});
    const data = new Uint8Array(text.length * 2), view = new DataView(data.buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(2 * i, text.charCodeAt(i), encoding === 'utf-16le');
    return new Blob([data], {type});
  }
  function init(scope) {
    const doc = scope.document;
    const el = id => doc.getElementById(id);
    const source = el('source-language'), target = el('target-language');
    const fileInput = el('subtitle-file'), button = el('translate'), cancel = el('cancel');
    const progress = el('translation-progress'), info = el('translation-mode'), output = el('translation-output');
    const engine = scope.CueTranslationEngine;
    const nav = scope.navigator;
    const chrome = nav.userAgentData?.brands?.length
      ? nav.userAgentData.brands.some(brand => brand.brand === 'Google Chrome')
      : /Chrome\//.test(nav.userAgent) && !/Edg\/|OPR\/|SamsungBrowser\//.test(nav.userAgent);
    const desktop = !nav.userAgentData?.mobile && !/Android|iPhone|iPad|iPod/i.test(nav.userAgent);
    const supported = chrome && desktop && scope.isSecureContext !== false && !!(scope.Translator?.create || scope.LanguageModel?.create);
    const autoOption = source.options[0];
    const languageNames = new Map(languages);
    function option(select, value, label) {
      const item = doc.createElement('option');
      item.value = value; item.textContent = label; select.append(item);
    }
    for (const [code, name] of languages) { option(source, code, name); option(target, code, name); }
    const base = lang => lang.toLowerCase().split('-')[0];
    const preferred = (nav.languages || [nav.language || 'en']).map(base).find(lang => languageNames.has(lang));
    target.value = preferred || 'en';

    let file, prepared, detected, detector, plan, task, result, encodingForExport;
    let selection = 0, preflight = 0, targetChosen = false;
    function message(text, kind = '') {
      const node = el('translation-status');
      node.textContent = text; node.dataset.kind = kind;
    }
    function showMode(mode, completed = 0) {
      info.textContent = completed && mode === 'standard'
        ? 'Chrome’s local translator is completing the remaining segments.' : modes[mode] || '';
      info.hidden = !info.textContent;
    }
    function release(run) {
      if (run?.session) { run.session.destroy(); run.session = null; }
    }
    function resetWork() {
      preflight++;
      if (task) { const old = task; task = null; old.controller.abort(); release(old); }
      plan = null; result = null;
      button.disabled = true; cancel.hidden = true; progress.hidden = true;
      output.hidden = true; el('export').disabled = true; showMode(null);
    }
    function stopDetector() {
      if (detector) { detector.controller.abort(); release(detector); detector = null; }
    }
    function beginDetection() {
      stopDetector();
      const controller = new AbortController();
      const current = {controller, session: null};
      detector = current;
      // Chrome may require activation for the detector's first download. Start
      // creation in the file or language event, before reading the file.
      try {
        current.ready = Promise.resolve(scope.LanguageDetector?.create({signal: controller.signal})).catch(() => null);
      } catch { current.ready = Promise.resolve(null); }
      current.ready = current.ready.then(service => {
        if (controller.signal.aborted) { service?.destroy(); return null; }
        current.session = service; return service;
      });
      return current;
    }
    async function preparePair() {
      resetWork();
      if (!prepared) return;
      const from = source.value || detected;
      if (!from) { message('Choose the original language in From to continue.'); return; }
      if (base(from) === base(target.value) && !targetChosen) target.value = base(from) === 'en' ? 'es' : 'en';
      if (base(from) === base(target.value)) { message('Choose a different target language.'); return; }
      const request = preflight;
      message('Checking language support…');
      try {
        const candidate = await engine.plan(from, target.value, scope);
        if (request !== preflight) return;
        if (candidate.mode === 'unavailable') {
          message('Chrome cannot translate this language pair on this device. Choose another language.', 'error');
          return;
        }
        plan = candidate; button.disabled = false;
        message('Ready to translate.'); showMode(candidate.mode);
      } catch {
        if (request === preflight) message('Chrome could not check this language pair. Reselect a language to try again.', 'error');
      }
    }
    async function detect(current) {
      const {controller} = current;
      let service;
      try {
        service = await current.ready;
        if (controller.signal.aborted) return;
        if (service && prepared?.sample) {
          const [best] = await service.detect(prepared.sample, {signal: controller.signal});
          if (controller.signal.aborted) return;
          if (best?.detectedLanguage && best.detectedLanguage !== 'und' && best.confidence >= 0.65) {
            detected = Intl.getCanonicalLocales(best.detectedLanguage)[0];
            const name = new Intl.DisplayNames(['en'], {type: 'language'}).of(detected);
            autoOption.textContent = 'Auto-detect · ' + name;
          }
        }
      } catch { /* The source selector stays available if detection is unavailable. */ }
      finally { release(current); }
      if (detector === current && !controller.signal.aborted) { detector = null; await preparePair(); }
    }
    async function chooseFile(selected, encoding = 'auto') {
      const token = ++selection;
      resetWork(); stopDetector(); file = selected; prepared = null; detected = '';
      autoOption.textContent = 'Auto-detect';
      el('file-name').textContent = selected?.name || 'Choose subtitle';
      el('file-meta').textContent = 'Drop an SRT file here';
      if (!supported || !selected) return;
      if (encoding === 'auto') { el('file-encoding').value = 'auto'; el('encoding-field').hidden = true; }
      let current = source.value ? null : beginDetection();
      message('Reading subtitle…');
      try {
        const bytes = await selected.arrayBuffer();
        if (selection !== token) return;
        let text;
        try { text = scope.SyncSrt.decode(bytes, encoding); }
        catch (error) { el('encoding-field').hidden = false; throw error; }
        encodingForExport = outputEncoding(bytes, encoding);
        prepared = scope.CueTranslationSrt.prepare(text);
        if (!prepared.units.length) throw Error('This subtitle has no dialogue to translate.');
        el('file-meta').textContent = prepared.cueCount.toLocaleString() + (prepared.cueCount === 1 ? ' cue' : ' cues');
        if (source.value) await preparePair();
        else {
          message('Detecting the original language…');
          if (current !== detector || !current) current = detector || beginDetection();
          await detect(current);
        }
      } catch (error) {
        if (token !== selection) return;
        prepared = null; stopDetector(); message(error.message || 'Could not read this subtitle.', 'error');
      }
    }
    async function translate() {
      if (!plan || !prepared || task) return;
      const current = {controller: new AbortController(), session: null};
      task = current; const signal = current.controller.signal;
      button.disabled = true; cancel.hidden = false; progress.hidden = false; progress.removeAttribute('value');
      result = null; output.hidden = true; el('export').disabled = true;
      message('Preparing on-device translation…'); showMode(plan.mode);
      try {
        // start() must run inside the Translate click to authorize model setup.
        const session = await engine.start(plan, {signal, scope, onStatus({component, progress: fraction}) {
          if (task !== current) return;
          const percent = Math.round(fraction * 100);
          if (component === 'nano' && fraction === 1 && plan.mode === 'review') {
            message('Gemini Nano is ready. Preparing the language pair…');
            return;
          }
          message('Preparing ' + (component === 'nano' ? 'Gemini Nano' : 'Chrome translation resources') +
            (Number.isFinite(percent) ? ' · ' + percent + '%' : '…'));
        }});
        if (task !== current || signal.aborted) { session.destroy(); return; }
        current.session = session; showMode(session.mode);
        progress.max = prepared.units.length; progress.value = 0;
        message('Translating subtitle…');
        let lastPercent = -1;
        const lines = await session.translate(prepared.units, {signal,
          onMode(mode, completed) { if (task === current) showMode(mode, completed); },
          onProgress(done, total) {
            if (task !== current) return;
            progress.max = total; progress.value = done;
            const percent = Math.floor(done * 100 / total);
            if (percent !== lastPercent) { lastPercent = percent; message('Translating · ' + percent + '%'); }
          },
        });
        if (task !== current || signal.aborted) return;
        const text = prepared.render(lines);
        result = {text, encoding:encodingForExport, filename:file.name.replace(/\.srt$/i, '') + '.' + target.value + '.srt'};
        el('result-file').textContent = result.filename;
        message('Translation complete. ' + prepared.cueCount.toLocaleString() +
          (prepared.cueCount === 1 ? ' cue' : ' cues') + ' ready to export.', 'ok');
        el('export').disabled = false; output.hidden = false;
      } catch (error) {
        if (task === current) { showMode(null); message(error.message || 'Translation could not finish. Try again.', 'error'); }
      } finally {
        release(current);
        if (task === current) { task = null; cancel.hidden = true; progress.hidden = true; button.disabled = !plan; }
      }
    }

    if (!supported) {
      fileInput.disabled = true; source.disabled = true; target.disabled = true;
      message('Open this page in an up-to-date version of Google Chrome on a desktop or laptop with built-in AI available.', 'error');
      return;
    }
    fileInput.addEventListener('change', () => { const selected = fileInput.files[0]; if (selected) return chooseFile(selected); });
    el('file-encoding').addEventListener('change', () => chooseFile(file, el('file-encoding').value));
    const drop = el('drop-zone');
    drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', event => {
      event.preventDefault(); drop.classList.remove('over');
      const selected = event.dataTransfer.files[0]; if (selected) return chooseFile(selected);
    });
    source.addEventListener('change', () => {
      resetWork(); stopDetector();
      if (source.value || detected) return preparePair();
      if (file && prepared) {
        message('Detecting the original language…'); return detect(beginDetection());
      }
    });
    target.addEventListener('change', () => {
      targetChosen = true;
      if (prepared && !source.value && !detected && detector) { resetWork(); return; }
      return preparePair();
    });
    button.addEventListener('click', translate);
    cancel.addEventListener('click', () => {
      const retry = plan; resetWork(); plan = retry; button.disabled = !plan;
      message('Translation canceled. You can try again.');
    });
    el('export').addEventListener('click', () => {
      if (!result) return;
      const url = scope.URL.createObjectURL(subtitleBlob(result.text, result.encoding));
      const link = doc.createElement('a');
      link.href = url; link.download = result.filename; doc.body.append(link); link.click(); link.remove();
      scope.setTimeout(() => scope.URL.revokeObjectURL(url), 1000);
    });
    scope.addEventListener('pagehide', () => { ++selection; stopDetector(); resetWork(); });
    scope.addEventListener('pageshow', event => {
      if (event.persisted && prepared) preparePair();
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = {init, outputEncoding, subtitleBlob};
  else init(globalThis);
})();
