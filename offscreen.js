// 在 offscreen document 中播放提示音（service worker 沒有 Audio API）
let ctx = null;

function beep(freq, startAt, duration, gainValue) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(gainValue, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.05);
}

function play(urgent) {
  if (!ctx) ctx = new (self.AudioContext || self.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + 0.02;
  if (urgent) {
    // 快輪到你了：三聲較高的提示
    beep(988, t, 0.16, 0.32);
    beep(988, t + 0.22, 0.16, 0.32);
    beep(1319, t + 0.44, 0.28, 0.34);
  } else {
    // 一般進度異動：兩聲柔和提示
    beep(660, t, 0.14, 0.22);
    beep(880, t + 0.18, 0.2, 0.22);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'play-sound') {
    try {
      play(!!msg.urgent);
    } catch (e) {
      console.error('播放提示音失敗', e);
    }
  }
});
