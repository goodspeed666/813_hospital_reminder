import assert from 'node:assert/strict';

const notificationOptions = [];
let offscreenCalls = 0;
let runtimeMessages = 0;
let audioContexts = 0;
let oscillatorStarts = 0;
const messageListeners = [];

class FakeAudioContext {
  constructor() {
    audioContexts++;
    this.state = 'running';
    this.currentTime = 1;
    this.destination = {};
  }
  createOscillator() {
    return {
      type: '',
      frequency: { value: 0 },
      connect() { return this; },
      start() { oscillatorStarts++; },
      stop() {}
    };
  }
  createGain() {
    return {
      gain: {
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {}
      },
      connect() { return this; }
    };
  }
  async resume() {}
}

const storedSettings = {
  intervalMinutes: 1,
  paused: false,
  sound: true,
  requireInteraction: true,
  badgeEnabled: true,
  dailyReset: true
};

globalThis.AudioContext = FakeAudioContext;
globalThis.browser = { runtime: { getBrowserInfo: async () => ({ name: 'Firefox' }) } };
globalThis.chrome = {
  runtime: {
    lastError: undefined,
    getURL: (path) => `moz-extension://test/${path}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    async sendMessage() { runtimeMessages++; },
    openOptionsPage() {}
  },
  storage: {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key === 'settings').map((key) => [key, storedSettings]));
      },
      async set() {}
    },
    onChanged: { addListener() {} }
  },
  alarms: {
    onAlarm: { addListener() {} },
    async clear() { return true; },
    async get() { return undefined; },
    create() {}
  },
  notifications: {
    async clear() { return true; },
    create(id, options, callback) {
      notificationOptions.push(options);
      callback?.(id);
    },
    onClicked: { addListener() {} }
  },
  offscreen: {
    async hasDocument() { offscreenCalls++; return true; },
    async createDocument() { offscreenCalls++; }
  },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {},
    async setTitle() {}
  },
  tabs: { create() {} }
};

await import('../background.js?firefox-runtime-test');

let testResponse;
const responseReady = new Promise((resolve) => { testResponse = resolve; });
for (const listener of messageListeners) {
  listener({ type: 'test-notification' }, {}, (value) => testResponse(value));
}
await responseReady;
await new Promise((resolve) => setImmediate(resolve));

assert.equal(notificationOptions.length, 1, 'the test command creates one notification');
assert.deepEqual(
  Object.keys(notificationOptions[0]).sort(),
  ['iconUrl', 'message', 'title', 'type'],
  'Firefox notifications use only the supported basic options'
);
assert.equal(offscreenCalls, 0, 'Firefox plays sound without the Chrome offscreen API');
assert.equal(runtimeMessages, 0, 'Firefox does not message a Chrome offscreen document');
assert.equal(audioContexts, 1, 'Firefox creates Web Audio only when sound is requested');
assert.ok(oscillatorStarts > 0, 'Firefox emits the test reminder tones');

console.log('Firefox notification/audio API behavior passes ✅');
