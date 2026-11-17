# The Table

A D&D 5th Edition table for a group of players with an AI Dungeon Master. Everyone says what their character does and
marks themselves ready; the Dungeon Master writes the round (with real dice the app rolls), voices the characters as their
players described, and stops where the party has to act again. Fights happen in the text, by the rules.

Built on the Inkwell engine: a records keeper tracks every character sheet, the people the party meets, facts and open
threads; a continuity check reads each passage against them; chapters close into summaries so long campaigns stay sharp.

## Playing

- **Accounts.** The first account made is the admin. After that, a player signs up with a campaign's invite code (or the
  admin makes an account under Players).
- **Characters.** Talk it through with the Dungeon Master in a chat (in any language): it asks, explains the rules in
  plain words, suggests, and fills in the species, class, background, ability scores, personality and look as you go,
  with a real 🎲 roll for the scores. Or fill in the boxes yourself (anything homebrew too). Either way the AI then builds
  the full 5e sheet. Paint portrait makes their picture.
- **Campaigns.** The host starts one from a world brief (written by hand, by Write with AI, or from the shared shelf of
  saved worlds) and shares its invite code. Everyone brings a character. Nothing is written until the host presses
  **Begin the campaign** (with an optional private note on where it starts): the Dungeon Master then writes the opening
  scene with every character at the table and stops at the first moment the party has to act. Anyone who joins later is
  brought in with the next round.
- **Rounds.** Write what your character does, in "quotes" for speech and ((double brackets)) for out-of-character
  questions, then press Ready (or Pass). The round starts once every player marked *here* is ready, or when the host
  presses Go (a campaign setting). Players marked *away* tag along doing nothing new.
- **Fights** are built to the 5e XP budget for the party at the table (a first job stays easy to medium), and foes break
  and run when a fight turns against them. When every character is down at 0 HP at once, it's **game over**: the table
  stops, and the host picks **Try the fight again** (back to just before it began, sheets and all), **Go back one
  round**, or **Carry on**.
- **Rulings.** When the rules or a sheet cut an action short (Action Surge already spent, a spell and a weapon attack in
  one turn, a spell the sheet doesn't have), the passage says so in a plain **Ruling** line where it happens, so a
  player can tell a rule from a skipped move.
- **Levelling.** XP or milestone. Level up appears only once a character has earned it: the story notes it once
  ("Mira has earned level 3!"), and its player gets a banner over the action box. They press Level up and talk it through with
  the Dungeon Master (what the new level gives, then each choice it asks for, with a real 🎲 roll for HP), or just says
  what they want. The AI does the 5e math and shows what changes before it is kept.
- **The host** can retry, correct or edit a passage, see the Dungeon Master's notes and dice, keep or undo record
  changes, close chapters, and change the campaign's settings. Players never see the Dungeon Master's notes, the dice
  tray, the secrets ledger or anyone's hidden backstory.
- **DM guidance** (📜, host only): standing instructions the Dungeon Master reads every round until the host changes
  them (how hard to go, what to allow, where to steer). The server sends it to the host alone, and the passage never
  mentions it.
- **Difficulty.** Story says yes to sensible plans, takes DCs down by 5, turns failures into setbacks rather than capture
  or knockouts, keeps fights easy, and leaves a character at 0 HP stable (no death saves). Standard and Deadly play by
  the book. At every difficulty, players can fill in small off-page details about their own characters.
- **Listen.** Each passage can be read aloud by the Kokoro narrator, on the server, free.

## Running

Node 22.18 or newer (it runs the TypeScript directly).

```bash
npm install
npm run build
DND_INSECURE_COOKIES=1 PORT=3000 DATA_DIR=./data npm start
```

Then open http://localhost:3000 and make the admin account. Add connections under Connections: a Dungeon Master (Claude
Opus works best), a records keeper (a cheaper model is fine) and, for pictures, an OpenAI-compatible image endpoint.

For development, `npm run dev:server` and `npm run dev:web` (Vite on 5179, proxying `/api` to 8093: set `PORT=8093`).

### Environment

| Variable | What it does |
| --- | --- |
| `PORT`, `HOST` | Where the server listens (default 8080 on 0.0.0.0; the Docker image uses 3000). |
| `DATA_DIR` | Database (`table.db`), pictures, voice cache and daily backups. |
| `DND_MASTER_KEY` | Encrypts stored API keys. Without it, one is made and kept in `DATA_DIR/.master_key`. |
| `DND_INSECURE_COOKIES=1` | Plain http on localhost: the session cookie goes without the Secure flag. |
| `DND_ADMIN_USER`, `DND_ADMIN_PASSWORD` | Optional first account, made on first boot. |
| `DND_WRITER_ENDPOINT`, `DND_WRITER_KEY`, `DND_WRITER_MODEL`, `DND_RECORDS_*`, `DND_IMAGES_*` | Optional connections (Dungeon Master, records keeper, images) seeded on first boot. |

### Docker

The Dockerfile builds the client and runs the server on port 3000 with its data in `/app/data` (mount a volume there).
