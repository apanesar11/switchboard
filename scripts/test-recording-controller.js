'use strict';

// The actual renderer controller, with a simulated camera and recorder. No real
// media devices, local config, workspace names or recordings are read here.
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src/diagrams/lib/recording.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  logLevel: 'error',
}).outputFiles[0].text;
const FILE = '/fictional/Movies/Switchboard/Recording-example.webm';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name, event = {}) {
    for (const listener of [...(this.listeners.get(name) || [])]) listener(event);
  }
}

function stream(kinds = ['video', 'audio']) {
  const tracks = kinds.map(kind => Object.assign(new Events(), {
    kind, enabled: true, readyState: 'live',
    stop() { this.readyState = 'ended'; },
    disconnect() { this.readyState = 'ended'; this.emit('ended'); },
  }));
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter(track => track.kind === 'video'),
    getAudioTracks: () => tracks.filter(track => track.kind === 'audio'),
  };
}

function harness(options = {}) {
  const calls = [];
  const parts = [];
  const devices = options.stream || stream();
  const recorders = [];
  let flush;
  class Recorder extends Events {
    static isTypeSupported(type) { return options.supported ? options.supported(type) : type.startsWith('video/webm'); }
    constructor(media, config) {
      super();
      this.stream = media;
      this.mimeType = config.mimeType;
      this.state = 'inactive';
      recorders.push(this);
    }
    start(timeslice) { this.state = 'recording'; this.timeslice = timeslice; }
    stop() {
      assert.equal(this.state, 'recording');
      this.state = 'inactive';
      queueMicrotask(() => {
        this.emit('dataavailable', { data: new Blob([options.finalData ?? 'tail']) });
        this.emit('stop');
      });
    }
    data(value) { this.emit('dataavailable', { data: value instanceof Blob ? value : new Blob([value]) }); }
  }
  const sb = {
    async recordingPermissions() {
      calls.push(['permissions']);
      return options.permissions ? options.permissions() : { ok: true, data: null };
    },
    async recordingStart(mimeType) {
      calls.push(['start', mimeType]);
      return options.start ? options.start(mimeType) : { ok: true, data: { id: 'example-recording', path: FILE, mimeType } };
    },
    async recordingAppend(id, sequence, bytes) {
      calls.push(['append', id, sequence, bytes.byteLength]);
      if (options.append) {
        const answer = await options.append(id, sequence, bytes);
        if (!answer.ok) return answer;
      }
      parts.push(Buffer.from(bytes));
      return { ok: true, data: null };
    },
    async recordingFinish(id) {
      calls.push(['finish', id]);
      if (options.finish) return options.finish(id);
      const bytes = parts.reduce((total, part) => total + part.length, 0);
      return bytes ? { ok: true, data: { path: FILE, bytes } } : { ok: false, error: 'The recording contained no video.' };
    },
    onRecordingFlush(listener) { flush = listener; return () => {}; },
    async recordingFlushed(id, result) { calls.push(['flushed', id, result]); return { ok: true }; },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    window: { sb },
    navigator: { mediaDevices: { async getUserMedia(constraints) {
      calls.push(['media', constraints]);
      return options.media ? options.media(constraints) : devices;
    } } },
    MediaRecorder: Recorder,
    Blob, Uint8Array, DOMException, Error, Date, console, queueMicrotask,
  }, { filename: 'recording-controller.js' });
  return { api: module.exports, calls, parts, devices, recorders, flush: id => flush(id) };
}

async function until(check) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise(done => setImmediate(done));
  }
  assert.fail('The recording operation did not settle.');
}

function state(h) { return h.api.getRecordingSnapshot(); }
function count(h, name) { return h.calls.filter(call => call[0] === name).length; }
function allDevicesStopped(media) { return media.getTracks().every(track => track.readyState === 'ended'); }

test('start, mute and stop drain every chunk in order before finishing, and stop devices immediately', { timeout: 2000 }, async () => {
  const writing = deferred();
  const h = harness({ append: (_id, sequence) => sequence === 0 ? writing.promise : { ok: true } });
  let updates = 0;
  const unsubscribe = h.api.subscribeRecording(() => { updates++; });
  await h.api.startRecording();
  await h.api.startRecording();
  assert.equal(count(h, 'start'), 1);
  assert.equal(state(h).phase, 'recording');
  assert.equal(state(h).stream, h.devices);
  assert.equal(h.recorders[0].timeslice, 1000);
  const constraints = h.calls.find(call => call[0] === 'media')[1];
  assert.equal(constraints.audio, true);
  assert.equal(constraints.video.width.ideal, 1280);
  h.api.toggleRecordingMicrophone();
  assert.equal(state(h).micMuted, true);
  assert.equal(h.devices.getAudioTracks()[0].enabled, false);
  h.api.toggleRecordingMicrophone();
  assert.equal(h.devices.getAudioTracks()[0].enabled, true);
  h.recorders[0].data('head');
  h.recorders[0].data('');
  await until(() => count(h, 'append') === 1);
  const stopping = h.api.stopRecording();
  assert.equal(state(h).phase, 'saving');
  assert.equal(allDevicesStopped(h.devices), true);
  assert.equal(count(h, 'finish'), 0);
  writing.resolve({ ok: true });
  await stopping;
  assert.equal(Buffer.concat(h.parts).toString(), 'headtail');
  assert.deepEqual(h.calls.filter(call => call[0] === 'append').map(call => call[2]), [0, 1]);
  assert.equal(count(h, 'finish'), 1);
  assert.equal(state(h).phase, 'saved');
  assert.equal(state(h).saved.path, FILE);
  assert.ok(updates >= 5);
  unsubscribe();
  h.api.dismissRecording();
  assert.equal(state(h).phase, 'idle');
});

test('large recorder blobs are sliced into bounded IPC chunks', { timeout: 2000 }, async () => {
  const h = harness();
  await h.api.startRecording();
  const size = 9 * 1024 * 1024 + 7;
  h.recorders[0].data(new Blob([new Uint8Array(size)]));
  await h.api.stopRecording();
  const chunks = h.calls.filter(call => call[0] === 'append');
  assert.deepEqual(chunks.map(call => call[2]), [0, 1, 2, 3]);
  assert.ok(chunks.every(call => call[3] <= 4 * 1024 * 1024));
  assert.equal(Buffer.concat(h.parts).length, size + 4);
});

test('a denied permission never opens the devices or a file', async () => {
  const h = harness({ permissions: () => ({ ok: false, error: 'Camera access was denied.' }) });
  await h.api.startRecording();
  assert.equal(state(h).phase, 'error');
  assert.match(state(h).error, /denied/);
  assert.equal(count(h, 'media'), 0);
  assert.equal(count(h, 'start'), 0);
});

test('a missing microphone or unsupported recorder releases the camera without opening a file', async () => {
  for (const options of [{ stream: stream(['video']) }, { supported: () => false }]) {
    const h = harness(options);
    await h.api.startRecording();
    assert.equal(state(h).phase, 'error');
    assert.equal(allDevicesStopped(h.devices), true);
    assert.equal(count(h, 'start'), 0);
  }
});

test('canceling a pending permissions prompt does not open late media or prevent another recording', async () => {
  const permission = deferred();
  let requested = 0;
  const h = harness({ permissions: () => ++requested === 1 ? permission.promise : { ok: true, data: null } });
  const first = h.api.startRecording();
  await h.api.stopRecording();
  assert.equal(state(h).phase, 'idle');
  await h.api.startRecording();
  permission.resolve({ ok: true, data: null });
  await first;
  assert.equal(count(h, 'media'), 1);
  assert.equal(count(h, 'start'), 1);
  assert.equal(state(h).phase, 'recording');
  await h.api.stopRecording();
});

test('a canceled late camera stream is stopped without affecting a newer recording', async () => {
  const request = deferred();
  const late = stream();
  const current = stream();
  let requested = 0;
  const h = harness({ media: () => ++requested === 1 ? request.promise : current });
  const first = h.api.startRecording();
  await until(() => requested === 1);
  await h.api.stopRecording();
  await h.api.startRecording();
  request.resolve(late);
  await first;
  assert.equal(allDevicesStopped(late), true);
  assert.equal(allDevicesStopped(current), false);
  assert.equal(count(h, 'start'), 1);
  await h.api.stopRecording();
});

test('cancel during file opening waits for cleanup and treats its empty file as cancellation', async () => {
  const opening = deferred();
  const h = harness({ start: () => opening.promise });
  const starting = h.api.startRecording();
  await until(() => count(h, 'start') === 1);
  const stopping = h.api.stopRecording();
  assert.equal(state(h).phase, 'saving');
  await h.api.startRecording();
  assert.equal(count(h, 'start'), 1);
  opening.resolve({ ok: true, data: { id: 'example-recording', path: FILE, mimeType: 'video/webm' } });
  await Promise.all([starting, stopping]);
  assert.equal(count(h, 'finish'), 1);
  assert.equal(state(h).phase, 'idle');
  assert.equal(h.recorders[0].state, 'inactive');
  assert.equal(allDevicesStopped(h.devices), true);
});

test('a write error stops recording without deadlocking the queue and exposes the retained partial', { timeout: 2000 }, async () => {
  const h = harness({
    append: () => ({ ok: false, error: 'The disk is full.' }),
    finish: () => ({ ok: false, error: 'The disk is full.', recoveryPath: FILE + '.partial.webm' }),
  });
  await h.api.startRecording();
  h.recorders[0].data('head');
  await until(() => state(h).phase === 'error');
  assert.equal(allDevicesStopped(h.devices), true);
  assert.equal(count(h, 'append'), 1);
  assert.equal(count(h, 'finish'), 1);
  assert.match(state(h).error, /disk is full/);
  assert.equal(state(h).saved.path, FILE + '.partial.webm');
});

test('device disconnection retains queued bytes and the recorder final chunk', async () => {
  const h = harness();
  await h.api.startRecording();
  h.recorders[0].data('head');
  h.devices.getVideoTracks()[0].disconnect();
  await until(() => state(h).phase === 'error');
  assert.equal(Buffer.concat(h.parts).toString(), 'headtail');
  assert.match(state(h).error, /disconnected/);
  assert.equal(state(h).saved.path, FILE);
  assert.equal(allDevicesStopped(h.devices), true);
});

test('memory pressure stops accepting new data while preserving the previously queued portion', async () => {
  const h = harness();
  await h.api.startRecording();
  h.recorders[0].data('head');
  h.recorders[0].emit('dataavailable', { data: { size: 33 * 1024 * 1024, slice() { assert.fail('An oversized blob must not be allocated.'); } } });
  await until(() => state(h).phase === 'error');
  assert.equal(Buffer.concat(h.parts).toString(), 'head');
  assert.match(state(h).error, /disk could not keep up/);
  assert.equal(state(h).saved.path, FILE);
});

test('shutdown flush acknowledges only after the final bytes and finish reach main', async () => {
  const writing = deferred();
  const h = harness({ append: () => writing.promise });
  await h.api.startRecording();
  h.flush(42);
  assert.equal(allDevicesStopped(h.devices), true);
  await until(() => count(h, 'append') === 1);
  assert.equal(count(h, 'flushed'), 0);
  writing.resolve({ ok: true });
  await until(() => count(h, 'flushed') === 1);
  const ack = h.calls.find(call => call[0] === 'flushed');
  assert.equal(ack[1], 42);
  assert.equal(ack[2].ok, true);
  assert.equal(h.calls.at(-2)[0], 'finish');
  assert.equal(state(h).phase, 'saved');
});

test('shutdown flush reports disk failures instead of acknowledging a complete save', async () => {
  const h = harness({ finish: () => ({ ok: false, error: 'The recording could not be renamed.', recoveryPath: FILE + '.partial.webm' }) });
  await h.api.startRecording();
  h.flush(7);
  await until(() => count(h, 'flushed') === 1);
  const ack = h.calls.find(call => call[0] === 'flushed');
  assert.equal(ack[2].ok, false);
  assert.match(ack[2].error, /renamed/);
  assert.equal(state(h).saved.path, FILE + '.partial.webm');
});
