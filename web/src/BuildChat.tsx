// Making a character by talking it through with the Dungeon Master: the player says who they'd like to play, the Dungeon Master
// asks, explains and suggests, and what gets settled lands on the form beside the chat, ready for Build the sheet.
import { Fragment, useEffect, useRef, useState } from 'react';
import { useAssistJob } from './Assist';

export type ChatLine = { role: 'dm' | 'me'; text: string; draft?: Record<string, any> };

const GREETING = `Let's make your character. Tell me anything: an idea, a hero from a show or a book you love, or just how you like to play (hit hard, sneak around, cast spells, talk your way out).

New to D&D? Say so and I'll explain as we go. Any language is fine.`;
const ROLLED = '🎲 I rolled my ability scores';

// The dice are rolled here, for real, once: the Dungeon Master model can't roll.
const d6 = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return (a[0] % 6) + 1; };
const rollScores = () => Array.from({ length: 6 }, () => { const r = [d6(), d6(), d6(), d6()].sort((x, y) => y - x); return r[0] + r[1] + r[2]; });

// Plain text with the odd **bold** a model writes anyway, without handing it HTML.
const Text = ({ t }: { t: string }) => <>{t.split(/\*\*(.+?)\*\*/g).map((s, i) => i % 2 ? <b key={i}>{s}</b> : <Fragment key={i}>{s}</Fragment>)}</>;

export function BuildChat(p: { lines: ChatLine[]; setLines: (f: (l: ChatLine[]) => ChatLine[]) => void; draft: () => Record<string, any>; onDraft: (d: Record<string, any>) => void; ready: boolean; built: boolean }) {
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const job = useAssistJob();
  const log = useRef<HTMLDivElement>(null);
  const latest = useRef(p);
  latest.current = p;
  const rolled = p.lines.some(l => l.role === 'me' && l.text.startsWith(ROLLED));
  const waiting = !job.busy && p.lines[p.lines.length - 1]?.role === 'me';
  useEffect(() => { const el = log.current; if (el) el.scrollTop = el.scrollHeight; }, [p.lines.length, streaming, job.busy]);

  const ask = (lines: ChatLine[]) => {
    let acc = '';
    setStreaming('');
    job.start('/assist/character-chat', { lines, draft: latest.current.draft(), built: latest.current.built }, {
      text: d => { acc += d; setStreaming(acc.replace(/^\s+/, '')); },
      done: r => {
        const draft = r.draft ?? {};
        latest.current.setLines(l => [...l, { role: 'dm', text: (r.reply ?? acc).trim(), draft }]);
        latest.current.onDraft(draft);
        setStreaming(null);
      },
      fail: () => setStreaming(null),
    });
  };
  const send = (msg: string) => {
    const t = msg.trim();
    if (!t || job.busy) return;
    const lines = [...p.lines, { role: 'me' as const, text: t }];
    p.setLines(() => lines);
    setText('');
    ask(lines);
  };
  const roll = () => {
    if (!confirm('Roll your ability scores? 4d6, drop the lowest, six times. You roll once, and these are the numbers you keep.')) return;
    send(`${ROLLED} (4d6, drop the lowest, six times): ${rollScores().join(', ')}.`);
  };
  const restart = () => { if (confirm('Clear the conversation? What it put on the form stays.')) p.setLines(() => []); };

  if (!p.ready) return <div className="muted small">Talking it through needs a model: an admin has to add a connection first. Fill in the boxes instead.</div>;
  return (
    <div className="bchat">
      <div className="bchat-log" ref={log}>
        <div className="bmsg dm"><span className="who">Dungeon Master</span><Text t={GREETING} /></div>
        {p.lines.map((l, i) => <div key={i} className={`bmsg ${l.role}`}>{l.role === 'dm' && <span className="who">Dungeon Master</span>}<Text t={l.text} /></div>)}
        {streaming !== null && <div className="bmsg dm"><span className="who">Dungeon Master</span>{streaming ? <Text t={streaming} /> : <span className="muted"><span className="spinner" /> {job.phase || 'thinking'}…</span>}
          {streaming && job.phase === 'filling in the form' && <span className="filling"><span className="spinner" /> filling in the form…</span>}</div>}
      </div>
      {waiting && <div className="ai-row"><span className="muted small grow">No answer came back.</span><button type="button" className="btn sm" onClick={() => ask(p.lines)}>Try again</button></div>}
      {!job.busy && <div className="bchat-chips">
        {!p.lines.length && <>
          <button type="button" className="btn sm" onClick={() => send("I'm new to D&D. Help me make a character, and explain things as we go.")}>I'm new to D&D</button>
          <button type="button" className="btn sm" onClick={() => send('Surprise me: come up with a character for me.')}>Surprise me</button>
        </>}
        {!rolled && <button type="button" className="btn sm" onClick={roll} title="4d6, drop the lowest, six times. Once.">🎲 Roll ability scores</button>}
        {p.lines.length > 0 && <button type="button" className="btn sm ghost" onClick={restart}>Start the talk over</button>}
      </div>}
      <div className="bchat-in">
        <textarea rows={2} value={text} onChange={e => setText(e.target.value)} placeholder="Tell the Dungeon Master who you'd like to play…" maxLength={4000}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); } }} />
        {job.busy
          ? <button type="button" className="btn" onClick={job.stop}>Stop</button>
          : <button type="button" className="btn primary" onClick={() => send(text)} disabled={!text.trim()}>Send</button>}
      </div>
    </div>
  );
}
