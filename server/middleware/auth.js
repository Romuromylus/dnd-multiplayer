/**
 * Authentication Middleware
 * Cookie-based user sessions. Admin is a flag on the user row (is_admin=1).
 */

const crypto = require('crypto');

const SESSION_COOKIE = 'dnd_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // refresh when less than 7d left

function parseCookie(header, name) {
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const xfp = req.headers['x-forwarded-proto'];
  return typeof xfp === 'string' && xfp.split(',')[0].trim() === 'https';
}

function buildCookie(token, { maxAgeSeconds, secure, clear = false }) {
  const parts = [`${SESSION_COOKIE}=${clear ? '' : encodeURIComponent(token)}`];
  parts.push('Path=/');
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (clear) {
    parts.push('Max-Age=0');
  } else if (typeof maxAgeSeconds === 'number') {
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function createAuthHelpers(db) {
  function generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  function createSession(userId) {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString().replace('T', ' ').replace('Z', '');
    db.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
    return { token, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
  }

  function deleteSession(token) {
    if (!token) return;
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  }

  function deleteUserSessions(userId) {
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  }

  function loadUserByToken(token) {
    if (!token) return null;
    const row = db.prepare(`
      SELECT u.id, u.username, u.is_admin, s.token, s.expires_at
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > CURRENT_TIMESTAMP
    `).get(token);
    if (!row) return null;
    return {
      user: { id: row.id, username: row.username, is_admin: row.is_admin },
      expires_at: row.expires_at
    };
  }

  // DB-only refresh (used by both HTTP and socket paths). Returns true if refreshed.
  function maybeRefreshDb(token, expiresAt) {
    const expiresMs = new Date(expiresAt.replace(' ', 'T') + 'Z').getTime();
    if (expiresMs - Date.now() > REFRESH_THRESHOLD_MS) return false;
    const newExpires = new Date(Date.now() + SESSION_TTL_MS).toISOString().replace('T', ' ').replace('Z', '');
    db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE token = ?').run(newExpires, token);
    return true;
  }

  function maybeRefresh(token, expiresAt, req, res) {
    if (!maybeRefreshDb(token, expiresAt)) return;
    const cookie = buildCookie(token, {
      maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
      secure: isSecureRequest(req)
    });
    res.setHeader('Set-Cookie', cookie);
  }

  const requireUser = (req, res, next) => {
    const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
    const loaded = loadUserByToken(token);
    if (!loaded) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = loaded.user;
    req.sessionToken = token;
    maybeRefresh(token, loaded.expires_at, req, res);
    next();
  };

  const requireAdmin = (req, res, next) => {
    requireUser(req, res, (err) => {
      if (err) return next(err);
      if (!req.user || !req.user.is_admin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      next();
    });
  };

  return {
    requireUser,
    requireAdmin,
    createSession,
    deleteSession,
    deleteUserSessions,
    loadUserByToken,
    maybeRefreshDb,
    buildCookie,
    isSecureRequest,
    parseCookie,
    SESSION_COOKIE,
    SESSION_TTL_MS
  };
}

module.exports = { createAuthHelpers, parseCookie, SESSION_COOKIE };
