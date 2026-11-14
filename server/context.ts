import { db } from './db.ts';
import { HOUR, type Block, type Msg, type SysPart } from './llm.ts';
import * as R from './records.ts';
import { craftRules } from './modes.ts';
import { forParty } from './rules_dnd.ts';
import { on, parseBanned, SLOP_PATTERNS } from './rules.ts';
import { cardText, colorsSpeech, ledgerText } from './tools.ts';
import { estTokens, normName } from './util.ts';

export const BUDGET = {
  verbatimTail: 12000,
  chapter: 40000,
  storySoFar: 25000,
  presentCards: 4000,
  cardIndex: 1000,
  ledger: 2000,
  threads: 1000,
  facts: 1500,
};

function takeWithin<T>(items: T[], budget: number, fmt: (t: T) => string): { lines: string[]; dropped: number } {
  const lines: string[] = [];
  let used = 0;
  for (const it of items) {
    const l = fmt(it);
    const t = estTokens(l);
    if (used + t > budget && lines.length) break;
    lines.push(l); used += t;
  }
  return { lines, dropped: items.length - lines.length };
}

// ---------------------------------------------------------------- layers 1-4 and 5 (system)

export function systemParts(story: R.Story): SysPart[] {
  const party = R.party(story.id);
  const names = party.map(p => p.name);
  const head = `You are the Dungeon Master of "${story.title}", a Dungeons & Dragons 5th Edition campaign played round by round in text with a table of ${party.length || 'several'} player${party.length === 1 ? '' : 's'}. Each player plays one character${names.length ? `: ${party.map(p => `${p.name} (played by ${p.player})`).join(', ')}` : ''}. Each round, every player says what their character does; you write it out, roll for it with the real dice, play the world and everyone in it, and stop where the party has to act again.`;
  const parts = [head, craftRules(story.settings)];
  const bible = forParty(story.bible.trim());
  parts.push(`<world>\n${bible || '(No world written yet. Take the setting from the story so far and the players\' actions, in the spirit of a classic D&D campaign.)'}\n</world>`);
  // Who the characters are stays here, where it is cached; their sheets change every round, so they ride in the continuity pack.
  const people = party.map(p => {
    const persona = R.getPersona(p.personaId);
    const about = forParty(persona?.description?.trim() ?? '');
    return `<character name="${p.name}" player="${p.player}">\n${about || '(No backstory written.)'}\n</character>`;
  });
  parts.push(`<party>\n${people.join('\n') || '(No characters at the table yet.)'}\n</party>`);
  return [{ text: parts.join('\n\n'), cache: '1h' }, { text: storySoFar(story), cache: '1h' }];
}

export function storySoFar(story: R.Story): string {
  const arcs = db.prepare('select * from arcs where story_id = ? order by first_chapter').all(story.id) as any[];
  const closed = db.prepare(`select * from chapters where story_id = ? and status = 'closed' order by number`).all(story.id) as R.Chapter[];
  const covered = (n: number) => arcs.some(a => n >= a.first_chapter && n <= a.last_chapter);
  const items: string[] = [];
  const unit = 'chapter';
  for (const a of arcs) items.push(`<arc chapters="${a.first_chapter}-${a.last_chapter}"${a.title ? ` title="${a.title}"` : ''}>\n${a.summary.trim()}\n</arc>`);
  const chs = closed.filter(c => !covered(c.number));
  // Newest chapter summaries matter most; drop the oldest uncovered ones if over budget (they stay reachable by tool).
  const kept: string[] = [];
  let used = items.reduce((n, x) => n + estTokens(x), 0);
  for (const c of [...chs].reverse()) {
    const t = `<${unit}_summary number="${c.number}"${c.title ? ` title="${c.title.replace(/"/g, "'")}"` : ''}>\n${(c.summary || '(no summary)').trim()}\n</${unit}_summary>`;
    if (used + estTokens(t) > BUDGET.storySoFar && kept.length) break;
    kept.unshift(t); used += estTokens(t);
  }
  const omitted = chs.length - kept.length;
  const body = [...items, ...(omitted ? [`(${omitted} older chapter summaries omitted; use get_chapter_summary.)`] : []), ...kept].join('\n\n');
  return `<story_so_far>\n${body || 'This is the beginning of the campaign. Nothing has happened yet.'}\n</story_so_far>`;
}

// ---------------------------------------------------------------- layer 7: the current chapter

type ChapterOpts = { uptoSeq?: number; excludeIds?: number[] };

export function chapterLayout(storyId: number, chapter: R.Chapter, opts: ChapterOpts = {}) {
  let ps = R.chapterPassages(chapter.id).filter(p => ['prose', 'direction', 'run', 'persona_switch', 'note'].includes(p.kind));
  if (opts.uptoSeq != null) ps = ps.filter(p => p.seq < opts.uptoSeq!);
  if (opts.excludeIds) ps = ps.filter(p => !opts.excludeIds!.includes(p.id));
  const tokens = ps.map(p => estTokens(p.text));
  const total = tokens.reduce((a, b) => a + b, 0);
  // Whole chapters are long: the budgets leave the last few of them word for word.
  const long = false;
  const tailBudget = long ? BUDGET.verbatimTail * 2 : BUDGET.verbatimTail, chapterBudget = long ? BUDGET.chapter * 1.5 : BUDGET.chapter;
  // Latest stretch always verbatim: at least the tail budget, and up to twice that. Where it starts moves on in steps of
  // one budget instead of with every passage, so the prompt opens the same way for several turns running and its cache
  // holds (a start that slid every turn changed everything after it, and had one more scene summarized, every turn).
  const from = Math.max(0, (Math.floor(total / tailBudget) - 1) * tailBudget);
  let tailStart = 0, before = 0;
  while (tailStart < ps.length - 1 && before + tokens[tailStart] <= from) { before += tokens[tailStart]; tailStart++; }
  const verbatim = new Set<number>();
  const needSummary: { sceneId: number; passages: R.Passage[] }[] = [];
  if (total <= chapterBudget) ps.forEach(p => verbatim.add(p.id));
  else {
    ps.slice(tailStart).forEach(p => verbatim.add(p.id));
    // Older passages: group by scene; scenes without a current summary stay verbatim while they fit.
    const older = ps.slice(0, tailStart);
    const groups = new Map<number, R.Passage[]>();
    for (const p of older) { const k = p.scene_id ?? -p.id; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(p); }
    for (const [k, g] of groups) {
      const sc: any = k > 0 ? db.prepare('select * from scenes where id = ?').get(k) : null;
      const lastId = Math.max(...g.map(p => p.id));
      if (!(sc?.summary && (sc.summary_upto ?? 0) >= lastId)) {
        if (k > 0) needSummary.push({ sceneId: k, passages: g });
        g.forEach(p => verbatim.add(p.id));
      }
    }
  }
  return { passages: ps, verbatim, needSummary, total };
}

// The chapter in order: the previous chapter's ending while this one is young, summaries of older scenes,
// scene tags, directions and notes as text, and each verbatim passage with its row.
type Item = { text: string; prose?: R.Passage; summary?: boolean };

function chapterItems(story: R.Story, chapter: R.Chapter, opts: ChapterOpts): Item[] {
  const { passages, verbatim } = chapterLayout(story.id, chapter, opts);
  const items: Item[] = [];
  const proseCount = passages.filter(p => p.kind === 'prose').length;
  if (proseCount < 3 && chapter.number > 1) {
    const prev = db.prepare(`select * from chapters where story_id = ? and number = ?`).get(story.id, chapter.number - 1) as R.Chapter | undefined;
    if (prev) {
      const tail = (db.prepare(`select * from passages where chapter_id = ? and kind = 'prose' order by seq desc limit 2`).all(prev.id) as R.Passage[]).reverse();
      if (tail.length) items.push({ text: `<previous_chapter_ending number="${prev.number}">\n${tail.map(p => p.text).join('\n\n')}\n</previous_chapter_ending>` });
    }
  }
  let lastScene: number | null | undefined = undefined;
  const sceneRow = (id: number) => db.prepare('select * from scenes where id = ?').get(id) as any;
  const summarizedDone = new Set<number>();
  for (const p of passages) {
    if (!verbatim.has(p.id)) {
      if (p.scene_id && !summarizedDone.has(p.scene_id)) {
        const sc = sceneRow(p.scene_id);
        summarizedDone.add(p.scene_id);
        items.push({ text: `<earlier_scene place="${sc?.place ?? ''}" time="${sc?.story_time ?? ''}">\n${sc?.summary ?? ''}\n</earlier_scene>`, summary: true });
      }
      continue;
    }
    if (p.kind === 'prose' && p.scene_id && p.scene_id !== lastScene) {
      const sc = sceneRow(p.scene_id);
      // A passage with its own scene lines already says where it is.
      if (sc && (sc.place || sc.story_time) && !p.text.includes('<scene>')) items.push({ text: `<scene place="${sc.place}" time="${sc.story_time}"${sc.weather ? ` weather="${sc.weather}"` : ''}/>` });
      lastScene = p.scene_id;
    }
    if (p.kind === 'prose') items.push({ text: `<passage id="${p.id}">\n${p.text}\n</passage>`, prose: p });
    else if (p.kind === 'direction' || p.kind === 'run') items.push({ text: `<direction>${p.text}</direction>` });
    else if (p.kind === 'persona_switch' || p.kind === 'note') items.push({ text: `<note>${p.text}</note>` });
  }
  return items;
}

// A scene written ahead and not played yet becomes other text once it is played (the choices made in it), so the cache
// ends on the last passage before it: an entry that ended on the unplayed one would never be found again.
const isSettled = (p: R.Passage) => p.records_status !== 'unplayed';

const chapterTag = (chapter: R.Chapter) => `<current_chapter number="${chapter.number}"${chapter.title ? ` title="${chapter.title.replace(/"/g, "'")}"` : ''}>`;
export const NO_DIRECTION = 'No direction this turn: write the next passage, continuing from where the story stands.';

export function chapterBlocks(story: R.Story, chapter: R.Chapter, opts: ChapterOpts = {}): Block[] {
  const items = chapterItems(story, chapter, opts);
  const [before, rest] = [items.filter(i => i.text.startsWith('<previous_chapter_ending')), items.filter(i => !i.text.startsWith('<previous_chapter_ending'))];
  const blocks: Item[] = [...before, { text: chapterTag(chapter) }, ...rest];
  if (!items.some(i => i.prose)) blocks.push({ text: '(No passages yet in this chapter.)' });
  blocks.push({ text: `</current_chapter>` });
  // Small pieces (headers, scene tags, directions) ride along at the front of the next passage's block, and each passage
  // ends its own block. Block boundaries then stay identical from turn to turn, so the cache entry written at the
  // last passage this turn is found again next turn.
  const merged: Block[] = [];
  let pending = '', settled = -1;
  for (const b of blocks) {
    if (b.prose || b.summary) {
      merged.push({ type: 'text', text: pending ? `${pending}\n${b.text}` : b.text }); pending = '';
      if (!b.prose || isSettled(b.prose)) settled = merged.length - 1;
    }
    else pending = pending ? `${pending}\n${b.text}` : b.text;
  }
  if (pending) merged.push({ type: 'text', text: pending });
  if (settled >= 0) merged[settled].cache_control = HOUR;
  return merged;
}

// The writer's messages: the chapter, then this turn's material (`final`) in the last user message.
// History "chat" lays the chapter out the way SillyTavern does: each direction as a user turn and each passage as the
// narrator's own earlier reply, so the model continues its own writing instead of reading it back as a document.
export function chapterMessages(story: R.Story, chapter: R.Chapter, opts: ChapterOpts, final: Block[]): Msg[] {
  const book = false;
  if (story.settings.history !== 'chat' && !book) return [{ role: 'user', content: [...chapterBlocks(story, chapter, opts), ...final] }];
  const msgs: Msg[] = [];
  let pending: string[] = [book
    ? `<current_part number="${chapter.number}">This part of the book so far is the conversation below: each direction, then the chapter you wrote for it. Chapter numbers run through the whole book.</current_part>`
    : `${chapterTag(chapter)}The chapter so far is the conversation below: each direction, then the passage you wrote for it.</current_chapter>`];
  let settled = -1;
  for (const it of chapterItems(story, chapter, opts)) {
    if (!it.prose) { pending.push(it.text); continue; }
    if (!pending.some(t => t.startsWith('<direction'))) pending.push(`<direction>${book ? 'No direction this turn: write the next chapter, continuing from where the story stands.' : NO_DIRECTION}</direction>`);
    msgs.push({ role: 'user', content: [{ type: 'text', text: pending.join('\n\n') }] });
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: it.prose.text }] });
    if (isSettled(it.prose)) settled = msgs.length - 1;
    pending = [];
  }
  // The newest settled passage ends the part that stays the same next turn.
  if (settled >= 0) msgs[settled].content[0].cache_control = HOUR;
  msgs.push({ role: 'user', content: [...(pending.length ? [{ type: 'text', text: pending.join('\n\n') }] : []), ...final] });
  return msgs;
}

// ---------------------------------------------------------------- layer 6: continuity pack

function mentioned(storyId: number, text: string) {
  const lower = text.toLowerCase();
  return R.listCards(storyId).filter(c => [c.name, ...c.aliases].some((n: string) => {
    const first = n.split(/\s+/)[0];
    return lower.includes(n.toLowerCase()) || (first.length > 2 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').toLowerCase()}\\b`).test(lower));
  }));
}

export function recentBeats(storyId: number) {
  const rows = (db.prepare(`select p.beat from passages p join chapters c on c.id = p.chapter_id where p.story_id = ? and p.kind = 'prose' order by c.number desc, p.seq desc limit 6`).all(storyId) as any[]).map(r => r.beat || '?').reverse();
  return rows;
}

// Phrases repeated across recent passages, plus Anti-Slop hits: fed back so the writer varies them.
const STOP = new Set('the a an and or but of to in on at for with from by as is was were be been it its he she they them his her their i you we me my your our that this then than so not no just like into out up down over back what who all had has have did do does said says would could will can there here when while if one'.split(' '));
export function overusedPhrases(storyId: number): string[] {
  const texts = (db.prepare(`select p.text from passages p join chapters c on c.id = p.chapter_id where p.story_id = ? and p.kind = 'prose' order by c.number desc, p.seq desc limit 6`).all(storyId) as any[]).map(r => r.text as string);
  if (texts.length < 3) return [];
  const seen = new Map<string, number>();
  for (const t of texts) {
    const words = t.toLowerCase().replace(/<scene>[^<]*<\/scene>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/[^a-z'\s-]/g, ' ').split(/\s+/).filter(Boolean);
    const grams = new Set<string>();
    for (let i = 0; i + 4 <= words.length; i++) {
      const g = words.slice(i, i + 4);
      if (g.filter(w => !STOP.has(w)).length < 2) continue;
      grams.add(g.join(' '));
    }
    for (const g of grams) seen.set(g, (seen.get(g) ?? 0) + 1);
  }
  const reps = [...seen.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).map(([g]) => g);
  // Drop grams contained in a longer kept gram.
  const out: string[] = [];
  for (const g of reps) if (!out.some(o => o.includes(g) || g.includes(o))) out.push(g);
  const slop: string[] = [];
  for (const [label, re] of SLOP_PATTERNS) {
    const n = texts.reduce((acc, t) => acc + (t.match(re)?.length ?? 0), 0);
    if (n >= 2) slop.push(label);
  }
  return [...out.slice(0, 8).map(g => `"${g}"`), ...slop.map(s => `${s} (stock phrase)`)];
}

// What a long story drifts into, measured: clipped sentences, sentences that open on "it", the same beat again and again,
// cast members who have gone quiet, and a mood that has left the one the story opened with. Each line is fed back to the writer.
export const BEATS: [string, RegExp][] = [
  ['"Nobody spoke" / "Nobody said anything"', /\bNobody\b/g],
  ['a pause before an answer ("A pause.", "at last", "after a while", "for a moment")', /\bA pause\b|\bat last\b|\bafter a while\b|\bfor a (?:long )?moment\b|\bfor a long time\b/g],
  ['someone not answering ("said nothing", "didn\'t answer")', /\bsaid nothing\b|\bdid(?:n't| not) answer\b|\bdid(?:n't| not) say anything\b/g],
  ['a thing told by what it is not ("It was not X. It was Y.")', /\b(?:It|He|She|That|This) (?:was not|wasn't|did not|didn't|had not|hadn't)\b[^.!?\n]{0,60}[.]\s+(?:It|He|She|That|This) (?:was|did|had)\b/g],
];
export const plainText = (t: string) => t.replace(/<scene>[^<]*<\/scene>/g, ' ').replace(/<chaphead>[^<]*<\/chaphead>/g, ' ').replace(/<[^>]+>/g, ' ');
export const wordCount = (t: string) => (t.match(/\S+/g) ?? []).length;
export function readingCheck(storyId: number, tone = 'source'): string[] {
  const texts = (db.prepare(`select p.text from passages p join chapters c on c.id = p.chapter_id where p.story_id = ? and p.kind = 'prose' and p.records_status != 'unplayed' order by c.number, p.seq`).all(storyId) as any[]).map(r => plainText(r.text as string));
  // Recent: the last passages, back to about two chapters' worth. Opening: the same amount from the start.
  const SPAN = 9000;
  let from = texts.length, got = 0;
  while (from > 0 && got < SPAN) { from--; got += wordCount(texts[from]); }
  const recent = texts.slice(from).join('\n\n');
  const rw = wordCount(recent);
  if (rw < 2500) return [];
  const out: string[] = [];

  // A sentence with speech in it is left out: its "she said" is not a clipped sentence.
  const narration = recent.replace(/["\u201c][^"\u201d\n]*["\u201d]/g, ' @@ ');
  const sents = narration.split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(x => /[a-z]/i.test(x) && !x.includes('@@'));
  if (sents.length >= 80) {
    const short = sents.filter(x => wordCount(x) <= 4).length / sents.length;
    if (short >= 0.2) out.push(`About ${Math.round(short * 10)} in every 10 sentences of narration lately were four words or fewer. Join them into fuller sentences; keep a short one for a joke or a shock.`);
    const vague = sents.filter(x => /^(?:It|That|This)\b/.test(x)).length / sents.length;
    if (vague >= 0.09) out.push(`About 1 sentence in ${Math.round(1 / vague)} of narration opens with "It", "That" or "This". Name the thing instead.`);
  }
  const beats = BEATS.map(([label, re]) => [label, (recent.match(re) ?? []).length] as const).filter(([, n]) => n / rw >= 4 / 5000);
  if (beats.length) out.push(`Beats used again and again lately: ${beats.map(([l, n]) => `${l}, ${n} times`).join('; ')}. Drop them or find another way.`);

  // The rest compares the recent text with what came before it.
  const early = texts.slice(0, from).join('\n\n');
  const ew = wordCount(early);
  if (ew < 2500) return out;
  const count = (text: string, c: any) => {
    const names = [...new Set([c.name, ...c.aliases].flatMap((n: string) => n.split(/\s+/)).filter((n: string) => n && n.length > 2))] as string[];
    return names.reduce((acc, n) => acc + (text.match(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) ?? []).length, 0);
  };
  const faded = R.listCards(storyId).filter(c => { const e = count(early, c) / ew, r = count(recent, c) / rw; return e >= 2 / 1000 && r < e * 0.5; }).map(c => c.name);
  if (faded.length) out.push(`${faded.join(', ')} had a large part of the story earlier and little of the page lately. If they are still in the story, they speak and act again.`);

  let open = '', ow = 0;
  for (const t of texts.slice(0, from)) { if (ow >= SPAN) break; open += `\n\n${t}`; ow += wordCount(t); }
  // Names giving way to "the captain", "the red-haired man": the cast is named less and less, though no less present.
  const cards = R.listCards(storyId);
  const named = (t: string) => cards.reduce((acc, c) => acc + count(t, c), 0);
  const namedThen = named(open) / ow * 1000, namedNow = named(recent) / rw * 1000;
  if (namedThen >= 10 && namedNow < namedThen * 0.6) out.push(`The cast were called by name about ${Math.round(namedThen)} times in every 1,000 words at the start and ${Math.round(namedNow)} lately: titles and descriptions ("the captain", "the red-haired man") have taken the names' place. Use each person's name.`);
  const loud = (t: string) => (t.match(/!/g) ?? []).length;
  const then = loud(open) / ow * 1000, now = loud(recent) / rw * 1000;
  // A story set to a heavy tone is meant to be quieter than a lively opening.
  if (!['drama', 'suspense', 'dark'].includes(tone) && then >= 3 && now < then * 0.5) out.push(`The story opened louder and lighter than it reads now: about ${Math.round(then)} exclaimed lines in every 1,000 words then, ${Math.round(now)} lately. If the story's tone is still the one it opened with, that energy comes back; if the author or the story's events turned it, leave it.`);
  return out;
}

export function buildPack(story: R.Story, mode: 'writer' | 'records' | 'check', extraText = ''): string {
  const s = story.settings;
  const scene = R.getSceneState(story.id);
  const out: string[] = [];
  const presentNames = scene.present.map(p => p.name);
  const who = (p: R.Present) => `${p.name}${p.doing ? ` (${p.doing})` : ''}${p.condition && !/^(unhurt|alive|fine|healthy)$/i.test(p.condition) ? ` [${p.condition}]` : ''}`;
  const party = R.party(story.id);

  out.push(`<scene_state>\nPlace: ${scene.place || '(not set yet)'}\nDate and time: ${scene.story_time || '(not set yet)'}\nWeather: ${scene.weather || '-'}${scene.initiative ? `\nInitiative (a fight is on): ${scene.initiative}` : ''}\nPresent besides the party: ${scene.present.length ? scene.present.map(who).join('; ') : 'nobody recorded'}\n</scene_state>`);

  if (mode !== 'records') {
    const beats = recentBeats(story.id);
    if (beats.length) {
      const talky = beats.slice(-3).filter(b => b === 'talk' || b === 'quiet').length;
      out.push(`<recent_beats>Oldest to newest: ${beats.join(', ')}${talky >= 3 ? `. The last three passages were all talk or downtime.` : ''}</recent_beats>`);
    }
  }

  // Every character's sheet, every round: the writer and the checker need them all.
  const sheets = party.map(p => `<sheet name="${p.name}" player="${p.player}"${p.status === 'away' ? ' away="true"' : ''}>\n${p.card ? cardText(p.card, s) : '(no sheet yet)'}\n</sheet>`);
  out.push(`<character_sheets>\n${sheets.join('\n') || '(No characters at the table yet.)'}\n</character_sheets>`);

  // Cards: full for present and mentioned people, an index line for everyone else.
  if (on(s, 'npc_cards')) {
    const all = R.listCards(story.id);
    const full = new Map<number, any>();
    for (const n of presentNames) { const c = R.findCard(story.id, n); if (c) full.set(c.id, c); }
    for (const c of mentioned(story.id, extraText)) full.set(c.id, c);
    const fullList = [...full.values()];
    const fc = takeWithin(fullList, mode === 'records' ? BUDGET.presentCards * 1.5 : BUDGET.presentCards, c => cardText(c, s));
    if (fc.lines.length) out.push(`<cards_present>\n${fc.lines.join('\n')}\n</cards_present>`);
    const others = all.filter(c => !fc.lines.length || !fullList.slice(0, fc.lines.length).some(f => f.id === c.id))
      .sort((a, b) => (b.last_seen_passage ?? 0) - (a.last_seen_passage ?? 0));
    const idx = takeWithin(others, mode === 'records' ? BUDGET.cardIndex * 2 : BUDGET.cardIndex, c => `${c.name}${c.aliases.length ? ` (${c.aliases.join(', ')})` : ''}: ${c.fields.role_age || ''}`);
    if (idx.lines.length) out.push(`<card_index note="other people with cards; fetch with get_card">\n${idx.lines.join('\n')}${idx.dropped ? `\n(+${idx.dropped} more)` : ''}\n</card_index>`);
  }
  // The colors already given to people's spoken lines: the writer keeps them, the records keeper adds the new ones.
  if (mode !== 'check' && colorsSpeech(s)) {
    const cols = [...party.filter(p => p.card?.color).map(p => `${p.name} ${p.card.color}`), ...R.listCards(story.id).filter(c => c.color).map(c => `${c.name} ${c.color}`)];
    if (cols.length || mode === 'records') out.push(`<dialogue_colors note="the saved color of each person's spoken lines">${cols.join(', ') || 'None saved yet.'}</dialogue_colors>`);
  }

  if (on(s, 'knowledge_ledger')) {
    const rows = R.listLedger(story.id, 'open');
    const pn = new Set([...presentNames, ...party.map(p => p.name)].map(normName));
    const involves = (r: R.LedgerRow) => [...r.known_by, ...r.not_known_by.map(x => x.name)].some(n => pn.has(normName(n)));
    const chosen = mode === 'writer' && pn.size ? [...rows.filter(involves), ...rows.filter(r => !involves(r))] : rows;
    const lt = takeWithin(chosen, mode === 'writer' ? BUDGET.ledger : BUDGET.ledger * 2, ledgerText);
    out.push(`<knowledge_ledger>\n${lt.lines.join('\n') || 'Nothing recorded yet.'}${lt.dropped ? `\n(+${lt.dropped} rows not shown; use check_ledger)` : ''}\n</knowledge_ledger>`);
  }

  const threads = R.listThreads(story.id, 'open').sort((a, b) => (b.last_touched_passage ?? 0) - (a.last_touched_passage ?? 0));
  const tt = takeWithin(threads, BUDGET.threads, (t: any) => `#${t.id} ${t.text}`);
  if (tt.lines.length) out.push(`<open_threads>\n${tt.lines.join('\n')}${tt.dropped ? `\n(+${tt.dropped} older threads)` : ''}\n</open_threads>`);

  const facts = R.listFacts(story.id);
  if (facts.length) {
    const keys = [...presentNames, scene.place, ...party.map(p => p.name), ...mentioned(story.id, extraText).map(c => c.name)].filter(Boolean).map(x => x.toLowerCase());
    const rel = facts.filter(f => f.about.some(a => keys.some(k => k.includes(a.toLowerCase()) || a.toLowerCase().includes(k))));
    const recent = facts.slice(-10);
    const pick = [...new Map([...rel, ...recent].map(f => [f.id, f])).values()];
    const ft = takeWithin(pick.reverse(), mode === 'writer' ? BUDGET.facts : BUDGET.facts * 2, f => `#${f.id} ${f.text}${f.status === 'conflict' ? ' (DISPUTED, the host has not decided)' : ''}`);
    out.push(`<story_facts>\n${ft.lines.join('\n')}${facts.length > ft.lines.length ? `\n(${facts.length - ft.lines.length} more facts; use get_facts)` : ''}\n</story_facts>`);
  }

  if (mode === 'writer' && s.prose_lint) {
    const rc = readingCheck(story.id, s.tone);
    if (rc.length) out.push(`<reading_check>Measured from the campaign's own text, opening against recent. Each point is something to correct in what you write next:\n${rc.map(x => `- ${x}`).join('\n')}</reading_check>`);
    const ov = overusedPhrases(story.id);
    if (ov.length) out.push(`<overused_phrases>These already appear in several recent passages. Don't reuse them; find a fresh way or skip the beat: ${ov.join(', ')}</overused_phrases>`);
  }
  const banned = mode === 'writer' ? parseBanned(s.banned_phrases) : [];
  if (banned.length) out.push(`<banned_phrases>Never use these words or phrases: ${banned.join(', ')}</banned_phrases>`);
  return `<continuity_pack>\n${out.join('\n\n')}\n</continuity_pack>`;
}
