// What the narrator says for a passage, cut into the pieces it speaks one at a time (server/voice.ts speaks them).
// Pure, so the reader can match a piece to the page it is on.

// Kokoro-82M's voices worth listening to for a whole chapter. The first is the default.
export const VOICES: { id: string; name: string; note: string }[] = [
  { id: 'af_heart', name: 'Heart', note: 'American woman, warm' },
  { id: 'af_bella', name: 'Bella', note: 'American woman, bright' },
  { id: 'af_nicole', name: 'Nicole', note: 'American woman, soft and close' },
  { id: 'af_sarah', name: 'Sarah', note: 'American woman, even' },
  { id: 'af_kore', name: 'Kore', note: 'American woman, low' },
  { id: 'am_michael', name: 'Michael', note: 'American man, steady' },
  { id: 'am_fenrir', name: 'Fenrir', note: 'American man, deep' },
  { id: 'am_puck', name: 'Puck', note: 'American man, lively' },
  { id: 'bf_emma', name: 'Emma', note: 'British woman, clear' },
  { id: 'bf_isabella', name: 'Isabella', note: 'British woman, warm' },
  { id: 'bm_george', name: 'George', note: 'British man, an old-fashioned storyteller' },
  { id: 'bm_fable', name: 'Fable', note: 'British man, young' },
  { id: 'bm_lewis', name: 'Lewis', note: 'British man, deep' },
];
export const DEFAULT_VOICE = VOICES[0].id;
export const voiceOf = (v: unknown) => VOICES.some(x => x.id === v) ? v as string : DEFAULT_VOICE;
export const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

export type Chunk = { text: string; pause: number };

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

// The words of a passage as they'd be read aloud: no markup, no dice lines, no scene stamps; a chapter heading is said.
export function spokenText(raw: string): string {
  return raw
    .replace(/<chaphead>([^<]*)<\/chaphead>/g, (_, x: string) => {
      const [n = '', title = ''] = x.split('|').map(v => v.trim());
      return `\n\nChapter ${n}${title ? `. ${title}` : ''}${/[.!?…]$/.test(title) ? '' : '.'}\n\n`;
    })
    .replace(/<(scene|roll|gate|room_result)>[^<]*<\/\1>/g, '\n\n')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<passage id="\d+"[^>]*\/>/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|table|section|article)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, '\n')
    .replace(/^[ \t]{0,3}(#{1,6}|>+|[-*+•]|\d{1,3}[.)])[ \t]+/gm, '')
    .replace(/`+/g, '')
    .replace(/\*\*|__|~~|\*/g, '')
    .replace(/(^|[^\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const ABBR = /(?:^|[\s"“‘'(])(?:Mr|Mrs|Ms|Dr|St|Mt|Prof|Sr|Jr|Lt|Col|Gen|Capt|Sgt|Rev|Hon|vs|etc|No|[A-Z])\.$/;

// Sentences of one paragraph. "Run!" she said. stays one sentence, and so do Mr. Hale and J. R. Smith.
function sentences(p: string): string[] {
  const parts = p.match(/[\s\S]+?(?:[.!?…]+["'”’»)\]]*(?=\s|$)|$)/g) ?? [];
  const out: string[] = [];
  for (const raw of parts) {
    const s = raw.trim();
    if (!s) continue;
    const prev = out.at(-1);
    if (prev && (ABBR.test(prev) || /^[a-z,;:—–)]/.test(s))) out[out.length - 1] = `${prev} ${s}`;
    else out.push(s);
  }
  return out;
}

// A sentence too long to speak in one go, cut at its commas, then at its words.
function splitLong(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let cur = '';
  for (const piece of s.split(/(?<=[,;:—–])\s+/)) {
    const bits = piece.length > max ? piece.split(/\s+/) : [piece];
    for (const b of bits) {
      if (cur && cur.length + 1 + b.length > max) { out.push(cur); cur = b; } else cur = cur ? `${cur} ${b}` : b;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const MAX = 260, FIRST = 140;
export const PARA_PAUSE = 0.45, SENT_PAUSE = 0.08;

// The pieces: a few sentences each, never across a paragraph, and a short first one so the voice starts quickly.
export function speechChunks(raw: string): Chunk[] {
  const out: Chunk[] = [];
  for (const para of spokenText(raw).split(/\n\s*\n/)) {
    const p = para.replace(/\s*\n\s*/g, ' ').trim();
    if (!/[\p{L}\p{N}]/u.test(p)) continue;
    let cur = '';
    for (const s of sentences(p)) for (const piece of splitLong(s, MAX)) {
      const lim = out.length ? MAX : FIRST;
      if (cur && cur.length + 1 + piece.length > lim) { out.push({ text: cur, pause: SENT_PAUSE }); cur = piece; } else cur = cur ? `${cur} ${piece}` : piece;
    }
    if (cur) out.push({ text: cur, pause: PARA_PAUSE });
  }
  return out;
}

// Letters and digits only, for finding a piece of speech on a page of the book.
export const squash = (t: string) => t.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// ---------------------------------------------------------------- when each word is said

// The words of a piece, as the reader highlights them: split at whitespace, so their letters run in the same order as squash(text).
export const chunkWords = (t: string) => t.split(/\s+/).filter(Boolean);
const said = (w: string) => /[\p{L}\p{N}]/u.test(w);
const CLAUSE = /[,.;:!?…—–]["'”’»)\]]*$/;

// Start and end (ms) of every word of a piece, from the model's duration for each phoneme token it spoke.
// Tokens between spaces are a spoken word; the text and the phonemes are lined up clause by clause (the punctuation
// survives into the phonemes), word for word where the counts agree and by length where they don't (a number
// like 1854 is one word written and three spoken).
export function wordTimes(text: string, toks: string[], dur: number[], secs: number): [number, number][] {
  const total = dur.reduce((a, b) => a + b, 0) || 1, k = secs / total;
  type G = { s: number; e: number; t: string };
  const groups: G[] = [];
  let at = 0, cur: G | null = null;
  for (let i = 0; i < toks.length; i++) {
    const t0 = at * k;
    at += dur[i] ?? 0;
    const tk = toks[i] ?? '';
    if (tk === ' ' || tk === '$') { cur = null; continue; }
    if (!cur) { cur = { s: t0, e: at * k, t: '' }; groups.push(cur); }
    if (/\p{L}/u.test(tk)) cur.e = at * k;
    cur.t += tk;
  }
  // A group of nothing but punctuation (a lone dash or quote) belongs to the word before it.
  const gs: G[] = [];
  for (const g of groups) { if (/\p{L}/u.test(g.t)) gs.push(g); else if (gs.length) gs[gs.length - 1].t += g.t; }
  const words = chunkWords(text);
  // Each spoken word carries the punctuation standing after it (a spaced dash) for finding clause ends.
  const spoken: { w: string; i: number; end: string }[] = [];
  words.forEach((w, i) => { if (said(w)) spoken.push({ w, i, end: w }); else if (spoken.length) spoken[spoken.length - 1].end += w; });
  // A title or an initial ends in a stop that isn't spoken ("Mr." is said "Mister").
  const ends = (x: { w: string; end: string }) => CLAUSE.test(x.end) && !(x.end === x.w && ABBR.test(` ${x.w}`));
  const out: [number, number][] = words.map(() => [0, 0]);
  const clauses = <T,>(xs: T[], end: (x: T) => boolean) => { const r: T[][] = [[]]; for (const x of xs) { r[r.length - 1].push(x); if (end(x)) r.push([]); } return r.filter(c => c.length); };
  const wc = clauses(spoken, ends), gc = clauses(gs, g => CLAUSE.test(g.t));
  // Clause by clause only when the clauses plainly match up; a number can triple a clause's words, not more.
  const fits = wc.length === gc.length && wc.every((c, i) => gc[i].length <= c.length * 3 + 1 && c.length <= gc[i].length * 2 + 1);
  const pairs: [typeof spoken, G[]][] = fits ? wc.map((c, i) => [c, gc[i]]) : [[spoken, gs]];
  for (const [ws, g] of pairs) {
    if (!g.length) continue;
    if (ws.length === g.length) { ws.forEach((x, j) => { out[x.i] = [g[j].s, g[j].e]; }); continue; }
    // By length: a word's share of the clause's letters maps onto the same share of its phonemes.
    const pos = [0];
    for (const x of g) pos.push(pos[pos.length - 1] + x.t.length);
    const time = (f: number) => {
      const p = f * pos[pos.length - 1];
      let j = 0;
      while (j < g.length - 1 && pos[j + 1] < p) j++;
      const span = pos[j + 1] - pos[j] || 1;
      return g[j].s + Math.min(1, (p - pos[j]) / span) * (g[j].e - g[j].s);
    };
    const wt = ws.map(x => { const s = squash(x.w); return s.length + (s.match(/\p{N}/gu)?.length ?? 0) * 2; });
    const sum = wt.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    ws.forEach((x, j) => { const a = acc / sum; acc += wt[j]; out[x.i] = [time(a), time(acc / sum)]; });
  }
  // Words with nothing to say (a spaced dash) sit at the end of the word before.
  for (let i = 0; i < words.length; i++) if (!said(words[i])) out[i] = i ? [out[i - 1][1], out[i - 1][1]] : [0, 0];
  return out.map(([s, e]) => [Math.round(s * 1000), Math.round(Math.max(s, e) * 1000)]);
}
