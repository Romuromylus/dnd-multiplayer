// The narrator: Kokoro-82M (Apache 2.0), run here on the server's CPU, so reading a story aloud costs nothing per word.
// A passage is spoken a piece at a time (speech.ts), each piece once, and kept as an MP3 under data/voice named by
// what it says and in which voice, so a replay is free and an edit only re-speaks the sentences that changed.
// Measured on the 4-core server (2026-11-04): fp32 speaks 1.76x faster than real time, q8 only 0.58x, so fp32.
// The timestamped export is the same voice, and also says how long it spent on every phoneme, which gives each word
// a start and an end so the reader can light it up while it's said.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Hono } from 'hono';
import { Mp3Encoder } from '@breezystack/lamejs';
import { config } from './config.ts';
import { db } from './db.ts';
import { speechChunks, voiceOf, wordTimes } from './speech.ts';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';
const OLD_MODELS = ['onnx-community/Kokoro-82M-v1.0-ONNX'];
const VERSION = 'k2';
const dir = path.join(config.dataDir, 'voice');
const IDLE_MS = 10 * 60_000;
const CAP = 1.5 * 2 ** 30, KEEP = 1.2 * 2 ** 30;

type Tts = {
  generate(text: string, o: { voice: string }): Promise<{ audio: Float32Array; sampling_rate: number }>;
  model: any; tokenizer: { model?: { vocab?: string[] } };
};
// What the model said last: its phoneme tokens and how long each took. The queue speaks one piece at a time.
type Heard = { ids: ArrayLike<bigint | number>; durations?: { data: ArrayLike<number> } };
let heard: Heard | null = null;
let tts: Tts | null = null;
let loading: Promise<Tts> | null = null;
let lastUse = 0;

// The model's files are fetched here rather than by transformers.js: it only keeps a download that is an instance of the
// global Response, and the Hono server replaces that global, so a first download inside the server was never saved.
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'];
async function fetchModel(cacheDir: string) {
  for (const f of FILES) {
    const out = path.join(cacheDir, MODEL, f);
    if (fs.existsSync(out)) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const r = await fetch(`https://huggingface.co/${MODEL}/resolve/main/${f}`);
    if (!r.ok || !r.body) throw new Error(`The narrator's voice model couldn't be downloaded (${f}: ${r.status}).`);
    const tmp = `${out}.${process.pid}.part`;
    await pipeline(Readable.fromWeb(r.body as any), fs.createWriteStream(tmp));
    fs.renameSync(tmp, out);
  }
  for (const m of OLD_MODELS) fs.rmSync(path.join(cacheDir, m), { recursive: true, force: true });
}

// The model loads on first use (the first time ever it downloads, about 330 MB, into data/models) and is let go when idle.
function model(): Promise<Tts> {
  lastUse = Date.now();
  if (tts) return Promise.resolve(tts);
  loading ??= (async () => {
    const t = performance.now();
    const cacheDir = path.join(config.dataDir, 'models');
    await fetchModel(cacheDir);
    const { env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    const { KokoroTTS } = await import('kokoro-js').finally(unhook);
    const m = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device: 'cpu' }) as unknown as Tts;
    // kokoro-js keeps only the waveform; the durations are caught on the way past.
    const real = m.model;
    m.model = Object.assign(async (inputs: any) => { const out = await real(inputs); heard = { ids: inputs.input_ids.data, durations: out.durations }; return out; }, { dispose: () => real.dispose?.() });
    await m.generate('Ready.', { voice: 'af_heart' }).finally(unhook);
    console.log(`[voice] narrator ready in ${Math.round(performance.now() - t)} ms`);
    tts = m;
    return m;
  })().finally(() => { loading = null; });
  return loading;
}
export const voiceAwake = () => !!tts;

// The phonemizer (espeak-ng built with Emscripten) hooks the process's error events when it loads, and on any crash
// prints its whole minified source into the log. The server's own crash behaviour is Node's default, so they go.
const hooks = { unhandledRejection: process.listeners('unhandledRejection'), uncaughtException: process.listeners('uncaughtException') };
function unhook() {
  const em = process as unknown as NodeJS.EventEmitter;
  for (const ev of ['unhandledRejection', 'uncaughtException'] as const)
    for (const l of em.listeners(ev)) if (!(hooks[ev] as Function[]).includes(l)) em.off(ev, l as (...a: unknown[]) => void);
}

setInterval(() => {
  if (!tts || running || Date.now() - lastUse < IDLE_MS) return;
  const m = tts;
  tts = null;
  Promise.resolve(m.model?.dispose?.()).catch(() => {});
  console.log('[voice] narrator put away (idle)');
}, 60_000).unref();

// One piece spoken at a time, the one someone is waiting for first, then the ones read ahead.
type Task = { key: string; text: string; voice: string; pause: number; prio: number; ahead: boolean; waiters: number; at: number; done: Promise<string>; resolve: (f: string) => void; reject: (e: unknown) => void };
const tasks = new Map<string, Task>();
let running: Task | null = null;

export const pieceKey = (text: string, voice: string, pause: number) => crypto.createHash('sha1').update(`${VERSION}|${voice}|${pause}|${text}`).digest('hex').slice(0, 24);
const fileOf = (key: string) => path.join(dir, `${key}.mp3`);

// A listener who goes away (a skip, a stop) takes their piece out of the queue, unless it's also wanted as a read-ahead.
export function speak(text: string, voice: string, pause: number, prio: number, signal?: AbortSignal): Promise<string> {
  const key = pieceKey(text, voice, pause);
  const file = fileOf(key);
  if (fs.existsSync(file)) return Promise.resolve(file);
  let t = tasks.get(key);
  if (t) t.prio = Math.max(t.prio, prio);
  else {
    let resolve!: (f: string) => void, reject!: (e: unknown) => void;
    const done = new Promise<string>((a, b) => { resolve = a; reject = b; });
    done.catch(() => {});
    t = { key, text, voice, pause, prio, ahead: false, waiters: 0, at: Date.now(), done, resolve, reject };
    tasks.set(key, t);
  }
  if (!signal) t.ahead = true;
  else {
    const task = t;
    task.waiters++;
    signal.addEventListener('abort', () => {
      if (--task.waiters > 0 || running === task || tasks.get(task.key) !== task) return;
      if (task.ahead) task.prio = 1;
      else { tasks.delete(task.key); task.reject(new Error('Not wanted any more.')); }
    }, { once: true });
  }
  pump();
  return t.done;
}

async function pump() {
  if (running) return;
  // Reading ahead for someone who has stopped listening isn't worth the CPU.
  for (const t of tasks.values()) if (t.prio < 2 && Date.now() - t.at > 3 * 60_000) { tasks.delete(t.key); t.reject(new Error('No longer wanted.')); }
  const next = [...tasks.values()].sort((a, b) => b.prio - a.prio || a.at - b.at)[0];
  if (!next) return;
  running = next;
  try {
    const m = await model();
    heard = null;
    const out = await m.generate(next.text, { voice: next.voice });
    fs.mkdirSync(dir, { recursive: true });
    const file = fileOf(next.key), tmp = `${file}.${process.pid}.tmp`;
    // The word times go next to the audio, and before it, so a piece that's there always has them.
    const vocab = m.tokenizer.model?.vocab, h = heard as Heard | null;
    if (h?.durations && vocab) {
      const toks = Array.from(h.ids, x => vocab[Number(x)] ?? '');
      const words = wordTimes(next.text, toks, Array.from(h.durations.data, Number), out.audio.length / out.sampling_rate);
      fs.writeFileSync(file.replace(/\.mp3$/, '.json'), JSON.stringify(words));
    }
    fs.writeFileSync(tmp, mp3(out.audio, out.sampling_rate, next.pause));
    fs.renameSync(tmp, file);
    lastUse = Date.now();
    next.resolve(file);
  } catch (e) {
    console.error('[voice] could not speak', e);
    next.reject(e);
  } finally {
    tasks.delete(next.key);
    running = null;
    pump();
  }
}

// 48 kbps mono: a minute of speech is about 360 KB.
function mp3(samples: Float32Array, rate: number, pause: number): Buffer {
  const n = samples.length + Math.round(rate * pause);
  const pcm = new Int16Array(n);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  const enc = new Mp3Encoder(1, rate, 48);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < n; i += 11520) parts.push(enc.encodeBuffer(pcm.subarray(i, i + 11520)));
  parts.push(enc.flush());
  return Buffer.concat(parts.map(x => Buffer.from(x.buffer, x.byteOffset, x.byteLength)));
}

// The oldest pieces go once the voice folder passes its cap. A piece played again counts as new.
function prune() {
  try {
    const all = new Set(fs.readdirSync(dir));
    for (const f of all) if (f.endsWith('.mp3') && !all.has(f.replace(/\.mp3$/, '.json'))) { fs.rmSync(path.join(dir, f), { force: true }); all.delete(f); }
    const files = [...all].filter(f => f.endsWith('.mp3')).map(f => { const s = fs.statSync(path.join(dir, f)); return { f, size: s.size, t: s.mtimeMs }; });
    let total = files.reduce((n, x) => n + x.size, 0);
    if (total <= CAP) return;
    for (const x of files.sort((a, b) => a.t - b.t)) {
      if (total <= KEEP) break;
      fs.rmSync(path.join(dir, x.f), { force: true });
      fs.rmSync(path.join(dir, x.f.replace(/\.mp3$/, '.json')), { force: true });
      total -= x.size;
    }
  } catch { /* no voice folder yet */ }
}
setTimeout(prune, 30_000).unref();
setInterval(prune, 6 * 60 * 60_000).unref();

// ---------------------------------------------------------------- routes

export const voiceApi = new Hono();

const passageText = (id: number) => (db.prepare(`select text from passages where id = ? and kind = 'prose'`).get(id) as { text: string } | undefined)?.text;
const SAMPLE = 'The rain had not stopped for three days, and the river below the mill ran brown and loud. "They\'re moving," she said, without turning around.';

const sendMp3 = (c: any, file: string, immutable: boolean) => {
  try { const t = new Date(); fs.utimesSync(file, t, t); } catch { /* it's still there to read */ }
  let words = '';
  try { words = fs.readFileSync(file.replace(/\.mp3$/, '.json'), 'utf8'); } catch { /* spoken before word times */ }
  return c.body(fs.readFileSync(file), 200, { 'content-type': 'audio/mpeg', 'cache-control': immutable ? 'private, max-age=31536000, immutable' : 'no-cache', ...(words ? { 'x-words': words } : {}) });
};

// What a passage will be read as: its pieces, and which are spoken already. Asking wakes the narrator up.
voiceApi.get('/passage/:id', c => {
  const text = passageText(Number(c.req.param('id')));
  if (text == null) return c.json({ error: 'No such passage.' }, 404);
  const voice = voiceOf(c.req.query('voice'));
  const chunks = speechChunks(text).map(x => { const h = pieceKey(x.text, voice, x.pause); return { t: x.text, h, ready: fs.existsSync(fileOf(h)) }; });
  const awake = voiceAwake();
  if (!awake && chunks.some(x => !x.ready)) model().catch(e => console.error('[voice] narrator failed to load', e));
  return c.json({ voice, awake, chunks });
});

voiceApi.get('/passage/:id/:i', async c => {
  const text = passageText(Number(c.req.param('id')));
  if (text == null) return c.json({ error: 'No such passage.' }, 404);
  const voice = voiceOf(c.req.query('voice'));
  const chunks = speechChunks(text);
  const i = Number(c.req.param('i'));
  const ch = chunks[i];
  if (!ch) return c.json({ error: 'No such piece.' }, 404);
  const h = c.req.query('h');
  if (h && h !== pieceKey(ch.text, voice, ch.pause)) return c.json({ error: 'The passage changed.' }, 409);
  const signal: AbortSignal = c.req.raw.signal;
  let file: string;
  try { file = await speak(ch.text, voice, ch.pause, 2, signal); }
  catch (e) { if (signal.aborted) return c.body(null, 204); throw e; }
  for (const k of [1, 2]) { const x = chunks[i + k]; if (x) speak(x.text, voice, x.pause, 1); }
  return sendMp3(c, file, !!h);
});

voiceApi.get('/sample', async c => sendMp3(c, await speak(SAMPLE, voiceOf(c.req.query('voice')), 0.1, 3), true));

