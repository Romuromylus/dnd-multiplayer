// What the records keeper keeps: the people the party has met, the open threads, the facts, and (for the host) the secrets
// ledger and every change, with undo. Also the chapters and their summaries.
import { useEffect, useState } from 'react';
import { api, type Detail, type FieldDef } from './api';
import { errToast, Field, Modal, useAsync } from './ui';

type Tab = 'people' | 'threads' | 'facts' | 'ledger' | 'changes' | 'chapters';
type Recs = { cards: any[]; ledger: any[]; facts: any[]; threads: any[]; changes: any[]; host: boolean; npcFields: FieldDef[] };

export function RecordsPanel(p: { d: Detail; busy: boolean; startJob: (path: string, body?: any) => Promise<boolean>; reload: () => Promise<any>; onSummary: (chapterId: number) => void }) {
  const d = p.d;
  const [tab, setTab] = useState<Tab>('people');
  const [r, setR] = useState<Recs | null>(null);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const { busy, run } = useAsync();
  const load = () => api<Recs>(`/stories/${d.story.id}/records`).then(setR).catch(errToast);
  useEffect(() => { load(); }, [d.passages.length, d.story.id, p.busy]);
  if (!r) return <div className="muted">Loading…</div>;
  const tabs: [Tab, string][] = [['people', `People ${r.cards.length}`], ['threads', 'Threads'], ['facts', 'Facts'], ...(d.host ? [['ledger', 'Secrets'], ['changes', 'Changes']] as [Tab, string][] : []), ['chapters', 'Chapters']];
  const portrait = (name: string) => d.art[`portrait:${name.trim().toLowerCase().replace(/\s+/g, ' ')}`];
  const act = (fn: () => Promise<any>) => run(async () => { await fn(); await load(); });
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="tabs" style={{ border: 0, padding: 0 }}>{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>

      {tab === 'people' && <>
        {r.cards.length === 0 && <div className="muted small">Nobody yet. The records keeper adds the people the party meets as the story names them.</div>}
        {r.cards.map(c => {
          const art = portrait(c.name);
          return (
            <details key={c.id} className="rec person">
              <summary className="h">
                {art?.url ? <img className="mini-portrait" src={art.url} alt="" /> : <span className="mini-portrait blank">{c.name[0]}</span>}
                <div className="min0 grow"><b>{c.name}</b><div className="dim tiny ellipsis">{c.fields.role_age}</div></div>
              </summary>
              {art?.url && <img className="big-portrait" src={art.url} alt="" />}
              {r.npcFields.filter(f => f.key !== 'name' && c.fields[f.key]).map(f => <div key={f.key} className="f"><b>{f.label}</b>{c.fields[f.key]}</div>)}
              {d.host && <div className="row" style={{ marginTop: 6 }}>
                <span className="grow" />
                {art && <button className="btn sm ghost" disabled={busy} onClick={() => act(() => api(`/assets/${art.id}/redo`, { body: {} }))}>Repaint</button>}
                <button className="btn sm ghost" onClick={() => setEdit(c)}>Edit</button>
                <button className="btn sm ghost danger" disabled={busy} onClick={() => confirm(`Delete ${c.name}'s card?`) && act(() => api(`/cards/${c.id}`, { method: 'DELETE' }))}>Delete</button>
              </div>}
            </details>
          );
        })}
        {d.host && <button className="btn sm" onClick={() => setEdit('new')}>+ Add a person</button>}
      </>}

      {tab === 'threads' && <>
        {r.threads.length === 0 && <div className="muted small">No threads yet: quests, debts, threats and promises go here.</div>}
        {r.threads.map(t => (
          <div key={t.id} className={`rec ${t.status !== 'open' ? 'dim' : ''}`}>
            <div className="h"><span className={`chip ${t.status === 'open' ? 'ok' : ''}`}>{t.status}</span><span className="grow" />
              {d.host && <><button className="btn sm ghost" disabled={busy} onClick={() => act(() => api(`/stories/${d.story.id}/threads`, { body: { id: t.id, text: t.text, status: t.status === 'open' ? 'resolved' : 'open' } }))}>{t.status === 'open' ? 'Resolve' : 'Reopen'}</button>
                <button className="btn sm ghost danger" disabled={busy} onClick={() => act(() => api(`/threads/${t.id}`, { method: 'DELETE' }))}>✕</button></>}
            </div>
            <div className="f">{t.text}</div>
          </div>
        ))}
        {d.host && <AddLine placeholder="A new thread" onAdd={text => act(() => api(`/stories/${d.story.id}/threads`, { body: { text } }))} />}
      </>}

      {tab === 'facts' && <>
        {r.facts.length === 0 && <div className="muted small">Facts the story has settled show up here.</div>}
        {r.facts.map(f => (
          <div key={f.id} className={`rec ${f.status === 'conflict' ? 'conflict' : ''}`}>
            <div className="f" style={{ marginTop: 0 }}>{f.text}</div>
            {f.about?.length > 0 && <div className="dim tiny">{f.about.join(', ')}</div>}
            {d.host && <div className="row" style={{ marginTop: 4 }}>
              {f.status === 'conflict' && <><span className="chip warn">conflict</span>
                <button className="btn sm ghost" onClick={() => act(() => api(`/facts/${f.id}/resolve`, { body: { action: 'keep_new' } }))}>Keep this</button>
                <button className="btn sm ghost" onClick={() => act(() => api(`/facts/${f.id}/resolve`, { body: { action: 'keep_old' } }))}>Drop this</button></>}
              <span className="grow" />
              <button className="btn sm ghost danger" disabled={busy} onClick={() => act(() => api(`/facts/${f.id}`, { method: 'DELETE' }))}>✕</button>
            </div>}
          </div>
        ))}
        {d.host && <AddLine placeholder="A new fact" onAdd={text => act(() => api(`/stories/${d.story.id}/facts`, { body: { text } }))} />}
      </>}

      {tab === 'ledger' && d.host && <>
        <div className="muted small">Who knows what. Players never see this tab.</div>
        {r.ledger.length === 0 && <div className="muted small">Empty. Turn on the knowledge ledger in the campaign settings for the records keeper to fill it.</div>}
        {r.ledger.map(l => (
          <div key={l.id} className="rec">
            <div className="f" style={{ marginTop: 0 }}>{l.fact}</div>
            <div className="dim tiny">{l.known_by?.length ? `Known by ${l.known_by.join(', ')}` : ''}{l.not_known_by?.length ? ` · not by ${l.not_known_by.join(', ')}` : ''}</div>
            <div className="row"><span className="grow" /><button className="btn sm ghost danger" disabled={busy} onClick={() => act(() => api(`/ledger/${l.id}`, { method: 'DELETE' }))}>✕</button></div>
          </div>
        ))}
      </>}

      {tab === 'changes' && d.host && <>
        {r.changes.map(c => (
          <div key={c.id} className={`rec ${c.undone ? 'dim' : ''}`}>
            <div className="h"><span className="chip">{c.record}</span><span className="grow small">{c.summary}</span>
              {!c.undone && <button className="btn sm ghost" disabled={busy} onClick={() => act(async () => { await api(`/changes/${c.id}/undo`, { body: {} }); await p.reload(); })}>undo</button>}</div>
          </div>
        ))}
        {r.changes.length === 0 && <div className="muted small">No changes yet.</div>}
      </>}

      {tab === 'chapters' && <>
        {d.chapters.map(c => (
          <div key={c.id} className="rec">
            <div className="h"><b>Chapter {c.number}{c.title ? `: ${c.title}` : ''}</b><span className="grow" /><span className="chip">{c.status === 'open' ? 'now' : c.summary_status === 'draft' ? 'summary draft' : 'closed'}</span></div>
            {c.summary && <details><summary className="small muted" style={{ cursor: 'pointer' }}>Summary</summary><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.summary}</div></details>}
            {d.host && c.status !== 'open' && <div className="row"><span className="grow" /><button className="btn sm ghost" onClick={() => p.onSummary(c.id)}>Edit summary</button></div>}
          </div>
        ))}
        {d.host && <div className="row wrap">
          <button className="btn sm" disabled={p.busy} onClick={() => { const t = prompt('Close the chapter. Its title (optional):', ''); if (t !== null) p.startJob(`/stories/${d.story.id}/chapter/close`, { title: t || undefined }); }}>Close this chapter</button>
          {d.chapters.filter(c => c.status !== 'open' && !c.arc_id).length >= 2 && <button className="btn sm ghost" disabled={p.busy} onClick={() => p.startJob(`/stories/${d.story.id}/arc/close`)}>Roll chapters into an arc</button>}
        </div>}
        <div className="muted small">A closed chapter is summarized, and the Dungeon Master reads the summary instead of its whole text from then on. Close one at a natural break: a dungeon cleared, a journey's end.</div>
      </>}

      {edit && <CardModal storyId={d.story.id} card={edit === 'new' ? null : edit} defs={r.npcFields} onClose={() => setEdit(null)} onSaved={load} />}
    </div>
  );
}

function AddLine(p: { placeholder: string; onAdd: (text: string) => void }) {
  const [t, setT] = useState('');
  return <div className="row"><input type="text" value={t} onChange={e => setT(e.target.value)} placeholder={p.placeholder} onKeyDown={e => { if (e.key === 'Enter' && t.trim()) { p.onAdd(t.trim()); setT(''); } }} /><button className="btn sm" disabled={!t.trim()} onClick={() => { p.onAdd(t.trim()); setT(''); }}>Add</button></div>;
}

function CardModal(p: { storyId: number; card: any | null; defs: FieldDef[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Record<string, string>>(() => ({ ...(p.card?.fields ?? {}) }));
  const { busy, run } = useAsync();
  const save = () => run(async () => {
    if (p.card) await api(`/cards/${p.card.id}`, { method: 'PUT', body: { fields: f, what_changed: 'edited by the host' } });
    else await api(`/stories/${p.storyId}/cards`, { body: { fields: f } });
    p.onSaved(); p.onClose();
  });
  return (
    <Modal title={p.card ? p.card.name : 'New person'} onClose={p.onClose} foot={<><span className="grow" /><button className="btn ghost" onClick={p.onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy || !(f.name ?? '').trim()}>Save</button></>}>
      {p.defs.map(d => <Field key={d.key} label={d.label} hint={d.desc}>{d.short ? <input type="text" value={f[d.key] ?? ''} onChange={e => setF(x => ({ ...x, [d.key]: e.target.value }))} /> : <textarea rows={3} value={f[d.key] ?? ''} onChange={e => setF(x => ({ ...x, [d.key]: e.target.value }))} />}</Field>)}
    </Modal>
  );
}
