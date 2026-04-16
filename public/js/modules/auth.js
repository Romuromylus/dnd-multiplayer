// ============================================
// Auth Module — user login via cookie session
// ============================================

import { getState, setState } from '../state.js';
import { api } from '../api.js';

// ============================================
// State persistence (app shell — NOT credentials)
// ============================================

export function saveAppState() {
  const { currentSession, charCreationInProgress, charCreationMessages } = getState();

  const stateToSave = {
    currentSessionId: currentSession ? currentSession.id : null,
    currentTab: document.querySelector('.tab-btn.active')?.dataset.tab || 'game',
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
// Bootstrap: try cookie session → fetch /api/me
// ============================================

export async function restoreSession() {
  let me;
  try {
    me = await api('/api/me');
  } catch (e) {
    return false;
  }
  if (!me || !me.user) return false;
  setState({ currentUser: me.user });

  const savedState = loadAppState();

  try {
    const { initSocket } = await import('../socket.js');
    const { loadInitialData } = await import('../main.js');
    const { loadSession } = await import('./sessions.js');
    const { loadAutoReplyCharacters } = await import('./settings.js');
    const { escapeHtml, formatChatMessage } = await import('../utils/formatters.js');
    const { scrollChatToBottom } = await import('../utils/dom.js');

    initSocket();
    await loadInitialData();

    if (savedState) {
      if (savedState.currentTab) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector(`.tab-btn[data-tab="${savedState.currentTab}"]`)?.classList.add('active');
        document.getElementById(`${savedState.currentTab}-tab`)?.classList.add('active');
      }

      if (savedState.currentSessionId) {
        await loadSession(savedState.currentSessionId).catch(e => {
          console.warn('[DnD] Could not restore session:', e.message);
        });
      }

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
    }
  } catch (e) {
    console.error('[DnD] Restore session error:', e);
  }

  return true;
}

// ============================================
// Login / Logout
// ============================================

export function showLoginModal() {
  document.getElementById('login-modal').classList.add('active');
  const pwd = document.getElementById('login-password-input');
  const err = document.getElementById('login-error');
  if (pwd) pwd.value = '';
  if (err) err.textContent = '';
  const user = document.getElementById('login-username-input');
  if (user) user.focus();
}

function hideLoginModal() {
  document.getElementById('login-modal').classList.remove('active');
}

export async function submitLogin() {
  const username = document.getElementById('login-username-input').value.trim();
  const password = document.getElementById('login-password-input').value;
  const errEl = document.getElementById('login-error');
  if (!username || !password) {
    if (errEl) errEl.textContent = 'Enter username and password';
    return false;
  }

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (errEl) errEl.textContent = data.error || 'Login failed';
      return false;
    }
    const data = await res.json();
    setState({ currentUser: data.user });
    hideLoginModal();
    saveAppState();
    return true;
  } catch (e) {
    if (errEl) errEl.textContent = 'Login failed: ' + e.message;
    return false;
  }
}

export async function logout() {
  try {
    await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin'
    });
  } catch (e) {
    // ignore — we clear client state regardless
  }
  const socket = getState('socket');
  if (socket) {
    try { socket.disconnect(); } catch (e) {}
  }
  setState({ currentUser: null, currentSession: null, characters: [], sessionCharacters: [], socket: null });
  sessionStorage.removeItem('dnd-app-state');
  window.location.reload();
}
