// Talking things through with the Dungeon Master: making a character (the Dungeon Master asks, explains and suggests, and
// what gets settled lands on the form beside the chat) or levelling one up (the choices the new level asks for, one at a time).
import { Fragment, useEffect, useRef, useState } from 'react';
import { useAssistJob } from './Assist';

export type ChatLine = { role: 'dm' | 'me'; text: string; draft?: Record<string, any> };

// What makes one chat different from another: where it goes, what goes with it, how it opens, and its dice.
export type ChatSetup = {
  path: string;
  body: () => Record<string, any>;
  greeting: string;
  starters?: { label: string; text: string }[];
  roll?: { label: string; title: string; confirm: string; marker: string; make: () => string } | null;
  placeholder: string;
  noting: string;
};

// The dice are rolled here, for real, once: the Dungeon Master model can't roll.
export const die = (sides: number) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return (a[0] % sides) + 1; };
const rollScores = () => Array.from({ length: 6 }, () => { const r = [die(6), die(6), die(6), die(6)].sort((x, y) => y - x); return r[0] + r[1] + r[2]; });

export const buildSetup = (body: () => Record<string, any>): ChatSetup => ({
  path: '/assist/character-chat',
  body,
  greeting: `Let's make your character. Tell me anything: an idea, a hero from a show or a book you love, or just how you like to play (hit hard, sneak around, cast spells, talk your way out).

New to D&D? Say so and I'll explain as we go. Any language is fine.`,
  starters: [
    { label: "I'm new to D&D", text: "I'm new to D&D. Help me make a character, and explain things as we go." },
    { label: 'Surprise me', text: 'Surprise me: come up with a character for me.' },
  ],
  roll: {
    label: '🎲 Roll ability scores', title: '4d6, drop the lowest, six times. Once.', marker: '🎲 I rolled my ability scores',
    confirm: 'Roll your ability scores? 4d6, drop the lowest, six times. You roll once, and these are the numbers you keep.',
    make: () => `🎲 I rolled my ability scores (4d6, drop the lowest, six times): ${rollScores().join(', ')}.`,
  },
  placeholder: "Tell the Dungeon Master who you'd like to play…",
  noting: 'filling in the form',
});

// Plain text with the odd **bold** a model writes anyway, without handing it HTML.
const Text = ({ t }: { t: string }) => <>{t.split(/\*\*(.+?)\*\*/g).map((s, i) => i % 2 ? <b key={i}>{s}</b> : <Fragment key={i}>{s}</Fragment>)}</>;

export function DmChat(p: { lines: ChatLine[]; setLines: (f: (l: ChatLine[]) => ChatLine[]) => void; setup: ChatSetup; onDraft: (d: Record<string, any>) => void; ready: boolean }) {
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const job = useAssistJob();
  const log = useRef<HTMLDivElement>(null);
  const latest = useRef(p);
  latest.current = p;
  const roll = p.setup.roll;
  const rolled = !!roll && p.lines.some(l => l.role === 'me' && l.text.startsWith(roll.marker));
  const waiting = !job.busy && p.lines[p.lines.length - 1]?.role === 'me';
  useEffect(() => { const el = log.current; if (el) el.scrollTop = el.scrollHeight; }, [p.lines.length, streaming, job.busy]);

  const ask = (lines: ChatLine[]) => {
    let acc = '';
    setStreaming('');
    job.start(latest.current.setup.path, { lines, ...latest.current.setup.body() }, {
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
  const doRoll = () => { if (roll && confirm(roll.confirm)) send(roll.make()); };
  const restart = () => { if (confirm('Clear the conversation? What it settled stays.')) p.setLines(() => []); };

  if (!p.ready) return <div className="muted small">Talking it through needs a model: an admin has to add a connection first.</div>;
  return (
    <div className="bchat">
      <div className="bchat-log" ref={log}>
        <div className="bmsg dm"><span className="who">Dungeon Master</span><Text t={p.setup.greeting} /></div>
        {p.lines.map((l, i) => <div key={i} className={`bmsg ${l.role}`}>{l.role === 'dm' && <span className="who">Dungeon Master</span>}<Text t={l.text} /></div>)}
        {streaming !== null && <div className="bmsg dm"><span className="who">Dungeon Master</span>{streaming ? <Text t={streaming} /> : <span className="muted"><span className="spinner" /> {job.phase || 'thinking'}…</span>}
          {streaming && job.phase === p.setup.noting && <span className="filling"><span className="spinner" /> {p.setup.noting}…</span>}</div>}
      </div>
      {waiting && <div className="ai-row"><span className="muted small grow">No answer came back.</span><button type="button" className="btn sm" onClick={() => ask(p.lines)}>Try again</button></div>}
      {!job.busy && <div className="bchat-chips">
        {!p.lines.length && p.setup.starters?.map(s => <button key={s.label} type="button" className="btn sm" onClick={() => send(s.text)}>{s.label}</button>)}
        {roll && !rolled && <button type="button" className="btn sm" onClick={doRoll} title={roll.title}>{roll.label}</button>}
        {p.lines.length > 0 && <button type="button" className="btn sm ghost" onClick={restart}>Start the talk over</button>}
      </div>}
      <div className="bchat-in">
        <textarea rows={2} value={text} onChange={e => setText(e.target.value)} placeholder={p.setup.placeholder} maxLength={4000}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); } }} />
        {job.busy
          ? <button type="button" className="btn" onClick={job.stop}>Stop</button>
          : <button type="button" className="btn primary" onClick={() => send(text)} disabled={!text.trim()}>Send</button>}
      </div>
    </div>
  );
}
