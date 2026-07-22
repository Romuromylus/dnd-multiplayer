'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractFinishReason,
  isLengthFinish,
  buildContinuationMessages,
  DEFAULT_SYSTEM_PROMPT,
  POV_CONVERSION_PROMPT,
  NARRATION_WORD_LIMIT,
  POV_WORD_LIMIT,
  NARRATION_MAX_TOKENS,
  POV_MAX_TOKENS,
} = require('../server/services/aiService.js');

describe('extractFinishReason', () => {
  test('reads OpenAI finish_reason from choices[0]', () => {
    const data = { choices: [{ finish_reason: 'length' }] };
    assert.equal(extractFinishReason(data), 'length');
  });

  test('reads Anthropic stop_reason', () => {
    const data = { stop_reason: 'max_tokens' };
    assert.equal(extractFinishReason(data), 'max_tokens');
  });

  test('returns null when finish reason is omitted', () => {
    assert.equal(extractFinishReason({ choices: [{ message: { content: 'ok' } }] }), null);
    assert.equal(extractFinishReason(null), null);
  });
});

describe('isLengthFinish', () => {
  test('detects token-cap finish reasons', () => {
    assert.equal(isLengthFinish('length'), true);
    assert.equal(isLengthFinish('max_tokens'), true);
    assert.equal(isLengthFinish('LENGTH'), true);
    assert.equal(isLengthFinish('MAX_TOKENS'), true);
  });

  test('rejects non-length finish reasons', () => {
    assert.equal(isLengthFinish('stop'), false);
    assert.equal(isLengthFinish(null), false);
  });
});

describe('buildContinuationMessages', () => {
  const baseMessages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'write the scene' },
  ];

  test('OpenAI-compatible continuation appends assistant partial then user nudge', () => {
    const messages = buildContinuationMessages(baseMessages, 'partial scene', 'openai');

    assert.equal(messages.length, 4);
    assert.deepEqual(messages.slice(0, 2), baseMessages);
    assert.deepEqual(messages[2], { role: 'assistant', content: 'partial scene' });
    assert.equal(messages[3].role, 'user');
    assert.match(messages[3].content, /Continue seamlessly/);
    assert.match(messages[3].content, /Do NOT repeat/);
  });

  test('Anthropic continuation ends on assistant partial with no trailing user turn', () => {
    const messages = buildContinuationMessages(baseMessages, 'partial scene', 'anthropic');

    assert.equal(messages.length, 3);
    assert.deepEqual(messages.slice(0, 2), baseMessages);
    assert.deepEqual(messages[2], { role: 'assistant', content: 'partial scene' });
  });
});

describe('generation length budgets', () => {
  test('DM and POV prompts include explicit word limits', () => {
    assert.equal(NARRATION_WORD_LIMIT, 650);
    assert.equal(POV_WORD_LIMIT, 450);
    assert.match(DEFAULT_SYSTEM_PROMPT, /650 words or fewer/);
    assert.match(POV_CONVERSION_PROMPT, /450 words/);
  });

  test('output token caps are bounded enough to avoid runaway generations', () => {
    assert.ok(NARRATION_MAX_TOKENS <= 3500);
    assert.ok(POV_MAX_TOKENS <= 2400);
  });
});
