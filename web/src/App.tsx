import { useCallback, useEffect, useState } from 'react';
import { api, setKnownPrefs, type Home, type User } from './api';
import { applyPrefs } from './appearance';
import { AuthView } from './Auth';
import { HomeView } from './Home';
import { TableView } from './Table';
import { narrator } from './narrator';
import { errToast, Toasts } from './ui';

// #/ is home, #/c/12 is campaign 12.
const routeOf = () => { const m = location.hash.match(/^#\/c\/(\d+)/); return m ? Number(m[1]) : null; };

export default function App() {
  const [auth, setAuth] = useState<{ user: User | null; setup: boolean } | null>(null);
  const [home, setHome] = useState<Home | null>(null);
  const [route, setRoute] = useState<number | null>(routeOf);
  const [theme, setThemeState] = useState(() => { try { return localStorage.getItem('dnd-theme') || 'dark'; } catch { return 'dark'; } });
  const setTheme = (t: string) => { setThemeState(t); document.documentElement.dataset.theme = t; try { localStorage.setItem('dnd-theme', t); } catch { /* */ } };

  const useUser = (u: User) => {
    setKnownPrefs(u.prefs ?? {});
    applyPrefs(u.prefs?.colors ?? {});
    narrator.init(u.prefs?.narrator);
  };
  const loadHome = useCallback(async () => {
    try { const h = await api<Home>('/home'); setHome(h); } catch (e) { errToast(e); }
  }, []);

  useEffect(() => {
    api<{ user: User | null; setup: boolean }>('/auth/status').then(s => { setAuth(s); if (s.user) { useUser(s.user); loadHome(); } }).catch(() => setAuth({ user: null, setup: false }));
    const out = () => { setAuth(a => a && { ...a, user: null }); setHome(null); };
    const hash = () => setRoute(routeOf());
    window.addEventListener('signed-out', out);
    window.addEventListener('hashchange', hash);
    return () => { window.removeEventListener('signed-out', out); window.removeEventListener('hashchange', hash); };
  }, []);

  const open = (id: number | null) => { location.hash = id ? `#/c/${id}` : '#/'; };

  if (!auth) return <div className="empty">Loading…</div>;
  if (!auth.user) return <><AuthView setup={auth.setup} onIn={(u, joined) => {
    setAuth({ user: u, setup: false }); useUser(u); loadHome();
    if (location.search) history.replaceState(null, '', location.pathname + location.hash);
    if (joined) open(joined);
  }} /><Toasts /></>;
  if (!home) return <><div className="empty">Loading…</div><Toasts /></>;
  return <>
    {route
      ? <TableView key={route} id={route} home={home} reloadHome={loadHome} onBack={() => { open(null); loadHome(); }} />
      : <HomeView home={home} reload={loadHome} open={open} theme={theme} setTheme={setTheme} onUser={u => { setAuth({ user: u, setup: false }); useUser(u); }} />}
    <Toasts />
  </>;
}
