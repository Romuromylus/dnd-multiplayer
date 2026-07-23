// ============================================
// Rules-driven Level Up Modal
// ============================================

import { getState, setState } from '../../state.js';
import { api } from '../../api.js';
import { escapeHtml } from '../../utils/formatters.js';
import { showNotification } from '../../utils/dom.js';
import { getRequiredXP, canLevelUp } from '../../utils/gameRules.js';
import { loadCharacters } from '../characters.js';

const ABILITIES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

export async function levelUpCharacter(charId) {
  const characters = getState('characters');
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  if (!canLevelUp(char.xp || 0, char.level)) {
    alert(`${char.character_name} needs ${getRequiredXP(char.level)} XP to level up. Current: ${char.xp || 0} XP`);
    return;
  }

  setState({ levelUpModalCharId: charId, levelUpMessages: [] });
  document.getElementById('modal-title').textContent = `Level Up ${char.character_name}`;
  document.getElementById('modal-input-area')?.classList.add('hidden');
  document.getElementById('modal-chat-messages').innerHTML = '<div class="chat-message assistant"><div class="message-content">Loading the rules for this level...</div></div>';
  document.getElementById('char-modal').classList.add('active');

  try {
    const info = await api(`/api/characters/${charId}/levelinfo`);
    renderLevelUpForm(charId, char, info);
  } catch (error) {
    renderError(error.message);
  }
}

function renderLevelUpForm(charId, char, info) {
  const progression = info.nextProgression;
  if (!progression) {
    renderError('No progression data is available for this level.');
    return;
  }

  const classOptions = (info.classOptions || []).filter(option => option.available);
  const classSelect = classOptions.map(option => {
    const selected = option.name === info.currentClass ? ' selected' : '';
    const label = option.level ? `${option.name} (level ${option.level})` : `${option.name} (multiclass)`;
    return `<option value="${escapeHtml(option.name)}"${selected}>${escapeHtml(label)}</option>`;
  }).join('');
  const asi = progression.asi ? `
    <div class="levelup-choice-group">
      <label for="levelup-asi">Ability Score Improvement</label>
      <select id="levelup-asi" class="levelup-asi-select">
        <option value="none">Choose a +2 increase</option>
        ${ABILITIES.map(ability => `<option value="${ability}">+2 ${ability[0].toUpperCase() + ability.slice(1)}</option>`).join('')}
        <option value="split">+1 to two abilities</option>
        <option value="feat">Take a feat instead</option>
      </select>
      <div id="levelup-asi-split" class="hidden">
        <select id="levelup-asi-first">${ABILITIES.map(ability => `<option value="${ability}">${ability}</option>`).join('')}</select>
        <select id="levelup-asi-second">${ABILITIES.map(ability => `<option value="${ability}">${ability}</option>`).join('')}</select>
      </div>
      <input id="levelup-feat" class="hidden" maxlength="120" placeholder="Feat name">
    </div>` : '';
  const subclass = progression.subclass ? `
    <div class="levelup-choice-group">
      <label for="levelup-subclass">Subclass choice</label>
      <input id="levelup-subclass" maxlength="120" placeholder="Subclass, oath, domain, path, tradition, or patron">
    </div>` : '';
  const spellcasting = progression.spell_slots?.some(slot => slot > 0) ? `
    <div class="levelup-choice-group">
      <label for="levelup-spells">New spells or cantrips</label>
      <textarea id="levelup-spells" rows="2" placeholder="Optional: separate spell names with commas"></textarea>
    </div>` : '';

  document.getElementById('modal-chat-messages').innerHTML = `
    <div class="chat-message assistant"><div class="message-content">
      <strong>Level ${info.nextLevel}: ${escapeHtml(info.currentClass)} ${info.currentClassLevel + 1}</strong><br>
      Choose the class level to take. The server applies HP, features, proficiencies, ASI/feat rules, and spell slots from the stored 2014/5e progression.
      <ul>${progression.features.map(feature => `<li>${escapeHtml(feature)}</li>`).join('') || '<li>No named feature at this level</li>'}</ul>
      <p>Fixed HP increase: ${Math.floor(progression.hitDie / 2) + 1 + Math.floor((Number(char.constitution || 10) - 10) / 2)} (minimum 1).</p>
    </div></div>
    <div class="levelup-form" id="levelup-form">
      <div class="levelup-choice-group"><label for="levelup-class">Class level</label><select id="levelup-class">${classSelect}</select></div>
      ${asi}${subclass}${spellcasting}
      <button class="btn-primary" onclick="submitStructuredLevelUp('${escapeHtml(charId)}')">Apply Level Up</button>
    </div>`;

  document.getElementById('levelup-class')?.addEventListener('change', async event => {
    try {
      const selectedInfo = await api(`/api/characters/${charId}/levelinfo?class=${encodeURIComponent(event.target.value)}`);
      renderLevelUpForm(charId, char, selectedInfo);
    } catch (error) {
      renderError(error.message);
    }
  });
  document.getElementById('levelup-asi')?.addEventListener('change', event => {
    document.getElementById('levelup-asi-split')?.classList.toggle('hidden', event.target.value !== 'split');
    document.getElementById('levelup-feat')?.classList.toggle('hidden', event.target.value !== 'feat');
  });
}

export async function submitStructuredLevelUp(charId) {
  const asi = document.getElementById('levelup-asi')?.value || 'none';
  const abilityIncreases = {};
  if (asi === 'split') {
    const first = document.getElementById('levelup-asi-first')?.value;
    const second = document.getElementById('levelup-asi-second')?.value;
    if (first === second) return renderError('Choose two different abilities for a split increase.');
    abilityIncreases[first] = 1;
    abilityIncreases[second] = 1;
  } else if (ABILITIES.includes(asi)) {
    abilityIncreases[asi] = 2;
  }
  try {
    const result = await api(`/api/characters/${charId}/levelup`, 'POST', {
      choices: {
        class_name: document.getElementById('levelup-class')?.value,
        ability_increases: abilityIncreases,
        feat: asi === 'feat' ? document.getElementById('levelup-feat')?.value : '',
        subclass: document.getElementById('levelup-subclass')?.value || '',
        spells: document.getElementById('levelup-spells')?.value || ''
      }
    });
    document.getElementById('modal-chat-messages').innerHTML = `<div class="chat-message assistant"><div class="message-content">${escapeHtml(result.message)}</div></div>`;
    if (result.complete) {
      loadCharacters();
      showNotification(`${result.character.character_name} is now level ${result.character.level}!`);
    }
  } catch (error) {
    renderError(error.message);
  }
}

function parseClasses(raw, primaryClass, totalLevel) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (Object.keys(parsed).length) return parsed;
  } catch (e) { /* use the legacy primary class below */ }
  return primaryClass ? { [primaryClass]: totalLevel || 1 } : {};
}

function renderError(message) {
  document.getElementById('modal-chat-messages').innerHTML = `<div class="chat-message assistant"><div class="message-content">Error: ${escapeHtml(message)}</div></div>`;
}
