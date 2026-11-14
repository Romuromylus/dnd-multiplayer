import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

fs.mkdirSync(config.dataDir, { recursive: true });
// The old app's dnd.db may still sit in the same volume; this one is a new file and never reads it.
export const db = new Database(path.join(config.dataDir, 'table.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// A "story" is a campaign, and a "persona" is a player's character: the records engine came from Inkwell and keeps its words.
db.exec(`
create table if not exists app_kv (key text primary key, value text);

create table if not exists users (
  id integer primary key autoincrement,
  username text not null unique collate nocase,
  display_name text not null default '',
  pass_hash text not null,
  role text not null default 'player',
  prefs text not null default '{}',
  created_at text, updated_at text
);

create table if not exists auth_sessions (
  token_hash text primary key,
  user_id integer not null references users(id) on delete cascade,
  created_at text not null,
  seen_at text not null
);

-- A player's characters. sheet is the starting sheet (JSON fields); a campaign keeps its own copy as a card that changes in play.
create table if not exists personas (
  id integer primary key autoincrement,
  user_id integer references users(id) on delete cascade,
  name text not null,
  description text not null default '',
  look text not null default '',
  sheet text not null default '{}',
  avatar text,
  created_at text, updated_at text
);

-- Saved worlds to start campaigns from. A campaign has its own copy.
create table if not exists bibles (
  id integer primary key autoincrement,
  user_id integer references users(id) on delete set null,
  name text not null,
  text text not null default '',
  created_at text, updated_at text
);

create table if not exists connections (
  id integer primary key autoincrement,
  name text not null,
  api_type text not null default 'anthropic',
  endpoint text not null,
  api_key_enc text,
  key_last4 text,
  model text not null,
  thinking_level text not null default 'high',
  show_thinking integer not null default 1,
  max_tokens integer not null default 32000,
  post_processing text not null default 'none',
  caching integer not null default 1,
  default_role text not null default 'none',
  created_at text, updated_at text
);

create table if not exists stories (
  id integer primary key autoincrement,
  title text not null,
  persona_id integer,
  host_user_id integer references users(id) on delete set null,
  invite_code text not null default '',
  bible text not null default '',
  settings text not null default '{}',
  summary_template text not null default '',
  writer_conn_id integer references connections(id) on delete set null,
  records_conn_id integer references connections(id) on delete set null,
  archived integer not null default 0,
  created_at text, updated_at text
);

-- Who sits at a campaign's table, with which character (none: watching). status 'active' or 'away'.
create table if not exists seats (
  story_id integer not null references stories(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  persona_id integer references personas(id) on delete set null,
  status text not null default 'active',
  joined_at text,
  primary key (story_id, user_id)
);

-- What each player says their character does this round, until the round is played.
create table if not exists actions (
  story_id integer not null references stories(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  text text not null default '',
  ready integer not null default 0,
  updated_at text,
  primary key (story_id, user_id)
);

-- Table talk between the players, which the Game Master never reads.
create table if not exists chat (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  user_id integer references users(id) on delete set null,
  text text not null,
  created_at text
);
create index if not exists chat_story on chat(story_id, id);

create table if not exists chapters (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  number integer not null,
  title text not null default '',
  status text not null default 'open',
  summary text not null default '',
  summary_status text not null default '',
  arc_id integer,
  plan text not null default '',
  closed_at text, created_at text
);

create table if not exists arcs (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  first_chapter integer not null,
  last_chapter integer not null,
  title text not null default '',
  summary text not null default '',
  created_at text
);

create table if not exists scenes (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  chapter_id integer references chapters(id) on delete cascade,
  place text not null default '',
  story_time text not null default '',
  weather text not null default '',
  summary text not null default '',
  summary_upto integer,
  created_at text
);

create table if not exists passages (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  chapter_id integer not null references chapters(id) on delete cascade,
  scene_id integer references scenes(id) on delete set null,
  seq integer not null,
  kind text not null default 'prose',
  text text not null default '',
  beat text,
  cut integer not null default 0,
  records_status text not null default 'none',
  turn_id integer,
  persona_id integer,
  vn text,
  created_at text, updated_at text
);
create index if not exists passages_story on passages(story_id, chapter_id, seq);

create table if not exists passage_versions (
  id integer primary key autoincrement,
  passage_id integer not null references passages(id) on delete cascade,
  text text not null,
  reason text not null default '',
  created_at text
);

create virtual table if not exists passages_fts using fts5(
  text, content='passages', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
);
create trigger if not exists passages_ai after insert on passages begin
  insert into passages_fts(rowid, text) values (new.id, new.text);
end;
create trigger if not exists passages_ad after delete on passages begin
  insert into passages_fts(passages_fts, rowid, text) values ('delete', old.id, old.text);
end;
create trigger if not exists passages_au after update of text on passages begin
  insert into passages_fts(passages_fts, rowid, text) values ('delete', old.id, old.text);
  insert into passages_fts(rowid, text) values (new.id, new.text);
end;

create table if not exists turns (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  passage_id integer,
  kind text not null default 'write',
  direction text not null default '',
  plan text not null default '',
  tools text not null default '[]',
  thinking text not null default '',
  check_result text,
  usage text not null default '{}',
  model text not null default '',
  error text,
  dice text not null default '',
  created_at text
);

create table if not exists cards (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  name text not null,
  kind text not null default 'npc',
  persona_id integer,
  aliases text not null default '[]',
  current_version_id integer,
  deleted integer not null default 0,
  last_seen_passage integer,
  color text not null default '',
  created_at text
);
create index if not exists cards_story on cards(story_id);

create table if not exists card_versions (
  id integer primary key autoincrement,
  card_id integer not null references cards(id) on delete cascade,
  fields text not null,
  changed_in_passage integer,
  what_changed text not null default '',
  created_at text
);

create table if not exists ledger (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  fact text not null,
  known_by text not null default '[]',
  not_known_by text not null default '[]',
  source_passage integer,
  status text not null default 'open',
  created_at text, updated_at text
);

create table if not exists facts (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  text text not null,
  about text not null default '[]',
  source_passage integer,
  status text not null default 'active',
  supersedes integer,
  note text not null default '',
  created_at text
);

create table if not exists outline (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  seq integer not null,
  text text not null,
  done integer not null default 0,
  created_at text
);

create table if not exists threads (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  text text not null,
  opened_in_passage integer,
  closed_in_passage integer,
  last_touched_passage integer,
  status text not null default 'open',
  created_at text
);

create table if not exists scene_state (
  story_id integer primary key references stories(id) on delete cascade,
  place text not null default '',
  story_time text not null default '',
  weather text not null default '',
  initiative text not null default '',
  present text not null default '[]',
  updated_passage integer
);

create table if not exists record_changes (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  passage_id integer,
  turn_id integer,
  record text not null,
  record_id integer,
  op text not null,
  before text,
  after text,
  summary text not null default '',
  undone integer not null default 0,
  created_at text
);
create index if not exists record_changes_passage on record_changes(story_id, passage_id);

create table if not exists assets (
  id integer primary key autoincrement,
  story_id integer not null references stories(id) on delete cascade,
  key text not null,
  kind text not null,
  prompt text not null default '',
  file text,
  status text not null default 'pending',
  error text,
  refs text not null default '[]',
  created_at text, updated_at text,
  unique(story_id, key)
);
`);

export function kvGet(key: string): string | null {
  const r = db.prepare('select value from app_kv where key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function kvSet(key: string, value: string) {
  db.prepare('insert into app_kv(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
}

export function tx<T>(fn: () => T): T {
  return db.transaction(fn)();
}
