// A character's 5e sheet: read at a glance, edited by hand, or changed by the AI (a level-up, a new spell, homebrew).
import { useState } from 'react';
import { hpOf, type FieldDef } from './api';
import { useAssistJob } from './Assist';
import { die, DmChat, type ChatLine, type ChatSetup } from './BuildChat';
import { Seg } from './ui';

export const GROUPS: { key: string; label: string }[] = [
  { key: 'who', label: 'Who' }, { key: 'vitals', label: 'Vitals' }, { key: 'stats', label: 'Abilities & skills' },
  { key: 'play', label: 'In play' }, { key: 'gear', label: 'Gear' }, { key: 'person', label: 'The person' },
];

const ABIL = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
export function abilities(text: string | undefined): { k: string; score: string; mod: string }[] | null {
  const out: { k: string; score: string; mod: string }[] = [];
  for (const k of ABIL) {
    const m = String(text ?? '').match(new RegExp(`${k}\\w*\\s*:?\\s*(\\d+)\\s*(?:\\(\\s*([+\\-−–]?\\s*\\d+)\\s*\\))?`, 'i'));
    if (!m) return null;
    const score = Number(m[1]);
    const mod = m[2] ? m[2].replace(/\s/g, '').replace(/[−–]/, '-') : String(Math.floor((score - 10) / 2));
    out.push({ k, score: m[1], mod: /^[+-]/.test(mod) ? mod : `+${mod}` });
  }
  return out;
}

export function HpBar(p: { hp?: string; small?: boolean }) {
  const hp = hpOf(p.hp);
  if (!hp) return p.hp ? <span className="chip">HP {p.hp}</span> : null;
  const [cur, max] = hp;
  const pct = Math.max(0, Math.min(100, max ? (cur / max) * 100 : 0));
  const tone = cur <= 0 ? 'down' : pct <= 25 ? 'low' : pct <= 50 ? 'mid' : 'ok';
  const temp = String(p.hp ?? '').match(/\+\s*(\d+)\s*temp/i)?.[1];
  return (
    <div className={`hpbar ${tone} ${p.small ? 'small' : ''}`} title={`HP ${p.hp}`}>
      <div className="fill" style={{ width: `${pct}%` }} />
      <span className="lbl">{cur <= 0 ? 'DOWN' : `${cur}/${max}`}{temp ? ` +${temp}` : ''}</span>
    </div>
  );
}

const shown = (v: string | undefined) => !!v && !/^\s*(none|—|-|n\/a)?\s*$/i.test(v);

// ---------------------------------------------------------------- long fields as bullet lists
// The records keep features, spells, gear and the rest as running text. Here they are cut into entries at the separators
// the sheet uses, never inside brackets, so a description's own commas and semicolons stay with it.
type Cut = { semis?: 'any' | 'entry'; commas?: boolean; sentences?: boolean; sub?: boolean };
const LIST_FIELDS: Record<string, Cut> = {
  features: { semis: 'entry' }, spells: { semis: 'entry', sub: true }, personality: { semis: 'entry' },
  resources: { semis: 'any', sentences: true }, attacks: { semis: 'any' }, proficiencies: { semis: 'any' }, equipment: { semis: 'any', commas: true },
};
// A labelled entry starting: "Fey Ancestry: ...", "1st level (known): ...", "Tides of Chaos (1/long rest): ...".
const LABEL = /^[A-Z0-9][^.:;()\n]{0,50}(?:\([^()]*\))?[^.:;()\n]{0,24}:\s/;
const LABELLED = /^([A-Z0-9][^.:;()\n]{0,50}(?:\([^()]*\))?[^.:;()\n]{0,24}):\s+([\s\S]+)$/;

function cutPoints(s: string, c: Cut, labelsOnly: boolean): number[] {
  const at: number[] = [];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if (depth) continue;
    const next = s.slice(i + 1).replace(/^ /, '');
    const spaced = s[i + 1] === ' ';
    const label = (ch === '.' || ch === ';') && spaced && LABEL.test(next);
    const cut = ch === '\n' || label || (!labelsOnly && (
      // "; Keen Senses" starts an entry; "; on a 1, roll again" goes on with the one before.
      (ch === ';' && (c.semis === 'any' || (c.semis === 'entry' && /^[A-Z0-9]/.test(next))))
      || (ch === ',' && !!c.commas)
      || (ch === '.' && spaced && !!c.sentences && /^[A-Z0-9]/.test(next))));
    if (cut) at.push(i);
  }
  return at;
}
export function cutEntries(s: string, c: Cut): string[] {
  // Written as "Label: description" entries, a description's own semicolons stay in it.
  const labelled = c.semis === 'entry' ? cutPoints(s, c, true) : [];
  const at = labelled.length >= 2 ? labelled : cutPoints(s, c, false);
  const out: string[] = [];
  let from = 0;
  for (const i of at) { out.push(s.slice(from, i)); from = i + 1; }
  out.push(s.slice(from));
  return out.map(x => x.trim().replace(/[.;,]$/, '').trim()).filter(Boolean);
}

type Entry = { label?: string; text: string; sub?: string[] };
export function listOf(key: string, v: string): Entry[] | null {
  const c = LIST_FIELDS[key];
  if (!c) return null;
  const entries = cutEntries(v, c).map(x => {
    const m = x.match(LABELLED);
    const e: Entry = m ? { label: m[1].trim(), text: m[2].trim() } : { text: x };
    // A spell level's spells, one each: "Cantrips (5): Fire Bolt, Mage Hand, ...".
    if (c.sub && e.label) { const sub = cutEntries(e.text, { commas: true }); if (sub.length > 1) e.sub = sub; }
    return e;
  });
  return entries.length > 1 || entries[0]?.sub ? entries : null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function FieldBody(p: { k: string; v: string }) {
  const list = listOf(p.k, p.v);
  if (!list) return <div>{p.v}</div>;
  return (
    <ul className="s5-list">
      {list.map((e, i) => <li key={i}>
        {e.label && <span className="lbl">{e.label}{e.sub ? '' : ':'}</span>}{e.label && !e.sub ? ' ' : ''}
        {e.sub ? <ul>{e.sub.map((x, j) => <li key={j}>{cap(x)}</li>)}</ul> : e.label ? e.text : cap(e.text)}
      </li>)}
    </ul>
  );
}

export function SheetView(p: { fields: Record<string, string>; defs: FieldDef[] }) {
  const f = p.fields;
  const ab = abilities(f.abilities);
  const head = [f.species, f.class, f.background].filter(Boolean).join(' · ');
  const used = new Set(['name', 'species', 'class', 'background', 'level', 'hp', 'ac', 'speed', 'proficiency', 'hit_dice', 'xp', ...(ab ? ['abilities'] : [])]);
  const rest = p.defs.filter(d => !used.has(d.key) && shown(f[d.key]));
  return (
    <div className="sheet5">
      {head && <div className="s5-head">{head}{f.level && !/\d/.test(f.class ?? '') ? ` · level ${f.level}` : ''}</div>}
      <div className="s5-vitals">
        <HpBar hp={f.hp} />
        {f.ac && <span className="chip"><b>AC</b> {f.ac}</span>}
        {f.speed && <span className="chip"><b>Speed</b> {f.speed}</span>}
        {f.proficiency && <span className="chip"><b>Prof</b> {f.proficiency}</span>}
        {f.hit_dice && <span className="chip"><b>Hit dice</b> {f.hit_dice}</span>}
        {f.xp && <span className="chip"><b>XP</b> {f.xp}</span>}
      </div>
      {ab && <div className="s5-abil">{ab.map(a => <div key={a.k} className="ab"><div className="k">{a.k}</div><div className="m">{a.mod}</div><div className="s">{a.score}</div></div>)}</div>}
      {rest.map(d => <div key={d.key} className="s5-f"><b>{d.label}</b><FieldBody k={d.key} v={f[d.key]} /></div>)}
    </div>
  );
}

// Every field, grouped, for editing by hand.
export function SheetForm(p: { fields: Record<string, string>; defs: FieldDef[]; onChange: (key: string, v: string) => void; withName?: boolean }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      {p.withName && <label className="field">Name<input type="text" value={p.fields.name ?? ''} onChange={e => p.onChange('name', e.target.value)} /></label>}
      {GROUPS.map(g => {
        const defs = p.defs.filter(d => (d.group ?? 'play') === g.key);
        if (!defs.length) return null;
        return (
          <div key={g.key} className="col" style={{ gap: 8 }}>
            <div className="section-title">{g.label}</div>
            <div className={defs.every(d => d.short) ? 'grid2' : 'col'} style={{ gap: 8 }}>
              {defs.map(d => (
                <label key={d.key} className="field" title={d.desc}>{d.label}
                  {d.short ? <input type="text" value={p.fields[d.key] ?? ''} onChange={e => p.onChange(d.key, e.target.value)} placeholder={d.desc} />
                    : <textarea rows={Math.min(8, Math.max(2, Math.ceil((p.fields[d.key] ?? '').length / 70)))} value={p.fields[d.key] ?? ''} onChange={e => p.onChange(d.key, e.target.value)} placeholder={d.desc} />}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// A level-up talked through with the Dungeon Master: it says what the new level gives and goes through the choices it asks
// for, noting each one; Level up then works the sheet out from them.
const levelSetup = (path: string, current: Record<string, string>, choices: string): ChatSetup => {
  const sides = Number(String(current.hit_dice ?? '').match(/d(\d+)/)?.[1]) || 0;
  return {
    path: path.replace(/\/ai$/, '/chat'),
    body: () => ({ choices }),
    greeting: `Level up! Say what you have in mind, or ask me to walk you through it: I'll tell you what the new level gives and go through each choice it asks for, one at a time.`,
    starters: [
      { label: 'Walk me through it', text: 'Walk me through this level, one choice at a time.' },
      { label: 'You choose for me', text: 'Choose everything for this level the way a good player would for this character, and tell me what you picked.' },
    ],
    roll: sides ? {
      label: `🎲 Roll HP (1d${sides})`, title: 'Your hit die for the new level’s HP. Once.', marker: '🎲 I rolled my hit die',
      confirm: `Roll your hit die (1d${sides}) for this level's HP? You roll once and keep it. (The average is the safe choice.)`,
      make: () => `🎲 I rolled my hit die for HP (1d${sides}): ${die(sides)}.`,
    } : null,
    placeholder: 'Ask about a choice, or say what you want…',
    noting: 'noting your choices',
  };
};

// The AI changes the sheet as the player asks (a level-up, a feat, a homebrew spell), shows what it changed, and the player keeps it or not.
export function SheetAi(p: { path: string; kind: 'levelup' | 'edit'; defs: FieldDef[]; current: Record<string, string>; onApply: (fields: Record<string, string>, summary: string) => Promise<void> | void; onCancel?: () => void }) {
  const [request, setRequest] = useState('');
  const [result, setResult] = useState<{ fields: Record<string, string>; summary: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [how, setHow] = useState<'talk' | 'quick'>('talk');
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [choices, setChoices] = useState('');
  const talking = p.kind === 'levelup' && how === 'talk';
  const settled = lines.some(l => l.draft?.ready);
  const job = useAssistJob();
  const go = (req = request) => job.start(p.path, { kind: p.kind, request: req }, { done: r => { if (r.fields) setResult({ fields: r.fields, summary: r.summary ?? '' }); } });
  const levelUp = () => go(`The player's choices for this level, settled in a talk with the Dungeon Master. Follow them exactly:\n${choices}`);
  const changed = result ? p.defs.filter(d => result.fields[d.key] != null && String(result.fields[d.key]).trim() !== String(p.current[d.key] ?? '').trim()) : [];
  const apply = async () => {
    if (!result) return;
    setApplying(true);
    try { await p.onApply({ ...p.current, ...Object.fromEntries(changed.map(d => [d.key, result.fields[d.key]])) }, result.summary); setResult(null); setRequest(''); }
    finally { setApplying(false); }
  };
  return (
    <div className="ai-box">
      {!result && p.kind === 'levelup' && <div className="row wrap">
        <Seg value={how} options={[{ value: 'talk', label: 'Talk it through' }, { value: 'quick', label: 'Just do it' }]} onChange={v => setHow(v as 'talk' | 'quick')} />
        <span className="muted small">{talking ? 'The Dungeon Master explains each choice and notes what you pick.' : 'Say what you want in a line, or leave it to the AI.'}</span>
      </div>}
      {!result && talking && <>
        <DmChat lines={lines} setLines={setLines} setup={levelSetup(p.path, p.current, choices)} onDraft={d => { if (typeof d.choices === 'string') setChoices(d.choices); }} ready />
        <div className="rec sofar">
          <div className="h"><b>Your choices</b></div>
          <div className={`v ${choices ? '' : 'dim'}`} style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{choices || 'Nothing settled yet.'}</div>
        </div>
        <div className="ai-row">
          {job.busy
            ? <><span className="muted small"><span className="spinner" /> {job.phase || 'levelling up'}…</span><span className="grow" /><button type="button" className="btn sm" onClick={job.stop}>Stop</button></>
            : <><span className="muted small grow">{settled ? 'Everything this level asks for is settled.' : 'Level up once your choices are settled. You look the sheet over before it is kept.'}</span>
              {p.onCancel && <button type="button" className="btn sm" onClick={p.onCancel}>Close</button>}
              <button type="button" className={`btn sm ${settled ? 'primary' : ''}`} onClick={levelUp} disabled={!choices.trim()}>Level up</button></>}
        </div>
      </>}
      {!result && !talking && <>
        <textarea rows={3} value={request} onChange={e => setRequest(e.target.value)} disabled={job.busy}
          placeholder={p.kind === 'levelup' ? 'What to take at the new level (a subclass, a feat or ability increase, spells), or leave empty and let the AI choose well. Homebrew is fine.' : 'What to change. "Add the homebrew spell Ember Lash (1st level, ...)", "Swap Shield for Absorb Elements", "She found a +1 longsword".'} />
        <div className="ai-row">
          {job.busy
            ? <><span className="muted small"><span className="spinner" /> {job.phase || 'working'}…</span><span className="grow" /><button type="button" className="btn sm" onClick={job.stop}>Stop</button></>
            : <><span className="muted small grow">{p.kind === 'levelup' ? 'The AI does the 5e math: HP, slots, features, proficiency.' : 'The AI changes what you ask and anything that follows from it.'}</span>
              {p.onCancel && <button type="button" className="btn sm" onClick={p.onCancel}>Close</button>}
              <button type="button" className="btn sm primary" onClick={() => go()} disabled={p.kind === 'edit' && !request.trim()}>{p.kind === 'levelup' ? 'Level up' : 'Change it'}</button></>}
        </div>
      </>}
      {result && <>
        {result.summary && <div className="small"><b>{result.summary}</b></div>}
        {changed.length === 0 ? <div className="muted small">Nothing on the sheet changed.</div>
          : <div className="diff">{changed.map(d => (
            <div key={d.key} className="d">
              <div className="k">{d.label}</div>
              {String(p.current[d.key] ?? '').trim() && <div className="old">{p.current[d.key]}</div>}
              <div className="new">{result.fields[d.key]}</div>
            </div>
          ))}</div>}
        <div className="ai-row">
          <span className="grow" />
          <button type="button" className="btn sm" onClick={() => setResult(null)} disabled={applying}>Discard</button>
          <button type="button" className="btn sm primary" onClick={apply} disabled={applying || !changed.length}>Keep it</button>
        </div>
      </>}
    </div>
  );
}

export function Avatar(p: { src?: string | null; name: string; size?: number }) {
  const size = p.size ?? 36;
  if (p.src) return <img className="avatar" src={p.src} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  return <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42 }}>{(p.name || '?').trim().slice(0, 1).toUpperCase()}</span>;
}
