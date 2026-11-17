import fs from 'node:fs';
import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { db } from './db.ts';
import { encrypt } from './crypto.ts';
import { getJob, JobBusy, runningJob, sseResponse, startJob, stopJob, type Job, type JobEvent } from './jobs.ts';
import { listModels, testConnection, type Conn } from './llm.ts';
import * as R from './records.ts';
import { modeSchema, NPC, normalizeSettings, defaultSettings, SHEET, SHEET_KEYS } from './modes.ts';
import { closeChapter, rollupArc, summarizeChapter } from './chapters.ts';
import { ensureSheets, flushPendingRecords, getGuidance, guidanceKey, levelEarned, openingRound, roundMarkup, runContinue, runFix, runRecords, runRedoRecords, runTurn, sheetFields, type RoundAction } from './turn.ts';
import { ART_WIDTHS, artMap, artWatchers, assetPath, deleteAsset, deleteStoryImages, enqueuePortraits, enqueueSceneArt, getAsset, imageConn, pump, redoAsset, sceneKey, sizedFile } from './art.ts';
import { cleanDraft, runAssist, runAvatar, runBuildSheet, runCharacterChat, runLevelChat, runSheetEdit, type AssistKind, type ChatLine } from './assist.ts';
import { voiceApi } from './voice.ts';
import { broadcast, liveResponse, online } from './live.ts';
import * as A from './auth.ts';
import { clip, now, parseJson } from './util.ts';
import srdRaces from './srd/races.json' with { type: 'json' };
import srdClasses from './srd/classes.json' with { type: 'json' };
import srdBackgrounds from './srd/backgrounds.json' with { type: 'json' };
import srdSubclasses from './srd/subclasses.json' with { type: 'json' };

export const api = new Hono();

// A finished picture shows up at its table straight away.
artWatchers.add(storyId => broadcast(storyId, 'art', {}));

api.onError((err, c) => {
  if (err instanceof JobBusy) return c.json({ error: 'The Dungeon Master is busy with this campaign. Wait for it to finish.' }, 409);
  console.error(err);
  return c.json({ error: err.message || String(err) }, 500);
});

const num = (v: string | undefined) => Number(v);
const bad = (c: Context, msg: string, code = 400) => c.json({ error: msg }, code as any);
const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as any;
const str = (v: any, max = 20000) => String(v ?? '').slice(0, max);

// ---------------------------------------------------------------- accounts (before sign-in)

api.get('/auth/status', c => {
  const u = A.sessionUser(c);
  return c.json({ user: u, setup: A.userCount() === 0 });
});

api.post('/auth/login', async c => {
  const b = await body(c);
  const name = str(b.username, 64).trim(), pw = str(b.password, 200);
  const keys = [`ip:${A.clientIp(c)}`, `u:${name.toLowerCase()}`];
  if (A.tooManyTries(keys)) return bad(c, 'Too many tries. Wait a few minutes.', 429);
  const row = A.findUser(name);
  if (!row || !A.checkPassword(pw, row.pass_hash)) { A.failedTry(keys); return bad(c, 'Wrong username or password.', 401); }
  A.startSession(c, row.id);
  return c.json({ user: A.getUser(row.id) });
});

api.post('/auth/logout', c => { A.endSession(c); return c.json({ ok: true }); });

// The first account is the admin. After that, a new player signs up with a campaign's invite code, which seats them in it.
api.post('/auth/register', async c => {
  const b = await body(c);
  const name = str(b.username, 64).trim(), pw = str(b.password, 200), code = str(b.code, 32).trim().toUpperCase();
  if (A.tooManyTries([`ip:${A.clientIp(c)}`])) return bad(c, 'Too many tries. Wait a few minutes.', 429);
  if (!A.validUsername(name)) return bad(c, 'A username is 2 to 32 letters, digits, dots, dashes or underscores.');
  if (pw.length < 8) return bad(c, 'A password needs at least 8 characters.');
  if (A.findUser(name)) return bad(c, 'That username is taken.');
  const first = A.userCount() === 0;
  const story = first ? null : db.prepare('select id from stories where invite_code = ? and archived = 0').get(code) as { id: number } | undefined;
  if (!first && !story) { A.failedTry([`ip:${A.clientIp(c)}`]); return bad(c, 'Sign-up needs an invite code from a campaign host.'); }
  const u = A.createUser(name, pw, first ? 'admin' : 'player', str(b.display_name, 40));
  if (story) seat(story.id, u.id, null);
  A.startSession(c, u.id);
  return c.json({ user: u, joined: story?.id ?? null });
});

// ---------------------------------------------------------------- everything below needs an account

api.use('*', A.requireUser);

const isAdmin = (c: Context) => A.me(c).role === 'admin';
const seatOf = (storyId: number, userId: number) => R.getSeat(storyId, userId);
const canSee = (c: Context, story: R.Story | null) => !!story && (isAdmin(c) || !!seatOf(story.id, A.me(c).id));
const isHost = (c: Context, story: R.Story | null) => !!story && (isAdmin(c) || story.host_user_id === A.me(c).id);

// The campaign from the route, if this user may see it (and run it, with host).
function campaign(c: Context, opts: { host?: boolean } = {}): R.Story | Response {
  const story = R.getStory(num(c.req.param('id')));
  if (!canSee(c, story)) return bad(c, 'Not found', 404);
  if (opts.host && !isHost(c, story)) return bad(c, 'Only the host can do that.', 403);
  return story!;
}
const failed = (x: unknown): x is Response => x instanceof Response;

function seat(storyId: number, userId: number, personaId: number | null) {
  const before = seatOf(storyId, userId)?.persona_id ?? null;
  db.prepare(`insert into seats(story_id, user_id, persona_id, status, joined_at) values (?, ?, ?, 'active', ?)
    on conflict(story_id, user_id) do update set persona_id = excluded.persona_id`).run(storyId, userId, personaId, now());
  if (personaId) ensureSheets(storyId);
  noteArrival(storyId, userId, before);
  broadcast(storyId, 'seats', {});
}

// A campaign has begun once the Dungeon Master has written its opening. Until then nobody plays a round: the host is
// still gathering the table.
const begun = (storyId: number) => !!db.prepare(`select 1 from passages where story_id = ? and kind = 'prose' limit 1`).get(storyId);

// Game over: every character at the table is down at 0 HP (dying, stable or dead). The table stops there and the host
// decides what comes next: back to before the fight, back one round, or carry on. Carrying on holds until someone is up again.
type Fallen = { name: string; state: 'dying' | 'stable' | 'dead' };
const fallenState = (f: Record<string, any>): Fallen['state'] => {
  const cond = String(f?.conditions ?? '');
  return /\bdead\b/i.test(cond) ? 'dead' : /\bstable\b/i.test(cond) ? 'stable' : 'dying';
};
const isDown = (f: Record<string, any>) => {
  const hp = String(f?.hp ?? '').match(/^\s*(-?\d+)\s*\//);
  return (!!hp && Number(hp[1]) <= 0) || fallenState(f) === 'dead';
};
const ackKey = (storyId: number) => `gameover_ack:${storyId}`;
function gameOver(storyId: number): { party: Fallen[]; fight: boolean } | null {
  if (!begun(storyId)) return null;
  const cards = R.listSeats(storyId).filter(s => s.persona_id).map(s => R.userCard(storyId, s.persona_id!)).filter(c => !!c) as { fields: Record<string, any> }[];
  const down = cards.length > 0 && cards.every(c => isDown(c.fields));
  const acked = !!db.prepare('select 1 from app_kv where key = ?').get(ackKey(storyId));
  if (!down) { if (acked) db.prepare('delete from app_kv where key = ?').run(ackKey(storyId)); return null; }
  if (acked) return null;
  return { party: cards.map(c => ({ name: String(c.fields.name ?? ''), state: fallenState(c.fields) })), fight: fightStart(storyId) != null };
}
const GAME_OVER = 'Game over: the whole party is down. The host decides what comes next.';

// Where a rewind starts, in the open chapter: the round that began the latest fight (its first initiative roll), or the
// latest round. A round is the players' actions and the passage written from them, so both go.
const INITIATIVE = /<roll>[^<|]*\|\s*Initiative\s*\|/i;
function roundFrom(ps: R.Passage[], i: number) { return i > 0 && ps[i - 1].kind === 'direction' ? ps[i - 1].seq : ps[i].seq; }
function fightStart(storyId: number): number | null {
  const ps = R.chapterPassages(R.openChapter(storyId).id);
  for (let i = ps.length - 1; i >= 0; i--) if (ps[i].kind === 'prose' && INITIATIVE.test(ps[i].text)) return roundFrom(ps, i);
  return null;
}
function lastRoundStart(storyId: number): number | null {
  const ps = R.chapterPassages(R.openChapter(storyId).id);
  for (let i = ps.length - 1; i >= 0; i--) if (ps[i].kind === 'prose') return roundFrom(ps, i);
  return null;
}
// Takes the open chapter back to just before the passage at seq: everything from there on goes, with what it changed in the records.
function rewindTo(storyId: number, fromSeq: number) {
  const ch = R.openChapter(storyId);
  const gone = (db.prepare('select id from passages where chapter_id = ? and seq >= ?').all(ch.id, fromSeq) as { id: number }[]).map(r => r.id);
  db.transaction(() => {
    R.undoPassageChanges(storyId, gone);
    db.prepare('delete from passages where chapter_id = ? and seq >= ?').run(ch.id, fromSeq);
    db.prepare('update actions set ready = 0 where story_id = ?').run(storyId);
    db.prepare('delete from app_kv where key = ?').run(ackKey(storyId));
  })();
  return gone.length;
}

// A character brought to the table after the opening isn't in the scene yet: a note tells the Dungeon Master (and the table)
// to bring them in with the next passage.
function noteArrival(storyId: number, userId: number, before: number | null) {
  const s = seatOf(storyId, userId);
  if (!s?.persona_id || s.persona_id === before || !begun(storyId)) return;
  const m = R.party(storyId).find(p => p.userId === userId);
  if (!m) return;
  // Someone who stepped away and came back, or a character already in the story, is no newcomer.
  const first = m.name.split(/\s+/)[0];
  const named = (t: string) => t.includes(m.name) || (first.length > 2 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t));
  if (R.storyProse(storyId).some(p => named(p.text))) return;
  const p = R.addPassage(storyId, R.openChapter(storyId).id, 'note', `${m.name} (played by ${m.player}) joins the party. The next passage brings them into the scene: as their player's action describes, or simply arriving, with nothing said or decided for them.`);
  broadcast(storyId, 'refresh', { what: 'passages', passageId: p.id });
}

api.get('/me', c => c.json({ user: A.me(c) }));
api.put('/me', async c => {
  const b = await body(c);
  const u = A.me(c);
  if (b.display_name != null) db.prepare('update users set display_name = ?, updated_at = ? where id = ?').run(str(b.display_name, 40).trim(), now(), u.id);
  if (b.prefs && typeof b.prefs === 'object') {
    // Laid over what is kept, key by key: a page opened before another device saved something sends an older copy, and
    // it shouldn't wipe what it never knew about (saved campaign defaults, say).
    const kept = parseJson<Record<string, any>>((db.prepare('select prefs from users where id = ?').get(u.id) as { prefs: string } | undefined)?.prefs, {});
    const json = JSON.stringify({ ...kept, ...b.prefs });
    if (json.length > 24000) return bad(c, 'Preferences too large.');
    db.prepare('update users set prefs = ?, updated_at = ? where id = ?').run(json, now(), u.id);
  }
  if (b.new_password != null) {
    const row: any = db.prepare('select pass_hash from users where id = ?').get(u.id);
    if (!A.checkPassword(str(b.password, 200), row.pass_hash)) return bad(c, 'The current password is wrong.', 403);
    if (str(b.new_password, 200).length < 8) return bad(c, 'A password needs at least 8 characters.');
    db.prepare('update users set pass_hash = ?, updated_at = ? where id = ?').run(A.hashPassword(str(b.new_password, 200)), now(), u.id);
  }
  return c.json({ user: A.getUser(u.id) });
});

// ---------------------------------------------------------------- admin: users and connections

const admin = (c: Context) => isAdmin(c) ? null : bad(c, 'Only an admin can do that.', 403);

api.get('/admin/users', c => admin(c) ?? c.json({ users: db.prepare(`select id, username, display_name, role, created_at from users order by id`).all() }));
api.post('/admin/users', async c => {
  const no = admin(c); if (no) return no;
  const b = await body(c);
  const name = str(b.username, 64).trim(), pw = str(b.password, 200);
  if (!A.validUsername(name)) return bad(c, 'A username is 2 to 32 letters, digits, dots, dashes or underscores.');
  if (pw.length < 8) return bad(c, 'A password needs at least 8 characters.');
  if (A.findUser(name)) return bad(c, 'That username is taken.');
  return c.json({ user: A.createUser(name, pw, b.role === 'admin' ? 'admin' : 'player', str(b.display_name, 40)) });
});
api.put('/admin/users/:uid', async c => {
  const no = admin(c); if (no) return no;
  const id = num(c.req.param('uid'));
  const b = await body(c);
  if (b.role && id !== A.me(c).id) db.prepare('update users set role = ? where id = ?').run(b.role === 'admin' ? 'admin' : 'player', id);
  if (b.password) {
    if (str(b.password, 200).length < 8) return bad(c, 'A password needs at least 8 characters.');
    db.prepare('update users set pass_hash = ? where id = ?').run(A.hashPassword(str(b.password, 200)), id);
    A.endAllSessions(id);
  }
  return c.json({ ok: true });
});
api.delete('/admin/users/:uid', c => {
  const no = admin(c); if (no) return no;
  const id = num(c.req.param('uid'));
  if (id === A.me(c).id) return bad(c, "You can't delete your own account.");
  db.prepare('delete from users where id = ?').run(id);
  return c.json({ ok: true });
});

function maskConn(r: any) {
  const { api_key_enc, ...rest } = r;
  return { ...rest, has_key: !!api_key_enc, show_thinking: !!r.show_thinking, caching: !!r.caching };
}
const ROLES = ['writer', 'records', 'images', 'none'];
function connFromBody(b: any, ex: any = {}) {
  return {
    name: String(b.name ?? ex.name ?? 'Connection').trim().slice(0, 80) || 'Connection',
    api_type: b.api_type === 'openai' ? 'openai' : b.api_type === 'anthropic' ? 'anthropic' : ex.api_type ?? 'anthropic',
    endpoint: String(b.endpoint ?? ex.endpoint ?? '').trim(),
    model: String(b.model ?? ex.model ?? '').trim(),
    thinking_level: ['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(b.thinking_level) ? b.thinking_level : ex.thinking_level ?? 'high',
    show_thinking: (b.show_thinking ?? (ex.show_thinking == null ? true : !!ex.show_thinking)) ? 1 : 0,
    max_tokens: Math.max(1000, Math.min(128000, Number(b.max_tokens ?? ex.max_tokens ?? 32000) || 32000)),
    post_processing: ['none', 'merge', 'semi', 'strict', 'single'].includes(b.post_processing) ? b.post_processing : ex.post_processing ?? 'none',
    caching: (b.caching ?? (ex.caching == null ? true : !!ex.caching)) ? 1 : 0,
    default_role: ROLES.includes(b.default_role) ? b.default_role : ex.default_role ?? 'none',
  };
}
function setDefaultRole(id: number, role: string) {
  if (role === 'writer' || role === 'records' || role === 'images') db.prepare(`update connections set default_role = 'none' where default_role = ? and id != ?`).run(role, id);
  if (role === 'images') pump();
}
// Everyone may see which connections exist (to pick one for a campaign); only an admin sees the details.
api.get('/connections', c => {
  const rows = db.prepare('select * from connections order by id').all() as any[];
  return c.json({ connections: isAdmin(c) ? rows.map(maskConn) : rows.map(r => ({ id: r.id, name: r.name, model: r.model, default_role: r.default_role })) });
});
api.post('/connections', async c => {
  const no = admin(c); if (no) return no;
  const b = await body(c);
  const f = connFromBody(b);
  if (!f.endpoint || !f.model) return bad(c, 'Endpoint and model are required.');
  const key = String(b.api_key ?? '').trim();
  const id = db.prepare(`insert into connections(name, api_type, endpoint, api_key_enc, key_last4, model, thinking_level, show_thinking, max_tokens, post_processing, caching, default_role, created_at, updated_at)
    values (@name, @api_type, @endpoint, @enc, @last4, @model, @thinking_level, @show_thinking, @max_tokens, @post_processing, @caching, @default_role, @t, @t)`)
    .run({ ...f, enc: key ? encrypt(key) : null, last4: key ? key.slice(-4) : null, t: now() }).lastInsertRowid as number;
  setDefaultRole(id, f.default_role);
  return c.json(maskConn(db.prepare('select * from connections where id = ?').get(id)));
});
api.put('/connections/:cid', async c => {
  const no = admin(c); if (no) return no;
  const id = num(c.req.param('cid'));
  const ex: any = db.prepare('select * from connections where id = ?').get(id);
  if (!ex) return bad(c, 'Not found', 404);
  const b = await body(c);
  const f = connFromBody(b, ex);
  const key = String(b.api_key ?? '').trim();
  const keyUpdate = b.clear_key ? { enc: null, last4: null } : key ? { enc: encrypt(key), last4: key.slice(-4) } : { enc: ex.api_key_enc, last4: ex.key_last4 };
  db.prepare(`update connections set name=@name, api_type=@api_type, endpoint=@endpoint, api_key_enc=@enc, key_last4=@last4, model=@model, thinking_level=@thinking_level, show_thinking=@show_thinking,
    max_tokens=@max_tokens, post_processing=@post_processing, caching=@caching, default_role=@default_role, updated_at=@t where id=@id`).run({ ...f, ...keyUpdate, t: now(), id });
  setDefaultRole(id, f.default_role);
  return c.json(maskConn(db.prepare('select * from connections where id = ?').get(id)));
});
api.delete('/connections/:cid', c => { const no = admin(c); if (no) return no; db.prepare('delete from connections where id = ?').run(num(c.req.param('cid'))); return c.json({ ok: true }); });
api.post('/connections/:cid/test', async c => {
  const no = admin(c); if (no) return no;
  const conn = R.getConn(num(c.req.param('cid')));
  if (!conn) return bad(c, 'Not found', 404);
  if (conn.default_role === 'images') {
    try {
      const models = await listModels(conn);
      return c.json({ results: [{ step: 'Endpoint answers', ok: true, detail: `${models.length} models listed` }, { step: 'Image model', ok: models.includes(conn.model), detail: models.includes(conn.model) ? `${conn.model} is available` : `${conn.model} is not in the model list` }] });
    } catch (e: any) { return c.json({ results: [{ step: 'Endpoint answers', ok: false, detail: e.message }] }); }
  }
  return c.json({ results: await testConnection(conn) });
});
api.post('/connections/models', async c => {
  const no = admin(c); if (no) return no;
  const b = await body(c);
  const saved = b.id ? R.getConn(Number(b.id)) : null;
  const conn = { api_type: b.api_type ?? saved?.api_type ?? 'anthropic', endpoint: b.endpoint || saved?.endpoint || '', api_key: b.api_key || saved?.api_key || '' } as Conn;
  try { return c.json({ models: await listModels(conn) }); } catch (e: any) { return bad(c, `Could not list models: ${e.message}`); }
});

// ---------------------------------------------------------------- the home page: campaigns, characters, worlds

api.get('/home', c => {
  const u = A.me(c);
  const where = isAdmin(c) ? '1 = 1' : 's.id in (select story_id from seats where user_id = @uid)';
  const campaigns = db.prepare(`select s.id, s.title, s.host_user_id, s.archived, s.updated_at, s.created_at,
      (select coalesce(nullif(display_name, ''), username) from users where id = s.host_user_id) host,
      (select count(*) from seats where story_id = s.id) seats,
      (select count(*) from passages where story_id = s.id and kind = 'prose') passages,
      (select persona_id from seats where story_id = s.id and user_id = @uid) my_persona,
      exists(select 1 from seats where story_id = s.id and user_id = @uid) seated
    from stories s where ${where} order by s.updated_at desc`).all({ uid: u.id });
  const characters = db.prepare('select * from personas where user_id = ? order by name collate nocase').all(u.id);
  const worlds = db.prepare(`select b.*, coalesce(nullif(u.display_name, ''), u.username) owner from bibles b left join users u on u.id = b.user_id order by b.name collate nocase`).all();
  return c.json({ user: u, campaigns, characters, worlds, schema: modeSchema(), srd: srd(), imageConn: !!imageConn(), hasWriter: !!R.defaultConn('writer') });
});

// Names for the character builder's lists. Anything else typed in (homebrew) is fine too.
function srd() {
  const names = (x: any) => (Array.isArray(x) ? x : Object.values(x ?? {})).map((r: any) => r?.name ?? r).filter((n: any) => typeof n === 'string');
  const subs: Record<string, string[]> = {};
  const clsName = new Map((srdClasses as any[]).map(c => [c.index, c.name]));
  for (const s of srdSubclasses as any[]) { const cls = clsName.get(s.class_index) ?? s.class_index; (subs[cls] ??= []).push(s.name); }
  return { species: names((srdRaces as any).races ?? srdRaces), classes: names((srdClasses as any).classes ?? srdClasses), backgrounds: names((srdBackgrounds as any).backgrounds ?? srdBackgrounds), subclasses: subs };
}

// A player's characters.
const myPersona = (c: Context, id: number) => {
  const p = R.getPersona(id);
  return p && (p.user_id === A.me(c).id || isAdmin(c)) ? p : null;
};
const BUILD_KEYS = ['species', 'cls', 'subclass', 'background', 'level', 'scoresHow', 'scores', 'notes'] as const;
// The talk with the Dungeon Master that made the character, kept so it can go on later (the latest part, if it runs long).
function chatLines(v: unknown): ChatLine[] {
  if (!Array.isArray(v)) return [];
  const lines: ChatLine[] = v.filter(l => l && typeof l === 'object' && typeof l.text === 'string' && l.text.trim()).slice(-80)
    .map(l => ({ role: l.role === 'dm' ? 'dm' : 'me', text: str(l.text, 6000), ...(l.role === 'dm' && l.draft ? { draft: cleanDraft(l.draft) } : {}) }));
  while (lines.length > 1 && JSON.stringify(lines).length > 200000) lines.shift();
  return lines;
}
function personaFromBody(b: any, ex: Partial<R.Persona> = {}) {
  const sheet = b.sheet && typeof b.sheet === 'object' ? JSON.stringify(Object.fromEntries(SHEET_KEYS.map(k => [k, str(b.sheet[k], 4000)]))) : ex.sheet ?? '{}';
  // The build choices, kept as typed, so a character saved before the sheet is built comes back as it was left.
  const build = b.build && typeof b.build === 'object' ? JSON.stringify({ ...Object.fromEntries(BUILD_KEYS.map(k => [k, str(b.build[k], k === 'notes' ? 4000 : 300)])), chat: chatLines(b.build.chat) }) : ex.build ?? '{}';
  return { name: str(b.name ?? ex.name, 80).trim(), description: str(b.description ?? ex.description, 12000), look: str(b.look ?? ex.look, 3000), sheet, build, avatar: 'avatar' in b ? (b.avatar ? str(b.avatar, 400000) : null) : ex.avatar ?? null };
}
api.post('/personas', async c => {
  const f = personaFromBody(await body(c));
  if (!f.name) return bad(c, 'Give the character a name.');
  const id = db.prepare('insert into personas(user_id, name, description, look, sheet, build, avatar, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(A.me(c).id, f.name, f.description, f.look, f.sheet, f.build, f.avatar, now(), now()).lastInsertRowid;
  return c.json({ persona: R.getPersona(Number(id)) });
});
api.put('/personas/:pid', async c => {
  const ex = myPersona(c, num(c.req.param('pid')));
  if (!ex) return bad(c, 'Not found', 404);
  const f = personaFromBody(await body(c), ex);
  if (!f.name) return bad(c, 'Give the character a name.');
  db.prepare('update personas set name = ?, description = ?, look = ?, sheet = ?, build = ?, avatar = ?, updated_at = ? where id = ?').run(f.name, f.description, f.look, f.sheet, f.build, f.avatar, now(), ex.id);
  for (const s of db.prepare('select story_id from seats where persona_id = ?').all(ex.id) as { story_id: number }[]) broadcast(s.story_id, 'refresh', { what: 'party' });
  return c.json({ persona: R.getPersona(ex.id) });
});
api.delete('/personas/:pid', c => {
  const ex = myPersona(c, num(c.req.param('pid')));
  if (!ex) return bad(c, 'Not found', 404);
  db.prepare('delete from personas where id = ?').run(ex.id);
  return c.json({ ok: true });
});

// Saved worlds: anyone can use one; whoever saved it (or an admin) can change it.
api.post('/worlds', async c => {
  const b = await body(c);
  if (!str(b.name).trim()) return bad(c, 'Name the world.');
  const id = db.prepare('insert into bibles(user_id, name, text, created_at, updated_at) values (?, ?, ?, ?, ?)').run(A.me(c).id, str(b.name, 200).trim(), str(b.text, 40000), now(), now()).lastInsertRowid;
  return c.json({ world: db.prepare('select * from bibles where id = ?').get(id) });
});
api.put('/worlds/:wid', async c => {
  const w: any = db.prepare('select * from bibles where id = ?').get(num(c.req.param('wid')));
  if (!w) return bad(c, 'Not found', 404);
  if (w.user_id !== A.me(c).id && !isAdmin(c)) return bad(c, 'Only whoever saved this world can change it.', 403);
  const b = await body(c);
  db.prepare('update bibles set name = ?, text = ?, updated_at = ? where id = ?').run(str(b.name ?? w.name, 200).trim() || w.name, typeof b.text === 'string' ? str(b.text, 40000) : w.text, now(), w.id);
  return c.json({ world: db.prepare('select * from bibles where id = ?').get(w.id) });
});
api.delete('/worlds/:wid', c => {
  const w: any = db.prepare('select * from bibles where id = ?').get(num(c.req.param('wid')));
  if (!w) return bad(c, 'Not found', 404);
  if (w.user_id !== A.me(c).id && !isAdmin(c)) return bad(c, 'Only whoever saved this world can delete it.', 403);
  db.prepare('delete from bibles where id = ?').run(w.id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- helper jobs (not tied to a campaign): writing, sheets, portraits

const jobOwner = new Map<string, { userId: number; storyId: number | null }>();
let helperSeq = 0;
function helperJob(c: Context, kind: string, label: string, fn: (j: Job) => Promise<void>, storyId: number | null = null) {
  const j = startJob(-(++helperSeq), kind, label, fn);
  jobOwner.set(j.id, { userId: A.me(c).id, storyId });
  // Forgotten once the job itself is (jobs are kept two hours after they end).
  setTimeout(() => jobOwner.delete(j.id), 6 * 60 * 60 * 1000).unref?.();
  return c.json({ jobId: j.id });
}

api.post('/assist', async c => {
  const b = await body(c);
  const kind: AssistKind = b.kind === 'character' || b.kind === 'look' ? b.kind : 'world';
  const idea = str(b.idea, 6000), current = str(b.current, 40000);
  if (!idea.trim() && !current.trim()) return bad(c, 'Write a few words first.');
  return helperJob(c, 'assist', 'Writing', j => runAssist(j, { kind, idea, current, given: str(b.given, 4000) }));
});
api.post('/assist/sheet', async c => {
  const b = await body(c);
  return helperJob(c, 'assist', 'Building the sheet', j => runBuildSheet(j, {
    name: str(b.name, 80), species: str(b.species, 120), cls: str(b.cls, 120), subclass: str(b.subclass, 120), background: str(b.background, 120),
    level: Math.round(Number(b.level) || 1), scores: str(b.scores, 300), notes: str(b.notes, 3000), description: str(b.description, 6000), look: str(b.look, 2000),
  }));
});
// Making a character by talking it through: the Dungeon Master answers, and says what to change on the form.
api.post('/assist/character-chat', async c => {
  const b = await body(c);
  const lines = chatLines(b.lines);
  if (lines[lines.length - 1]?.role !== 'me') return bad(c, 'Say something first.');
  return helperJob(c, 'assist', 'Talking', j => runCharacterChat(j, { lines, draft: cleanDraft(b.draft), built: b.built === true }));
});
api.post('/assist/portrait', async c => {
  const b = await body(c);
  return helperJob(c, 'assist', 'Painting', j => runAvatar(j, { name: str(b.name, 80), look: str(b.look, 2000), role: str(b.role, 200), style: str(b.style, 20) || 'painterly' }));
});
// A level-up or a change to a library character's own sheet (outside any campaign).
api.post('/personas/:pid/sheet/ai', async c => {
  const p = myPersona(c, num(c.req.param('pid')));
  if (!p) return bad(c, 'Not found', 404);
  const b = await body(c);
  const kind = b.kind === 'levelup' ? 'levelup' : 'edit';
  return helperJob(c, 'assist', kind === 'levelup' ? 'Levelling up' : 'Changing the sheet', j => runSheetEdit(j, { kind, name: p.name, sheet: parseJson(p.sheet, {}), request: str(b.request, 3000) }));
});
api.post('/personas/:pid/sheet/chat', async c => {
  const p = myPersona(c, num(c.req.param('pid')));
  if (!p) return bad(c, 'Not found', 404);
  const b = await body(c);
  const lines = chatLines(b.lines);
  if (lines[lines.length - 1]?.role !== 'me') return bad(c, 'Say something first.');
  return helperJob(c, 'assist', 'Talking', j => runLevelChat(j, { name: p.name, sheet: parseJson(p.sheet, {}), lines, choices: str(b.choices, 4000) }));
});

// ---------------------------------------------------------------- campaigns

const inviteCode = () => {
  for (;;) {
    const code = Array.from(crypto.randomBytes(6), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
    if (!db.prepare('select 1 from stories where invite_code = ?').get(code)) return code;
  }
};

// A character brought to a table must have a sheet: one without (only a look, or nothing) would sit down blank.
const builtPersona = (c: Context, id: unknown) => {
  const p = id ? myPersona(c, Number(id)) : null;
  return p && R.sheetBuilt(p) ? p.id : null;
};

api.post('/stories', async c => {
  const b = await body(c);
  const title = str(b.title, 120).trim();
  if (!title) return bad(c, 'Name the campaign.');
  const settings = normalizeSettings(b.settings ?? defaultSettings());
  const id = db.prepare(`insert into stories(title, host_user_id, invite_code, bible, settings, summary_template, writer_conn_id, records_conn_id, created_at, updated_at) values (?, ?, ?, ?, ?, '', ?, ?, ?, ?)`)
    .run(title, A.me(c).id, inviteCode(), str(b.bible, 40000), JSON.stringify(settings), b.writer_conn_id || null, b.records_conn_id || null, now(), now()).lastInsertRowid as number;
  R.openChapter(id);
  const pid = builtPersona(c, b.persona_id);
  seat(id, A.me(c).id, pid);
  return c.json({ id });
});

api.post('/join', async c => {
  const b = await body(c);
  const code = str(b.code, 32).trim().toUpperCase();
  const story = db.prepare('select id from stories where invite_code = ? and archived = 0').get(code) as { id: number } | undefined;
  if (!story) return bad(c, 'No campaign has that invite code.', 404);
  const pid = builtPersona(c, b.persona_id);
  const had = seatOf(story.id, A.me(c).id);
  // From an invite link the character is only a default: someone already playing at this table keeps theirs.
  seat(story.id, A.me(c).id, b.keep_current && had?.persona_id ? had.persona_id : pid ?? had?.persona_id ?? null);
  return c.json({ id: story.id });
});

function passageView(p: R.Passage, host: boolean) {
  const t: any = p.turn_id ? db.prepare('select id, kind, plan, tools, usage, model, check_result, thinking, dice from turns where id = ?').get(p.turn_id) : null;
  return {
    ...p,
    turn: t ? {
      id: t.id, kind: t.kind, model: t.model, usage: parseJson(t.usage, {}), ...(host ? { dice: t.dice } : {}),
      ...(host ? { plan: t.plan, tools: parseJson(t.tools, []), check: parseJson(t.check_result, null), thinking: t.thinking } : { check: parseJson(t.check_result, null) ? [] : null }),
    } : null,
    changes: p.kind === 'prose' ? (host ? R.passageChanges(p.id) : forPlayers(R.passageChanges(p.id) as any[])) : [],
    cards: p.kind === 'prose' ? R.passageCards(p.id).map(cd => host ? cd : hideSecrets(cd)) : [],
    versions: host ? (db.prepare('select count(*) n from passage_versions where passage_id = ?').get(p.id) as any).n : 0,
  };
}
// What a player isn't told: a person's backstory may hold truths nobody at the table knows yet.
const hideSecrets = <T extends { type?: string; fields: Record<string, any>; what_changed?: string }>(cd: T): T => cd.type === 'user' || cd.type === 'scene' ? cd : { ...cd, what_changed: '', fields: { ...cd.fields, backstory: undefined } };
// The record changes a player is shown: none to the secrets ledger, and a person's card change by name only (the note on what
// changed can speak of what their backstory hides).
const forPlayers = <T extends { record: string; summary: string }>(xs: T[]): T[] => xs.filter(x => x.record !== 'ledger').map(x => x.record === 'card' ? { ...x, summary: x.summary.replace(/\s*\([\s\S]*\)\s*$/, '') } : x);

function scenesFor(chId: number) {
  const rows = db.prepare('select id, place, story_time, weather from scenes where id in (select distinct scene_id from passages where chapter_id = ? and scene_id is not null)').all(chId) as any[];
  return Object.fromEntries(rows.map(r => [r.id, r]));
}

// Who sits at the table, with each character's sheet as it stands in this campaign and whether they can level up.
function tableView(story: R.Story) {
  const acts = new Map((db.prepare('select * from actions where story_id = ?').all(story.id) as any[]).map(a => [a.user_id, a]));
  return R.listSeats(story.id).map(s => {
    const card = s.persona_id ? R.userCard(story.id, s.persona_id) : null;
    const levelTo = card ? levelEarned(story, card.fields) : null;
    const a = acts.get(s.user_id);
    return {
      user_id: s.user_id, player: s.display_name, username: s.username, status: s.status, host: s.user_id === story.host_user_id,
      persona_id: s.persona_id, name: card?.fields?.name || s.name, avatar: s.avatar, sheet: card ? { id: card.id, fields: card.fields, color: card.color } : null, levelUp: !!levelTo, levelTo,
      action: a ? { ready: !!a.ready, text: a.ready ? a.text : '', drafting: !a.ready && !!a.text, updated_at: a.updated_at } : null,
    };
  });
}

api.get('/stories/:id', c => {
  const story = campaign(c); if (failed(story)) return story;
  const host = isHost(c, story);
  const open = R.openChapter(story.id);
  const job = runningJob(story.id);
  const conns = R.storyConns(story);
  const mine = db.prepare('select text, ready from actions where story_id = ? and user_id = ?').get(story.id, A.me(c).id) as any;
  return c.json({
    story: { ...story, invite_code: story.invite_code },
    host, me: A.me(c).id, begun: begun(story.id), gameOver: gameOver(story.id),
    ...(host ? { guidance: getGuidance(story.id) } : {}),
    chapters: db.prepare('select id, number, title, status, summary, summary_status, arc_id, closed_at from chapters where story_id = ? order by number').all(story.id),
    openChapterId: open.id,
    passages: R.chapterPassages(open.id).map(p => passageView(p, host)), scenes: scenesFor(open.id), scene: R.getSceneState(story.id),
    table: tableView(story), online: online(story.id), myAction: mine ? { text: mine.text, ready: !!mine.ready } : null,
    job: job ? { id: job.id, kind: job.kind, label: job.label } : null,
    conns: { writer: conns.writer ? { id: conns.writer.id, name: conns.writer.name, model: conns.writer.model } : null, records: conns.records ? { id: conns.records.id, name: conns.records.name, model: conns.records.model } : null },
    art: artMap(story.id), imageConn: !!imageConn(),
    chat: (db.prepare(`select ch.id, ch.user_id, ch.text, ch.created_at, coalesce(nullif(u.display_name, ''), u.username) who from chat ch left join users u on u.id = ch.user_id where ch.story_id = ? order by ch.id desc limit 80`).all(story.id) as any[]).reverse(),
  });
});

api.get('/stories/:id/chapters/:cid', c => {
  const story = campaign(c); if (failed(story)) return story;
  const ch = R.getChapter(num(c.req.param('cid')));
  if (!ch || ch.story_id !== story.id) return bad(c, 'Not found', 404);
  return c.json({ chapter: ch, passages: R.chapterPassages(ch.id).map(p => passageView(p, isHost(c, story))), scenes: scenesFor(ch.id) });
});

api.put('/stories/:id', async c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  const b = await body(c);
  const settings = b.settings ? normalizeSettings({ ...story.settings, ...b.settings, toggles: { ...story.settings.toggles, ...(b.settings.toggles ?? {}) } }) : story.settings;
  db.prepare('update stories set title = ?, bible = ?, settings = ?, summary_template = ?, writer_conn_id = ?, records_conn_id = ?, archived = ?, updated_at = ? where id = ?').run(
    str(b.title ?? story.title, 120).trim() || story.title, typeof b.bible === 'string' ? str(b.bible, 40000) : story.bible, JSON.stringify(settings),
    typeof b.summary_template === 'string' ? str(b.summary_template, 4000) : story.summary_template,
    'writer_conn_id' in b ? (b.writer_conn_id || null) : story.writer_conn_id, 'records_conn_id' in b ? (b.records_conn_id || null) : story.records_conn_id,
    'archived' in b ? (b.archived ? 1 : 0) : story.archived, now(), story.id);
  if (b.new_code) db.prepare('update stories set invite_code = ? where id = ?').run(inviteCode(), story.id);
  broadcast(story.id, 'refresh', { what: 'story' });
  return c.json({ story: R.getStory(story.id) });
});

api.delete('/stories/:id', c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  if (runningJob(story.id)) return bad(c, 'Wait for the running job to finish.', 409);
  deleteStoryImages(story.id);
  db.prepare('delete from stories where id = ?').run(story.id);
  db.prepare('delete from app_kv where key = ?').run(guidanceKey(story.id));
  broadcast(story.id, 'deleted', {});
  return c.json({ ok: true });
});

// The host's guidance for the Dungeon Master: only the host reads or writes it, and it never goes out to the players' pages.
api.put('/stories/:id/guidance', async c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  const b = await c.req.json().catch(() => ({}));
  const text = str(b.text, 4000).trim();
  if (text) db.prepare('insert into app_kv(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(guidanceKey(story.id), text);
  else db.prepare('delete from app_kv where key = ?').run(guidanceKey(story.id));
  return c.json({ guidance: text });
});

// A player's own seat: which character they bring, and whether they are here or away. The host can change anyone's, or remove them.
api.put('/stories/:id/seat', async c => {
  const story = campaign(c); if (failed(story)) return story;
  const b = await body(c);
  const uid = b.user_id && isHost(c, story) ? Number(b.user_id) : A.me(c).id;
  const s = seatOf(story.id, uid);
  if (!s) return bad(c, 'Not at this table.', 404);
  if ('persona_id' in b) {
    const before = s.persona_id;
    const pid = b.persona_id ? Number(b.persona_id) : null;
    const p = pid ? R.getPersona(pid) : null;
    if (pid && (!p || p.user_id !== uid)) return bad(c, 'That character belongs to someone else.');
    if (pid && db.prepare('select 1 from seats where story_id = ? and persona_id = ? and user_id != ?').get(story.id, pid, uid)) return bad(c, 'That character is already at this table.');
    if (pid && !R.sheetBuilt(p)) return bad(c, 'Build that character\'s sheet first (My characters).');
    db.prepare('update seats set persona_id = ? where story_id = ? and user_id = ?').run(pid, story.id, uid);
    if (pid) ensureSheets(story.id);
    noteArrival(story.id, uid, before);
  }
  if (b.status === 'active' || b.status === 'away') db.prepare('update seats set status = ? where story_id = ? and user_id = ?').run(b.status, story.id, uid);
  broadcast(story.id, 'seats', {});
  maybeStartRound(story.id);
  return c.json({ ok: true });
});
api.delete('/stories/:id/seat/:uid', c => {
  const story = campaign(c); if (failed(story)) return story;
  const uid = num(c.req.param('uid'));
  if (uid !== A.me(c).id && !isHost(c, story)) return bad(c, 'Only the host can remove someone.', 403);
  if (uid === story.host_user_id) return bad(c, 'The host keeps their seat.');
  db.prepare('delete from seats where story_id = ? and user_id = ?').run(story.id, uid);
  db.prepare('delete from actions where story_id = ? and user_id = ?').run(story.id, uid);
  broadcast(story.id, 'seats', {});
  maybeStartRound(story.id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- the live line

api.get('/stories/:id/live', c => {
  const story = campaign(c); if (failed(story)) return story;
  const job = runningJob(story.id);
  return liveResponse(story.id, A.me(c).id, () => [
    { type: 'presence', data: { online: online(story.id) } },
    ...(job ? [{ type: 'job', data: { id: job.id, kind: job.kind, label: job.label } }] : []),
  ]);
});

api.post('/stories/:id/chat', async c => {
  const story = campaign(c); if (failed(story)) return story;
  const text = str((await body(c)).text, 2000).trim();
  if (!text) return bad(c, 'Say something first.');
  const id = db.prepare('insert into chat(story_id, user_id, text, created_at) values (?, ?, ?, ?)').run(story.id, A.me(c).id, text, now()).lastInsertRowid;
  const u = A.me(c);
  broadcast(story.id, 'chat', { id, user_id: u.id, who: u.display_name, text, created_at: now() });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- rounds

const touch = (id: number) => db.prepare('update stories set updated_at = ? where id = ?').run(now(), id);
const actionsView = (storyId: number) => tableView(R.getStory(storyId)!).map(t => ({ user_id: t.user_id, action: t.action, status: t.status }));

// Jobs that belong to a campaign: everyone at the table hears when one starts and ends.
function campaignJob(storyId: number, kind: string, label: string, fn: (j: Job) => Promise<void>) {
  touch(storyId);
  const j = startJob(storyId, kind, label, async job => {
    try { await fn(job); }
    finally {
      setTimeout(() => { broadcast(storyId, 'job_end', { id: job.id, kind, status: job.status }); maybeStartRound(storyId); }, 50);
    }
  });
  broadcast(storyId, 'job', { id: j.id, kind, label });
  return j;
}
function job(c: Context, story: R.Story, kind: string, label: string, fn: (j: Job) => Promise<void>) {
  return c.json({ jobId: campaignJob(story.id, kind, label, fn).id });
}

// The round is played once every active player with a character is ready (when the campaign starts rounds that way), or
// when the host says go. Ready with nothing written is passing.
function readyActions(storyId: number): { acts: RoundAction[]; users: number[] } {
  const party = R.party(storyId);
  const rows = db.prepare('select * from actions where story_id = ? and ready = 1').all(storyId) as any[];
  const acts: RoundAction[] = [], users: number[] = [];
  for (const m of party) {
    const a = rows.find(r => r.user_id === m.userId);
    if (!a) continue;
    users.push(a.user_id);
    if (a.text.trim()) acts.push({ personaId: m.personaId, name: m.name, player: m.player, text: a.text.trim() });
  }
  return { acts, users };
}

function startRound(storyId: number, why: string) {
  const { acts, users } = readyActions(storyId);
  const round = roundMarkup(acts);
  // The actions leave the table as the round starts; a round that fails before anything is written gives them back.
  const taken = users.map(u => db.prepare('select * from actions where story_id = ? and user_id = ?').get(storyId, u) as any);
  for (const u of users) db.prepare('delete from actions where story_id = ? and user_id = ?').run(storyId, u);
  broadcast(storyId, 'actions', { actions: actionsView(storyId) });
  const before = Number(db.prepare('select coalesce(max(id), 0) from turns').pluck().get());
  return campaignJob(storyId, 'turn', why, async j => {
    try { await runTurn(j, storyId, { round, mode: 'write' }); }
    catch (e) {
      // Nothing was written for the round: the actions go back to their players, to send again.
      if (!db.prepare('select 1 from turns where story_id = ? and id > ? and passage_id is not null').get(storyId, before)) {
        for (const a of taken) db.prepare(`insert into actions(story_id, user_id, text, ready, updated_at) values (?, ?, ?, 0, ?) on conflict(story_id, user_id) do nothing`).run(storyId, a.user_id, a.text, now());
        broadcast(storyId, 'actions', { actions: actionsView(storyId) });
      }
      throw e;
    }
  });
}

function maybeStartRound(storyId: number): Job | null {
  const story = R.getStory(storyId);
  if (!story || story.archived || story.settings.auto_go !== 'all_ready' || runningJob(storyId) || !R.storyConns(story).writer || !begun(storyId) || gameOver(storyId)) return null;
  const party = R.party(storyId).filter(m => m.status === 'active');
  if (!party.length) return null;
  const ready = new Set((db.prepare('select user_id, text from actions where story_id = ? and ready = 1').all(storyId) as any[]).map(a => a.user_id));
  const someText = db.prepare(`select 1 from actions where story_id = ? and ready = 1 and trim(text) != ''`).get(storyId);
  return someText && party.every(m => ready.has(m.userId)) ? startRound(storyId, 'Playing the round') : null;
}

api.put('/stories/:id/action', async c => {
  const story = campaign(c); if (failed(story)) return story;
  const s = seatOf(story.id, A.me(c).id);
  if (!s?.persona_id) return bad(c, 'Bring a character to the table first.');
  if (!begun(story.id)) return bad(c, "The campaign hasn't begun yet: the host begins it once everyone is at the table.", 409);
  if (gameOver(story.id)) return bad(c, GAME_OVER, 409);
  const b = await body(c);
  const text = str(b.text, 6000);
  const ready = b.ready ? 1 : 0;
  db.prepare(`insert into actions(story_id, user_id, text, ready, updated_at) values (?, ?, ?, ?, ?)
    on conflict(story_id, user_id) do update set text = excluded.text, ready = excluded.ready, updated_at = excluded.updated_at`).run(story.id, A.me(c).id, text, ready, now());
  // Being here and playing means not away.
  if (s.status === 'away' && ready) db.prepare(`update seats set status = 'active' where story_id = ? and user_id = ?`).run(story.id, A.me(c).id);
  broadcast(story.id, 'actions', { actions: actionsView(story.id) });
  // The answer says whether this started the round, which took the action off the table.
  const started = maybeStartRound(story.id);
  return c.json({ ok: true, started: !!started });
});

// The host begins the campaign once the table is gathered: the Dungeon Master writes the opening scene, bringing in every
// character seated, and the first round follows it.
api.post('/stories/:id/begin', async c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  if (runningJob(story.id)) return bad(c, 'The Dungeon Master is already writing.', 409);
  if (begun(story.id)) return bad(c, 'The campaign has already begun.', 409);
  if (!R.storyConns(story).writer) return bad(c, 'Set a Dungeon Master connection first.');
  if (!R.party(story.id).length) return bad(c, 'Nobody has brought a character to the table yet.');
  const note = str((await body(c)).note, 4000);
  // Nothing anyone readied before the opening plays as a round right after it.
  db.prepare('update actions set ready = 0 where story_id = ?').run(story.id);
  broadcast(story.id, 'actions', { actions: actionsView(story.id) });
  return job(c, story, 'turn', 'Opening the campaign', j => runTurn(j, story.id, { round: openingRound(note), mode: 'write' }));
});

api.post('/stories/:id/go', c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  if (runningJob(story.id)) return bad(c, 'The Dungeon Master is already writing.', 409);
  if (!begun(story.id)) return bad(c, 'Begin the campaign first.', 409);
  if (gameOver(story.id)) return bad(c, GAME_OVER, 409);
  return c.json({ jobId: startRound(story.id, 'Playing the round').id });
});

// After a game over, the host picks: back to before the fight, back one round, or carry on as things stand.
api.post('/stories/:id/gameover', async c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  if (runningJob(story.id)) return bad(c, 'Wait for the Dungeon Master to finish.', 409);
  const what = str((await body(c)).do, 20);
  if (what === 'carry_on') {
    db.prepare('insert into app_kv(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(ackKey(story.id), now());
    broadcast(story.id, 'refresh', { what: 'party' });
    return c.json({ ok: true });
  }
  const from = what === 'fight' ? fightStart(story.id) : what === 'round' ? lastRoundStart(story.id) : null;
  if (from == null) return bad(c, what === 'fight' ? 'No fight to go back to in this chapter.' : 'Nothing to go back to.');
  // The opening stays: going back past it would un-begin the campaign.
  const ch = R.openChapter(story.id);
  if (!db.prepare(`select 1 from passages where story_id = ? and kind = 'prose' and not (chapter_id = ? and seq >= ?) limit 1`).get(story.id, ch.id, from))
    return bad(c, 'That would undo the opening scene. Delete passages one by one instead.');
  const removed = rewindTo(story.id, from);
  broadcast(story.id, 'refresh', { what: 'passages' });
  broadcast(story.id, 'actions', { actions: actionsView(story.id) });
  return c.json({ ok: true, removed });
});

api.post('/stories/:id/retry', async c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  const b = await body(c);
  return job(c, story, 'turn', 'Writing the round again', j => runTurn(j, story.id, { round: '', mode: 'retry', note: str(b.note, 2000) }));
});
api.post('/stories/:id/continue', c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  if (gameOver(story.id)) return bad(c, GAME_OVER, 409);
  return job(c, story, 'turn', 'Continuing', j => runContinue(j, story.id));
});
api.post('/stories/:id/fix', async c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  const b = await body(c);
  if (!str(b.correction).trim()) return bad(c, 'Write the correction first.');
  return job(c, story, 'fix', b.chapterId ? 'Rewriting the chapter' : 'Rewriting', j => runFix(j, story.id, { passageIds: b.passageIds, chapterId: b.chapterId, correction: str(b.correction, 6000), recheck: !!b.recheck }));
});
api.post('/stories/:id/keep', c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  return job(c, story, 'records', 'Keeping records', async j => { await flushPendingRecords(j, R.getStory(story.id)!); });
});
api.post('/stories/:id/chapter/close', async c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  const b = await body(c);
  return job(c, story, 'chapter', 'Closing the chapter', j => closeChapter(j, story.id, b.title ? str(b.title, 200) : undefined));
});
api.post('/stories/:id/arc/close', c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  return job(c, story, 'arc', 'Rolling up an arc', async j => { await rollupArc(j, story.id); });
});
api.post('/chapters/:chid/summary/redo', async c => {
  const ch = R.getChapter(num(c.req.param('chid')));
  const story = ch ? R.getStory(ch.story_id) : null;
  if (!ch || !isHost(c, story)) return bad(c, 'Not found', 404);
  const b = await body(c);
  return job(c, story!, 'summary', 'Rewriting the summary', async j => { await summarizeChapter(j, R.getStory(ch.story_id)!, ch, { note: b.note, title: ch.title }); });
});
api.put('/chapters/:chid', async c => {
  const ch = R.getChapter(num(c.req.param('chid')));
  if (!ch || !isHost(c, R.getStory(ch.story_id))) return bad(c, 'Not found', 404);
  const b = await body(c);
  db.prepare('update chapters set title = ?, summary = ?, summary_status = ? where id = ?').run(b.title ?? ch.title, b.summary ?? ch.summary, b.summary_status ?? (b.summary != null ? 'saved' : ch.summary_status), ch.id);
  return c.json({ chapter: R.getChapter(ch.id) });
});

// Milestone levelling: the host lifts the party to the next level, and each player levels up their own character.
api.post('/stories/:id/milestone', c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  const top = Math.max(1, ...R.party(story.id).map(m => parseInt(String(m.card?.fields?.level ?? '1')) || 1));
  db.prepare('insert into app_kv(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(`milestone:${story.id}`, String(Math.min(20, top + 1)));
  R.addPassage(story.id, R.openChapter(story.id).id, 'note', `The party reached a milestone: every character can rise to level ${Math.min(20, top + 1)}.`);
  broadcast(story.id, 'refresh', { what: 'party' });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- passages

const passageStory = (c: Context, host = true) => {
  const p = R.getPassage(num(c.req.param('pid')));
  const story = p ? R.getStory(p.story_id) : null;
  if (!p || !canSee(c, story) || (host && !isHost(c, story))) return null;
  return { p, story: story! };
};
api.put('/passages/:pid', async c => {
  const x = passageStory(c); if (!x) return bad(c, 'Not found', 404);
  const b = await body(c);
  if (typeof b.text === 'string') R.setPassageText(x.p.id, str(b.text, 60000), 'hand edit');
  broadcast(x.story.id, 'refresh', { what: 'passages' });
  return c.json({ passage: passageView(R.getPassage(x.p.id)!, true) });
});
api.delete('/passages/:pid', c => {
  const x = passageStory(c); if (!x) return bad(c, 'Not found', 404);
  if (runningJob(x.story.id)) return bad(c, 'Wait for the running job to finish.', 409);
  R.undoPassageChanges(x.story.id, [x.p.id]);
  db.prepare('delete from passages where id = ?').run(x.p.id);
  broadcast(x.story.id, 'refresh', { what: 'passages' });
  return c.json({ ok: true });
});
api.get('/passages/:pid/versions', c => {
  const x = passageStory(c); if (!x) return bad(c, 'Not found', 404);
  return c.json({ versions: db.prepare('select * from passage_versions where passage_id = ? order by id desc').all(x.p.id) });
});
api.post('/passages/:pid/revert', async c => {
  const x = passageStory(c); if (!x) return bad(c, 'Not found', 404);
  const { versionId } = await body(c);
  const v: any = db.prepare('select * from passage_versions where id = ? and passage_id = ?').get(versionId, x.p.id);
  if (!v) return bad(c, 'Not found', 404);
  R.setPassageText(x.p.id, v.text, 'revert');
  broadcast(x.story.id, 'refresh', { what: 'passages' });
  return c.json({ passage: passageView(R.getPassage(x.p.id)!, true) });
});
api.post('/passages/:pid/redo-records', c => {
  const x = passageStory(c); if (!x) return bad(c, 'Not found', 404);
  return job(c, x.story, 'records', 'Redoing records', j => runRedoRecords(j, x.story.id, x.p.id));
});
api.post('/passages/:pid/keep', c => {
  const x = passageStory(c); if (!x) return bad(c, 'Not found', 404);
  return job(c, x.story, 'records', 'Keeping records', async j => { await runRecords(j, R.getStory(x.story.id)!, [x.p.id], { turnId: x.p.turn_id }); });
});
// Anyone at the table can have a passage painted.
api.post('/passages/:pid/paint', async c => {
  const x = passageStory(c, false); if (!x) return bad(c, 'Not found', 404);
  if (!imageConn()) return bad(c, 'No Images connection is set up.');
  const redo = !!(await body(c)).redo;
  if (!enqueueSceneArt(x.story, x.p.id, redo)) return bad(c, 'Only a passage of the story can be painted.');
  broadcast(x.story.id, 'art', {});
  return c.json({ ok: true, key: sceneKey(x.p.id) });
});

// ---------------------------------------------------------------- sheets in a campaign

// A character's sheet in this campaign: its player (or the host) can change it by hand, level it up, or ask for a change.
function sheetFor(c: Context, story: R.Story, personaId: number) {
  const s = R.listSeats(story.id).find(x => x.persona_id === personaId);
  if (!s) return null;
  if (s.user_id !== A.me(c).id && !isHost(c, story)) return null;
  return { seat: s, card: R.userCard(story.id, personaId) };
}
api.put('/stories/:id/sheets/:pid', async c => {
  const story = campaign(c); if (failed(story)) return story;
  const x = sheetFor(c, story, num(c.req.param('pid')));
  if (!x?.card) return bad(c, 'Not your character.', 403);
  const b = await body(c);
  const fields: R.UserFields = { ...x.card.fields };
  for (const d of SHEET) if (typeof b.fields?.[d.key] === 'string') fields[d.key] = str(b.fields[d.key], 4000);
  if (typeof b.fields?.name === 'string' && b.fields.name.trim()) fields.name = str(b.fields.name, 80).trim();
  const why = str(b.what_changed, 300).trim() || 'edited by hand';
  R.setUserCard({ storyId: story.id, passageId: null, turnId: null }, x.card.persona_id, fields, `${why} (by ${A.me(c).display_name})`, 'Sheet');
  // A level-up or a change of what the character can do is news the Dungeon Master needs.
  if (b.announce) R.addPassage(story.id, R.openChapter(story.id).id, 'note', `${fields.name}: ${clip(why, 400)}`);
  if (typeof b.color === 'string') R.setCardColor(x.card.id, b.color);
  broadcast(story.id, 'refresh', { what: 'party' });
  return c.json({ ok: true });
});
api.post('/stories/:id/sheets/:pid/ai', async c => {
  const story = campaign(c); if (failed(story)) return story;
  const x = sheetFor(c, story, num(c.req.param('pid')));
  if (!x?.card) return bad(c, 'Not your character.', 403);
  const b = await body(c);
  const kind = b.kind === 'levelup' ? 'levelup' : 'edit';
  const recent = R.storyProse(story.id).slice(-3).map(p => p.text).join('\n\n').slice(-3000);
  return helperJob(c, 'assist', kind === 'levelup' ? 'Levelling up' : 'Changing the sheet', j => runSheetEdit(j, { kind, name: x.card.fields.name, sheet: x.card.fields, request: str(b.request, 3000), context: recent }), story.id);
});
// Talking a level-up through with the Dungeon Master, with what has happened in the campaign to guide the picks.
api.post('/stories/:id/sheets/:pid/chat', async c => {
  const story = campaign(c); if (failed(story)) return story;
  const x = sheetFor(c, story, num(c.req.param('pid')));
  if (!x?.card) return bad(c, 'Not your character.', 403);
  const b = await body(c);
  const lines = chatLines(b.lines);
  if (lines[lines.length - 1]?.role !== 'me') return bad(c, 'Say something first.');
  const recent = R.storyProse(story.id).slice(-3).map(p => p.text).join('\n\n').slice(-3000);
  return helperJob(c, 'assist', 'Talking', j => runLevelChat(j, { name: x.card.fields.name, sheet: x.card.fields, lines, choices: str(b.choices, 4000), context: recent }), story.id);
});
// The campaign's sheet goes back to the character's library, so the next campaign starts from where this one left them.
api.post('/stories/:id/sheets/:pid/save', c => {
  const story = campaign(c); if (failed(story)) return story;
  const x = sheetFor(c, story, num(c.req.param('pid')));
  const p = R.getPersona(num(c.req.param('pid')));
  if (!x?.card || !p || p.user_id !== A.me(c).id) return bad(c, 'Not your character.', 403);
  const sheet = Object.fromEntries(SHEET_KEYS.map(k => [k, String(x.card.fields[k] ?? '')]));
  db.prepare('update personas set sheet = ?, name = ?, updated_at = ? where id = ?').run(JSON.stringify(sheet), x.card.fields.name || p.name, now(), p.id);
  return c.json({ ok: true });
});
// The library character's sheet into this campaign again, as it stands in the library now.
api.post('/stories/:id/sheets/:pid/reload', c => {
  const story = campaign(c); if (failed(story)) return story;
  const x = sheetFor(c, story, num(c.req.param('pid')));
  const p = R.getPersona(num(c.req.param('pid')));
  if (!x || !p || (p.user_id !== A.me(c).id && !isHost(c, story))) return bad(c, 'Not your character.', 403);
  R.setUserCard({ storyId: story.id, passageId: null, turnId: null }, p.id, sheetFields(p), `sheet loaded from the library (by ${A.me(c).display_name})`, 'Sheet');
  broadcast(story.id, 'refresh', { what: 'party' });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- records

api.get('/stories/:id/records', c => {
  const story = campaign(c); if (failed(story)) return story;
  const host = isHost(c, story);
  const cards = R.listCards(story.id).map(cd => ({ ...cd, versions: (db.prepare('select count(*) n from card_versions where card_id = ?').get(cd.id) as any).n }))
    .map(cd => host ? cd : { ...cd, fields: { ...cd.fields, backstory: undefined } });
  const changes = (db.prepare('select id, passage_id, record, op, summary, undone, created_at from record_changes where story_id = ? order by id desc limit 300').all(story.id) as any[]);
  const shownChanges = host ? changes : forPlayers(changes);
  return c.json({
    cards, ledger: host ? R.listLedger(story.id) : [], facts: (db.prepare(`select * from facts where story_id = ? and status != 'rejected' order by id`).all(story.id) as any[]).map(f => ({ ...f, about: parseJson(f.about, []) })),
    threads: R.listThreads(story.id), scene: R.getSceneState(story.id), changes: shownChanges, host, npcFields: NPC,
  });
});
const hostOf = (c: Context, storyId: number | undefined) => { const s = storyId ? R.getStory(storyId) : null; return isHost(c, s) ? s : null; };
api.post('/stories/:id/cards', async c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  const b = await body(c);
  const fields: R.UserFields = { name: str(b.fields?.name, 120).trim() };
  for (const d of NPC) if (d.key !== 'name') fields[d.key] = str(b.fields?.[d.key], 4000);
  if (!fields.name) return bad(c, 'Name is required.');
  R.createCard({ storyId: story.id, passageId: null, turnId: null }, fields, Array.isArray(b.aliases) ? b.aliases.map((x: any) => str(x, 80)) : []);
  enqueuePortraits(story.id);
  return c.json({ ok: true });
});
api.put('/cards/:cid', async c => {
  const card: any = db.prepare('select * from cards where id = ?').get(num(c.req.param('cid')));
  if (!card || !hostOf(c, card.story_id)) return bad(c, 'Not found', 404);
  const b = await body(c);
  if (Array.isArray(b.aliases)) db.prepare('update cards set aliases = ? where id = ?').run(JSON.stringify(b.aliases.map((x: any) => str(x, 80))), card.id);
  if (typeof b.color === 'string') R.setCardColor(card.id, b.color);
  if (b.fields) R.updateCard({ storyId: card.story_id, passageId: null, turnId: null }, card, b.fields, str(b.what_changed, 200) || 'edited by hand', card.kind === 'user' ? 'Sheet' : 'Card');
  return c.json({ ok: true });
});
api.delete('/cards/:cid', c => {
  const card: any = db.prepare('select * from cards where id = ?').get(num(c.req.param('cid')));
  if (!card || !hostOf(c, card.story_id)) return bad(c, 'Not found', 404);
  db.prepare('update cards set deleted = 1 where id = ?').run(card.id);
  return c.json({ ok: true });
});
api.post('/stories/:id/ledger', async c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  const b = await body(c);
  R.upsertLedger({ storyId: story.id, passageId: null, turnId: null }, { id: b.id, fact: str(b.fact, 1000), known_by: b.known_by ?? [], not_known_by: b.not_known_by ?? [], status: b.status }, 'edited by hand');
  return c.json({ ok: true });
});
api.delete('/ledger/:lid', c => {
  const r: any = db.prepare('select story_id from ledger where id = ?').get(num(c.req.param('lid')));
  if (!r || !hostOf(c, r.story_id)) return bad(c, 'Not found', 404);
  db.prepare('delete from ledger where id = ?').run(num(c.req.param('lid')));
  return c.json({ ok: true });
});
api.post('/stories/:id/facts', async c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  const b = await body(c);
  if (b.id) db.prepare('update facts set text = ?, about = ?, status = coalesce(?, status) where id = ? and story_id = ?').run(str(b.text, 1000), JSON.stringify(b.about ?? []), b.status ?? null, b.id, story.id);
  else R.addFact({ storyId: story.id, passageId: null, turnId: null }, str(b.text, 1000), b.about ?? [], 'new');
  return c.json({ ok: true });
});
api.post('/facts/:fid/resolve', async c => {
  const f: any = db.prepare('select story_id from facts where id = ?').get(num(c.req.param('fid')));
  if (!f || !hostOf(c, f.story_id)) return bad(c, 'Not found', 404);
  const { action } = await body(c);
  R.resolveConflict(f.story_id, num(c.req.param('fid')), action);
  return c.json({ ok: true });
});
api.delete('/facts/:fid', c => {
  const f: any = db.prepare('select story_id from facts where id = ?').get(num(c.req.param('fid')));
  if (!f || !hostOf(c, f.story_id)) return bad(c, 'Not found', 404);
  db.prepare('delete from facts where id = ?').run(num(c.req.param('fid')));
  return c.json({ ok: true });
});
api.post('/stories/:id/threads', async c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  const b = await body(c);
  if (b.id) db.prepare('update threads set text = ?, status = ? where id = ? and story_id = ?').run(str(b.text, 1000), b.status ?? 'open', b.id, story.id);
  else R.setThread({ storyId: story.id, passageId: null, turnId: null }, 'open', str(b.text, 1000));
  return c.json({ ok: true });
});
api.delete('/threads/:tid', c => {
  const t: any = db.prepare('select story_id from threads where id = ?').get(num(c.req.param('tid')));
  if (!t || !hostOf(c, t.story_id)) return bad(c, 'Not found', 404);
  db.prepare('delete from threads where id = ?').run(num(c.req.param('tid')));
  return c.json({ ok: true });
});
api.put('/stories/:id/scene', async c => {
  const story = campaign(c, { host: true }); if (failed(story)) return story;
  const b = await body(c);
  db.prepare(`insert into scene_state(story_id, place, story_time, weather, initiative, present) values (?, ?, ?, ?, ?, ?)
    on conflict(story_id) do update set place = excluded.place, story_time = excluded.story_time, weather = excluded.weather, initiative = excluded.initiative, present = excluded.present`)
    .run(story.id, str(b.place, 300), str(b.story_time, 200), str(b.weather, 200), str(b.initiative, 500), JSON.stringify(Array.isArray(b.present) ? b.present : []));
  broadcast(story.id, 'refresh', { what: 'scene' });
  return c.json({ ok: true });
});
api.post('/changes/:chid/undo', c => {
  const ch: any = db.prepare('select story_id from record_changes where id = ?').get(num(c.req.param('chid')));
  if (!ch || !hostOf(c, ch.story_id)) return bad(c, 'Not found', 404);
  const r = R.undoChange(num(c.req.param('chid')));
  if (r.ok) broadcast(ch.story_id, 'refresh', { what: 'party' });
  return r.ok ? c.json({ ok: true }) : bad(c, r.error!, 409);
});

// ---------------------------------------------------------------- art

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
api.get('/art/:aid', async c => {
  const a = getAsset(num(c.req.param('aid')));
  if (!a?.file || !canSee(c, R.getStory(a.story_id)) || !fs.existsSync(assetPath(a))) return bad(c, 'Not found', 404);
  const w = ART_WIDTHS.find(x => x === Number(c.req.query('w')));
  const small = w ? await sizedFile(assetPath(a), w) : null;
  const buf = await fs.promises.readFile(small ?? assetPath(a));
  return new Response(buf, { headers: { 'content-type': small ? 'image/webp' : MIME[a.file.split('.').pop() ?? ''] ?? 'image/png', 'cache-control': 'private, max-age=31536000, immutable' } });
});
api.get('/stories/:id/art', c => {
  const story = campaign(c); if (failed(story)) return story;
  return c.json({ art: artMap(story.id), imageConn: !!imageConn() });
});
api.post('/assets/:aid/redo', async c => {
  const a = getAsset(num(c.req.param('aid')));
  if (!a || !canSee(c, R.getStory(a.story_id))) return bad(c, 'Not found', 404);
  redoAsset(a, (await body(c)).prompt);
  broadcast(a.story_id, 'art', {});
  return c.json({ ok: true });
});
api.delete('/assets/:aid', c => {
  const a = getAsset(num(c.req.param('aid')));
  if (!a || !hostOf(c, a.story_id)) return bad(c, 'Not found', 404);
  deleteAsset(a);
  broadcast(a.story_id, 'art', {});
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- jobs

// What a player sees of a turn as it is written: the passage as it comes, and what changed, but not the Dungeon Master's
// notes, thinking or lookups (they can hold secrets), and the people's cards without their hidden backstory.
const PLAYER_HIDDEN = new Set(['plan', 'thinking', 'tool']);
const playerView = (e: JobEvent): JobEvent | null => {
  if (PLAYER_HIDDEN.has(e.type)) return null;
  if (e.type === 'changes') return { ...e, data: { ...e.data, changes: forPlayers(e.data.changes ?? []), cards: (e.data.cards ?? []).map(hideSecrets) } };
  if (e.type === 'check') return { ...e, data: { passageId: e.data.passageId, problems: [] } };
  return e;
};
function jobAccess(c: Context, j: Job): 'host' | 'player' | null {
  const owner = jobOwner.get(j.id);
  if (owner) return owner.userId === A.me(c).id || isAdmin(c) ? 'host' : null;
  const story = R.getStory(j.storyId);
  if (!canSee(c, story)) return null;
  return isHost(c, story) ? 'host' : 'player';
}
api.get('/jobs/:jid/events', c => {
  const j = getJob(c.req.param('jid'));
  const access = j && jobAccess(c, j);
  if (!j || !access) return bad(c, 'Job not found (it may have finished a while ago).', 404);
  const lei = c.req.header('last-event-id');
  const from = lei != null && lei !== '' ? Number(lei) + 1 : Number(c.req.query('from') ?? 0) || 0;
  return sseResponse(j, Math.max(0, from), access === 'host' ? undefined : playerView);
});
api.get('/jobs/:jid', c => {
  const j = getJob(c.req.param('jid'));
  return j && jobAccess(c, j) ? c.json({ status: j.status, kind: j.kind, label: j.label }) : bad(c, 'Job not found.', 404);
});
api.post('/jobs/:jid/stop', c => {
  const j = getJob(c.req.param('jid'));
  if (!j || jobAccess(c, j) !== 'host') return bad(c, 'Only the host can stop that.', 403);
  stopJob(j.id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- the narrator's voice

// A passage is read aloud only to someone at its table.
api.use('/voice/passage/:vid/*', async (c, next) => {
  const p = R.getPassage(num(c.req.param('vid')));
  if (!p || !canSee(c, R.getStory(p.story_id))) return bad(c, 'Not found', 404);
  await next();
});
api.use('/voice/passage/:vid', async (c, next) => {
  const p = R.getPassage(num(c.req.param('vid')));
  if (!p || !canSee(c, R.getStory(p.story_id))) return bad(c, 'Not found', 404);
  await next();
});
api.route('/voice', voiceApi);

// ---------------------------------------------------------------- export

function mdText(t: string) {
  return t
    .replace(/<\/?font[^>]*>/g, '')
    .replace(/<scene>([^<]*)<\/scene>/g, (_, x: string) => { const [place, ...when] = x.split('|').map(v => v.trim()); return `**${place}**${when.filter(Boolean).length ? ` · *${when.filter(Boolean).join(' · ')}*` : ''}`; })
    .replace(/<roll>([^<]*)<\/roll>/g, (_, x: string) => { const [who, check, what, die, mod, total, vs, ...res] = x.split('|').map(v => v.trim()); return `> **${who}**, ${check}: ${what}. d20 ${die} ${mod} = ${total} vs ${vs}: **${res.join(' | ')}**`; })
    .replace(/<ruling>([^<]*)<\/ruling>/g, (_, x: string) => { const [who, ...said] = x.split('|').map(v => v.trim()); return said.length ? `> *Ruling, ${who}:* ${said.join(' ')}` : `> *Ruling:* ${who}`; })
    .replace(/<action by="([^"]*)">\s*([\s\S]*?)\s*<\/action>/g, (_, who: string, text: string) => `> *${who}:* ${text.replace(/\n+/g, ' ')}`);
}
api.get('/stories/:id/export', c => {
  const story = campaign(c); if (failed(story)) return story;
  const safe = story.title.replace(/[^\w\- ]+/g, '').trim() || 'campaign';
  const chapters = db.prepare('select * from chapters where story_id = ? order by number').all(story.id) as R.Chapter[];
  const md = [`# ${story.title}`, ''];
  for (const ch of chapters) {
    const ps = R.chapterPassages(ch.id).filter(p => p.kind === 'prose' || p.kind === 'direction');
    if (!ps.some(p => p.kind === 'prose')) continue;
    md.push(`## Chapter ${ch.number}${ch.title ? `: ${ch.title}` : ''}`, '');
    for (const p of ps) md.push(mdText(p.text), '');
  }
  return new Response(md.join('\n'), { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${safe}.md"` } });
});
