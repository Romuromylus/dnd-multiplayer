/**
 * Marker JSON Extractor
 * Pulls a brace-balanced JSON object out of an AI message that follows a marker
 * such as "LEVELUP_COMPLETE:", "EDIT_COMPLETE:", or "CHARACTER_COMPLETE:".
 *
 * Faithfully reproduces the brace-counting scan that was triplicated across the
 * character level-up / edit / ai-create routes: it starts at the first "{" after
 * the marker and returns the substring up to the matching "}". Callers guard with
 * their own marker `.includes(...)` check exactly as before.
 *
 * @param {string} text - The full AI message.
 * @param {string} marker - The marker string that precedes the JSON (e.g. "EDIT_COMPLETE:").
 * @returns {string|null} The JSON substring, or null if no "{" follows the marker.
 *                        Returns "" when a "{" is found but the braces never balance
 *                        (matching the original inline behavior, where callers treat
 *                        an empty/unparseable string as "not complete").
 */
function extractMarkerJson(text, marker) {
  if (typeof text !== 'string') return null;
  const startIdx = text.indexOf(marker) + marker.length;
  const jsonStart = text.indexOf('{', startIdx);
  if (jsonStart === -1) return null;

  let braceCount = 0;
  let jsonEnd = jsonStart;
  for (let i = jsonStart; i < text.length; i++) {
    if (text[i] === '{') braceCount++;
    if (text[i] === '}') braceCount--;
    if (braceCount === 0) {
      jsonEnd = i + 1;
      break;
    }
  }
  return text.substring(jsonStart, jsonEnd);
}

module.exports = { extractMarkerJson };
