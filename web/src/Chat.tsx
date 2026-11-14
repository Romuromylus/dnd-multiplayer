// Table talk: the players' own chat, out of character. The Dungeon Master never reads it.
import { useEffect, useRef, useState } from 'react';
import { api, type Detail } from './api';
import { errToast } from './ui';

export function ChatPanel(p: { d: Detail }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [p.d.chat.length]);
  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    try { await api(`/stories/${p.d.story.id}/chat`, { body: { text } }); setText(''); } catch (e) { errToast(e); } finally { setSending(false); }
  };
  return (
    <div className="chat">
      <div className="muted tiny">Out of character, between the players. The Dungeon Master never reads this.</div>
      <div className="chat-list">
        {p.d.chat.length === 0 && <div className="muted small">Nothing said yet.</div>}
        {p.d.chat.map(c => (
          <div key={c.id} className={`chat-line ${c.user_id === p.d.me ? 'me' : ''}`}>
            <span className="who">{c.who}</span> <span className="dim tiny">{new Date(c.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <div className="txt">{c.text}</div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="row">
        <input type="text" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send(); }} placeholder="Say something to the table" maxLength={2000} />
        <button className="btn" onClick={send} disabled={sending || !text.trim()}>Send</button>
      </div>
    </div>
  );
}
