import { api } from '../api.js';
import { getState, setState } from '../state.js';
import { showNotification } from '../utils/dom.js';

let apiPromise = null;
let player = null;
let playerReadyPromise = null;
let playerReady = false;
let loadedTrackKey = null;
let activeMusic = null;
let playbackState = 'idle';
let autoplayBlocked = false;
let playbackCheckTimer = null;
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
  if (playerReady && player) return player;
  if (playerReadyPromise) return playerReadyPromise;
  await loadYouTubeApi();
  const host = document.getElementById('youtube-dj-host');
  if (!host) return null;
  playerReadyPromise = new Promise(resolve => {
    player = new window.YT.Player(host, {
      width: '200', height: '113',
      playerVars: { autoplay: 1, playsinline: 1, controls: 0, rel: 0 },
      events: {
        onReady: () => {
          playerReady = true;
          player.setVolume(previousVolume);
          updatePlaybackControls();
          resolve(player);
        },
        onStateChange: event => {
          if (event.data === window.YT.PlayerState.PLAYING) {
            autoplayBlocked = false;
            playbackState = 'playing';
          } else if (event.data === window.YT.PlayerState.PAUSED || event.data === window.YT.PlayerState.CUED) {
            playbackState = 'paused';
          } else if (event.data === window.YT.PlayerState.BUFFERING) {
            playbackState = 'loading';
          } else if (event.data === window.YT.PlayerState.ENDED) {
            player.seekTo(0, true);
            player.playVideo();
          }
          updatePlaybackControls();
        },
        onAutoplayBlocked: () => {
          autoplayBlocked = true;
          playbackState = 'paused';
          updatePlaybackControls();
        },
        onError: () => {
          playbackState = 'error';
          updatePlaybackControls();
        }
      }
    });
  });
  return playerReadyPromise;
}

function elapsedSeconds(music) {
  const startedAt = Date.parse(music.startedAt || '');
  return Number.isFinite(startedAt) ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
}

function syncVolumeControl() {
  const input = document.querySelector('#music-dj-player input[type="range"]');
  if (input) input.value = String(previousVolume);
}

function trackKey(music) {
  return music?.videoId ? `${music.videoId}:${music.startedAt || ''}` : null;
}

function updatePlaybackControls() {
  const button = document.getElementById('youtube-dj-playback-btn');
  const notice = document.getElementById('youtube-dj-playback-notice');
  if (button) {
    button.disabled = !playerReady;
    button.classList.toggle('needs-unlock', autoplayBlocked);
    button.textContent = !playerReady
      ? 'Loading...'
      : autoplayBlocked
        ? 'Enable Music'
        : playbackState === 'playing'
          ? 'Pause'
          : 'Play';
  }
  if (notice) {
    notice.hidden = !autoplayBlocked;
    notice.textContent = autoplayBlocked ? 'Tap Enable Music on this device.' : '';
  }
}

function ensurePlayerMarkup(container) {
  if (container.querySelector('.music-dj-now')) return;
  container.innerHTML = `<div class="music-dj-now"><span class="music-dj-label">DJ</span><span class="music-dj-title"></span><span id="youtube-dj-playback-notice" class="music-dj-notice" role="status" aria-live="polite" hidden></span></div><div class="youtube-dj-host-shell"><div id="youtube-dj-host" aria-hidden="true"></div></div><div class="music-dj-controls"><button id="youtube-dj-playback-btn" onclick="toggleDJPlayback()" title="Play or pause" disabled>Loading...</button><button onclick="muteDJPlayback()" title="Mute or restore volume">Mute</button><input type="range" min="0" max="100" value="${previousVolume}" oninput="setDJVolume(this.value)" aria-label="Music volume"></div>`;
}

function scheduleAutoplayCheck() {
  clearTimeout(playbackCheckTimer);
  playbackCheckTimer = setTimeout(() => {
    if (!player || !activeMusic || previousVolume === 0) return;
    const state = player.getPlayerState?.();
    if (state !== window.YT.PlayerState.PLAYING && state !== window.YT.PlayerState.BUFFERING) {
      autoplayBlocked = true;
      playbackState = 'paused';
      updatePlaybackControls();
    }
  }, 1800);
}

async function playMusic(music) {
  const instance = await ensurePlayer();
  const nextTrackKey = trackKey(music);
  if (!instance || !nextTrackKey || loadedTrackKey === nextTrackKey) return;
  loadedTrackKey = nextTrackKey;
  autoplayBlocked = false;
  playbackState = 'loading';
  updatePlaybackControls();
  instance.loadVideoById({ videoId: music.videoId, startSeconds: elapsedSeconds(music) });
  instance.setVolume(previousVolume);
  scheduleAutoplayCheck();
}

export function renderYouTubeDJ(music) {
  const container = document.getElementById('music-dj-player');
  if (!container) return;
  activeMusic = music?.videoId ? music : null;
  setState({ activeMusic: music?.videoId ? music : null });
  if (!music?.videoId) {
    container.hidden = true;
    try { player?.stopVideo(); } catch (error) {}
    loadedTrackKey = null;
    playbackState = 'idle';
    autoplayBlocked = false;
    clearTimeout(playbackCheckTimer);
    return;
  }
  container.hidden = false;
  ensurePlayerMarkup(container);
  const title = container.querySelector('.music-dj-title');
  if (title) {
    title.textContent = music.title || music.query;
    title.title = music.title || music.query;
  }
  updatePlaybackControls();
  playMusic(music).catch(error => showNotification(error.message || 'YouTube playback could not start.'));
}

export function toggleDJPlayback() {
  if (!playerReady || !player) return;
  const playing = player.getPlayerState?.() === window.YT.PlayerState.PLAYING;
  if (playing) {
    player.pauseVideo();
  } else {
    autoplayBlocked = false;
    playbackState = 'loading';
    if (previousVolume === 0) setDJVolume(lastAudibleVolume);
    player.playVideo();
    scheduleAutoplayCheck();
  }
  updatePlaybackControls();
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
