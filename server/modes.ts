// The campaign's settings, record shapes and prompt builders. There is one mode, D&D 5e at a table of players; the rest of
// the engine (records, context, chapters) asks this file, as it asked Inkwell's mode registry.
import { INKWELL_OPTIONS, buildArcSystem, buildSceneSummarySystem, buildSummarySystem, type StorySettings } from './rules.ts';
import * as D from './rules_dnd.ts';

export type FieldDef = { key: string; label: string; desc: string; short?: boolean; group?: string };
export type CardKind = 'npc' | 'user';

export const NPC: FieldDef[] = [
  { key: 'name', label: 'Name', desc: 'Full name as used in the story', short: true },
  { key: 'role_age', label: 'Role, age', desc: 'Role, age or age range', short: true },
  { key: 'appearance', label: 'Appearance', desc: 'Appearance' },
  { key: 'backstory', label: 'Backstory', desc: 'Backstory (may hold truths nobody knows yet)' },
  { key: 'relationship', label: 'Relationship with the party', desc: 'Where they stand with the party, and with any one character in particular' },
  { key: 'voice', label: 'Voice', desc: 'How they talk: vocabulary, tics, catchphrases, forms of address' },
];

// A player's character's 5e sheet, as short text fields the records keeper can follow and the app can show.
export const SHEET: FieldDef[] = [
  { key: 'species', label: 'Species', desc: 'Race or species, with subrace', short: true, group: 'who' },
  { key: 'class', label: 'Class', desc: 'Class and level, with subclass, e.g. "Rogue 3 (Thief)" or "Fighter 2 / Wizard 1"', short: true, group: 'who' },
  { key: 'background', label: 'Background', desc: 'Background', short: true, group: 'who' },
  { key: 'level', label: 'Level', desc: 'Total character level, e.g. "3"', short: true, group: 'who' },
  { key: 'xp', label: 'XP', desc: 'current/next level threshold, e.g. "950/2,700"', short: true, group: 'who' },
  { key: 'hp', label: 'HP', desc: 'current/max, with temporary HP after it, e.g. "21/24 +5 temp"', short: true, group: 'vitals' },
  { key: 'ac', label: 'AC', desc: 'Armor Class and where it comes from', short: true, group: 'vitals' },
  { key: 'speed', label: 'Speed', desc: 'e.g. "30 ft"', short: true, group: 'vitals' },
  { key: 'hit_dice', label: 'Hit Dice', desc: 'total and left, e.g. "3d8, 2 left"', short: true, group: 'vitals' },
  { key: 'proficiency', label: 'Proficiency', desc: 'Proficiency bonus, e.g. "+2"', short: true, group: 'vitals' },
  { key: 'abilities', label: 'Ability scores', desc: 'All six with modifiers, e.g. "STR 10 (+0), DEX 17 (+3), CON 14 (+2), INT 12 (+1), WIS 13 (+1), CHA 8 (-1)"', group: 'stats' },
  { key: 'saves', label: 'Saving throws', desc: 'All six with totals, proficient ones marked *', group: 'stats' },
  { key: 'skills', label: 'Skills', desc: 'Proficient skills with totals (* proficient, ** expertise), and Passive Perception', group: 'stats' },
  { key: 'proficiencies', label: 'Proficiencies & languages', desc: 'Armor, weapons, tools, languages', group: 'stats' },
  { key: 'attacks', label: 'Attacks', desc: 'Weapon and cantrip attacks with bonus and damage', group: 'play' },
  { key: 'spellcasting', label: 'Spellcasting', desc: 'Ability, spell save DC and attack bonus, or "None"', short: true, group: 'play' },
  { key: 'spell_slots', label: 'Spell slots', desc: 'Each level as left/max, e.g. "1st 2/4, 2nd 1/2", or "None"', group: 'play' },
  { key: 'spells', label: 'Spells', desc: 'Cantrips and spells by level, prepared ones marked', group: 'play' },
  { key: 'resources', label: 'Resources', desc: 'Class resources with uses left, and Inspiration', group: 'play' },
  { key: 'features', label: 'Features & traits', desc: 'Species traits, class and subclass features, feats, with uses', group: 'play' },
  { key: 'conditions', label: 'Conditions', desc: 'Short and concrete, with what they do; concentration; death saves; "None" when clear', group: 'play' },
  { key: 'equipment', label: 'Equipment', desc: 'Weapons, armor, gear, consumables and magic items', group: 'gear' },
  { key: 'money', label: 'Money', desc: 'Coins, e.g. "15 gp, 3 sp"', short: true, group: 'gear' },
  { key: 'look', label: 'Usual look', desc: 'How they normally look, rested and in their own clothes: build, hair, eyes, the clothes and gear they wear. It changes only for what lasts: a scar, new clothes they keep, a haircut', group: 'person' },
  { key: 'look_now', label: 'Look now', desc: 'Only what is different from the usual look right now: soaked, bloodied, torn, filthy, bandaged, a disguise. "As usual" when nothing is, and again once they have slept, washed, changed or time has passed', group: 'person' },
  { key: 'personality', label: 'Personality', desc: 'Traits, ideals, bonds and flaws, in a few lines', group: 'person' },
];
export const SHEET_KEYS = SHEET.map(f => f.key);

export const MODE = {
  key: 'dnd' as const, label: 'D&D 5e',
  picks: D.DND_PICKS, toggles: D.DND_TOGGLES, options: ['continuity_check', 'persona_quotes', 'lookups', 'history', 'polish'] as (keyof typeof INKWELL_OPTIONS)[],
  cards: { npc: NPC, user: SHEET } as Record<CardKind, FieldDef[]>,
  beats: ['event', 'fight', 'talk', 'quiet', 'intimate', 'skip'],
};
// The engine asks for a story's mode; every campaign has this one.
export const modeOf = (_s?: StorySettings) => MODE;
export const MODES = { dnd: MODE, story: MODE } as Record<string, typeof MODE>;

// Extra campaign options beside the craft picks and toggles.
export const TABLE_OPTIONS = {
  scene_art: { label: 'Scene pictures', default: 'off', hint: 'Paints a picture for each new scene with the Images connection. Any player can also paint one by hand from a passage.', options: [
    { value: 'off', label: 'By hand only' }, { value: 'auto', label: 'Every new scene' }] },
  auto_go: { label: 'Start the round', default: 'all_ready', hint: 'When the Dungeon Master writes: as soon as every active player is ready, or only when the host presses Go.', options: [
    { value: 'all_ready', label: 'When everyone is ready' }, { value: 'host', label: 'When the host says go' }] },
};

export function defaultSettings(): StorySettings {
  const s: any = { mode: 'dnd', toggles: {} };
  for (const p of MODE.picks) s[p.key] = p.default;
  for (const t of MODE.toggles) s.toggles[t.key] = t.default;
  for (const [k, d] of Object.entries(INKWELL_OPTIONS)) s[k] = d.default;
  for (const [k, d] of Object.entries(TABLE_OPTIONS)) s[k] = d.default;
  s.prose_lint = true;
  s.art_style = 'painterly';
  s.banned_phrases = '';
  return s as StorySettings;
}

export function normalizeSettings(raw: any): StorySettings {
  const d = defaultSettings();
  const s: any = { ...d, ...(raw || {}), mode: 'dnd', toggles: { ...d.toggles, ...(raw?.toggles || {}) } };
  for (const p of MODE.picks) if (!p.options.some(o => o.value === s[p.key])) s[p.key] = p.default;
  for (const [k, def] of Object.entries({ ...INKWELL_OPTIONS, ...TABLE_OPTIONS })) if (!def.options.some(o => o.value === s[k])) s[k] = def.default;
  for (const k of Object.keys(s.toggles)) if (!MODE.toggles.some(t => t.key === k)) delete s.toggles[k];
  s.prose_lint = s.prose_lint !== false;
  s.banned_phrases = String(s.banned_phrases ?? '').slice(0, 4000);
  s.art_style = ['painterly', 'anime', 'realistic', 'comic'].includes(s.art_style) ? s.art_style : 'painterly';
  return s as StorySettings;
}

// ---------------------------------------------------------------- prompt builders

export const craftRules = (s: StorySettings) => D.dndCraftRules(s);
export const writeReminders = (s: StorySettings) => D.dndWriteReminders(s);
export const planStep = (s: StorySettings) => D.dndPlanStep(s);
export const recordsSystem = (s: StorySettings, title: string, party: string[]) => D.dndRecordsSystem(s, title, party);
export const checkSystem = (s: StorySettings) => D.dndCheckSystem(s);
export const summarySystem = (_s: StorySettings, _name: string) => D.forParty(buildSummarySystem('{{user}}'));
export const sceneSummarySystem = (_s: StorySettings, _name: string) => D.forParty(buildSceneSummarySystem('{{user}}'));
export const arcSystem = (_s: StorySettings, _name: string) => D.forParty(buildArcSystem('{{user}}'));
export const defaultTemplate = (_s?: StorySettings) => D.DND_SUMMARY_TEMPLATE;

// What the client needs to draw the settings and the sheet.
export function modeSchema() {
  return {
    picks: MODE.picks.map(p => ({ key: p.key, label: p.label, default: p.default, options: p.options.map(o => ({ value: o.value, label: o.label })) })),
    toggles: MODE.toggles.map(({ text, ...t }) => t),
    inkwell: Object.fromEntries(MODE.options.map(k => [k, INKWELL_OPTIONS[k]])),
    table: TABLE_OPTIONS,
    sheet: SHEET, npc: NPC,
    defaultTemplate: D.DND_SUMMARY_TEMPLATE,
  };
}
