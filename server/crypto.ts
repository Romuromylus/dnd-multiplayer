import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

// API keys are encrypted at rest with AES-256-GCM. The master key comes from DND_MASTER_KEY;
// without it, a random key is generated once and kept next to the database.
function loadMasterKey(): Buffer {
  let secret = config.masterKey;
  if (!secret) {
    const file = path.join(config.dataDir, '.master_key');
    if (fs.existsSync(file)) secret = fs.readFileSync(file, 'utf8').trim();
    else {
      fs.mkdirSync(config.dataDir, { recursive: true });
      secret = crypto.randomBytes(32).toString('base64');
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  return crypto.createHash('sha256').update(secret).digest();
}

const KEY = loadMasterKey();

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(blob: string | null | undefined): string {
  if (!blob) return '';
  const [v, iv, tag, data] = blob.split(':');
  if (v !== 'v1') return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}
