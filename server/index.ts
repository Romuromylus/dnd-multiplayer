import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { encrypt } from './crypto.ts';
import { db } from './db.ts';
import { api } from './routes.ts';
import { resumeArt } from './art.ts';
import { createUser, findUser, userCount } from './auth.ts';
import { now } from './util.ts';

// Default connections from the environment on first boot, so a fresh container can play before anything is set up.
function seedConnections() {
  const count = (db.prepare('select count(*) n from connections').get() as { n: number }).n;
  if (count) return;
  for (const role of ['writer', 'records', 'images'] as const) {
    const s = config.seed[role];
    if (!s.endpoint) continue;
    db.prepare(`insert into connections(name, api_type, endpoint, api_key_enc, key_last4, model, thinking_level, show_thinking, max_tokens, post_processing, caching, default_role, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, 1, ?, 'none', 1, ?, ?, ?)`)
      .run(s.name, s.apiType, s.endpoint, s.key ? encrypt(s.key) : null, s.key ? s.key.slice(-4) : null, s.model, s.thinking, role === 'writer' ? 32000 : 16000, role, now(), now());
    console.log(`[table] seeded ${role} connection: ${s.model}`);
  }
}
seedConnections();

// The first account from the environment, when there is none yet (otherwise the first person to sign up is the admin).
if (!userCount() && config.admin.user && config.admin.password && !findUser(config.admin.user)) {
  createUser(config.admin.user, config.admin.password, 'admin');
  console.log(`[table] admin account made: ${config.admin.user}`);
}

// Art that was mid-generation when the server stopped goes back in the queue.
resumeArt();

// Daily backup of the database (SQLite online backup), keeping the newest N.
async function backup() {
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `table-${new Date().toISOString().slice(0, 10)}.db`);
  if (!fs.existsSync(file)) {
    await db.backup(file);
    console.log(`[table] backup written: ${file}`);
  }
  const files = fs.readdirSync(dir).filter(f => /^table-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - config.backupKeep))) fs.unlinkSync(path.join(dir, f));
}
setTimeout(() => backup().catch(e => console.error('[table] backup failed', e)), 60_000);
setInterval(() => backup().catch(e => console.error('[table] backup failed', e)), 6 * 60 * 60 * 1000);

const app = new Hono();
app.get('/healthz', c => c.json({ ok: true }));
app.route('/api', api);

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../web/dist');
if (fs.existsSync(dist)) {
  const rel = path.relative(process.cwd(), dist) || '.';
  app.use('/assets/*', serveStatic({ root: rel, onFound: (_p, c) => { c.header('cache-control', 'public, max-age=31536000, immutable'); } }));
  // index.html names the hashed bundles, so it must be revalidated after every deploy.
  app.use('/*', serveStatic({ root: rel, onFound: (_p, c) => { c.header('cache-control', 'no-cache'); } }));
  // Read each time (it is tiny), so a new build is picked up without a restart.
  app.get('*', c => { c.header('cache-control', 'no-cache'); return c.html(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')); });
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, info => {
  console.log(`[table] listening on http://${config.host}:${info.port} (data: ${config.dataDir})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { try { db.close(); } catch {} process.exit(0); });
