// A character's 5e sheet: read at a glance, edited by hand, or changed by the AI (a level-up, a new spell, homebrew).
import { useState } from 'react';
import { hpOf, type FieldDef } from './api';
import { useAssistJob } from './Assist';

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
      {rest.map(d => <div key={d.key} className="s5-f"><b>{d.label}</b><div>{f[d.key]}</div></div>)}
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

// The AI changes the sheet as the player asks (a level-up, a feat, a homebrew spell), shows what it changed, and the player keeps it or not.
export function SheetAi(p: { path: string; kind: 'levelup' | 'edit'; defs: FieldDef[]; current: Record<string, string>; onApply: (fields: Record<string, string>, summary: string) => Promise<void> | void; onCancel?: () => void }) {
  const [request, setRequest] = useState('');
  const [result, setResult] = useState<{ fields: Record<string, string>; summary: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const job = useAssistJob();
  const go = () => job.start(p.path, { kind: p.kind, request }, { done: r => { if (r.fields) setResult({ fields: r.fields, summary: r.summary ?? '' }); } });
  const changed = result ? p.defs.filter(d => result.fields[d.key] != null && String(result.fields[d.key]).trim() !== String(p.current[d.key] ?? '').trim()) : [];
  const apply = async () => {
    if (!result) return;
    setApplying(true);
    try { await p.onApply({ ...p.current, ...Object.fromEntries(changed.map(d => [d.key, result.fields[d.key]])) }, result.summary); setResult(null); setRequest(''); }
    finally { setApplying(false); }
  };
  return (
    <div className="ai-box">
      {!result && <>
        <textarea rows={3} value={request} onChange={e => setRequest(e.target.value)} disabled={job.busy}
          placeholder={p.kind === 'levelup' ? 'What to take at the new level (a subclass, a feat or ability increase, spells), or leave empty and let the AI choose well. Homebrew is fine.' : 'What to change. "Add the homebrew spell Ember Lash (1st level, ...)", "Swap Shield for Absorb Elements", "She found a +1 longsword".'} />
        <div className="ai-row">
          {job.busy
            ? <><span className="muted small"><span className="spinner" /> {job.phase || 'working'}…</span><span className="grow" /><button type="button" className="btn sm" onClick={job.stop}>Stop</button></>
            : <><span className="muted small grow">{p.kind === 'levelup' ? 'The AI does the 5e math: HP, slots, features, proficiency.' : 'The AI changes what you ask and anything that follows from it.'}</span>
              {p.onCancel && <button type="button" className="btn sm" onClick={p.onCancel}>Close</button>}
              <button type="button" className="btn sm primary" onClick={go} disabled={p.kind === 'edit' && !request.trim()}>{p.kind === 'levelup' ? 'Level up' : 'Change it'}</button></>}
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
