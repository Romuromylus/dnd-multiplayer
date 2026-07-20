/** Estimate token count for text (~4 chars per token). */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

module.exports = { estimateTokens };
