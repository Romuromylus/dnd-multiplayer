const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/search';
const EXCLUDED_TERMS = '-shorts -short -tiktok -meme -reaction';

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function youtubeError(status, message) {
  const lower = String(message || '').toLowerCase();
  if (lower.includes('quota')) return 'YouTube Data API quota is exhausted for this key. Try again later.';
  if (lower.includes('keyinvalid') || lower.includes('api key not valid')) return 'The saved YouTube API key is invalid.';
  if (lower.includes('accessnotconfigured') || lower.includes('not been used') || lower.includes('disabled')) return 'Enable YouTube Data API v3 for the saved key in Google Cloud Console.';
  return `YouTube search failed (${status}).`;
}

async function searchYoutubeMusic(apiKey, query) {
  const trimmedKey = String(apiKey || '').trim();
  const trimmedQuery = String(query || '').trim().slice(0, 180);
  if (!trimmedKey) throw new Error('YouTube DJ is not configured by the administrator.');
  if (!trimmedQuery) throw new Error('A YouTube search query is required.');
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    videoDuration: /ambient|extended|hour|mix|soundtrack|ost/i.test(trimmedQuery) ? 'long' : 'medium',
    maxResults: '8',
    q: `${trimmedQuery} ${EXCLUDED_TERMS}`,
    key: trimmedKey
  });
  const response = await fetch(`${YOUTUBE_API_URL}?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(youtubeError(response.status, body));
  }
  const data = await response.json();
  const results = (data.items || [])
    .map(item => ({
      videoId: item.id?.videoId,
      title: decodeEntities(item.snippet?.title),
      channel: decodeEntities(item.snippet?.channelTitle),
      thumbnail: item.snippet?.thumbnails?.medium?.url || null
    }))
    .filter(result => result.videoId && !/(shorts?|tiktok|meme|reaction|compilation)/i.test(`${result.title} ${result.channel}`));
  return results;
}

module.exports = { searchYoutubeMusic };
