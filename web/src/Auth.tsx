// Signing in, making the first (admin) account, and signing up with a campaign's invite code.
import { useState } from 'react';
import { api, type User } from './api';
import { Field, useAsync } from './ui';

export function AuthView(p: { setup: boolean; onIn: (u: User, joined?: number | null) => void }) {
  const invite = new URLSearchParams(location.search).get('join') ?? '';
  const [mode, setMode] = useState<'in' | 'up'>(p.setup || invite ? 'up' : 'in');
  const [f, setF] = useState({ username: '', password: '', display_name: '', code: invite.toUpperCase() });
  const { busy, run } = useAsync();
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }));
  const go = () => run(async () => {
    if (mode === 'in') { const r = await api<{ user: User }>('/auth/login', { body: f }); p.onIn(r.user); return; }
    const r = await api<{ user: User; joined: number | null }>('/auth/register', { body: f });
    p.onIn(r.user, r.joined);
  });
  return (
    <div className="auth">
      <form className="auth-box" onSubmit={e => { e.preventDefault(); go(); }}>
        <div className="logo" style={{ justifyContent: 'center', fontSize: 20 }}><img src="/favicon.svg" alt="" /> The Table</div>
        <p className="muted small" style={{ textAlign: 'center', margin: '4px 0 14px' }}>
          {p.setup ? 'Make the first account. It is the admin: it sets up the model and can see every campaign.' : 'A D&D 5e table with an AI Dungeon Master. Everyone says what their character does; the Dungeon Master tells what happens.'}
        </p>
        {!p.setup && <div className="seg" style={{ alignSelf: 'center', marginBottom: 12 }}>
          <button type="button" className={mode === 'in' ? 'on' : ''} onClick={() => setMode('in')}>Sign in</button>
          <button type="button" className={mode === 'up' ? 'on' : ''} onClick={() => setMode('up')}>I have an invite code</button>
        </div>}
        {invite && !p.setup && <p className="small muted" style={{ textAlign: 'center', margin: '0 0 10px' }}>
          {mode === 'up' ? 'Already have an account? Sign in instead: you’ll join this campaign either way.' : 'You’ll join the campaign from your invite once you sign in.'}
        </p>}
        <Field label="Username"><input type="text" value={f.username} onChange={e => set('username', e.target.value)} autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus /></Field>
        <Field label="Password" hint={mode === 'up' ? 'At least 8 characters.' : undefined}><input type="password" value={f.password} onChange={e => set('password', e.target.value)} autoComplete={mode === 'up' ? 'new-password' : 'current-password'} /></Field>
        {mode === 'up' && <Field label="Display name" hint="What the others at the table see. Optional."><input type="text" value={f.display_name} onChange={e => set('display_name', e.target.value)} /></Field>}
        {mode === 'up' && !p.setup && <Field label="Invite code" hint="From the host of the campaign you're joining."><input type="text" value={f.code} onChange={e => set('code', e.target.value.toUpperCase())} autoCapitalize="characters" /></Field>}
        <button className="btn primary" type="submit" disabled={busy || !f.username || !f.password || (mode === 'up' && !p.setup && !f.code)} style={{ justifyContent: 'center', marginTop: 6 }}>
          {busy ? '…' : mode === 'in' ? 'Sign in' : p.setup ? 'Make the admin account' : 'Make my account and join'}
        </button>
      </form>
    </div>
  );
}
