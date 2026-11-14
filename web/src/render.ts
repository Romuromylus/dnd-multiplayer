import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { spokenText } from '../../server/speech';

marked.setOptions({ gfm: true, breaks: false });

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
  // A character's dialogue color, also as a variable, so a light page can draw a darker shade of the same color.
  const fc = node.tagName === 'FONT' ? node.getAttribute('color')?.trim() : '';
  if (fc && /^#?[0-9a-z]+$/i.test(fc)) (node as HTMLElement).style.setProperty('--fc', /^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(fc) ? `#${fc}` : fc);
});

const PURIFY = {
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta'],
  ADD_ATTR: ['color', 'face', 'size'],
};

// Prose is model-written markdown with some HTML (font colors, diegetic documents). Scripts, styles blocks,
// iframes and event handlers are stripped; inline styles and <font color> survive.
// With quotes, quoted speech is wrapped in <span class="q"> so it can take the quote color.
export function renderProse(text: string, opts: { quotes?: boolean } = {}): string {
  const html = marked.parse(gameMarkup(text), { async: false }) as string;
  if (!opts.quotes) return DOMPurify.sanitize(html, PURIFY);
  const frag = DOMPurify.sanitize(html, { ...PURIFY, RETURN_DOM_FRAGMENT: true });
  markQuotes(frag);
  const div = document.createElement('div');
  div.appendChild(frag);
  return div.innerHTML;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function rollClass(result: string) {
  const r = result.toLowerCase();
  if (/critical fail|fumble/.test(r)) return 'fumble';
  if (/critical success|\bcrit/.test(r)) return 'crit';
  if (/strong success/.test(r)) return 'strong';
  if (/fail|miss/.test(r)) return 'fail';
  return 'ok';
}

// Dice lines, scene lines and Inspiration awards as their own blocks. A tag still streaming in is hidden until it closes.
function gameMarkup(text: string): string {
  if (!text.includes('<roll>') && !text.includes('<scene') && !text.includes('<inspiration>')) return text;
  return text
    .replace(/<inspiration>([^<]*)<\/inspiration>/g, (_, x: string) => {
      const [who = '', ...why] = x.split('|').map(v => v.trim());
      const reason = why.filter(Boolean).join(', ');
      return `\n\n<div class="insp-line"><span class="star">✦</span><span><b>${esc(who)}</b> earns Inspiration${reason ? `<span class="why">: ${esc(reason)}</span>` : ''}</span></div>\n\n`;
    })
    .replace(/<scene>([^<]*)<\/scene>/g, (_, x: string) => {
      const [place = '', ...when] = x.split('|').map(v => v.trim());
      return `\n\n<div class="scene-line"><span class="when">${esc(when.filter(Boolean).join(' · '))}</span><span class="where">${esc(place)}</span></div>\n\n`;
    })
    .replace(/<roll>([^<]*)<\/roll>/g, (_, x: string) => {
      const r = parseRoll(x);
      // An initiative roll has no DC: "—" (or an empty or zero DC from an older line) is left off.
      const vs = /^(—|-|–|DC 0|0)?$/i.test(r.vs) ? '' : /^\d+$/.test(r.vs) ? `DC ${r.vs}` : r.vs;
      if (/initiative/i.test(r.check)) r.result = /^(success|failure)$/i.test(r.result) ? 'rolled' : r.result;
      const math = `${r.mod && r.mod !== '+0' ? `${r.mod} ` : ''}= ${r.total}${vs ? ` vs ${vs}` : ''}`;
      return `\n\n<div class="roll r-${/initiative/i.test(r.check) ? 'init' : rollClass(r.result)}"><span class="die">${esc(r.die.startsWith('d') ? r.die : `d20 ${r.die}`)}</span><span class="who">${esc(r.who)}</span><span class="stat">${esc(r.check)}</span><span class="what">${esc(r.what)}</span><span class="math">${esc(math)}</span><span class="res">${esc(r.result)}</span></div>\n\n`;
    })
    .replace(/<(roll|scene|inspiration)>[^<]*$/, '');
}

// A roll line: who|check|what|d20|mod|total|DC or AC|result. An older seven-field line has no "who".
export function parseRoll(x: string) {
  const f = x.split('|').map(v => v.trim());
  if (f.length === 7) f.unshift('');
  const [who = '', check = '', what = '', die = '', mod = '', total = '', vs = '', ...res] = f;
  return { who, check, what, die, mod, total, vs, result: res.join(' | ') };
}

const OPEN = '“«「『', CLOSE = '”»」』';
const BLOCK = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, dd, dt, figcaption, div';

// Quote state runs across inline tags (a quote with *emphasis* inside) and resets at each paragraph,
// so an unclosed quote never colors the rest of the passage. Text the model already colored
// (<font color>, inline color styles) keeps its own color.
function markQuotes(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let block: Element | null = null;
  let inQ = false;
  for (const node of nodes) {
    const el = node.parentElement;
    if (!el || el.closest('code, pre, .roll, .scene-line, .insp-line')) continue;
    const b = el.closest(BLOCK);
    if (b !== block) { block = b; inQ = false; }
    const parts: [string, boolean][] = [];
    let cur = '';
    const push = (q: boolean) => { if (cur) parts.push([cur, q]); cur = ''; };
    for (const ch of node.data) {
      if (!inQ && (ch === '"' || OPEN.includes(ch))) { push(false); cur = ch; inQ = true; }
      else if (inQ && (ch === '"' || CLOSE.includes(ch))) { cur += ch; push(true); inQ = false; }
      else cur += ch;
    }
    push(inQ);
    if (!parts.some(([, q]) => q) || el.closest('font[color], [style*="color"]')) continue;
    const out = document.createDocumentFragment();
    for (const [t, q] of parts) {
      if (!q) { out.appendChild(document.createTextNode(t)); continue; }
      const span = document.createElement('span');
      span.className = 'q';
      span.textContent = t;
      out.appendChild(span);
    }
    node.replaceWith(out);
  }
}

// Copies passages as plain reading text, the same words the narrator reads aloud: no colors, tags, dice or scene lines.
// For pasting into another reader app. False when the browser won't allow it.
export async function copyReadingText(texts: string[]): Promise<boolean> {
  const text = texts.map(spokenText).filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n');
  if (!text) return false;
  try { await navigator.clipboard.writeText(text); return true; } catch { /* older browsers, or no permission: the old way */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// Plain text (a direction) with its quoted words marked.
export function quoteText(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  markQuotes(div);
  return div.innerHTML;
}

export function stripTags(t: string) {
  return t.replace(/<passage id="\d+"[^>]*\/>/g, '').replace(/<\/?passage[^>]*>/g, '\n\n');
}

// A round as the players posted it: one action per character.
export function parseRound(text: string): { who: string; text: string }[] {
  const out: { who: string; text: string }[] = [];
  for (const m of text.matchAll(/<action by="([^"]*)">([\s\S]*?)<\/action>/g)) out.push({ who: m[1], text: m[2].trim() });
  if (!out.length && text.trim()) out.push({ who: '', text: text.trim() });
  return out;
}
