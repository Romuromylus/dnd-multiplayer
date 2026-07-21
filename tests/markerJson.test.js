'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { extractMarkerJson } = require('../server/lib/markerJson.js');

describe('extractMarkerJson', () => {
  test('extracts a flat JSON object that follows the marker', () => {
    const text = 'Sure! EDIT_COMPLETE:{"hp":35,"max_hp":35}';
    assert.equal(extractMarkerJson(text, 'EDIT_COMPLETE:'), '{"hp":35,"max_hp":35}');
  });

  test('balances nested braces and stops at the matching close', () => {
    const text = 'LEVELUP_COMPLETE:{"summary":"nice","nested":{"a":1,"b":{"c":2}}} trailing junk';
    assert.equal(
      extractMarkerJson(text, 'LEVELUP_COMPLETE:'),
      '{"summary":"nice","nested":{"a":1,"b":{"c":2}}}'
    );
  });

  test('ignores any braces that appear before the marker', () => {
    const text = 'chatter {not this} more CHARACTER_COMPLETE:{"character_name":"Aria"}';
    assert.equal(extractMarkerJson(text, 'CHARACTER_COMPLETE:'), '{"character_name":"Aria"}');
  });

  test('skips whitespace/text between the marker and the opening brace', () => {
    const text = 'EDIT_COMPLETE:   \n  {"gold": 10}';
    assert.equal(extractMarkerJson(text, 'EDIT_COMPLETE:'), '{"gold": 10}');
  });

  test('returns null when no opening brace follows the marker', () => {
    assert.equal(extractMarkerJson('EDIT_COMPLETE: no json here', 'EDIT_COMPLETE:'), null);
  });

  test('returns "" (falsy) when a brace opens but never balances', () => {
    // Callers treat an empty/unparseable result as "not complete".
    const text = 'EDIT_COMPLETE:{"hp":35';
    assert.equal(extractMarkerJson(text, 'EDIT_COMPLETE:'), '');
  });

  test('non-string input returns null', () => {
    assert.equal(extractMarkerJson(null, 'X:'), null);
    assert.equal(extractMarkerJson(undefined, 'X:'), null);
    assert.equal(extractMarkerJson(42, 'X:'), null);
  });

  test('parsed result round-trips through JSON.parse for a realistic payload', () => {
    const payload = { hp_increase: 7, class_leveled: 'Wizard', summary: 'To level 5!' };
    const text = `Great choice. LEVELUP_COMPLETE:${JSON.stringify(payload)}`;
    const extracted = extractMarkerJson(text, 'LEVELUP_COMPLETE:');
    assert.deepEqual(JSON.parse(extracted), payload);
  });
});
