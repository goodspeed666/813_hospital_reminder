// Web Audio tone synthesis shared by Firefox's background page and Chrome's
// offscreen document.
let context = null;

function beep(freq, startAt, duration, gainValue) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = freq;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(gainValue, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.05);
}

export function play(urgent) {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!context) context = new AudioContextClass();
  if (context.state === 'suspended') context.resume();
  const startAt = context.currentTime + 0.02;
  if (urgent) {
    // 快輪到你了：三聲較高的提示
    beep(988, startAt, 0.16, 0.32);
    beep(988, startAt + 0.22, 0.16, 0.32);
    beep(1319, startAt + 0.44, 0.28, 0.34);
  } else {
    // 一般進度異動：兩聲柔和提示
    beep(660, startAt, 0.14, 0.22);
    beep(880, startAt + 0.18, 0.2, 0.22);
  }
}
