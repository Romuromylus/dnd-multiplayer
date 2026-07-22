'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeProvider,
  buildEndpoint,
  decodeImageData,
  extractChatImage
} = require('../server/services/imageGenerationService');

describe('image generation provider helpers', () => {
  test('accepts supported providers and safely defaults unknown values', () => {
    assert.equal(normalizeProvider('nanogpt'), 'nanogpt');
    assert.equal(normalizeProvider('chat_completions'), 'chat_completions');
    assert.equal(normalizeProvider('unexpected'), 'openai');
  });

  test('builds image and chat endpoints from base or full URLs', () => {
    assert.equal(
      buildEndpoint('https://api.openai.com/v1', '/images/generations'),
      'https://api.openai.com/v1/images/generations'
    );
    assert.equal(
      buildEndpoint('https://api.openai.com/v1/images/generations', '/images/edits'),
      'https://api.openai.com/v1/images/edits'
    );
    assert.equal(
      buildEndpoint('https://example.com/v1/images/generations', '/chat/completions'),
      'https://example.com/v1/chat/completions'
    );
  });

  test('decodes a generated PNG data URL', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const result = decodeImageData(`data:image/png;base64,${png.toString('base64')}`);
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.extension, 'png');
    assert.deepEqual(result.buffer, png);
  });

  test('extracts image results from common chat-completions shapes', () => {
    assert.equal(
      extractChatImage({ images: [{ image_url: { url: 'https://cdn.example/scene.webp' } }] }),
      'https://cdn.example/scene.webp'
    );
    assert.equal(
      extractChatImage({ content: 'Done: ![scene](https://cdn.example/scene.png)' }),
      'https://cdn.example/scene.png'
    );
  });
});
