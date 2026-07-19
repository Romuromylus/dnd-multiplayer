// ============================================
// TTS (Text-to-Speech) Manager
// ============================================

import { getState } from '../state.js';
import { showNotification } from '../utils/dom.js';
import { api } from '../api.js';

class TTSManager {
  constructor() {
    this.voice = localStorage.getItem('tts-voice') || 'onyx';
    this.speed = parseFloat(localStorage.getItem('tts-speed')) || 1.0;
    this.currentAudio = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.currentText = null;
    this.currentChunkIndex = 0;
    this.totalChunks = 0;
    this.onStateChange = null;
  }

  setVoice(voice) {
    this.voice = voice;
    localStorage.setItem('tts-voice', voice);
  }

  setSpeed(speed) {
    this.speed = parseFloat(speed);
    localStorage.setItem('tts-speed', this.speed.toString());
  }

  async speak(text, buttonEl = null) {
    this.stop();

    this.currentText = text;
    this.currentChunkIndex = 0;
    this.activeButton = buttonEl;

    try {
      const info = await api('/api/tts/info', 'POST', { text });
      this.totalChunks = info.totalChunks;

      await this.playChunk(0);
    } catch (error) {
      console.error('TTS Error:', error);
      this.resetState();
      showNotification('TTS Error: ' + (error.message || 'Failed to generate speech'));
    }
  }

  async playChunk(index) {
    if (index >= this.totalChunks || !this.currentText) {
      this.resetState();
      return;
    }

    this.currentChunkIndex = index;
    this.isPlaying = true;
    this.isPaused = false;
    this.updateButtonState();

    try {
      const response = await fetch('/api/tts/audio', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: this.currentText,
          chunkIndex: index,
          voice: this.voice,
          speed: this.speed
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate audio');
      }

      const audioBlob = await response.blob();

      if (audioBlob.size === 0) {
        throw new Error('Received empty audio blob');
      }

      const audioUrl = URL.createObjectURL(audioBlob);

      this.currentAudio = new Audio(audioUrl);
      this.currentAudio.volume = 1.0;

      this.currentAudio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        this.playChunk(index + 1);
      };

      this.currentAudio.onerror = (e) => {
        console.error('Audio playback error:', e, this.currentAudio.error);
        URL.revokeObjectURL(audioUrl);
        this.resetState();
        showNotification('Audio playback failed - check console for details');
      };

      try {
        await this.currentAudio.play();
      } catch (playError) {
        console.error('Play error:', playError);
        showNotification('Click anywhere on the page first, then try TTS again (autoplay policy)');
        this.resetState();
        return;
      }

      // Pre-fetch next chunk for smoother playback
      if (index + 1 < this.totalChunks) {
        this.prefetchChunk(index + 1);
      }
    } catch (error) {
      console.error('TTS playback error:', error);
      this.resetState();
      showNotification('TTS Error: ' + error.message);
    }
  }

  async prefetchChunk(index) {
    try {
      fetch('/api/tts/audio', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: this.currentText,
          chunkIndex: index,
          voice: this.voice,
          speed: this.speed
        })
      });
    } catch (e) {
      // Ignore prefetch errors
    }
  }

  pause() {
    if (this.currentAudio && this.isPlaying && !this.isPaused) {
      this.currentAudio.pause();
      this.isPaused = true;
      this.updateButtonState();
    }
  }

  resume() {
    if (this.currentAudio && this.isPaused) {
      this.currentAudio.play();
      this.isPaused = false;
      this.updateButtonState();
    }
  }

  stop() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }
    this.resetState();
  }

  updateButtonState() {
    if (!this.activeButton) return;

    if (this.isPaused) {
      this.activeButton.classList.add('tts-paused');
      this.activeButton.classList.remove('tts-playing');
      this.activeButton.innerHTML = '&#x25B6;&#xFE0F;';
      this.activeButton.title = 'Resume';
    } else if (this.isPlaying) {
      this.activeButton.classList.add('tts-playing');
      this.activeButton.classList.remove('tts-paused');
      this.activeButton.innerHTML = '&#x23F8;&#xFE0F;';
      const progress = this.totalChunks > 1 ? ` (${this.currentChunkIndex + 1}/${this.totalChunks})` : '';
      this.activeButton.title = 'Pause' + progress;
    }
  }

  resetState() {
    this.isPlaying = false;
    this.isPaused = false;
    this.currentText = null;
    this.currentChunkIndex = 0;
    this.totalChunks = 0;

    if (this.activeButton) {
      this.activeButton.classList.remove('tts-playing', 'tts-paused');
      this.activeButton.innerHTML = '&#x1F50A;';
      this.activeButton.title = 'Play narration';
    }
    this.activeButton = null;

    if (this.onStateChange) {
      this.onStateChange(false);
    }
  }

  togglePlayback(text, buttonEl) {
    if (this.currentText === text && (this.isPlaying || this.isPaused)) {
      if (this.isPaused) {
        this.resume();
      } else {
        this.pause();
      }
    } else {
      this.speak(text, buttonEl);
    }
  }
}

// Singleton instance
export const ttsManager = new TTSManager();

// TTS click handler for play buttons
export function handleTTSClick(buttonEl) {
  const encodedContent = buttonEl.dataset.ttsContent;

  if (!encodedContent) {
    showNotification('TTS Error: No content found');
    return;
  }

  try {
    const text = decodeURIComponent(atob(encodedContent));
    ttsManager.togglePlayback(text, buttonEl);
  } catch (e) {
    console.error('TTS decode error:', e);
    showNotification('TTS Error: Failed to decode content');
  }
}
