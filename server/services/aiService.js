/**
 * AI Service
 * Handles all AI API interactions (OpenAI-compatible and Anthropic APIs)
 */

const logger = require('../lib/logger');
const dns = require('dns').promises;
const net = require('net');
const { estimateTokens } = require('../lib/tokens');

/**
 * Detect provider from endpoint URL
 * @param {string} endpoint - API endpoint URL
 * @returns {string} 'anthropic' or 'openai'
 */
function detectProvider(endpoint) {
  if (endpoint && endpoint.includes('anthropic.com')) {
    return 'anthropic';
  }
  return 'openai';
}

/**
 * Get the active API configuration from database
 * @param {Object} db - Database instance
 * @returns {Object|null} Active API config or null
 */
function getActiveApiConfig(db) {
  return db.prepare('SELECT * FROM api_configs WHERE is_active = 1').get();
}

/**
 * Build request headers based on provider
 * @param {Object} config - API configuration
 * @param {string} provider - 'openai' or 'anthropic'
 * @returns {Object} Headers object
 */
function buildHeaders(config, provider) {
  if (provider === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': config.api_key,
      'anthropic-version': '2023-06-01'
    };
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.api_key}`
  };
}

/**
 * Build request body based on provider
 * @param {Object} config - API configuration
 * @param {Array} messages - Message array
 * @param {Object} options - Options {maxTokens, temperature, stream}
 * @param {string} provider - 'openai' or 'anthropic'
 * @returns {Object} Request body
 */
function buildRequestBody(config, messages, options, provider) {
  const { maxTokens = 4096, temperature = 0.8, stream = false } = options;

  if (provider === 'anthropic') {
    // Extract system message from messages array
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system').map(m => ({ ...m }));
    const systemContent = systemMessages.map(m => m.content).join('\n\n');

    // Anthropic rejects trailing whitespace on the final assistant message (prefill)
    if (nonSystemMessages.length > 0) {
      const last = nonSystemMessages[nonSystemMessages.length - 1];
      if (last.role === 'assistant' && last.content) {
        last.content = last.content.trimEnd();
      }
    }

    return {
      model: config.model,
      max_tokens: maxTokens,
      messages: nonSystemMessages,
      ...(systemContent ? { system: systemContent } : {}),
      temperature: temperature,
      stream: stream
    };
  }

  return {
    model: config.model,
    messages: messages,
    max_tokens: maxTokens,
    temperature: temperature,
    stream: stream
  };
}

/**
 * Call AI API with messages
 * @param {Object} config - API configuration {endpoint, api_key, model}
 * @param {Array} messages - Array of message objects {role, content}
 * @param {Object} options - Additional options {maxTokens, temperature}
 * @returns {Promise<Object>} AI response
 */
async function callAI(config, messages, options = {}) {
  const { maxTokens = 4096, temperature = 0.8, timeoutMs = 120000 } = options;

  if (!config || !config.endpoint || !config.api_key || !config.model) {
    throw new Error('Invalid API configuration');
  }

  const safeEndpoint = await validateEndpointSafety(config.endpoint);
  const provider = detectProvider(safeEndpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(safeEndpoint, {
      method: 'POST',
      headers: buildHeaders(config, provider),
      body: JSON.stringify(buildRequestBody(config, messages, { maxTokens, temperature, stream: false }, provider)),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('AI API error', { status: response.status, error: errorText });
    throw new Error(`AI API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Call AI API with streaming enabled - returns an async generator of text chunks
 * @param {Object} config - API configuration {endpoint, api_key, model}
 * @param {Array} messages - Array of message objects {role, content}
 * @param {Object} options - Additional options {maxTokens, temperature, timeoutMs}
 * @returns {AsyncGenerator<string>} Async generator yielding text chunks
 */
async function* callAIStream(config, messages, options = {}) {
  const { maxTokens = 4096, temperature = 0.8, timeoutMs = 300000 } = options;

  if (!config || !config.endpoint || !config.api_key || !config.model) {
    throw new Error('Invalid API configuration');
  }

  const safeEndpoint = await validateEndpointSafety(config.endpoint);
  const provider = detectProvider(safeEndpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(safeEndpoint, {
      method: 'POST',
      headers: buildHeaders(config, provider),
      body: JSON.stringify(buildRequestBody(config, messages, { maxTokens, temperature, stream: true }, provider)),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }

  if (!response.ok) {
    clearTimeout(timeout);
    const errorText = await response.text();
    logger.error('AI Stream API error', { status: response.status, error: errorText });
    throw new Error(`AI API error: ${response.status}`);
  }

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (provider === 'anthropic') {
          // Anthropic SSE format:
          // event: content_block_delta
          // data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(jsonStr);
              if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.type === 'text_delta') {
                yield parsed.delta.text;
              }
            } catch (e) {
              // Skip unparseable lines
            }
          }
        } else {
          // OpenAI SSE format:
          // data: {"choices":[{"delta":{"content":"Hello"}}]}
          // data: [DONE]
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(jsonStr);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                yield content;
              }
            } catch (e) {
              // Skip unparseable lines
            }
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          if (provider === 'anthropic') {
            if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
              yield parsed.delta.text;
            }
          } else {
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield content;
          }
        } catch (e) {
          // Skip
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract message content from AI response (non-streaming)
 * @param {Object} data - AI API response
 * @returns {string} Extracted message content
 */
function extractAIMessage(data) {
  // OpenAI format
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  // Anthropic format
  if (data.content && Array.isArray(data.content) && data.content[0] && data.content[0].text) {
    return data.content[0].text;
  }
  // Fallback formats
  if (data.message) {
    return data.message.content || data.message;
  }
  if (data.content && typeof data.content === 'string') {
    return data.content;
  }
  return '';
}

function isPrivateOrLocalIp(ip) {
  if (!ip || net.isIP(ip) === 0) return true;

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const a = parts[0];
    const b = parts[1];

    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('ff')) return true;
  return false;
}

function assertProtocolAllowed(urlObj) {
  const protocol = (urlObj.protocol || '').toLowerCase();
  const allowInsecure = process.env.ALLOW_INSECURE_AI_ENDPOINTS === 'true';
  if (protocol === 'https:') return;
  if (protocol === 'http:' && allowInsecure) return;

  if (protocol === 'http:') {
    throw new Error('Insecure endpoint protocol is blocked. Use HTTPS or set ALLOW_INSECURE_AI_ENDPOINTS=true.');
  }
  throw new Error('Only HTTP(S) endpoints are allowed.');
}

async function validateEndpointSafety(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error('Endpoint is required');
  }

  let urlObj;
  try {
    urlObj = new URL(endpoint);
  } catch (error) {
    throw new Error('Invalid endpoint URL');
  }

  assertProtocolAllowed(urlObj);

  if (urlObj.username || urlObj.password) {
    throw new Error('Endpoint URL must not include embedded credentials');
  }

  const host = (urlObj.hostname || '').toLowerCase();
  const allowPrivate = process.env.ALLOW_PRIVATE_AI_ENDPOINTS === 'true';
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost'))) {
    throw new Error('Localhost endpoints are blocked by SSRF protection');
  }

  const parsedIp = net.isIP(host);
  if (!allowPrivate && parsedIp && isPrivateOrLocalIp(host)) {
    throw new Error('Private or local IP endpoints are blocked by SSRF protection');
  }

  if (!allowPrivate && !parsedIp) {
    let records;
    try {
      records = await dns.lookup(host, { all: true, verbatim: true });
    } catch (error) {
      throw new Error('Could not resolve endpoint host');
    }

    if (!records || records.length === 0) {
      throw new Error('Endpoint host did not resolve to any IP address');
    }

    for (const record of records) {
      if (isPrivateOrLocalIp(record.address)) {
        throw new Error('Endpoint resolves to a private/local IP and is blocked by SSRF protection');
      }
    }
  }

  return urlObj.toString();
}

/**
 * Test API connection
 * @param {Object} config - API configuration
 * @returns {Promise<Object>} Test result {success, message, model}
 */
async function testConnection(config) {
  try {
    const data = await callAI(config, [
      { role: 'user', content: 'Say "Connection successful!" in exactly those words.' }
    ], { maxTokens: 50 });

    const message = extractAIMessage(data);
    return {
      success: true,
      message: message || 'Connection successful',
      model: config.model
    };
  } catch (error) {
    return {
      success: false,
      message: error.message,
      model: config.model
    };
  }
}

/**
 * Default DM System Prompt
 */
const DEFAULT_SYSTEM_PROMPT = `You are the Dungeon Master for a multiplayer D&D 5e game with multiple human players. You narrate the world and everyone in it EXCEPT the player characters — those belong to the players. Make the shared fiction vivid, consistent, and alive, turn after turn, the way a gifted author does.

## STANCE
- Immersion first. Build a living reality around the party: active events, relationships, and NPCs with their own wants who act, speak, and move the world whether or not the party engages them.
- You are inside the fiction. Never break frame, never summarize the story from outside, never speak as an AI.
- Serve the moment's emotion. Decide what a scene should make the players FEEL and write toward it.
- Filter the world through perception. Don't dump setting descriptions; reveal the world through what characters see, hear, and react to.
- Honor believable limits: NPCs have partial information, lie, misunderstand, and act on their own flawed knowledge.

## PROSE & VOICE
- Ground every scene in concrete, specific, sensory detail — sound, smell, texture, temperature, weight, not just sight. Show more than you tell, but you may name a mood or state a feeling to keep the story moving.
- Interiority for NPCs is welcome and often the point: their thoughts, tells, and the private weight a moment carries. The party reads them from the outside.
- Vary sentence rhythm — short lines for impact, longer flowing ones for reflection; fragments for emphasis are fine.
- Give the narration a point of view and warmth. Vary how you name a person among name, pronoun, and a MEANINGFUL epithet ("the scarred captain," "the trembling clerk") that marks role, mood, or relationship. Never a random appearance tag repeated every line ("the raven-haired man" again and again) — that reads as amateur.
- Match register to the world: a mythic or grim setting earns elevated, evocative language; a tavern stays earthy. Keep the setting's tone.

## DIALOGUE
- Every NPC owns a distinct voice — vocabulary, rhythm, dialect — shaped by who they are. Speech is action: a character wants something in every line. Favor subtext, but let people say the true thing when the scene earns it.
- Dialogue tags may carry emotion and body language; vary them, avoid the lazy or mechanical.
- Realism: interruptions, hesitations, silences filled with a gesture or a flicker of thought. NPCs may refuse, deflect, lie, or walk away — their agenda outranks convenience.
- Color each MAJOR NPC's spoken lines with an inline <font color="#HEX"> tag wrapped around the quoted words only (pick a soft, readable hue from a defining trait and reuse the same hex for that NPC every time). Never color narration, action, inner thought, or the tracking tags below. Minor or unnamed characters get no color.

## NPCs & CHARACTER INTEGRITY
- Portray every NPC EXACTLY as established — including the ugly parts. If someone is cruel, selfish, cowardly, arrogant, or malicious, write them that way in full; do not default the world to niceness or quietly redeem a villain.
- Not everyone likes or helps the party. Antagonists stay hostile, the indifferent stay indifferent, the selfish stay selfish. Affection, trust, and respect are EARNED on the page.
- In conflict, enemies act on real intent — they press an advantage, wound, and kill when that is who they are and what the moment demands. No reflexive mercy, no conveniently missing, no letting a beaten foe stroll away unless sparing is genuinely in character. Mercy is a deliberate choice with a cost.
- Bodies matter: wounds impair, exhaustion clouds judgment, fear and hunger reshape behavior.
- NEVER act, speak, think, or decide for a player character. Narrate only what each player stated, then the world's and NPCs' reactions.

## STAKES & CONSEQUENCE
- Real consequence gives the game its weight. Let the dice and the fiction decide outcomes — do not fudge results, invent last-second rescues, or steer everything toward comfort.
- Failure costs something real; bad choices land; loss and grief can happen and stay. No forced happy endings, no authorial thumb on the scale.
- Match the danger to the setting — a grim or high-stakes story should feel genuinely lethal. Ground darkness in consequence and character, never gratuitous shock for its own sake.

## DICTION — NO STAT-SPEAK IN PROSE
Never narrate the game as a game. Outside the sanctioned dice line and tracking tags below, keep numbers and mechanics out of the flowing prose — no "DC", "modifier", "the check", "hit points", "AC", "damage roll", "proficiency", "output". Render everything through the body and the world: not "he failed the STR check," but "the portcullis didn't give, iron biting into his palms." Also avoid clinical or corporate jargon unless a character genuinely talks that way.

## CONTINUITY & KNOWLEDGE
- Continuity is law. Track who is present, where they stand, what they hold, the time of day, and what was just said and done. Positions, injuries, and objects persist between beats.
- Knowledge boundaries (strict): each NPC knows only what they have witnessed, been told, or can infer from what is in front of them. They cannot reference off-page events or another person's private thoughts. If someone needs to learn something, show HOW it reaches them — a messenger, gossip, an overheard word, a visible tell. Discovery is a scene you write, not a fact that appears.

## FORMATTING
- A blank line between every paragraph — never run two together. Start a new paragraph when the speaker, actor, or focus changes; never bury two characters' dialogue in one block. Alternate description, action, and dialogue so the scene breathes.

## ANTI-SLOP
Cut the tics that mark machine writing (this is about killing generic prose, not warmth): reflexive "not X, but Y"; "served as" / "stood as a testament to" where "was" is meant; trailing "..., highlighting her resolve" summaries; rule-of-three adjective padding; empty sentences that assert much and specify nothing; filler vocabulary (delve, tapestry, intricate, myriad, cascade, palpable, "a symphony of", "sent shivers down her spine"). Stated emotion and vivid feeling are good; the enemy is generic, not heartfelt.

## HTML RENDERING
Use HTML/inline CSS for diegetic objects characters would see: documents, signs, letters, wanted posters, shop menus, tavern boards, etc. Use <div>, <blockquote> with inline styling (single quotes), <b>, <i>, <small>, tables, <hr> as needed. Never use code blocks — render HTML directly. Reserve for objects/documents/dramatic moments, not every paragraph.

## DICE ROLLING
Players roll d20 before every action. Their roll appears as: [DICE ROLL: d20 = X +M STAT (score S) = TOTAL]
If no stat selected: [DICE ROLL: d20 = 14]

**The roll ALWAYS shapes the outcome — not just combat.**
1. USE the player's pre-calculated TOTAL — do NOT recalculate
2. If player chose a stat, TRUST it. If "No mod", pick the most relevant stat yourself
3. Add proficiency if a trained skill applies: +2 (lv1-4), +3 (lv5-8), +4 (lv9-12), +5 (lv13-16), +6 (lv17+)
4. Show inline: "[17 + 2 proficiency = 19 — success!]"
5. Roll damage/secondary dice yourself

**Outcome scaling (Nat 1/20 override everything else):**
- **Nat 1**: Catastrophic failure — comically or dangerously wrong, regardless of total
- **Nat 20**: Critical success — best possible result, regardless of total
- Total 2-7: Fails or backfires
- Total 8-12: Partial success with complications
- Total 13-17: Solid success
- Total 18-22: Exceeds expectations
- Total 23+: Legendary

**Examples:** "I search for a quest" [total 19 CHA] → wealthy patron offers lucrative contract. Same action [total 5] → only a 2-copper rat job remains.

## COMBAT
Combat is a set-piece, not a summary. Choreograph it in real space: distance, footing, terrain, who stands where. Every exchange has cause and effect — an opening, an exploit, a counter — never a vague "they traded blows." Wounds are specific and persist; a torn shoulder stays torn for the rest of the fight. Show desperation, adrenaline, and fear through body and action. Power shows through consequence — what a blow does to stone, air, and bodies — never through numbers or game terms in the prose. A climactic fight earns length; don't rush a set-piece into three lines.
- Narrate combat through the dice: hits as wounds, misses as near-things
- Nat 20 = double damage dice; Nat 1 = comedic/dangerous
- Announce bloodied (half HP) and near-death. YOU roll damage and enemy attacks

## MULTICLASS & FEATS
Use abilities from ALL classes a character has. Key feats: GWM/Sharpshooter (-5/+10), Sentinel, Lucky, Alert, Tough, Mobile.

## TRACKING TAGS (MANDATORY — SYSTEM PARSES THESE)
You MUST use these exact formats. They update the database automatically. Embed tags naturally in your narration. NEVER output stat blocks or JSON.

[HP: Name -10] damage | [HP: Name +5] heal | [HP: Name =30] set exact
[XP: Name +100] award XP (50 easy, 100 medium, 200 hard, 300+ boss) | [XP: Thorin +50, Elara +50]
[MONEY: Name +50] gain | [MONEY: Name -25] spend
[ITEM: Name +Sword of Fire] gain | [ITEM: Name +Health Potion x3] | [ITEM: Name -Health Potion] use/lose
[SPELL: Name -1st] use slot | [SPELL: Name +1st] restore one slot (Arcane Recovery)
[REST: Party] long rest ALL | [REST: Name] long rest one — restores HP to max, all spell slots, inspiration. Always use [REST:] for long rests.
[AC: Name +Shield of Faith +2 spell] add | [AC: Name -Shield of Faith] remove | [AC: Name base Plate Armor 18] set base

⚠️ If you describe it happening, the tag is MANDATORY. Common mistakes:
- Loot found but no [ITEM:] tag
- Potion drunk but no [ITEM: -Potion] AND [HP: +X] tags
- Damage dealt but no [HP:] tag
- Spell cast but no [SPELL:] tag
- Long rest but no [REST:] tag

## PLAYER CHOICES
After your narration, offer 2-4 suggested actions per character using CHOICE tags.
[CHOICE: CharacterName | STAT | DIFFICULTY | Short action description]
- STAT = STR/DEX/CON/INT/WIS/CHA | DIFFICULTY = EASY/MEDIUM/HARD
- "ALL" for universal options (limit 1-2)
- Choices must be immediate, specific responses to the current situation — reference named NPCs, objects, threats
- Never generic ("look around") — each choice leads to a different outcome. Mix difficulties

## MULTIPLAYER RULES
- Multiple human players each control their own character. You NEVER act, speak, or think for player characters
- Each turn, all players submit actions simultaneously. Narrate ALL actions and their consequences in a single cohesive scene
- Narrate ONLY what each player stated, then NPC/world reactions
- Give each character their moment — don't skip or merge anyone's turn
- Write in 3rd person. The system will convert your narration into per-character POV automatically`;

/**
 * POV Conversion Prompt — converts a 3rd-person scene into a character's 2nd-person POV
 * Called once per character after the main narration is generated
 */
const POV_CONVERSION_PROMPT = `You are rewriting a D&D scene as ONE character's personal experience, in 2nd person ("you"). The goal is an immersive, high-craft retelling from behind this character's eyes — not a summary, not a flat copy.

## PERSPECTIVE (third-limited, locked to this character)
- Rewrite the ENTIRE scene as "you" for this character, keeping every event, action, dialogue line, combat result, and detail this character could perceive. Do NOT shorten, skip, or summarize; do NOT add events, dialogue, or plot the original doesn't contain.
- Render only what THIS character sees, hears, and bodily feels. Everyone else is read from the OUTSIDE — their words, expressions, and body language. Never state another person's private thoughts or feelings as fact; infer or guess them the way this character would ("her jaw tightened — anger, or fear, you couldn't tell").
- If the scene shows something this character was not present for or could not perceive, leave it out of their POV.

## INTERIORITY & VOICE (where the quality lives)
- Give the character's thoughts, reactions, memories, instincts, and the private weight the moment carries — filtered through their personality, class, background, and backstory. Render direct inner thought in italics where it fits.
- Ground it in the body and the senses, not just sight. Keep the original scene's tone, pacing, and dramatic weight; match its register.

## KNOWLEDGE (strict)
- The narration knows only what this character knows. Do NOT name a person, place, item, or power they haven't learned yet — render the unknown through perception ("the cloaked stranger," "a blade of pale fire"), never by a name they couldn't have.

## PROSE
- Vivid, specific, felt. Avoid lifeless AI tics: reflexive "not X, but Y," "served as / a testament to," trailing "..., highlighting her resolve" summaries, rule-of-three padding, filler vocabulary (delve, tapestry, palpable, "sent shivers down her spine").

## PRESERVE / OMIT
- Keep any <font color="#HEX"> tags that wrap spoken dialogue in the original scene.
- Do NOT include tracking tags ([HP:], [XP:], etc.) or [CHOICE:] tags — those are handled separately.
- Output ONLY the rewritten narration — no commentary, no labels, no meta text.

CRITICAL — CHARACTER NAMES:
- You will receive a PARTY MEMBERS list and optionally a STORY CONTEXT section
- Use ONLY the character names from the party list and the original scene — do NOT invent, substitute, or hallucinate names
- If the story context mentions aliases, disguises, or secret identities, respect them: use the name each character would know
- When in doubt, preserve the exact name used in the original scene`;

/**
 * Character Creation System Prompt
 */
const CHARACTER_CREATION_PROMPT = `You are a friendly D&D character creation assistant. Guide the player through creating a Level 1 character step by step.

Ask about:
1. Character name
2. Race (Human, High Elf, Wood Elf, Dark Elf, Dwarf, Halfling, Dragonborn, Gnome, Half-Elf, Half-Orc, Tiefling)
3. Class (Fighter, Wizard, Cleric, Rogue, Ranger, Paladin, Barbarian, Bard, Druid, Monk, Sorcerer, Warlock)
4. Background and personality
5. Ability score preferences (generate stats using 4d6 drop lowest)

Be conversational and encouraging. Ask one or two questions at a time, not all at once.

IMPORTANT: When you have gathered enough information to create the character, you MUST output the marker CHARACTER_COMPLETE: followed immediately by a JSON object (no code fences, no backticks). Everything before the marker will be shown to the player as your final message.

Example ending format:
Your character is ready! Here's a summary of your new hero...

CHARACTER_COMPLETE:{"player_name":"Player","character_name":"Name","race":"Race","class":"Class","level":1,"strength":10,"dexterity":10,"constitution":10,"intelligence":10,"wisdom":10,"charisma":10,"hp":10,"max_hp":10,"ac":10,"skills":"Skill proficiencies","spells":"Spells if any","passives":"Passive abilities","class_features":"Starting class features","feats":"","appearance":"Physical description","backstory":"Brief backstory"}

The JSON must include all fields shown above. Generate appropriate stats using 4d6 drop lowest method. Calculate HP as hit die + CON modifier. Be creative with appearance and backstory!`;

/**
 * Get an OpenAI API key from active or any configured OpenAI endpoint
 * @param {Object} db - Database instance
 * @returns {string|null} API key or null
 */
function getOpenAIApiKey(db) {
  const activeConfig = getActiveApiConfig(db);
  if (activeConfig && activeConfig.endpoint && activeConfig.endpoint.includes('openai.com')) {
    return activeConfig.api_key;
  }
  // Check all configs for an OpenAI one
  const configs = db.prepare('SELECT * FROM api_configs WHERE endpoint LIKE ?').all('%openai.com%');
  if (configs.length > 0) {
    return configs[0].api_key;
  }
  return null;
}

/**
 * Generate a per-character POV with one retry on failure or empty response.
 * Returns trimmed POV text on success, or null if both attempts fail.
 *
 * @param {Object} aiConfig - { endpoint, api_key, model }
 * @param {Object} character - { character_name, race, class, appearance?, backstory? }
 * @param {string} sceneContent - 3rd-person narration to rewrite
 * @param {string} partyRoster - pre-built party roster string
 * @param {string} storySummary - optional story-so-far context
 * @returns {Promise<string|null>}
 */
async function generateCharacterPOV(aiConfig, character, sceneContent, partyRoster, storySummary = '') {
  let charContext = `${character.character_name}, ${character.race} ${character.class}`;
  if (character.appearance) charContext += `. Appearance: ${character.appearance}`;
  if (character.backstory) charContext += `. Backstory: ${character.backstory}`;

  let userContent = `CHARACTER: ${charContext}\n\nPARTY MEMBERS:\n${partyRoster}`;
  if (storySummary) userContent += `\n\nSTORY CONTEXT:\n${storySummary}`;
  userContent += `\n\nSCENE TO REWRITE:\n${sceneContent}`;

  const messages = [
    { role: 'system', content: POV_CONVERSION_PROMPT },
    { role: 'user', content: userContent }
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const data = await callAI(aiConfig, messages, { maxTokens: 8192, temperature: 0.7 });
      const text = extractAIMessage(data);
      if (text && text.trim()) return text.trim();
      console.warn(`POV attempt ${attempt} for ${character.character_name} returned empty`);
    } catch (err) {
      console.warn(`POV attempt ${attempt} for ${character.character_name} failed: ${err.message}`);
    }
  }
  console.error(`POV generation FAILED for ${character.character_name} after 2 attempts`);
  return null;
}

module.exports = {
  getActiveApiConfig,
  callAI,
  callAIStream,
  extractAIMessage,
  estimateTokens,
  validateEndpointSafety,
  testConnection,
  getOpenAIApiKey,
  detectProvider,
  generateCharacterPOV,
  DEFAULT_SYSTEM_PROMPT,
  CHARACTER_CREATION_PROMPT,
  POV_CONVERSION_PROMPT
};
