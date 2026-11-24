import { readFile, writeFile, mkdir } from 'node:fs/promises';

const source = new URL('./', import.meta.url);
const output = new URL('../docs/', source);
const read = (relative) => readFile(new URL(relative, source), 'utf8');
const escapeHTML = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
let html = await read('index.html');
const css = await read('style.css');
html = html.replace('<link rel="stylesheet" href="style.css">', () => '<style>\n' + css + '\n</style>');
for (const match of html.matchAll(/<script([^>]*?) src="([\w.-]+\.js)"><\/script>/g)) {
  const script = (await read(match[2])).replace(/<\/script/gi, '<\\/script');
  html = html.replace(match[0], () => '<script' + match[1] + '>\n' + script + '\n</script>');
}
if (/<script[^>]+src=|<link[^>]+stylesheet/.test(html)) throw new Error('External build asset left in standalone page');
const licence = await read('../LICENSE');
const about = '<p><a href="./index.html" download="cueframe.html">Download the offline HTML page</a></p><details class="help"><summary>Source and license</summary><p>Cueframe is a browser rewrite in a fork of Michał Szymaniak’s SubSync. Distributed under the GNU General Public License, version 3 or later. <a href="https://github.com/StanMiletskiy/subsync">View source and tests on GitHub</a>.</p><details><summary>Read GNU GPL v3</summary><pre style="white-space:pre-wrap;max-height:18rem;overflow:auto">' + escapeHTML(licence) + '</pre></details></details>';
html = html.replace('    <footer>', () => '    ' + about + '\n    <footer>');
await mkdir(output, { recursive: true });
await writeFile(new URL('index.html', output), html);
await writeFile(new URL('.nojekyll', output), '');
console.log('Built docs/index.html (' + Buffer.byteLength(html) + ' bytes).');
