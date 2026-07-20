'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  findCharacterByName,
  parseChoices,
  parseXPAwards,
  parseMoneyChanges,
  parseItemChanges,
  parseHPChanges,
  parseSpellSlotChanges,
  parseACChanges,
} = require('../server/services/tagParser.js');

// NOTE: the source matches on the `character_name` field (NOT `name`),
// and looks up `id` on the matched character, so fakes must use both.
const characters = [
  { id: 'char-1', character_name: 'Thorin' },
  { id: 'char-2', character_name: 'Elara' },
  { id: 'char-3', character_name: 'Reinhard Lockeheart' },
];

describe('findCharacterByName', () => {
  test('exact match (case-sensitive input)', () => {
    const c = findCharacterByName(characters, 'Thorin');
    assert.equal(c.id, 'char-1');
  });

  test('case-insensitive match', () => {
    const c = findCharacterByName(characters, 'elara');
    assert.equal(c.id, 'char-2');
  });

  test('first-name match against a full name', () => {
    const c = findCharacterByName(characters, 'Reinhard');
    assert.equal(c.id, 'char-3');
  });

  test('partial / substring match', () => {
    const c = findCharacterByName(characters, 'hor'); // substring of "Thorin"
    assert.equal(c.id, 'char-1');
  });

  test('whitespace is tolerated (input is trimmed)', () => {
    const c = findCharacterByName(characters, '   Thorin   ');
    assert.equal(c.id, 'char-1');
  });

  test('no match returns null', () => {
    assert.equal(findCharacterByName(characters, 'Gandalf'), null);
  });
});

describe('parseChoices', () => {
  test('single choice tag returns one entry with expected shape', () => {
    const result = parseChoices('[CHOICE: Thorin | STR | HARD | Break down the door]', characters);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      characterId: 'char-1',
      characterName: 'Thorin',
      stat: 'STR',
      difficulty: 'HARD',
      description: 'Break down the door',
    });
  });

  test('multiple choice tags return multiple entries', () => {
    const text = '[CHOICE: Thorin | STR | HARD | Push it] and [CHOICE: Elara | DEX | EASY | Sneak past]';
    const result = parseChoices(text, characters);
    assert.equal(result.length, 2);
    assert.equal(result[1].characterName, 'Elara');
    assert.equal(result[1].stat, 'DEX');
  });

  test('text with no choice tag returns empty array', () => {
    assert.deepEqual(parseChoices('Just some narration.', characters), []);
  });
});

describe('parseXPAwards', () => {
  test('parses multiple awards from one tag', () => {
    const result = parseXPAwards('[XP: Thorin +50, Elara +50]', characters);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { characterId: 'char-1', characterName: 'Thorin', amount: 50 });
    assert.equal(result[1].amount, 50);
  });

  test('no tag returns empty array', () => {
    assert.deepEqual(parseXPAwards('nothing here', characters), []);
  });
});

describe('parseMoneyChanges', () => {
  test('parses gains and losses (GOLD alias, signed amounts)', () => {
    const result = parseMoneyChanges('[GOLD: Thorin +100, Elara -25]', characters);
    assert.equal(result.length, 2);
    assert.equal(result[0].amount, 100);
    assert.equal(result[1].amount, -25);
  });

  test('no tag returns empty array', () => {
    assert.deepEqual(parseMoneyChanges('no money mentioned', characters), []);
  });
});

describe('parseItemChanges', () => {
  test('parses an item addition (multi-word item, default quantity)', () => {
    const result = parseItemChanges('[ITEM: Thorin +Sword of Fire]', characters);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      characterId: 'char-1',
      characterName: 'Thorin',
      item: 'Sword of Fire',
      quantity: 1,
      isAdding: true,
    });
  });

  test('no tag returns empty array', () => {
    assert.deepEqual(parseItemChanges('no items', characters), []);
  });
});

describe('parseHPChanges', () => {
  test('parses an HP subtraction', () => {
    const result = parseHPChanges('[HP: Thorin -10]', characters);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      characterId: 'char-1',
      characterName: 'Thorin',
      operator: '-',
      value: 10,
    });
  });

  test('no tag returns empty array', () => {
    assert.deepEqual(parseHPChanges('nobody took damage', characters), []);
  });
});

describe('parseSpellSlotChanges', () => {
  test('parses slot usage (numeric ordinal, level kept as string)', () => {
    const result = parseSpellSlotChanges('[SPELL: Thorin -1st]', characters);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      characterId: 'char-1',
      characterName: 'Thorin',
      action: 'use',
      level: '1',
    });
  });

  test('no tag returns empty array', () => {
    assert.deepEqual(parseSpellSlotChanges('no spells cast', characters), []);
  });
});

describe('parseACChanges', () => {
  test('parses an add-effect AC change', () => {
    const result = parseACChanges('[AC: Thorin +Shield +2 equipment]', characters);
    assert.equal(result.length, 1);
    const change = result[0];
    assert.equal(change.characterId, 'char-1');
    assert.equal(change.action, 'add_effect');
    assert.equal(change.effect.name, 'Shield');
    assert.equal(change.effect.value, 2);
    assert.equal(change.effect.type, 'equipment');
    assert.equal(change.effect.temporary, false);
    assert.equal(typeof change.effect.id, 'string');
  });

  test('no tag returns empty array', () => {
    assert.deepEqual(parseACChanges('no armor changes', characters), []);
  });
});
