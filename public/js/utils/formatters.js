// ============================================
// Text Formatting Utilities
// ============================================

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Inline elements whose author-chosen text color we normalize for theme readability. The AI
// colors major-NPC dialogue with <font color> (see the DM prompt); a fixed hex can't read well
// on both the dark and the light parchment background, so we keep the hue/saturation and let
// theme-scoped CSS drive the lightness. Block/container elements are left alone — a styled
// diegetic document (letter, sign) sets its own foreground+background together.
const INLINE_COLOR_TAGS = new Set(['FONT', 'SPAN', 'B', 'I', 'EM', 'STRONG', 'U', 'SMALL']);

/**
 * Parse a CSS color (#rgb, #rrggbb, or rgb()/rgba()) into HSL hue + saturation.
 * Returns null for anything unparseable (named colors, gradients) so it's left untouched.
 */
function colorToHueSat(input) {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  let r, g, b, m;
  if ((m = s.match(/^#([0-9a-f]{3})$/))) {
    r = parseInt(m[1][0] + m[1][0], 16);
    g = parseInt(m[1][1] + m[1][1], 16);
    b = parseInt(m[1][2] + m[1][2], 16);
  } else if ((m = s.match(/^#([0-9a-f]{6})$/))) {
    r = parseInt(m[1].slice(0, 2), 16);
    g = parseInt(m[1].slice(2, 4), 16);
    b = parseInt(m[1].slice(4, 6), 16);
  } else if ((m = s.match(/^rgba?\(([^)]+)\)/))) {
    // Accept comma AND CSS Color 4 space/slash separators; require 3 valid channels.
    const parts = m[1].split(/[\s,/]+/).map(p => parseFloat(p)).filter(p => !Number.isNaN(p));
    if (parts.length < 3) return null;
    [r, g, b] = parts;
  } else {
    return null;
  }

  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, sat = 0;
  if (max !== min) {
    const d = max - min;
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(sat * 100) };
}

/**
 * Sanitize HTML: allow safe tags, strip scripts and dangerous attributes.
 */
function sanitizeHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove all script, iframe, object, embed, form elements
  const dangerous = doc.querySelectorAll('script, iframe, object, embed, form, link, meta, base');
  dangerous.forEach(el => el.remove());

  // Remove dangerous attributes from all remaining elements
  const allEls = doc.body.querySelectorAll('*');
  allEls.forEach(el => {
    // Strip ALL on* event handler attributes (covers onerror, onwheel, onpointerenter, etc.)
    const attrs = [...el.attributes];
    for (const attr of attrs) {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    }
    // Remove javascript: and data: protocols from href/src
    ['href', 'src', 'action'].forEach(attr => {
      const val = el.getAttribute(attr);
      if (val) {
        const trimmed = val.trim().toLowerCase();
        if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:')) {
          el.removeAttribute(attr);
        }
      }
    });

    // Theme-normalize inline text color (NPC dialogue) so it stays readable in both themes.
    if (INLINE_COLOR_TAGS.has(el.tagName)) {
      const styleAttr = el.getAttribute('style') || '';
      // Leave self-contained styled snippets (they set their own background) untouched.
      if (!/background/i.test(styleAttr)) {
        const attrColor = el.getAttribute('color');
        const styleColorMatch = styleAttr.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
        const styleColor = styleColorMatch ? styleColorMatch[1].trim() : null;
        const hsl = colorToHueSat(styleColor || attrColor);
        if (hsl) {
          if (attrColor) el.removeAttribute('color');
          // Drop only the top-level `color` declaration (keep background-color/border-color and
          // everything else) by splitting into declarations — a regex spanning `;color:…;` could
          // fuse the neighbours of a middle color into one invalid declaration.
          const rest = styleAttr
            .split(';')
            .map(d => d.trim())
            .filter(d => d && !/^color\s*:/i.test(d))
            .join('; ');
          const sat = Math.min(80, Math.max(45, hsl.s));
          const vars = `--npc-h:${hsl.h};--npc-s:${sat}%`;
          el.setAttribute('style', rest ? `${rest}; ${vars}` : vars);
          el.classList.add('npc-line');
        }
      }
    }
  });

  return doc.body.innerHTML;
}

/**
 * Format AI narration content — supports HTML passthrough with sanitization,
 * plus markdown bold/italic for non-HTML content.
 */
export function formatContent(content) {
  if (!content) return '';
  // Check if content contains HTML tags
  const hasHtml = /<[a-z][\s\S]*?>/i.test(content);

  if (hasHtml) {
    // HTML mode: sanitize and pass through
    let html = sanitizeHtml(content);
    // Convert newlines to <br> only in text segments (outside HTML tags)
    html = html.replace(/(^|>)([^<]+)(<|$)/g, (match, before, text, after) => {
      const converted = text
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>');
      return before + converted + after;
    });
    return html;
  }

  // Plain text mode: escape HTML, convert newlines and markdown
  return escapeHtml(content)
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
}

export function formatChatMessage(text) {
  return escapeHtml(text)
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
}
