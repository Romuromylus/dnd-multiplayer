// Home: your campaigns, joining one by its code, your characters, the shared worlds, and (for an admin) the server's setup.
import { useState } from 'react';
import { ago, api, hasSheet, knownPrefs, sheetOf, type Home, type Persona, type Settings, type User } from './api';
import { AiWrite, WorldShelf, WorldsModal } from './Assist';
import { CharacterModal } from './Character';
import { AccountModal, ConnectionsModal, PlayersModal } from './Admin';
import { Avatar } from './Sheet';
import { Field, Modal, Seg, Switch, toast, useAsync } from './ui';

type Dialog = null | { kind: 'char'; persona: Persona | null } | { kind: 'new' } | { kind: 'worlds' } | { kind: 'conns' } | { kind: 'players' } | { kind: 'account' };

export function HomeView(p: { home: Home; reload: () => Promise<void>; open: (id: number) => void; theme: string; setTheme: (t: string) => void; onUser: (u: User) => void }) {
  const h = p.home;
  const admin = h.user.role === 'admin';
  const [dialog, setDialog] = useState<Dialog>(null);
  const [code, setCode] = useState('');
  const [joinAs, setJoinAs] = useState<number | ''>('');
  const { busy, run } = useAsync();
  const mine = h.campaigns.filter(c => c.seated);
  const others = h.campaigns.filter(c => !c.seated);
  const join = () => run(async () => {
    const r = await api<{ id: number }>('/join', { body: { code, persona_id: joinAs || null } });
    p.open(r.id);
  });
  const close = () => setDialog(null);
  return (
    <div className="home">
      <header className="home-head">
        <div className="logo"><img src="/favicon.svg" alt="" /> The Table</div>
        <span className="grow" />
        {admin && <button className="btn sm ghost" onClick={() => setDialog({ kind: 'players' })}>Players</button>}
        {admin && <button className="btn sm ghost" onClick={() => setDialog({ kind: 'conns' })}>Connections</button>}
        <button className="btn sm" onClick={() => setDialog({ kind: 'account' })}>{h.user.display_name || h.user.username}</button>
      </header>

      {!h.hasWriter && <div className="checkbar" style={{ margin: '0 0 18px' }}>
        <h4>NO DUNGEON MASTER YET</h4>
        {admin ? <><p className="small" style={{ margin: '0 0 8px' }}>Add a connection to a model (Claude works best) and make it the Dungeon Master. A cheaper one can keep the records.</p><button className="btn sm primary" onClick={() => setDialog({ kind: 'conns' })}>Set up connections</button></>
          : <p className="small" style={{ margin: 0 }}>The server's admin hasn't set up a model yet.</p>}
      </div>}

      <section>
        <div className="row"><h2 className="grow">Campaigns</h2><button className="btn primary" onClick={() => setDialog({ kind: 'new' })}>+ New campaign</button></div>
        {mine.length === 0 && <div className="muted small">No campaigns yet. Start one and share its invite code, or join one with a code from its host.</div>}
        <div className="cards">
          {mine.map(c => {
            const ch = h.characters.find(x => x.id === c.my_persona);
            return (
              <button key={c.id} className="ccard" onClick={() => p.open(c.id)}>
                <div className="t">{c.title}</div>
                <div className="m">{c.host_user_id === h.user.id ? 'You host' : `Hosted by ${c.host}`} · {c.seats} at the table · {c.passages} round{c.passages === 1 ? '' : 's'}</div>
                <div className="m">{ch ? `You play ${ch.name}` : 'No character chosen yet'} · {ago(c.updated_at)}</div>
                {c.archived ? <span className="chip">archived</span> : null}
              </button>
            );
          })}
        </div>
        <div className="join">
          <input type="text" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Invite code" maxLength={12} autoCapitalize="characters" />
          <select value={joinAs} onChange={e => setJoinAs(e.target.value ? Number(e.target.value) : '')} aria-label="Bring a character">
            <option value="">Bring a character later</option>
            {h.characters.filter(hasSheet).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn" onClick={join} disabled={busy || code.trim().length < 4}>Join</button>
        </div>
        {admin && others.length > 0 && <>
          <div className="section-title" style={{ marginTop: 18 }}>Other campaigns on the server</div>
          <div className="cards">{others.map(c => <button key={c.id} className="ccard dim" onClick={() => p.open(c.id)}><div className="t">{c.title}</div><div className="m">Hosted by {c.host} · {c.seats} at the table · {ago(c.updated_at)}</div></button>)}</div>
        </>}
      </section>

      <section>
        <div className="row"><h2 className="grow">Your characters</h2><button className="btn" onClick={() => setDialog({ kind: 'char', persona: null })}>+ New character</button></div>
        {h.characters.length === 0 && <div className="muted small">Make a character to bring to a table: pick a species, class and background, and the AI builds the sheet.</div>}
        <div className="cards">
          {h.characters.map(c => {
            const s = sheetOf(c);
            return (
              <button key={c.id} className="ccard char" onClick={() => setDialog({ kind: 'char', persona: c })}>
                <Avatar src={c.avatar} name={c.name} size={48} />
                <div className="min0">
                  <div className="t ellipsis">{c.name}</div>
                  <div className="m ellipsis">{[s.species, s.class].filter(Boolean).join(' · ') || 'Sheet not built yet'}</div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="row"><h2 className="grow">Worlds</h2><button className="btn" onClick={() => setDialog({ kind: 'worlds' })}>Open the shelf</button></div>
        <div className="muted small">{h.worlds.length ? `${h.worlds.length} saved world${h.worlds.length > 1 ? 's' : ''}: ${h.worlds.slice(0, 4).map(w => w.name).join(', ')}${h.worlds.length > 4 ? '…' : ''}` : 'Settings kept to start campaigns from, shared by everyone on the server.'}</div>
      </section>

      {dialog?.kind === 'char' && <CharacterModal home={h} persona={dialog.persona} onClose={close} onSaved={p.reload} />}
      {dialog?.kind === 'new' && <NewCampaignModal home={h} onClose={close} reload={p.reload} onCreated={p.open} />}
      {dialog?.kind === 'worlds' && <WorldsModal worlds={h.worlds} me={h.user.id} admin={admin} ready={h.hasWriter} onClose={close} reload={p.reload} />}
      {dialog?.kind === 'conns' && <ConnectionsModal onClose={close} onChanged={p.reload} />}
      {dialog?.kind === 'players' && <PlayersModal me={h.user} onClose={close} />}
      {dialog?.kind === 'account' && <AccountModal me={h.user} theme={p.theme} setTheme={p.setTheme} onClose={close} onSaved={u => { p.onUser(u); p.reload(); }} />}
    </div>
  );
}

// The settings every campaign starts from unless its host saved their own.
export function standardSettings(h: Home): Settings {
  const s: Settings = { toggles: {} };
  for (const pk of h.schema.picks) s[pk.key] = pk.default;
  for (const t of h.schema.toggles) s.toggles[t.key] = t.default;
  for (const [k, d] of Object.entries({ ...h.schema.inkwell, ...h.schema.table })) s[k] = d.default;
  s.art_style = 'painterly';
  return s;
}
// A host's saved defaults (Campaign settings, Save as my defaults), laid over the standard ones so a setting added since still has a value.
export const savedDefaults = (h: Home): Settings | null => {
  const mine = knownPrefs().campaign_defaults ?? h.user.prefs?.campaign_defaults;
  return mine && typeof mine === 'object' ? mine : null;
};
export function defaultSettings(h: Home): Settings {
  const base = standardSettings(h), mine = savedDefaults(h);
  return mine ? { ...base, ...mine, toggles: { ...base.toggles, ...(mine.toggles ?? {}) } } : base;
}

function NewCampaignModal(p: { home: Home; onClose: () => void; reload: () => Promise<void>; onCreated: (id: number) => void }) {
  const h = p.home;
  const [title, setTitle] = useState('');
  const [bible, setBible] = useState('');
  const [persona, setPersona] = useState<number | ''>(h.characters.find(hasSheet)?.id ?? '');
  const [st, setSt] = useState<Settings>(() => defaultSettings(h));
  const [more, setMore] = useState(false);
  const { busy, run } = useAsync();
  const create = () => run(async () => {
    const r = await api<{ id: number }>('/stories', { body: { title, bible, settings: st, persona_id: persona || null } });
    await p.reload();
    toast('Campaign made. Share its invite code (the Party panel) with your players.');
    p.onCreated(r.id);
  });
  return (
    <Modal title="New campaign" wide onClose={p.onClose} foot={<>
      <span className="grow" />
      <button className="btn ghost" onClick={p.onClose}>Cancel</button>
      <button className="btn primary" onClick={create} disabled={busy || !title.trim()}>Start the campaign</button>
    </>}>
      <Field label="Title"><input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="The Ashen Coast" /></Field>
      <Field label="The world" hint="Setting, tone, factions, where it starts, house rules. Leave the players' characters out: they bring their own sheets.">
        <textarea rows={10} value={bible} onChange={e => setBible(e.target.value)} />
      </Field>
      <WorldShelf worlds={h.worlds} reload={p.reload} value={bible} onLoad={setBible} suggest={title} me={h.user.id} admin={h.user.role === 'admin'} />
      <AiWrite kind="world" value={bible} onChange={setBible} ready={h.hasWriter} what="world brief" />
      <Field label="Your character" hint="You play too. Pick none to only run the table (you can sit a character down later).">
        <select value={persona} onChange={e => setPersona(e.target.value ? Number(e.target.value) : '')}>
          <option value="">None for now</option>
          {h.characters.map(c => <option key={c.id} value={c.id} disabled={!hasSheet(c)}>{c.name}{hasSheet(c) ? '' : ' (no sheet yet)'}</option>)}
        </select>
      </Field>
      {savedDefaults(h) && <div className="ai-row">
        <span className="muted small grow">These start from your saved defaults.</span>
        <button type="button" className="btn sm ghost" onClick={() => setSt(() => standardSettings(h))}>Use the standard settings</button>
      </div>}
      <CampaignSettingsFields home={h} st={st} setSt={setSt} short={!more} />
      {!more && <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setMore(true)}>More settings…</button>}
    </Modal>
  );
}

const MAIN_PICKS = ['difficulty', 'death', 'levelling', 'reply_length', 'tone'];

// The campaign's settings: how the Dungeon Master plays, the table's rules, and the craft beneath it.
export function CampaignSettingsFields(p: { home: Home; st: Settings; setSt: (f: (s: Settings) => Settings) => void; short?: boolean }) {
  const sc = p.home.schema;
  const st = p.st;
  const set = (k: string, v: any) => p.setSt(x => ({ ...x, [k]: v }));
  const setT = (k: string, v: boolean) => p.setSt(x => ({ ...x, toggles: { ...x.toggles, [k]: v } }));
  const picks = sc.picks.filter(pk => !p.short || MAIN_PICKS.includes(pk.key));
  const groups = [...new Set(sc.toggles.map(t => t.group))];
  return <>
    <div className="section-title">The game</div>
    <div className="grid2">
      {picks.map(pk => (
        <Field key={pk.key} label={pk.label} hint={pk.options.find(o => o.value === st[pk.key])?.hint ?? pk.hint}>
          <select value={st[pk.key]} onChange={e => set(pk.key, e.target.value)}>{pk.options.map(o => <option key={o.value} value={o.value}>{o.label}{o.value === pk.default ? ' (default)' : ''}</option>)}</select>
        </Field>
      ))}
    </div>
    <div className="section-title">The table</div>
    {Object.entries(sc.table).map(([k, d]) => <Field key={k} label={d.label} hint={d.hint}><Seg value={st[k]} options={d.options} onChange={v => set(k, v)} /></Field>)}
    {st.scene_art === 'auto' && <Field label="Picture style"><Seg value={st.art_style ?? 'painterly'} options={[{ value: 'painterly', label: 'Painterly' }, { value: 'anime', label: 'Anime' }, { value: 'realistic', label: 'Realistic' }, { value: 'comic', label: 'Comic' }]} onChange={v => set('art_style', v)} /></Field>}
    {!p.short && <>
      <div className="section-title">The Dungeon Master's craft</div>
      {Object.entries(sc.inkwell).map(([k, d]) => <Field key={k} label={d.label} hint={d.hint}><Seg value={st[k]} options={d.options} onChange={v => set(k, v)} /></Field>)}
      {groups.map(g => (
        <div key={g}>
          <div className="section-title">{g === 'craft' ? 'Writing' : g === 'records' ? 'Records' : g === 'display' ? 'Display' : g}</div>
          <div className="grid2" style={{ gap: 0, columnGap: 16 }}>
            {sc.toggles.filter(t => t.group === g).map(t => <Switch key={t.key} checked={!!st.toggles[t.key]} onChange={v => setT(t.key, v)} label={t.label} hint={t.hint} />)}
          </div>
        </div>
      ))}
      <Field label="Banned words and phrases" hint="Separated by commas. The Dungeon Master is told never to use them.">
        <input type="text" value={st.banned_phrases ?? ''} onChange={e => set('banned_phrases', e.target.value)} placeholder="ozone, a beat passed" />
      </Field>
    </>}
  </>;
}

