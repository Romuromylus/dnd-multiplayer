// The admin's screens (connections to the models, the players' accounts) and everyone's own account and appearance.
import { useEffect, useState } from 'react';
import { api, savePrefs, type Connection, type User } from './api';
import { applyPrefs, COLOR_KEYS, currentColor, type ColorKey, type Prefs } from './appearance';
import { renderProse } from './render';
import { errToast, Field, Modal, Seg, Switch, toast, useAsync } from './ui';

const THINKING = [
  { value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' }, { value: 'xhigh', label: 'XHigh' }, { value: 'max', label: 'Max' },
];
const POSTPROC = [
  { value: 'none', label: 'None', hint: 'Send messages as built (best for Claude).' },
  { value: 'merge', label: 'Merge consecutive roles', hint: 'Join back-to-back messages from the same role.' },
  { value: 'semi', label: 'Semi-strict', hint: 'One system message at the top, then alternating roles.' },
  { value: 'strict', label: 'Strict', hint: 'Semi-strict, and the first message after system is always the user.' },
  { value: 'single', label: 'Single user message', hint: 'Everything in one user message. Turns tools off, so lookups and records are skipped.' },
];

export function ConnectionsModal(p: { onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<Connection[]>([]);
  const [sel, setSel] = useState<number | 'new'>('new');
  const conn = list.find(c => c.id === sel);
  const blank = (): Partial<Connection> => ({
    name: list.length ? 'New connection' : 'Dungeon Master', api_type: 'anthropic', endpoint: '', model: 'claude-opus-5-5', thinking_level: 'high',
    show_thinking: true, max_tokens: 32000, post_processing: 'none', caching: true, default_role: list.length ? 'none' : 'writer',
  });
  const [f, setF] = useState<Partial<Connection>>(blank());
  const [key, setKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [results, setResults] = useState<{ step: string; ok: boolean; detail: string }[] | null>(null);
  const { busy, run } = useAsync();
  const reload = async () => { const r = await api<{ connections: Connection[] }>('/connections'); setList(r.connections); return r.connections; };
  useEffect(() => { reload().then(l => { if (l[0]) setSel(l[0].id); }).catch(errToast); }, []);
  useEffect(() => { setF(conn ?? blank()); setKey(''); setResults(null); setModels([]); }, [sel, list.length]);
  const set = (k: keyof Connection, v: any) => setF(x => ({ ...x, [k]: v }));
  const save = () => run(async () => {
    const body = { ...f, api_key: key || undefined };
    const r: Connection = sel === 'new' ? await api('/connections', { body }) : await api(`/connections/${sel}`, { method: 'PUT', body });
    await reload(); setSel(r.id); setKey(''); p.onChanged();
    toast('Connection saved.');
    return r;
  });
  const fetchModels = () => run(async () => {
    const r = await api<{ models: string[] }>('/connections/models', { body: { id: sel === 'new' ? undefined : sel, api_type: f.api_type, endpoint: f.endpoint, api_key: key || undefined } });
    setModels(r.models); toast(`${r.models.length} models found.`);
  });
  const test = () => run(async () => {
    let id = sel;
    if (sel === 'new' || key || JSON.stringify(f) !== JSON.stringify(conn)) { const r = await save(); if (!r) return; id = r.id; }
    setResults(null);
    const r = await api<{ results: any[] }>(`/connections/${id}/test`, { body: {} });
    setResults(r.results);
  });
  const del = () => run(async () => {
    if (sel === 'new' || !confirm('Delete this connection?')) return;
    await api(`/connections/${sel}`, { method: 'DELETE' });
    const l = await reload(); setSel(l[0]?.id ?? 'new'); p.onChanged();
  });
  return (
    <Modal title="Connections" onClose={p.onClose} wide foot={<>
      {sel !== 'new' && <button className="btn danger" onClick={del} disabled={busy}>Delete</button>}
      <span className="grow" />
      <button className="btn" onClick={test} disabled={busy || !f.endpoint}>{busy ? '…' : 'Test'}</button>
      <button className="btn primary" onClick={save} disabled={busy || !f.endpoint || !f.model}>Save</button>
    </>}>
      <div className="split">
        <div className="list">
          {list.map(c => (
            <button key={c.id} className={`side-item ${sel === c.id ? 'on' : ''}`} onClick={() => setSel(c.id)}>
              <div className="t ellipsis">{c.name}</div>
              <div className="m ellipsis">{c.model}{c.default_role !== 'none' ? ` · ${ROLE_NAME[c.default_role] ?? c.default_role}` : ''}</div>
            </button>
          ))}
          <button className={`side-item ${sel === 'new' ? 'on' : ''}`} onClick={() => setSel('new')}><div className="t">+ New connection</div></button>
        </div>
        <div className="col" style={{ gap: 14 }}>
          <div className="muted small">The Dungeon Master writes every round; the records keeper keeps the sheets, people and threads, checks continuity and writes summaries (a cheaper model is fine); Images paints portraits and scenes.</div>
          <div className="grid2">
            <Field label="Name"><input type="text" value={f.name ?? ''} onChange={e => set('name', e.target.value)} /></Field>
            <Field label="API type"><select value={f.api_type} onChange={e => set('api_type', e.target.value)}><option value="anthropic">Anthropic Messages</option><option value="openai">OpenAI-compatible</option></select></Field>
          </div>
          <Field label="Endpoint URL" hint={f.api_type === 'anthropic' ? 'Base URL, e.g. https://api.anthropic.com' : 'Base URL ending in /v1'}>
            <input type="text" value={f.endpoint ?? ''} onChange={e => set('endpoint', e.target.value)} placeholder="https://…" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </Field>
          <Field label="API key" hint="Stored encrypted on the server and never sent back to the browser.">
            <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder={conn?.has_key ? `•••• ${conn.key_last4 ?? ''} (leave empty to keep)` : 'Paste key'} autoComplete="off" />
          </Field>
          <Field label="Model">
            <div className="row">
              <input type="text" list="model-list" value={f.model ?? ''} onChange={e => set('model', e.target.value)} autoCapitalize="off" spellCheck={false} />
              <button className="btn" onClick={fetchModels} disabled={busy || !f.endpoint}>Fetch models</button>
            </div>
            <datalist id="model-list">{models.map(m => <option key={m} value={m} />)}</datalist>
            {models.length > 0 && <select value="" onChange={e => e.target.value && set('model', e.target.value)}><option value="">Pick from {models.length} models…</option>{models.map(m => <option key={m}>{m}</option>)}</select>}
          </Field>
          <Field label="Thinking level"><Seg value={f.thinking_level ?? 'high'} options={THINKING} onChange={v => set('thinking_level', v)} /></Field>
          <div className="grid2">
            <Field label="Max output tokens" hint="32k for the Dungeon Master, 8k to 16k for records."><input type="number" min={1024} max={128000} step={1024} value={f.max_tokens ?? 32000} onChange={e => set('max_tokens', Number(e.target.value))} /></Field>
            <Field label="Prompt post-processing" hint={POSTPROC.find(x => x.value === f.post_processing)?.hint}>
              <select value={f.post_processing} onChange={e => set('post_processing', e.target.value)}>{POSTPROC.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
            </Field>
          </div>
          <Switch checked={!!f.show_thinking} onChange={v => set('show_thinking', v)} label="Show thinking" hint="The host sees the Dungeon Master's summarized thinking under each round. Players never do." />
          <Switch checked={!!f.caching} onChange={v => set('caching', v)} label="Prompt caching" hint="Cache breakpoints after the rules, the campaign so far and the chapter text." />
          <Field label="Default role" hint={f.default_role === 'images' ? 'OpenAI-compatible image endpoint. Test only checks the model is listed (a test picture would cost money).' : undefined}>
            <Seg value={f.default_role ?? 'none'} options={[{ value: 'writer', label: 'Dungeon Master' }, { value: 'records', label: 'Records keeper' }, { value: 'images', label: 'Images' }, { value: 'none', label: 'None' }]} onChange={v => { set('default_role', v); if (v === 'images') set('api_type', 'openai'); }} />
          </Field>
          {results && <div className="rec">{results.map(r => <div key={r.step} className="row" style={{ alignItems: 'flex-start' }}><span className={`chip ${r.ok ? 'ok' : 'warn'}`}>{r.ok ? 'ok' : 'fail'}</span><div><b>{r.step}</b><div className="muted small">{r.detail}</div></div></div>)}</div>}
        </div>
      </div>
    </Modal>
  );
}
const ROLE_NAME: Record<string, string> = { writer: 'Dungeon Master', records: 'records keeper', images: 'images' };

export function PlayersModal(p: { me: User; onClose: () => void }) {
  const [users, setUsers] = useState<(User & { created_at: string })[]>([]);
  const [f, setF] = useState({ username: '', password: '', display_name: '' });
  const { busy, run } = useAsync();
  const reload = () => api<{ users: any[] }>('/admin/users').then(r => setUsers(r.users)).catch(errToast);
  useEffect(() => { reload(); }, []);
  const add = () => run(async () => { await api('/admin/users', { body: f }); setF({ username: '', password: '', display_name: '' }); await reload(); toast('Account made. Give them the username and password.'); });
  const reset = (u: User) => run(async () => {
    const pw = prompt(`New password for ${u.username} (8 characters or more):`);
    if (!pw) return;
    await api(`/admin/users/${u.id}`, { method: 'PUT', body: { password: pw } }); toast(`Password changed. ${u.username} is signed out everywhere.`);
  });
  const role = (u: User) => run(async () => { await api(`/admin/users/${u.id}`, { method: 'PUT', body: { role: u.role === 'admin' ? 'player' : 'admin' } }); await reload(); });
  const del = (u: User) => run(async () => {
    if (!confirm(`Delete ${u.username}'s account? Their characters go with it, and they leave every table.`)) return;
    await api(`/admin/users/${u.id}`, { method: 'DELETE' }); await reload();
  });
  return (
    <Modal title="Players" onClose={p.onClose}>
      <div className="muted small">Players can also sign up on their own with a campaign's invite code. Here you can make an account for someone, reset a password, or make someone an admin (admins see every campaign and set up connections).</div>
      {users.map(u => (
        <div key={u.id} className="rec"><div className="h">
          <b>{u.display_name || u.username}</b><span className="dim mono tiny">{u.username}</span>{u.role === 'admin' && <span className="chip">admin</span>}
          <span className="grow" />
          <button className="btn sm ghost" onClick={() => reset(u)} disabled={busy}>Password</button>
          {u.id !== p.me.id && <button className="btn sm ghost" onClick={() => role(u)} disabled={busy}>{u.role === 'admin' ? 'Make player' : 'Make admin'}</button>}
          {u.id !== p.me.id && <button className="btn sm ghost danger" onClick={() => del(u)} disabled={busy}>Delete</button>}
        </div></div>
      ))}
      <div className="section-title">New account</div>
      <div className="grid2">
        <Field label="Username"><input type="text" value={f.username} onChange={e => setF(x => ({ ...x, username: e.target.value }))} autoCapitalize="off" /></Field>
        <Field label="Display name"><input type="text" value={f.display_name} onChange={e => setF(x => ({ ...x, display_name: e.target.value }))} /></Field>
      </div>
      <Field label="Password"><input type="text" value={f.password} onChange={e => setF(x => ({ ...x, password: e.target.value }))} autoComplete="off" /></Field>
      <div className="row"><span className="grow" /><button className="btn primary" onClick={add} disabled={busy || !f.username || f.password.length < 8}>Make account</button></div>
    </Modal>
  );
}

const SAMPLE = `Rain drummed on the tavern's shutters. *Not tonight,* Ilsa thought.

"You're late," the innkeeper said, without looking up. "Again."

He slid the key across the bar. <u>Room four.</u>`;

export function AccountModal(p: { me: User; theme: string; setTheme: (t: string) => void; onClose: () => void; onSaved: (u: User) => void }) {
  const [display, setDisplay] = useState(p.me.display_name);
  const [colors, setColors] = useState<Prefs>({ ...(p.me.prefs.colors ?? {}) });
  const [pw, setPw] = useState({ old: '', next: '' });
  const [, redraw] = useState(0);
  const { busy, run } = useAsync();
  useEffect(() => { applyPrefs(colors); redraw(n => n + 1); }, [colors, p.theme]);
  const close = () => { applyPrefs(p.me.prefs.colors ?? {}); p.onClose(); };
  const save = () => run(async () => {
    savePrefs('colors', colors);
    const body: any = { display_name: display };
    if (pw.next) { body.password = pw.old; body.new_password = pw.next; }
    const r = await api<{ user: User }>('/me', { method: 'PUT', body });
    p.onSaved({ ...r.user, prefs: { ...r.user.prefs, colors } }); toast('Saved.'); p.onClose();
  });
  const set = (k: ColorKey, v: string) => setColors(x => ({ ...x, [k]: v }));
  return (
    <Modal title="Your account" onClose={close} foot={<>
      <button className="btn" onClick={() => api('/auth/logout', { body: {} }).then(() => location.reload())}>Sign out</button>
      <span className="grow" />
      <button className="btn ghost" onClick={close}>Cancel</button>
      <button className="btn primary" onClick={save} disabled={busy || !display.trim()}>Save</button>
    </>}>
      <Field label="Display name" hint="What the others at the table see."><input type="text" value={display} onChange={e => setDisplay(e.target.value)} /></Field>
      <div className="grid2">
        <Field label="Current password"><input type="password" value={pw.old} onChange={e => setPw(x => ({ ...x, old: e.target.value }))} autoComplete="current-password" /></Field>
        <Field label="New password" hint="Leave empty to keep it."><input type="password" value={pw.next} onChange={e => setPw(x => ({ ...x, next: e.target.value }))} autoComplete="new-password" /></Field>
      </div>
      <Field label="Theme" hint="On this device."><Seg value={p.theme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} onChange={p.setTheme} /></Field>
      <div className="section-title">Text colors</div>
      {COLOR_KEYS.map(c => {
        const v = colors[c.key] ?? '';
        return (
          <div key={c.key} className="color-row">
            <div className="grow"><b>{c.label}</b>{c.hint && <div className="small muted">{c.hint}</div>}</div>
            {c.canOff && <Switch checked={v !== 'off'} onChange={on => set(c.key, on ? '' : 'off')} label="" />}
            <input type="color" value={currentColor(c.key)} disabled={v === 'off'} onChange={e => set(c.key, e.target.value)} aria-label={`${c.label} color`} />
            <button className="btn sm ghost" onClick={() => set(c.key, '')} disabled={!v.startsWith('#')}>Default</button>
          </div>
        );
      })}
      <div className="rec"><div className="prose" style={{ fontSize: 16 }} dangerouslySetInnerHTML={{ __html: renderProse(SAMPLE, { quotes: true }) }} /></div>
    </Modal>
  );
}
