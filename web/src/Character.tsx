// A player's character in their own library: who they are, how they look, the 5e sheet (built by the AI from a few choices,
// then theirs to change), and a portrait. A campaign takes a copy of the sheet when the character sits down at its table.
import { useMemo, useRef, useState } from 'react';
import { api, buildOf, sheetBuilt, sheetOf, type Home, type Persona } from './api';
import { AiWrite, PortraitMaker, shrinkImage, useAssistJob } from './Assist';
import { Avatar, SheetAi, SheetForm, SheetView } from './Sheet';
import { errToast, Field, Modal, Seg, toast, useAsync } from './ui';

const SCORES = [
  { value: 'standard array, placed for the class', label: 'Standard array' },
  { value: 'point buy (27 points), spent well for the class', label: 'Point buy' },
  { value: 'rolled: 4d6 drop the lowest, six times, placed for the class', label: 'Roll them' },
  { value: 'own', label: 'My own' },
];

export function CharacterModal(p: { home: Home; persona: Persona | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const ex = p.persona;
  const initial = ex ? sheetOf(ex) : {};
  const [name, setName] = useState(ex?.name ?? '');
  const [description, setDescription] = useState(ex?.description ?? '');
  const [look, setLook] = useState(ex?.look ?? '');
  const [avatar, setAvatar] = useState<string | null>(ex?.avatar ?? null);
  const [sheet, setSheet] = useState<Record<string, string>>(initial);
  const [id, setId] = useState<number | null>(ex?.id ?? null);
  const built = sheetBuilt(sheet);
  const [tab, setTab] = useState<'build' | 'sheet'>(built ? 'sheet' : 'build');
  const [sheetMode, setSheetMode] = useState<'view' | 'edit' | 'levelup' | 'ai'>('view');
  // The quick build: a few choices the AI turns into a full sheet. They're saved with the character, so a character saved
  // before the sheet is built comes back with everything as it was left.
  const saved = buildOf(ex);
  const [b, setB] = useState({
    species: saved.species ?? initial.species ?? '', cls: saved.cls ?? (initial.class ?? '').replace(/\s*\d+.*$/, ''), subclass: saved.subclass ?? '',
    background: saved.background ?? initial.background ?? '', level: Number(saved.level) || Number(initial.level) || 1,
    scoresHow: SCORES.some(s => s.value === saved.scoresHow) ? saved.scoresHow : SCORES[0].value, scores: saved.scores ?? '', notes: saved.notes ?? '',
  });
  const job = useAssistJob();
  const { busy, run } = useAsync();
  const srd = p.home.srd;
  const subs = useMemo(() => srd.subclasses[Object.keys(srd.subclasses).find(k => k.toLowerCase() === b.cls.trim().toLowerCase()) ?? ''] ?? [], [b.cls]);
  const ready = p.home.hasWriter;
  const given = [name && `Name: ${name}`, b.species && `Species: ${b.species}`, b.cls && `Class: ${b.cls}${b.subclass ? ` (${b.subclass})` : ''}`, b.background && `Background: ${b.background}`, sheet.class && `Sheet: ${sheet.class}`].filter(Boolean).join('\n');

  // Closing with unsaved changes asks first (a sheet the AI just built is only kept once saved).
  const current = () => JSON.stringify({ name, description, look, avatar, sheet, b });
  const clean = useRef<string | null>(null);
  if (clean.current === null) clean.current = current();
  const close = () => {
    if (job.busy && !confirm('The sheet is still being built. Close anyway? It won’t be kept.')) return;
    if (!job.busy && current() !== clean.current && !confirm('Close without saving? Your changes to this character will be lost.')) return;
    p.onClose();
  };

  const save = (close = true) => run(async () => {
    if (!name.trim()) throw new Error('Give the character a name.');
    // The look goes onto the sheet only once there is a sheet: a look on its own would pass for a built one.
    const body = { name, description, look, avatar, build: { ...b, level: String(b.level) }, sheet: built ? { ...sheet, look: sheet.look || look } : sheet };
    const r = await api<{ persona: Persona }>(id ? `/personas/${id}` : '/personas', { method: id ? 'PUT' : 'POST', body });
    setId(r.persona.id);
    clean.current = current();
    await p.onSaved();
    toast(built ? 'Character saved.' : 'Saved. Build the sheet before bringing them to a table.');
    if (close) p.onClose();
    return r.persona;
  });
  const del = () => run(async () => {
    if (!id || !confirm(`Delete ${name}? Campaigns they're seated in lose them from the table.`)) return;
    await api(`/personas/${id}`, { method: 'DELETE' }); await p.onSaved(); p.onClose();
  });
  const build = () => {
    if (built && !confirm('Build a new sheet? It replaces the one there now.')) return;
    const scores = b.scoresHow === 'own' ? b.scores : b.scoresHow;
    job.start('/assist/sheet', { name, species: b.species, cls: b.cls, subclass: b.subclass, background: b.background, level: b.level, scores, notes: b.notes, description, look }, {
      done: r => { if (r.sheet) { setSheet(r.sheet); setTab('sheet'); setSheetMode('view'); toast('Sheet built. Look it over, change anything, then save.'); } },
    });
  };
  const upload = async (file: File) => { try { setAvatar(await shrinkImage(file)); } catch (e) { errToast(e); } };

  return (
    <Modal title={ex ? name || 'Character' : 'New character'} wide onClose={close} foot={<>
      {id && <button className="btn danger" onClick={del} disabled={busy}>Delete</button>}
      <span className="grow" />
      <button className="btn ghost" onClick={close}>Cancel</button>
      <button className="btn primary" onClick={() => save()} disabled={busy || !name.trim() || job.busy}>Save</button>
    </>}>
      <div className="char-top">
        <div className="col" style={{ alignItems: 'center', gap: 6 }}>
          <Avatar src={avatar} name={name} size={112} />
          <div className="row wrap" style={{ justifyContent: 'center', gap: 4 }}>
            <label className="btn sm">Upload<input type="file" accept="image/*" hidden onChange={e => e.target.files?.[0] && upload(e.target.files[0])} /></label>
            {avatar && <button className="btn sm ghost" onClick={() => setAvatar(null)}>Remove</button>}
          </div>
        </div>
        <div className="col grow" style={{ gap: 10, minWidth: 0 }}>
          <Field label="Name"><input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Ilsa Thornwood" /></Field>
          <div className="row wrap"><PortraitMaker ready={p.home.imageConn} name={name} look={look || sheet.look || ''} role={[b.species || sheet.species, b.cls || sheet.class].filter(Boolean).join(' ')} onImage={setAvatar} /></div>
        </div>
      </div>

      <div className="tabs" style={{ border: 0, padding: 0 }}>
        <button className={tab === 'build' ? 'on' : ''} onClick={() => setTab('build')}>Who they are</button>
        <button className={tab === 'sheet' ? 'on' : ''} onClick={() => setTab('sheet')}>Character sheet{built ? '' : ' (not built)'}</button>
      </div>

      {tab === 'build' && <>
        <div className="section-title">The build</div>
        <div className="grid2">
          <Field label="Species"><input type="text" list="dl-species" value={b.species} onChange={e => setB(x => ({ ...x, species: e.target.value }))} placeholder="Tiefling, or anything homebrew" /></Field>
          <Field label="Class"><input type="text" list="dl-classes" value={b.cls} onChange={e => setB(x => ({ ...x, cls: e.target.value }))} placeholder="Paladin" /></Field>
          <Field label="Subclass" hint="Optional, or leave it for the level that picks one."><input type="text" list="dl-subs" value={b.subclass} onChange={e => setB(x => ({ ...x, subclass: e.target.value }))} placeholder={subs[0] ?? ''} /></Field>
          <Field label="Background"><input type="text" list="dl-backgrounds" value={b.background} onChange={e => setB(x => ({ ...x, background: e.target.value }))} placeholder="Acolyte" /></Field>
          <Field label="Starting level"><input type="number" min={1} max={20} value={b.level} onChange={e => setB(x => ({ ...x, level: Math.max(1, Math.min(20, Number(e.target.value) || 1)) }))} /></Field>
          <Field label="Ability scores"><select value={b.scoresHow} onChange={e => setB(x => ({ ...x, scoresHow: e.target.value }))}>{SCORES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
        </div>
        {b.scoresHow === 'own' && <Field label="Your scores" hint="Before species bonuses, or say how you want them placed."><input type="text" value={b.scores} onChange={e => setB(x => ({ ...x, scores: e.target.value }))} placeholder="STR 15, DEX 10, CON 14, INT 8, WIS 12, CHA 13" /></Field>}
        <Field label="Wishes for the sheet" hint="Spells, feats, gear, a homebrew feature: anything goes, and the AI makes it fit the rules.">
          <textarea rows={3} value={b.notes} onChange={e => setB(x => ({ ...x, notes: e.target.value }))} placeholder="Take Healing Word. A homebrew trinket: her dead brother's compass, which always points to the nearest grave." />
        </Field>
        <datalist id="dl-species">{srd.species.map(x => <option key={x} value={x} />)}</datalist>
        <datalist id="dl-classes">{srd.classes.map(x => <option key={x} value={x} />)}</datalist>
        <datalist id="dl-subs">{subs.map(x => <option key={x} value={x} />)}</datalist>
        <datalist id="dl-backgrounds">{srd.backgrounds.map(x => <option key={x} value={x} />)}</datalist>

        <div className="section-title">The person</div>
        <Field label="Who they are" hint="Personality, how they talk, where they come from, what they want. The Dungeon Master reads it every round.">
          <textarea rows={8} value={description} onChange={e => setDescription(e.target.value)} />
        </Field>
        <AiWrite kind="character" value={description} onChange={setDescription} given={given} ready={ready} what="description" />
        <Field label="How they look" hint="For the portrait and how the Dungeon Master describes them.">
          <textarea rows={4} value={look} onChange={e => setLook(e.target.value)} />
        </Field>
        <AiWrite kind="look" value={look} onChange={setLook} given={given} ready={ready} what="description of how they look" />

        <div className="ai-box">
          {job.busy
            ? <div className="ai-row"><span className="muted small"><span className="spinner" /> {job.phase || 'building the sheet'}…</span><span className="grow" /><button className="btn sm" onClick={job.stop}>Stop</button></div>
            : <div className="ai-row">
              <span className="muted small grow">The AI builds the full 5e sheet from the build and the person: abilities, HP, AC, skills, attacks, spells, gear.</span>
              <button className="btn primary" onClick={build} disabled={!ready || !b.cls.trim()}>{built ? 'Rebuild the sheet' : 'Build the sheet'}</button>
            </div>}
        </div>
      </>}

      {tab === 'sheet' && <>
        {!built && <div className="muted">No sheet yet. Fill in the build on the first tab and press Build the sheet, or write one by hand.</div>}
        <div className="row wrap">
          <Seg value={sheetMode === 'levelup' || sheetMode === 'ai' ? 'view' : sheetMode} options={[{ value: 'view', label: 'View' }, { value: 'edit', label: 'Edit by hand' }]} onChange={v => setSheetMode(v as any)} />
          <span className="grow" />
          {id && built && <button className="btn sm" onClick={() => setSheetMode('levelup')} disabled={!ready}>Level up</button>}
          {id && built && <button className="btn sm" onClick={() => setSheetMode('ai')} disabled={!ready}>Change with AI</button>}
        </div>
        {!id && built && <div className="muted small">Save the character to level them up or change the sheet with AI.</div>}
        {id && (sheetMode === 'levelup' || sheetMode === 'ai') && <SheetAi path={`/personas/${id}/sheet/ai`} kind={sheetMode === 'levelup' ? 'levelup' : 'edit'} defs={p.home.schema.sheet} current={sheet}
          onCancel={() => setSheetMode('view')}
          onApply={async f => { setSheet(f); setSheetMode('view'); toast('Changed. Save to keep it.'); }} />}
        {sheetMode === 'edit' ? <SheetForm fields={sheet} defs={p.home.schema.sheet} onChange={(k, v) => setSheet(s => ({ ...s, [k]: v }))} />
          : built && <SheetView fields={sheet} defs={p.home.schema.sheet} />}
      </>}
    </Modal>
  );
}
