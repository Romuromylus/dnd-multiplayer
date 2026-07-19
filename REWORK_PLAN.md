# Rework Campaign Plan — dnd-multiplayer

Branch: `rework/refactor-ui` (off `main`). Local commits per verified unit; **no push to GitHub until user says so**.
Decisions (user-confirmed 2026-07-19): keep vanilla no-build frontend and restructure it; UI = visual overhaul on the existing CSS token/theme system (parchment-fantasy identity stays).

Process per unit (Marinara lessons): one Opus implementer per small scoped unit → orchestrator reviews the diff → tests + server boot check → commit. Phase-end: review pass + browser verification via preview server. Overlapping-file units run sequentially; disjoint units run in parallel.

## Phase 1 — Safety net (IN PROGRESS)

- **U1.1 Backend dead code** *(dispatched, running)*: delete `server/index-modular-example.js`, `server/services/gameRules.js` (server copy only), `AI_RESPONSE_PREFIX` plumbing, stale `X-Game-Password/X-Admin-Password` CORS headers. Keep `tagParser` parsers (Phase 3 consolidates onto them) and `asyncHandler` (Phase 3 adopts it).
- **U1.2 Frontend dead code** *(dispatched, running)*: delete `modals/admin.js` stub, `modals/sessionNew.js` shim, `state.subscribe`, legacy `handleSectionToggleClick`, `toggleInventory` (if grep-dead); fix `formatSpellSlots` ordinal bug ("2st/3st"); strip debug console.logs in main.js/characters.js/tts.js.
- **U1.3 Test harness**: `node:test` + package.json `test` script; tests for currently-pure logic: `tagParser.parseChoices`, `findCharacterByName`, `lib/validation.js`, XP thresholds. Tests are committed (own repo — unlike Marinara upstream local-only rule).
- **U1.4 Helper unification**: one canonical `getActiveApiConfig` shape (kill the dual `{api_endpoint,api_key,api_model}` vs `{endpoint,api_key,model}` and the defensive `x.api_endpoint || x.endpoint` normalizations in sessions.js/characters.js); single `estimateTokens` (currently defined in both aiService.js:285 and turnProcessor.js:14).

## Phase 2 — Summarization rework (user's explicit pain point)

Root cause of "vanishing space between summarizations": the compact trigger at `turnProcessor.js:385-393` counts `estimateTokens(JSON.stringify(recentHistory))` — stored entries **including per-character `povs`** (one full scene rewrite per player) + JSON overhead — while the model is only ever sent `entry.content`. With N players the counter runs ~(N+1)× hot, so the 8000-token threshold trips faster and faster.

- **U2.1 Merge turn processors**: `processAITurn` (turnProcessor.js:143-448) and `streamAITurn` (459-781) are ~99% duplicated; merge into one core with an injected model-caller (callAI vs callAIStream). Preserve the index.js:116-132 stream-first-with-fallback wrapper semantics.
- **U2.2 Compaction fix**: trigger on tokens of the **actual outgoing messages array** (system prompt + aiMessages); after compaction keep a **tail of ~10 raw entries** uncompacted (today `compacted_count = length-1` leaves exactly 1 — a continuity cliff); keep `max_tokens_before_compact` setting but raise default (≥16000); revisit the 4000-char summary cap + recursive re-summarization (progressive detail loss).
- **U2.3 Tests**: trigger math, tail retention, progressive-chunking (25-entry) path, stale compacted_count fallback.

## Phase 3 — Backend consolidation

- **U3.1 Single tag grammar**: consolidate the 4 diverging XP/MONEY/ITEM/HP/SPELL/AC parse implementations onto `tagParser` (structured output); `tagApplicator` becomes parse→apply. Canonical semantics = current live applicator behavior (incl. fuzzy item matching).
- **U3.2 Session-scoped broadcasts (security fix)**: `broadcastCharacterUpdate(charId)` helper resolving the character's session(s); replace the **10× global `io.emit('character_updated')` in tagApplicator.js and 16× in characters.js** which currently leak every character's HP/gold/inventory/backstory to all connected clients across sessions. Room-scoped pattern already exists (`sendToSession`, used 22× in sessions.js).
- **U3.3 Recalculate routes**: rewrite the four `recalculate-*` handlers (sessions.js:1035-1492, ~460 lines) as "re-run the shared parser/applier over history".
- **U3.4 Extract services**: character mutation service (select→mutate JSON col→UPDATE→emit cycle recurs ~15×); shared brace-counting marker-JSON extractor (triplicated in characters.js levelup/edit/ai-create); prompt strings gathered into one module.
- **U3.5 Error handling + validation**: adopt `asyncHandler`, consistent status codes (action vs process currently return 200-with-error vs 500 for the same failure), stop leaking raw `e.message`; apply `schemas.character` stat bounds to `POST /api/characters`, `quick-update`, `ai-create`, `edit`.

## Phase 4 — Frontend structure

- **U4.1 Event delegation**: data-action attributes + one delegated listener per view; retire the ~96 `window.*` exports in main.js and inline onclick in HTML strings (this is the load-bearing coupling; also unblocks CSP tightening in Phase 5).
- **U4.2 Split `modules/sessions.js`** (1,728 lines) along its comment-banner seams: session list/CRUD + new-session modal, story renderer (+POV), virtual scroller, dice+inspiration (self-contained state at :757-1102), choices, slash commands, actions/turn/recalc.
- **U4.3 Split `characterBuilder.js`** (1,282 lines) by wizard step; fix full-innerHTML-re-render-per-keystroke listener churn.
- **U4.4 Unify card rendering**: one card function behind `renderCharactersList`/`updatePartyList` (near-identical ~130-line duplicates).
- **U4.5 Adopt `modalManager`** (already written, unused) for open/close/Escape; collapse the triple-wired section-toggle (inline onclick + delegated listener + capture-phase handler).
- **U4.6 Shared post-mutation helper** for the `characters[idx]=result; setState; render; loadCharacters` block repeated ~7× in spellSlots.js/inventory.js.

## Phase 5 — UI overhaul (on existing tokens)

- **U5.1 In-app dialog system** (confirm/prompt/alert replacement) styled on the token system — kills all native `confirm()/alert()/prompt()` flows.
- **U5.2 UX fixes**: real spell-slot editor (replaces raw-JSON text input in Quick Edit), recalc results rendered in-app (replaces `alert()` dumps), split Character-Edit vs Level-Up shared modal DOM.
- **U5.3 Visual refresh pass** per component group (cards, drawer, action bar, dice roller, builder, settings) keeping parchment identity; accessibility: `role="tabpanel"`, clickable divs → buttons, focus order.
- **U5.4 CSP tighten**: drop `'unsafe-inline'` for scripts (enabled by U4.1); notable because the DM prompt makes the AI emit raw HTML that is rendered client-side.
- **U5.5 Verification sweep**: preview server, light+dark themes, mobile+desktop widths.

## Environment note

Local `node_modules` lacks the compiled `better-sqlite3` native binding (local Node is v24) — `node server/index.js` fails at `config/database.js:21` before any app code runs. Run `npm rebuild better-sqlite3` (may need the Task Scheduler escape if the sandbox blocks native builds) before any local boot / browser verification. Until then, verify units via `node --check` + direct `require()` load tests.

## Resume state (for post-compaction pickup)

- Tasks #1-#5 mirror the phases (Task #1 in_progress; deps 2←1, 3←2, 4←1, 5←4).
- U1.1 + U1.2 implementers were dispatched 2026-07-19; their diffs land uncommitted in the working tree → review, run `node --check`/boot check, commit each separately.
- Then dispatch U1.3 + U1.4 (parallel-safe? U1.4 touches turnProcessor/aiService/sessions/characters — run U1.3 and U1.4 in parallel only if U1.3 stays inside tests/ + package.json; otherwise sequential).
- Full audit evidence (file:line) lives in the session that produced this plan; the plan above carries everything needed to execute.
