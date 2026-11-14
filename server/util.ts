export const now = () => new Date().toISOString();

// Rough token estimate (Claude tokenizers average ~3.6 chars per token on English prose).
export const estTokens = (s: string | null | undefined) => Math.ceil((s?.length ?? 0) / 3.6);

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function clip(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// Pull the first JSON object or array out of model text (tolerates ```json fences and chatter).
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const open = c[start], close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try { return JSON.parse(c.slice(start, i + 1)) as T; } catch { break; }
      }
    }
  }
  return null;
}

export function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
