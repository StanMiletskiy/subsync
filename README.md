# Cueframe · Subtitle sync

[Open Cueframe](https://perfectintegers.com/subsync/) · [Download the standalone HTML for offline use](https://raw.githubusercontent.com/StanMiletskiy/subsync/master/docs/index.html)

Retiming an SRT changes when lines appear. Cueframe keeps the language, dialogue, line breaks, cue identifiers and styling in the file you selected. The interface is in English. Source and reference subtitles can be in any languages. The alignment engine compares the timing of dialogue and pauses without reading the words.

## Sync a subtitle

1. Open the app in a current desktop browser. Chrome is a good first choice for movie audio. Use **Load demo** to try a cross-language example.
2. Choose the **Subtitle to retime**. For **Timing reference**, choose an SRT that already plays correctly with your release. You can also select a movie with a supported embedded subtitle or audio track, or a PCM WAV. For a movie, pick the full dialogue track in the track list. Forced-only, commentary and descriptive audio tracks can have very different timing.
3. Select **Find timing**. Check the proposed shift and inspect lines at the start, middle and end against the film. Export the corrected SRT and open it in your usual player. For media your browser can play, the optional preview lets you jump to a cue and capture times for manual anchors. The original file stays intact.

If the delay changes after an edit, switch to **Manual anchors**. Enter the subtitle time and the corresponding film time for the same line. One pair shifts the whole subtitle. Two pairs correct a consistent speed difference. Three or more adjust successive sections. For a scene insertion, put a pair on each side of the change, as close to the cut as practical. Cues that have no counterpart in the film need editing. A correction that takes a cue before time zero is reported before export.

For older subtitles that look garbled or fail to load, choose the original **Text encoding** for that file. Cueframe exports UTF-8 and preserves the decoded text. It never translates your dialogue. Files are processed locally. The app has no accounts, analytics, API keys, model downloads or server-side file processing.

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

## Run, test and publish

For offline use, choose **Download the offline app** at the bottom of the live page, then open `cueframe.html` in your browser. All application code is included. For development, edit the readable source in `studio/` and run these commands from the repository root with Node 20 or later:

```sh
node --test studio-tests/*.test.cjs
node studio/build.mjs
```

The build generates `docs/index.html` and `docs/.nojekyll`. Commit the generated page alongside the source. Keep GitHub Pages disabled in this source repository. To publish an update, copy the generated `docs/index.html` to `subsync/index.html` on `main` in both `StanMiletskiy/perfectintegers-site` and `StanMiletskiy/perfectintegers-pages`. The latter serves [perfectintegers.com/subsync/](https://perfectintegers.com/subsync/).

## Upstream review

This fork retains Michał Szymaniak’s [SubSync](https://github.com/sc0ty/subsync) and its history. The author [archived the project in October 2024](https://github.com/sc0ty/subsync/issues/197), citing build and release complexity. The legacy desktop and browser clients remain in their original directories.

| Upstream finding | Change in Cueframe |
| --- | --- |
| The previous [web build](web/package.json) installs Browserify and native dependencies via Docker/Emscripten, including FFmpeg 4.2 and PocketSphinx. | The new static client is written in plain JavaScript. Building the standalone page uses Node’s standard library. |
| The original [speech synchronizer](https://github.com/sc0ty/subsync/wiki/FAQ) uses recognized words, optional bilingual dictionaries and one delay/speed correction for the whole film. | This implementation estimates timing from cue occupancy or local audio activity. It checks agreement across the track and exposes manual anchors for local changes. |
| The original [web exporter](web/src/subtitle.js) rebuilds the SRT and renumbers cues. It clamps both ends at zero, which can produce a zero-length cue. | The new exporter replaces timestamp spans in the original text. It identifies the cue when a proposed correction would create an invalid interval. |

The default automatic correction still assumes one offset and one speed ratio; it does not identify alternate cuts automatically. Match strength is an indicator of timing consistency. No general accuracy or speed advantage over the legacy recognizer has been established.

Original SubSync by Michał Szymaniak. Browser rewrite distributed under [GPL-3.0-or-later](LICENSE).
