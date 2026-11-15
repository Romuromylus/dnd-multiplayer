import { db } from './db.ts';
import { buildPack, chapterLayout, chapterMessages, systemParts } from './context.ts';
import { emit, type Job } from './jobs.ts';
import { callJson, withRoom } from './ask.ts';
import { addUsage, callModel, supportsTools, zeroUsage, LlmError, type Block, type CallResult, type Conn, type Msg, type SysPart, type ToolDef, type Usage } from './llm.ts';
import * as R from './records.ts';
import { checkSystem, planStep, recordsSystem, sceneSummarySystem, SHEET, writeReminders } from './modes.ts';
import { bannedHits, on, type StorySettings } from './rules.ts';
import { rollTray } from './rules_dnd.ts';
import { describeCall, readTools, runTool, writeTools, type ToolCtx } from './tools.ts';
import { clip, estTokens, now, parseJson } from './util.ts';
import { polishes, runPolish } from './polish.ts';
import { enqueuePortraits, enqueueSceneArt } from './art.ts';

export type Problem = { type: string; quote: string; problem: string; record: string };
// One player's action for a round: who plays it, and what they said.
export type RoundAction = { personaId: number; name: string; player: string; text: string };

// ---------------------------------------------------------------- helpers

// Scene lines stay when the Scene Tracker is on: the writer marks moves inside a passage with them.
export function cleanProse(t: string, keepScene = false): string {
  return (keepScene ? t : t.replace(/<scene>[\s\S]*?<\/scene>/g, ''))
    .replace(/<\/?passage[^>]*>/g, '')
    .replace(/<(npc|npc_update|you|you_update|knowledge|cast|direction|round|notes?|plan|sheet|foe|dice_tray)>[\s\S]*?<\/\1>/g, '')
    .replace(/^\s*(Passage|Notes?):\s*\n/i, '')
    .trim();
}

export function insertTurn(storyId: number, kind: string, direction: string) {
  return db.prepare(`insert into turns(story_id, kind, direction, created_at) values (?, ?, ?, ?)`).run(storyId, kind, direction, now()).lastInsertRowid as number;
}
export function updateTurn(id: number, f: Record<string, any>) {
  const keys = Object.keys(f);
  if (!keys.length) return;
  db.prepare(`update turns set ${keys.map(k => `${k} = @${k}`).join(', ')} where id = @id`).run({ ...f, id });
}

type LoopOpts = {
  job: Job; who: 'plan' | 'records'; conn: Conn; system: SysPart[]; messages: Msg[]; tools: ToolDef[];
  allowWrite: boolean; ctx: ToolCtx; maxIter: number; maxTokens?: number; streamThinking?: boolean;
};

// Tool loop: call, run requested tools, feed results back, until the model stops asking.
export async function toolLoop(o: LoopOpts) {
  let usage = zeroUsage();
  const calls: { name: string; input: any; result: string; who: string }[] = [];
  let thinking = '';
  let last: CallResult | null = null;
  for (let i = 0; i < o.maxIter; i++) {
    const r = await callModel({
      conn: o.conn, system: o.system, messages: o.messages, tools: o.tools, toolChoice: 'auto', maxTokens: o.maxTokens, signal: o.job.abort.signal,
      onThinking: o.streamThinking ? d => emit(o.job, 'thinking', { delta: d, who: o.who }) : undefined,
    });
    usage = addUsage(usage, r.usage);
    thinking += r.thinking;
    last = r;
    o.messages.push({ role: 'assistant', content: r.content });
    if (r.stopReason === 'refusal') throw new LlmError('The model declined this request (refusal).');
    if (!r.toolUses.length) break;
    const results: Block[] = [];
    for (const tu of r.toolUses) {
      const res = runTool(o.ctx, tu.name, tu.input, o.allowWrite);
      calls.push({ name: tu.name, input: tu.input, result: clip(res.text, 4000), who: o.who });
      emit(o.job, 'tool', { who: o.who, name: tu.name, label: describeCall(tu.name, tu.input), result: clip(res.text, 1500), error: res.isError });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: res.text, ...(res.isError ? { is_error: true } : {}) });
    }
    o.messages.push({ role: 'user', content: results });
  }
  const tail = o.messages[o.messages.length - 1];
  const pending = tail.role === 'assistant' && tail.content.some(b => b.type === 'tool_use');
  return { usage, calls, thinking, last, pendingToolUse: pending };
}

// The plan is notes. When the model runs on into the passage itself (a scene line, a roll line or colored dialogue starting a
// line, or a run of prose paragraphs after the last note), that part is cut off.
export function planNotes(text: string): { notes: string; spill: string } {
  let cut = text.search(/^[ \t]*(<(scene|roll|inspiration|ruling)>|<font color=)/m);
  if (cut < 0) {
    const paras = text.split(/\n{2,}/);
    let i = paras.length;
    while (i > 0 && !/^\s*(\d+[.)]|[-*•]\s|#{1,4}\s|\*\*|notes?\b)/i.test(paras[i - 1])) i--;
    const tail = paras.slice(i);
    if (i > 0 && tail.length >= 3 && tail.join(' ').split(/\s+/).length > 150) cut = text.lastIndexOf(tail[0]);
  }
  if (cut <= 0) return { notes: text, spill: '' };
  return { notes: text.slice(0, cut).trim(), spill: text.slice(cut).trim() };
}

const esc = (t: string) => t.replace(/"/g, "'");
// A round's actions as they are kept in the campaign and read back by every later turn.
export const roundMarkup = (acts: RoundAction[]) => acts.map(a => `<action by="${esc(a.name)}">\n${a.text.trim()}\n</action>`).join('\n');
export const NO_ACTIONS = 'Nobody gave an action this round: carry the scene on to the next moment that calls on the party, deciding nothing for any of their characters.';

// The campaign's first passage, written when the host begins it: the round holds this instead of players' actions. The host's
// note (where to start, what to bring in) stays with the turn and is never shown to the players.
export const openingRound = (note: string) => `<opening>${note.trim() ? `\n${note.trim()}\n` : ''}</opening>`;
export const isOpening = (round: string) => round.trim().startsWith('<opening>');

function openingText(story: R.Story, round: string) {
  const note = round.trim().replace(/^<opening>|<\/opening>$/g, '').trim();
  const party = R.party(story.id).map(p => `${p.name} (played by ${p.player})`).join(', ');
  return `<opening>
The campaign begins with this passage. Nobody has acted yet: it sets the stage for the whole table.
- ${keepScenes(story.settings) ? 'Open with a scene line, then build' : 'Build'} the place, the time, the mood and the situation from the world brief${note ? ' and the host\'s note below' : ''}.
- Bring every character at the table into the scene: ${party || '(none seated)'}. Show each one from outside, as their sheet and their player's description have them: how they look, what they carry, where they are and how they came to be here, as far as the brief and their descriptions support it. Give each a moment on the page. They don't speak, decide or react to anything new: their players do that from here on.
- Introduce the first people the party meets and the first hook or trouble of the campaign, and end on the first moment that calls on the party to act: someone addressing them, something happening in front of them. Stop there.
- No roll lines: stop before anything would need one.${note ? `\n\nThe host's note for the opening (the players don't see it): ${note}` : ''}
</opening>`;
}

// This round's actions, for the writer: who acted, and who sat it out.
export function roundText(story: R.Story, round: string, note?: string) {
  if (isOpening(round)) return `${openingText(story, round)}${note?.trim() ? `\n<retry_note>The last attempt at this passage was thrown away. The host's note for this attempt: ${note.trim()}</retry_note>` : ''}`;
  const acted = new Set([...round.matchAll(/<action by="([^"]+)">/g)].map(m => m[1]));
  const idle = R.party(story.id).filter(p => !acted.has(esc(p.name)));
  const idleLine = idle.length ? `\n<no_action note="These characters' players sent nothing this round. They are present with the party, do nothing new and say nothing${idle.some(p => p.status === 'away') ? '; a player marked away is not at the table right now' : ''}. In a fight they take the Dodge action.">${idle.map(p => `${p.name}${p.status === 'away' ? ' (away)' : ''}`).join(', ')}</no_action>` : '';
  const body = round.trim() ? `<round>\n${round.trim()}${idleLine}\n</round>` : `<round>${NO_ACTIONS}</round>`;
  return note?.trim() ? `${body}\n<retry_note>The last attempt at this passage was thrown away. The host's note for this attempt: ${note.trim()}</retry_note>` : body;
}

function writeText(story: R.Story, planned: boolean, opening = false) {
  return `Now write ${opening ? 'the campaign\'s opening passage' : 'the passage for this round'}${planned ? ', using your notes' : ''}, following ${opening ? 'the opening brief' : 'the players\' actions'}, the craft rules and the campaign settings.\n\n${writeReminders(story.settings)}`;
}

const keepScenes = (s: StorySettings) => on(s, 'scene_tracker');
const turnDice = (turnId: number | null | undefined) => turnId ? ((db.prepare('select dice from turns where id = ?').get(turnId) as any)?.dice ?? '') : '';

// A seated character with no sheet in this campaign gets the one from their library.
export function ensureSheets(storyId: number) {
  for (const s of R.listSeats(storyId)) {
    if (!s.persona_id || R.userCard(storyId, s.persona_id)) continue;
    const p = R.getPersona(s.persona_id);
    if (!p) continue;
    R.setUserCard({ storyId, passageId: null, turnId: null }, p.id, sheetFields(p), 'joined the table', 'Sheet');
  }
}
export function sheetFields(p: R.Persona): R.UserFields {
  const sheet = parseJson<Record<string, string>>(p.sheet, {});
  const f: R.UserFields = { name: p.name };
  for (const d of SHEET) f[d.key] = String(sheet[d.key] ?? '').trim();
  if (!f.look) f.look = p.look;
  if (!f.look_now) f.look_now = R.AS_USUAL;
  return f;
}

export function toolCtx(story: R.Story, turnId: number | null, passageIds: number[], chapterId: number): ToolCtx {
  return { storyId: story.id, settings: story.settings, turnId, passageIds, chapterId };
}

export function requireConns(story: R.Story) {
  const c = R.storyConns(story);
  if (!c.writer) throw new Error('No connection set up yet. An admin adds one under Connections.');
  return c as { writer: Conn; records: Conn | null };
}

// ---------------------------------------------------------------- bookkeeping

export async function runRecords(job: Job, story: R.Story, passageIds: number[], opts: { reconcile?: boolean; turnId?: number | null } = {}) {
  const { records } = R.storyConns(story);
  const setStatus = (st: string) => { for (const id of passageIds) db.prepare('update passages set records_status = ? where id = ?').run(st, id); };
  if (!passageIds.length) return zeroUsage();
  if (!records) { setStatus('skipped'); return zeroUsage(); }
  if (!supportsTools(records)) {
    emit(job, 'notice', { message: `Records were not kept: the records connection uses "Single user message", which turns tools off.` });
    setStatus('skipped');
    return zeroUsage();
  }
  emit(job, 'phase', { phase: 'records', label: opts.reconcile ? 'updating records for the corrected text' : 'keeping records' });
  const passages = passageIds.map(id => R.getPassage(id)!).filter(Boolean);
  const first = passages[0];
  const all = R.storyProse(story.id);
  const idx = all.findIndex(p => p.id === first.id);
  const before = idx > 0 ? all[idx - 1].text.slice(-2500) : '';
  const newText = passages.map(p => {
    const prev = db.prepare(`select kind, text from passages where chapter_id = ? and seq < ? order by seq desc limit 1`).get(p.chapter_id, p.seq) as any;
    return `${prev?.kind === 'direction' ? `<round>\n${prev.text}\n</round>\n` : ''}<passage id="${p.id}">\n${p.text}\n</passage>`;
  }).join('\n\n');
  // The Dungeon Master's notes hold the foes' stat lines, which the page rightly never prints.
  const notes = passages.map(p => (p.turn_id ? (db.prepare('select plan from turns where id = ?').get(p.turn_id) as any)?.plan : '') ?? '').filter(Boolean).join('\n\n');
  const user = [
    `<records_now>\n${buildPack(story, 'records', newText)}\n</records_now>`,
    notes ? `<dm_notes note="The Dungeon Master's private notes for the new passage. Use them only for what the page doesn't print: each foe's AC and HP. Never record anything else from them; only what happens on the page happened.">\n${clip(notes, 5000)}\n</dm_notes>` : '',
    before ? `<story_just_before>\n…${before}\n</story_just_before>` : `<story_just_before>(This is the start of the campaign.)</story_just_before>`,
    `<new_passages>\n${newText}\n</new_passages>`,
    opts.reconcile
      ? `These passages were rewritten after a correction from the host. The records may still describe the old version: fix whatever no longer matches the text (update sheets, cards, ledger rows and threads; record corrected facts with kind "change" replacing the old ones), and record anything new. Call set_scene for the last passage.`
      : `Update the records for the new passage${passages.length > 1 ? 's, in order' : ''} now.`,
  ].filter(Boolean).join('\n\n');
  const ctx = toolCtx(story, opts.turnId ?? null, passageIds, first.chapter_id);
  const res = await toolLoop({
    job, who: 'records', conn: records, system: [{ text: recordsSystem(story.settings, story.title, R.party(story.id).map(p => p.name)), cache: '1h' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: user, cache_control: { type: 'ephemeral' } }] }],
    tools: [...readTools(story.settings), ...writeTools(story.settings)], allowWrite: true, ctx, maxIter: 12, maxTokens: Math.min(records.max_tokens, 16000),
  });
  setStatus('done');
  for (const p of passages) emit(job, 'changes', { passageId: p.id, changes: R.passageChanges(p.id), cards: R.passageCards(p.id) });
  enqueuePortraits(story.id);
  return res.usage;
}

// Passages written but not yet recorded (held by a check, cut off, or edited) get recorded before the campaign moves on.
export async function flushPendingRecords(job: Job, story: R.Story, skipId?: number) {
  const rows = (db.prepare(`select p.id from passages p join chapters c on c.id = p.chapter_id where p.story_id = ? and p.kind = 'prose' and p.records_status in ('pending','hold') order by c.number, p.seq`).all(story.id) as { id: number }[])
    .filter(r => r.id !== skipId);
  if (!rows.length) return zeroUsage();
  let usage = zeroUsage();
  for (let i = 0; i < rows.length; i += 4) usage = addUsage(usage, await runRecords(job, story, rows.slice(i, i + 4).map(r => r.id)));
  return usage;
}

// ---------------------------------------------------------------- continuity check

export async function runCheck(job: Job, story: R.Story, passage: R.Passage, round: string): Promise<{ problems: Problem[]; usage: Usage }> {
  const { records, writer } = R.storyConns(story);
  const conn = records ?? writer;
  if (!conn || story.settings.continuity_check === 'off') return { problems: [], usage: zeroUsage() };
  emit(job, 'phase', { phase: 'check', label: 'checking continuity and dice' });
  const all = R.storyProse(story.id);
  const idx = all.findIndex(p => p.id === passage.id);
  const recent = all.slice(Math.max(0, idx - 3), idx).map(p => p.text).join('\n\n').slice(-9000);
  const dice = turnDice(passage.turn_id);
  const user = [
    buildPack(story, 'check', `${round}\n${passage.text}`),
    ...(dice ? [dice] : []),
    `<recent_text>\n${recent || '(start of the campaign)'}\n</recent_text>`,
    roundText(story, round),
    `<new_passage>\n${passage.text}\n</new_passage>`,
    `Check the new passage now. JSON only.`,
  ].join('\n\n');
  try {
    const r = await callJson<{ problems: Problem[] }>({ conn, system: [{ text: checkSystem(story.settings), cache: true }], messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 8000, signal: job.abort.signal }, { tries: 1 });
    const benign = /\b(no (real )?(issue|problem|leak|contradiction)|not (a|an|really a|a real|an actual|a clear) (problem|issue|leak|conflict|contradiction)|possible minor issue|is fine|are fine|this is consistent|which matches|so it'?s ok|minor departure|minor,? but|minor (point|quibble|nitpick)|borderline|acceptable|arguably|technically fine|within the rules)\b/i;
    const problems = (r.json?.problems ?? []).filter(p => p && p.problem && !benign.test(p.problem)).slice(0, 8);
    return { problems, usage: r.usage };
  } catch (e: any) {
    if (job.abort.signal.aborted) throw e;
    emit(job, 'notice', { message: `Continuity check failed: ${e.message}` });
    return { problems: [], usage: zeroUsage() };
  }
}

export const autoFixText = (problems: Problem[]) => `Fix these continuity problems:\n${problemsText(problems)}`;
export function problemsText(problems: Problem[]) {
  return problems.map((p, i) => `${i + 1}. [${p.type}] "${p.quote}": ${p.problem}${p.record ? ` (${p.record})` : ''}`).join('\n');
}

// ---------------------------------------------------------------- scene compression (context handler)

export async function ensureSceneSummaries(job: Job, story: R.Story, chapter: R.Chapter) {
  const { needSummary } = chapterLayout(story.id, chapter);
  if (!needSummary.length) return zeroUsage();
  const { records, writer } = R.storyConns(story);
  const conn = records ?? writer;
  if (!conn) return zeroUsage();
  emit(job, 'phase', { phase: 'scenes', label: 'compressing older scenes' });
  let usage = zeroUsage();
  for (const g of needSummary) {
    const text = g.passages.filter(p => p.kind === 'prose').map(p => p.text).join('\n\n');
    if (!text) continue;
    const r = await callModel({ conn, system: [{ text: sceneSummarySystem(story.settings, '') }], messages: [{ role: 'user', content: [{ type: 'text', text: `<scene_text>\n${text}\n</scene_text>\n\nSummarize this scene.` }] }], maxTokens: withRoom(conn, 4000, 'low'), thinking: 'low', signal: job.abort.signal });
    usage = addUsage(usage, r.usage);
    db.prepare('update scenes set summary = ?, summary_upto = ? where id = ?').run(r.text.trim(), Math.max(...g.passages.map(p => p.id)), g.sceneId);
  }
  return usage;
}

// ---------------------------------------------------------------- a round

type TurnOpts = { round: string; mode: 'write' | 'retry'; note?: string };

export async function runTurn(job: Job, storyId: number, o: TurnOpts) {
  let story = R.getStory(storyId)!;
  const conns = requireConns(story);
  let usage = zeroUsage();
  const by: Record<string, Usage> = {};
  const add = (step: string, u: Usage) => { by[step] = addUsage(by[step] ?? zeroUsage(), u); usage = addUsage(usage, u); };
  const usageJson = () => JSON.stringify({ ...usage, by });
  ensureSheets(storyId);
  add('records', await flushPendingRecords(job, story, o.mode === 'retry' ? R.lastProse(storyId)?.id : undefined));
  const chapter = R.openChapter(storyId);
  let round = o.round ?? '';
  let roundPassage: R.Passage | null = null;
  let retriedRound: number | null = null;

  if (o.mode === 'retry') {
    const last = R.lastProse(storyId);
    if (!last || last.chapter_id !== chapter.id) throw new Error('Nothing to retry in the open chapter.');
    const t: any = last.turn_id ? db.prepare('select * from turns where id = ?').get(last.turn_id) : null;
    round = t?.direction ?? '';
    R.undoPassageChanges(storyId, [last.id]);
    db.prepare(`insert into passage_versions(passage_id, text, reason, created_at) values (?, ?, 'retry', ?)`).run(last.id, last.text, now());
    db.prepare('delete from passages where id = ?').run(last.id);
    emit(job, 'removed', { passageId: last.id });
    const tail = R.chapterPassages(chapter.id).filter(p => p.kind !== 'note').at(-1);
    if (tail?.kind === 'direction' && tail.text === round.trim()) retriedRound = tail.id;
  } else if (round.trim() && !isOpening(round)) {
    roundPassage = R.addPassage(storyId, chapter.id, 'direction', round.trim());
    emit(job, 'passage', { passage: roundPassage });
  }

  const turnId = insertTurn(storyId, o.mode, round);
  story = R.getStory(storyId)!;
  try {
    add('scenes', await ensureSceneSummaries(job, story, chapter));

    const system = systemParts(story);
    const exclude = [roundPassage?.id, retriedRound].filter((x): x is number => x != null);
    const pack = buildPack(story, 'writer', `${round}\n${R.lastProse(storyId)?.text.slice(-3000) ?? ''}`);
    const lookups = story.settings.lookups === 'on' && supportsTools(conns.writer);
    const READ_TOOLS = readTools(story.settings);
    const dice = rollTray(R.party(storyId).map(p => ({ name: p.name })));
    updateTurn(turnId, { dice });
    const reread = lookups || story.settings.continuity_check === 'autofix';
    const opening = isOpening(round);
    const turnBlock = `${roundText(story, round, o.note)}\n\n${dice}\n\n${lookups ? planStep(story.settings) : writeText(story, false, opening)}`;
    const messages = chapterMessages(story, chapter, { excludeIds: exclude }, [{ type: 'text', text: pack }, { type: 'text', text: turnBlock, ...(reread ? { cache_control: { type: 'ephemeral' } } : {}) }]);

    let plan = '', planCalls: any[] = [], thinking = '';
    if (lookups) {
      emit(job, 'phase', { phase: 'plan', label: 'planning the round and rolling' });
      const res = await toolLoop({ job, who: 'plan', conn: conns.writer, system, messages, tools: READ_TOOLS, allowWrite: false, ctx: toolCtx(story, turnId, [], chapter.id), maxIter: 6, maxTokens: 16000, streamThinking: true });
      add('plan', res.usage);
      plan = res.last?.text.trim() ?? '';
      const cut = planNotes(plan);
      if (cut.spill) {
        plan = cut.notes;
        const reply = messages.findLast(m => m.role === 'assistant');
        if (reply) reply.content = [...reply.content.filter(b => b.type !== 'text'), { type: 'text', text: plan || 'Notes done.' }].sort((a, b) => (a.type === 'tool_use' ? 1 : 0) - (b.type === 'tool_use' ? 1 : 0));
      }
      planCalls = res.calls; thinking = res.thinking;
      if (plan) emit(job, 'plan', { text: plan });
      const write: Block = { type: 'text', text: writeText(story, true, opening) };
      if (res.pendingToolUse) {
        const tail = messages[messages.length - 1];
        messages.push({ role: 'user', content: [...tail.content.filter(b => b.type === 'tool_use').map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'Out of lookups for this round.' })), write] });
      } else messages.push({ role: 'user', content: [write] });
    }

    emit(job, 'phase', { phase: 'write', label: 'the Dungeon Master is writing' });
    let text = '', writeThinking = '';
    let w: CallResult;
    try {
      w = await callModel({
        conn: conns.writer, system, messages, tools: lookups ? READ_TOOLS : undefined, toolChoice: 'none', signal: job.abort.signal,
        onText: d => { text += d; emit(job, 'text', { delta: d }); },
        onThinking: d => { writeThinking += d; emit(job, 'thinking', { delta: d, who: 'write' }); },
      });
    } catch (e) {
      if (job.abort.signal.aborted) updateTurn(turnId, { plan, tools: JSON.stringify(planCalls), thinking: thinking + writeThinking, usage: usageJson(), model: conns.writer.model, error: 'stopped' });
      if (job.abort.signal.aborted && text.trim()) {
        const p = R.addPassage(storyId, chapter.id, 'prose', cleanProse(text, keepScenes(story.settings)), { cut: 1, records_status: 'pending', turn_id: turnId });
        updateTurn(turnId, { passage_id: p.id });
        emit(job, 'passage', { passage: p });
        return;
      }
      throw e;
    }
    add('write', w.usage);
    thinking += w.thinking;
    if (w.stopReason === 'refusal') throw new LlmError('The model declined to write this passage (refusal). Try rephrasing the actions.');
    const prose = cleanProse(w.text, keepScenes(story.settings));
    if (!prose) throw new LlmError(`The model returned no prose (stop reason: ${w.stopReason}).`);
    const cut = w.stopReason === 'max_tokens' ? 1 : 0;
    let passage = R.addPassage(storyId, chapter.id, 'prose', prose, { cut, records_status: 'pending', turn_id: turnId });
    emit(job, 'passage', { passage });
    updateTurn(turnId, { passage_id: passage.id, plan, tools: JSON.stringify(planCalls), thinking, usage: usageJson(), model: w.model });
    const slipped = bannedHits(prose, story.settings.banned_phrases);
    if (slipped.length) emit(job, 'notice', { message: `Banned phrases that slipped through: ${slipped.join(', ')}. Fix can take them out.` });
    if (cut) { emit(job, 'notice', { message: 'The passage hit the output limit. The host can press Continue to finish it.' }); return; }

    if (polishes(story.settings)) {
      try {
        const pol = await runPolish(job, story, passage, conns.writer);
        add('polish', pol.usage);
        passage = pol.passage;
      } catch (e) {
        if (job.abort.signal.aborted) throw e;
        emit(job, 'notice', { message: `The polish pass failed and the passage was left as written: ${clip(String((e as any)?.message ?? e), 140)}` });
      }
    }
    let problems: Problem[] = [];
    if (story.settings.continuity_check !== 'off') {
      const c = await runCheck(job, story, passage, round);
      add('check', c.usage);
      problems = c.problems;
      if (problems.length && story.settings.continuity_check === 'autofix') {
        emit(job, 'phase', { phase: 'revise', label: `fixing ${problems.length} problem${problems.length > 1 ? 's' : ''}` });
        emit(job, 'text_reset', { passageId: passage.id });
        messages.push({ role: 'assistant', content: passage.text === prose ? w.content : [{ type: 'text', text: passage.text }] });
        messages.push({ role: 'user', content: [{ type: 'text', text: `A check of that passage found these problems:\n${problemsText(problems)}\n\nRewrite the whole passage so these problems are gone. Keep everything else as it is: the same events, voice and length, changing only what the problems need. The same dice tray applies. Output only the passage.` }] });
        const fixed = await callModel({ conn: conns.writer, system, messages, tools: lookups ? READ_TOOLS : undefined, toolChoice: 'none', signal: job.abort.signal, onText: d => emit(job, 'text', { delta: d }) });
        add('fix', fixed.usage);
        const ft = cleanProse(fixed.text, keepScenes(story.settings));
        if (ft) { R.setPassageText(passage.id, ft, 'auto-fix'); passage = R.getPassage(passage.id)!; emit(job, 'passage', { passage }); }
        const again = await runCheck(job, story, passage, round);
        add('check', again.usage);
        problems = again.problems;
      }
      updateTurn(turnId, { check_result: JSON.stringify(problems) });
      if (problems.length) {
        db.prepare(`update passages set records_status = 'hold' where id = ?`).run(passage.id);
        emit(job, 'check', { passageId: passage.id, problems });
      }
    }

    if (!problems.length) add('records', await runRecords(job, story, [passage.id], { turnId }));
    sceneArt(storyId, passage.id);
    updateTurn(turnId, { usage: usageJson() });
    emit(job, 'usage', { usage: { ...usage, by } });
  } catch (e) {
    // Nothing written: drop the round so it can be played again, and give the actions back to the players.
    const wrote = db.prepare('select passage_id from turns where id = ?').get(turnId) as any;
    if (!wrote?.passage_id && roundPassage) {
      db.prepare('delete from passages where id = ?').run(roundPassage.id);
      emit(job, 'removed', { passageId: roundPassage.id, restoreRound: roundPassage.text });
    }
    updateTurn(turnId, { error: String((e as any)?.message ?? e), usage: usageJson() });
    throw e;
  }
}

// A passage that opened a new scene gets its picture, when the campaign paints them by itself.
function sceneArt(storyId: number, passageId: number) {
  const story = R.getStory(storyId);
  const p = R.getPassage(passageId);
  if (!story || !p || story.settings.scene_art !== 'auto') return;
  const prev = db.prepare(`select scene_id from passages where story_id = ? and kind = 'prose' and id < ? order by id desc limit 1`).get(storyId, passageId) as any;
  if (p.scene_id && p.scene_id !== prev?.scene_id) enqueueSceneArt(story, passageId);
}

// Finish a passage that was cut off (Stop pressed, or the output limit).
export async function runContinue(job: Job, storyId: number) {
  const story = R.getStory(storyId)!;
  const conns = requireConns(story);
  const last = R.lastProse(storyId);
  if (!last || !last.cut) throw new Error('The last passage is finished.');
  const chapter = R.getChapter(last.chapter_id)!;
  const system = systemParts(story);
  const pack = buildPack(story, 'writer', last.text.slice(-3000));
  const dice = turnDice(last.turn_id);
  const messages = chapterMessages(story, chapter, {}, [{ type: 'text', text: pack }, { type: 'text', text:
    `${dice ? `${dice}\nThe dice already used in the passage so far stay used: carry on with the next unused ones.\n\n` : ''}The last passage${story.settings.history === 'chat' ? ', your last reply above,' : ` (id ${last.id})`} was cut off before it was finished. Continue it from exactly where it stops, mid-sentence if need be: output only the rest of the passage, with no repetition of what is already there.\n\n${writeReminders(story.settings)}` }]);
  emit(job, 'phase', { phase: 'write', label: 'continuing' });
  let added = '';
  const save = (extra: string, cut: number) => {
    const joiner = /\s$/.test(last.text) || /^[\s,.;:!?…'")\]—-]/.test(extra) ? '' : ' ';
    db.prepare('update passages set text = ?, cut = ?, updated_at = ? where id = ?').run(last.text + joiner + extra.replace(/^\n+/, extra.startsWith('\n\n') ? '\n\n' : ''), cut, now(), last.id);
    emit(job, 'passage', { passage: R.getPassage(last.id) });
  };
  emit(job, 'text_reset', { passageId: last.id, prefix: last.text });
  try {
    const r = await callModel({ conn: conns.writer, system, messages, signal: job.abort.signal, onText: d => { added += d; emit(job, 'text', { delta: d }); } });
    save(r.text.replace(/<\/?passage[^>]*>/g, '').trimEnd(), r.stopReason === 'max_tokens' ? 1 : 0);
    if (r.stopReason === 'max_tokens') { emit(job, 'notice', { message: 'Still cut off at the output limit. Continue again.' }); return; }
  } catch (e) {
    if (job.abort.signal.aborted && added.trim()) { save(added, 1); return; }
    throw e;
  }
  const fresh = R.getStory(storyId)!;
  const p = R.getPassage(last.id)!;
  const t: any = p.turn_id ? db.prepare('select direction from turns where id = ?').get(p.turn_id) : null;
  if (fresh.settings.continuity_check !== 'off') {
    const c = await runCheck(job, fresh, p, t?.direction ?? '');
    if (p.turn_id) updateTurn(p.turn_id, { check_result: JSON.stringify(c.problems) });
    if (c.problems.length) {
      db.prepare(`update passages set records_status = 'hold' where id = ?`).run(p.id);
      emit(job, 'check', { passageId: p.id, problems: c.problems });
      return;
    }
  }
  await runRecords(job, fresh, [p.id], { turnId: p.turn_id });
}

// ---------------------------------------------------------------- corrections: rewrite passages

const FIX_CHUNK_TOKENS = 9000;

export async function runFix(job: Job, storyId: number, o: { passageIds?: number[]; chapterId?: number; correction: string; recheck?: boolean }) {
  let story = R.getStory(storyId)!;
  const conns = requireConns(story);
  let targets: R.Passage[];
  if (o.chapterId) targets = R.chapterPassages(o.chapterId).filter(p => p.kind === 'prose');
  else targets = (o.passageIds ?? []).map(id => R.getPassage(id)!).filter(p => p && p.story_id === storyId && p.kind === 'prose');
  if (!targets.length) throw new Error('Nothing to correct.');
  const chapterIds = [...new Set(targets.map(p => p.chapter_id))];
  if (chapterIds.length > 1) throw new Error('A correction works inside one chapter at a time.');
  const chapter = R.getChapter(chapterIds[0])!;
  targets.sort((a, b) => a.seq - b.seq);
  const turnId = insertTurn(storyId, o.chapterId ? 'fix_chapter' : 'fix', o.correction);

  const allProse = R.storyProse(storyId);
  const firstIdx = allProse.findIndex(p => p.id === targets[0].id);
  const tail = allProse.slice(firstIdx);
  const redo = tail.length <= 30;

  const chunks: R.Passage[][] = [];
  let cur: R.Passage[] = [], size = 0;
  for (const p of targets) {
    const t = estTokens(p.text);
    if (cur.length && size + t > FIX_CHUNK_TOKENS) { chunks.push(cur); cur = []; size = 0; }
    cur.push(p); size += t;
  }
  if (cur.length) chunks.push(cur);

  let usage = zeroUsage();
  const system = systemParts(story);
  const pack = buildPack(story, 'writer', targets.map(p => p.text).join('\n').slice(0, 6000));
  const newText = new Map<number, string>();
  const changed: number[] = [];

  for (const [ci, chunk] of chunks.entries()) {
    emit(job, 'phase', { phase: 'fix', label: chunks.length > 1 ? `rewriting part ${ci + 1} of ${chunks.length}` : targets.length > 1 ? 'rewriting the chapter' : 'rewriting the passage' });
    emit(job, 'fix_start', { passageIds: chunk.map(p => p.id) });
    const ids = new Set(chunk.map(p => p.id));
    const list = chunk.map(p => p.id).join(', ');
    const many = chunk.length > 1;
    const earlier = targets.filter(p => newText.has(p.id) && !ids.has(p.id));
    const dice = chunk.length === 1 ? turnDice(chunk[0].turn_id) : '';
    const task = `<correction from="the host">
${o.correction.trim()}
</correction>

${dice ? `${dice}\nThis passage's round was rolled with the tray above: a rewrite keeps every roll that the correction doesn't touch, and takes any new roll from the next unused dice.\n\n` : ''}${earlier.length ? `<already_rewritten note="This correction has already rewritten these passages. The chapter above shows them as they were before: these are how they read now.">
${earlier.map(p => `<passage id="${p.id}">\n${newText.get(p.id)}\n</passage>`).join('\n\n')}
</already_rewritten>

` : ''}<to_rewrite note="As ${many ? 'they stand' : 'it stands'} now, in ${chapter.status === 'open' ? 'the text above' : `chapter ${chapter.number}`}.">
${chunk.map(p => `<passage id="${p.id}">\n${p.text}\n</passage>`).join('\n\n')}
</to_rewrite>

Rewrite the passage${many ? 's' : ''} in to_rewrite (id${many ? 's' : ''} ${list}) so the correction holds. Keep everything the correction doesn't touch as close to the original as you can, word for word where possible: same events, voice, dialogue, rolls and length, except where the correction needs a change.
Follow the craft rules and settings. Output each passage in order, in exactly this form and nothing else:
<passage id="N">
full rewritten text
</passage>
If a passage needs no change at all, output <passage id="N" unchanged="true"/> instead.`;
    const messages = chapterMessages(story, chapter, {}, [{ type: 'text', text: pack }, { type: 'text', text: task }]);
    const r = await callModel({ conn: conns.writer, system, messages, signal: job.abort.signal, onText: d => emit(job, 'text', { delta: d }) });
    usage = addUsage(usage, r.usage);
    if (r.stopReason === 'refusal') throw new LlmError('The model declined to rewrite this (refusal).');
    const re = /<passage id="(\d+)"(\s+unchanged="true")?\s*(\/>|>([\s\S]*?)<\/passage>)/g;
    let m: RegExpExecArray | null;
    const got = new Set<number>();
    while ((m = re.exec(r.text))) {
      const id = Number(m[1]);
      if (!ids.has(id)) continue;
      got.add(id);
      if (m[2] || m[3] === '/>') continue;
      const t = cleanProse(m[4] ?? '', keepScenes(story.settings));
      const orig = targets.find(p => p.id === id)!;
      if (t && t !== orig.text) { newText.set(id, t); changed.push(id); }
    }
    if (!got.size && chunk.length === 1 && cleanProse(r.text) && r.stopReason !== 'max_tokens') {
      const t = cleanProse(r.text, keepScenes(story.settings));
      if (t !== chunk[0].text) { newText.set(chunk[0].id, t); changed.push(chunk[0].id); }
    }
    const missing = chunk.filter(p => !got.has(p.id) && !newText.has(p.id)).map(p => p.id);
    if (missing.length && got.size) emit(job, 'notice', { message: `Passage${missing.length > 1 ? 's' : ''} ${missing.join(', ')} came back incomplete and were left as they were.` });
  }

  if (!changed.length) {
    emit(job, 'notice', { message: 'The rewrite changed nothing.' });
    updateTurn(turnId, { usage: JSON.stringify(usage) });
    return;
  }

  const recordIds = redo ? tail.map(p => p.id) : changed;
  if (redo) R.undoPassageChanges(storyId, recordIds);
  for (const id of recordIds) db.prepare(`update passages set records_status = 'pending' where id = ?`).run(id);
  for (const id of changed) R.setPassageText(id, newText.get(id)!, `correction: ${clip(o.correction, 120)}`);
  for (const id of changed) emit(job, 'passage', { passage: R.getPassage(id) });
  emit(job, 'fixed', { passageIds: changed });
  story = R.getStory(storyId)!;

  const lastId = allProse[allProse.length - 1]?.id;
  if (o.recheck && changed.length === 1 && changed[0] === lastId && story.settings.continuity_check !== 'off') {
    const p = R.getPassage(changed[0])!;
    const t: any = p.turn_id ? db.prepare('select direction from turns where id = ?').get(p.turn_id) : null;
    const c = await runCheck(job, story, p, t?.direction ?? '');
    usage = addUsage(usage, c.usage);
    if (p.turn_id) updateTurn(p.turn_id, { check_result: JSON.stringify(c.problems) });
    if (c.problems.length) {
      db.prepare(`update passages set records_status = 'hold' where id = ?`).run(p.id);
      emit(job, 'check', { passageId: p.id, problems: c.problems });
      updateTurn(turnId, { usage: JSON.stringify(usage) });
      return;
    }
  }

  for (let i = 0; i < recordIds.length; i += 4) usage = addUsage(usage, await runRecords(job, story, recordIds.slice(i, i + 4), { reconcile: !redo, turnId }));
  db.prepare(`update scenes set summary = '', summary_upto = null where id in (select scene_id from passages where id in (${changed.map(() => '?').join(',')}))`).run(...changed);
  if (chapter.status === 'closed') {
    const { summarizeChapter } = await import('./chapters.ts');
    usage = addUsage(usage, await summarizeChapter(job, story, chapter, {}));
  }
  updateTurn(turnId, { usage: JSON.stringify(usage) });
  emit(job, 'usage', { usage });
}

// Re-run bookkeeping for one passage (after a manual edit): undo its records and everything after, rebuild.
export async function runRedoRecords(job: Job, storyId: number, passageId: number) {
  const story = R.getStory(storyId)!;
  const all = R.storyProse(storyId);
  const idx = all.findIndex(p => p.id === passageId);
  if (idx < 0) throw new Error('No such passage.');
  const tail = all.slice(idx);
  if (tail.length > 30) { await runRecords(job, story, [passageId], { reconcile: true }); return; }
  const ids = tail.map(p => p.id);
  R.undoPassageChanges(storyId, ids);
  for (const id of ids) db.prepare(`update passages set records_status = 'pending' where id = ?`).run(id);
  for (let i = 0; i < ids.length; i += 4) await runRecords(job, story, ids.slice(i, i + 4));
}
