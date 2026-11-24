/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';

  async function estimate(job, onProgress, signal) {
    const options = {onProgress, signal};
    let reference = job.reference;
    if (!reference) {
      if (job.kind === 'wav') {
        reference = await SyncAudio.readWavActivity(job.file, options);
      } else {
        const demuxer = job.kind === 'mkv' ? SyncMkv : SyncMp4;
        if (job.track.kind === 'audio') {
          reference = await SyncMovieAudio.readMovieActivity(job.file, job.track, demuxer, options);
        } else {
          const cues = await demuxer.readCues(job.file, job.track.id, options);
          reference = cues.map(({start, end}) => ({start, end}));
        }
      }
    }
    if (signal?.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
    onProgress(1);
    return {answer: SyncAlign.align(job.cues, reference), prepared: job.file ? reference : null};
  }

  // Only the currently selected reference is kept. Entries are compared by File identity,
  // since two unrelated files can share a name, size and modification time.
  function createCache() {
    let selection = null;

    async function run(job, onProgress, signal, dispatch) {
      if (signal.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
      if (!job.file) {
        selection = null;
        const {answer} = await dispatch(job, onProgress, signal);
        if (signal.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
        return answer;
      }

      const {file, kind, track} = job;
      if (!selection || selection.file !== file || selection.kind !== kind ||
          selection.trackId !== track?.id || selection.trackKind !== track?.kind) {
        selection = {file, kind, trackId: track?.id, trackKind: track?.kind, prepared: null};
      }
      const current = selection;
      // A worker receives its own copy on a hit, so termination or cancellation cannot
      // detach the cached activity buffer owned by the tab.
      const request = current.prepared ? {cues: job.cues, reference: current.prepared} : job;
      if (current.prepared) onProgress(1);
      const {answer, prepared} = await dispatch(request, onProgress, signal);
      if (signal.aborted || selection !== current) throw new DOMException('Analysis cancelled', 'AbortError');
      if (prepared) current.prepared = prepared;
      return answer;
    }

    return {run, clear() { selection = null; }};
  }

  const api = {estimate, createCache};
  root.SyncReference = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
