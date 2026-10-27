'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecordingSession } = require('../src/main/recording-session');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(overrides = {}) {
  const handlers = new Map();
  const calls = [];
  const revealed = [];
  const rendererUrl = 'file:///example/app/renderer/index.html';
  const frame = { url: rendererUrl };
  const wc = {
    mainFrame: frame,
    isDestroyed: () => false,
    send: (channel, id) => calls.push(['send', channel, id]),
  };
  let win = { webContents: wc, isDestroyed: () => false };
  let active = false;
  const store = {
    start: async options => { calls.push(['start', options]); active = true; return { ok: true, data: { id: 'session', path: '/example/recordings/camera.partial.webm' } }; },
    append: async (...args) => { calls.push(['append', ...args]); return { ok: true, data: { bytes: 5 } }; },
    finish: async id => { calls.push(['finish', id]); active = false; return { ok: true, data: { path: '/example/recordings/camera.webm', bytes: 5 } }; },
    dispose: async () => { calls.push(['dispose']); active = false; return { ok: true, data: null }; },
    isActive: () => active,
    ...overrides.store,
  };
  const session = createRecordingSession({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWindow: () => win,
    directory: '/example/recordings', rendererUrl,
    platform: 'darwin', flushTimeout: 30,
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: async () => true,
    },
    shell: { showItemInFolder: file => revealed.push(file) },
    ...overrides,
    store,
  });
  const event = { sender: wc, senderFrame: frame };
  const invoke = (name, ...args) => handlers.get(`sb:recording:${name}`)(event, ...args);
  return { session, invoke, event, handlers, calls, revealed, wc, frame, setWindow: value => { win = value; } };
}

test('recording IPC rejects another sender, an embedded frame and another document', async () => {
  const f = fixture();
  const handler = f.handlers.get('sb:recording:start');
  for (const event of [
    { sender: {}, senderFrame: f.frame },
    { sender: f.wc, senderFrame: { url: f.frame.url } },
    { sender: f.wc, senderFrame: null },
  ]) {
    assert.equal((await handler(event, 'video/webm')).ok, false);
  }
  f.frame.url = 'https://www.youtube-nocookie.com/embed/example';
  assert.equal((await f.invoke('start', 'video/webm')).ok, false);
  f.frame.url = 'file:///example/app/renderer/index.html?untrusted';
  assert.equal((await f.invoke('permissions')).ok, false);
  assert.deepEqual(f.calls, []);
});

test('the trusted document may stream bytes and reveal only the path main saved', async () => {
  const f = fixture();
  f.frame.url += '#whiteboard';
  assert.equal((await f.invoke('reveal', '/example/other-file')).ok, false);
  assert.equal((await f.invoke('start', 'video/webm')).ok, true);
  const bytes = new Uint8Array([1, 2, 3]);
  await f.invoke('append', 'session', 0, bytes);
  await f.invoke('finish', 'session');
  assert.equal((await f.invoke('reveal', '/example/other-file')).ok, true);
  assert.deepEqual(f.revealed, ['/example/recordings/camera.webm']);
  assert.deepEqual(f.calls.slice(0, 3), [
    ['start', { mimeType: 'video/webm' }], ['append', 'session', 0, bytes], ['finish', 'session'],
  ]);
});

test('macOS asks for camera and microphone once while requests are concurrent', async () => {
  const waiting = deferred();
  const prompts = [];
  const f = fixture({ systemPreferences: {
    getMediaAccessStatus: () => 'not-determined',
    askForMediaAccess: async type => { prompts.push(type); await waiting.promise; return true; },
  } });
  const first = f.invoke('permissions');
  const second = f.invoke('permissions');
  assert.deepEqual(prompts, ['camera']);
  waiting.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.deepEqual(prompts, ['camera', 'microphone']);
});

test('denied or restricted macOS access gives instructions without repeating a prompt', async () => {
  for (const status of ['denied', 'restricted']) {
    let prompted = false;
    const f = fixture({ systemPreferences: {
      getMediaAccessStatus: type => type === 'camera' ? 'granted' : status,
      askForMediaAccess: async () => { prompted = true; return true; },
    } });
    const result = await f.invoke('permissions');
    assert.equal(result.ok, false);
    assert.match(result.error, /System Settings.*Microphone/);
    assert.equal(prompted, false);
  }
});

test('other platforms leave device permissions to getUserMedia', async () => {
  const f = fixture({ platform: 'linux', systemPreferences: undefined });
  assert.deepEqual(await f.invoke('permissions'), { ok: true, data: null });
});

test('flush coalesces, drains final writes, matches acknowledgments and blocks new starts', async () => {
  const f = fixture();
  const first = f.session.flush();
  assert.equal(f.session.flush(), first);
  assert.equal((await f.invoke('start', 'video/webm')).ok, false);
  assert.equal((await f.invoke('permissions')).ok, false);
  const id = f.calls.find(call => call[0] === 'send')[2];
  await f.invoke('flushed', id + 1, { ok: true });
  assert.equal(f.calls.some(call => call[0] === 'dispose'), false);
  await f.invoke('append', 'session', 0, new Uint8Array([1]));
  await f.invoke('finish', 'session');
  await f.invoke('flushed', id, { ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.equal(f.calls.at(-1)[0], 'dispose');
  f.session.resume();
  assert.equal((await f.invoke('start', 'video/webm')).ok, true);
});

test('a permission prompt resolving during close cannot permit a late recording', async () => {
  const waiting = deferred();
  const f = fixture({ systemPreferences: {
    getMediaAccessStatus: () => 'not-determined',
    askForMediaAccess: () => waiting.promise,
  } });
  const permitted = f.invoke('permissions');
  const flush = f.session.flush();
  waiting.resolve(true);
  assert.equal((await permitted).ok, false);
  const id = f.calls.find(call => call[0] === 'send')[2];
  await f.invoke('flushed', id, { ok: true });
  assert.equal((await flush).ok, true);
});

test('a flush timeout closes the store and keeps the interrupted path available', async () => {
  const f = fixture({ flushTimeout: 5, store: {
    dispose: async () => ({ ok: true, data: { path: '/example/recordings/recovery.partial.webm', bytes: 100 } }),
  } });
  const result = await f.session.flush();
  assert.equal(result.ok, false);
  assert.match(result.error, /finish saving in time/);
  await f.invoke('reveal');
  assert.deepEqual(f.revealed, ['/example/recordings/recovery.partial.webm']);
});

test('renderer failure is reported and recovery from a failed finish can be revealed', async () => {
  const f = fixture({ store: {
    finish: async () => ({ ok: false, error: 'The disk is full.', recoveryPath: '/example/recordings/recovery.partial.webm' }),
  } });
  assert.equal((await f.invoke('finish', 'session')).ok, false);
  await f.invoke('reveal');
  assert.deepEqual(f.revealed, ['/example/recordings/recovery.partial.webm']);
  const flush = f.session.flush();
  const id = f.calls.find(call => call[0] === 'send')[2];
  await f.invoke('flushed', id, { ok: false, error: 'The disk is full.' });
  assert.deepEqual(await flush, { ok: false, error: 'The disk is full.' });
});

test('a destroyed renderer disposes immediately and an interrupt permits a replacement', async () => {
  const f = fixture();
  const flush = f.session.flush();
  f.setWindow(null);
  await f.session.interrupt();
  assert.equal((await flush).ok, true);
  assert.equal(f.calls.filter(call => call[0] === 'dispose').length, 2);
  f.calls.length = 0;
  assert.equal((await f.session.flush()).ok, true);
  assert.deepEqual(f.calls, [['dispose']]);
  f.session.resume();
});

test('unexpected OS and disk errors settle as values', async () => {
  const f = fixture({
    systemPreferences: { getMediaAccessStatus() { throw new Error('Permission service unavailable.'); }, askForMediaAccess: async () => true },
    store: { start: async () => { throw new Error('Cannot create recording.'); } },
  });
  assert.deepEqual(await f.invoke('permissions'), { ok: false, error: 'Permission service unavailable.' });
  assert.deepEqual(await f.invoke('start', 'video/webm'), { ok: false, error: 'Cannot create recording.' });
});
