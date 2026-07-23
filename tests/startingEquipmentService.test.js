'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  getStartingEquipment,
  normalizeInventory,
  resolveStartingInventory
} = require('../server/services/startingEquipmentService.js');

describe('starting equipment', () => {
  test('provides a package for every supported class', () => {
    for (const className of ['Barbarian', 'Bard', 'Cleric', 'Druid', 'Fighter', 'Monk', 'Paladin', 'Ranger', 'Rogue', 'Sorcerer', 'Warlock', 'Wizard']) {
      assert.ok(getStartingEquipment(className).length > 0, `${className} should have starting equipment`);
    }
  });

  test('merges selected equipment with the class package', () => {
    const inventory = resolveStartingInventory('Wizard', [{ name: 'Rope', quantity: 1 }, { name: 'Quarterstaff', quantity: 1 }]);
    assert.ok(inventory.some(item => item.name === 'Spellbook'));
    assert.deepEqual(inventory.find(item => item.name === 'Rope'), { name: 'Rope', quantity: 1 });
    assert.equal(inventory.find(item => item.name === 'Quarterstaff').quantity, 1);
  });

  test('normalizes quantities and ignores malformed entries', () => {
    assert.deepEqual(normalizeInventory('[{"name":"Dagger","quantity":2},{"name":"Dagger","quantity":1},{"name":""}]'), [
      { name: 'Dagger', quantity: 2 },
      { name: 'Dagger', quantity: 1 }
    ]);
  });
});
