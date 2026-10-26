// Chrome uses an offscreen document because its service worker has no Audio API.
import { play } from './sound.js';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'play-sound') {
    try {
      play(!!msg.urgent);
    } catch (e) {
      console.error('播放提示音失敗', e);
    }
  }
});
