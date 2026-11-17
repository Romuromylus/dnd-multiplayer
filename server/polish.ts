// The polish pass: a new passage is measured, and when it shows the habits a long story drifts into, a separate editor
// with none of the story in front of it repairs the paragraphs that hold them. The editor returns only what it changed,
// and a change is taken only when it leaves every spoken line, color and tag as it was.
import { BEATS, nameWords, plainText, readingCheck, STOP, wordCount } from './context.ts';
import { bannedHits } from './rules.ts';
import { emit, type Job } from './jobs.ts';
import { callModel, zeroUsage, type Conn, type Usage } from './llm.ts';
import * as R from './records.ts';
import { on, SLOP_PATTERNS, type StorySettings } from './rules.ts';

const QUOTE = /["“][^"”\n]*["”]/g;
// Thoughts, songs and writing set in italics: like speech, they are the characters' own words.
const ITALIC = /\*[^*\n]+\*|_[^_\n]+_/g;

// Passages a line editor can work on: prose with colored speech at most. A visual novel script names its speakers.
export const polishes = (s: StorySettings) => s.polish === 'on';

// A paragraph the editor may not touch: a scene line, a dice roll, a letter or sign drawn in HTML, a scene break.
const locked = (p: string) => !/[a-z]/i.test(p.replace(/<[^>]+>/g, '')) || /<(?!\/?(?:font|em|i|b|u|strong)\b)[a-z!/]/i.test(p);

export function paragraphs(text: string): { parts: string[]; seps: string[] } {
  const bits = text.split(/(\n{2,})/);
  return { parts: bits.filter((_, i) => i % 2 === 0), seps: bits.filter((_, i) => i % 2 === 1) };
}

const cap = (xs: string[], n: number) => `${xs.slice(0, n).map(x => `"${x}"`).join(', ')}${xs.length > n ? `, and ${xs.length - n} more like them` : ''}`;

// What is wrong with this one passage, each point with the words that show it. Empty when it reads fine.
export function polishFlags(story: R.Story, text: string): string[] {
  const s = story.settings;
  const { parts } = paragraphs(text);
  const prose = parts.filter(p => !locked(p)).map(plainText).join('\n\n');
  const words = wordCount(prose);
  if (words < 300) return [];
  const out: string[] = [];
  // Narration only: spoken lines are not the editor's to change, so nothing in them is counted.
  const narration = prose.replace(ITALIC, ' @@ ').replace(QUOTE, ' @@ ');
  const sents = narration.split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(x => /[a-z]/i.test(x) && !x.includes('@@'));
  if (sents.length >= 25) {
    const short = sents.filter(x => wordCount(x) <= 4);
    if (short.length >= 6 && short.length / sents.length >= 0.2) out.push(`Clipped narration: ${short.length} of ${sents.length} sentences are four words or fewer (${cap(short, 14)}). Join each to the sentence before or after it so the narration reads in full sentences. Keep one only where it is a joke or a shock.`);
    const vague = sents.filter(x => /^(?:It|That|This)\b/.test(x));
    if (vague.length >= 5 && vague.length / sents.length >= 0.09) out.push(`Vague openers: ${vague.length} sentences open with "It", "That" or "This" (${cap(vague.map(x => x.split(/\s+/).slice(0, 6).join(' ')), 12)}). Open most of them with the thing or person meant.`);
  }
  const beats = BEATS.map(([label, re]) => [label, (narration.match(re) ?? []).length] as const).filter(([, n]) => n >= 4);
  if (beats.length) out.push(`Beats used again and again: ${beats.map(([l, n]) => `${l}, ${n} times`).join('; ')}. Keep the one that matters most and reword or cut the rest.`);
  // Uncontracted negatives in narration ("He did not answer."): popular fanfic writes "didn't", and says what happened.
  const negs = narration.split(/(?<=[.!?])\s+|\n+/).filter(x => !x.includes('@@') && /\b(?:did|was|were|had|could|would|is|are|do|does|has|have) not\b/i.test(x));
  if (negs.length >= 3 && negs.length / words * 1000 >= 5) out.push(`Stiff negatives: ${negs.length} sentences of narration say "did not", "was not" or "had not" (${cap(negs.map(x => x.split(/\s+/).slice(0, 8).join(' ')), 8)}). Write them with contractions ("didn't", "wasn't"), or say what happened instead of what didn't.`);

  // Repeated wording, counted inside a sentence (never across a full stop or a spoken line), and a long repeated
  // phrase is one finding, not every four words of it.
  const grams = new Map<string, { n: number; at: number }>();
  const names = nameWords(story.id, [text]);
  let at = 0;
  for (const seg of narration.toLowerCase().split(/@@|[.!?;:\n]+/)) {
    const w = seg.replace(/[^a-z'\s-]/g, ' ').split(/\s+/).filter(Boolean);
    for (let i = 0; i + 4 <= w.length; i++, at++) {
      const g = w.slice(i, i + 4);
      if (g.filter(x => !STOP.has(x)).length < 2 || g.some(x => names.has(x))) continue;
      const k = g.join(' '), e = grams.get(k);
      if (e) e.n++; else grams.set(k, { n: 1, at });
    }
    at += 10;
  }
  const reps: string[] = [];
  let last = -10;
  for (const [g, e] of [...grams.entries()].filter(([, e]) => e.n >= 4).sort((x, y) => x[1].at - y[1].at)) {
    const gap = e.at - last;
    if (gap >= 1 && gap <= 4 && reps.length) reps[reps.length - 1] += ` ${g.split(' ').slice(4 - gap).join(' ')}`;
    else reps.push(g);
    last = e.at;
  }
  if (reps.length) out.push(`Phrases repeated four times or more in the narration: ${cap(reps, 6)}. Keep the first and say the others another way.`);

  if (on(s, 'anti_slop')) {
    // Once is a word; twice in one passage is a habit.
    const slop = SLOP_PATTERNS.map(([, re]) => narration.match(re) ?? []).filter(m => m.length >= 2).flat();
    if (slop.length) out.push(`Stock phrases used more than once: ${cap([...new Set(slop.map(x => x.toLowerCase()))], 8)}. Keep one at most and say the rest plainly.`);
  }
  const banned = bannedHits(narration, s.banned_phrases);
  if (banned.length) out.push(`Phrases the author has banned: ${cap(banned, 10)}. Reword so they are gone.`);

  // Names giving way to titles is measured over the story's recent text; here it is put right in the newest of it.
  if (readingCheck(story.id, s.tone).some(x => x.includes('called by name'))) {
    const names = R.listCards(story.id).filter(c => new RegExp(`\\b${c.name.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(prose)).map(c => `${c.name}${c.fields?.role_age ? ` (${c.fields.role_age})` : ''}`);
    if (names.length) out.push(`Names replaced by titles: the narration calls people by a title or a description ("the captain", "the red-haired man") where it used to use their names. Where it is certain who is meant, use the name. The people here: ${names.slice(0, 14).join('; ')}.`);
  }
  return out;
}

const EDITOR = `You are a line editor for a serialized story. You are given one passage, cut into numbered paragraphs, and a list of problems measured in it. Fix those problems and nothing else.

Rules:
- Never change, add or remove a word inside quotation marks. Every spoken line stays exactly as written, together with any <font color="..."> tag around it.
- Text set in *italics* is a thought, a song or a piece of writing: it stays exactly as written too.
- Never change what happens, who does it, the order of events, the point of view, the tense or the tone.
- Add no new events, facts, descriptions, comparisons or figures of speech. Cut nothing that tells the reader something.
- Write in plain, everyday words and full sentences, in the voice the passage already has.
- Names stay. A person, place, power, form, technique or item keeps the name the passage gives it; never swap a name for a description.
- Change as few paragraphs as the problems need. A paragraph with none of the listed problems stays as it is.
- A paragraph marked "locked" is there for context only.

Output only the paragraphs you changed, each one whole, in this form:
<p n="NUMBER">the new text of that paragraph</p>
To fold a very short paragraph into the one before it, give the earlier paragraph with the joined text and the later one empty: <p n="NUMBER"></p>
If nothing needs changing, output <none/>. No notes and no commentary.`;

const multiset = (xs: string[]) => [...xs].sort().join('\u0001');
const quotes = (p: string) => [...(p.match(ITALIC) ?? []), ...(p.replace(ITALIC, ' ').replace(/<[^>]+>/g, '').match(QUOTE) ?? [])];
const tags = (p: string) => p.match(/<[^>]+>/g) ?? [];

// Whether a rewritten paragraph may take the place of the old one.
export function acceptable(old: string, next: string, first: boolean): boolean {
  if (next === old) return false;
  const ow = wordCount(plainText(old)), nw = wordCount(plainText(next));
  // Folded into the paragraph before: only a short line of narration, never the first.
  if (!next.trim()) return !first && ow <= 12 && !quotes(old).length && !tags(old).length;
  if (locked(next) || /\n{2,}/.test(next)) return false;
  if (multiset(quotes(old)) !== multiset(quotes(next))) return false;
  if (multiset(tags(old)) !== multiset(tags(next))) return false;
  return nw >= ow * 0.6 && nw <= ow * 1.6 + 30;
}

export function applyEdits(text: string, reply: string): { text: string; changed: number; refused: number } {
  const { parts, seps } = paragraphs(text);
  const edits = new Map<number, string>();
  for (const m of reply.matchAll(/<p n="(\d+)">([\s\S]*?)<\/p>/g)) edits.set(Number(m[1]), m[2].trim());
  let changed = 0, refused = 0;
  const next = [...parts];
  const taken = new Set<number>();
  for (const [n, t] of [...edits.entries()].sort((x, y) => x[0] - y[0])) {
    const i = n - 1;
    if (taken.has(i)) continue;
    // The short paragraphs after it that the editor folded into this one.
    const fold: number[] = [];
    while (t && edits.get(i + fold.length + 2) === '') fold.push(i + fold.length + 1);
    for (const j of fold) taken.add(j);
    const ok = !!t && i >= 0 && i < parts.length && !locked(parts[i]) && fold.every(j => j < parts.length && acceptable(parts[j], '', false))
      && acceptable([parts[i], ...fold.map(j => parts[j])].join(' '), t, i === 0) && (fold.length > 0 || acceptable(parts[i], t, i === 0));
    if (!ok) { refused += 1 + fold.length; continue; }
    next[i] = t;
    for (const j of fold) next[j] = '';
    changed += 1 + fold.length;
  }
  // Put back together with the breaks it had; a folded paragraph takes its break with it.
  let out = '';
  for (let i = 0; i < next.length; i++) {
    if (!next[i].trim() && parts[i].trim()) continue;
    out += (out && i > 0 ? seps[i - 1] ?? '\n\n' : '') + next[i];
  }
  return { text: out, changed, refused };
}

export async function runPolish(job: Job, story: R.Story, passage: R.Passage, conn: Conn): Promise<{ passage: R.Passage; usage: Usage }> {
  const flags = polishFlags(story, passage.text);
  if (!flags.length) return { passage, usage: zeroUsage() };
  emit(job, 'phase', { phase: 'polish', label: 'tidying the prose' });
  const { parts } = paragraphs(passage.text);
  const body = parts.map((p, i) => `[${i + 1}${locked(p) ? ' locked' : ''}]\n${p}`).join('\n\n');
  const r = await callModel({
    conn, system: [{ text: EDITOR }], signal: job.abort.signal, maxTokens: 20000,
    messages: [{ role: 'user', content: [{ type: 'text', text: `<problems>\n${flags.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n</problems>\n\n<passage>\n${body}\n</passage>` }] }],
  });
  // Cut off partway, the reply's last paragraph may be half of one: what came whole before it is still good.
  const reply = r.stopReason === 'max_tokens' ? r.text.slice(0, r.text.lastIndexOf('</p>') + 4) : r.text;
  const e = applyEdits(passage.text, reply);
  if (!e.changed) return { passage, usage: r.usage };
  R.setPassageText(passage.id, e.text, 'polish');
  const fresh = R.getPassage(passage.id)!;
  emit(job, 'passage', { passage: fresh });
  emit(job, 'notice', { message: `Polish pass: ${e.changed} paragraph${e.changed > 1 ? 's' : ''} tidied. The first version is kept in the passage's history.` });
  return { passage: fresh, usage: r.usage };
}
