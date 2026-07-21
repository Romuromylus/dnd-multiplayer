/**
 * Admin User Management Routes
 * All routes require admin.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { validate, validateBody, schemas } = require('../lib/validation');
const { invalidateCache } = require('../lib/cache');

function createAdminUserRoutes(db, auth, io, broadcast = {}) {
  const router = express.Router();
  const { requireAdmin, deleteUserSessions } = auth;
  const { emitCharacterUpdate, emitToUser } = broadcast;

  /**
   * GET /api/admin/users
   */
  router.get('/users', requireAdmin, (req, res) => {
    const users = db.prepare(`
      SELECT u.id, u.username, u.is_admin, u.created_at,
             (SELECT COUNT(*) FROM characters c WHERE c.user_id = u.id) AS character_count
      FROM users u
      ORDER BY u.is_admin DESC, u.username ASC
    `).all();
    res.json(users);
  });

  /**
   * POST /api/admin/users  { username, password, is_admin? }
   */
  router.post('/users', requireAdmin, validateBody(schemas.userCreate), (req, res) => {
    const username = validate.sanitizeString(req.body.username, 100);
    const password = validate.sanitizeString(req.body.password, 200);
    const isAdmin = req.body.is_admin ? 1 : 0;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const id = uuidv4();
    db.prepare('INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)')
      .run(id, username, bcrypt.hashSync(password, 10), isAdmin);

    const user = db.prepare('SELECT id, username, is_admin, created_at FROM users WHERE id = ?').get(id);
    res.json({ ...user, character_count: 0 });
  });

  /**
   * POST /api/admin/users/:id/password  { password }
   */
  router.post('/users/:id/password', requireAdmin, validateBody(schemas.passwordReset), (req, res) => {
    const password = validate.sanitizeString(req.body.password, 200);
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
    deleteUserSessions(req.params.id);
    res.json({ success: true });
  });

  /**
   * POST /api/admin/users/:id/admin  { is_admin: boolean }
   */
  router.post('/users/:id/admin', requireAdmin, (req, res) => {
    const { is_admin } = req.body;
    if (typeof is_admin !== 'boolean') {
      return res.status(400).json({ error: 'is_admin must be boolean' });
    }
    const user = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (req.params.id === req.user.id && !is_admin) {
      return res.status(400).json({ error: 'Cannot remove your own admin flag' });
    }

    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, req.params.id);
    res.json({ success: true });
  });

  /**
   * DELETE /api/admin/users/:id
   */
  router.delete('/users/:id', requireAdmin, (req, res) => {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.prepare('UPDATE characters SET user_id = NULL WHERE user_id = ?').run(req.params.id);
    deleteUserSessions(req.params.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    invalidateCache('characters:');
    res.json({ success: true });
  });

  /**
   * POST /api/admin/characters/:id/assign  { user_id: string|null }
   */
  router.post('/characters/:id/assign', requireAdmin, (req, res) => {
    const { user_id } = req.body;
    const character = db.prepare('SELECT id, user_id FROM characters WHERE id = ?').get(req.params.id);
    if (!character) return res.status(404).json({ error: 'Character not found' });
    const previousOwnerId = character.user_id;

    if (user_id !== null && user_id !== undefined && user_id !== '') {
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      db.prepare('UPDATE characters SET user_id = ? WHERE id = ?').run(user_id, req.params.id);
    } else {
      db.prepare('UPDATE characters SET user_id = NULL WHERE id = ?').run(req.params.id);
    }

    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    // Reach the new owner (+ its sessions + admins) via the standard resolver, and
    // additionally the previous owner so the reassigned character leaves their list.
    if (emitCharacterUpdate) emitCharacterUpdate(req.params.id, 'character_updated', updated);
    if (emitToUser && previousOwnerId != null && previousOwnerId !== updated.user_id) {
      emitToUser(previousOwnerId, 'character_updated', updated);
    }
    res.json(updated);
  });

  return router;
}

module.exports = { createAdminUserRoutes };
