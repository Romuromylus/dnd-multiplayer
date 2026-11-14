import { useState } from 'react';
import { narrator, useNarrator } from './narrator';
import { SPEEDS, VOICES } from '../../server/speech';
import { Switch } from './ui';

const I = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true } as const;
export const SpeakerIcon = () => <svg {...I}><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M18.6 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
const PlayIcon = () => <svg {...I}><path d="M8 5v14l11-7z" /></svg>;
const PauseIcon = () => <svg {...I}><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>;
const BackIcon = () => <svg {...I}><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>;
const NextIcon = () => <svg {...I}><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>;

// The player, while this story is being read aloud, and the narrator's settings when they're open.
export function NarratorBar(p: { storyId: number; storyTitle: string; unit: string; onLatest: (() => void) | null }) {
  const n = useNarrator();
  const active = n.storyId === p.storyId && n.status !== 'idle';
  const speed = n.prefs.speed ?? 1;
  const nextSpeed = () => narrator.setPrefs({ speed: SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1 });
  return <>
    {active && <div className="narr-bar">
      <button className="icon-btn" onClick={() => narrator.skip(-1)} aria-label="Back a sentence" title="Back a sentence"><BackIcon /></button>
      <button className="icon-btn play" onClick={() => narrator.toggle()} aria-label={n.status === 'paused' ? 'Play' : 'Pause'}>{n.status === 'paused' ? <PlayIcon /> : <PauseIcon />}</button>
      <button className="icon-btn" onClick={() => narrator.skip(1)} aria-label="Next sentence" title="Next sentence"><NextIcon /></button>
      <div className="narr-cap">
        <div className="k ellipsis">{n.label}{n.total ? ` · ${n.chunk + 1}/${n.total}` : ''}{n.status === 'loading' ? (n.waking ? ' · waking the narrator' : ' · …') : n.status === 'paused' ? ' · paused' : ''}</div>
        <div className="t ellipsis">{n.caption || ' '}</div>
      </div>
      <button className="btn sm ghost" onClick={nextSpeed} title="Speed">{speed}×</button>
      <button className={`icon-btn ${n.panel ? 'on' : ''}`} onClick={() => narrator.setPanel(!n.panel)} aria-label="Narrator settings" title="Voice and speed"><SpeakerIcon /></button>
      <button className="icon-btn" onClick={() => narrator.stop()} aria-label="Stop reading" title="Stop">✕</button>
    </div>}
    {n.panel && <NarratorPanel storyId={p.storyId} unit={p.unit} active={active} onLatest={p.onLatest} />}
  </>;
}

function NarratorPanel(p: { storyId: number; unit: string; active: boolean; onLatest: (() => void) | null }) {
  const n = useNarrator();
  const voice = narrator.voiceFor(p.storyId);
  const speed = n.prefs.speed ?? 1;
  const [trying, setTrying] = useState(false);
  const pick = (v: string) => narrator.setVoice(p.storyId, v);
  return (
    <div className="narr-panel" role="dialog" aria-label="Narrator">
      <div className="row"><div className="section-title grow">Narrator</div><button className="icon-btn" onClick={() => narrator.setPanel(false)} aria-label="Close">✕</button></div>
      <div className="row">
        <select className="grow" value={voice} onChange={e => pick(e.target.value)} aria-label="Voice">
          {VOICES.map(v => <option key={v.id} value={v.id}>{v.name} · {v.note}</option>)}
        </select>
        <button className="btn sm" disabled={trying} onClick={() => { setTrying(true); narrator.trySample(voice, () => setTrying(false)); }}>{trying ? 'Playing…' : 'Try it'}</button>
      </div>
      <div className="row wrap narr-speeds">
        <span className="small dim">Speed</span>
        {SPEEDS.map(s => <button key={s} className={`btn sm ${s === speed ? 'primary' : ''}`} onClick={() => narrator.setPrefs({ speed: s })}>{s}×</button>)}
      </div>
      <Switch checked={!!n.prefs.auto} onChange={v => narrator.setPrefs({ auto: v })} label={`Read each new ${p.unit} aloud when it's written`} />
      {!p.active && p.onLatest && <button className="btn sm" onClick={() => { narrator.setPanel(false); p.onLatest!(); }}>Listen to the latest {p.unit}</button>}
      <div className="tiny dim">The voice is made on this server by Kokoro, a free and open voice model, so listening costs nothing. Each sentence is made once and kept, so hearing it again is instant. After a quiet spell the narrator takes a few seconds to wake.</div>
    </div>
  );
}
