/* Original browser studio. SPDX-License-Identifier: GPL-3.0-or-later */
(() => {
  'use strict';

  function workerStart(calculate) {
    self.onmessage = async ({data}) => {
      self.postMessage({type:'ready'});
      try {
        const value = await calculate(data, fraction => self.postMessage({type:'progress',fraction}));
        const buffer = value.prepared?.activity?.buffer;
        self.postMessage({type:'result',value}, buffer ? [buffer] : []);
      } catch (error) {
        self.postMessage({type:'failure',message:error.message || String(error)});
      }
    };
  }
  if (typeof document === 'undefined') {
    workerStart(SyncReference.estimate);
    return;
  }

  const byId = id => document.getElementById(id);
  const engines = ['align-engine', 'audio-engine', 'mkv-engine', 'mp4-engine', 'movie-audio-engine', 'reference-engine'];
  const referenceCache = SyncReference.createCache();
  const tracks = {source:null, ref:null};
  const readId = {source:0, ref:0};
  const readAbort = {source:null, ref:null};
  let mode = 'automatic';
  let position = 'first';
  let running = null;
  let result = null;
  let mediaUrl = null;
  let mediaName = '';
  let reviewMedia = null;
  let attachedSeparately = false;
  let mediaReady = false;
  let focusedPair = null;
  let playbackCues = [], previousPlaybackSource, previousPlaybackMap;
  const identityTime = time => time;

  const encodings = [
    ['auto','Auto (Unicode)'], ['utf-8','UTF-8'], ['utf-16le','UTF-16 little-endian'], ['utf-16be','UTF-16 big-endian'],
    ['windows-1250','Central European · Windows-1250'], ['windows-1252','Western European · Windows-1252'],
    ['windows-1251','Cyrillic · Windows-1251'], ['koi8-r','Cyrillic · KOI8-R'], ['koi8-u','Ukrainian · KOI8-U'],
    ['windows-1253','Greek · Windows-1253'], ['windows-1254','Turkish · Windows-1254'], ['windows-1257','Baltic · Windows-1257'],
    ['windows-1255','Hebrew · Windows-1255'], ['windows-1256','Arabic · Windows-1256'], ['windows-1258','Vietnamese · Windows-1258'],
    ['windows-874','Thai · Windows-874'], ['shift_jis','Japanese · Shift_JIS'], ['euc-jp','Japanese · EUC-JP'],
    ['iso-2022-jp','Japanese · ISO-2022-JP'], ['gb18030','Chinese · GB18030'], ['big5','Chinese · Big5'],
    ['euc-kr','Korean · EUC-KR'], ['ibm866','Cyrillic · IBM866'], ['macintosh','Western European · Macintosh'],
    ['iso-8859-2','Central European · ISO-8859-2'], ['iso-8859-3','South European · ISO-8859-3'],
    ['iso-8859-4','Baltic · ISO-8859-4'], ['iso-8859-5','Cyrillic · ISO-8859-5'], ['iso-8859-6','Arabic · ISO-8859-6'],
    ['iso-8859-7','Greek · ISO-8859-7'], ['iso-8859-8','Hebrew · ISO-8859-8'], ['iso-8859-10','Nordic · ISO-8859-10'],
    ['iso-8859-13','Baltic · ISO-8859-13'], ['iso-8859-14','Celtic · ISO-8859-14'], ['iso-8859-15','Western European · ISO-8859-15']
  ];
  for (const slot of ['source','ref']) {
    for (const [value,label] of encodings) byId(slot+'-encoding').add(new Option(label,value));
  }

  function message(text, kind='') {
    byId('status').textContent = text;
    byId('status').dataset.kind = kind;
  }
  function stop() {
    if (running) running.abort();
    running = null;
  }
  function invalidate() {
    stop();
    result = null;
    if (position.startsWith('section-')) position = 'first';
    showSections();
    controls();
    preview();
  }
  function selectPosition(next) {
    position = next;
    preview();
  }
  function controls() {
    const ref = tracks.ref;
    const hasRef = ref?.parsed || ref?.kind==='wav' || ref?.selected;
    byId('run').disabled = !!running || !tracks.source?.parsed || (mode==='automatic' && !hasRef);
    byId('run').textContent = running ? 'Analyzing…' : mode==='automatic' ? 'Find timing' : 'Preview adjustment';
    byId('cancel').hidden = !running;
    byId('export').disabled = !result?.exportable;
  }
  function guide() {
    const source = tracks.source;
    const ref = tracks.ref;
    if (source?.error || (mode==='automatic' && ref?.error)) {
      message(source?.error || ref.error,'error');
    } else if (!source?.parsed) {
      message(mode==='automatic' ? 'Choose your subtitle and timing reference to begin.' : 'Choose the subtitle you want to adjust.');
    } else if (mode==='manual') {
      message('Set matching times, then preview the adjustment.');
    } else if (!ref) {
      message('Choose a reference timed to the release you want.');
    } else if (ref.tracks?.length > 1 && !ref.selected) {
      message('Choose the reference track you want to use.');
    } else if (!byId('run').disabled) {
      message('Ready to compare timing patterns.');
    }
  }
  function setMode(next) {
    mode = next;
    byId('automatic').setAttribute('aria-pressed', String(next==='automatic'));
    byId('manual').setAttribute('aria-pressed', String(next==='manual'));
    byId('auto-fields').hidden = next==='manual';
    byId('anchor-fields').hidden = next==='automatic';
    byId('capture').hidden = next!=='manual' || !mediaReady;
    invalidate();
    guide();
  }

  function kindOf(file, slot) {
    if (slot==='source') return 'srt';
    const ext = file.name.split('.').pop().toLowerCase();
    if (['mkv','mks','webm'].includes(ext)) return 'mkv';
    if (['mp4','m4v','mov'].includes(ext)) return 'mp4';
    return ['wav','wave'].includes(ext) ? 'wav' : 'srt';
  }
  function trackChoices(record) {
    const select = byId('movie-track');
    select.replaceChildren();
    const choices = [...record.tracks].sort((a,b)=>Number(a.kind==='audio')-Number(b.kind==='audio'));
    const available = choices.filter(track => track.kind!=='audio' || SyncMovieAudio.available());
    const selected = available.length===1 ? available[0] : null;
    if (!selected) select.add(new Option('Choose a track…',''));
    for (const track of choices) {
      const disabled = !available.includes(track);
      const entry = new Option(track.label + (disabled ? ' · browser audio unavailable' : ''), String(track.id));
      entry.disabled = disabled;
      select.add(entry);
    }
    record.selected = selected;
    select.value = selected ? String(selected.id) : '';
    byId('track-box').hidden = false;
    if (!available.length) throw Error('This movie has no usable reference track in this browser. Choose a timed SRT or extract a PCM WAV.');
  }
  async function choose(slot, file) {
    if (!file) return;
    const ticket = ++readId[slot];
    readAbort[slot]?.abort();
    const controller = new AbortController();
    readAbort[slot] = controller;
    const kind = kindOf(file,slot);
    const record = {file,kind,name:file.name};
    if (slot==='ref') referenceCache.clear();
    tracks[slot] = record;
    if (slot==='source') position='first';
    invalidate();
    const meta = byId(slot+'-meta');
    byId(slot+'-name').textContent = file.name;
    meta.textContent = 'Reading file…';
    byId(slot+'-encoding-box').hidden = kind!=='srt';
    if (slot==='ref') {
      byId('track-box').hidden = true;
      if (!attachedSeparately) setMedia(kind==='srt'?null:file);
    }
    try {
      if (kind==='srt') {
        if (file.size > 32*1024*1024) throw Error('Choose an SRT under 32 MiB, or use an MKV, MP4, or WAV as your timing reference.');
        const bytes = await file.arrayBuffer();
        if (readId[slot]!==ticket) return;
        record.parsed = SyncSrt.parse(SyncSrt.decode(bytes,byId(slot+'-encoding').value));
        meta.textContent = record.parsed.cues.length.toLocaleString()+' cues · SRT';
      } else if (kind==='wav') {
        meta.textContent = 'Audio activity · WAV';
      } else {
        const demuxer = kind==='mkv' ? SyncMkv : SyncMp4;
        record.tracks = await demuxer.listTracks(file,{signal:controller.signal});
        if (readId[slot]!==ticket) return;
        if (!record.tracks.length) throw Error('No usable tracks found. Choose a timed SRT or PCM WAV.');
        trackChoices(record);
        meta.textContent = record.tracks.length+' '+(record.tracks.length===1?'track':'tracks')+' · movie';
      }
    } catch (error) {
      if (readId[slot]!==ticket) return;
      record.error = error.message || String(error);
      meta.textContent = 'Could not read this file';
      if (kind==='srt' && /encod|UTF|decod/i.test(record.error)) byId(slot+'-encoding-box').open=true;
    }
    if (readId[slot]===ticket) {
      controls();
      guide();
      preview();
    }
  }
  function addAnchor() {
    const row = document.createElement('div');
    row.className='anchor-row';
    for (const label of ['Subtitle time','Film time']) {
      const input=document.createElement('input');
      input.type='text'; input.setAttribute('aria-label',label);
      input.placeholder='00:00:00,000'; input.autocomplete='off'; input.spellcheck=false;
      input.addEventListener('input',()=>{invalidate(); guide();});
      input.addEventListener('focus',()=>{focusedPair=row;});
      row.append(input);
    }
    const remove=document.createElement('button');
    remove.className='remove-anchor'; remove.type='button';
    remove.textContent='×'; remove.setAttribute('aria-label','Remove timing pair');
    remove.addEventListener('click',()=>{
      if (row.parentNode.children.length>1) row.remove();
      else for (const input of row.querySelectorAll('input')) input.value='';
      invalidate(); guide();
    });
    row.append(remove);
    byId('anchor-rows').append(row);
    focusedPair=row;
    return row;
  }

  function runWorker(job, onProgress, signal) {
    if (typeof Worker!=='function') return SyncReference.estimate(job,onProgress,signal);
    return new Promise((resolve,reject)=>{
      let worker, blobUrl, started=false;
      const cleanup = () => {
        signal.removeEventListener('abort',abort);
        worker?.terminate();
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      };
      const abort = () => {cleanup(); reject(new DOMException('Analysis cancelled','AbortError'));};
      const fallback = () => {
        cleanup();
        if (signal.aborted) return reject(new DOMException('Analysis cancelled','AbortError'));
        SyncReference.estimate(job,onProgress,signal).then(resolve,reject);
      };
      try {
        const sources=engines.map(id=>byId(id).textContent);
        if (sources.every(source=>source.trim())) {
          blobUrl=URL.createObjectURL(new Blob([...sources.map(source=>source+'\n;\n'),
            '('+workerStart.toString()+')(SyncReference.estimate);'],{type:'text/javascript'}));
        }
        worker=new Worker(blobUrl || 'worker.js');
        worker.onerror=event=>{
          event.preventDefault();
          if (!started) return fallback();
          cleanup(); reject(Error(event.message || 'Timing analysis failed. Try another reference.'));
        };
        worker.onmessage=({data})=>{
          if (data.type==='ready') {started=true; return;}
          if (data.type==='progress') {onProgress(data.fraction); return;}
          cleanup();
          if (data.type==='result') resolve(data.value);
          else reject(Error(data.message || 'Could not analyze this reference.'));
        };
        signal.addEventListener('abort',abort,{once:true});
        worker.postMessage(job);
      } catch {fallback();}
    });
  }
  function timingOnly(cues) {
    return cues.map(({start,end})=>({start,end}));
  }
  function signedSeconds(ms) {
    return (ms>=0?'+':'−')+(Math.abs(ms)/1000).toFixed(3)+' s';
  }
  async function analyze() {
    if (byId('run').disabled) return;
    invalidate();
    const controller=new AbortController();
    running=controller;
    controls();
    const parsed=tracks.source.parsed;
    try {
      let map, title, detail, exportable=true, sections=[];
      if (mode==='manual') {
        const pairs=Array.from(byId('anchor-rows').children,(row,index)=>{
          const times=Array.from(row.querySelectorAll('input'),input=>input.value.trim());
          if (times.some(value=>!value)) throw Error('Fill in both times for pair '+(index+1)+'.');
          return {source:SyncSrt.parseTime(times[0]),target:SyncSrt.parseTime(times[1])};
        });
        map=SyncSrt.anchors(pairs);
        title=pairs.length===1?'Offset '+signedSeconds(pairs[0].target-pairs[0].source):pairs.length+' timing pairs';
        detail='Review the adjusted cues before export.';
      } else {
        const ref=tracks.ref;
        const job={cues:timingOnly(parsed.cues),kind:ref.kind};
        if (ref.parsed) job.reference=timingOnly(ref.parsed.cues);
        else {job.file=ref.file; job.track=ref.selected;}
        message(ref.parsed?'Comparing timing patterns…':'Reading the selected track…');
        const answer=await referenceCache.run(job, fraction=>{
          if (running!==controller) return;
          const progress=Math.round(100*Number(fraction));
          if (Number.isFinite(progress)) message(progress>=100?'Comparing timing patterns…':'Reading reference · '+progress+'%');
        },controller.signal,runWorker);
        if (running!==controller) return;
        if (!Number.isFinite(answer.scale) || answer.scale<=0 || !Number.isFinite(answer.offsetMs)) throw Error(answer.reason || 'No timing estimate. Use manual anchors or choose another reference.');
        map=time=>SyncAlign.mapTime(answer,time);
        const edits=answer.edits || [], review=answer.reviewRanges || [];
        exportable=!!answer.reliable && !review.length;
        sections=timingSections(parsed.cues,edits,review);
        const drift=((answer.scale-1)*100);
        const sign=drift>=0?'+':'−';
        title=(edits.length?'Starting offset ':'Offset ')+signedSeconds(answer.offsetMs);
        detail='Rate '+sign+Math.abs(drift).toFixed(3)+'% · match score '+Math.round(answer.score*100)+'%';
        if (!exportable) message(review.length
          ? 'Timing needs review. Choose a flagged section in the preview.'
          : answer.reason || 'Weak timing match. Try manual anchors or another reference.','error');
      }
      let text;
      if (exportable) text=SyncSrt.render(parsed,map);
      result={map,title,detail,exportable,text,sections};
      showSections();
      if (exportable) message(sections.length
        ? 'Timing adjusted for this cut. Check the timing changes in the preview.'
        : 'Timing ready. Check the start, middle, and end before exporting.','ok');
    } catch (error) {
      if (running!==controller) return;
      message(error.message || String(error),'error');
    } finally {
      if (running===controller) {
        running=null;
        controls();
        preview();
      }
    }
  }

  function segments(id,cues,map,left,span) {
    const lane=byId(id);
    lane.replaceChildren();
    if (!map) return;
    const fragment=document.createDocumentFragment();
    for (const cue of cues) {
      const a=(map(cue.start)-left)/span, b=(map(cue.end)-left)/span;
      if (a>=1 || b<=0 || !Number.isFinite(a+b)) continue;
      const mark=document.createElement('i'); mark.className='segment';
      mark.style.left=(Math.max(0,a)*100)+'%';
      mark.style.width=(100*(Math.min(1,b)-Math.max(0,a)))+'%';
      fragment.append(mark);
    }
    lane.append(fragment);
  }
  function prettyTime(ms, short=false) {
    if (!Number.isFinite(ms)) return '—';
    const label=SyncSrt.formatTime(Math.abs(Math.round(ms)));
    return (ms<0?'−':'')+(short?label.split(/[,.]/)[0]:label);
  }
  function timingSections(cues, edits, ranges) {
    const sections = [
      ...edits.map(edit => ({
        at: edit.sourceMs,
        note: 'Subsequent cues move '+(Math.abs(edit.deltaMs)/1000).toFixed(3)+' s '+
          (edit.deltaMs>0?'later.':'earlier.'),
      })),
      ...ranges.map(range => ({at:range.startMs, end:range.endMs, note:range.reason, flagged:true})),
    ].sort((a,b)=>a.at-b.at);
    for (const [index, section] of sections.entries()) {
      // Jump to the first affected cue even when the cut falls inside a long pause.
      let next=-1, last=0;
      for (const [i,cue] of cues.entries()) {
        if (cue.start>cues[last].start) last=i;
        if (section.flagged && cue.start<=section.at && cue.end>section.at) {next=i; break;}
        if (cue.start>=section.at && (next<0 || cue.start<cues[next].start)) next=i;
      }
      section.index=next<0?last:next;
      section.position='section-'+index;
    }
    return sections;
  }
  function showSections() {
    const sections=result?.sections || [];
    const box=byId('timing-sections'), list=byId('section-list');
    box.hidden=!sections.length;
    list.replaceChildren();
    if (!sections.length) return;
    const needsReview=sections.some(section=>section.flagged);
    byId('sections-heading').textContent=needsReview?'Sections to check · original subtitle time':'Timing changes · original subtitle time';
    for (const section of sections) {
      const row=document.createElement('li'), button=document.createElement('button'), note=document.createElement('span');
      row.className=section.flagged?'flagged':'corrected';
      button.type='button'; button.className='section-jump'; button.dataset.position=section.position;
      let label=prettyTime(section.at,true);
      if (section.flagged && prettyTime(section.end,true)!==label) label+='–'+prettyTime(section.end,true);
      button.textContent=(section.flagged?'Review ':'Check ')+label;
      button.addEventListener('click',()=>{
        selectPosition(section.position);
        if (mediaReady) playCue(result.map(tracks.source.parsed.cues[section.index].start));
      });
      note.textContent=section.note;
      row.append(button,note); list.append(row);
    }
  }
  function preview() {
    const cues=tracks.source?.parsed?.cues;
    const hasCues=!!cues?.length;
    byId('preview-empty').hidden=hasCues;
    byId('preview-content').hidden=!hasCues;
    byId('preview-type').hidden=!hasCues;
    if (!hasCues) {
      for (const id of ['lane-original','lane-adjusted','cue-list']) byId(id).replaceChildren();
      for (const id of ['range-time','ruler-start','ruler-mid','ruler-end','preview-type','estimate-title','estimate-info']) byId(id).textContent='';
      refreshPlayer(null,identityTime);
      return;
    }
    const map=result?.map;
    byId('preview-type').textContent=!result?'Original':result.exportable?'Adjusted':'Low confidence';
    for (const button of document.querySelectorAll('[data-position]')) {
      button.setAttribute('aria-pressed', String(button.dataset.position===position));
    }
    const section=result?.sections.find(item=>item.position===position);
    const offset=section?Math.max(0,Math.min(cues.length-3,section.index-1)):
      position==='last'?Math.max(0,cues.length-3):position==='middle'?Math.max(0,Math.floor((cues.length-3)/2)):0;
    const selected=cues.slice(offset,offset+3);
    const start=selected[0].start;
    const end=selected[selected.length-1].end;
    const left=Math.max(0,Math.floor((Math.min(start,map?map(start):start)-2000)/1000)*1000);
    const right=Math.max(left+30000,Math.ceil((Math.max(end,map?map(end):end)+2000)/1000)*1000);
    byId('range-time').textContent=prettyTime(left,true)+' – '+prettyTime(right,true);
    for (const [id,time] of [['ruler-start',left],['ruler-mid',(left+right)/2],['ruler-end',right]]) byId(id).textContent=prettyTime(time,true);
    segments('lane-original',cues,t=>t,left,right-left);
    segments('lane-adjusted',cues,map,left,right-left);
    const body=byId('cue-list'); body.replaceChildren();
    for (const cue of selected) {
      const row=document.createElement('tr');
      if (section && cue===cues[section.index]) row.className='section-cue';
      const line=document.createElement('td'), isolated=document.createElement('bdi');
      isolated.dir='auto'; isolated.textContent=cue.text;
      if (mediaReady) {
        const jump=document.createElement('button');
        jump.type='button'; jump.className='play-cue'; jump.textContent='Play';
        jump.setAttribute('aria-label','Play cue at '+prettyTime(map?map(cue.start):cue.start));
        jump.addEventListener('click',()=>playCue(map?map(cue.start):cue.start));
        line.append(jump);
      }
      line.append(isolated); row.append(line);
      for (const label of [prettyTime(cue.start), map?prettyTime(map(cue.start)):'—']) {
        const td=document.createElement('td'); td.className='time'; td.textContent=label; row.append(td);
      }
      body.append(row);
    }
    refreshPlayer(cues,map || identityTime);
    byId('estimate-title').textContent=result?.title || 'Awaiting adjustment';
    byId('estimate-info').textContent=result?.detail || 'Adjusted timestamps will appear here.';
  }
  function setMedia(file, separate=false) {
    if (file===reviewMedia && separate===attachedSeparately) return;
    attachedSeparately = separate;
    const player=byId('player');
    player.pause();
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    mediaUrl = null; reviewMedia = file; mediaReady = false;
    mediaName = file?.name || '';
    byId('player-stage').hidden = true;
    byId('capture').hidden = true;
    byId('player-line').textContent = '';
    player.removeAttribute('src');
    if (file) {
      mediaUrl = URL.createObjectURL(file);
      player.src = mediaUrl;
      byId('player-note').textContent = 'Checking playback for '+mediaName+'…';
    } else {
      byId('player-note').textContent = 'Open a file to check the adjusted cues against the soundtrack.';
      byId('player-pane').open = false;
    }
    player.load();
  }
  function refreshPlayer(cues,map) {
    if (!mediaReady || !cues) {
      byId('player-line').textContent = '';
      previousPlaybackSource = null;
      return;
    }
    if (previousPlaybackSource!==cues || previousPlaybackMap!==map) {
      let until = -Infinity;
      playbackCues = cues.map(cue=>({start:map(cue.start),end:map(cue.end),text:cue.text})).sort((a,b)=>a.start-b.start);
      for (const cue of playbackCues) {until=Math.max(until,cue.end); cue.until=until;}
      previousPlaybackMap=map; previousPlaybackSource=cues;
    }
    updatePlaybackLine();
  }
  function updatePlaybackLine() {
    const line=byId('player-line');
    if (!mediaReady || !previousPlaybackSource) {line.textContent=''; return;}
    const time=byId('player').currentTime*1000;
    let low=0, high=playbackCues.length;
    while (low<high) {
      const middle=Math.floor((low+high)/2);
      if (playbackCues[middle].start<=time) low=middle+1;
      else high=middle;
    }
    const lines=[];
    for (let i=low-1;i>=0 && playbackCues[i].until>time;i--) {
      if (playbackCues[i].end>time) lines.push(playbackCues[i].text);
    }
    line.textContent=lines.reverse().join('\n');
  }
  function playCue(at) {
    const player=byId('player');
    byId('player-pane').open=true;
    if (!Number.isFinite(at) || at<0 || at/1000>=player.duration) {
      byId('player-note').textContent='This cue falls outside the playback file.';
      return;
    }
    player.currentTime=at/1000;
    player.play().catch(()=>{byId('player-note').textContent='Use the player’s controls to start playback.';});
  }
  function download() {
    if (!result?.exportable) return;
    const link=document.createElement('a');
    link.href=URL.createObjectURL(new Blob([result.text],{type:'application/x-subrip;charset=utf-8'}));
    link.download=tracks.source.name.replace(/\.srt$/i,'')+'.synced.srt';
    document.body.append(link); link.click(); link.remove();
    setTimeout(()=>URL.revokeObjectURL(link.href),30000);
    message('Exported '+link.download+' as UTF-8.','ok');
  }

  for (const slot of ['source','ref']) {
    const input=byId(slot+'-file'), drop=byId(slot+'-drop');
    input.addEventListener('change',()=>{const file=input.files[0]; input.value=''; choose(slot,file);});
    byId(slot+'-encoding').addEventListener('change',()=>{if (tracks[slot]?.file) choose(slot,tracks[slot].file);});
    for (const name of ['dragenter','dragover']) drop.addEventListener(name,event=>{event.preventDefault(); drop.classList.add('over');});
    drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
    drop.addEventListener('drop',event=>{event.preventDefault(); drop.classList.remove('over'); choose(slot,event.dataTransfer.files[0]);});
  }
  byId('movie-track').addEventListener('change',event=>{
    const ref=tracks.ref;
    if (!ref?.tracks) return;
    referenceCache.clear();
    ref.selected=ref.tracks.find(track=>String(track.id)===event.target.value) || null;
    invalidate(); guide();
  });
  byId('play-file').addEventListener('change',event=>{
    const file=event.target.files[0]; event.target.value='';
    if (file) {setMedia(file,true); preview();}
  });
  byId('player').addEventListener('loadedmetadata',()=>{
    const player=byId('player');
    if (!mediaUrl || player.currentSrc!==mediaUrl) return;
    mediaReady=true;
    const label=attachedSeparately?'Playback file: ':'Reference file: ';
    byId('player-note').textContent=label+mediaName+'. Choose Play beside a cue. For a movie with several soundtracks, playback uses the track selected by your browser.';
    byId('player-stage').hidden=false; byId('capture').hidden=mode!=='manual';
    preview();
  });
  byId('player').addEventListener('error',()=>{
    if (!mediaUrl || byId('player').currentSrc!==mediaUrl) return;
    mediaReady=false;
    byId('player-note').textContent='This browser cannot play '+mediaName+'. Timing analysis can still use supported tracks. Check timestamps in your usual movie player.';
    byId('player-stage').hidden=true; byId('capture').hidden=true;
    preview();
  });
  for (const name of ['timeupdate','seeked']) byId('player').addEventListener(name,updatePlaybackLine);
  byId('capture').addEventListener('click',()=>{
    if (!mediaReady || mode!=='manual') return;
    const box=byId('anchor-rows'), row=box.contains(focusedPair)?focusedPair:box.lastElementChild;
    const input=row.children[1]; input.value=prettyTime(byId('player').currentTime*1000);
    invalidate(); guide(); input.focus();
  });
  byId('automatic').addEventListener('click',()=>setMode('automatic'));
  byId('manual').addEventListener('click',()=>setMode('manual'));
  byId('add-anchor').addEventListener('click',()=>{addAnchor().firstElementChild.focus(); invalidate(); guide();});
  byId('run').addEventListener('click',analyze);
  byId('export').addEventListener('click',download);
  byId('cancel').addEventListener('click',()=>{stop(); controls(); message('Analysis cancelled.');});
  for (const button of document.querySelectorAll('[data-position]')) button.addEventListener('click',()=>selectPosition(button.dataset.position));
  addAnchor();
  controls();
  preview();
})();
