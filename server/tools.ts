import { db } from './db.ts';
import type { ToolDef } from './llm.ts';
import * as R from './records.ts';
import { modeOf, SHEET, type CardKind, type FieldDef } from './modes.ts';
import { on, type StorySettings } from './rules.ts';
import { clip, normName, parseJson } from './util.ts';

// ---------------------------------------------------------------- definitions

const str = (description: string) => ({ type: 'string', description });

export function readTools(st: StorySettings): ToolDef[] {
  const cardWhat = "Get the campaign's card for a person (role and age, appearance, backstory, relationship with the party, voice), or a player's character's sheet, or an earlier version of either. Returns 'no card' if there is none.";
  return [
  { name: 'search_story', description: 'Full-text search over every passage written so far in this story (names, exact phrases, keywords). Returns up to 8 excerpts with passage ids and chapter numbers. Use it before referring to anything from earlier in the story that is not in front of you. No results means it never happened on the page.',
    input_schema: { type: 'object', properties: { query: str('Words or names to search for. Short and specific works best.'), from_chapter: { type: 'integer' }, to_chapter: { type: 'integer' } }, required: ['query'] } },
  { name: 'read_passage', description: 'Read the exact text of a passage by id, optionally with neighbouring passages.',
    input_schema: { type: 'object', properties: { passage_id: { type: 'integer' }, neighbours: { type: 'integer', description: '0 to 2 passages on each side' } }, required: ['passage_id'] } },
  { name: 'get_chapter_summary', description: 'Get the stored summaries of earlier chapters.',
    input_schema: { type: 'object', properties: { from_chapter: { type: 'integer' }, to_chapter: { type: 'integer' } }, required: ['from_chapter'] } },
  { name: 'get_card', description: cardWhat,
    input_schema: { type: 'object', properties: { name: str('Character name'), version: { type: 'integer', description: 'Optional: 1 = first version' } }, required: ['name'] } },
  { name: 'check_ledger', description: 'Look up knowledge-ledger rows: facts not everyone knows, who knows them, who does not, and suspicion steps. Filter by character and/or keyword.',
    input_schema: { type: 'object', properties: { character: str('Character name'), keyword: str('Word in the fact') } } },
  { name: 'get_facts', description: 'Look up established story facts (each with its source passage) about a character, place, item or keyword.',
    input_schema: { type: 'object', properties: { query: str('Character, place, item or keyword') }, required: ['query'] } },
  ].filter(t => t.name !== 'check_ledger' || on(st, 'knowledge_ledger'));
}

const pid = { type: 'integer', description: 'Id of the passage this change comes from' };

const fieldProps = (defs: FieldDef[]) => Object.fromEntries(defs.map(d => [d.key, str(d.desc)]));
const keysOf = (defs: FieldDef[]) => defs.map(d => d.key);

// Modes whose passages are prose with colored speech. The visual novel modes name the speaker instead.
export const colorsSpeech = (s: StorySettings) => on(s, 'colored_dialogue');

export function writeTools(s: StorySettings): ToolDef[] {
  const m = modeOf(s);
  const scene = {
    place: str('Where the passage ends up'), story_time: str("Weekday (or the setting's calendar), date, time of day"), weather: str('Weather or indoor conditions'),
    initiative: str('During a fight: the initiative order with totals, like "Khel 21, Goblins 15, Lizzie 12". Empty when no fight is on'),
    present: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, doing: { type: 'string' }, condition: str('Condition; for a foe in a fight, its AC and HP like "AC 15, HP 3/7, bloodied"') }, required: ['name'] }, description: "Everyone present at the end of the passage besides the players' characters" },
  };
  const t: ToolDef[] = [
    { name: 'set_scene', description: 'Record the scene state at the end of a passage. Call exactly once per new passage.',
      input_schema: { type: 'object', properties: { passage_id: pid, ...scene, new_scene: { type: 'boolean' }, beat: { type: 'string', enum: m.beats } },
        required: ['passage_id', 'place', 'story_time', 'present', 'new_scene', 'beat'] } },
  ];
  const npc = m.cards.npc;
  if (on(s, 'npc_cards')) t.push(
    { name: 'create_card', description: "Create a person's card on their first appearance. Never for a player's character.",
      input_schema: { type: 'object', properties: { passage_id: pid, ...fieldProps(npc), aliases: { type: 'array', items: { type: 'string' }, description: 'Other names, nicknames, titles' } },
        required: ['passage_id', ...keysOf(npc)] } },
    { name: 'update_card', description: 'Post the whole updated card after a lasting change. Copy unchanged fields.',
      input_schema: { type: 'object', properties: { passage_id: pid, ...fieldProps(npc), what_changed: str('Short note of what changed') },
        required: ['passage_id', ...keysOf(npc), 'what_changed'] } },
  );
  t.push(
    { name: 'update_sheet', description: "Update one player's character's sheet. Send the character's name, only the fields that changed (each written whole), and what changed. Fields left out stay as they are.",
      input_schema: { type: 'object', properties: { passage_id: pid, name: str("The character's name, as the sheet has it"), ...fieldProps(PLAY_FIELDS), story_change: str('Only for a change the story itself made to a field this tool does not list (a magic item that sets an ability score, a curse): the field name and its new text, like "abilities: STR 19 (+4), DEX 12 (+1), ..."'), what_changed: str('Short note of what changed') },
        required: ['passage_id', 'name', 'what_changed'] } },
  );
  if (on(s, 'knowledge_ledger')) t.push(
    { name: 'update_ledger', description: 'Add a knowledge-ledger row, or change one (pass its id) when someone learns the fact or a suspicion step really happened.',
      input_schema: { type: 'object', properties: { passage_id: pid, id: { type: 'integer', description: 'Existing row id to change' }, fact: { type: 'string' },
        known_by: { type: 'array', items: { type: 'string' } },
        not_known_by: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, step: { type: 'string', enum: ['unaware', 'noticed, explained away', 'uneasy', 'suspects'] } }, required: ['name', 'step'] } },
        how: str('How someone learned it or why a step moved'), status: { type: 'string', enum: ['open', 'common'] } },
        required: ['passage_id', 'fact', 'known_by', 'not_known_by'] } },
  );
  t.push(
    { name: 'record_fact', description: 'Record a concrete story fact established on the page.',
      input_schema: { type: 'object', properties: { passage_id: pid, text: str('One short sentence'), about: { type: 'array', items: { type: 'string' }, description: 'People, places, items involved' },
        kind: { type: 'string', enum: ['new', 'change', 'conflict'] }, replaces_fact_id: { type: 'integer' } }, required: ['passage_id', 'text', 'about', 'kind'] } },
    { name: 'set_thread', description: 'Open, move, pay off or drop a plot thread.',
      input_schema: { type: 'object', properties: { passage_id: pid, action: { type: 'string', enum: ['open', 'touch', 'pay_off', 'drop'] }, text: str('One line'), thread_id: { type: 'integer' } }, required: ['passage_id', 'action', 'text'] } },
  );
  if (colorsSpeech(s)) t.push(
    { name: 'set_dialogue_colors', description: "Save the color a person's spoken lines are written in (the <font color> around their quotes). Call it once for a passage when someone with a card or a sheet speaks in a color and <dialogue_colors> does not list them yet. Leave out anyone already listed.",
      input_schema: { type: 'object', properties: { passage_id: pid, colors: { type: 'array', items: { type: 'object', properties: { name: str('Name, as on their card or sheet'), color: str('The hex color from the passage, like #C8C8FF') }, required: ['name', 'color'] } } }, required: ['passage_id', 'colors'] } },
  );
  return t;
}

// The sheet fields play changes. The rest (class, level, abilities, features, spells known...) change by levelling up in the app.
const BUILD_ONLY = ['species', 'class', 'background', 'level', 'abilities', 'proficiency', 'saves', 'skills', 'proficiencies', 'spellcasting', 'spells', 'features'];
export const PLAY_FIELDS = SHEET.filter(d => !BUILD_ONLY.includes(d.key));

// ---------------------------------------------------------------- handlers

export type ToolCtx = {
  storyId: number; settings: StorySettings;
  turnId: number | null; passageIds: number[]; chapterId: number;
};

// One-line card text for the model, in the field order of the story's mode.
export function cardText(c: any, st?: StorySettings): string {
  const m = modeOf(st);
  const kind = (c.kind ?? 'npc') as CardKind;
  const defs = m.cards[kind] ?? m.cards.npc;
  const f = c.fields || {};
  const aka = Array.isArray(c.aliases) && c.aliases.length ? ` (also: ${c.aliases.join(', ')})` : '';
  const label = (d: FieldDef) => d.label.toLowerCase();
  return `${f.name || c.name}${aka} | ${defs.filter(d => d.key !== 'name').map(d => `${label(d)}: ${f[d.key] || '-'}`).join(' | ')}`;
}

export function ledgerText(r: R.LedgerRow) {
  const nk = r.not_known_by.map(x => `${x.name}${x.step && x.step !== 'unaware' ? ` (${x.step})` : ''}`).join(', ');
  return `#${r.id} ${r.fact} | known by: ${r.known_by.join(', ') || '-'} | not known by: ${nk || '-'}${r.status !== 'open' ? ` [${r.status}]` : ''}`;
}

function ftsQuery(q: string, mode: 'and' | 'or') {
  const words = q.replace(/["*^():{}\[\]]/g, ' ').split(/\s+/).filter(w => w.length > 1).slice(0, 12);
  if (!words.length) return '';
  return words.map(w => `"${w}"`).join(mode === 'and' ? ' ' : ' OR ');
}

function excerpt(text: string, q: string, width = 1400) {
  const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of words) { const i = lower.indexOf(w.replace(/s$/, '')); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (text.length <= width) return text;
  const start = Math.max(0, (at < 0 ? 0 : at) - width / 3);
  return (start > 0 ? '…' : '') + text.slice(start, start + width) + (start + width < text.length ? '…' : '');
}

export function searchStory(storyId: number, query: string, from?: number, to?: number) {
  const run = (mode: 'and' | 'or') => {
    const fq = ftsQuery(query, mode);
    if (!fq) return [];
    return db.prepare(`select p.id, p.text, c.number chapter from passages_fts f join passages p on p.id = f.rowid join chapters c on c.id = p.chapter_id
      where passages_fts match ? and p.story_id = ? and p.kind = 'prose' and c.number >= ? and c.number <= ? order by bm25(passages_fts) limit 8`)
      .all(fq, storyId, from ?? 0, to ?? 1e9) as any[];
  };
  let rows: any[] = [];
  try { rows = run('and'); if (!rows.length) rows = run('or'); } catch { rows = []; }
  return rows;
}

function readHandlers(ctx: ToolCtx): Record<string, (a: any) => string> {
  return {
    search_story: a => {
      const rows = searchStory(ctx.storyId, String(a.query || ''), a.from_chapter, a.to_chapter);
      if (!rows.length) return `No passage matches "${a.query}". It has not happened on the page.`;
      return rows.map(r => `[passage ${r.id}, chapter ${r.chapter}]\n${excerpt(r.text, String(a.query))}`).join('\n\n---\n\n');
    },
    read_passage: a => {
      const p = R.getPassage(Number(a.passage_id));
      if (!p || p.story_id !== ctx.storyId) return 'No such passage.';
      const n = Math.max(0, Math.min(2, Number(a.neighbours) || 0));
      const rows = db.prepare(`select * from passages where chapter_id = ? and seq between ? and ? and kind in ('prose','direction') order by seq`).all(p.chapter_id, p.seq - n, p.seq + n) as R.Passage[];
      const ch = R.getChapter(p.chapter_id);
      return rows.map(r => r.kind === 'direction' ? `[direction] ${r.text}` : `[passage ${r.id}, chapter ${ch?.number}]\n${r.text}`).join('\n\n');
    },
    get_chapter_summary: a => {
      const from = Number(a.from_chapter) || 1, to = Number(a.to_chapter) || from;
      const rows = db.prepare(`select number, title, summary, status from chapters where story_id = ? and number between ? and ? order by number`).all(ctx.storyId, from, Math.min(to, from + 9)) as any[];
      if (!rows.length) return 'No such chapters.';
      return rows.map(r => r.summary ? r.summary : `Chapter ${r.number}${r.title ? `: ${r.title}` : ''}: ${r.status === 'open' ? '(the current chapter, not summarized yet)' : '(no summary)'}`).join('\n\n');
    },
    get_card: a => {
      const c = R.findCard(ctx.storyId, String(a.name || ''));
      if (!c) {
        const m = R.memberByName(ctx.storyId, String(a.name || ''));
        if (m) return m.card ? `${cardText(m.card, ctx.settings)}\n(player: ${m.player})` : `${m.name} has no sheet yet.`;
        return `No card for "${a.name}".`;
      }
      const versions = R.cardVersions(c.id);
      if (a.version) {
        const v = versions[Number(a.version) - 1];
        return v ? `${cardText({ ...c, fields: v.fields }, ctx.settings)}\n(version ${a.version} of ${versions.length}: ${v.what_changed})` : `Card has ${versions.length} versions.`;
      }
      const hist = versions.length > 1 ? `\nHistory: ${versions.map((v, i) => `v${i + 1} ${v.what_changed}`).join('; ')}` : '';
      return cardText(c, ctx.settings) + hist;
    },
    check_ledger: a => {
      const ch = a.character ? normName(String(a.character)) : '';
      const kw = a.keyword ? String(a.keyword).toLowerCase() : '';
      const rows = R.listLedger(ctx.storyId).filter(r => r.status !== 'retired').filter(r =>
        (!ch || [...r.known_by, ...r.not_known_by.map(x => x.name)].some(n => normName(n).includes(ch) || ch.includes(normName(n))))
        && (!kw || r.fact.toLowerCase().includes(kw)));
      return rows.length ? rows.slice(0, 30).map(ledgerText).join('\n') : 'No matching ledger rows.';
    },
    get_facts: a => {
      const q = String(a.query || '').toLowerCase();
      const words = q.split(/\s+/).filter(w => w.length > 2);
      const rows = R.listFacts(ctx.storyId).filter(f => f.about.some(x => x.toLowerCase().includes(q) || q.includes(x.toLowerCase()))
        || words.some(w => f.text.toLowerCase().includes(w)));
      return rows.length ? rows.slice(0, 40).map(f => `#${f.id} ${f.text} (passage ${f.source_passage ?? '?'}${f.status === 'conflict' ? ', DISPUTED' : ''})`).join('\n') : `No facts recorded about "${a.query}".`;
    },
  };
}

function writeHandlers(ctx: ToolCtx): Record<string, (a: any) => string> {
  const c = (a: any): R.ChangeCtx => {
    const p = Number(a.passage_id);
    return { storyId: ctx.storyId, turnId: ctx.turnId, passageId: ctx.passageIds.includes(p) ? p : ctx.passageIds[ctx.passageIds.length - 1] ?? null };
  };
  const s = (v: any) => (v == null ? '' : String(v)).trim();
  const m = modeOf(ctx.settings);
  // Fields of a card kind from the tool input, falling back to the old values for anything left out.
  const fieldsFrom = (kind: CardKind, a: any, old: Record<string, string> = {}) =>
    Object.fromEntries((m.cards[kind] ?? []).map(d => [d.key, s(a[d.key]) || old[d.key] || '']));
  return {
    set_scene: a => {
      const present: R.Present[] = (Array.isArray(a.present) ? a.present : []).map((x: any) => ({ name: s(x.name), doing: s(x.doing), condition: s(x.condition) }))
        .filter((x: R.Present) => x.name && !R.memberByName(ctx.storyId, x.name));
      const cx = c(a);
      R.setScene(cx, { place: s(a.place), story_time: s(a.story_time), weather: s(a.weather), initiative: s(a.initiative), present, new_scene: !!a.new_scene, beat: s(a.beat) }, ctx.chapterId);
      if (cx.passageId) R.touchCardsSeen(ctx.storyId, present.map(p => p.name), cx.passageId);
      return 'Scene saved.';
    },
    create_card: a => {
      if (R.memberByName(ctx.storyId, s(a.name)) && !R.findCard(ctx.storyId, s(a.name))) return `${s(a.name)} is a player's character: they have a sheet (update_sheet), not a card.`;
      const existing = R.findCard(ctx.storyId, s(a.name));
      if (existing && normName(existing.name) === normName(s(a.name))) return `A card for ${existing.name} already exists (use update_card for a lasting change):\n${cardText(existing, ctx.settings)}`;
      const f = fieldsFrom('npc', a) as R.UserFields;
      R.createCard(c(a), f, (Array.isArray(a.aliases) ? a.aliases : []).map(s).filter(Boolean));
      return `Card created for ${f.name}.`;
    },
    update_card: a => {
      const card = R.findCard(ctx.storyId, s(a.name));
      if (!card) return `No card for "${a.name}". Use create_card.`;
      const f = { ...fieldsFrom('npc', a, card.fields || {}), name: s(a.name) || card.name };
      R.updateCard(c(a), card, f, s(a.what_changed) || 'updated');
      return `Card updated for ${card.name}.`;
    },
    update_sheet: a => {
      const who = R.memberByName(ctx.storyId, s(a.name));
      if (!who) return `No player's character called "${a.name}". The party: ${R.party(ctx.storyId).map(p => p.name).join(', ') || 'nobody yet'}.`;
      const old = (who.card?.fields ?? { name: who.name }) as R.UserFields;
      const f: R.UserFields = { ...old, name: old.name || who.name };
      const changed: string[] = [];
      for (const d of PLAY_FIELDS) { const v = s(a[d.key]); if (v && v !== old[d.key]) { f[d.key] = v; changed.push(d.key); } }
      // A change the story itself made to a field play doesn't touch (the magic belt that sets Strength).
      const sc = s(a.story_change).match(/^([a-z_]+)\s*:\s*([\s\S]+)$/i);
      if (sc && SHEET.some(d => d.key === sc[1].toLowerCase())) { f[sc[1].toLowerCase()] = sc[2].trim(); changed.push(sc[1].toLowerCase()); }
      if (!changed.length) return `Nothing on ${who.name}'s sheet changed.`;
      R.setUserCard(c(a), who.personaId, f, s(a.what_changed) || `changed: ${changed.join(', ')}`, 'Sheet');
      return `${who.name}'s sheet saved (${changed.join(', ')}).`;
    },
    set_dialogue_colors: a => {
      const done: string[] = [], skipped: string[] = [];
      for (const x of Array.isArray(a.colors) ? a.colors : []) {
        const color = R.hexColor(x?.color), name = s(x?.name);
        const card = R.memberByName(ctx.storyId, name)?.card ?? R.findCard(ctx.storyId, name);
        if (!color || !card) { skipped.push(`${name || '?'} (${!color ? 'not a hex color' : 'no card'})`); continue; }
        if (card.color) { skipped.push(`${card.name} (keeps ${card.color})`); continue; }
        R.setCardColor(card.id, color);
        done.push(`${card.name} ${color}`);
      }
      return [done.length ? `Saved: ${done.join(', ')}.` : 'Nothing saved.', skipped.length ? `Skipped: ${skipped.join(', ')}.` : ''].filter(Boolean).join(' ');
    },
    update_ledger: a => {
      const nk = (Array.isArray(a.not_known_by) ? a.not_known_by : []).map((x: any) => typeof x === 'string' ? { name: x, step: 'unaware' } : { name: s(x.name), step: s(x.step) || 'unaware' }).filter((x: any) => x.name);
      const kb = (Array.isArray(a.known_by) ? a.known_by : []).map(s).filter(Boolean);
      const res: any = R.upsertLedger(c(a), { id: a.id ? Number(a.id) : undefined, fact: s(a.fact), known_by: kb, not_known_by: nk, status: s(a.status) || 'open' }, s(a.how));
      return `Ledger row #${res.id} saved.`;
    },
    record_fact: a => {
      const kind = ['new', 'change', 'conflict'].includes(a.kind) ? a.kind : 'new';
      const res: any = R.addFact(c(a), s(a.text), (Array.isArray(a.about) ? a.about : []).map(s).filter(Boolean), kind, a.replaces_fact_id ? Number(a.replaces_fact_id) : undefined);
      return kind === 'conflict' ? `Conflict #${res.id} recorded for the host to resolve.` : `Fact #${res.id} saved.`;
    },
    set_thread: a => {
      const res: any = R.setThread(c(a), s(a.action) || 'open', s(a.text), a.thread_id ? Number(a.thread_id) : undefined);
      return `Thread #${res.id} saved.`;
    },
  };
}

export function runTool(ctx: ToolCtx, name: string, input: any, allowWrite: boolean): { text: string; isError: boolean } {
  const h = readHandlers(ctx)[name] ?? (allowWrite ? writeHandlers(ctx)[name] : undefined);
  if (!h) return { text: `Unknown tool ${name}.`, isError: true };
  try { return { text: h(input ?? {}), isError: false }; }
  catch (e: any) { return { text: `Error: ${e.message}`, isError: true }; }
}

// One-line description of a tool call for the transcript.
export function describeCall(name: string, a: any): string {
  switch (name) {
    case 'search_story': return `searched: ${a.query}`;
    case 'read_passage': return `read passage ${a.passage_id}`;
    case 'get_chapter_summary': return `chapter summary ${a.from_chapter}${a.to_chapter && a.to_chapter !== a.from_chapter ? `-${a.to_chapter}` : ''}`;
    case 'get_card': return `card: ${a.name}`;
    case 'set_dialogue_colors': return `dialogue colors: ${(Array.isArray(a.colors) ? a.colors : []).map((x: any) => x?.name).filter(Boolean).join(', ')}`;
    case 'check_ledger': return `ledger: ${[a.character, a.keyword].filter(Boolean).join(', ') || 'all'}`;
    case 'get_facts': return `facts: ${a.query}`;
    case 'set_scene': return `scene: ${clip([a.place, a.story_time].filter(Boolean).join(' · '), 80)}`;
    case 'create_card': return `new card: ${a.name}`;
    case 'update_card': return `card update: ${a.name} (${clip(String(a.what_changed || ''), 60)})`;
    case 'update_sheet': return `sheet ${a.name ?? ''}: ${clip(String(a.what_changed || ''), 60)}`;
    case 'update_ledger': return `ledger: ${clip(String(a.fact || ''), 80)}`;
    case 'record_fact': return `${a.kind === 'conflict' ? 'conflict' : 'fact'}: ${clip(String(a.text || ''), 80)}`;
    case 'set_thread': return `thread ${a.action}: ${clip(String(a.text || ''), 70)}`;
    default: return name;
  }
}

export const parseNames = (s: string) => parseJson<string[]>(s, []);
