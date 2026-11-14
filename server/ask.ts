// Replies that have to be JSON. Apart from llm.ts so the tests can fake callModel under it.
import { addUsage, callModel, zeroUsage, type CallOpts, type Conn, type ThinkingLevel, type Usage } from './llm.ts';
import { clip, extractJson } from './util.ts';

// Thinking counts against the output limit, so a model that thinks gets room for it on top of the reply.
export const withRoom = (conn: Conn, reply: number, level: ThinkingLevel = conn.thinking_level) => reply + (level === 'off' ? 0 : 8000);

// A reply that has to be JSON (and pass ok), with room to think. One that runs out or can't be read is asked for again, with twice
// the room when it ran out. json is null when every try failed, and why says how the last one went.
export async function callJson<T = any>(o: CallOpts, opt: { tries?: number; ok?: (j: any) => boolean } = {}): Promise<{ json: T | null; usage: Usage; why: string }> {
  let usage = zeroUsage(), why = '', limit = withRoom(o.conn, o.maxTokens ?? o.conn.max_tokens, o.thinking ?? o.conn.thinking_level);
  for (let n = 0; n < (opt.tries ?? 2); n++) {
    const r = await callModel({ ...o, maxTokens: limit });
    usage = addUsage(usage, r.usage);
    const j = extractJson<T>(r.text);
    if (j && (opt.ok ?? Boolean)(j)) return { json: j, usage, why: '' };
    if (r.stopReason === 'max_tokens') {
      why = `It ran out of room at ${r.usage.output} tokens${r.text.trim() ? '' : ', all of it thinking'}.`;
      limit = Math.min(32000, limit * 2);
    } else why = clip(r.text, 200);
  }
  return { json: null, usage, why };
}
