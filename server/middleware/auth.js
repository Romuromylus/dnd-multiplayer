/**
 * Authentication Middleware
 * Handles game password and admin password verification
 */

const bcrypt = require('bcryptjs');

/**
 * Create authentication middleware with database dependency
 * @param {Object} db - Database instance
 * @returns {Object} Middleware functions
 */
function createAuthMiddleware(db) {
  function getSettingHash(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value || null;
  }

  function verifyGamePassword(password) {
    const storedHash = getSettingHash('game_password');
    if (!storedHash || !password) return false;
    return bcrypt.compareSync(password, storedHash);
  }

  /**
   * Check game password
   */
  const checkPassword = (req, res, next) => {
    const gamePwd = req.headers['x-game-password'];
    if (!verifyGamePassword(gamePwd)) {
      return res.status(401).json({ error: 'Game authentication required' });
    }
    next();
  };

  /**
   * Check admin password (requires game password first)
   */
  const checkAdminPassword = (req, res, next) => {
    const gamePwd = req.headers['x-game-password'];
    if (!verifyGamePassword(gamePwd)) {
      return res.status(401).json({ error: 'Game authentication required' });
    }

    const adminPwd = req.headers['x-admin-password'];
    const storedHash = getSettingHash('admin_password');

    if (!storedHash || !bcrypt.compareSync(adminPwd || '', storedHash)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  };

  return {
    checkPassword,
    checkAdminPassword,
    verifyGamePassword
  };
}

module.exports = { createAuthMiddleware };
