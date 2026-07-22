import { api } from '../api.js';
import { getState, setState } from '../state.js';
import { showNotification } from '../utils/dom.js';
import { escapeHtml } from '../utils/formatters.js';

const TERRAIN_COST = { plains: 1, forest: 2, ruins: 1, water: 99, wall: 99 };
let actionMode = 'idle';
let modeVersion = null;
let actionPending = false;

function unitAt(state, x, y) {
  return state.units.find(unit => unit.hp > 0 && unit.x === x && unit.y === y) || null;
}

function isOwnedActiveUnit(unit) {
  const user = getState('currentUser');
  return !!unit && unit.side === 'party' && !!user && (user.is_admin || unit.sourceCharacterId && getState('sessionCharacters').some(character => character.id === unit.sourceCharacterId && character.user_id === user.id));
}

function reachableTiles(state, unit) {
  const queue = [{ x: unit.x, y: unit.y, cost: 0 }];
  const found = new Map([[`${unit.x},${unit.y}`, 0]]);
  const occupied = new Set(state.units.filter(other => other.hp > 0 && other.id !== unit.id).map(other => `${other.x},${other.y}`));
  while (queue.length) {
    const current = queue.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = current.x + dx;
      const y = current.y + dy;
      if (x < 0 || y < 0 || x >= state.grid.width || y >= state.grid.height || occupied.has(`${x},${y}`)) continue;
      const cost = current.cost + (TERRAIN_COST[state.grid.tiles[y][x]] || 1);
      const key = `${x},${y}`;
      if (cost > unit.movement || found.has(key)) continue;
      found.set(key, cost);
      queue.push({ x, y, cost });
    }
  }
  return new Set(found.keys());
}

function currentUnit(state) {
  return state.units.find(unit => unit.id === state.turnOrder[state.turnIndex]) || null;
}

function healthBar(unit) {
  const width = Math.max(0, Math.min(100, Math.round((unit.hp / Math.max(1, unit.maxHp)) * 100)));
  return `<span class="tactical-unit-hp"><span style="width:${width}%"></span></span>`;
}

function renderInitiative(state) {
  return state.turnOrder.map(id => {
    const unit = state.units.find(candidate => candidate.id === id);
    if (!unit) return '';
    return `<span class="initiative-chip ${unit.id === state.turnOrder[state.turnIndex] ? 'active' : ''} ${unit.side}">${escapeHtml(unit.name)}</span>`;
  }).join('');
}

export function renderTacticalCombat(combat) {
  const panel = document.getElementById('tactical-combat-panel');
  if (!panel) return;
  document.querySelector('.story-main')?.classList.toggle('combat-mode-active', !!combat?.state);
  setState({ activeCombat: combat || null });
  if (!combat?.state) {
    panel.hidden = true;
    panel.innerHTML = '';
    actionMode = 'idle';
    modeVersion = null;
    return;
  }
  const { state } = combat;
  if (modeVersion !== state.version) {
    actionMode = 'idle';
    modeVersion = state.version;
  }
  panel.hidden = false;
  const unit = currentUnit(state);
  const controllable = isOwnedActiveUnit(unit) && !state.outcome;
  const canMove = controllable && !unit.hasMoved && !unit.hasActed;
  const canAct = controllable && !unit.hasActed;
  const moves = actionMode === 'move' && canMove ? reachableTiles(state, unit) : new Set();
  const targets = new Set(actionMode === 'attack' && canAct
    ? state.units.filter(candidate => candidate.side === 'enemy' && candidate.hp > 0 && Math.abs(candidate.x - unit.x) + Math.abs(candidate.y - unit.y) <= unit.range).map(candidate => candidate.id)
    : []);
  const board = state.grid.tiles.map((row, y) => row.map((terrain, x) => {
    const occupant = unitAt(state, x, y);
    const isMove = moves.has(`${x},${y}`);
    const isTarget = occupant && targets.has(occupant.id);
    const unitHtml = occupant
      ? `<span class="tactical-token ${occupant.side} ${occupant.id === unit?.id ? 'active' : ''}" title="${escapeHtml(`${occupant.name}: ${occupant.hp}/${occupant.maxHp} HP, AC ${occupant.ac}`)}"><span class="tactical-token-name">${escapeHtml(occupant.name.slice(0, 2).toUpperCase())}</span>${healthBar(occupant)}</span>`
      : '';
    return `<button class="tactical-tile terrain-${terrain} ${isMove ? 'move-target' : ''} ${isTarget ? 'attack-target' : ''}" onclick="tacticalTileClick(${x}, ${y})" aria-label="${escapeHtml(terrain)}${occupant ? `, ${occupant.name}` : ''}">${unitHtml}</button>`;
  }).join('')).join('');
  const status = state.outcome
    ? (state.outcome === 'victory' ? 'Victory' : 'Defeat')
    : unit?.side === 'party' ? `${unit.name}'s turn` : 'Resolving enemy turn';
  const instructions = actionMode === 'move' ? 'Choose a highlighted tile.' : actionMode === 'attack' ? 'Choose a highlighted enemy.' : controllable ? 'Move, attack, defend, or end your turn.' : 'Waiting for the active player.';

  panel.innerHTML = `
    <div class="tactical-combat-header">
      <div><span class="tactical-eyebrow">Tactical Encounter</span><h2>${escapeHtml(combat.name || 'Encounter')}</h2></div>
      <div class="tactical-status"><strong>${escapeHtml(status)}</strong><span>Round ${state.round}</span></div>
    </div>
    <div class="tactical-initiative" aria-label="Initiative order">${renderInitiative(state)}</div>
    <div class="tactical-board" style="--tactical-columns:${state.grid.width}">${board}</div>
    <div class="tactical-controls">
      <div class="tactical-help">${escapeHtml(instructions)}</div>
      ${controllable ? `<div class="tactical-actions">
        <button onclick="selectTacticalAction('move')" ${canMove ? '' : 'disabled'}>${actionMode === 'move' ? 'Cancel Move' : 'Move'}</button>
        <button onclick="selectTacticalAction('attack')" ${canAct ? '' : 'disabled'}>${actionMode === 'attack' ? 'Cancel Attack' : `Attack (${unit.range})`}</button>
        <button onclick="tacticalDefend()" ${canAct ? '' : 'disabled'}>Defend</button>
        <button onclick="tacticalEndTurn()">End Turn</button>
      </div>` : ''}
      ${getState('currentUser')?.is_admin ? `<div class="tactical-gm-actions"><button onclick="setDJTrack()">Set Music</button><button onclick="stopDJTrack()">Stop Music</button><button onclick="endTacticalCombat()">End Encounter</button></div>` : ''}
    </div>
    <div class="tactical-log">${state.log.slice(-4).reverse().map(event => `<div>${escapeHtml(event.text)}</div>`).join('')}</div>`;
}

export function selectTacticalAction(mode) {
  actionMode = actionMode === mode ? 'idle' : mode;
  renderTacticalCombat(getState('activeCombat'));
}

export async function tacticalTileClick(x, y) {
  const combat = getState('activeCombat');
  const state = combat?.state;
  const unit = state && currentUnit(state);
  if (!combat || !state || !unit || actionPending) return;
  if (actionMode === 'move') {
    if (!reachableTiles(state, unit).has(`${x},${y}`)) return;
    await submitTacticalAction({ type: 'move', x, y });
  } else if (actionMode === 'attack') {
    const target = unitAt(state, x, y);
    if (!target || target.side !== 'enemy' || Math.abs(target.x - unit.x) + Math.abs(target.y - unit.y) > unit.range) return;
    await submitTacticalAction({ type: 'attack', targetId: target.id });
  }
}

export async function tacticalDefend() {
  await submitTacticalAction({ type: 'defend' });
}

export async function tacticalEndTurn() {
  await submitTacticalAction({ type: 'endTurn' });
}

async function submitTacticalAction(action) {
  const session = getState('currentSession');
  const combat = getState('activeCombat');
  if (!session || !combat || actionPending) return;
  actionPending = true;
  try {
    const result = await api(`/api/sessions/${session.id}/combat/action`, 'POST', { version: combat.state.version, action });
    actionMode = 'idle';
    renderTacticalCombat(result.combat);
    const { updateActionFormState } = await import('./sessions.js');
    updateActionFormState();
    if (result.outcome) showNotification(result.outcome === 'victory' ? 'Victory!' : 'The party was defeated.');
  } catch (error) {
    showNotification(error.message || 'Combat action failed.');
  } finally {
    actionPending = false;
  }
}

export function openTacticalCombatSetup() {
  if (!getState('currentSession')) return showNotification('Select a session first.');
  document.getElementById('combat-setup-modal')?.classList.add('active');
  document.getElementById('combat-setup-status').textContent = '';
}

export function closeTacticalCombatSetup() {
  document.getElementById('combat-setup-modal')?.classList.remove('active');
}

function parseEnemies(value) {
  return value.split('\n').map((line, index) => {
    const [name, hp, ac, attackBonus, damageDie, damageBonus] = line.split('|').map(part => part.trim());
    return name ? { id: String(index + 1), name, hp: Number(hp), ac: Number(ac), attackBonus: Number(attackBonus), damageDie: Number(damageDie), damageBonus: Number(damageBonus) } : null;
  }).filter(Boolean);
}

export async function startTacticalCombat() {
  const session = getState('currentSession');
  if (!session) return;
  const enemies = parseEnemies(document.getElementById('combat-enemies').value);
  const status = document.getElementById('combat-setup-status');
  const button = document.getElementById('start-combat-btn');
  if (!enemies.length) { status.textContent = 'Add at least one enemy.'; return; }
  button.disabled = true;
  try {
    const result = await api(`/api/sessions/${session.id}/combat`, 'POST', {
      name: document.getElementById('combat-name').value,
      environment: document.getElementById('combat-environment').value,
      enemies
    });
    closeTacticalCombatSetup();
    renderTacticalCombat(result.combat);
  } catch (error) {
    status.textContent = error.message || 'Unable to start encounter.';
  } finally {
    button.disabled = false;
  }
}

export async function endTacticalCombat() {
  const session = getState('currentSession');
  if (!session || !window.confirm('End this encounter?')) return;
  try {
    await api(`/api/sessions/${session.id}/combat/end`, 'POST');
    renderTacticalCombat(null);
  } catch (error) {
    showNotification(error.message || 'Unable to end encounter.');
  }
}

export function handleCombatUpdate(sessionId, combat) {
  if (getState('currentSession')?.id !== sessionId) return;
  actionMode = 'idle';
  renderTacticalCombat(combat);
}
