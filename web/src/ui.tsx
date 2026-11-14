import { useEffect, useState, type ReactNode } from 'react';

// ---------- toasts
type ToastItem = { id: number; text: string; kind: 'info' | 'error' };
let toastId = 0;
const listeners = new Set<(t: ToastItem[]) => void>();
let items: ToastItem[] = [];
function publish() { for (const l of listeners) l(items); }
export function toast(text: string, kind: 'info' | 'error' = 'info', ms = kind === 'error' ? 7000 : 3500) {
  const t = { id: ++toastId, text, kind };
  items = [...items, t].slice(-4);
  publish();
  setTimeout(() => { items = items.filter(x => x.id !== t.id); publish(); }, ms);
}
export function Toasts() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => { listeners.add(setList); return () => { listeners.delete(setList); }; }, []);
  return <div className="toast-wrap">{list.map(t => <div key={t.id} className={`toast ${t.kind}`}><div>{t.text}</div></div>)}</div>;
}
export const errToast = (e: any) => toast(e?.message || String(e), 'error');

// ---------- modal
export function Modal(p: { title: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [p.onClose]);
  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className={`modal ${p.wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head"><h3 className="grow">{p.title}</h3><button className="icon-btn" onClick={p.onClose} aria-label="Close">✕</button></div>
        <div className="modal-body">{p.children}</div>
        {p.foot && <div className="modal-foot">{p.foot}</div>}
      </div>
    </div>
  );
}

export function Switch(p: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={p.checked} onChange={e => p.onChange(e.target.checked)} />
      <span><b>{p.label}</b>{p.hint && <small>{p.hint}</small>}</span>
    </label>
  );
}

export function Seg(p: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return <div className="seg">{p.options.map(o => <button key={o.value} type="button" className={p.value === o.value ? 'on' : ''} onClick={() => p.onChange(o.value)}>{o.label}</button>)}</div>;
}

export function Field(p: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return <label className="field">{p.label}{p.children}{p.hint && <span className="hint">{p.hint}</span>}</label>;
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try { return await fn(); } catch (e) { errToast(e); return undefined; } finally { setBusy(false); }
  };
  return { busy, run };
}

export function download(url: string) {
  const a = document.createElement('a');
  a.href = url; a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}
