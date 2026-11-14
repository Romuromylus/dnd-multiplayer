import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || './data'),
  masterKey: env.DND_MASTER_KEY || '',
  backupKeep: Number(env.DND_BACKUP_KEEP || 14),
  // Cookies get the Secure flag unless this is set (plain http on localhost).
  insecureCookies: env.DND_INSECURE_COOKIES === '1',
  // Optional first account, made on first boot when there are no users yet.
  admin: { user: env.DND_ADMIN_USER || '', password: env.DND_ADMIN_PASSWORD || '' },
  // Optional default connections, seeded once on first boot (the key is stored encrypted, then the env copy is no longer needed).
  seed: {
    writer: {
      endpoint: env.DND_WRITER_ENDPOINT || '',
      key: env.DND_WRITER_KEY || '',
      model: env.DND_WRITER_MODEL || 'claude-opus-5-5',
      thinking: env.DND_WRITER_THINKING || 'high',
      apiType: env.DND_WRITER_API_TYPE || 'anthropic',
      name: env.DND_WRITER_NAME || 'Game Master (default)',
    },
    records: {
      endpoint: env.DND_RECORDS_ENDPOINT || env.DND_WRITER_ENDPOINT || '',
      key: env.DND_RECORDS_KEY || env.DND_WRITER_KEY || '',
      model: env.DND_RECORDS_MODEL || 'claude-sonnet-5-5',
      thinking: env.DND_RECORDS_THINKING || 'medium',
      apiType: env.DND_RECORDS_API_TYPE || env.DND_WRITER_API_TYPE || 'anthropic',
      name: env.DND_RECORDS_NAME || 'Records keeper (default)',
    },
    images: {
      endpoint: env.DND_IMAGES_ENDPOINT || '',
      key: env.DND_IMAGES_KEY || '',
      model: env.DND_IMAGES_MODEL || 'gpt-image-2-c',
      thinking: 'off',
      apiType: 'openai',
      name: env.DND_IMAGES_NAME || 'Images (default)',
    },
  },
};
