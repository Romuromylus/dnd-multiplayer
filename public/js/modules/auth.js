// ============================================
// Auth Module
// - Game and admin auth
// ============================================

import { getState, setState } from '../state.js';
import { escapeHtml, formatChatMessage } from '../utils/formatters.js';
import { scrollChatToBottom } from '../utils/dom.js';

// ============================================
// State persistence
// ============================================

export function saveAppState() {
  const {
    currentSession, charCreationInProgress,
    charCreationMessages, gamePassword,
    isGameAuthenticated
  } = getState();

  const stateToSave = {
    currentSessionId: currentSession ? currentSession.id : null,
    currentTab: document.querySelector('.tab-btn.active')?.dataset.tab || 'game',
    gamePassword,
    isGameAuthenticated,
    charCreationInProgress,
    charCreationMessages,
    autoReplySessionId: document.getElementById('autoreply-session-select')?.value || '',
    autoReplyCharacterId: document.getElementById('autoreply-character-select')?.value || ''
  };
  sessionStorage.setItem('dnd-app-state', JSON.stringify(stateToSave));
}

function loadAppState() {
  try {
    const saved = sessionStorage.getItem('dnd-app-state');
    if (saved) return JSON.parse(saved);
  } catch (e) {
    console.error('Failed to load app state:', e);
  }
  return null;
}

// ============================================
// Session restore (app state only, no auth)
// ============================================

export async function restoreSession() {
  const savedState = loadAppState();
  if (!savedState || !savedState.isGameAuthenticated || !savedState.gamePassword) return false;

  try {
    const authCheck = await fetch('/api/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Game-Password': savedState.gamePassword
      },
      body: JSON.stringify({ password: savedState.gamePassword })
    });
    if (!authCheck.ok) return false;
  } catch (error) {
    return false;
  }

  setState({
    gamePassword: savedState.gamePassword,
    isGameAuthenticated: true
  });

  try {
    const { initSocket } = await import('../socket.js');
    const { loadInitialData } = await import('../main.js');
    const { loadSession } = await import('./sessions.js');
    const { loadAutoReplyCharacters } = await import('./settings.js');

    initSocket();
    await loadInitialData();

    // Restore active tab
    if (savedState.currentTab) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelector(`.tab-btn[data-tab="${savedState.currentTab}"]`)?.classList.add('active');
      document.getElementById(`${savedState.currentTab}-tab`)?.classList.add('active');
    }

    // Restore current session
    if (savedState.currentSessionId) {
      await loadSession(savedState.currentSessionId).catch(e => {
        console.warn('[DnD] Could not restore session:', e.message);
      });
    }

    // Restore auto-reply selections
    if (savedState.autoReplySessionId) {
      const autoReplySelect = document.getElementById('autoreply-session-select');
      if (autoReplySelect) {
        autoReplySelect.value = savedState.autoReplySessionId;
        await loadAutoReplyCharacters().catch(() => {});
        if (savedState.autoReplyCharacterId) {
          const charSelect = document.getElementById('autoreply-character-select');
          if (charSelect) charSelect.value = savedState.autoReplyCharacterId;
        }
      }
    }

    // Restore character creation state
    if (savedState.charCreationInProgress && savedState.charCreationMessages) {
      setState({
        charCreationInProgress: true,
        charCreationMessages: savedState.charCreationMessages
      });

      document.getElementById('start-creation-btn').disabled = true;
      document.getElementById('char-chat-input').disabled = false;
      document.getElementById('char-chat-send').disabled = false;

      const messagesContainer = document.getElementById('char-chat-messages');
      messagesContainer.innerHTML = savedState.charCreationMessages
        .filter(m => m.role !== 'system')
        .map(m => `<div class="chat-message ${m.role === 'user' ? 'user' : 'assistant'}"><div class="message-content">${m.role === 'user' ? escapeHtml(m.content) : formatChatMessage(m.content)}</div></div>`)
        .join('');
      scrollChatToBottom();
    }
  } catch (e) {
    console.error('[DnD] Restore session error:', e);
  }

  return true;
}

// ============================================
// Admin auth
// ============================================

export function showAdminModal() {
  document.getElementById('admin-modal').classList.add('active');
  document.getElementById('admin-password-input').value = '';
  document.getElementById('admin-login-error').textContent = '';
  document.getElementById('admin-password-input').focus();
}

export function closeAdminModal() {
  document.getElementById('admin-modal').classList.remove('active');
  const resolve = getState('adminLoginResolve');
  if (resolve) {
    resolve(false);
    setState({ adminLoginResolve: null });
  }
}

export async function submitAdminLogin() {
  const pwd = document.getElementById('admin-password-input').value;
  const gamePassword = getState('gamePassword');
  if (!pwd) {
    document.getElementById('admin-login-error').textContent = 'Please enter a password';
    return;
  }

  try {
    const result = await fetch('/api/admin-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Game-Password': gamePassword || ''
      },
      body: JSON.stringify({ adminPassword: pwd })
    });

    if (result.ok) {
      setState({ adminPassword: pwd, isAdminAuthenticated: true });
      document.getElementById('admin-modal').classList.remove('active');
      const resolve = getState('adminLoginResolve');
      if (resolve) {
        resolve(true);
        setState({ adminLoginResolve: null });
      }
    } else {
      const data = await result.json();
      document.getElementById('admin-login-error').textContent = data.error || 'Invalid admin password';
    }
  } catch (error) {
    document.getElementById('admin-login-error').textContent = 'Failed to authenticate';
  }
}

export function promptAdminLogin() {
  return new Promise((resolve) => {
    setState({ adminLoginResolve: resolve });
    showAdminModal();
  });
}

// ============================================
// Game auth
// ============================================

export function showGameModal() {
  document.getElementById('game-modal').classList.add('active');
  document.getElementById('game-password-input').value = '';
  document.getElementById('game-login-error').textContent = '';
  document.getElementById('game-password-input').focus();
}

export async function submitGameLogin() {
  const pwd = document.getElementById('game-password-input').value;
  if (!pwd) {
    document.getElementById('game-login-error').textContent = 'Please enter a password';
    return;
  }

  try {
    const result = await fetch('/api/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Game-Password': pwd
      },
      body: JSON.stringify({ password: pwd })
    });

    if (result.ok) {
      setState({ gamePassword: pwd, isGameAuthenticated: true });
      document.getElementById('game-modal').classList.remove('active');
      saveAppState();
      return true;
    }

    const data = await result.json().catch(() => ({}));
    document.getElementById('game-login-error').textContent = data.error || 'Invalid game password';
    return false;
  } catch (error) {
    document.getElementById('game-login-error').textContent = 'Failed to authenticate';
    return false;
  }
}
