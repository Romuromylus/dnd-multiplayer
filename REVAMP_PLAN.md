# D&D Table: revamp plan (2026-11-14)

The D&D app becomes a **multiplayer Game (d20)**: Inkwell's engine (writer, records agent, checker, jobs that survive
leaving the tab), D&D 5e character sheets, and a table of human players with the AI as Game Master. The old vanilla-JS
app is retired; only its SRD data (now `server/srd/*.json`, for the builder's suggestion lists) comes along.

## Decisions (Romu, 2026-11-14)

- **Base:** Inkwell's engine, trimmed to Game (d20) only. Same repo (`Romuromylus/dnd-multiplayer`), same EasyPanel
  service (`sillytavern/dnd-multiplayer`) and domain. The old code lives on in git history.
- **No combat module.** Fights happen in the prose with real dice, like Inkwell's Game (d20).
- **Turns: gather, then write.** Every player posts what their character does; the GM writes one passage when all are
  in, or when the host presses Go.
- **Dice: the app rolls a tray** of real dice per player every turn (plus the world's dice). Rolls show as chips.
- **The GM narrates and voices the players' characters** (writes their declared action out in full, with their lines),
  but never decides what they do next. That stays with each player.
- **Passages are campaign beats, not book chapters.** Short by default; no book reader.
- **Inkwell features that come along:** Kokoro narrator voice, Write with AI + saved worlds (bibles), generated pictures
  (portraits, scene art), polish pass, records/cards, continuity checker, chapters with summaries.

## Decisions (Romu, second message, 2026-11-14)

- **Levelling is done by the AI**, not by code from a maintained list: players can take homebrew spells and features, and
  the AI does the 5e math (HP, slots, proficiency, features) and shows what it changed before it is kept.
- **Fresh start:** the old characters and records are wiped (the players agreed). The new app uses its own database file
  (`table.db`) in the same volume, so the old `dnd.db` is simply left unused.
- Built to completion with autonomy on what makes a good D&D table.

## Phases

### P0 Seed
Copy Inkwell's core into this repo on a `v2` branch: server (Hono + better-sqlite3, jobs/SSE, llm, records, tools,
context, turn, rules, rules_gm, speech/voice, assist, art, polish) and the React client. Strip every other mode (VN,
Adventurer, dungeon, JRPG, Sovereign, Holdout, Wasteland, Alt-History, Story) and the book reader. Dockerfile on Node 22.
Done when: boots locally, a single-player Game (d20) story plays as it does in Inkwell.

### P1 Accounts and campaigns
- Users (username + password, scrypt), roles admin / player. Admin manages connections and users. Cookie sessions
  replace Inkwell's basic-auth assumption.
- Campaigns (an Inkwell story) with members: host + players, joined by invite code. Each member seats one character.
- A campaign event stream (SSE) for presence, posted actions, ready marks and job start/end, so every seat watches the
  same passage stream (jobs already fan out to many listeners).

### P2 D&D 5e characters
- Sheet: STR DEX CON INT WIS CHA, proficiency bonus, saves, skills, AC, HP + hit dice, speed, spell slots, spells,
  class features, inventory, gold, conditions, inspiration, XP and level (5e table).
- Builder: race, class, subclass, background from the SRD JSON; standard array / point buy; starting gear.
  Write with AI for look and backstory; generated portrait.
- Level-up in the app, worked out by the AI from the sheet and the player's wishes (homebrew allowed), shown as a
  before/after and kept only when the player says so. XP levelling flags a character when XP passes the 5e threshold;
  milestone levelling lets the host lift the party a level.

### P3 Party Game Master rules
- `rules_gm` rewritten for 5e and a party: checks = d20 + ability mod (+ proficiency), attacks vs AC, spell save DC,
  advantage/disadvantage, damage dice by weapon and spell, spell slots spent on the page.
- Dice tray: one labelled row per character plus the world's row; roll lines name the roller.
- Agency for N players: every declared action written out in that player's voice, nothing added; a player who posted
  nothing stays in the background. End each passage on a moment that calls on the party.
- Fights in prose: all declared actions resolved in a sensible order, then every foe acts with its own roll. Foe HP in
  the scene state, as in Game (d20).
- Records: one sheet card per player character (HP, slots, gold, gear, conditions, XP) kept by the records agent; the
  checker reads all sheets and the whole tray.
- Length pick defaulting to a short beat (about 300-600 words).

### P4 Gather turn flow
Per-turn pending actions (edit until Go), ready marks, auto-Go when every seated player is ready, host Go / skip,
out-of-character notes in brackets, away seats. Retry and Fix are host-only.

### P5 Inkwell features
Kokoro narrator (each listener plays their own), polish pass, saved worlds + Write with AI, art (portraits, scene
pictures), chapters and summaries.

### P6 Deploy
- Fresh data: no import. The first account made on the live site is the admin (or `DND_ADMIN_USER` / `DND_ADMIN_PASSWORD`).
- Same service and volume (`/app/data`), port 3000, `DATA_DIR=/app/data`.

## What was built (2026-11-14)

All phases above, on branch `v2`: accounts with invite codes, campaigns with seats, the live table line (presence, ready
marks, table talk, job start/end), the gather-then-write round with auto-go and host Go, away seats, the 5e sheet builder
and AI level-up/edits, the party Dungeon Master rules with a per-character dice tray, records with spoiler control (players
never get the Dungeon Master's notes, thinking, lookups, the dice tray, the secrets ledger or anyone's hidden backstory),
scene pictures and NPC portraits, the narrator voice, chapters and summaries, export.
