// ============================================
// Pub/Sub State Manager
// ============================================

const state = {
  currentUser: null, // { id, username, is_admin }
  currentSession: null,
  characters: [],
  sessionCharacters: [],
  users: [], // admin-only: list of users for owner dropdowns
  socket: null,
  isTurnProcessing: false,
  storyScrollPosition: 0,

  // Character creation
  charCreationMessages: [],
  charCreationInProgress: false,

  // Modal state
  modalCharacterId: null,
  modalMessages: [],
  modalMode: 'edit',

  // Level up modal
  levelUpModalCharId: null,
  levelUpMessages: [],

  // Inventory modal
  inventoryModalCharId: null,

  // Spell slots modal
  spellSlotsModalCharId: null,

  // Quick edit modal
  quickEditCharId: null,

  // API config edit
  editingConfigId: null,

  // Session creation
  selectedScenario: 'classic_fantasy',
  selectedCharacterIds: [],

  // Section expand/collapse state
  sectionExpandedStates: {},
  sectionToggleListenerAttached: false,

  // AI-generated choices for current turn
  pendingChoices: null,
};

const subscribers = {};

export function getState(key) {
  if (key) return state[key];
  return { ...state };
}

export function setState(updates) {
  Object.assign(state, updates);
  for (const [key, value] of Object.entries(updates)) {
    (subscribers[key] || []).forEach(cb => cb(value, key));
  }
}

export function subscribe(key, callback) {
  if (!subscribers[key]) subscribers[key] = [];
  subscribers[key].push(callback);
  return () => {
    subscribers[key] = subscribers[key].filter(cb => cb !== callback);
  };
}
