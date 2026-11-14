// Pictures for a campaign: a portrait for each person with a card, and a painting of a scene when it opens (by hand, or on
// its own when the campaign asks for it). Images come from the connection whose default role is "images" (any
// OpenAI-compatible image endpoint) and are kept in the data volume. A small queue works through them, apart from the turns,
// so writing never waits on a picture. Players' characters have their portraits in their library (personas.avatar).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { db } from './db.ts';
import { openaiBase, type Conn } from './llm.ts';
import * as R from './records.ts';
import type { StorySettings } from './rules.ts';
import { clip, normName, now, parseJson, sleep } from './util.ts';

export type Asset = { id: number; story_id: number; key: string; kind: string; prompt: string; file: string | null; status: string; error: string | null; updated_at: string; refs: string };

export const ART_STYLES: Record<string, string> = {
  painterly: 'Fantasy digital painting in the style of classic tabletop roleplaying art, painterly brushwork, dramatic lighting, rich color',
  anime: 'Anime fantasy illustration, clean line art, cel shading, vibrant colors',
  realistic: 'Realistic fantasy concept art, cinematic lighting, detailed textures',
  comic: 'Fantasy comic book art, bold inks, flat bright colors',
};

export function imageConn(): Conn | null {
  const r = db.prepare(`select * from connections where default_role = 'images' order by id limit 1`).get();
  return r ? R.rowToConn(r) : null;
}

const storyDir = (storyId: number) => path.join(config.dataDir, 'images', String(storyId));
export const assetPath = (a: Asset) => path.join(storyDir(a.story_id), a.file ?? '');
export const deleteStoryImages = (storyId: number) => fs.rmSync(storyDir(storyId), { recursive: true, force: true });

// Smaller copies of a picture, made the first time one is asked for and kept beside it.
export const ART_WIDTHS = [256, 512, 768, 1536];
let sharpLib: any;
const making = new Map<string, Promise<string | null>>();
export function sizedFile(file: string, w: number): Promise<string | null> {
  const out = `${file}.w${w}.webp`;
  try { if (fs.statSync(out).mtimeMs >= fs.statSync(file).mtimeMs) return Promise.resolve(out); } catch { /* not made yet */ }
  let p = making.get(out);
  if (!p) {
    p = (async () => {
      try {
        sharpLib ??= (await import('sharp')).default;
        const tmp = `${out}.${process.pid}.tmp`;
        await sharpLib(file).resize({ width: w, withoutEnlargement: true }).webp({ quality: 84, smartSubsample: true }).toFile(tmp);
        fs.renameSync(tmp, out);
        return out;
      } catch (e: any) {
        console.error('[art] smaller copy:', e?.message ?? e);
        return null;
      }
    })().finally(() => making.delete(out));
    making.set(out, p);
  }
  return p;
}
const removeFile = (file: string) => { for (const f of [file, ...ART_WIDTHS.map(w => `${file}.w${w}.webp`)]) fs.rmSync(f, { force: true }); };

export const listAssets = (storyId: number) => db.prepare('select * from assets where story_id = ? order by id').all(storyId) as Asset[];
export const getAsset = (id: number) => db.prepare('select * from assets where id = ?').get(id) as Asset | undefined;

const SHOWN: Record<string, number> = { portrait: 512, scene: 1536 };
// What the client needs: each key's picture url (once made) and status.
export function artMap(storyId: number): Record<string, { url: string | null; full?: string; status: string; error?: string; id: number }> {
  const out: Record<string, any> = {};
  for (const a of listAssets(storyId)) {
    const v = a.file ? `?v=${encodeURIComponent(a.updated_at)}` : '';
    out[a.key] = { id: a.id, url: a.file ? `/api/art/${a.id}${v}${v ? '&' : '?'}w=${SHOWN[a.kind] ?? 768}` : null, full: a.file ? `/api/art/${a.id}${v}` : undefined, status: a.status, ...(a.error ? { error: a.error } : {}) };
  }
  return out;
}

export function enqueueArt(storyId: number, items: { key: string; kind: string; prompt: string; refs?: string[] }[]) {
  const ins = db.prepare(`insert into assets(story_id, key, kind, prompt, refs, status, created_at, updated_at) values (?, ?, ?, ?, ?, 'pending', ?, ?) on conflict(story_id, key) do nothing`);
  for (const it of items) ins.run(storyId, it.key, it.kind, it.prompt, JSON.stringify(it.refs ?? []), now(), now());
  pump();
}

export function redoAsset(a: Asset, prompt?: string) {
  if (a.file) removeFile(assetPath(a));
  db.prepare(`update assets set status = 'pending', file = null, error = null, prompt = ?, updated_at = ? where id = ?`).run(prompt?.trim() || a.prompt, now(), a.id);
  pump();
}
export function deleteAsset(a: Asset) {
  if (a.file) removeFile(assetPath(a));
  db.prepare('delete from assets where id = ?').run(a.id);
}

let running = 0;
const MAX_PARALLEL = 2;
const RETRIES = 2;
const RETRY_MS = 30_000;
const tries = new Map<number, number>();
export const noCredits = (msg: string) => /^(401|402|403)\b|insufficient|balance|credits?\b|quota|payment|billing/i.test(msg);

// Told when a picture is finished (or has failed), so the table can show it at once.
export const artWatchers = new Set<(storyId: number) => void>();

export function pump() {
  if (!imageConn()) return;
  while (running < MAX_PARALLEL) {
    const a = db.prepare(`select * from assets where status = 'pending' order by case kind when 'portrait' then 0 else 1 end, id limit 1`).get() as Asset | undefined;
    if (!a) return;
    db.prepare(`update assets set status = 'working', updated_at = ? where id = ?`).run(now(), a.id);
    running++;
    makeAsset(a)
      .then(file => { tries.delete(a.id); if (file) db.prepare(`update assets set status = 'done', file = ?, error = null, updated_at = ? where id = ?`).run(file, now(), a.id); })
      .catch(e => {
        console.error(`[art] ${a.key}:`, e?.message ?? e);
        const n = (tries.get(a.id) ?? 0) + 1;
        if (n <= RETRIES && !noCredits(String(e?.message ?? e))) {
          tries.set(a.id, n);
          setTimeout(() => { db.prepare(`update assets set status = 'pending' where id = ? and status = 'working'`).run(a.id); pump(); }, RETRY_MS * n);
          return;
        }
        tries.delete(a.id);
        db.prepare(`update assets set status = 'error', error = ?, updated_at = ? where id = ?`).run(clip(String(e?.message ?? e), 300), now(), a.id);
      })
      .finally(() => { running--; for (const w of artWatchers) { try { w(a.story_id); } catch { /* */ } } pump(); });
  }
}

export function resumeArt() {
  db.prepare(`update assets set status = 'pending' where status = 'working'`).run();
  pump();
}

const SAME_PEOPLE = 'The attached images show the people in this picture. Draw them as those exact characters, with the same faces, hair, outfits, colours and art style, in the new pose and setting asked for below. Do not copy the backgrounds of the attached images. Make the picture a wide landscape, wider than it is tall.';

// The pictures a scene is drawn from: the players' characters' portraits and the people's.
function refImages(a: Asset): { buf: Buffer; ext: string }[] {
  const out: { buf: Buffer; ext: string }[] = [];
  for (const k of parseJson<string[]>(a.refs, [])) {
    const av = k.match(/^avatar:(\d+)$/);
    if (av) {
      const data = R.getPersona(Number(av[1]))?.avatar?.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
      if (data) out.push({ buf: Buffer.from(data[2], 'base64'), ext: data[1] === 'jpeg' ? 'jpg' : data[1] });
      continue;
    }
    const x = db.prepare(`select * from assets where story_id = ? and key = ? and status = 'done'`).get(a.story_id, k) as Asset | undefined;
    if (x?.file) { try { out.push({ buf: fs.readFileSync(assetPath(x)), ext: x.file.split('.').pop()! }); } catch { /* gone */ } }
  }
  return out.slice(0, 4);
}

async function makeAsset(a: Asset): Promise<string> {
  const conn = imageConn();
  if (!conn) throw new Error('No image connection.');
  const refs = a.kind === 'scene' ? refImages(a) : [];
  const size = a.kind === 'scene' ? '1536x1024' : '1024x1024';
  const img = refs.length
    ? await generateImage(conn, `${SAME_PEOPLE} ${a.prompt}`, size, refs).catch(e => { console.error(`[art] ${a.key} with references:`, e?.message ?? e); return generateImage(conn, a.prompt, size); })
    : await generateImage(conn, a.prompt, size);
  if (!getAsset(a.id)) return '';
  fs.mkdirSync(storyDir(a.story_id), { recursive: true });
  const file = `${a.id}-${Date.now().toString(36)}.${img.ext}`;
  fs.writeFileSync(path.join(storyDir(a.story_id), file), img.buf);
  return file;
}

function sniff(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return 'png';
}

async function download(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`image download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, ext: sniff(buf) };
}

// The image in a reply: b64_json or a url (images API), or a data URI or link in a chat reply.
async function imageFrom(text: string): Promise<{ buf: Buffer; ext: string } | null> {
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  const b64 = j?.data?.[0]?.b64_json;
  if (b64) { const buf = Buffer.from(b64, 'base64'); return { buf, ext: sniff(buf) }; }
  const msg = j?.choices?.[0]?.message?.content;
  const content = typeof msg === 'string' ? msg : Array.isArray(msg) ? msg.map((p: any) => p?.image_url?.url ?? p?.text ?? '').join('\n') : '';
  const hay = [content, text.replace(/\\\//g, '/')].join('\n');
  const data = hay.match(/data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)/);
  if (data) { const buf = Buffer.from(data[2], 'base64'); return { buf, ext: sniff(buf) }; }
  const url = j?.data?.[0]?.url ?? hay.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/)?.[1] ?? hay.match(/https?:\/\/[^\s"'<>)\]\\]+\.(?:png|jpe?g|webp)(?:\?[^\s"'<>)\]\\]*)?/i)?.[0];
  return url ? download(url.replace(/\\u0026/g, '&')) : null;
}

const chatModels = new Set<string>();

// The images API first, then a chat completion (proxies such as LinkAPI serve image models through either). Reference images
// only go through chat.
export async function generateImage(conn: Conn, prompt: string, size = '1024x1024', refs: { buf: Buffer; ext: string }[] = []): Promise<{ buf: Buffer; ext: string }> {
  const base = openaiBase(conn.endpoint);
  const headers = { authorization: `Bearer ${conn.api_key}`, 'content-type': 'application/json' };
  const images = { url: `${base}/images/generations`, body: { model: conn.model, prompt, n: 1, size } };
  const content = refs.length ? [{ type: 'text', text: prompt }, ...refs.map(ref => ({ type: 'image_url', image_url: { url: `data:image/${ref.ext === 'jpg' ? 'jpeg' : ref.ext};base64,${ref.buf.toString('base64')}` } }))] : prompt;
  const chat = { url: `${base}/chat/completions`, body: { model: conn.model, size, messages: [{ role: 'user', content }] } };
  const order = refs.length ? [chat] : chatModels.has(conn.model) || /gemini/i.test(conn.model) ? [chat, images] : [images, chat];
  let last = '';
  for (const t of order) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(4000 * 2 ** attempt);
      let res: Response;
      try { res = await fetch(t.url, { method: 'POST', headers, body: JSON.stringify(t.body), signal: AbortSignal.timeout(300_000) }); }
      catch (e: any) { last = e?.message ?? String(e); continue; }
      const text = await res.text();
      if (!res.ok) {
        last = `${res.status} ${clip(text, 300)}`;
        if ((res.status === 429 || res.status >= 500) && !/not supported|only imagen/i.test(text)) continue;
        break;
      }
      const img = await imageFrom(text);
      if (img) {
        if (t === chat) chatModels.add(conn.model); else chatModels.delete(conn.model);
        return img;
      }
      last = `no image in the reply: ${clip(text, 200)}`;
      break;
    }
  }
  throw new Error(last || 'image generation failed');
}

// ---------------------------------------------------------------- prompts

export const styleOf = (s: StorySettings | string) => ART_STYLES[typeof s === 'string' ? s : s.art_style] ?? ART_STYLES.painterly;
const LOOK_ONLY = 'Draw how they look, standing at ease: leave out any pose, seat, place, action or thing held in the hands that the description mentions, though clothes, armor and gear worn on the body stay.';

export const portraitKey = (name: string) => `portrait:${normName(name)}`;
export const sceneKey = (passageId: number) => `scene:${passageId}`;

export function portraitPrompt(style: string, name: string, role: string, look: string) {
  return `${styleOf(style)}. Character portrait of ${name}${role ? `, ${role}` : ''}. ${look} ${LOOK_ONLY} Head and shoulders, facing the viewer, expressive face, simple softly lit background. No text, no lettering, no frame.`;
}

// A portrait for each person with a card, once their card says how they look.
export function enqueuePortraits(storyId: number) {
  const story = R.getStory(storyId);
  if (!story || !imageConn()) return;
  const have = new Set(listAssets(storyId).map(a => a.key));
  const items = R.listCards(storyId).filter(c => c.fields?.appearance && !have.has(portraitKey(c.name)))
    .map(c => ({ key: portraitKey(c.name), kind: 'portrait', prompt: portraitPrompt(story.settings.art_style, c.name, c.fields.role_age ?? '', clip(c.fields.appearance, 900)) }));
  if (items.length) enqueueArt(storyId, items);
}

// A painting of where a passage ends up and who is there, drawn with the people's own portraits as references.
export function enqueueSceneArt(story: R.Story, passageId: number, redo = false) {
  if (!imageConn()) return false;
  const p = R.getPassage(passageId);
  if (!p || p.story_id !== story.id || p.kind !== 'prose') return false;
  const sc = p.scene_id ? db.prepare('select * from scenes where id = ?').get(p.scene_id) as any : null;
  const state = R.getSceneState(story.id);
  const party = R.party(story.id).filter(m => m.status === 'active');
  const people = [
    ...party.map(m => `${m.name}: ${clip(m.card?.fields?.look || R.getPersona(m.personaId)?.look || '', 260)}`),
    ...state.present.slice(0, 4).map(x => { const c = R.findCard(story.id, x.name); return `${x.name}${c?.fields?.appearance ? `: ${clip(c.fields.appearance, 200)}` : ''}`; }),
  ].filter(Boolean);
  const moment = clip(p.text.replace(/<roll>[^<]*<\/roll>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(-900), 900);
  const prompt = `${styleOf(story.settings)}. A wide illustration of a scene from a fantasy adventure. The place: ${sc?.place || state.place || 'where the story stands'}${sc?.story_time || state.story_time ? `, ${sc?.story_time || state.story_time}` : ''}${sc?.weather || state.weather ? `, ${sc?.weather || state.weather}` : ''}. The moment: ${moment} The people in it: ${people.join('; ') || 'nobody in particular'}. Draw the moment as the text gives it. No text, no lettering, no speech bubbles, no frame.`;
  const refs = [...party.filter(m => R.getPersona(m.personaId)?.avatar).map(m => `avatar:${m.personaId}`), ...state.present.map(x => portraitKey(x.name))];
  const key = sceneKey(passageId);
  const old = db.prepare('select * from assets where story_id = ? and key = ?').get(story.id, key) as Asset | undefined;
  if (old) { if (redo || old.status === 'error') { db.prepare('update assets set refs = ? where id = ?').run(JSON.stringify(refs), old.id); redoAsset(old, prompt); } return true; }
  enqueueArt(story.id, [{ key, kind: 'scene', prompt, refs }]);
  return true;
}
