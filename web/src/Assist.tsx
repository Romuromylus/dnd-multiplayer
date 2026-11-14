// Help with what a campaign is built from: a world or a character written from a few words, a sheet built for them, a portrait.
import { useEffect, useRef, useState } from 'react';
import { api, followJob, type World } from './api';
import { errToast, Field, Modal, toast, useAsync } from './ui';

type Done = { text?: string; image?: string; sheet?: Record<string, string>; fields?: Record<string, string>; summary?: string };

// One helper job at a time: what is written streams in, and its result arrives once at the end.
export function useAssistJob() {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const stopRef = useRef<{ id: string; off: () => void } | null>(null);
  useEffect(() => () => { stopRef.current?.off(); }, []);
  const start = async (path: string, body: any, on: { text?: (delta: string) => void; done: (r: Done) => void; fail?: () => void }) => {
    if (stopRef.current) return;
    setBusy(true); setPhase('');
    let got = false;
    const end = () => { stopRef.current = null; setBusy(false); setPhase(''); };
    try {
      const { jobId } = await api<{ jobId: string }>(path, { body });
      const off = followJob(jobId, (type, data) => {
        if (type === 'phase') setPhase(data.label ?? '');
        else if (type === 'text') on.text?.(data.delta ?? '');
        else if (type === 'assist') { got = true; on.done(data); }
        else if (type === 'error') toast(data.message || 'It failed.', 'error');
        else if (type === 'end') { if (!got) on.fail?.(); end(); }
      }, msg => { toast(msg, 'error'); on.fail?.(); end(); });
      stopRef.current = { id: jobId, off };
    } catch (e) { errToast(e); on.fail?.(); end(); }
  };
  const stop = () => { const s = stopRef.current; if (s) api(`/jobs/${s.id}/stop`, { body: {} }).catch(() => {}); };
  return { busy, phase, start, stop };
}

const IDEA: Record<'world' | 'character' | 'look', string> = {
  world: 'A few words are enough: the setting, the premise, the tone.\nThe Sword Coast, a year after a dragon burned Daggerford. Grim but with warmth, low magic, lots of intrigue.',
  character: 'A few words are enough: who they are.\nA tiefling ex-temple guard who lost her faith and kept the sword. Dry humor, soft spot for strays.',
  look: 'A few words are enough.\nTall, ash-grey skin, curled horns with brass rings, a scar through one eyebrow, travel-worn chain shirt.',
};

// Writes into the box beside it from a few words, or revises what is there. Nothing is saved by this, and Undo puts back what was there.
export function AiWrite(p: { kind: 'world' | 'character' | 'look'; value: string; onChange: (text: string) => void; given?: string; ready: boolean; what: string }) {
  const [open, setOpen] = useState(false);
  const [idea, setIdea] = useState('');
  const [before, setBefore] = useState<string | null>(null);
  const job = useAssistJob();
  const latest = useRef(p);
  latest.current = p;
  const has = !!p.value.trim();
  const go = () => {
    const prev = p.value;
    let acc = '';
    job.start('/assist', { kind: p.kind, idea, current: p.value, given: p.given ?? '' }, {
      text: d => { acc += d; latest.current.onChange(acc.replace(/^\s+/, '')); },
      done: r => { latest.current.onChange(r.text ?? acc); setBefore(prev); },
      fail: () => { if (acc) setBefore(prev); },
    });
  };
  if (!open) return <div className="ai-row"><button type="button" className="btn sm" onClick={() => setOpen(true)} disabled={!p.ready} title={p.ready ? `Write the ${p.what} from a few words, or revise what's there` : 'An admin has to add a connection first'}>✦ Write with AI</button></div>;
  return (
    <div className="ai-box">
      <textarea rows={3} value={idea} onChange={e => setIdea(e.target.value)} placeholder={has ? `What to change, or leave empty to tighten the ${p.what} and fill its gaps.` : IDEA[p.kind]} disabled={job.busy} />
      <div className="ai-row">
        {job.busy
          ? <><span className="muted small"><span className="spinner" /> {job.phase || 'writing'}…</span><span className="grow" /><button type="button" className="btn sm" onClick={job.stop}>Stop</button></>
          : <>
            <span className="muted small grow">{has ? `Revises the ${p.what} in the box. It isn't saved until you save.` : 'Written by the Dungeon Master model.'}</span>
            {before != null && <button type="button" className="btn sm" onClick={() => { p.onChange(before); setBefore(null); }}>Undo</button>}
            <button type="button" className="btn sm" onClick={() => setOpen(false)}>Close</button>
            <button type="button" className="btn sm primary" onClick={go} disabled={!has && !idea.trim()}>{has ? (idea.trim() ? 'Revise' : 'Improve') : 'Write'}</button>
          </>}
      </div>
    </div>
  );
}

// The shelf: put a saved world in the box, or keep what is in the box for other campaigns.
export function WorldShelf(p: { worlds: World[]; reload: () => Promise<void>; value: string; onLoad: (text: string) => void; suggest: string; me: number; admin: boolean }) {
  const { busy, run } = useAsync();
  const load = (id: number) => {
    const b = p.worlds.find(x => x.id === id);
    if (!b || (p.value.trim() && p.value.trim() !== b.text.trim() && !confirm(`Replace the world in the box with "${b.name}"?`))) return;
    p.onLoad(b.text);
  };
  const save = () => run(async () => {
    const name = (prompt('Save it to the worlds as:', p.suggest.trim() || 'Untitled world') ?? '').trim();
    if (!name) return;
    const same = p.worlds.find(x => x.name.toLowerCase() === name.toLowerCase() && (x.user_id === p.me || p.admin));
    if (same && !confirm(`"${same.name}" is already saved. Replace it?`)) return;
    if (same) await api(`/worlds/${same.id}`, { method: 'PUT', body: { name, text: p.value } });
    else await api('/worlds', { body: { name, text: p.value } });
    await p.reload();
    toast(`Saved to the worlds as "${name}".`);
  });
  return (
    <div className="ai-row">
      {p.worlds.length > 0 && <select className="sm-select" value="" onChange={e => { if (e.target.value) load(Number(e.target.value)); }} aria-label="Use a saved world">
        <option value="">Use a saved world…</option>
        {p.worlds.map(b => <option key={b.id} value={b.id}>{b.name}{b.owner ? ` · ${b.owner}` : ''}</option>)}
      </select>}
      <button type="button" className="btn sm" onClick={save} disabled={busy || !p.value.trim()} title="Keep this world to start other campaigns from">Save to worlds</button>
    </div>
  );
}

// Every saved world, to read, change, write or throw away. Everyone at the server shares the shelf.
export function WorldsModal(p: { worlds: World[]; me: number; admin: boolean; ready: boolean; onClose: () => void; reload: () => Promise<void> }) {
  const [sel, setSel] = useState<number | 'new'>(p.worlds[0]?.id ?? 'new');
  const cur = p.worlds.find(x => x.id === sel);
  const mine = !cur || cur.user_id === p.me || p.admin;
  const [f, setF] = useState<{ name: string; text: string }>({ name: cur?.name ?? '', text: cur?.text ?? '' });
  const { busy, run } = useAsync();
  useEffect(() => { setF({ name: cur?.name ?? '', text: cur?.text ?? '' }); }, [sel]);
  const save = () => run(async () => {
    const r: { world: World } = sel === 'new' ? await api('/worlds', { body: f }) : await api(`/worlds/${sel}`, { method: 'PUT', body: f });
    await p.reload(); setSel(r.world.id); toast('World saved.');
  });
  const del = () => run(async () => {
    if (sel === 'new' || !confirm('Delete this saved world? Campaigns started from it keep their own copy.')) return;
    await api(`/worlds/${sel}`, { method: 'DELETE' }); await p.reload(); setSel('new');
  });
  const importFile = async (file: File) => {
    const text = await file.text();
    setSel('new'); setTimeout(() => setF({ name: file.name.replace(/\.(txt|md)$/i, '').trim(), text }), 0);
  };
  return (
    <Modal title="Worlds" onClose={p.onClose} wide foot={<>
      {sel !== 'new' && mine && <button className="btn danger" onClick={del} disabled={busy}>Delete</button>}
      <label className="btn">Import .txt<input type="file" accept=".txt,.md" hidden onChange={e => e.target.files?.[0] && importFile(e.target.files[0])} /></label>
      <span className="grow" />
      <button className="btn primary" onClick={save} disabled={busy || !f.name.trim() || !mine}>Save</button>
    </>}>
      <div className="split">
        <div className="list">
          {p.worlds.map(x => <button key={x.id} className={`side-item ${sel === x.id ? 'on' : ''}`} onClick={() => setSel(x.id)}><div className="t ellipsis">{x.name}</div>{x.owner && <div className="m">{x.owner}</div>}</button>)}
          <button className={`side-item ${sel === 'new' ? 'on' : ''}`} onClick={() => setSel('new')}><div className="t">+ New world</div></button>
        </div>
        <div className="col" style={{ gap: 14 }}>
          <p className="muted small" style={{ margin: 0 }}>Settings kept to start campaigns from. A new campaign takes a copy, so changing one here changes no campaign already begun.{!mine && ' Only whoever saved this world can change it.'}</p>
          <Field label="Name"><input type="text" value={f.name} onChange={e => setF(x => ({ ...x, name: e.target.value }))} placeholder="The Ashen Coast" disabled={!mine} /></Field>
          <Field label="World brief" hint="Setting, tone, factions, dangers, places, where the campaign starts, house rules. Leave the players' characters out: they bring their own.">
            <textarea rows={16} value={f.text} onChange={e => setF(x => ({ ...x, text: e.target.value }))} disabled={!mine} />
          </Field>
          {mine && <AiWrite kind="world" value={f.text} onChange={t => setF(x => ({ ...x, text: t }))} ready={p.ready} what="world brief" />}
        </div>
      </div>
    </Modal>
  );
}

export const ART_STYLES = [{ value: 'painterly', label: 'Painterly' }, { value: 'anime', label: 'Anime' }, { value: 'realistic', label: 'Realistic' }, { value: 'comic', label: 'Comic' }];

// A character's portrait, painted from how they look. It lands in the form and is kept on Save.
export function PortraitMaker(p: { ready: boolean; name: string; look: string; role: string; onImage: (dataUrl: string) => void }) {
  const [style, setStyle] = useState(() => { try { return localStorage.getItem('dnd-portrait-style') || 'painterly'; } catch { return 'painterly'; } });
  const job = useAssistJob();
  const latest = useRef(p);
  latest.current = p;
  const pick = (v: string) => { setStyle(v); try { localStorage.setItem('dnd-portrait-style', v); } catch { /* */ } };
  const go = () => job.start('/assist/portrait', { name: p.name, look: p.look, role: p.role, style }, { done: r => { if (r.image) latest.current.onImage(r.image); } });
  if (job.busy) return <><span className="muted small"><span className="spinner" /> {job.phase || 'painting'}…</span><button type="button" className="btn sm" onClick={job.stop}>Stop</button></>;
  return <>
    <button type="button" className="btn sm" onClick={go} disabled={!p.ready || !p.look.trim()} title={!p.ready ? 'An admin has to set up an Images connection first' : !p.look.trim() ? 'Write how they look first' : 'Paint a portrait from how they look'}>✦ Paint portrait</button>
    <select className="sm-select" value={style} onChange={e => pick(e.target.value)} aria-label="Portrait style" disabled={!p.ready}>{ART_STYLES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
  </>;
}

// A picture from the player's own files, made small enough to keep with the character.
export async function shrinkImage(file: File, size = 384): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file isn't a picture this browser can read.")); i.src = url; });
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const s = Math.min(img.width, img.height);
    // Square, from the top: faces are near the top of most portraits.
    c.getContext('2d')!.drawImage(img, (img.width - s) / 2, 0, s, s, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.86);
  } finally { URL.revokeObjectURL(url); }
}
