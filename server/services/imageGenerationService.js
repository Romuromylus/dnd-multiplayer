const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { validateEndpointSafety } = require('./aiService');
const logger = require('../lib/logger');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 5 * 60 * 1000;
const POV_SCENE_DIR = path.join(__dirname, '../../data/uploads/pov-scenes');
const povImageJobs = new Map();
let povImageQueue = Promise.resolve();

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'nanogpt' || provider === 'chat_completions') return provider;
  return 'openai';
}

function buildEndpoint(baseUrl, targetPath) {
  const parsed = new URL(String(baseUrl || '').trim());
  const currentPath = parsed.pathname.replace(/\/+$/, '');
  if (/\/images\/(?:generations|edits)$/i.test(currentPath)) {
    parsed.pathname = currentPath.replace(/\/images\/(?:generations|edits)$/i, targetPath);
  } else if (/\/chat\/completions$/i.test(currentPath)) {
    parsed.pathname = currentPath.replace(/\/chat\/completions$/i, targetPath);
  } else if (!currentPath || currentPath === '/') {
    parsed.pathname = `/v1${targetPath}`;
  } else if (/\/(?:api\/)?v1$/i.test(currentPath)) {
    parsed.pathname = `${currentPath}${targetPath}`;
  } else {
    parsed.pathname = `${currentPath}${targetPath}`;
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function detectImageType(buffer, fallback = 'image/png') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  if (fallback.includes('jpeg') || fallback.includes('jpg')) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (fallback.includes('webp')) return { mimeType: 'image/webp', extension: 'webp' };
  return { mimeType: 'image/png', extension: 'png' };
}

function decodeImageData(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  const encoded = match ? match[2] : raw;
  if (!encoded || !/^[A-Za-z0-9+/=\s]+$/.test(encoded)) throw new Error('Image provider returned invalid base64 data');
  const buffer = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('Generated image was empty or too large');
  return { buffer, ...detectImageType(buffer, match?.[1] || 'image/png') };
}

function referenceDataUrl(reference) {
  if (!reference?.buffer?.length) return null;
  return `data:${reference.mimeType || 'image/png'};base64,${reference.buffer.toString('base64')}`;
}

async function fetchWithTimeout(url, options = {}) {
  await validateEndpointSafety(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function responseError(response, label) {
  const body = await response.text().catch(() => 'Unknown error');
  const clean = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  return new Error(`${label} failed (${response.status}): ${clean || response.statusText}`);
}

async function downloadImage(url) {
  if (String(url).startsWith('data:')) return decodeImageData(url);
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw await responseError(response, 'Generated image download');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_IMAGE_BYTES) throw new Error('Generated image was too large');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('Generated image was empty or too large');
  return { buffer, ...detectImageType(buffer, response.headers.get('content-type') || 'image/png') };
}

async function readImageResult(response, label) {
  if (!response.ok) throw await responseError(response, label);
  const contentType = response.headers.get('content-type') || '';
  if (contentType.startsWith('image/')) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('Generated image was empty or too large');
    return { buffer, ...detectImageType(buffer, contentType) };
  }

  const data = await response.json();
  const item = data?.data?.[0];
  const base64 = item?.b64_json || item?.image_base64;
  if (base64) return decodeImageData(base64);
  if (item?.url) return downloadImage(item.url);
  throw new Error(`${label} returned no image data`);
}

async function generateOpenAI(config, prompt, reference) {
  const target = reference ? '/images/edits' : '/images/generations';
  const endpoint = buildEndpoint(config.endpoint, target);
  if (reference) {
    const form = new FormData();
    form.append('model', config.model);
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', '1536x1024');
    form.append('output_format', 'png');
    form.append('image[]', new Blob([reference.buffer], { type: reference.mimeType }), `character.${reference.extension}`);
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form
    });
    return readImageResult(response, 'Image edit');
  }

  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, prompt, n: 1, size: '1536x1024', output_format: 'png' })
  });
  return readImageResult(response, 'Image generation');
}

async function generateNanoGPT(config, prompt, reference) {
  const parsedBase = new URL(config.endpoint);
  parsedBase.pathname = parsedBase.pathname.replace(/\/api\/v1\/?$/i, '/v1');
  const endpoint = buildEndpoint(parsedBase.toString(), '/images/generations');
  const body = {
    model: config.model,
    prompt,
    n: 1,
    size: '1536x1024',
    response_format: 'b64_json'
  };
  const dataUrl = referenceDataUrl(reference);
  if (dataUrl) body.imageDataUrl = dataUrl;
  if (config.model.toLowerCase().includes('flux-kontext')) body.kontext_max_mode = true;
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body)
  });
  return readImageResult(response, 'NanoGPT image generation');
}

function extractChatImage(message) {
  for (const image of Array.isArray(message?.images) ? message.images : []) {
    const url = image?.image_url?.url || image?.imageUrl?.url || image?.url;
    if (url) return url;
  }
  const content = typeof message?.content === 'string' ? message.content : '';
  return content.match(/data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+/i)?.[0]
    || content.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1]
    || content.match(/https?:\/\/\S+\.(?:png|jpe?g|webp)(?:\?\S*)?/i)?.[0]
    || null;
}

async function generateChatImage(config, prompt, reference) {
  const endpoint = buildEndpoint(config.endpoint, '/chat/completions');
  const content = reference
    ? [
        { type: 'image_url', image_url: { url: referenceDataUrl(reference) } },
        { type: 'text', text: prompt }
      ]
    : prompt;
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content }], stream: false })
  });
  if (!response.ok) throw await responseError(response, 'Chat image generation');
  const data = await response.json();
  const imageUrl = extractChatImage(data?.choices?.[0]?.message);
  if (!imageUrl) throw new Error('Chat image provider returned no image');
  return downloadImage(imageUrl);
}

async function generatePOVSceneImage(config, prompt, reference = null) {
  const normalized = {
    provider: normalizeProvider(config.provider),
    endpoint: String(config.endpoint || '').trim(),
    apiKey: String(config.apiKey || '').trim(),
    model: String(config.model || '').trim()
  };
  if (!normalized.endpoint || !normalized.apiKey || !normalized.model) throw new Error('Image generation is not fully configured');
  if (normalized.provider === 'nanogpt') return generateNanoGPT(normalized, prompt, reference);
  if (normalized.provider === 'chat_completions') return generateChatImage(normalized, prompt, reference);
  return generateOpenAI(normalized, prompt, reference);
}

function loadCharacterReference(character) {
  const imageUrl = String(character?.image_url || '');
  const match = imageUrl.match(/^\/uploads\/characters\/([A-Za-z0-9_.-]+)$/);
  if (!match) return null;
  const filePath = path.join(__dirname, '../../data/uploads/characters', match[1]);
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
  return { buffer, ...detectImageType(buffer, path.extname(filePath).slice(1)) };
}

function savePOVSceneImage(image, sessionId) {
  const safeSessionId = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!safeSessionId || safeSessionId !== String(sessionId || '')) throw new Error('Invalid session ID');
  const directory = path.join(POV_SCENE_DIR, safeSessionId);
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${uuidv4()}.${image.extension}`;
  fs.writeFileSync(path.join(directory, filename), image.buffer);
  return `/uploads/pov-scenes/${safeSessionId}/${filename}`;
}

function deletePOVSceneImage(imageUrl) {
  const match = String(imageUrl || '').match(/^\/uploads\/pov-scenes\/([A-Za-z0-9-]+)\/([A-Za-z0-9.-]+)$/);
  if (!match) return false;
  const filePath = path.join(POV_SCENE_DIR, match[1], match[2]);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

function deleteEntryPOVImages(entry) {
  for (const scene of Object.values(entry?.povImages || {})) {
    if (scene?.url) deletePOVSceneImage(scene.url);
  }
}

function deleteSessionPOVScenes(sessionId) {
  const safeSessionId = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!safeSessionId || safeSessionId !== String(sessionId || '')) return;
  try { fs.rmSync(path.join(POV_SCENE_DIR, safeSessionId), { recursive: true, force: true }); } catch {}
}

function loadPOVImageSettings(db) {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (
    'pov_image_enabled', 'pov_image_auto_enabled', 'pov_image_provider',
    'pov_image_endpoint', 'pov_image_api_key', 'pov_image_model',
    'pov_image_style_prompt'
  )`).all();
  return Object.fromEntries(rows.map(row => [row.key, row.value]));
}

async function generateAndPersistPOVScene(options) {
  const {
    db, aiService, sessionId, index, character, aiConfig,
    settings = loadPOVImageSettings(db)
  } = options;
  const session = db.prepare('SELECT full_history FROM game_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('Session not found');
  const history = JSON.parse(session.full_history || '[]');
  const entry = history[index];
  if (!entry || entry.role !== 'assistant') throw new Error('Target entry is not a narration');
  const povContent = entry.povs?.[character.character_name] || entry.content || '';
  if (!povContent.trim()) throw new Error('This POV has no narration to illustrate');
  if (settings.pov_image_enabled !== 'true') throw new Error('POV scene images are disabled in Admin Settings');
  if (!settings.pov_image_endpoint || !settings.pov_image_api_key || !settings.pov_image_model) {
    throw new Error('POV image generation is not fully configured in Admin Settings');
  }
  if (!aiConfig?.api_key) throw new Error('No active narration API configuration');

  let generatedUrl = null;
  try {
    const prompt = await aiService.generatePOVImagePrompt(
      { endpoint: aiConfig.endpoint, api_key: aiConfig.api_key, model: aiConfig.model },
      character,
      povContent,
      settings.pov_image_style_prompt || ''
    );
    const reference = loadCharacterReference(character);
    const image = await generatePOVSceneImage({
      provider: settings.pov_image_provider,
      endpoint: settings.pov_image_endpoint,
      apiKey: settings.pov_image_api_key,
      model: settings.pov_image_model
    }, prompt, reference);
    generatedUrl = savePOVSceneImage(image, sessionId);

    const latestSession = db.prepare('SELECT full_history FROM game_sessions WHERE id = ?').get(sessionId);
    const latestHistory = JSON.parse(latestSession?.full_history || '[]');
    const latestEntry = latestHistory[index];
    const latestPov = latestEntry?.povs?.[character.character_name] || latestEntry?.content || '';
    if (!latestEntry || latestEntry.role !== 'assistant' || latestPov !== povContent) {
      throw new Error('The POV changed while its image was generating. Please try again.');
    }

    const oldImageUrl = latestEntry.povImages?.[character.id]?.url;
    latestEntry.povImages = latestEntry.povImages || {};
    latestEntry.povImages[character.id] = {
      url: generatedUrl,
      prompt,
      characterName: character.character_name,
      createdAt: new Date().toISOString(),
      usedAvatarReference: !!reference
    };
    latestHistory[index] = latestEntry;
    db.prepare('UPDATE game_sessions SET full_history = ? WHERE id = ?').run(JSON.stringify(latestHistory), sessionId);
    if (oldImageUrl && oldImageUrl !== generatedUrl) deletePOVSceneImage(oldImageUrl);
    generatedUrl = null;
    return latestEntry.povImages[character.id];
  } catch (error) {
    if (generatedUrl) deletePOVSceneImage(generatedUrl);
    throw error;
  }
}

function queuePOVSceneGeneration(options) {
  const jobKey = `${options.sessionId}:${options.index}:${options.character.id}`;
  const existing = povImageJobs.get(jobKey);
  if (existing) return { started: false, promise: existing };

  const job = povImageQueue
    .catch(() => {})
    .then(() => generateAndPersistPOVScene(options));
  const trackedJob = job.finally(() => povImageJobs.delete(jobKey));
  povImageJobs.set(jobKey, trackedJob);
  povImageQueue = trackedJob.catch(() => {});
  return { started: true, promise: trackedJob };
}

function queueAutoPOVScenes(options) {
  const { db, sessionId, index, characters, sendToSession } = options;
  const settings = loadPOVImageSettings(db);
  if (settings.pov_image_enabled !== 'true' || settings.pov_image_auto_enabled !== 'true') return 0;
  if (!settings.pov_image_endpoint || !settings.pov_image_api_key || !settings.pov_image_model) return 0;

  let queued = 0;
  for (const character of characters || []) {
    const result = queuePOVSceneGeneration({ ...options, character, settings });
    if (!result.started) continue;
    queued++;
    result.promise
      .then(() => sendToSession(sessionId, 'session_updated', { id: sessionId, reason: 'pov_image' }))
      .catch(error => logger.error('Automatic POV scene image generation failed', {
        sessionId,
        characterId: character.id,
        error: error.message
      }));
  }
  return queued;
}

function prunePOVSceneImages(db, keepRecentTurns = 3) {
  const keepCount = Math.max(1, Math.min(10, Number.parseInt(keepRecentTurns, 10) || 3));
  const retainedUrls = new Set();
  let removedImages = 0;
  let removedFiles = 0;
  let sessionsUpdated = 0;

  const sessions = db.prepare('SELECT id, full_history FROM game_sessions').all();
  for (const session of sessions) {
    let history;
    try { history = JSON.parse(session.full_history || '[]'); } catch (error) { continue; }
    const illustratedIndexes = history
      .map((entry, index) => Object.keys(entry?.povImages || {}).length ? index : -1)
      .filter(index => index >= 0);
    const keptIndexes = new Set(illustratedIndexes.slice(-keepCount));
    let changed = false;

    for (const index of keptIndexes) {
      for (const scene of Object.values(history[index].povImages || {})) {
        if (scene?.url) retainedUrls.add(scene.url);
      }
    }

    for (const index of illustratedIndexes) {
      const scenes = Object.values(history[index].povImages || {});
      if (keptIndexes.has(index)) continue;
      for (const scene of scenes) {
        if (scene?.url && !retainedUrls.has(scene.url) && deletePOVSceneImage(scene.url)) removedFiles++;
        removedImages++;
      }
      delete history[index].povImages;
      changed = true;
    }

    if (changed) {
      db.prepare('UPDATE game_sessions SET full_history = ? WHERE id = ?').run(JSON.stringify(history), session.id);
      sessionsUpdated++;
    }
  }

  if (fs.existsSync(POV_SCENE_DIR)) {
    for (const directory of fs.readdirSync(POV_SCENE_DIR, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^[A-Za-z0-9-]+$/.test(directory.name)) continue;
      const directoryPath = path.join(POV_SCENE_DIR, directory.name);
      for (const file of fs.readdirSync(directoryPath, { withFileTypes: true })) {
        if (!file.isFile() || !/^[A-Za-z0-9.-]+$/.test(file.name)) continue;
        const imageUrl = `/uploads/pov-scenes/${directory.name}/${file.name}`;
        if (retainedUrls.has(imageUrl)) continue;
        try {
          fs.unlinkSync(path.join(directoryPath, file.name));
          removedFiles++;
        } catch (error) {}
      }
      try {
        if (fs.readdirSync(directoryPath).length === 0) fs.rmdirSync(directoryPath);
      } catch (error) {}
    }
  }

  return {
    keepRecentTurns: keepCount,
    keptImages: retainedUrls.size,
    removedImages,
    removedFiles,
    sessionsUpdated
  };
}

function queuePOVImageCleanup(db, keepRecentTurns = 3) {
  const cleanup = povImageQueue
    .catch(() => {})
    .then(() => prunePOVSceneImages(db, keepRecentTurns));
  povImageQueue = cleanup.catch(() => {});
  return cleanup;
}

module.exports = {
  normalizeProvider,
  buildEndpoint,
  decodeImageData,
  extractChatImage,
  generatePOVSceneImage,
  loadCharacterReference,
  savePOVSceneImage,
  deletePOVSceneImage,
  deleteEntryPOVImages,
  deleteSessionPOVScenes,
  loadPOVImageSettings,
  generateAndPersistPOVScene,
  queuePOVSceneGeneration,
  queueAutoPOVScenes,
  prunePOVSceneImages,
  queuePOVImageCleanup
};
