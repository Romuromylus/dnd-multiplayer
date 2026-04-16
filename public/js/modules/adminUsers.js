// ============================================
// Admin Users Module
// User management UI + character ownership assignment
// ============================================

import { getState, setState } from '../state.js';
import { api } from '../api.js';
import { escapeHtml } from '../utils/formatters.js';
import { showNotification } from '../utils/dom.js';

export async function loadUsers() {
  const user = getState('currentUser');
  if (!user || !user.is_admin) return;

  try {
    const users = await api('/api/admin/users');
    setState({ users });
    renderUsers(users);

    // Re-render character cards so owner dropdowns populate
    const { renderCharactersList } = await import('./characters.js');
    renderCharactersList();
  } catch (e) {
    console.error('Failed to load users:', e);
  }
}

function renderUsers(users) {
  const container = document.getElementById('users-list');
  if (!container) return;
  const currentUser = getState('currentUser');

  if (!users || users.length === 0) {
    container.innerHTML = '<p class="settings-note">No users yet.</p>';
    return;
  }

  container.innerHTML = `
    <table class="users-table" style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="text-align:left;padding:0.4em;">Username</th>
          <th style="text-align:center;padding:0.4em;">Admin</th>
          <th style="text-align:center;padding:0.4em;">Characters</th>
          <th style="text-align:right;padding:0.4em;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${users.map(u => {
          const isSelf = u.id === currentUser.id;
          return `
          <tr data-user-id="${u.id}">
            <td style="padding:0.4em;">${escapeHtml(u.username)}</td>
            <td style="padding:0.4em;text-align:center;">
              <input type="checkbox" ${u.is_admin ? 'checked' : ''} ${isSelf ? 'disabled' : ''} onchange="toggleUserAdmin('${u.id}', this.checked)">
            </td>
            <td style="padding:0.4em;text-align:center;">${u.character_count || 0}</td>
            <td style="padding:0.4em;text-align:right;">
              <button class="btn-secondary" onclick="resetUserPassword('${u.id}', '${escapeHtml(u.username).replace(/'/g, '&apos;')}')">Reset Password</button>
              ${isSelf ? '' : `<button class="btn-secondary" onclick="deleteUser('${u.id}', '${escapeHtml(u.username).replace(/'/g, '&apos;')}')">Delete</button>`}
            </td>
          </tr>
        `;}).join('')}
      </tbody>
    </table>
  `;
}

export async function createUserSubmit() {
  const username = document.getElementById('new-user-username').value.trim();
  const password = document.getElementById('new-user-password').value;
  const isAdmin = document.getElementById('new-user-admin').checked;
  const statusEl = document.getElementById('new-user-status');

  if (!username || !password) {
    if (statusEl) { statusEl.textContent = 'Username and password required.'; statusEl.className = 'error'; }
    return;
  }
  if (password.length < 6) {
    if (statusEl) { statusEl.textContent = 'Password must be at least 6 characters.'; statusEl.className = 'error'; }
    return;
  }

  try {
    await api('/api/admin/users', 'POST', { username, password, is_admin: isAdmin });
    document.getElementById('new-user-username').value = '';
    document.getElementById('new-user-password').value = '';
    document.getElementById('new-user-admin').checked = false;
    if (statusEl) { statusEl.textContent = `User ${username} created.`; statusEl.className = ''; }
    await loadUsers();
  } catch (e) {
    if (statusEl) { statusEl.textContent = e.message; statusEl.className = 'error'; }
  }
}

export async function resetUserPassword(id, username) {
  const password = prompt(`New password for ${username} (min 6 chars):`);
  if (!password) return;
  if (password.length < 6) {
    alert('Password must be at least 6 characters.');
    return;
  }
  try {
    await api(`/api/admin/users/${id}/password`, 'POST', { password });
    showNotification(`Password reset for ${username}`);
  } catch (e) {
    alert('Failed to reset password: ' + e.message);
  }
}

export async function toggleUserAdmin(id, isAdmin) {
  try {
    await api(`/api/admin/users/${id}/admin`, 'POST', { is_admin: isAdmin });
    await loadUsers();
  } catch (e) {
    alert('Failed to update admin flag: ' + e.message);
    await loadUsers();
  }
}

export async function deleteUser(id, username) {
  if (!confirm(`Delete user "${username}"? Their characters will be unassigned.`)) return;
  try {
    await api(`/api/admin/users/${id}`, 'DELETE');
    showNotification(`User ${username} deleted`);
    await loadUsers();
    // Reload characters (owner field for the deleted user's chars is now null)
    const { loadCharacters } = await import('./characters.js');
    await loadCharacters();
  } catch (e) {
    alert('Failed to delete user: ' + e.message);
  }
}

export async function assignCharacterOwner(characterId, userId) {
  try {
    await api(`/api/admin/characters/${characterId}/assign`, 'POST', { user_id: userId || null });
    // Reload characters so the card reflects the new owner
    const { loadCharacters } = await import('./characters.js');
    await loadCharacters();
    // Refresh user character counts
    await loadUsers();
  } catch (e) {
    alert('Failed to assign owner: ' + e.message);
  }
}
