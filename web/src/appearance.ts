// Reader text colors, like SillyTavern's theme colors. Stored on the server so phone and desktop match.
// A value is '' (theme default), 'off' (same color as the surrounding text) or a #rrggbb color.
export type Prefs = Partial<Record<ColorKey, string>>;
export type ColorKey = 'prose' | 'quote' | 'italic' | 'underline';

export const COLOR_KEYS: { key: ColorKey; label: string; hint: string; canOff: boolean }[] = [
  { key: 'prose', label: 'Main text', hint: 'Narration.', canOff: false },
  { key: 'quote', label: 'Quoted text', hint: 'Anything inside "quotes". Character colors from Colored Dialogue still win.', canOff: true },
  { key: 'italic', label: 'Italics', hint: 'Thoughts, emphasis, sounds.', canOff: true },
  { key: 'underline', label: 'Underlined text', hint: '', canOff: true },
];

export function applyPrefs(p: Prefs) {
  const root = document.documentElement;
  for (const { key } of COLOR_KEYS) {
    const v = p[key] ?? '';
    if (/^#[0-9a-f]{6}$/i.test(v)) root.style.setProperty(`--${key}`, v);
    else root.style.removeProperty(`--${key}`);
    root.classList.toggle(`plain-${key}`, v === 'off');
  }
}

// The color a key currently shows, for the color picker.
export function currentColor(key: ColorKey): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${key}`).trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : '#888888';
}
