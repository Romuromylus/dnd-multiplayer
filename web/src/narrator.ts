// The narrator on this device: plays a story's passages aloud a piece at a time, spoken on the server (server/voice.ts).
// One audio element for everything, so a phone that let it play once keeps letting it play, and one piece is
// always fetched ahead so the next sentence starts the moment the last one ends.
import { useSyncExternalStore } from 'react';
import { api, savePrefs } from './api';
import { toast } from './ui';
import { chunkWords, squash, voiceOf } from '../../server/speech';

export type NarratorPrefs = { voice?: string; speed?: number; auto?: boolean; byStory?: Record<string, string> };
export type ReadItem = { id: number; label: string };
type Piece = { t: string; h: string; ready: boolean };
type Manifest = { voice: string; awake: boolean; chunks: Piece[] };
// A piece ready to play: its audio, and when each of its words is said (ms), if the server knows.
type Got = { url: string; times: [number, number][] | null };
// The word being said right now, for the reader to light up and follow.
export type WordNow = { passageId: number; chunk: number; caption: string; words: string[]; word: number };

export type NarratorState = {
  storyId: number | null; title: string; items: ReadItem[]; at: number;
  passageId: number | null; label: string; chunk: number; total: number; caption: string;
  status: 'idle' | 'loading' | 'playing' | 'paused'; waking: boolean;
  prefs: NarratorPrefs; panel: boolean;
};

const IDLE = { storyId: null, title: '', items: [], at: 0, passageId: null, label: '', chunk: 0, total: 0, caption: '', status: 'idle' as const, waking: false };

// A twentieth of a second of silence, played from the tap that starts the narrator so the browser lets it go on.
const SILENCE = (() => {
  const n = 400, b = new Uint8Array(44 + n), v = new DataView(b.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  b.fill(128, 44);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return `data:audio/wav;base64,${btoa(s)}`;
})();

class HttpError extends Error { constructor(msg: string, public status: number) { super(msg); } }

// Where a bit of text (squashed) falls among the pieces, or -1.
export function findPiece(chunks: { t: string }[], hint: string): number {
  if (!hint) return -1;
  const starts: number[] = [];
  let all = '';
  for (const c of chunks) { starts.push(all.length); all += squash(c.t); }
  for (const len of [32, 14]) {
    const at = all.indexOf(hint.slice(0, len));
    if (at >= 0) { let k = 0; while (k + 1 < starts.length && starts[k + 1] <= at) k++; return k; }
  }
  return -1;
}

class Narrator {
  s: NarratorState = { ...IDLE, prefs: {}, panel: false };
  private subs = new Set<() => void>();
  private audio: HTMLAudioElement | null = null;
  private token = 0;
  private live = false;
  private paused = false;
  private cur: { man: Manifest; voice: string; i: number } | null = null;
  private manifests = new Map<string, Promise<Manifest>>();
  private urls = new Map<string, Promise<Got>>();
  private times: [number, number][] | null = null;
  private wordNow: WordNow | null = null;
  private wordSubs = new Set<(w: WordNow | null) => void>();
  private raf = 0;
  private inflight = new Map<string, AbortController>();
  private skipT = 0;
  private saveT = 0;
  private sessionBound = false;
  private sample: HTMLAudioElement | null = null;

  get = () => this.s;
  subscribe = (f: () => void) => { this.subs.add(f); return () => { this.subs.delete(f); }; };
  private set(p: Partial<NarratorState>) { this.s = { ...this.s, ...p }; for (const f of this.subs) f(); }

  init(prefs: NarratorPrefs | undefined) { this.set({ prefs: prefs ?? {} }); }
  voiceFor(storyId: number | null) { return voiceOf((storyId != null && this.s.prefs.byStory?.[storyId]) || this.s.prefs.voice); }
  speed() { return this.s.prefs.speed ?? 1; }
  setPanel(open: boolean) { this.set({ panel: open }); }

  setPrefs(p: Partial<NarratorPrefs>) {
    this.set({ prefs: { ...this.s.prefs, ...p } });
    if (this.audio) { this.audio.defaultPlaybackRate = this.speed(); this.audio.playbackRate = this.speed(); }
    clearTimeout(this.saveT);
    savePrefs('narrator', this.s.prefs);
  }

  // A new voice for this story; what's playing carries on from the same sentence in it.
  setVoice(storyId: number, v: string) {
    this.setPrefs({ voice: v, byStory: { ...this.s.prefs.byStory, [storyId]: v } });
    if (this.s.storyId === storyId && this.s.status !== 'idle' && this.cur) {
      const chunk = this.cur.i;
      const tk = ++this.token;
      clearTimeout(this.skipT);
      this.abortAll();
      this.live = false;
      this.audio?.pause();
      this.set({ status: this.paused ? 'paused' : 'loading' });
      this.startItem(tk, { chunk });
    }
  }

  private el() {
    if (!this.audio) {
      const a = new Audio();
      a.preload = 'auto';
      a.addEventListener('ended', () => this.onEnded());
      a.addEventListener('playing', () => { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.loop); });
      // A few times a second even where frames don't run (a hidden tab, a throttled browser).
      a.addEventListener('timeupdate', () => this.step());
      this.audio = a;
    }
    return this.audio;
  }

  // ---------------------------------------------------------------- the word being said
  onWord(f: (w: WordNow | null) => void) { this.wordSubs.add(f); return () => { this.wordSubs.delete(f); }; }
  currentWord() { return this.wordNow; }
  private emitWord(w: WordNow | null) { this.wordNow = w; for (const f of this.wordSubs) f(w); }

  // Each frame while the audio plays, which word its clock is in. A piece without times from the server shares its
  // length out by the letters in each word.
  private loop = () => { if (this.step()) this.raf = requestAnimationFrame(this.loop); };
  private step(): boolean {
    const a = this.audio, cur = this.cur, it = this.s.items[this.s.at];
    if (!a || !this.live || !cur || !it || a.paused) return false;
    const pc = cur.man.chunks[cur.i];
    const words = this.wordNow?.passageId === it.id && this.wordNow.chunk === cur.i ? this.wordNow.words : chunkWords(pc.t);
    let times = this.times;
    if (!times && isFinite(a.duration) && a.duration > 0) {
      const w = words.map(x => squash(x).length), sum = w.reduce((p, q) => p + q, 0) || 1, ms = a.duration * 1000 * 0.94;
      let acc = 0;
      times = this.times = w.map(x => { const s0 = (acc / sum) * ms; acc += x; return [s0, (acc / sum) * ms] as [number, number]; });
    }
    if (times) {
      const t = a.currentTime * 1000;
      let k = 0;
      while (k + 1 < times.length && times[k + 1][0] <= t) k++;
      while (k > 0 && !squash(words[k]).length) k--;
      if (!this.wordNow || this.wordNow.passageId !== it.id || this.wordNow.chunk !== cur.i || this.wordNow.word !== k)
        this.emitWord({ passageId: it.id, chunk: cur.i, caption: pc.t, words, word: k });
    }
    return true;
  }

  // Read these passages in order. A hint (squashed page text) starts at the sentence it's in, looking that many passages in.
  play(storyId: number, title: string, items: ReadItem[], opts: { hint?: string; span?: number } = {}) {
    if (!items.length) return;
    const tk = ++this.token;
    clearTimeout(this.skipT);
    this.abortAll();
    this.live = false;
    this.paused = false;
    const a = this.el();
    a.src = SILENCE;
    a.play().catch(() => {});
    this.sample?.pause();
    this.set({ ...IDLE, storyId, title, items, status: 'loading', passageId: items[0].id, label: items[0].label });
    this.startItem(tk, opts);
  }

  // Auto-read: a passage that just arrived is read next, or now if nothing is playing.
  arrived(storyId: number, title: string, item: ReadItem) {
    if (!this.s.prefs.auto) return;
    if (this.s.storyId === storyId && this.s.status !== 'idle') {
      if (!this.s.items.some(x => x.id === item.id)) this.set({ items: [...this.s.items, item] });
      return;
    }
    this.play(storyId, title, [item]);
  }

  private manifest(id: number, voice: string) {
    const k = `${id}|${voice}`;
    let m = this.manifests.get(k);
    if (!m) {
      m = api<Manifest>(`/voice/passage/${id}?voice=${voice}`);
      this.manifests.set(k, m);
      m.catch(() => this.manifests.delete(k));
    }
    return m;
  }
  private forget(id: number) { for (const k of [...this.manifests.keys()]) if (k.startsWith(`${id}|`)) this.manifests.delete(k); }

  private pieceKey = (id: number, voice: string, i: number, h: string) => `${id}|${voice}|${i}|${h}`;
  private pieceUrl(id: number, voice: string, i: number, h: string) {
    const k = this.pieceKey(id, voice, i, h);
    let u = this.urls.get(k);
    if (!u) {
      const ctl = new AbortController();
      this.inflight.set(k, ctl);
      u = (async () => {
        try {
          const r = await fetch(`/api/voice/passage/${id}/${i}?voice=${voice}&h=${h}`, { signal: ctl.signal });
          if (!r.ok) { const j = await r.json().catch(() => ({})); throw new HttpError(j.error || `${r.status} ${r.statusText}`, r.status); }
          let times: [number, number][] | null = null;
          try { const t = JSON.parse(r.headers.get('x-words') ?? 'null'); if (Array.isArray(t)) times = t; } catch { /* none */ }
          return { url: URL.createObjectURL(await r.blob()), times };
        } finally { this.inflight.delete(k); }
      })();
      this.urls.set(k, u);
      u.catch(() => { if (this.urls.get(k) === u) this.urls.delete(k); });
      // Keep the last dozen pieces; older ones are let go.
      while (this.urls.size > 12) {
        const [old, p] = this.urls.entries().next().value!;
        this.urls.delete(old);
        p.then(x => setTimeout(() => URL.revokeObjectURL(x.url), 60_000)).catch(() => {});
      }
    }
    return u;
  }

  // Pieces on their way that the reading no longer needs are called off, so the server can drop them.
  private abortAll(keep = '') {
    for (const [k, ctl] of this.inflight) if (k !== keep) { ctl.abort(); this.inflight.delete(k); this.urls.delete(k); }
  }

  private async startItem(tk: number, opts: { hint?: string; span?: number; chunk?: number } = {}) {
    // Until this passage's pieces are known, there's nothing to skip through.
    this.cur = null;
    const voice = this.voiceFor(this.s.storyId);
    let start = opts.chunk ?? 0;
    try {
      if (opts.hint) {
        for (let k = 0; k < (opts.span ?? 1) && this.s.items[this.s.at + k]; k++) {
          const man = await this.manifest(this.s.items[this.s.at + k].id, voice);
          if (tk !== this.token) return;
          const at = findPiece(man.chunks, opts.hint);
          if (at >= 0) { this.set({ at: this.s.at + k }); start = at; break; }
        }
      }
      const it = this.s.items[this.s.at];
      if (!it) { this.finish(); return; }
      const man = await this.manifest(it.id, voice);
      if (tk !== this.token) return;
      if (!man.chunks.length) { this.set({ at: this.s.at + 1 }); return this.startItem(tk); }
      start = Math.min(start, man.chunks.length - 1);
      this.cur = { man, voice, i: start };
      this.set({ passageId: it.id, label: it.label, total: man.chunks.length, waking: !man.awake && !man.chunks[start].ready });
      await this.playPiece(tk);
    } catch (e) {
      if (tk !== this.token) return;
      toast(`The narrator stopped: ${(e as Error).message}`, 'error');
      this.stop();
    }
  }

  private async playPiece(tk: number) {
    const cur = this.cur!;
    const it = this.s.items[this.s.at];
    const pc = cur.man.chunks[cur.i];
    this.set({ chunk: cur.i, caption: pc.t, status: this.paused ? 'paused' : 'loading' });
    let got: Got;
    try { got = await this.pieceUrl(it.id, cur.voice, cur.i, pc.h); }
    catch (e) {
      if (tk !== this.token) return;
      // The passage was edited since: read it again from the same place.
      if (e instanceof HttpError && e.status === 409) { this.forget(it.id); return this.startItem(tk, { chunk: cur.i }); }
      throw e;
    }
    if (tk !== this.token) return;
    const a = this.el();
    this.live = true;
    a.src = got.url;
    const words = chunkWords(pc.t);
    this.times = got.times && got.times.length === words.length ? got.times : null;
    this.emitWord({ passageId: it.id, chunk: cur.i, caption: pc.t, words, word: -1 });
    a.defaultPlaybackRate = this.speed();
    a.playbackRate = this.speed();
    this.session();
    this.prefetch(tk);
    if (this.paused) { this.set({ status: 'paused', waking: false }); return; }
    try { await a.play(); if (tk === this.token) this.set({ status: 'playing', waking: false }); }
    catch { if (tk === this.token) { this.paused = true; this.set({ status: 'paused', waking: false }); } }
  }

  private prefetch(tk: number) {
    const cur = this.cur;
    if (!cur || tk !== this.token) return;
    const it = this.s.items[this.s.at];
    const nx = cur.man.chunks[cur.i + 1];
    if (nx) this.pieceUrl(it.id, cur.voice, cur.i + 1, nx.h).catch(() => {});
    else {
      const after = this.s.items[this.s.at + 1];
      if (after) this.manifest(after.id, cur.voice).then(m => m.chunks[0] && this.pieceUrl(after.id, cur.voice, 0, m.chunks[0].h)).catch(() => {});
    }
  }

  private onEnded() {
    if (!this.live || !this.cur) return;
    const tk = this.token;
    if (this.cur.i + 1 < this.cur.man.chunks.length) { this.cur.i++; this.playPiece(tk).catch(e => this.fail(tk, e)); }
    else { this.set({ at: this.s.at + 1 }); this.startItem(tk); }
  }
  private fail(tk: number, e: unknown) { if (tk === this.token) { toast(`The narrator stopped: ${(e as Error).message}`, 'error'); this.stop(); } }

  private finish() {
    this.live = false;
    this.cur = null;
    this.emitWord(null);
    this.set({ ...IDLE });
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none';
  }

  pause() {
    this.paused = true;
    this.audio?.pause();
    if (this.s.status !== 'idle') this.set({ status: 'paused' });
  }
  resume() {
    if (this.s.status === 'idle') return;
    this.paused = false;
    const a = this.audio;
    if (this.live && a?.src) { a.play().then(() => this.set({ status: 'playing' })).catch(() => { this.paused = true; this.set({ status: 'paused' }); }); }
    else if (this.cur) { const tk = ++this.token; this.playPiece(tk).catch(e => this.fail(tk, e)); }
  }
  toggle() { if (this.s.status === 'playing' || this.s.status === 'loading') this.pause(); else this.resume(); }

  stop() {
    this.token++;
    clearTimeout(this.skipT);
    this.abortAll();
    this.live = false;
    this.cur = null;
    this.paused = false;
    if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); }
    this.emitWord(null);
    this.set({ ...IDLE });
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none';
  }

  // A sentence on or back; past either end of a passage goes to the next one or the start of this one.
  // Taps in a row settle first, so only the sentence landed on is fetched.
  skip(d: 1 | -1) {
    if (!this.cur) return;
    const tk = ++this.token;
    clearTimeout(this.skipT);
    this.live = false;
    this.audio?.pause();
    const cur = this.cur, it = this.s.items[this.s.at];
    const i = cur.i + d;
    if (i >= cur.man.chunks.length) { this.abortAll(); this.set({ at: this.s.at + 1 }); this.startItem(tk); return; }
    cur.i = Math.max(0, i);
    const pc = cur.man.chunks[cur.i];
    const k = this.pieceKey(it.id, cur.voice, cur.i, pc.h);
    this.abortAll(k);
    this.set({ chunk: cur.i, caption: pc.t, status: this.paused ? 'paused' : 'loading' });
    const go = () => { if (tk === this.token) this.playPiece(tk).catch(e => this.fail(tk, e)); };
    if (this.urls.has(k)) go(); else this.skipT = window.setTimeout(go, 450);
  }

  // The lock screen and headphone buttons.
  private session() {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ms) return;
    try { ms.metadata = new MediaMetadata({ title: this.s.label || this.s.title, artist: this.s.title, album: 'Inkwell' }); } catch { /* not supported */ }
    ms.playbackState = this.paused ? 'paused' : 'playing';
    if (this.sessionBound) return;
    this.sessionBound = true;
    const on = (a: MediaSessionAction, f: () => void) => { try { ms.setActionHandler(a, f); } catch { /* not supported */ } };
    on('play', () => this.resume());
    on('pause', () => this.pause());
    on('stop', () => this.stop());
    on('nexttrack', () => this.skip(1));
    on('previoustrack', () => this.skip(-1));
  }

  // A line in a voice, to choose by. Pauses the story while it plays.
  trySample(voice: string, onDone: () => void) {
    if (this.s.status === 'playing' || this.s.status === 'loading') this.pause();
    this.sample?.pause();
    const a = new Audio(`/api/voice/sample?voice=${voice}`);
    a.playbackRate = this.speed();
    this.sample = a;
    a.addEventListener('ended', onDone);
    a.addEventListener('error', () => { toast("That voice couldn't be played.", 'error'); onDone(); });
    a.play().catch(() => onDone());
  }
}

export const narrator = new Narrator();
export const useNarrator = () => useSyncExternalStore(narrator.subscribe, narrator.get);
export const useReading = (id: number) => useSyncExternalStore(narrator.subscribe, () => narrator.s.status !== 'idle' && narrator.s.passageId === id);
