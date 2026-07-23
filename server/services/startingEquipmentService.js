const STARTING_EQUIPMENT = require('../data/srd/startingEquipment.json');

function cloneItems(items) {
  return (items || []).map(item => ({ name: item.name, quantity: Math.max(1, Number(item.quantity) || 1) }));
}

function getStartingEquipment(className) {
  const key = Object.keys(STARTING_EQUIPMENT).find(name => name.toLowerCase() === String(className || '').toLowerCase());
  return cloneItems(STARTING_EQUIPMENT[key] || []);
}

function normalizeInventory(value) {
  let items = value;
  if (typeof value === 'string') {
    try { items = JSON.parse(value); } catch (error) { items = []; }
  }
  if (!Array.isArray(items)) return [];
  return cloneItems(items.filter(item => item && typeof item.name === 'string' && item.name.trim()));
}

function resolveStartingInventory(className, requestedInventory) {
  const merged = new Map();
  for (const item of getStartingEquipment(className)) {
    const key = item.name.toLowerCase();
    merged.set(key, { ...item });
  }
  const selected = new Map();
  for (const item of normalizeInventory(requestedInventory)) {
    const key = item.name.toLowerCase();
    const existing = selected.get(key);
    if (existing) existing.quantity += item.quantity;
    else selected.set(key, { ...item });
  }
  for (const [key, item] of selected) {
    const starter = merged.get(key);
    merged.set(key, starter ? { ...starter, quantity: Math.max(starter.quantity, item.quantity) } : item);
  }
  return [...merged.values()];
}

module.exports = { getStartingEquipment, normalizeInventory, resolveStartingInventory };
