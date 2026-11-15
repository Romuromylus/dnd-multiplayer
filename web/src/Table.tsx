// The table: the campaign as it is played. Each player says what their character does and marks themselves ready; the
// Dungeon Master writes the round once everyone is (or when the host says go), and everyone watches it come in.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, followJob, followLive, NetError, type Detail, type Home, type Passage, type Seat } from './api';
import { narrator } from './narrator';
import { NarratorBar, SpeakerIcon } from './NarratorBar';
import { Feed, LiveBlock, type Live } from './Feed';
import { PartyPanel, SheetModal } from './Party';
import { RecordsPanel } from './Records';
import { ChatPanel } from './Chat';
import { CorrectionModal, EditPassageModal, SettingsModal, SummaryModal, VersionsModal } from './TableModals';
import { copyReadingText } from './render';
import { Avatar } from './Sheet';
import { errToast, toast } from './ui';

type Side = 'party' | 'records' | 'chat';
type ModalState = null
  | { kind: 'settings' } | { kind: 'sheet'; personaId: number } | { kind: 'fix'; passage: Passage; isLast: boolean }
  | { kind: 'edit'; passage: Passage } | { kind: 'versions'; passage: Passage } | { kind: 'summary'; chapterId: number };

export function TableView(p: { id: number; home: Home; reloadHome: () => Promise<void>; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [side, setSide] = useState<Side | null>(() => (window.innerWidth > 1100 ? 'party' : null));
  const [modal, setModal] = useState<ModalState>(null);
  const [unread, setUnread] = useState(0);
  const [viewChapter, setViewChapter] = useState<number | null>(null);
  const [viewPassages, setViewPassages] = useState<Passage[] | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const stopFollow = useRef<(() => void) | null>(null);
  const following = useRef<string | null>(null);
  const sideRef = useRef(side);
  sideRef.current = side;

  const load = useCallback(async () => {
    try { const d = await api<Detail>(`/stories/${p.id}`); setDetail(d); return d; }
    catch (e: any) { errToast(e); if (/not found/i.test(e?.message ?? '')) p.onBack(); return null; }
  }, [p.id]);

  // ---------------------------------------------------------------- the Dungeon Master's work, as it comes
  const follow = useCallback((jobId: string, kind = '', label = 'Working') => {
    if (following.current === jobId) return;
    stopFollow.current?.();
    following.current = jobId;
    setLive({ jobId, kind, label, phase: '', tools: [], thinking: '', text: '', prefix: '', plan: '', summary: false });
    stick.current = true;
    stopFollow.current = followJob(jobId, (type, d) => {
      switch (type) {
        case 'start': setLive(l => l && { ...l, kind: d.kind, label: d.label }); break;
        case 'phase': setLive(l => l && { ...l, phase: d.label }); break;
        case 'tool': setLive(l => l && { ...l, tools: [...l.tools, d] }); break;
        case 'thinking': setLive(l => l && { ...l, thinking: l.thinking + d.delta }); break;
        case 'text': setLive(l => l && { ...l, text: l.text + d.delta }); break;
        case 'text_reset': setLive(l => l && { ...l, text: '', prefix: d.prefix ?? '' }); break;
        case 'plan': setLive(l => l && { ...l, plan: d.text }); break;
        case 'summary_start': setLive(l => l && { ...l, summary: true, text: '' }); break;
        case 'passage': {
          const np: Passage = d.passage;
          setDetail(dt => {
            if (!dt || np.chapter_id !== dt.openChapterId) return dt;
            const i = dt.passages.findIndex(x => x.id === np.id);
            return { ...dt, passages: i >= 0 ? dt.passages.map(x => x.id === np.id ? { ...x, ...np } : x) : [...dt.passages, np] };
          });
          if (np.kind === 'prose') setLive(l => l && { ...l, text: '', prefix: '', thinking: '', plan: '' });
          break;
        }
        case 'removed': setDetail(dt => dt && { ...dt, passages: dt.passages.filter(x => x.id !== d.passageId) }); break;
        case 'check': setDetail(dt => dt && { ...dt, passages: dt.passages.map(x => x.id === d.passageId ? { ...x, records_status: 'hold', turn: { ...(x.turn ?? {} as any), check: d.problems } } : x) }); break;
        case 'changes': setDetail(dt => dt && { ...dt, passages: dt.passages.map(x => x.id === d.passageId ? { ...x, records_status: 'done', changes: d.changes, cards: d.cards ?? x.cards } : x) }); break;
        case 'notice': toast(d.message); break;
        case 'error': toast(d.message, 'error'); break;
        case 'summary': toast(`Chapter summary drafted${d.title ? `: ${d.title}` : ''}.`); break;
        case 'end':
          setLive(null); stopFollow.current = null; following.current = null;
          load();
          break;
      }
    }, msg => { toast(msg, 'info', 8000); setLive(null); stopFollow.current = null; following.current = null; load(); });
  }, [load]);

  useEffect(() => {
    load().then(d => { if (d?.job) follow(d.job.id, d.job.kind, d.job.label); });
    // The table's live line: everything the others do reaches this page as it happens.
    const off = followLive(p.id, (type, d) => {
      switch (type) {
        case 'presence': setDetail(dt => dt && { ...dt, online: d.online }); break;
        case 'actions': setDetail(dt => dt && { ...dt, table: dt.table.map(s => { const a = d.actions.find((x: any) => x.user_id === s.user_id); return a ? { ...s, action: a.action, status: a.status } : s; }) }); break;
        case 'chat':
          setDetail(dt => dt && (dt.chat.some(c => c.id === d.id) ? dt : { ...dt, chat: [...dt.chat, d].slice(-200) }));
          if (sideRef.current !== 'chat') setUnread(n => n + 1);
          break;
        case 'job': follow(d.id, d.kind, d.label); break;
        case 'job_end': case 'seats': case 'refresh': case 'reconnected': load(); break;
        case 'art': api<{ art: Detail['art'] }>(`/stories/${p.id}/art`).then(r => setDetail(dt => dt && { ...dt, art: r.art })).catch(() => {}); break;
        case 'deleted': toast('The host deleted this campaign.'); p.onBack(); break;
      }
    });
    return () => { off(); stopFollow.current?.(); following.current = null; };
  }, [p.id]);

  // Pictures being painted are looked for again until they're done.
  const painting = detail ? Object.values(detail.art).some(a => a.status === 'pending' || a.status === 'working') : false;
  useEffect(() => {
    if (!painting) return;
    const t = window.setInterval(() => { api<{ art: Detail['art'] }>(`/stories/${p.id}/art`).then(r => setDetail(dt => dt && { ...dt, art: r.art })).catch(() => {}); }, 6000);
    return () => clearInterval(t);
  }, [painting, p.id]);

  // Older chapters are read from the server when picked.
  useEffect(() => {
    if (!viewChapter || !detail || viewChapter === detail.openChapterId) { setViewPassages(null); return; }
    api<{ passages: Passage[] }>(`/stories/${p.id}/chapters/${viewChapter}`).then(r => setViewPassages(r.passages)).catch(errToast);
  }, [viewChapter]);

  // Kept at the bottom while new words arrive, unless the reader has scrolled up.
  const onScroll = () => { const el = scroller.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; };
  useEffect(() => { const el = scroller.current; if (el && stick.current && !viewPassages) el.scrollTop = el.scrollHeight; }, [detail?.passages, live?.text, live?.phase, viewPassages]);
  useEffect(() => { if (side === 'chat') setUnread(0); }, [side]);

  // Each new round is read aloud when it lands, for a player who asked for that.
  const seenProse = useRef<number | null>(null);
  useEffect(() => {
    if (!detail) return;
    const top = detail.passages.reduce((m, x) => x.kind === 'prose' ? Math.max(m, x.id) : m, 0);
    if (seenProse.current == null || top <= seenProse.current) { seenProse.current = Math.max(seenProse.current ?? 0, top); return; }
    seenProse.current = top;
    narrator.arrived(p.id, detail.story.title, { id: top, label: 'The latest round' });
  }, [detail?.passages]);
  useEffect(() => () => { if (narrator.s.storyId === p.id) narrator.stop(); narrator.setPanel(false); }, []);

  const startJob = async (path: string, body: any = {}) => {
    try { const r = await api<{ jobId: string }>(path, { body }); follow(r.jobId); return true; }
    catch (e: any) {
      if (e instanceof NetError) { const d = await load(); if (d?.job) { follow(d.job.id, d.job.kind, d.job.label); return true; } }
      errToast(e); return false;
    }
  };

  if (!detail) return <div className="empty">Loading the table…</div>;
  const d = detail;
  const busy = !!live || !!d.job;
  const prose = d.passages.filter(x => x.kind === 'prose');
  const lastProse = prose.at(-1);
  const mySeat = d.table.find(s => s.user_id === d.me) ?? null;
  const shown = viewPassages ?? d.passages;
  const viewing = viewChapter && viewChapter !== d.openChapterId ? d.chapters.find(c => c.id === viewChapter) : null;
  const openCh = d.chapters.find(c => c.id === d.openChapterId);

  const onAction = async (a: string, ps: Passage) => {
    const isLast = ps.id === lastProse?.id;
    switch (a) {
      case 'listen': {
        const from = prose.findIndex(x => x.id === ps.id);
        narrator.play(p.id, d.story.title, prose.slice(Math.max(0, from)).map(x => ({ id: x.id, label: x.id === lastProse?.id ? 'The latest round' : 'An earlier round' })));
        break;
      }
      case 'fix': setModal({ kind: 'fix', passage: ps, isLast }); break;
      case 'edit': setModal({ kind: 'edit', passage: ps }); break;
      case 'versions': setModal({ kind: 'versions', passage: ps }); break;
      case 'retry': {
        const note = prompt('Write the round again. A note for the Dungeon Master (optional):', '');
        if (note !== null) await startJob(`/stories/${p.id}/retry`, { note });
        break;
      }
      case 'continue': await startJob(`/stories/${p.id}/continue`); break;
      case 'redo': if (confirm('Rebuild the records from this passage onward?')) await startJob(`/passages/${ps.id}/redo-records`); break;
      case 'keep': await startJob(`/passages/${ps.id}/keep`); break;
      case 'autofix': {
        const probs = ps.turn?.check ?? [];
        await startJob(`/stories/${p.id}/fix`, { passageIds: [ps.id], correction: probs.map((x, i) => `${i + 1}. ${x.problem}${x.quote ? ` (at "${x.quote}")` : ''}`).join('\n'), recheck: isLast });
        break;
      }
      case 'paint': try { await api(`/passages/${ps.id}/paint`, { body: { redo: !!d.art[`scene:${ps.id}`] } }); toast('Painting the scene…'); api<{ art: Detail['art'] }>(`/stories/${p.id}/art`).then(r => setDetail(dt => dt && { ...dt, art: r.art })); } catch (e) { errToast(e); } break;
      case 'copy': if (await copyReadingText([ps.text])) toast('Copied as plain text.'); else toast('Copy failed.', 'error'); break;
      case 'delete':
        if (!confirm(ps.kind === 'prose' ? 'Delete this passage? Its record changes are undone.' : 'Delete this?')) return;
        try { await api(`/passages/${ps.id}`, { method: 'DELETE' }); await load(); } catch (e) { errToast(e); }
        break;
    }
  };
  const undo = async (id: number) => { try { await api(`/changes/${id}/undo`, { body: {} }); await load(); } catch (e) { errToast(e); } };

  return (
    <div className={`table-app ${side ? 'with-side' : ''}`}>
      <div className="table-main">
        <header className="header">
          <button className="icon-btn" onClick={p.onBack} aria-label="Home" title="Home">←</button>
          <div className="min0 grow">
            <div className="title ellipsis">{d.story.title}</div>
            <div className="sub ellipsis">{d.host ? 'You host' : `Host: ${d.table.find(s => s.host)?.player ?? ''}`} · chapter {openCh?.number ?? 1}{d.scene.place ? ` · ${d.scene.place}` : ''}</div>
          </div>
          <div className="party-faces hide-mobile">
            {d.table.filter(s => s.persona_id).map(s => <span key={s.user_id} className={`face ${d.online.includes(s.user_id) ? 'on' : ''}`} title={`${s.name} (${s.player})`}><Avatar src={s.avatar} name={s.name} size={26} /></span>)}
          </div>
          <button className="icon-btn" onClick={() => narrator.setPanel(!narrator.s.panel)} aria-label="Narrator" title="Read aloud"><SpeakerIcon /></button>
          <button className={`icon-btn ${side === 'party' ? 'on' : ''}`} onClick={() => setSide(side === 'party' ? null : 'party')} title="The party" aria-label="The party">☗</button>
          <button className={`icon-btn ${side === 'chat' ? 'on' : ''}`} onClick={() => setSide(side === 'chat' ? null : 'chat')} title="Table talk" aria-label="Table talk">💬{unread > 0 && <span className="badge">{unread}</span>}</button>
          <button className={`icon-btn ${side === 'records' ? 'on' : ''}`} onClick={() => setSide(side === 'records' ? null : 'records')} title="Records: people, threads, chapters" aria-label="Records">☰</button>
          {d.host && <button className="icon-btn" onClick={() => setModal({ kind: 'settings' })} title="Campaign settings" aria-label="Settings">⚙</button>}
        </header>

        <div className="transcript" ref={scroller} onScroll={onScroll}>
          <div className="transcript-inner">
            {d.chapters.length > 1 && <div className="chapter-pick">
              <select value={viewChapter ?? d.openChapterId} onChange={e => setViewChapter(Number(e.target.value))} aria-label="Chapter">
                {d.chapters.map(c => <option key={c.id} value={c.id}>Chapter {c.number}{c.title ? `: ${c.title}` : ''}{c.id === d.openChapterId ? ' (now)' : ''}</option>)}
              </select>
            </div>}
            {viewing && <div className="chapter-head"><div className="k">CHAPTER {viewing.number}</div><h2>{viewing.title || 'Untitled'}</h2>
              {viewing.summary && <details className="summary-box" style={{ textAlign: 'left' }}><summary className="mono small" style={{ cursor: 'pointer' }}>Summary</summary><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{viewing.summary}</div></details>}
              <button className="btn sm" onClick={() => setViewChapter(null)}>Back to now</button></div>}
            {!viewing && !d.begun && !live && <Welcome d={d} mySeat={mySeat} busy={busy} onSheet={() => setSide('party')} onBegin={note => startJob(`/stories/${p.id}/begin`, { note })} />}
            <Feed passages={shown} d={d} lastProseId={viewing ? undefined : lastProse?.id} busy={busy} onAction={onAction} onUndo={undo} readOnly={!!viewing} />
            {!viewing && d.gameOver && !live && <GameOverCard d={d} busy={busy} reload={load} />}
            {live && !viewing && <LiveBlock live={live} host={d.host} />}
          </div>
        </div>

        <NarratorBar storyId={p.id} storyTitle={d.story.title} unit="round" onLatest={lastProse ? () => narrator.play(p.id, d.story.title, [{ id: lastProse.id, label: 'The latest round' }]) : null} />
        <Composer d={d} mySeat={mySeat} busy={busy} live={live} onGo={() => startJob(`/stories/${p.id}/go`)} onStop={() => live && api(`/jobs/${live.jobId}/stop`, { body: {} }).catch(errToast)} reload={load} home={p.home} />
      </div>

      {side && <div className="side-scrim show-mobile" onClick={() => setSide(null)} />}
      {side && <aside className="drawer">
        <div className="drawer-head">
          <div className="tabs" style={{ border: 0, padding: 0, flex: 1 }}>
            <button className={side === 'party' ? 'on' : ''} onClick={() => setSide('party')}>Party</button>
            <button className={side === 'chat' ? 'on' : ''} onClick={() => setSide('chat')}>Table talk{unread > 0 ? ` (${unread})` : ''}</button>
            <button className={side === 'records' ? 'on' : ''} onClick={() => setSide('records')}>Records</button>
          </div>
          <button className="icon-btn" onClick={() => setSide(null)} aria-label="Close">✕</button>
        </div>
        <div className="drawer-body">
          {side === 'party' && <PartyPanel d={d} home={p.home} reload={load} busy={busy} onSheet={pid => setModal({ kind: 'sheet', personaId: pid })} onGo={() => startJob(`/stories/${p.id}/go`)} />}
          {side === 'chat' && <ChatPanel d={d} />}
          {side === 'records' && <RecordsPanel d={d} busy={busy} startJob={startJob} reload={load} onSummary={chapterId => setModal({ kind: 'summary', chapterId })} />}
        </div>
      </aside>}

      {modal?.kind === 'settings' && <SettingsModal d={d} home={p.home} onClose={() => setModal(null)} onSaved={load} onDeleted={() => { p.reloadHome(); p.onBack(); }} />}
      {modal?.kind === 'sheet' && <SheetModal d={d} home={p.home} personaId={modal.personaId} onClose={() => setModal(null)} reload={load} />}
      {modal?.kind === 'fix' && <CorrectionModal storyId={p.id} passage={modal.passage} isLast={modal.isLast} onClose={() => setModal(null)} onJob={id => follow(id)} />}
      {modal?.kind === 'edit' && <EditPassageModal passage={modal.passage} onClose={() => setModal(null)} onSaved={load} onJob={id => follow(id)} />}
      {modal?.kind === 'versions' && <VersionsModal passage={modal.passage} onClose={() => setModal(null)} onSaved={load} />}
      {modal?.kind === 'summary' && d.chapters.find(c => c.id === modal.chapterId) && <SummaryModal chapter={d.chapters.find(c => c.id === modal.chapterId)!} onClose={() => setModal(null)} onSaved={load} onJob={id => follow(id)} />}
    </div>
  );
}

// Before the opening: the host gathers the table, then begins; the Dungeon Master opens the scene with everyone seated.
function Welcome(p: { d: Detail; mySeat: Seat | null; busy: boolean; onSheet: () => void; onBegin: (note: string) => Promise<boolean> }) {
  const d = p.d;
  const [note, setNote] = useState('');
  const [starting, setStarting] = useState(false);
  const seated = d.table.filter(s => s.persona_id);
  const waiting = d.table.filter(s => !s.persona_id);
  const begin = async () => {
    const away = seated.filter(s => !d.online.includes(s.user_id));
    if (away.length && !confirm(`${away.map(s => s.name).join(', ')} ${away.length > 1 ? 'aren’t' : 'isn’t'} here right now. Begin anyway? They'll still be in the opening.`)) return;
    setStarting(true);
    try { await p.onBegin(note); } finally { setStarting(false); }
  };
  return (
    <div className="empty welcome">
      <div className="big">{d.story.title}</div>
      <p>The campaign hasn't begun yet.</p>
      <div className="welcome-party">
        {seated.map(s => <span key={s.user_id} className={`rchip ${d.online.includes(s.user_id) ? 'on' : ''}`} title={`${s.player}${d.online.includes(s.user_id) ? ', here now' : ''}`}><Avatar src={s.avatar} name={s.name} size={20} /> {s.name} <span className="dim">({s.player})</span></span>)}
        {waiting.map(s => <span key={s.user_id} className="rchip waiting" title="At the table without a character yet">· {s.player} <span className="dim">(no character yet)</span></span>)}
        {!seated.length && !waiting.length && <span className="small muted">Nobody is at the table yet.</span>}
      </div>
      {!p.mySeat?.persona_id && <p className="small"><button className="btn sm" onClick={p.onSheet}>Bring a character to the table</button></p>}
      {d.host ? <>
        <p className="small">Share the invite code <b className="mono">{d.story.invite_code}</b> with your players (the Party panel copies it, or a sign-up link). When everyone has brought a character, begin: the Dungeon Master writes the opening scene with every character at the table, and the first round follows it.</p>
        <label className="field welcome-note">
          <span>Where it starts (optional, only you see this)</span>
          <textarea rows={2} value={note} maxLength={4000} onChange={e => setNote(e.target.value)} placeholder="e.g. Open in the caravan's last camp before the pass, the night the scouts don't come back." />
        </label>
        <p><button className="btn primary" onClick={begin} disabled={starting || p.busy || !d.conns.writer || !seated.length}>Begin the campaign</button></p>
        <p className="small muted">{!d.conns.writer ? 'No Dungeon Master connection is set up yet: an admin adds one under Connections.' : !seated.length ? 'Someone needs to bring a character first.' : 'Anyone who joins after this is brought into the story with the next round.'}</p>
      </> : <p className="small">Waiting for the host to begin. When they do, the Dungeon Master opens the scene with every character at the table, and then it's your move.</p>}
    </div>
  );
}

// The whole party is down. Nobody plays a round until the host picks what comes next; everyone else sees it and waits.
function GameOverCard(p: { d: Detail; busy: boolean; reload: () => Promise<Detail | null> }) {
  const d = p.d, go = d.gameOver!;
  const [doing, setDoing] = useState(false);
  const heroic = d.story.settings.death === 'heroic';
  const STATE = { dying: 'dying', stable: 'down, stable', dead: 'dead' } as const;
  const pick = async (what: 'fight' | 'round' | 'carry_on') => {
    const ask = what === 'fight' ? 'Try the fight again? Every round of it comes off the page, along with what it did to the sheets, and everyone says again what they do as it begins.'
      : what === 'round' ? 'Go back one round? The last round comes off the page, along with what it did to the sheets, and everyone says again what they do.'
      : `Carry on with the whole party down? ${heroic ? 'The Dungeon Master writes what becomes of them: alive, but at a real cost.' : 'Death saves go on, and whoever fails three dies.'}`;
    if (!confirm(ask)) return;
    setDoing(true);
    try {
      await api(`/stories/${d.story.id}/gameover`, { body: { do: what } });
      await p.reload();
      toast(what === 'carry_on' ? 'Carrying on. Say what your characters do.' : 'Gone back. Say what your characters do.');
    } catch (e) { errToast(e); } finally { setDoing(false); }
  };
  return (
    <div className="gameover">
      <div className="k">GAME OVER</div>
      <h2>The party has fallen.</h2>
      <div className="welcome-party">
        {go.party.map(x => { const s = d.table.find(t => t.name === x.name); return <span key={x.name} className={`rchip ${x.state}`}><Avatar src={s?.avatar} name={x.name} size={20} /> {x.name} <span className="dim">({STATE[x.state]})</span></span>; })}
      </div>
      {d.host ? <>
        <div className="row wrap" style={{ justifyContent: 'center' }}>
          {go.fight && <button className="btn primary" disabled={doing || p.busy} onClick={() => pick('fight')}>Try the fight again</button>}
          <button className={`btn ${go.fight ? '' : 'primary'}`} disabled={doing || p.busy} onClick={() => pick('round')}>Go back one round</button>
          <button className="btn ghost" disabled={doing || p.busy} onClick={() => pick('carry_on')}>Carry on</button>
        </div>
        <p className="small muted">{go.fight ? 'Try the fight again goes back to just before it began. ' : ''}Going back takes those rounds off the page and undoes what they did to the sheets. Carry on plays the next round with everyone down: {heroic ? 'nobody dies in Heroic mode, but they pay for it.' : 'death saves go on.'}</p>
      </> : <p className="small muted">The host decides what happens next: try the fight again, go back a round, or carry on.</p>}
    </div>
  );
}

// What I tell the Dungeon Master my character does this round, who else is ready, and (for the host) Go.
function Composer(p: { d: Detail; mySeat: Seat | null; busy: boolean; live: Live | null; onGo: () => void; onStop: () => void; reload: () => Promise<Detail | null>; home: Home }) {
  const d = p.d;
  const [text, setText] = useState(d.myAction?.text ?? '');
  const [ready, setReady] = useState(!!d.myAction?.ready);
  const [sending, setSending] = useState(false);
  const draftT = useRef(0);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const box = useRef<HTMLTextAreaElement>(null);
  // The server's word on my action wins when it changes from outside (a round took it, or a failed one gave it back).
  const serverKey = `${d.myAction?.ready ?? ''}|${d.myAction?.text ?? ''}`;
  const lastServer = useRef(serverKey);
  useEffect(() => {
    if (serverKey === lastServer.current) return;
    lastServer.current = serverKey;
    setReady(!!d.myAction?.ready);
    if (d.myAction) setText(d.myAction.text); else if (ready) setText('');
  }, [serverKey]);
  const mine = d.table.find(s => s.user_id === d.me)?.action;
  useEffect(() => { if (!mine && ready) { setReady(false); setText(''); } }, [mine]);
  useEffect(() => { const el = box.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`; } }, [text]);

  const send = async (r: boolean, t = text) => {
    // A draft still waiting to be saved would land after this and bring the action back as a draft.
    clearTimeout(draftT.current);
    setSending(true);
    try {
      const res = await api<{ started: boolean }>(`/stories/${d.story.id}/action`, { method: 'PUT', body: { text: t, ready: r } });
      // My Ready started the round: the action is in it now, and the box is for the next one.
      if (res.started) { setReady(false); setText(''); lastServer.current = '|'; }
      else { setReady(r); lastServer.current = `${r}|${t}`; }
    }
    catch (e) { errToast(e); } finally { setSending(false); }
  };
  // A draft is kept on the server (not shown to anyone) so it survives a reload or a switch of device.
  const onType = (v: string) => {
    setText(v);
    clearTimeout(draftT.current);
    draftT.current = window.setTimeout(() => { if (!readyRef.current) api(`/stories/${d.story.id}/action`, { method: 'PUT', body: { text: v, ready: false } }).catch(() => {}); }, 1500);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); if (text.trim() && !ready) send(true); }
  };

  const players = d.table.filter(s => s.persona_id);
  const active = players.filter(s => s.status === 'active');
  const readyN = active.filter(s => s.action?.ready).length;
  const auto = d.story.settings.auto_go === 'all_ready';
  const me = p.mySeat;
  const name = me?.name ?? '';

  return (
    <div className="inputbar">
      <div className="inputbar-inner">
        <div className="status ready-row">
          {players.map(s => {
            const st = s.status === 'away' ? 'away' : s.action?.ready ? 'ready' : s.action?.drafting ? 'writing' : 'waiting';
            return <span key={s.user_id} className={`rchip ${st} ${d.online.includes(s.user_id) ? 'on' : ''}`} title={`${s.player}: ${st}`}>{st === 'ready' ? '✓' : st === 'writing' ? '✎' : st === 'away' ? '◌' : '·'} {s.name}</span>;
          })}
          <span className="grow" />
          {p.live ? <span className="phase" style={{ margin: 0 }}><span className="spinner" />{p.live.phase || p.live.label}…</span>
            : d.begun && active.length > 0 && <span className="dim">{readyN}/{active.length} ready{auto ? '' : ' · the host starts the round'}</span>}
          {p.live && d.host && <button className="btn sm" onClick={p.onStop}>Stop</button>}
          {!p.live && d.host && d.begun && !d.gameOver && <button className="btn sm primary" onClick={p.onGo} disabled={p.busy || !d.conns.writer} title={auto ? 'Start the round now with whoever is ready' : 'Start the round'}>Go</button>}
        </div>
        {!d.conns.writer && <div className="small dim" style={{ marginBottom: 6 }}>No Dungeon Master connection is set up yet: an admin adds one under Connections.</div>}
        {!d.begun ? <div className="small muted">{p.live ? 'The Dungeon Master is opening the campaign.' : 'The first round comes after the opening scene.'}</div>
          : d.gameOver && !p.live ? <div className="small muted">Game over: the whole party is down. {d.host ? 'Pick what happens next, above.' : 'The host decides what happens next.'}</div>
          : !me?.persona_id ? <div className="small muted">You're at the table without a character. Open the Party panel to bring one (or just watch and talk).</div> : (
          <div className="prompt-row">
            <Avatar src={me.avatar} name={name} size={32} />
            <textarea ref={box} rows={1} value={text} onChange={e => onType(e.target.value)} onKeyDown={onKey} readOnly={ready}
              className={ready ? 'is-ready' : ''}
              placeholder={`What does ${name} do? Speak in "quotes". (( Double brackets )) are out of character.`} />
            {ready
              ? <button className="btn" onClick={() => send(false)} disabled={sending} title="Change your action">Change</button>
              : <div className="col" style={{ gap: 4 }}>
                <button className="btn primary" onClick={() => send(true)} disabled={sending || !text.trim()}>Ready</button>
                <button className="btn sm ghost" onClick={() => send(true, '')} disabled={sending || !!text.trim()} title="Sit this round out">Pass</button>
              </div>}
          </div>
        )}
      </div>
    </div>
  );
}

