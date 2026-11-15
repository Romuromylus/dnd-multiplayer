export type User = { id: number; username: string; display_name: string; role: 'admin' | 'player'; prefs: Record<string, any> };
export type FieldDef = { key: string; label: string; desc: string; short?: boolean; group?: string };
export type Pick = { key: string; label: string; default: string; hint?: string; options: { value: string; label: string; hint?: string }[] };
export type Toggle = { key: string; label: string; default: boolean; group: string; hint: string };
export type Opt = { label: string; default: string; hint?: string; options: { value: string; label: string }[] };
export type Schema = { picks: Pick[]; toggles: Toggle[]; inkwell: Record<string, Opt>; table: Record<string, Opt>; sheet: FieldDef[]; npc: FieldDef[]; defaultTemplate: string };
export type Srd = { species: string[]; classes: string[]; backgrounds: string[]; subclasses: Record<string, string[]> };
export type Persona = { id: number; user_id: number; name: string; description: string; look: string; sheet: string; build?: string; avatar: string | null; updated_at: string };
export type World = { id: number; user_id: number; name: string; text: string; owner?: string };
export type CampaignItem = { id: number; title: string; host_user_id: number; host: string; archived: number; updated_at: string; seats: number; passages: number; my_persona: number | null; seated: number };
export type Connection = {
  id: number; name: string; api_type: 'anthropic' | 'openai'; endpoint: string; has_key: boolean; key_last4: string | null; model: string;
  thinking_level: string; show_thinking: boolean; max_tokens: number; post_processing: string; caching: boolean; default_role: string;
};
export type Home = { user: User; campaigns: CampaignItem[]; characters: Persona[]; worlds: World[]; schema: Schema; srd: Srd; imageConn: boolean; hasWriter: boolean };

export type Settings = Record<string, any> & { toggles: Record<string, boolean> };
export type Story = { id: number; title: string; host_user_id: number; invite_code: string; bible: string; settings: Settings; summary_template: string; writer_conn_id: number | null; records_conn_id: number | null; archived: number };
export type Chapter = { id: number; number: number; title: string; status: string; summary: string; summary_status: string; arc_id: number | null };
export type Change = { id: number; record: string; op: string; summary: string; undone: number };
export type InlineCard = { type: 'scene' | 'npc' | 'user'; op: string; name: string; fields: Record<string, any>; what_changed: string };
export type Problem = { type: string; quote: string; problem: string; record: string };
export type Passage = {
  id: number; chapter_id: number; scene_id: number | null; seq: number; kind: string; text: string; cut: number;
  records_status: string; turn_id: number | null; created_at: string;
  turn?: { id: number; kind: string; plan?: string; tools?: { name: string; input: any; result: string; who: string }[]; usage: any; model: string; check: Problem[] | null; thinking?: string; dice?: string } | null;
  changes?: Change[]; cards?: InlineCard[]; versions?: number;
};
export type Seat = {
  user_id: number; player: string; username: string; status: 'active' | 'away'; host: boolean; persona_id: number | null; name: string; avatar: string | null;
  sheet: { id: number; fields: Record<string, string>; color: string } | null; levelUp: boolean;
  action: { ready: boolean; text: string; drafting: boolean; updated_at: string } | null;
};
export type ChatLine = { id: number; user_id: number; who: string; text: string; created_at: string };
export type ArtRef = { id?: number; url: string | null; full?: string; status: string; error: string | null };
export type Detail = {
  story: Story; host: boolean; me: number; begun: boolean; gameOver: GameOver | null; chapters: Chapter[]; openChapterId: number; passages: Passage[]; scenes: Record<number, any>;
  scene: { place: string; story_time: string; weather: string; initiative: string; present: { name: string; doing?: string; condition?: string }[] };
  table: Seat[]; online: number[]; myAction: { text: string; ready: boolean } | null;
  job: { id: string; kind: string; label: string } | null;
  conns: { writer: { id: number; name: string; model: string } | null; records: { id: number; name: string; model: string } | null };
  art: Record<string, ArtRef>; imageConn: boolean; chat: ChatLine[];
};

export class NetError extends Error {}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function api<T = any>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  let r: Response;
  for (let n = 0; ; n++) {
    try {
      r = await fetch(`/api${path}`, {
        method, credentials: 'same-origin',
        headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      break;
    } catch {
      // A phone coming back from sleep often has no network for a moment. Reading is safe to ask again.
      if (method === 'GET' && n < 3) { await pause(700 * (n + 1)); continue; }
      throw new NetError("Can't reach the server. Check the connection and try again.");
    }
  }
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/auth/')) { window.dispatchEvent(new Event('signed-out')); }
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j as T;
}

// The signed-in player's preferences (reader colors, the narrator), kept on the server so phone and desktop match.
let prefsNow: Record<string, any> = {};
let prefsTimer = 0;
export const setKnownPrefs = (p: Record<string, any>) => { prefsNow = { ...p }; };
export const knownPrefs = () => prefsNow;
export function savePrefs(key: string, value: any) {
  prefsNow = { ...prefsNow, [key]: value };
  clearTimeout(prefsTimer);
  prefsTimer = window.setTimeout(() => { api('/me', { method: 'PUT', body: { prefs: prefsNow } }).catch(() => { /* kept on this page until the next save */ }); }, 600);
}

export const JOB_EVENTS = ['start', 'phase', 'tool', 'thinking', 'text', 'text_reset', 'plan', 'passage', 'removed', 'check', 'changes', 'notice', 'error', 'usage',
  'summary_start', 'summary', 'chapter_closed', 'arc', 'fix_start', 'fixed', 'assist', 'end'] as const;

// Follow a server-side job over SSE. The job runs on the server whether or not anyone is listening, so a dropped connection
// (the phone slept, the tab sat in the background) is opened again from the last event seen, for as long as the server knows the job.
export function followJob(jobId: string, on: (type: string, data: any) => void, onGone: (msg: string) => void): () => void {
  let es: EventSource | null = null;
  let last = -1, ended = false, fails = 0, heard = Date.now(), timer = 0, watch = 0, hiddenAt = 0, gen = 0;
  let phase: any = null, away = false;
  const close = () => { if (es) { es.onerror = null; es.close(); es = null; } };
  const stop = () => {
    ended = true; close(); clearTimeout(timer); clearInterval(watch);
    document.removeEventListener('visibilitychange', vis); window.removeEventListener('online', again); window.removeEventListener('pageshow', again);
  };
  const back = () => { fails = 0; if (away) { away = false; on('phase', phase ?? { label: '' }); } };
  const open = () => {
    if (ended) return;
    close(); clearTimeout(timer);
    gen++; heard = Date.now();
    const src = es = new EventSource(`/api/jobs/${jobId}/events?from=${last + 1}`);
    src.onopen = () => { if (es === src) back(); };
    src.addEventListener('ping', (e: MessageEvent) => {
      if (es !== src) return;
      heard = Date.now();
      // An event held back from this viewer still moves the count on.
      const id = e.lastEventId === '' ? NaN : Number(e.lastEventId);
      if (Number.isFinite(id) && id > last) last = id;
    });
    for (const t of JOB_EVENTS) src.addEventListener(t, (e: MessageEvent) => {
      if (es !== src || ended || !(e instanceof MessageEvent)) return;
      heard = Date.now();
      const id = e.lastEventId === '' ? NaN : Number(e.lastEventId);
      if (Number.isFinite(id)) { if (id <= last) return; last = id; }
      back();
      let data: any = {};
      try { data = JSON.parse(e.data); } catch { /* ignore */ }
      if (t === 'phase') phase = data;
      if (t === 'end') stop();
      on(t, data);
    });
    src.onerror = () => { if (es === src && !ended) retry(); };
  };
  const retry = async () => {
    close(); clearTimeout(timer);
    const mine = ++gen;
    fails++;
    try {
      const r = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
      if (ended || mine !== gen) return;
      if (r.status === 404) { stop(); onGone('That work is no longer on the server: it finished a while ago, or the server restarted.'); return; }
    } catch { /* no network yet */ }
    if (ended || mine !== gen) return;
    if (fails >= 3 && !away) { away = true; on('phase', { label: 'Reconnecting' }); }
    timer = window.setTimeout(open, Math.min(5000, 400 * 2 ** Math.min(fails, 4)));
  };
  const again = () => { if (!ended) { fails = 0; open(); } };
  const vis = () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 2000) again();
    hiddenAt = 0;
  };
  document.addEventListener('visibilitychange', vis);
  window.addEventListener('online', again);
  window.addEventListener('pageshow', again);
  watch = window.setInterval(() => { if (!ended && document.visibilityState === 'visible' && Date.now() - heard > 30000) open(); }, 5000);
  open();
  return stop;
}

// Wait for a helper job (writing with AI, building a sheet, a portrait) and hand back its result.
export function jobResult<T = any>(jobId: string, onText?: (text: string) => void, onPhase?: (label: string) => void): { done: Promise<T>; stop: () => void } {
  let stopFollow = () => {};
  let text = '';
  const done = new Promise<T>((resolve, reject) => {
    let result: any = null, error = '';
    stopFollow = followJob(jobId, (t, d) => {
      if (t === 'text') { text += d.delta; onText?.(text); }
      if (t === 'phase') onPhase?.(d.label);
      if (t === 'assist') result = d;
      if (t === 'error') error = d.message;
      if (t === 'end') {
        if (result) resolve(result);
        else reject(new Error(error || (d.status === 'stopped' ? 'Stopped.' : 'Nothing came back. Try again.')));
      }
    }, msg => reject(new Error(msg)));
  });
  return { done, stop: () => { stopFollow(); api(`/jobs/${jobId}/stop`, { body: {} }).catch(() => {}); } };
}

// The table's live line: who is here, who is ready, chat, and when the Dungeon Master starts and stops writing.
export function followLive(storyId: number, on: (type: string, data: any) => void): () => void {
  let es: EventSource | null = null, ended = false, timer = 0, heard = Date.now();
  const types = ['presence', 'seats', 'actions', 'chat', 'job', 'job_end', 'refresh', 'art', 'deleted'];
  const open = () => {
    if (ended) return;
    es?.close();
    heard = Date.now();
    const src = es = new EventSource(`/api/stories/${storyId}/live`);
    src.addEventListener('ping', () => { heard = Date.now(); });
    for (const t of types) src.addEventListener(t, (e: MessageEvent) => {
      if (es !== src) return;
      heard = Date.now();
      let d: any = {};
      try { d = JSON.parse(e.data); } catch { /* ignore */ }
      on(t, d);
    });
    src.onopen = () => { if (es === src) on('reconnected', {}); };
    src.onerror = () => { if (es !== src || ended) return; src.close(); es = null; clearTimeout(timer); timer = window.setTimeout(open, 2500); };
  };
  const watch = window.setInterval(() => { if (!ended && document.visibilityState === 'visible' && Date.now() - heard > 40000) open(); }, 8000);
  const vis = () => { if (document.visibilityState === 'visible' && Date.now() - heard > 20000) open(); };
  document.addEventListener('visibilitychange', vis);
  open();
  return () => { ended = true; es?.close(); clearTimeout(timer); clearInterval(watch); document.removeEventListener('visibilitychange', vis); };
}

export function fmtTokens(n: number | undefined) {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}
export function usageLine(u: any) {
  if (!u || !(u.input || u.output)) return '';
  const inp = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return `${fmtTokens(inp)} in${u.cacheRead ? ` (${fmtTokens(u.cacheRead)} cached)` : ''} · ${fmtTokens(u.output)} out`;
}

export const portraitKey = (name: string) => `portrait:${name.trim().toLowerCase().replace(/\s+/g, ' ')}`;
export const sheetOf = (p: Persona): Record<string, string> => { try { return JSON.parse(p.sheet || '{}'); } catch { return {}; } };
// A sheet is built once it has more than the look (which the character's own Look field also fills).
export const sheetBuilt = (s: Record<string, string>) => Object.entries(s).some(([k, v]) => k !== 'look' && k !== 'look_now' && String(v ?? '').trim());
export const hasSheet = (p: Persona) => sheetBuilt(sheetOf(p));
// The whole party down at once: who, and in what state, and whether there is a fight to go back to the start of.
export type GameOver = { party: { name: string; state: 'dying' | 'stable' | 'dead' }[]; fight: boolean };

export const buildOf =(p: Persona | null): Record<string, any> => { try { return JSON.parse(p?.build || '{}'); } catch { return {}; } };
// "12/30" → [12, 30]
export function hpOf(hp: string | undefined): [number, number] | null {
  const m = String(hp ?? '').match(/(-?\d+)\s*\/\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
