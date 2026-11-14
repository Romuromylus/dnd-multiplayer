// Help with what a campaign is built from: a world written from a few words, a character's backstory and look, the 5e sheet
// built from them, a level-up, a change to a sheet, and a portrait. Each runs as a job of its own, so a long reply streams and
// a slow one isn't cut off on the way.
import { emit, type Job } from './jobs.ts';
import { callModel } from './llm.ts';
import { callJson, withRoom } from './ask.ts';
import * as R from './records.ts';
import { BANNED_NAMES } from './rules.ts';
import { sheetBuildSystem, sheetEditSystem } from './rules_dnd.ts';
import { SHEET_KEYS } from './modes.ts';
import { generateImage, imageConn, styleOf } from './art.ts';
import { clip } from './util.ts';

export type AssistKind = 'world' | 'character' | 'look';
// given: what the form already holds apart from this text (the character's name, species, class...).
export type AssistAsk = { kind: AssistKind; idea: string; current?: string; given?: string };

export type AssistEdit = 'new' | 'revise' | 'improve';
export const assistEdit = (a: { idea: string; current?: string }): AssistEdit => !(a.current ?? '').trim() ? 'new' : a.idea.trim() ? 'revise' : 'improve';

const revising = (what: string, facts: string) => `

<revising>
The author already has this ${what} and asks for a change to it. This is an edit, not a rewrite, and it overrides the layout and the length given above.
- Change only what the request asks for. Every other section, sentence and detail comes back word for word, in the order and the layout it already has.
- Add nothing the request didn't ask for. Where the text is silent it stays silent: no new section, and no new fact to fill a gap${facts}.
- If the change makes another line untrue, fix that line too, and nothing beyond it.
</revising>`;

export function assistSystem(kind: AssistKind, edit: AssistEdit = 'new'): string {
  const rev = edit === 'revise';
  if (kind === 'character') return `You write the backstory and personality of a player's character for a D&D 5th Edition campaign played in text. The Dungeon Master model reads it before every round, so it says who this person is and what drives them.

<what_it_holds>
Labelled sections in this order:
Personality: how they act and why: what they want, what they fear, how they treat people, a contradiction or two. Behavior, not a row of adjectives.
Speech: how they talk, with one short line in their voice.
Background: where they come from and what made them who they are, in one short paragraph, fitting their species, class and background.
Goals: what they are after now, and one thing they would never do.
</what_it_holds>

<rules>
- Keep everything the author gave, in their terms${rev ? '' : ', and fill the gaps with specifics'}. What the form already settled (name, species, class, background) is in <already_given>: build on it, don't repeat it as a list.
- No other player's characters, and named people only when the author named them; family or a mentor can be mentioned by role.
- Leave out how they look: that has its own field.
- Third person, present tense. Plain text: each section is its label, a colon, then prose. No markdown symbols, no preamble and no closing note.
- 150 to 350 words, unless they ask for more.
</rules>${rev ? revising('character', ": no history, goal or trait it doesn't already state") : ''}

Reply with the text only.`;
  if (kind === 'look') return `You write how a player's character in a D&D 5th Edition campaign looks: the text their portrait is painted from and the Dungeon Master describes them by.

<rules>
- One paragraph of concrete, visual detail: apparent age, build, height, skin, hair, eyes, face, what marks them out (scars, tattoos, horns, a missing finger), and what they usually wear and carry on them (armor, robes, weapons on the belt or back), fitting their species, class and background in <already_given>.
- Keep everything the author gave${rev ? '' : ', and fill the gaps with specifics'}. Only how they look: no personality, no history, no pose or place.
- Plain text, no labels, no markdown. 60 to 140 words.
</rules>${rev ? revising('description', ": no feature it doesn't already state") : ''}

Reply with the paragraph only.`;
  return `You write the world brief for a D&D 5th Edition campaign that an AI Dungeon Master runs in text for a table of players. It is the standing brief the Dungeon Master reads before every round: what is true, what this campaign is about, how it should feel. The author gives you a few words, and you turn them into a brief a Dungeon Master could start running at once.

<what_it_holds>
Short labelled sections, in this order, leaving out any that don't apply: Setting (the world or the published setting it uses, and the region where play happens), Tone, Factions (each with what it wants), Dangers, Places (a few the party will see early, a line each), Where the campaign starts (the opening situation that brings the party together), House rules.
</what_it_holds>

<rules>
- Keep everything the author gave, in their terms.${rev ? '' : ' Where they left a gap, fill it with something specific: a named place, a faction with a want, a pressure that is about to break. No padding with generalities.'}
- If it uses a published setting (the Forgotten Realms, Eberron, Ravenloft...) or an existing work, name it and build on it as you know it, under its real names. Where you aren't sure of a detail, stay general rather than inventing one.
- It sets things up and never tells the story. Give the situation, the tensions and the opening moment, and leave what happens open. No plot outline and no ending.
- The players' characters come from their own sheets: don't name or describe them. Say only why a party would be at the starting point.
- Names you make up fit the setting's culture. Never use these: ${BANNED_NAMES}.
- Tone is a line or two of concrete direction (what it reads like, how dark, how funny, how explicit if they said), not adjectives in a row.
- Plain text. Each section is its label, a colon, then a few sentences or a short list of lines. No markdown symbols, no preamble and no closing note. 250 to 600 words, unless they ask for more.
</rules>${rev ? revising('world brief', '') : ''}

Reply with the world brief only.`;
}

export function assistUser(a: AssistAsk): string {
  const idea = a.idea.trim(), current = (a.current ?? '').trim();
  const parts: string[] = [];
  if ((a.given ?? '').trim()) parts.push(`<already_given note="Settled, and kept apart from this text: build on it and don't repeat it.">\n${clip(a.given!.trim(), 4000)}\n</already_given>`);
  if (idea) parts.push(`<request>\n${clip(idea, 6000)}\n</request>`);
  if (current) parts.push(`<current_text note="${idea ? "Revise this as the request asks. Everything the request doesn't touch comes back word for word, and nothing is added that it didn't ask for." : 'Improve this: fill its gaps and tighten it, keeping everything it says.'}">\n${clip(current, 12000)}\n</current_text>`);
  parts.push('Write it now.');
  return parts.join('\n\n');
}

export async function runAssist(job: Job, a: AssistAsk) {
  const conn = R.defaultConn('writer');
  if (!conn) throw new Error('No connection set up yet.');
  emit(job, 'phase', { phase: 'write', label: 'writing' });
  const r = await callModel({
    conn, system: [{ text: assistSystem(a.kind, assistEdit(a)) }], messages: [{ role: 'user', content: [{ type: 'text', text: assistUser(a) }] }],
    maxTokens: withRoom(conn, 5000), signal: job.abort.signal, onText: delta => emit(job, 'text', { delta }),
  });
  const text = r.text.replace(/\r/g, '').trim();
  if (!text) throw new Error('Nothing came back. Try again.');
  emit(job, 'assist', { text });
}

// ---------------------------------------------------------------- character sheets

export type BuildAsk = { name: string; species: string; cls: string; subclass: string; background: string; level: number; scores: string; notes: string; description: string; look: string };

const keepKnown = (j: any) => Object.fromEntries(SHEET_KEYS.filter(k => j?.[k] != null).map(k => [k, String(j[k]).trim()]));

export async function runBuildSheet(job: Job, a: BuildAsk) {
  const conn = R.defaultConn('records') ?? R.defaultConn('writer');
  if (!conn) throw new Error('No connection set up yet.');
  emit(job, 'phase', { phase: 'records', label: 'building the character sheet' });
  const user = [
    `<character name="${a.name || 'unnamed'}">`,
    `Species: ${a.species || '(the player left it open)'}`,
    `Class: ${a.cls || '(the player left it open)'}${a.subclass ? `, subclass ${a.subclass}` : ''}`,
    `Background: ${a.background || '(the player left it open)'}`,
    `Level: ${Math.max(1, Math.min(20, a.level || 1))}`,
    `Ability scores: ${a.scores || 'standard array, placed for the class'}`,
    a.notes ? `The player's wishes (spells, feats, gear, homebrew):\n${clip(a.notes, 3000)}` : '',
    a.description ? `Who they are:\n${clip(a.description, 4000)}` : '',
    a.look ? `How they look:\n${clip(a.look, 1500)}` : '',
    `</character>`,
    'Build the sheet now. JSON only.',
  ].filter(Boolean).join('\n');
  const r = await callJson<Record<string, any>>({ conn, system: [{ text: sheetBuildSystem() }], messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 9000, signal: job.abort.signal }, { ok: j => !!j && typeof j === 'object' && !!j.class });
  if (!r.json) throw new Error(`The sheet could not be built. ${r.why}`);
  const fields = keepKnown(r.json);
  if (a.look && !fields.look) fields.look = a.look;
  emit(job, 'assist', { sheet: fields });
}

export async function runSheetEdit(job: Job, o: { kind: 'levelup' | 'edit'; name: string; sheet: Record<string, string>; request: string; context?: string }) {
  const conn = R.defaultConn('records') ?? R.defaultConn('writer');
  if (!conn) throw new Error('No connection set up yet.');
  emit(job, 'phase', { phase: 'records', label: o.kind === 'levelup' ? 'levelling up' : 'changing the sheet' });
  const user = [
    `<sheet name="${o.name}">\n${SHEET_KEYS.map(k => `${k}: ${o.sheet[k] ?? ''}`).join('\n')}\n</sheet>`,
    o.context ? `<campaign note="What has happened to them lately, for choices that fit the story">\n${clip(o.context, 3000)}\n</campaign>` : '',
    `<request from="the player">\n${clip(o.request.trim() || (o.kind === 'levelup' ? 'Level me up; you choose what a good player would.' : ''), 3000)}\n</request>`,
    'JSON only.',
  ].filter(Boolean).join('\n\n');
  const r = await callJson<{ fields: Record<string, any>; summary: string }>({ conn, system: [{ text: sheetEditSystem(o.kind) }], messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 9000, signal: job.abort.signal }, { ok: j => !!j?.fields && typeof j.fields === 'object' });
  if (!r.json) throw new Error(`The sheet could not be changed. ${r.why}`);
  emit(job, 'assist', { fields: keepKnown(r.json.fields), summary: String(r.json.summary ?? '').trim() });
}

// ---------------------------------------------------------------- a character's portrait

export function avatarPrompt(style: string, name: string, look: string, role = ''): string {
  return `${styleOf(style)}. Character portrait of ${name.trim() || 'an adventurer'}${role ? `, ${role}` : ''}. ${clip(look.replace(/\s+/g, ' ').trim(), 1200)} Draw only how they look, at ease: leave out any place, action or other person the description mentions. Head and shoulders, centered, facing the viewer, simple softly lit background. No text, no lettering, no frame.`;
}

let sharpLib: any;
export async function avatarData(buf: Buffer): Promise<string> {
  sharpLib ??= (await import('sharp')).default;
  const out: Buffer = await sharpLib(buf).resize(384, 384, { fit: 'cover', position: 'top' }).jpeg({ quality: 86 }).toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

export async function runAvatar(job: Job, o: { name: string; look: string; role: string; style: string }) {
  const conn = imageConn();
  if (!conn) throw new Error('No Images connection is set up. An admin can add one under Connections.');
  if (!o.look.trim()) throw new Error('Write how they look first.');
  emit(job, 'phase', { phase: 'art', label: 'painting the portrait' });
  const img = await generateImage(conn, avatarPrompt(o.style, o.name, o.look, o.role), '1024x1024');
  if (job.abort.signal.aborted) return;
  emit(job, 'assist', { image: await avatarData(img.buf) });
}
