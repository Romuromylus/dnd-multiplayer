// Accounts: usernames and passwords (scrypt), and a session cookie per device. The first account made is the admin.
import crypto from 'node:crypto';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from './config.ts';
import { db } from './db.ts';
import { now, parseJson } from './util.ts';

export type User = { id: number; username: string; display_name: string; role: 'admin' | 'player'; prefs: Record<string, any> };

const COOKIE = 'dnd_sid';
const SESSION_DAYS = 60;

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `s1:${salt.toString('base64')}:${key.toString('base64')}`;
}
export function checkPassword(pw: string, stored: string): boolean {
  const [v, salt, key] = stored.split(':');
  if (v !== 's1' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const rowToUser = (r: any): User => ({ id: r.id, username: r.username, display_name: r.display_name || r.username, role: r.role === 'admin' ? 'admin' : 'player', prefs: parseJson(r.prefs, {}) });
export const getUser = (id: number): User | null => { const r = db.prepare('select * from users where id = ?').get(id); return r ? rowToUser(r) : null; };
export const userCount = () => (db.prepare('select count(*) n from users').get() as { n: number }).n;
export const findUser = (username: string) => db.prepare('select * from users where username = ?').get(username.trim()) as any;

export const validUsername = (u: string) => /^[A-Za-z0-9_.-]{2,32}$/.test(u);
export function createUser(username: string, password: string, role: 'admin' | 'player', display = ''): User {
  const id = db.prepare('insert into users(username, display_name, pass_hash, role, created_at, updated_at) values (?, ?, ?, ?, ?, ?)')
    .run(username.trim(), display.trim().slice(0, 40), hashPassword(password), role, now(), now()).lastInsertRowid as number;
  return getUser(id)!;
}

export function startSession(c: Context, userId: number) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('insert into auth_sessions(token_hash, user_id, created_at, seen_at) values (?, ?, ?, ?)').run(sha(token), userId, now(), now());
  const secure = !config.insecureCookies && (c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:');
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: SESSION_DAYS * 86400 });
}
export function endSession(c: Context) {
  const token = getCookie(c, COOKIE);
  if (token) db.prepare('delete from auth_sessions where token_hash = ?').run(sha(token));
  deleteCookie(c, COOKIE, { path: '/' });
}
export const endAllSessions = (userId: number) => db.prepare('delete from auth_sessions where user_id = ?').run(userId);

export function sessionUser(c: Context): User | null {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const r: any = db.prepare('select * from auth_sessions where token_hash = ?').get(sha(token));
  if (!r) return null;
  if (Date.now() - Date.parse(r.seen_at) > SESSION_DAYS * 86400_000) { db.prepare('delete from auth_sessions where token_hash = ?').run(r.token_hash); return null; }
  // Seen-at moves on at most once an hour, so reading the page doesn't write to the database on every request.
  if (Date.now() - Date.parse(r.seen_at) > 3600_000) db.prepare('update auth_sessions set seen_at = ? where token_hash = ?').run(now(), r.token_hash);
  return getUser(r.user_id);
}

export async function requireUser(c: Context, next: Next) {
  const u = sessionUser(c);
  if (!u) return c.json({ error: 'Sign in first.' }, 401);
  c.set('user' as never, u as never);
  await next();
}
export const me = (c: Context): User => c.get('user' as never) as User;

// Ten wrong passwords in fifteen minutes from one address (or for one name) wait the rest of the fifteen minutes.
const fails = new Map<string, number[]>();
export function tooManyTries(keys: string[]): boolean {
  const cut = Date.now() - 15 * 60_000;
  return keys.some(k => (fails.get(k) ?? []).filter(t => t > cut).length >= 10);
}
export function failedTry(keys: string[]) {
  const cut = Date.now() - 15 * 60_000;
  for (const k of keys) fails.set(k, [...(fails.get(k) ?? []).filter(t => t > cut), Date.now()]);
}
export const clientIp = (c: Context) => (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || c.req.header('x-real-ip') || 'local';
