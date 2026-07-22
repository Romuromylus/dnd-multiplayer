import { api } from '../api.js';
import { getState, setState } from '../state.js';
import { escapeHtml } from '../utils/formatters.js';
import { showNotification } from '../utils/dom.js';

let apiPromise = null;
let player = null;
let loadedVideoId = null;
let previousVolume = Number(localStorage.getItem('dnd-youtube-volume') || 45);
let lastAudibleVolume = previousVolume > 0 ? previousVolume : 45;

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise(resolve => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(script);
  });
  return apiPromise;
}

async function ensurePlayer() {
  if (player) return player;
  await loadYouTubeApi();
  const host = document.getElementById('youtube-dj-host');
  if (!host) return null;
  return new Promise(resolve => {
    player = new window.YT.Player(host, {
      width: '1', height: '1',
      playerVars: { autoplay: 1, playsinline: 1, controls: 0, rel: 0 },
      events: {
        onReady: () => { player.setVolume(previousVolume); resolve(player); },
        onStateChange: event => {
          if (event.data === window.YT.PlayerState.ENDED) { player.seekTo(0, true); player.playVideo(); }
        }
      }
    });
  });
}

function elapsedSeconds(music) {
  const startedAt = Date.parse(music.startedAt || '');
  return Number.isFinite(startedAt) ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
}

function syncVolumeControl() {
  const input = document.querySelector('#music-dj-player input[type="range"]');
  if (input) input.value = String(previousVolume);
}

async function playMusic(music) {
  const instance = await ensurePlayer();
  if (!instance || !music?.videoId || loadedVideoId === music.videoId) return;
  loadedVideoId = music.videoId;
  instance.loadVideoById({ videoId: music.videoId, startSeconds: elapsedSeconds(music) });
  instance.setVolume(previousVolume);
}

export function renderYouTubeDJ(music) {
  const container = document.getElementById('music-dj-player');
  if (!container) return;
  setState({ activeMusic: music?.videoId ? music : null });
  if (!music?.videoId) {
    container.hidden = true;
    try { player?.stopVideo(); } catch (error) {}
    loadedVideoId = null;
    return;
  }
  if (player) {
    try { player.destroy(); } catch (error) {}
    player = null;
    loadedVideoId = null;
  }
  container.hidden = false;
  container.innerHTML = `<div class="music-dj-now"><span class="music-dj-label">DJ</span><span class="music-dj-title" title="${escapeHtml(music.title || music.query)}">${escapeHtml(music.title || music.query)}</span></div><div id="youtube-dj-host" aria-hidden="true"></div><div class="music-dj-controls"><button onclick="toggleDJPlayback()" title="Play or pause">Play/Pause</button><button onclick="muteDJPlayback()" title="Mute or restore volume">Mute</button><input type="range" min="0" max="100" value="${previousVolume}" oninput="setDJVolume(this.value)" aria-label="Music volume"></div>`;
  playMusic(music).catch(error => showNotification(error.message || 'YouTube playback could not start.'));
}

export function toggleDJPlayback() {
  if (!player) return;
  const playing = player.getPlayerState?.() === window.YT.PlayerState.PLAYING;
  if (playing) player.pauseVideo(); else player.playVideo();
}

export function setDJVolume(value) {
  previousVolume = Math.max(0, Math.min(100, Number(value) || 0));
  if (previousVolume > 0) lastAudibleVolume = previousVolume;
  localStorage.setItem('dnd-youtube-volume', String(previousVolume));
  player?.setVolume(previousVolume);
  syncVolumeControl();
}

export function muteDJPlayback() {
  setDJVolume(previousVolume > 0 ? 0 : lastAudibleVolume);
}

export async function setDJTrack() {
  const session = getState('currentSession');
  const query = window.prompt('Play a YouTube soundtrack for everyone:');
  if (!session || !query?.trim()) return;
  try {
    const result = await api(`/api/sessions/${session.id}/music`, 'POST', { query });
    renderYouTubeDJ(result.music);
  } catch (error) {
    showNotification(error.message || 'Unable to set music.');
  }
}

export async function stopDJTrack() {
  const session = getState('currentSession');
  if (!session) return;
  try {
    await api(`/api/sessions/${session.id}/music/stop`, 'POST');
    renderYouTubeDJ(null);
  } catch (error) {
    showNotification(error.message || 'Unable to stop music.');
  }
}
