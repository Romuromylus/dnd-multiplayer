// The host's dialogs: the campaign's settings, a correction, a hand edit, a passage's history, a chapter's summary.
import { useEffect, useState } from 'react';
import { api, type Chapter, type Detail, type Home, type Passage, type Settings } from './api';
import { AiWrite, WorldShelf } from './Assist';
import { CampaignSettingsFields } from './Home';
import { renderProse } from './render';
import { download, errToast, Field, Modal, toast, useAsync } from './ui';

export function SettingsModal(p: { d: Detail; home: Home; onClose: () => void; onSaved: () => void; onDeleted: () => void }) {
  const s = p.d.story;
  const [title, setTitle] = useState(s.title);
  const [bible, setBible] = useState(s.bible);
  const [st, setSt] = useState<Settings>(JSON.parse(JSON.stringify(s.settings)));
  const [writer, setWriter] = useState<number | ''>(s.writer_conn_id ?? '');
  const [records, setRecords] = useState<number | ''>(s.records_conn_id ?? '');
  const [conns, setConns] = useState<{ id: number; name: string; model: string; default_role: string }[]>([]);
  const { busy, run } = useAsync();
  useEffect(() => { api<{ connections: any[] }>('/connections').then(r => setConns(r.connections)).catch(errToast); }, []);
  const save = () => run(async () => {
    await api(`/stories/${s.id}`, { method: 'PUT', body: { title, bible, settings: st, writer_conn_id: writer || null, records_conn_id: records || null } });
    toast('Settings saved.'); p.onSaved(); p.onClose();
  });
  const newCode = () => run(async () => {
    if (!confirm('Make a new invite code? The old one stops working (players already at the table stay).')) return;
    await api(`/stories/${s.id}`, { method: 'PUT', body: { new_code: true } }); p.onSaved(); toast('New invite code made.');
  });
  const archive = () => run(async () => { await api(`/stories/${s.id}`, { method: 'PUT', body: { archived: !s.archived } }); p.onSaved(); p.onClose(); });
  const del = () => run(async () => {
    if (prompt(`Type the campaign's title to delete it for good:\n${s.title}`) !== s.title) return;
    await api(`/stories/${s.id}`, { method: 'DELETE' }); p.onDeleted();
  });
  const defName = (role: string) => conns.find(c => c.default_role === role)?.name ?? (role === 'records' ? 'same as the Dungeon Master' : 'none set');
  return (
    <Modal title="Campaign settings" wide onClose={p.onClose} foot={<>
      <button className="btn danger" onClick={del} disabled={busy}>Delete</button>
      <button className="btn" onClick={archive} disabled={busy}>{s.archived ? 'Unarchive' : 'Archive'}</button>
      <button className="btn" onClick={() => download(`/api/stories/${s.id}/export`)}>Export .md</button>
      <span className="grow" />
      <button className="btn ghost" onClick={p.onClose}>Cancel</button>
      <button className="btn primary" onClick={save} disabled={busy}>Save</button>
    </>}>
      <Field label="Title"><input type="text" value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <Field label="The world" hint="The Dungeon Master reads this before every round. Changing it changes the campaign from the next round on.">
        <textarea rows={10} value={bible} onChange={e => setBible(e.target.value)} />
      </Field>
      <WorldShelf worlds={p.home.worlds} reload={async () => {}} value={bible} onLoad={setBible} suggest={title} me={p.home.user.id} admin={p.home.user.role === 'admin'} />
      <AiWrite kind="world" value={bible} onChange={setBible} ready={!!p.d.conns.writer} what="world brief" />
      <div className="row wrap"><span className="small">Invite code <b className="mono">{s.invite_code}</b></span><button className="btn sm ghost" onClick={newCode} disabled={busy}>New code</button></div>
      <CampaignSettingsFields home={p.home} st={st} setSt={setSt} />
      <div className="section-title">Models</div>
      <div className="grid2">
        <Field label="Dungeon Master"><select value={writer} onChange={e => setWriter(e.target.value ? Number(e.target.value) : '')}><option value="">Default ({defName('writer')})</option>{conns.map(c => <option key={c.id} value={c.id}>{c.name} · {c.model}</option>)}</select></Field>
        <Field label="Records keeper" hint="Sheets, people, threads, the continuity check and summaries."><select value={records} onChange={e => setRecords(e.target.value ? Number(e.target.value) : '')}><option value="">Default ({defName('records')})</option>{conns.map(c => <option key={c.id} value={c.id}>{c.name} · {c.model}</option>)}</select></Field>
      </div>
    </Modal>
  );
}

export function CorrectionModal(p: { storyId: number; passage: Passage; isLast: boolean; onClose: () => void; onJob: (id: string) => void }) {
  const [text, setText] = useState('');
  const { busy, run } = useAsync();
  const go = () => run(async () => {
    const r = await api<{ jobId: string }>(`/stories/${p.storyId}/fix`, { body: { passageIds: [p.passage.id], correction: text, recheck: p.isLast } });
    p.onJob(r.jobId); p.onClose();
  });
  return (
    <Modal title="Correct this passage" onClose={p.onClose} foot={<><button className="btn ghost" onClick={p.onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={busy || !text.trim()}>Rewrite it</button></>}>
      <div className="muted small">Say what's wrong and what it should be. The Dungeon Master rewrites the passage, keeping everything else as close as it can, and the records follow. The old text is kept in its history.</div>
      <div className="rec" style={{ maxHeight: 180, overflowY: 'auto' }}><div className="prose" style={{ fontSize: 14.5 }} dangerouslySetInnerHTML={{ __html: renderProse(p.passage.text.slice(0, 1600) + (p.passage.text.length > 1600 ? '…' : ''), { quotes: true }) }} /></div>
      <Field label="Correction">
        <textarea rows={6} autoFocus value={text} onChange={e => setText(e.target.value)} placeholder={'Bram attacked the bandit captain, not the archer.\nThe Stealth roll was a 17, that beats DC 15.\nIlsa is a Paladin: she would have smelled the undead.'} />
      </Field>
    </Modal>
  );
}

export function EditPassageModal(p: { passage: Passage; onClose: () => void; onSaved: () => void; onJob: (id: string) => void }) {
  const [text, setText] = useState(p.passage.text);
  const { busy, run } = useAsync();
  const save = (redo: boolean) => run(async () => {
    await api(`/passages/${p.passage.id}`, { method: 'PUT', body: { text } });
    if (redo) { const r = await api<{ jobId: string }>(`/passages/${p.passage.id}/redo-records`, { body: {} }); p.onJob(r.jobId); }
    p.onSaved(); p.onClose();
  });
  return (
    <Modal title="Edit passage" wide onClose={p.onClose} foot={<>
      <button className="btn ghost" onClick={p.onClose}>Cancel</button>
      <button className="btn" onClick={() => save(false)} disabled={busy}>Save</button>
      <button className="btn primary" onClick={() => save(true)} disabled={busy}>Save and redo records</button>
    </>}>
      <textarea style={{ minHeight: '55dvh', fontFamily: 'var(--serif)', fontSize: 16 }} value={text} onChange={e => setText(e.target.value)} />
      <div className="muted small">"Redo records" rebuilds the sheets, people, facts and threads from this passage on, so they match your edit.</div>
    </Modal>
  );
}

export function VersionsModal(p: { passage: Passage; onClose: () => void; onSaved: () => void }) {
  const [versions, setVersions] = useState<any[] | null>(null);
  const { busy, run } = useAsync();
  useEffect(() => { api<{ versions: any[] }>(`/passages/${p.passage.id}/versions`).then(r => setVersions(r.versions)).catch(errToast); }, []);
  const restore = (v: any) => run(async () => { await api(`/passages/${p.passage.id}/revert`, { body: { versionId: v.id } }); toast('Restored. Use "Redo records" if the records should follow.'); p.onSaved(); p.onClose(); });
  return (
    <Modal title="Passage history" wide onClose={p.onClose}>
      {!versions ? <div className="muted">Loading…</div> : !versions.length ? <div className="muted">No earlier versions.</div> : versions.map(v => (
        <div key={v.id} className="rec">
          <div className="h"><span className="chip">{v.reason || 'edit'}</span><span className="dim tiny mono">{new Date(v.created_at).toLocaleString()}</span><span className="grow" /><button className="btn sm" disabled={busy} onClick={() => restore(v)}>Restore</button></div>
          <details><summary className="small muted" style={{ cursor: 'pointer', marginTop: 6 }}>{v.text.slice(0, 160)}…</summary><div className="prose" style={{ fontSize: 15, marginTop: 8 }} dangerouslySetInnerHTML={{ __html: renderProse(v.text, { quotes: true }) }} /></details>
        </div>
      ))}
    </Modal>
  );
}

export function SummaryModal(p: { chapter: Chapter; onClose: () => void; onSaved: () => void; onJob: (id: string) => void }) {
  const [title, setTitle] = useState(p.chapter.title);
  const [text, setText] = useState(p.chapter.summary);
  const [note, setNote] = useState('');
  const { busy, run } = useAsync();
  const save = () => run(async () => { await api(`/chapters/${p.chapter.id}`, { method: 'PUT', body: { title, summary: text, summary_status: 'saved' } }); toast('Summary saved.'); p.onSaved(); p.onClose(); });
  const redo = () => run(async () => { const r = await api<{ jobId: string }>(`/chapters/${p.chapter.id}/summary/redo`, { body: { note } }); p.onJob(r.jobId); p.onClose(); });
  return (
    <Modal title={`Chapter ${p.chapter.number} summary`} wide onClose={p.onClose} foot={<>
      <input type="text" style={{ maxWidth: 320 }} value={note} onChange={e => setNote(e.target.value)} placeholder="Note for a redo (optional)" />
      <button className="btn" onClick={redo} disabled={busy}>Redo summary</button>
      <span className="grow" />
      <button className="btn primary" onClick={save} disabled={busy}>Save</button>
    </>}>
      {p.chapter.summary_status === 'draft' && <div className="chip" style={{ alignSelf: 'flex-start' }}>draft: review and save</div>}
      <Field label="Chapter title"><input type="text" value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <Field label="Summary" hint="This replaces the chapter's text in the Dungeon Master's memory for every later chapter."><textarea rows={18} value={text} onChange={e => setText(e.target.value)} /></Field>
    </Modal>
  );
}
