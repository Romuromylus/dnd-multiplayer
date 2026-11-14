import { db, kvGet, kvSet, tx } from './db.ts';
import { decrypt } from './crypto.ts';
import { normalizeSettings } from './modes.ts';
import type { StorySettings } from './rules.ts';
import type { Conn } from './llm.ts';
import { now, parseJson, normName } from './util.ts';

// ---------------------------------------------------------------- basic loaders

export type Story = {
  id: number; title: string; persona_id: number | null; bible: string; settings: StorySettings; summary_template: string;
  host_user_id: number | null; invite_code: string;
  writer_conn_id: number | null; records_conn_id: number | null; archived: number; created_at: string; updated_at: string;
};
// A player's character in their library.
export type Persona = { id: number; user_id: number | null; name: string; description: string; look: string; sheet: string; avatar: string | null };
export type Chapter = { id: number; story_id: number; number: number; title: string; status: string; summary: string; summary_status: string; arc_id: number | null; closed_at: string | null; plan: string };
export type Passage = {
  id: number; story_id: number; chapter_id: number; scene_id: number | null; seq: number; kind: string; text: string;
  beat: string | null; cut: number; records_status: string; turn_id: number | null; persona_id: number | null; created_at: string; vn: string | null;
};

export function getStory(id: number): Story | null {
  const r: any = db.prepare('select * from stories where id = ?').get(id);
  if (!r) return null;
  return { ...r, settings: normalizeSettings(parseJson(r.settings, {})) };
}
export const getPersona = (id: number | null | undefined): Persona | null =>
  id ? (db.prepare('select * from personas where id = ?').get(id) as Persona) ?? null : null;
// The engine's one protagonist is the whole party at this table.
export const personaName = (_story: Story) => 'the party';

export function rowToConn(r: any): Conn {
  return {
    id: r.id, name: r.name, api_type: r.api_type, endpoint: r.endpoint, api_key: decrypt(r.api_key_enc), model: r.model,
    thinking_level: r.thinking_level, show_thinking: !!r.show_thinking, max_tokens: r.max_tokens, post_processing: r.post_processing, caching: !!r.caching, default_role: r.default_role,
  };
}
export function getConn(id: number | null | undefined): Conn | null {
  if (!id) return null;
  const r = db.prepare('select * from connections where id = ?').get(id);
  return r ? rowToConn(r) : null;
}
export function defaultConn(role: 'writer' | 'records'): Conn | null {
  const r = db.prepare('select * from connections where default_role = ? order by id limit 1').get(role)
    ?? (role === 'records' ? db.prepare(`select * from connections where default_role = 'writer' order by id limit 1`).get() : null)
    ?? db.prepare(`select * from connections where default_role != 'images' order by id limit 1`).get();
  return r ? rowToConn(r) : null;
}
export function storyConns(story: Story) {
  return { writer: getConn(story.writer_conn_id) ?? defaultConn('writer'), records: getConn(story.records_conn_id) ?? defaultConn('records') };
}

export function openChapter(storyId: number): Chapter {
  let ch = db.prepare(`select * from chapters where story_id = ? and status = 'open' order by number desc limit 1`).get(storyId) as Chapter | undefined;
  if (!ch) {
    const last = db.prepare('select max(number) n from chapters where story_id = ?').get(storyId) as { n: number | null };
    const n = (last.n ?? 0) + 1;
    const id = db.prepare(`insert into chapters(story_id, number, title, status, created_at) values (?, ?, '', 'open', ?)`).run(storyId, n, now()).lastInsertRowid;
    ch = db.prepare('select * from chapters where id = ?').get(id) as Chapter;
  }
  return ch;
}
export const getChapter = (id: number) => db.prepare('select * from chapters where id = ?').get(id) as Chapter | undefined;
export const chapterPassages = (chapterId: number) => db.prepare('select * from passages where chapter_id = ? order by seq').all(chapterId) as Passage[];
export const getPassage = (id: number) => db.prepare('select * from passages where id = ?').get(id) as Passage | undefined;
export function lastProse(storyId: number): Passage | undefined {
  return db.prepare(`select p.* from passages p join chapters c on c.id = p.chapter_id where p.story_id = ? and p.kind = 'prose' order by c.number desc, p.seq desc limit 1`).get(storyId) as Passage | undefined;
}
// Prose passages written after a given passage, newest first.
export function proseSince(storyId: number, afterId: number): Passage[] {
  return db.prepare(`select * from passages where story_id = ? and kind = 'prose' and id > ? order by id desc`).all(storyId, afterId) as Passage[];
}
// All prose passages of the story in reading order.
export function storyProse(storyId: number): Passage[] {
  return db.prepare(`select p.* from passages p join chapters c on c.id = p.chapter_id where p.story_id = ? and p.kind = 'prose' order by c.number, p.seq`).all(storyId) as Passage[];
}

export function addPassage(storyId: number, chapterId: number, kind: string, text: string, extra: Partial<Passage> = {}): Passage {
  const seq = ((db.prepare('select max(seq) m from passages where chapter_id = ?').get(chapterId) as { m: number | null }).m ?? 0) + 1;
  const st = db.prepare('select * from scenes where story_id = ? order by id desc limit 1').get(storyId) as any;
  const id = db.prepare(`insert into passages(story_id, chapter_id, scene_id, seq, kind, text, cut, records_status, turn_id, persona_id, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(storyId, chapterId, extra.scene_id ?? st?.id ?? null, seq, kind, text, extra.cut ?? 0,
    extra.records_status ?? 'none', extra.turn_id ?? null, extra.persona_id ?? null, now(), now()).lastInsertRowid as number;
  return getPassage(id)!;
}

export function setPassageText(id: number, text: string, reason: string) {
  const p = getPassage(id);
  if (!p) return;
  if (p.text && p.text !== text) db.prepare('insert into passage_versions(passage_id, text, reason, created_at) values (?, ?, ?, ?)').run(id, p.text, reason, now());
  db.prepare('update passages set text = ?, updated_at = ? where id = ?').run(text, now(), id);
}

// ---------------------------------------------------------------- row snapshots for undo

type Snap = { t: string; id: number | string; row: any | null };
const PK: Record<string, string> = { scene_state: 'story_id', app_kv: 'key' };
const pk = (t: string) => PK[t] ?? 'id';

function snap(t: string, id: number | string): Snap {
  if (t === 'passage_scene') {
    const r: any = db.prepare('select scene_id, beat from passages where id = ?').get(id);
    return { t, id, row: r ?? null };
  }
  return { t, id, row: db.prepare(`select * from ${t} where ${pk(t)} = ?`).get(id) ?? null };
}

function restore(s: Snap) {
  if (s.t === 'passage_scene') {
    if (s.row) db.prepare('update passages set scene_id = ?, beat = ? where id = ?').run(s.row.scene_id, s.row.beat, s.id);
    return;
  }
  const key = pk(s.t);
  if (!s.row) { db.prepare(`delete from ${s.t} where ${key} = ?`).run(s.id); return; }
  const cols = Object.keys(s.row);
  const exists = db.prepare(`select 1 from ${s.t} where ${key} = ?`).get(s.id);
  if (exists) db.prepare(`update ${s.t} set ${cols.filter(c => c !== key).map(c => `${c} = @${c}`).join(', ')} where ${key} = @${key}`).run(s.row);
  else db.prepare(`insert into ${s.t}(${cols.join(', ')}) values (${cols.map(c => '@' + c).join(', ')})`).run(s.row);
}

export type ChangeCtx = { storyId: number; passageId: number | null; turnId: number | null };

// Run a mutation and log it as one undoable change. `touch` lists the rows the mutation may modify.
function logged<T>(ctx: ChangeCtx, record: string, op: string, touch: [string, number | string][], summary: string, fn: () => T & { created?: [string, number][] }): T {
  return tx(() => {
    const before = touch.map(([t, id]) => snap(t, id));
    const res = fn();
    const created = res?.created ?? [];
    const allKeys = [...touch, ...created];
    const after = allKeys.map(([t, id]) => snap(t, id));
    for (const [t, id] of created) if (!before.some(b => b.t === t && b.id === id)) before.push({ t, id, row: null });
    const rid = created[0]?.[1] ?? touch[0]?.[1] ?? null;
    const recordId = typeof rid === 'number' ? rid : null;
    db.prepare(`insert into record_changes(story_id, passage_id, turn_id, record, record_id, op, before, after, summary, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ctx.storyId, ctx.passageId, ctx.turnId, record, recordId, op, JSON.stringify(before), JSON.stringify(after), summary, now());
    return res;
  });
}

export function undoChange(changeId: number, force = false): { ok: boolean; error?: string } {
  const ch: any = db.prepare('select * from record_changes where id = ?').get(changeId);
  if (!ch || ch.undone) return { ok: false, error: 'Already undone.' };
  const before: Snap[] = parseJson(ch.before, []);
  if (!force) {
    const later = db.prepare('select * from record_changes where story_id = ? and id > ? and undone = 0').all(ch.story_id, changeId) as any[];
    const keys = new Set(before.map(b => `${b.t}:${b.id}`));
    const clash = later.find(l => (parseJson<Snap[]>(l.after, [])).some(s => keys.has(`${s.t}:${s.id}`)));
    if (clash) return { ok: false, error: `A later change touches the same record ("${clash.summary}"). Undo that one first.` };
  }
  tx(() => {
    for (const s of [...before].reverse()) restore(s);
    db.prepare('update record_changes set undone = 1 where id = ?').run(changeId);
  });
  return { ok: true };
}

// Undo every live change made for these passages and everything recorded after them, newest first.
export function undoFromPassage(storyId: number, passageId: number) {
  const first: any = db.prepare('select min(id) m from record_changes where story_id = ? and passage_id = ? and undone = 0').get(storyId, passageId);
  if (!first?.m) return 0;
  const rows = db.prepare('select id from record_changes where story_id = ? and id >= ? and undone = 0 order by id desc').all(storyId, first.m) as { id: number }[];
  for (const r of rows) undoChange(r.id, true);
  return rows.length;
}
export function undoPassageChanges(storyId: number, passageIds: number[]) {
  if (!passageIds.length) return 0;
  const rows = db.prepare(`select id from record_changes where story_id = ? and undone = 0 and passage_id in (${passageIds.map(() => '?').join(',')}) order by id desc`).all(storyId, ...passageIds) as { id: number }[];
  for (const r of rows) undoChange(r.id, true);
  return rows.length;
}

export function passageChanges(passageId: number) {
  return db.prepare('select id, record, op, summary, undone, created_at from record_changes where passage_id = ? order by id').all(passageId);
}

export type InlineCard = { type: 'scene' | 'npc' | 'user' | 'nation'; op: string; name: string; fields: Record<string, any>; what_changed: string };

// What the records agent wrote for a passage, as cards to show under it: the scene it ended on, then each card it created or changed (last write wins).
export function passageCards(passageId: number): InlineCard[] {
  const rows = db.prepare(`select record, op, after from record_changes where passage_id = ? and undone = 0 and record in ('scene', 'card', 'user_card', 'nation') order by id`).all(passageId) as any[];
  let scene: InlineCard | null = null;
  const cards = new Map<string, InlineCard>();
  for (const r of rows) {
    const after = parseJson<Snap[]>(r.after, []);
    if (r.record === 'scene') {
      const st = after.find(s => s.t === 'scene_state')?.row;
      if (st) scene = { type: 'scene', op: 'update', name: '', fields: { place: st.place, story_time: st.story_time, weather: st.weather, present: parseJson(st.present, []) }, what_changed: '' };
      continue;
    }
    const v = after.find(s => s.t === 'card_versions')?.row;
    if (!v) continue;
    const fields = parseJson<Record<string, string>>(v.fields, {});
    const type = r.record === 'user_card' ? 'user' : r.record === 'nation' ? 'nation' : 'npc';
    const name = fields.name || after.find(s => s.t === 'cards')?.row?.name || '';
    const key = `${type}:${normName(name)}`;
    const prev = cards.get(key);
    cards.delete(key);
    cards.set(key, { type, op: prev?.op === 'create' ? 'create' : r.op, name, fields, what_changed: v.what_changed || '' });
  }
  return [...(scene ? [scene] : []), ...cards.values()];
}

// ---------------------------------------------------------------- cards

export type NpcFields = { name: string; role_age: string; appearance: string; backstory: string; relationship: string; voice: string };
export type UserFields = { name: string; [k: string]: string };

export function listCards(storyId: number, kind = 'npc') {
  return (db.prepare(`select c.*, v.fields from cards c left join card_versions v on v.id = c.current_version_id where c.story_id = ? and c.kind = ? and c.deleted = 0 order by c.name`).all(storyId, kind) as any[])
    .map(r => ({ ...r, aliases: parseJson<string[]>(r.aliases, []), fields: parseJson<any>(r.fields, {}) }));
}

export function findCard(storyId: number, name: string, kind = 'npc'): any | null {
  const n = normName(name);
  if (!n) return null;
  const cards = listCards(storyId, kind);
  const names = (c: any) => [c.name, ...c.aliases].map(normName);
  // A shorter name fits a longer one only by whole words: Kettlewick is Voss Kettlewick, but Wick is someone else.
  const words = (s: string) => ` ${s.split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `;
  const within = (a: string, b: string) => words(a).trim() !== '' && words(b).includes(words(a));
  return cards.find(c => names(c).includes(n))
    ?? cards.find(c => names(c).some(x => x.split(' ')[0] === n.split(' ')[0] && n.split(' ').length === 1))
    ?? cards.find(c => names(c).some(x => within(n, x) || within(x, n)))
    ?? null;
}

// A character's dialogue color, kept with the card itself so every version of the card shares it.
export const hexColor = (v: unknown) => { const m = String(v ?? '').trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i); return m ? `#${m[1].toUpperCase()}` : ''; };
export function setCardColor(cardId: number, color: string) { db.prepare('update cards set color = ? where id = ?').run(hexColor(color), cardId); }

export function cardVersions(cardId: number) {
  return (db.prepare('select * from card_versions where card_id = ? order by id').all(cardId) as any[]).map(v => ({ ...v, fields: parseJson(v.fields, {}) }));
}

export function createCard(ctx: ChangeCtx, f: { name: string; [k: string]: string }, aliases: string[] = [], kind = 'npc') {
  return logged(ctx, kind === 'nation' ? 'nation' : 'card', 'create', [], `New ${kind === 'nation' ? 'nation' : 'card'}: ${f.name}`, () => {
    const cid = db.prepare(`insert into cards(story_id, name, kind, aliases, last_seen_passage, created_at) values (?, ?, ?, ?, ?, ?)`)
      .run(ctx.storyId, f.name, kind, JSON.stringify(aliases), ctx.passageId, now()).lastInsertRowid as number;
    const vid = db.prepare('insert into card_versions(card_id, fields, changed_in_passage, what_changed, created_at) values (?, ?, ?, ?, ?)')
      .run(cid, JSON.stringify(f), ctx.passageId, 'first appearance', now()).lastInsertRowid as number;
    db.prepare('update cards set current_version_id = ? where id = ?').run(vid, cid);
    return { cardId: cid, created: [['cards', cid], ['card_versions', vid]] as [string, number][] };
  });
}

export function updateCard(ctx: ChangeCtx, card: any, f: any, whatChanged: string, label = 'Card') {
  return logged(ctx, card.kind === 'user' ? 'user_card' : card.kind === 'nation' ? 'nation' : 'card', 'update', [['cards', card.id]], `${label} updated: ${card.name} (${whatChanged})`, () => {
    const vid = db.prepare('insert into card_versions(card_id, fields, changed_in_passage, what_changed, created_at) values (?, ?, ?, ?, ?)')
      .run(card.id, JSON.stringify(f), ctx.passageId, whatChanged, now()).lastInsertRowid as number;
    db.prepare('update cards set current_version_id = ?, name = ?, last_seen_passage = coalesce(?, last_seen_passage) where id = ?').run(vid, f.name || card.name, ctx.passageId, card.id);
    return { created: [['card_versions', vid]] as [string, number][] };
  });
}

export function userCard(storyId: number, personaId: number | null) {
  const r: any = db.prepare(`select c.*, v.fields from cards c left join card_versions v on v.id = c.current_version_id where c.story_id = ? and c.kind = 'user' and c.deleted = 0 and coalesce(c.persona_id, 0) = coalesce(?, 0) order by c.id desc limit 1`).get(storyId, personaId);
  if (!r) return null;
  const fields = parseJson<UserFields>(r.fields, {} as UserFields);
  // A card from before the usual look was kept apart takes it from its first look.
  if (fields.look == null && fields.look_now != null) {
    const first = db.prepare('select fields from card_versions where card_id = ? order by id limit 1').get(r.id) as { fields: string } | undefined;
    fields.look = parseJson<UserFields>(first?.fields, {} as UserFields).look_now ?? '';
  }
  return { ...r, aliases: parseJson<string[]>(r.aliases, []), fields };
}

export const AS_USUAL = 'As usual';
export const looksUsual = (lookNow: string | undefined) => !lookNow?.trim() || /^(as usual|none|-)\.?$/i.test(lookNow.trim());

// The protagonist starts a new chapter rested and in their own clothes: the wear from the last one is gone.
export function wearOff(storyId: number, personaId: number | null) {
  const u = userCard(storyId, personaId);
  if (!u || looksUsual(u.fields.look_now)) return;
  updateCard({ storyId, passageId: null, turnId: null }, u, { ...u.fields, look_now: AS_USUAL }, 'a new chapter: the wear is gone', 'User card');
}

// The app's own changes to the sheet's HP: a dungeon run's result, and the rest between chapters.
export function setHp(storyId: number, personaId: number | null, cur: number, max: number, whatChanged: string) {
  const u = userCard(storyId, personaId);
  if (!u || String(u.fields.hp ?? '').trim() === `${cur}/${max}`) return;
  updateCard({ storyId, passageId: null, turnId: null }, u, { ...u.fields, hp: `${cur}/${max}` }, whatChanged, 'Sheet');
}

export function restUp(storyId: number, personaId: number | null) {
  const m = String(userCard(storyId, personaId)?.fields.hp ?? '').match(/(-?\d+)\s*\/\s*(\d+)/);
  if (m && Number(m[1]) < Number(m[2])) setHp(storyId, personaId, Number(m[2]), Number(m[2]), `a new chapter: rested, HP ${m[1]} → ${m[2]}`);
}

export function setUserCard(ctx: ChangeCtx, personaId: number | null, f: UserFields, whatChanged: string, label = 'User card') {
  const existing = userCard(ctx.storyId, personaId);
  if (existing) return updateCard(ctx, existing, f, whatChanged, label);
  return logged(ctx, 'user_card', 'create', [], `${label} created: ${f.name}`, () => {
    const cid = db.prepare(`insert into cards(story_id, name, kind, persona_id, aliases, created_at) values (?, ?, 'user', ?, '[]', ?)`).run(ctx.storyId, f.name, personaId, now()).lastInsertRowid as number;
    const vid = db.prepare('insert into card_versions(card_id, fields, changed_in_passage, what_changed, created_at) values (?, ?, ?, ?, ?)').run(cid, JSON.stringify(f), ctx.passageId, whatChanged || 'created', now()).lastInsertRowid as number;
    db.prepare('update cards set current_version_id = ? where id = ?').run(vid, cid);
    return { created: [['cards', cid], ['card_versions', vid]] as [string, number][] };
  });
}

export function touchCardsSeen(storyId: number, names: string[], passageId: number) {
  for (const n of names) {
    const c = findCard(storyId, n);
    if (c) db.prepare('update cards set last_seen_passage = ? where id = ?').run(passageId, c.id);
  }
}

// ---------------------------------------------------------------- ledger

export type LedgerRow = { id: number; fact: string; known_by: string[]; not_known_by: { name: string; step: string }[]; source_passage: number | null; status: string };
export function listLedger(storyId: number, status?: string): LedgerRow[] {
  const rows = (status ? db.prepare('select * from ledger where story_id = ? and status = ? order by id').all(storyId, status)
    : db.prepare('select * from ledger where story_id = ? order by id').all(storyId)) as any[];
  return rows.map(r => ({ ...r, known_by: parseJson(r.known_by, []), not_known_by: parseJson(r.not_known_by, []) }));
}

export function upsertLedger(ctx: ChangeCtx, row: { id?: number; fact: string; known_by: string[]; not_known_by: { name: string; step: string }[]; status?: string }, how: string) {
  if (row.id && db.prepare('select 1 from ledger where id = ? and story_id = ?').get(row.id, ctx.storyId)) {
    return logged(ctx, 'ledger', 'update', [['ledger', row.id]], `Ledger: ${row.fact}${how ? ` (${how})` : ''}`, () => {
      db.prepare('update ledger set fact = ?, known_by = ?, not_known_by = ?, status = ?, updated_at = ? where id = ?')
        .run(row.fact, JSON.stringify(row.known_by), JSON.stringify(row.not_known_by), row.status || 'open', now(), row.id);
      return { id: row.id };
    });
  }
  return logged(ctx, 'ledger', 'create', [], `Ledger: ${row.fact}`, () => {
    const id = db.prepare('insert into ledger(story_id, fact, known_by, not_known_by, source_passage, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.storyId, row.fact, JSON.stringify(row.known_by), JSON.stringify(row.not_known_by), ctx.passageId, row.status || 'open', now(), now()).lastInsertRowid as number;
    return { id, created: [['ledger', id]] as [string, number][] };
  });
}

// ---------------------------------------------------------------- facts

export type Fact = { id: number; text: string; about: string[]; source_passage: number | null; status: string; supersedes: number | null; note: string };
export function listFacts(storyId: number, statuses = ['active', 'conflict']): Fact[] {
  return (db.prepare(`select * from facts where story_id = ? and status in (${statuses.map(() => '?').join(',')}) order by id`).all(storyId, ...statuses) as any[])
    .map(r => ({ ...r, about: parseJson(r.about, []) }));
}

export function addFact(ctx: ChangeCtx, text: string, about: string[], kind: 'new' | 'change' | 'conflict', replaces?: number) {
  const old = replaces ? db.prepare('select * from facts where id = ? and story_id = ?').get(replaces, ctx.storyId) as any : null;
  const touch: [string, number][] = old ? [['facts', old.id]] : [];
  const label = kind === 'conflict' ? `Conflict: ${text}` : kind === 'change' ? `Fact changed: ${text}` : `Fact: ${text}`;
  return logged(ctx, 'fact', 'create', touch, label, () => {
    const status = kind === 'conflict' ? 'conflict' : 'active';
    const id = db.prepare('insert into facts(story_id, text, about, source_passage, status, supersedes, created_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.storyId, text, JSON.stringify(about), ctx.passageId, status, old?.id ?? null, now()).lastInsertRowid as number;
    if (old && kind === 'change') db.prepare(`update facts set status = 'superseded' where id = ?`).run(old.id);
    return { id, created: [['facts', id]] as [string, number][] };
  });
}

// Author's decision on a conflict: keep the old fact, keep the new one, or treat the new one as a deliberate retcon.
export function resolveConflict(storyId: number, factId: number, action: 'keep_old' | 'keep_new' | 'retcon') {
  const f: any = db.prepare('select * from facts where id = ? and story_id = ?').get(factId, storyId);
  if (!f) return;
  tx(() => {
    if (action === 'keep_old') db.prepare(`update facts set status = 'rejected' where id = ?`).run(f.id);
    else {
      db.prepare(`update facts set status = 'active', note = ? where id = ?`).run(action === 'retcon' ? 'retcon' : '', f.id);
      if (f.supersedes) db.prepare(`update facts set status = 'superseded' where id = ?`).run(f.supersedes);
    }
  });
}

// ---------------------------------------------------------------- outline

export type OutlineEvent = { id: number; story_id: number; seq: number; text: string; done: number };
export const listOutline = (storyId: number) => db.prepare('select * from outline where story_id = ? order by seq, id').all(storyId) as OutlineEvent[];

export function addOutlineEvent(storyId: number, text: string, done = false) {
  const seq = (db.prepare('select coalesce(max(seq), 0) + 1 n from outline where story_id = ?').get(storyId) as { n: number }).n;
  return db.prepare('insert into outline(story_id, seq, text, done, created_at) values (?, ?, ?, ?, ?)').run(storyId, seq, text, done ? 1 : 0, now()).lastInsertRowid as number;
}

// The records agent's changes go through the log, so a retried or corrected chapter takes its ticks back with it.
export function setOutline(ctx: ChangeCtx, action: string, text: string, eventId?: number) {
  if (action === 'add') {
    return logged(ctx, 'outline', 'create', [], `Outline: ${text}`, () => ({ created: [['outline', addOutlineEvent(ctx.storyId, text)]] as [string, number][] }));
  }
  const e = db.prepare('select * from outline where id = ? and story_id = ?').get(eventId ?? 0, ctx.storyId) as OutlineEvent | undefined;
  if (!e) throw new Error(`No outline event #${eventId}.`);
  const label = action === 'done' ? 'Outline done' : action === 'drop' ? 'Outline dropped' : 'Outline changed';
  return logged(ctx, 'outline', 'update', [['outline', e.id]], `${label}: ${text || e.text}`, () => {
    if (action === 'drop') db.prepare('delete from outline where id = ?').run(e.id);
    else db.prepare('update outline set text = ?, done = ? where id = ?').run(text || e.text, action === 'done' ? 1 : e.done, e.id);
    return {} as any;
  });
}

// A new plan: events whose text didn't change keep their ids, so ticks already logged still point at them.
export function replaceOutline(storyId: number, events: { text: string; done: boolean }[]) {
  const old = new Map(listOutline(storyId).map(e => [normName(e.text), e]));
  tx(() => {
    const keep = new Set<number>();
    events.forEach((e, i) => {
      const cur = old.get(normName(e.text));
      if (cur && !keep.has(cur.id)) { keep.add(cur.id); db.prepare('update outline set seq = ?, text = ?, done = ? where id = ?').run(i + 1, e.text, e.done || cur.done ? 1 : 0, cur.id); }
      else keep.add(db.prepare('insert into outline(story_id, seq, text, done, created_at) values (?, ?, ?, ?, ?)').run(storyId, i + 1, e.text, e.done ? 1 : 0, now()).lastInsertRowid as number);
    });
    for (const e of old.values()) if (!keep.has(e.id)) db.prepare('delete from outline where id = ?').run(e.id);
  });
}

export const listParts = (storyId: number) => db.prepare('select * from chapters where story_id = ? order by number').all(storyId) as Chapter[];

// ---------------------------------------------------------------- threads

export function listThreads(storyId: number, status?: string) {
  return (status ? db.prepare('select * from threads where story_id = ? and status = ? order by id').all(storyId, status)
    : db.prepare('select * from threads where story_id = ? order by id').all(storyId)) as any[];
}

export function setThread(ctx: ChangeCtx, action: string, text: string, threadId?: number) {
  const existing: any = threadId ? db.prepare('select * from threads where id = ? and story_id = ?').get(threadId, ctx.storyId) : null;
  if (action === 'open' || !existing) {
    return logged(ctx, 'thread', 'create', [], `Thread opened: ${text}`, () => {
      const id = db.prepare(`insert into threads(story_id, text, opened_in_passage, last_touched_passage, status, created_at) values (?, ?, ?, ?, 'open', ?)`)
        .run(ctx.storyId, text, ctx.passageId, ctx.passageId, now()).lastInsertRowid as number;
      return { id, created: [['threads', id]] as [string, number][] };
    });
  }
  const status = action === 'pay_off' ? 'paid' : action === 'drop' ? 'dropped' : 'open';
  const label = action === 'pay_off' ? 'Thread paid off' : action === 'drop' ? 'Thread dropped' : 'Thread moved';
  return logged(ctx, 'thread', 'update', [['threads', existing.id]], `${label}: ${text || existing.text}`, () => {
    db.prepare('update threads set text = ?, status = ?, last_touched_passage = ?, closed_in_passage = ? where id = ?')
      .run(text || existing.text, status, ctx.passageId, status === 'open' ? null : ctx.passageId, existing.id);
    return { id: existing.id };
  });
}

// ---------------------------------------------------------------- scene state

export type Present = { name: string; doing?: string; condition?: string };
export function getSceneState(storyId: number) {
  const r: any = db.prepare('select * from scene_state where story_id = ?').get(storyId);
  return r ? { ...r, present: parseJson<Present[]>(r.present, []) } : { story_id: storyId, place: '', story_time: '', weather: '', initiative: '', present: [] as Present[], updated_passage: null };
}

export function setScene(ctx: ChangeCtx, s: { place: string; story_time: string; weather: string; initiative?: string; present: Present[]; new_scene: boolean; beat: string }, chapterId: number) {
  const prevPassageScene = ctx.passageId ? snap('passage_scene', ctx.passageId) : null;
  const touch: [string, number][] = [['scene_state', ctx.storyId]];
  if (prevPassageScene) touch.push(['passage_scene', ctx.passageId!]);
  const cur: any = db.prepare('select * from scenes where story_id = ? order by id desc limit 1').get(ctx.storyId);
  if (cur && !s.new_scene) touch.push(['scenes', cur.id]);
  const label = `Scene: ${[s.place, s.story_time, s.weather].filter(Boolean).join(' · ')}${s.new_scene ? ' (new scene)' : ''}`;
  return logged(ctx, 'scene', 'update', touch, label, () => {
    const created: [string, number][] = [];
    let sceneId = cur?.id;
    if (s.new_scene || !cur) {
      sceneId = db.prepare('insert into scenes(story_id, chapter_id, place, story_time, weather, created_at) values (?, ?, ?, ?, ?, ?)')
        .run(ctx.storyId, chapterId, s.place, s.story_time, s.weather, now()).lastInsertRowid as number;
      created.push(['scenes', sceneId]);
    } else {
      db.prepare('update scenes set place = ?, story_time = ?, weather = ? where id = ?').run(s.place || cur.place, s.story_time || cur.story_time, s.weather || cur.weather, cur.id);
    }
    db.prepare(`insert into scene_state(story_id, place, story_time, weather, initiative, present, updated_passage) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(story_id) do update set place = excluded.place, story_time = excluded.story_time, weather = excluded.weather, initiative = excluded.initiative, present = excluded.present, updated_passage = excluded.updated_passage`)
      .run(ctx.storyId, s.place, s.story_time, s.weather, s.initiative ?? '', JSON.stringify(s.present ?? []), ctx.passageId);
    if (ctx.passageId) db.prepare('update passages set scene_id = ?, beat = ? where id = ?').run(sceneId, s.beat || null, ctx.passageId);
    return { sceneId, created };
  });
}


// One stored value changed for a passage, undone with it (a regenerated passage takes it back).
export function setKv(ctx: ChangeCtx, record: string, key: string, value: string, summary: string) {
  logged(ctx, record, 'update', [['app_kv', key]], summary, () => { kvSet(key, value); return {}; });
}

// ---------------------------------------------------------------- the table: seats and the party

export type Seat = { story_id: number; user_id: number; persona_id: number | null; status: 'active' | 'away'; joined_at: string; username: string; display_name: string; name: string | null; avatar: string | null };
export const listSeats = (storyId: number) => db.prepare(`select s.*, u.username, coalesce(nullif(u.display_name, ''), u.username) display_name, p.name, p.avatar from seats s join users u on u.id = s.user_id left join personas p on p.id = s.persona_id where s.story_id = ? order by s.joined_at, u.id`).all(storyId) as Seat[];
export const getSeat = (storyId: number, userId: number) => listSeats(storyId).find(s => s.user_id === userId) ?? null;

// The characters at the table, with whoever plays them. The sheet's own name wins over the library's (the card is renamed with it).
export type PartyMember = { personaId: number; userId: number; player: string; name: string; status: 'active' | 'away'; card: any | null };
export function party(storyId: number): PartyMember[] {
  return listSeats(storyId).filter(s => s.persona_id).map(s => {
    const card = userCard(storyId, s.persona_id);
    return { personaId: s.persona_id!, userId: s.user_id, player: s.display_name, name: card?.fields?.name || s.name || 'Unnamed', status: s.status, card };
  });
}
export function memberByName(storyId: number, name: string): PartyMember | null {
  const n = normName(name);
  if (!n) return null;
  const all = party(storyId);
  return all.find(m => normName(m.name) === n)
    ?? all.find(m => normName(m.name).split(' ')[0] === n.split(' ')[0])
    ?? all.find(m => normName(m.name).includes(n) || n.includes(normName(m.name)))
    ?? null;
}
