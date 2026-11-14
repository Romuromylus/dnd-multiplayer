// Who sits at the table: each character with HP, AC and conditions, who is here and ready, the invite code, and the scene.
import { useState } from 'react';
import { api, hasSheet, type Detail, type Home } from './api';
import { Avatar, HpBar, SheetAi, SheetForm, SheetView } from './Sheet';
import { Modal, Seg, toast, useAsync } from './ui';

export function PartyPanel(p: { d: Detail; home: Home; reload: () => Promise<any>; busy: boolean; onSheet: (personaId: number) => void; onGo: () => void }) {
  const d = p.d;
  const { busy, run } = useAsync();
  const me = d.table.find(s => s.user_id === d.me);
  const mine = p.home.characters.filter(c => hasSheet(c));
  const link = `${location.origin}/?join=${d.story.invite_code}`;
  const copy = async (t: string, what: string) => { try { await navigator.clipboard.writeText(t); toast(`${what} copied.`); } catch { prompt(`Copy the ${what.toLowerCase()}:`, t); } };
  const seat = (body: any) => run(async () => { await api(`/stories/${d.story.id}/seat`, { method: 'PUT', body }); await p.reload(); });
  const remove = (uid: number, name: string) => run(async () => {
    if (!confirm(uid === d.me ? 'Leave this table? Your character stays in your library.' : `Remove ${name} from the table?`)) return;
    await api(`/stories/${d.story.id}/seat/${uid}`, { method: 'DELETE' }); await p.reload();
  });
  const milestone = () => run(async () => {
    if (!confirm('Give the party a milestone? Every character can then level up.')) return;
    await api(`/stories/${d.story.id}/milestone`, { body: {} }); await p.reload();
  });
  const sc = d.scene;
  return (
    <div className="col" style={{ gap: 12 }}>
      {(sc.place || sc.initiative) && <div className="rec scene-card">
        {sc.place && <div className="h"><b>{sc.place}</b></div>}
        {(sc.story_time || sc.weather) && <div className="f">{[sc.story_time, sc.weather].filter(Boolean).join(' · ')}</div>}
        {sc.initiative && <div className="f init"><b>INITIATIVE</b>{sc.initiative}</div>}
        {sc.present?.length > 0 && <div className="f">{sc.present.filter(x => !d.table.some(s => s.name === x.name)).map((x, i) => <span key={i} className="who-chip">{x.name}{x.condition && !/^(unhurt|alive|fine|healthy)$/i.test(x.condition) ? <span className="cond"> [{x.condition}]</span> : null}</span>)}</div>}
      </div>}

      {d.table.map(s => {
        const f = s.sheet?.fields ?? {};
        const on = d.online.includes(s.user_id);
        const st = s.status === 'away' ? 'away' : s.action?.ready ? 'ready' : s.action?.drafting ? 'writing' : 'waiting';
        return (
          <div key={s.user_id} className={`pc ${s.status}`}>
            <button className="pc-main" onClick={() => s.persona_id && p.onSheet(s.persona_id)} disabled={!s.persona_id}>
              <span className={`face ${on ? 'on' : ''}`}><Avatar src={s.avatar} name={s.name || s.player} size={44} /></span>
              <div className="min0 grow">
                <div className="n ellipsis">{s.persona_id ? s.name : <span className="dim">no character yet</span>}{s.levelUp && <span className="chip lvl">level up!</span>}</div>
                <div className="m ellipsis">{s.player}{s.host ? ' · host' : ''}{s.persona_id ? ` · ${[f.class].filter(Boolean).join('')}` : ''}</div>
                {s.persona_id && <div className="row" style={{ gap: 6, marginTop: 4 }}><HpBar hp={f.hp} small />{f.ac && <span className="chip">AC {f.ac.replace(/\s*\(.*$/, '')}</span>}</div>}
                {f.conditions && !/^\s*none\s*$/i.test(f.conditions) && <div className="cond small ellipsis">{f.conditions}</div>}
              </div>
              {s.persona_id && <span className={`rstate ${st}`} title={st}>{st === 'ready' ? '✓' : st === 'writing' ? '✎' : st === 'away' ? 'away' : '…'}</span>}
            </button>
            {(d.host || s.user_id === d.me) && !s.host && <div className="pc-acts">
              {d.host && s.user_id !== d.me && <button className="btn sm ghost" disabled={busy} onClick={() => seat({ user_id: s.user_id, status: s.status === 'away' ? 'active' : 'away' })}>{s.status === 'away' ? 'Mark here' : 'Mark away'}</button>}
              <button className="btn sm ghost danger" disabled={busy} onClick={() => remove(s.user_id, s.player)}>{s.user_id === d.me ? 'Leave' : 'Remove'}</button>
            </div>}
          </div>
        );
      })}

      {me && <div className="rec">
        <div className="h"><b>You</b><span className="grow" /><Seg value={me.status} options={[{ value: 'active', label: 'Here' }, { value: 'away', label: 'Away' }]} onChange={v => seat({ status: v })} /></div>
        <div className="f small">Away: the round doesn't wait for you, and your character tags along doing nothing new.</div>
        <div className="row" style={{ marginTop: 8 }}>
          <select value={me.persona_id ?? ''} onChange={e => seat({ persona_id: e.target.value ? Number(e.target.value) : null })} disabled={busy} aria-label="Your character">
            <option value="">No character (watch and talk)</option>
            {mine.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {!mine.length && <div className="f small">Make a character on the home page first.</div>}
      </div>}

      <div className="rec">
        <div className="h"><b>Invite</b><span className="grow" /><span className="mono invite">{d.story.invite_code}</span></div>
        <div className="f small">New players sign up with this code and land at this table. Players who already have an account join with it from the home page.</div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={() => copy(d.story.invite_code, 'Code')}>Copy code</button>
          <button className="btn sm" onClick={() => copy(link, 'Link')}>Copy link</button>
        </div>
      </div>

      {d.host && <div className="rec">
        <div className="h"><b>Host</b></div>
        <div className="row wrap" style={{ marginTop: 6 }}>
          <button className="btn sm primary" disabled={p.busy || !d.conns.writer} onClick={p.onGo}>Go: play the round now</button>
          {d.story.settings.levelling === 'milestone' && <button className="btn sm" disabled={busy} onClick={milestone}>Milestone: level the party up</button>}
        </div>
        <div className="f small">{d.story.settings.auto_go === 'all_ready' ? 'The round starts by itself once every player marked here is ready. Go starts it with whoever is ready now.' : 'The round starts when you press Go.'}</div>
      </div>}
    </div>
  );
}

// A character's sheet in this campaign. Its player and the host can change it by hand or with the AI, level up, and keep it in the library.
export function SheetModal(p: { d: Detail; home: Home; personaId: number; onClose: () => void; reload: () => Promise<any> }) {
  const d = p.d;
  const s = d.table.find(x => x.persona_id === p.personaId);
  const [mode, setMode] = useState<'view' | 'edit' | 'levelup' | 'ai'>(s?.levelUp ? 'levelup' : 'view');
  const [fields, setFields] = useState<Record<string, string>>({ ...(s?.sheet?.fields ?? {}) });
  const [why, setWhy] = useState('');
  const { busy, run } = useAsync();
  if (!s?.sheet) return null;
  const can = s.user_id === d.me || d.host;
  const owner = s.user_id === d.me;
  const save = (f: Record<string, string>, whatChanged: string, announce: boolean) => run(async () => {
    await api(`/stories/${d.story.id}/sheets/${p.personaId}`, { method: 'PUT', body: { fields: f, what_changed: whatChanged, announce } });
    await p.reload(); setFields(f); setMode('view'); toast('Sheet saved.');
  });
  const keep = () => run(async () => { await api(`/stories/${d.story.id}/sheets/${p.personaId}/save`, { body: {} }); toast('Kept in your library: the next campaign starts from this sheet.'); });
  const reload = () => run(async () => {
    if (!confirm('Load the sheet from your library again? What changed in this campaign is replaced.')) return;
    await api(`/stories/${d.story.id}/sheets/${p.personaId}/reload`, { body: {} }); const dt = await p.reload(); setFields({ ...(dt?.table.find((x: any) => x.persona_id === p.personaId)?.sheet?.fields ?? {}) });
  });
  return (
    <Modal title={<span className="row" style={{ gap: 10 }}><Avatar src={s.avatar} name={s.name} size={30} />{s.name}<span className="dim small">· {s.player}</span></span>} wide onClose={p.onClose} foot={can ? <>
      {owner && <button className="btn sm" onClick={keep} disabled={busy}>Keep in my library</button>}
      {owner && <button className="btn sm ghost" onClick={reload} disabled={busy}>Load from library</button>}
      <span className="grow" />
      {mode === 'edit' && <><input type="text" style={{ maxWidth: 260 }} value={why} onChange={e => setWhy(e.target.value)} placeholder="What changed (optional)" />
        <button className="btn ghost" onClick={() => { setFields({ ...s.sheet!.fields }); setMode('view'); }}>Cancel</button>
        <button className="btn primary" onClick={() => save(fields, why || 'edited by hand', false)} disabled={busy}>Save</button></>}
    </> : undefined}>
      {can && <div className="row wrap">
        <Seg value={mode === 'edit' ? 'edit' : 'view'} options={[{ value: 'view', label: 'View' }, { value: 'edit', label: 'Edit by hand' }]} onChange={v => setMode(v as any)} />
        <span className="grow" />
        <button className={`btn sm ${s.levelUp ? 'primary' : ''}`} onClick={() => setMode('levelup')} disabled={!d.conns.writer && !d.conns.records}>Level up{s.levelUp ? '!' : ''}</button>
        <button className="btn sm" onClick={() => setMode('ai')}>Change with AI</button>
      </div>}
      {s.levelUp && mode !== 'levelup' && <div className="small" style={{ color: 'var(--accent)' }}>{s.name} has earned a level.</div>}
      {can && (mode === 'levelup' || mode === 'ai') && <SheetAi path={`/stories/${d.story.id}/sheets/${p.personaId}/ai`} kind={mode === 'levelup' ? 'levelup' : 'edit'} defs={p.home.schema.sheet}
        current={s.sheet.fields} onCancel={() => setMode('view')}
        onApply={async (f, summary) => { await save(f, summary || (mode === 'levelup' ? 'levelled up' : 'sheet changed'), true); }} />}
      {mode === 'edit' ? <SheetForm fields={fields} defs={p.home.schema.sheet} withName onChange={(k, v) => setFields(x => ({ ...x, [k]: v }))} />
        : <SheetView fields={s.sheet.fields} defs={p.home.schema.sheet} />}
      {!can && <div className="muted small">Only {s.player} and the host can change this sheet.</div>}
    </Modal>
  );
}
