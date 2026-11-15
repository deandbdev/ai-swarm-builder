// Renders a recorded agent session (traces/*.json) or a plain plan (plans/*.json)
// as a vertical 1080x1920 video by playing it in a headless browser and
// recording the page together with the sound effects synthesised by the page.
//
//   node render.mjs traces/bakery.json --speed 2
//   node render.mjs plans/dentist.json --lang en --out out/dentist.mp4
//   node render.mjs --all                  (everything in traces/ and plans/)
//
// --lang en|bg    applies to plain plans only; recordings carry their own language
// Sound is synthesised in the page and mixed into the video automatically.
//   --no-sound      no audio          --sfx-volume 0.8   effects volume
//   --sync 0.15     audio/video sync offset in seconds
//   --square        1080x1080 with black side bars (LinkedIn)
//   --watermark "Your name"   [--wm-pos top|bottom]
//   --music file.mp3 [--music-volume 0.18]   background music (only if you hold the rights)
//   --no-hook       no opening caption and closing question (on by default for
//                   recordings of real agent runs)
//
// Needs Node 18+, Chrome (or `npx playwright install chromium`) and ffmpeg in PATH.
import { chromium } from 'playwright';
import { readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, basename, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const speed = parseFloat(opt('--speed', '1')) || 1;
const lang = opt('--lang', 'bg') === 'en' ? 'en' : 'bg';
const sound = !args.includes('--no-sound');
const sfxVol = parseFloat(opt('--sfx-volume', '1')) || 1;
const sync = parseFloat(opt('--sync', '0.15'));                       // ако звукът избързва/закъснява спрямо картината, нагласи тук (секунди)
const square = args.includes('--square');                              // 1080×1080 с черни полета отляво/отдясно (за LinkedIn)
const wmPos = opt('--wm-pos', 'bottom');                              // top|bottom (за вертикално видео)
const watermark = opt('--watermark', null);                            // напр. --watermark "Dean Bouzekow"
const music = opt('--music', null);
const musicVol = parseFloat(opt('--music-volume', '0.18')) || 0.18;
const wavFromPcm = (pcm, sr) => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};
const W = 1080, H = 1920;

let files = [];
if (args.includes('--all')) {
  for (const dir of ['traces', 'plans']) {
    try { files.push(...readdirSync(join(here, dir)).filter(f => f.endsWith('.json')).map(f => join(here, dir, f))); } catch {}
  }
} else {
  const f = args.find(a => a.endsWith('.json'));
  if (!f) { console.error('Usage: node render.mjs traces/<recording>.json [--speed 2] [--out out/name.mp4]  |  node render.mjs --all'); process.exit(1); }
  files = [resolve(f)];
}

const ffmpeg = spawnSync('ffmpeg', ['-version']);
if (ffmpeg.error) { console.error('ffmpeg not found in PATH. Install it (for example `winget install ffmpeg`) and try again.'); process.exit(1); }

async function launch() {
  if (process.env.CHROME_PATH) return await chromium.launch({ executablePath: process.env.CHROME_PATH });
  try { return await chromium.launch({ channel: 'chrome' }); }          // инсталиран Google Chrome
  catch { return await chromium.launch(); }                             // или Chromium от Playwright
}

mkdirSync(join(here, 'out'), { recursive: true });
const browser = await launch();

for (const file of files) {
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  const name = basename(file, '.json');
  const out = resolve(opt('--out', join(here, 'out', name + '.mp4')));
  const tmp = join(here, 'out', '.tmp-' + name);
  rmSync(tmp, { recursive: true, force: true });

  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: tmp, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  const tPage = Date.now();                                              // запис на видеото започва със създаването на страницата
  page.on('pageerror', e => console.error('Грешка в страницата:', e.message));
  const url = pathToFileURL(join(here, 'index.html')).href + `?autorun=0&clean=1&speed=${speed}&lang=${lang}${args.includes('--no-hook') ? '&hook=0' : ''}`;
  await page.goto(url);
  await page.evaluate(() => window.swarm.fontsReady);
  await page.waitForTimeout(600);                                        // стабилен начален кадър
  const tPlay = Date.now();
  const offset = (tPlay - tPage) / 1000;                                 // толкова секунди преди старта на анимацията
  console.log(`▶ ${name}: записвам (върви в реално време)…`);
  await page.evaluate(obj => window.swarm.play(obj), plan);             // връща се, когато агентите приключат
  await page.waitForTimeout(800);                                        // кратка опашка след финала
  const seconds = (Date.now() - tPlay) / 1000;
  const wav = join(tmp, 'sfx.wav');
  if (sound) {
    const b64 = await page.evaluate(t => window.swarm.renderAudio(t), seconds + 0.5);
    writeFileSync(wav, wavFromPcm(Buffer.from(b64, 'base64'), 44100));
  }
  const vidLen = (Date.now() - tPage) / 1000;
  let wmPng = null;
  if (watermark) {                                                       // воден знак като прозрачна картинка (без шрифтове във ffmpeg)
    const wp = await browser.newPage({ viewport: { width: 520, height: 80 }, deviceScaleFactor: 2 });
    await wp.setContent(`<body style="margin:0;background:transparent"><div id=w style="display:inline-block;padding:10px 18px;font:600 30px 'Segoe UI',Arial,sans-serif;color:#fff;opacity:.62;text-shadow:0 1px 4px rgba(0,0,0,.7);white-space:nowrap"></div></body>`);
    await wp.evaluate(t => { document.getElementById('w').textContent = t; }, watermark);
    wmPng = join(tmp, 'wm.png');
    await wp.locator('#w').screenshot({ path: wmPng, omitBackground: true });
    await wp.close();
  }
  await ctx.close();                                                     // записва .webm

  const webm = readdirSync(tmp).find(f => f.endsWith('.webm'));
  const trim = Math.max(0, offset - 0.3);
  const delay = Math.max(0, offset - trim + (Number.isFinite(sync) ? sync : 0.15));                                           // толкова секунди преди старта на анимацията във видеото
  const inputs = ['-ss', trim.toFixed(2), '-i', join(tmp, webm)];
  const filters = [];
  let n = 1;
  if (sound) { inputs.push('-itsoffset', delay.toFixed(2), '-i', wav); filters.push(`[${n}:a]volume=${sfxVol}[s]`); n++; }
  if (music) { inputs.push('-stream_loop', '-1', '-i', resolve(music)); { const D = Math.max(6, vidLen - trim); filters.push(`[${n}:a]volume=${musicVol},afade=t=in:d=1.5,afade=t=out:st=${(D - 3).toFixed(2)}:d=3[m]`); }; n++; }
  let vLabel = '0:v';
  const vf = [];
  if (square) vf.push('scale=-2:1080', 'pad=1080:1080:(ow-iw)/2:0:black');
  if (wmPng) { inputs.push('-i', wmPng); }
  const wmIdx = wmPng ? n : -1; if (wmPng) n++;
  if (vf.length || wmPng) {
    let chain = `[0:v]${vf.length ? vf.join(',') : 'null'}[b]`;
    if (wmPng) chain += `;[${wmIdx}:v]scale=${square ? 210 : 360}:-1[w];[b][w]overlay=${square ? '13:H-h-24' : (wmPos === 'top' ? '(W-w)/2:70' : '(W-w)/2:H-h+4')}[v]`; else chain = chain.replace('[b]', '[v]');
    filters.push(chain); vLabel = '[v]';
  }
  const maps = ['-map', vLabel];
  if (sound && music) { filters.push('[s][m]amix=inputs=2:duration=first,volume=2[a]'); maps.push('-map', '[a]'); }
  else if (sound) { maps.push('-map', '[s]'); }
  else if (music) { maps.push('-map', '[m]'); }
  const ffArgs = ['-y', ...inputs, ...(filters.length ? ['-filter_complex', filters.join(';')] : []), ...maps,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
    ...(filters.length ? ['-c:a', 'aac', '-b:a', '160k', '-shortest'] : []), '-movflags', '+faststart', out];
  const r = spawnSync('ffmpeg', ffArgs, { stdio: 'ignore' });
  rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) { console.error('ffmpeg се провали за', name); continue; }
  console.log('✓ ' + out);
}
await browser.close();
