import Anthropic from '@anthropic-ai/sdk';

export type ApiType = 'anthropic' | 'openai';
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PostProcessing = 'none' | 'merge' | 'semi' | 'strict' | 'single';

export type Conn = {
  id: number; name: string; api_type: ApiType; endpoint: string; api_key: string; model: string;
  thinking_level: ThinkingLevel; show_thinking: boolean; max_tokens: number; post_processing: PostProcessing; caching: boolean; default_role?: string;
};

// Internal message format = Anthropic content blocks (text, tool_use, tool_result, thinking, redacted_thinking).
export type Block = { type: string; [k: string]: any };
export type Msg = { role: 'user' | 'assistant'; content: Block[] };
// cache '1h': text that stays the same from turn to turn (rules, the story so far). A reader takes longer than five minutes
// over a passage, so the short cache is gone by the next turn and the whole prompt is paid for again, at a premium.
export type SysPart = { text: string; cache?: boolean | '1h' };
export const HOUR = { type: 'ephemeral', ttl: '1h' } as const;
export type ToolDef = { name: string; description: string; input_schema: any };

export type CallOpts = {
  conn: Conn;
  system: SysPart[];
  messages: Msg[];
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
};

// hour: how much of cacheWrite went to the one-hour cache.
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; hour?: number };
export type CallResult = {
  content: Block[]; text: string; thinking: string;
  toolUses: { id: string; name: string; input: any }[];
  stopReason: string; usage: Usage; model: string;
};

export class LlmError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}

export const supportsTools = (c: Conn) => c.post_processing !== 'single';

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, hour: (a.hour ?? 0) + (b.hour ?? 0) };
}
export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function anthropicBase(endpoint: string) {
  let e = endpoint.trim().replace(/\/+$/, '');
  e = e.replace(/\/v1\/messages$/, '').replace(/\/messages$/, '').replace(/\/v1$/, '');
  return e;
}
export function openaiBase(endpoint: string) {
  return endpoint.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

// ---------------------------------------------------------------- post-processing (our own messages only)

function mergeRoles(msgs: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = [...last.content, ...m.content];
    else out.push({ role: m.role, content: [...m.content] });
  }
  return out;
}

function flattenText(blocks: Block[]) {
  return blocks.map(b => b.type === 'text' ? b.text : b.type === 'tool_result'
    ? `[tool result]\n${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}`
    : b.type === 'tool_use' ? `[tool call ${b.name} ${JSON.stringify(b.input)}]` : '').filter(Boolean).join('\n\n');
}

function applyPostProcessing(pp: PostProcessing, system: SysPart[], msgs: Msg[]): { system: SysPart[]; messages: Msg[] } {
  if (pp === 'none') return { system, messages: msgs };
  if (pp === 'single') {
    const text = [system.map(s => s.text).join('\n\n'), ...msgs.map(m => (m.role === 'assistant' ? 'Assistant:\n' : '') + flattenText(m.content))].join('\n\n');
    return { system: [], messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
  }
  let messages = mergeRoles(msgs);
  if ((pp === 'strict') && messages[0]?.role !== 'user') messages = [{ role: 'user', content: [{ type: 'text', text: '[Start]' }] }, ...messages];
  return { system, messages };
}

// ---------------------------------------------------------------- Anthropic

// Remember which "thinking off" variant each model accepts (Opus 5.5 rejects disabled; Sonnet 5.5 takes between_tools).
const offVariant = new Map<string, number>();
const OFF_VARIANTS = [
  { thinking: { type: 'disabled' } },
  { thinking: { type: 'between_tools' }, output_config: { effort: 'high' } },
  { thinking: { type: 'adaptive', display: 'omitted' }, output_config: { effort: 'low' } },
];

function thinkingParams(level: ThinkingLevel, show: boolean, model: string, variant?: number): any {
  if (level === 'off') return OFF_VARIANTS[variant ?? offVariant.get(model) ?? 0];
  return { thinking: { type: 'adaptive', display: show ? 'summarized' : 'omitted' }, output_config: { effort: level } };
}

const noHour = new Set<string>();
const clients = new Map<string, Anthropic>();
function anthropicClient(c: Conn) {
  const key = `${c.endpoint}|${c.api_key}`;
  let cl = clients.get(key);
  if (!cl) {
    cl = new Anthropic({ apiKey: c.api_key || 'none', baseURL: anthropicBase(c.endpoint), maxRetries: 2, timeout: 15 * 60 * 1000 });
    clients.set(key, cl);
  }
  return cl;
}

async function callAnthropic(o: CallOpts): Promise<CallResult> {
  const c = o.conn;
  const level = o.thinking ?? c.thinking_level;
  const pp = applyPostProcessing(c.post_processing, o.system, o.messages);
  const useTools = supportsTools(c) && o.tools && o.tools.length > 0;
  const cache = c.caching;
  const hour = !noHour.has(c.endpoint);
  const system: any[] = pp.system.map(s => ({ type: 'text', text: s.text, ...(cache && s.cache ? { cache_control: s.cache === '1h' && hour ? HOUR : { type: 'ephemeral' } } : {}) }));
  const messages = pp.messages.map(m => ({
    role: m.role,
    content: m.content.map(b => {
      if (!cache && b.cache_control) { const { cache_control, ...rest } = b; return rest; }
      if (!hour && b.cache_control?.ttl) return { ...b, cache_control: { type: 'ephemeral' } };
      return b;
    }),
  }));
  const hasHour = () => [...system, ...messages.flatMap(m => m.content)].some((b: any) => b.cache_control?.ttl);

  let variant = level === 'off' ? (offVariant.get(c.model) ?? 0) : undefined;
  let hourTry: '' | 'asked' | 'other' = '';
  for (;;) {
    const params: any = {
      model: c.model,
      max_tokens: o.maxTokens ?? c.max_tokens,
      messages,
      ...(system.length ? { system } : {}),
      ...thinkingParams(level, c.show_thinking, c.model, variant),
      ...(useTools ? { tools: o.tools, tool_choice: { type: o.toolChoice ?? 'auto' } } : {}),
    };
    let text = '', thinking = '';
    try {
      const stream = anthropicClient(c).messages.stream(params, { signal: o.signal });
      for await (const ev of stream as any) {
        if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') { text += ev.delta.text; o.onText?.(ev.delta.text); }
          else if (ev.delta.type === 'thinking_delta') { thinking += ev.delta.thinking; o.onThinking?.(ev.delta.thinking); }
        }
      }
      const msg: any = await stream.finalMessage();
      const content: Block[] = msg.content;
      const u = msg.usage || {};
      if (level === 'off') offVariant.set(c.model, variant ?? 0);
      if (hourTry === 'asked') noHour.add(c.endpoint);
      return {
        content,
        text: content.filter(b => b.type === 'text').map(b => b.text).join(''),
        thinking,
        toolUses: content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input })),
        stopReason: msg.stop_reason ?? 'end_turn',
        usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, hour: u.cache_creation?.ephemeral_1h_input_tokens ?? 0 },
        model: msg.model ?? c.model,
      };
    } catch (e: any) {
      if (o.signal?.aborted) throw e;
      const status = e?.status as number | undefined;
      const msg = String(e?.error?.error?.message ?? e?.message ?? e);
      // Thinking "off" fallback chain: only retry if nothing was streamed yet.
      if (level === 'off' && status === 400 && /thinking/i.test(msg) && !text && (variant ?? 0) < OFF_VARIANTS.length - 1) {
        variant = (variant ?? 0) + 1; continue;
      }
      // An endpoint that may not take the one-hour cache: try once with the ordinary one, and if that is what it was,
      // use the ordinary one from here on.
      if (hourTry === 'asked') hourTry = 'other';
      if (status === 400 && !text && hasHour()) {
        hourTry = 'asked';
        for (const b of system) if (b.cache_control) b.cache_control = { type: 'ephemeral' };
        for (const m of messages) m.content = m.content.map((b: any) => b.cache_control ? { ...b, cache_control: { type: 'ephemeral' } } : b);
        continue;
      }
      // Too many cache breakpoints (a proxy may add its own): keep only the system ones and retry.
      if (status === 400 && /cache_control|breakpoint/i.test(msg) && !text && messages.some(m => m.content.some((b: any) => b.cache_control))) {
        for (const m of messages) m.content = m.content.map((b: any) => { const { cache_control, ...rest } = b; return rest; });
        continue;
      }
      throw new LlmError(`${c.name}: ${status ? status + ' ' : ''}${msg}`, status);
    }
  }
}

// ---------------------------------------------------------------- OpenAI-compatible

function toOpenAI(system: SysPart[], msgs: Msg[]) {
  const out: any[] = [];
  if (system.length) out.push({ role: 'system', content: system.map(s => s.text).join('\n\n') });
  for (const m of msgs) {
    if (m.role === 'assistant') {
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const calls = m.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      const results = m.content.filter(b => b.type === 'tool_result');
      for (const r of results) out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content) });
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

async function callOpenAI(o: CallOpts): Promise<CallResult> {
  const c = o.conn;
  const level = o.thinking ?? c.thinking_level;
  const pp = applyPostProcessing(c.post_processing, o.system, o.messages);
  let messages = toOpenAI(pp.system, pp.messages);
  if (c.post_processing === 'semi' || c.post_processing === 'strict') {
    // One system message at the top, then strictly alternating user/assistant (tool messages pass through).
    const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const rest = messages.filter(m => m.role !== 'system');
    const merged: any[] = [];
    for (const m of rest) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role && m.role !== 'tool' && !last.tool_calls && !m.tool_calls) last.content = `${last.content ?? ''}\n\n${m.content ?? ''}`;
      else merged.push({ ...m });
    }
    messages = [...(sys ? [{ role: 'system', content: sys }] : []), ...merged];
    if (c.post_processing === 'strict' && merged[0]?.role !== 'user') messages.splice(sys ? 1 : 0, 0, { role: 'user', content: '[Start]' });
  }
  const useTools = supportsTools(c) && o.tools && o.tools.length > 0;
  const body: any = {
    model: c.model, stream: true, stream_options: { include_usage: true },
    max_tokens: o.maxTokens ?? c.max_tokens, messages,
    ...(useTools ? { tools: o.tools!.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })), tool_choice: o.toolChoice ?? 'auto' } : {}),
    ...(level !== 'off' ? { reasoning_effort: level === 'xhigh' || level === 'max' ? 'high' : level } : {}),
  };
  const res = await fetch(`${openaiBase(c.endpoint)}/chat/completions`, {
    method: 'POST', signal: o.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.api_key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new LlmError(`${c.name}: ${res.status} ${(await res.text()).slice(0, 500)}`, res.status);
  let text = '', thinking = '', stop = 'end_turn', model = c.model;
  const calls: Record<number, { id: string; name: string; args: string }> = {};
  const usage = zeroUsage();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j: any; try { j = JSON.parse(data); } catch { continue; }
      if (j.model) model = j.model;
      if (j.usage) {
        usage.input = j.usage.prompt_tokens ?? usage.input; usage.output = j.usage.completion_tokens ?? usage.output;
        usage.cacheRead = j.usage.prompt_tokens_details?.cached_tokens ?? usage.cacheRead;
      }
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || {};
      if (d.content) { text += d.content; o.onText?.(d.content); }
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) { thinking += r; o.onThinking?.(r); }
      for (const tc of d.tool_calls ?? []) {
        const k = tc.index ?? 0;
        calls[k] ??= { id: tc.id || `call_${k}_${Date.now()}`, name: '', args: '' };
        if (tc.id) calls[k].id = tc.id;
        if (tc.function?.name) calls[k].name += tc.function.name;
        if (tc.function?.arguments) calls[k].args += tc.function.arguments;
      }
      if (ch.finish_reason) stop = ch.finish_reason === 'tool_calls' ? 'tool_use' : ch.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
    }
  }
  const toolUses = Object.values(calls).map(cl => { let input: any = {}; try { input = JSON.parse(cl.args || '{}'); } catch { input = { _raw: cl.args }; } return { id: cl.id, name: cl.name, input }; });
  if (toolUses.length) stop = 'tool_use';
  const content: Block[] = [...(text ? [{ type: 'text', text }] : []), ...toolUses.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input }))];
  return { content, text, thinking, toolUses, stopReason: stop, usage, model };
}

export async function callModel(o: CallOpts): Promise<CallResult> {
  if (!o.conn.endpoint) throw new LlmError(`Connection "${o.conn.name}" has no endpoint set.`);
  return o.conn.api_type === 'openai' ? callOpenAI(o) : callAnthropic(o);
}

// ---------------------------------------------------------------- model list + connection test

export async function listModels(c: Pick<Conn, 'api_type' | 'endpoint' | 'api_key'>): Promise<string[]> {
  const res = c.api_type === 'openai'
    ? await fetch(`${openaiBase(c.endpoint)}/models`, { headers: { authorization: `Bearer ${c.api_key}` } })
    : await fetch(`${anthropicBase(c.endpoint)}/v1/models?limit=100`, { headers: { 'x-api-key': c.api_key, 'anthropic-version': '2023-06-01' } });
  if (!res.ok) throw new LlmError(`${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
  const j: any = await res.json();
  const list = (j.data ?? j.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
  return [...new Set<string>(list)].sort();
}

export async function testConnection(c: Conn) {
  const out: { step: string; ok: boolean; detail: string }[] = [];
  const t0 = Date.now();
  try {
    const r = await callModel({ conn: c, system: [{ text: 'Reply with the single word OK.' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'Ping.' }] }], maxTokens: 2000 });
    out.push({ step: 'Endpoint answers', ok: true, detail: `${r.model} replied "${r.text.trim().slice(0, 40)}" in ${((Date.now() - t0) / 1000).toFixed(1)}s` });
  } catch (e: any) {
    out.push({ step: 'Endpoint answers', ok: false, detail: e.message });
    return out;
  }
  if (supportsTools(c)) {
    try {
      const tool: ToolDef = { name: 'get_card', description: 'Look up a character card.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } };
      const r = await callModel({ conn: c, system: [{ text: 'You are testing tool use.' }], tools: [tool], messages: [{ role: 'user', content: [{ type: 'text', text: 'Use the tool to look up the card for "Test Character". Do not answer without calling it.' }] }], maxTokens: 4000 });
      out.push({ step: 'Tools', ok: r.toolUses.length > 0, detail: r.toolUses.length ? `called ${r.toolUses[0].name}` : `no tool call (stop: ${r.stopReason})` });
      out.push({ step: 'Thinking', ok: true, detail: r.thinking ? `summarized thinking received (${r.thinking.length} chars)` : c.thinking_level === 'off' ? 'off' : 'no thinking text this time (adaptive thinking may skip easy turns)' });
    } catch (e: any) { out.push({ step: 'Tools', ok: false, detail: e.message }); }
  } else out.push({ step: 'Tools', ok: true, detail: 'disabled by "Single user message" post-processing' });
  if (c.caching && c.api_type === 'anthropic') {
    try {
      const big = `Inkwell cache probe ${Date.now()}. ` + 'This sentence pads the cached prefix so it passes the minimum cacheable length. '.repeat(160);
      const call = () => callModel({ conn: c, system: [{ text: big, cache: '1h' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'Say OK.' }] }], maxTokens: 2000, thinking: 'low' });
      const r1 = await call();
      const r2 = await call();
      out.push({ step: 'Prompt caching', ok: r2.usage.cacheRead > 0, detail: `second call read ${r2.usage.cacheRead} cached tokens${r2.usage.cacheRead > 0 ? r1.usage.hour ? ', kept for an hour' : ', kept for five minutes (this endpoint does not take or report the one-hour cache)' : ''}` });
    } catch (e: any) { out.push({ step: 'Prompt caching', ok: false, detail: e.message }); }
  }
  return out;
}
