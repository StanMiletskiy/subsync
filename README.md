# Cueframe · Subtitle sync

[Open Cueframe](https://perfectintegers.com/subsync/) · [Download the standalone HTML for offline use](https://raw.githubusercontent.com/StanMiletskiy/subsync/master/docs/index.html)

Retiming an SRT changes when lines appear. Cueframe keeps the language, dialogue, line breaks, cue identifiers and styling in the file you selected. The interface is in English. Source and reference subtitles can be in any languages. When two SRTs share dialogue, Cueframe can match lines in sequence and use their reference timestamps. For different translations or audio, it compares the timing of dialogue and pauses.

## Sync a subtitle

1. Open the app in a current desktop browser. Chrome is a good first choice for movie audio.
2. Choose the **Subtitle to retime**. For **Timing reference**, choose an SRT that already plays correctly with your release. You can also select a movie with a supported embedded subtitle or audio track, or a PCM WAV. For a movie, pick the full dialogue track in the track list. Forced-only, commentary and descriptive audio tracks can have very different timing.
3. Select **Correct Timings**, then **Export SRT**. You can open the corrected file in your usual player. For media your browser can play, the optional preview lets you jump to a cue and capture times for manual anchors. The original file stays intact.

Cueframe checks timing across the subtitle file. When enough dialogue lines match in sequence, it uses their start and end times and estimates the timing of short passages between them. With different translations, it can detect a sustained shift when cue timings on both sides support the change. A soundtrack can also resolve a sustained shift near the end when several passages agree on its size and location. Where the files split or omit lines differently, Cueframe keeps the supported correction and preserves every source cue. Export is available as soon as the corrected SRT is ready. The cue count tells you how many entries are in the export. The timing match score measures agreement with the reference. For a correction you want to set yourself, switch to **Manual anchors**. Enter the subtitle time and the corresponding film time for the same line. One pair shifts the whole subtitle. Two pairs correct a consistent speed difference. Three or more adjust successive sections. For a single insertion between cues, use four pairs. Pick a line early in the film, one just before the cut, one just after it, and one near the end. Cues that have no counterpart in the film need editing. If an automatic shift pushes opening titles before zero and they fit in the gap before the first corrected line, Cueframe keeps those titles in that gap. It reports timestamps that cannot be saved as valid SRT intervals.

For older subtitles that look garbled or fail to load, choose the original **Text encoding** for that file. Cueframe exports UTF-8 and preserves the decoded text. It never translates your dialogue. Files are processed locally. The app has no accounts, analytics, API keys, model downloads or server-side file processing.

When trying several subtitles for the same release, leave the movie or WAV and its selected track in place. After the first analysis finishes, you can replace just **Subtitle to retime** and click **Correct Timings** again. The tab reuses the timing data it extracted. Changing the reference or track starts a fresh analysis.

## Choosing a reference

| What you have | What to choose |
| --- | --- |
| Correctly timed SRT for this release | Use it as the reference. Another language works if the dialogue follows the same edit. |
| MP4 or MKV with an embedded text subtitle | Select the movie, then choose the full-dialogue text track. It can be used even when your browser cannot play the video. |
| A movie with supported AAC/Opus audio | Select a listed audio track. Decoding depends on the browser, operating system, codec and container layout. Music and effects can reduce acoustic match quality. |
| A different audio codec, a fragmented file, or bitmap subtitles | Choose an external timed SRT, select manual anchors, or extract a mono PCM WAV locally. Bitmap subtitles would need OCR to become a text reference. |

With FFmpeg installed, a typical extraction is:

```sh
ffmpeg -i "movie.mkv" -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le "reference.wav"
```

The example picks the first audio stream. Change `0:a:0` to `0:a:1` for the second. Select the soundtrack that matches the edition and watch for a delayed audio start when creating a standalone WAV. As another free browser option, [ffsubsync](https://ffsubsync.readthedocs.io/en/latest/browser.html) uses FFmpeg/WASM and WebRTC voice activity detection.

## Translate a subtitle

Open [Free AI Translation](https://perfectintegers.com/subsync/translate/) in desktop Google Chrome. Choose an SRT and its target language. The app processes the subtitle on the device and exports a new SRT with the original cue identifiers, timestamp strings, line breaks, speaker prefixes and formatting tags. Only dialogue and caption text is replaced. UTF-8 and UTF-16 files keep their encoding. Legacy inputs export as UTF-8 to represent the target language. Chrome may need to download its models or a language pack before the first translation.

Cueframe checks the selected languages and the APIs available in the browser. When Gemini Nano supports both languages, its subtitle-editor prompt uses nearby dialogue to retain tone, names, certainty and speaker intent. When Nano supports only the target language, it can edit the local translator’s drafts alongside nearby translated lines. For pairs such as English to Russian, the local translator works directly from the original dialogue. Check names, forms of address and wordplay before publication.

For a manual compatibility review, check Google’s [Translator](https://developer.chrome.com/docs/ai/translator-api), [Language Detector](https://developer.chrome.com/docs/ai/language-detection), and [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) documentation against a current desktop Chrome build. Check one prompted pair, one pair using a language pack, and an unsupported-browser state. The browser manages the installed models.

## Run, test and publish

For offline use, choose **Download the offline HTML page** at the bottom of the live page, then open `cueframe.html` in your browser. All application code is included. For development, edit the readable source in `studio/` and run these commands from the repository root with Node 20 or later:

```sh
node --test studio-tests/*.test.cjs
node studio/build.mjs
```

The build generates `docs/index.html`, `docs/translate/index.html`, and `docs/.nojekyll`. Commit both pages alongside the source. Keep GitHub Pages disabled in this source repository. Publish the two generated HTML files to `subsync/index.html` and `subsync/translate/index.html` in the same commit on `main` of each publishing repository, `StanMiletskiy/perfectintegers-site` and `StanMiletskiy/perfectintegers-pages`. The latter serves [Cueframe](https://perfectintegers.com/subsync/).

## Upstream review

This fork retains Michał Szymaniak’s [SubSync](https://github.com/sc0ty/subsync) and its history. The author [archived the project in October 2024](https://github.com/sc0ty/subsync/issues/197), citing build and release complexity. The legacy desktop and browser clients remain in their original directories.

| Upstream finding | Change in Cueframe |
| --- | --- |
| The previous [web build](web/package.json) installs Browserify and native dependencies via Docker/Emscripten, including FFmpeg 4.2 and PocketSphinx. | The new static client is written in plain JavaScript. Building the standalone page uses Node’s standard library. |
| The original [speech synchronizer](https://github.com/sc0ty/subsync/wiki/FAQ) uses recognized words, optional bilingual dictionaries and one delay/speed correction for the whole film. | This implementation uses shared dialogue, cue timing or local audio activity. It checks agreement across the track, detects supported changes in delay and offers manual anchors for adjustments. |
| The original [web exporter](web/src/subtitle.js) rebuilds the SRT and renumbers cues. It clamps both ends at zero, which can produce a zero-length cue. | The new exporter replaces timestamp spans in the original text. It identifies the cue when a proposed correction would create an invalid interval. |

Automatic correction handles an overall shift and speed difference. A local timing change needs matching dialogue on both sides. Very short changes, missing dialogue and busy soundtracks can leave individual lines approximate. Match strength is an indicator of timing consistency. No general accuracy or speed advantage over the legacy recognizer has been established.

Original SubSync by Michał Szymaniak. Browser rewrite distributed under [GPL-3.0-or-later](LICENSE).
