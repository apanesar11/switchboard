'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createRecordingStore, recordingExtension, MAX_RECORDING_CHUNK_BYTES } = require('../src/main/recordings');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-recordings-'));
  const store = createRecordingStore({ directory, ...options });
  t.after(async () => {
    await store.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, store };
}

test('recording format chooses a container extension from a strict MIME whitelist', () => {
  for (const mime of ['video/webm', 'video/webm;codecs=vp9,opus', 'video/webm; codecs="vp8, opus"', 'video/webm;codecs=av1,opus']) {
    assert.equal(recordingExtension(mime), 'webm', mime);
  }
  for (const mime of ['video/mp4', 'video/mp4;codecs=avc1.42001e,mp4a.40.2']) {
    assert.equal(recordingExtension(mime), 'mp4', mime);
  }
  for (const mime of [undefined, null, {}, 'audio/webm', 'video/quicktime', '../video.mp4', 'video/webm;codecs=anything', 'video/webm;name=../../file', 'video/mp4;codecs=vp9', 'video/webm;codecs=vp8,']) {
    assert.equal(recordingExtension(mime), null, String(mime));
  }
});

test('chunks reach disk in order and finish yields one local video', async t => {
  const { directory, store } = await fixture(t);
  const started = await store.start({ mimeType: 'video/webm;codecs=vp8,opus', path: '/ignored/renderer-path' });
  assert.equal(started.ok, true);
  const { id } = started.data;
  assert.equal(path.dirname(started.data.path), directory);
  assert.equal(path.extname(started.data.path), '.webm');
  assert.equal(store.isActive(), true);
  const first = Buffer.from('fictional video header\n');
  const second = Buffer.from('fictional video bytes\n');
  const appended = store.append(id, 0, first);
  const appendedAgain = store.append(id, 1, second);
  const finished = store.finish(id);
  assert.equal((await appended).ok, true);
  assert.equal((await appendedAgain).ok, true);
  const result = await finished;
  assert.equal(result.ok, true);
  assert.equal(result.data.bytes, first.length + second.length);
  assert.equal(result.data.chunks, 2);
  assert.equal(result.data.mimeType, 'video/webm;codecs=vp8,opus');
  assert.equal(result.data.path.includes('.partial.'), false);
  assert.deepEqual(await fs.readFile(result.data.path), Buffer.concat([first, second]));
  assert.deepEqual(await fs.readdir(directory), [path.basename(result.data.path)]);
  assert.deepEqual(await store.finish(id), result, 'a second Stop receives the saved result');
  assert.equal(store.isActive(), false);
  assert.equal((await store.append(id, 2, second)).ok, false);
});

test('only one active session and its exact next chunk may write', async t => {
  const { store } = await fixture(t);
  const started = await store.start({ mimeType: 'video/mp4' });
  const { id } = started.data;
  assert.equal((await store.start({ mimeType: 'video/webm' })).ok, false);
  const bytes = Uint8Array.of(1, 2, 3);
  for (const [token, sequence, chunk] of [
    ['wrong-token', 0, bytes], [id, 1, bytes], [id, -1, bytes],
    [id, '0', bytes], [id, NaN, bytes], [id, 0, []],
    [id, 0, new Uint8Array()], [id, 0, new Uint8Array(MAX_RECORDING_CHUNK_BYTES + 1)],
  ]) assert.equal((await store.append(token, sequence, chunk)).ok, false);
  assert.equal((await store.finish('wrong-token')).ok, false);
  assert.equal(store.isActive(), true);
  assert.equal((await store.append(id, 0, bytes)).ok, true);
  assert.equal((await store.append(id, 0, bytes)).ok, false);
  const finished = await store.finish(id);
  assert.equal(finished.ok, true);
  assert.equal(path.extname(finished.data.path), '.mp4');
  assert.deepEqual(await fs.readFile(finished.data.path), Buffer.from(bytes));
});

test('bytes are saved before finish and unknown start payloads create no files', async t => {
  const { directory, store } = await fixture(t);
  for (const options of [null, {}, { mimeType: '../unexpected' }]) {
    assert.equal((await store.start(options)).ok, false);
  }
  assert.deepEqual(await fs.readdir(directory), []);
  const started = await store.start({ mimeType: 'video/webm' });
  await store.append(started.data.id, 0, Uint8Array.of(1, 2, 3));
  assert.deepEqual(await fs.readFile(started.data.path), Buffer.from([1, 2, 3]));
  if (process.platform !== 'win32') assert.equal((await fs.stat(started.data.path)).mode & 0o777, 0o600);
});

test('append copies caller bytes before waiting for disk and handles short writes', async t => {
  let writes = 0;
  const fileSystem = {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      return {
        write(buffer, offset, length, position) {
          writes += 1;
          return handle.write(buffer, offset, Math.min(2, length), position);
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  };
  const { store } = await fixture(t, { fileSystem });
  const started = await store.start({ mimeType: 'video/webm' });
  const bytes = Uint8Array.of(1, 2, 3, 4, 5);
  const writing = store.append(started.data.id, 0, bytes);
  bytes.fill(9);
  assert.equal((await writing).ok, true);
  assert.equal(writes, 3);
  const finished = await store.finish(started.data.id);
  assert.deepEqual(await fs.readFile(finished.data.path), Buffer.from([1, 2, 3, 4, 5]));
});

test('empty recordings leave no file and disposal preserves interrupted video', async t => {
  const { directory, store } = await fixture(t);
  const empty = await store.start({ mimeType: 'video/webm' });
  assert.equal((await store.finish(empty.data.id)).ok, false);
  assert.deepEqual(await fs.readdir(directory), []);
  await store.start({ mimeType: 'video/webm' });
  assert.deepEqual(await store.dispose(), { ok: true, data: null });
  assert.deepEqual(await fs.readdir(directory), []);
  const interrupted = await store.start({ mimeType: 'video/webm' });
  await store.append(interrupted.data.id, 0, Uint8Array.of(1, 2, 3));
  const disposed = await store.dispose();
  assert.equal(disposed.ok, true);
  assert.match(disposed.data.path, /\.partial\.webm$/);
  assert.deepEqual(await fs.readFile(disposed.data.path), Buffer.from([1, 2, 3]));
  assert.equal(store.isActive(), false);
  const resumed = await store.start({ mimeType: 'video/webm' });
  assert.equal(resumed.ok, true);
  assert.notEqual(resumed.data.path, interrupted.data.path);
});

test('same-time recordings get unique files and start errors are recoverable', async t => {
  let refuseOpen = true;
  const fileSystem = {
    ...fs,
    open(...args) {
      if (refuseOpen) return Promise.reject(Object.assign(new Error('fictional permission error'), { code: 'EACCES' }));
      return fs.open(...args);
    },
  };
  const { store } = await fixture(t, { fileSystem, now: () => new Date('2025-01-01T00:00:00Z') });
  assert.equal((await store.start({ mimeType: 'video/webm' })).code, 'EACCES');
  assert.equal(store.isActive(), false);
  refuseOpen = false;
  const paths = [];
  for (let i = 0; i < 2; i++) {
    const started = await store.start({ mimeType: 'video/webm' });
    await store.append(started.data.id, 0, Uint8Array.of(i));
    paths.push((await store.finish(started.data.id)).data.path);
  }
  assert.notEqual(paths[0], paths[1]);
});

test('disk-full failure closes the file and keeps the bytes already written', async t => {
  let writes = 0;
  let closes = 0;
  const fileSystem = {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      return {
        write(...writeArgs) {
          writes += 1;
          if (writes > 1) return Promise.reject(Object.assign(new Error('fictional full disk'), { code: 'ENOSPC' }));
          return handle.write(...writeArgs);
        },
        sync: () => handle.sync(),
        close() { closes += 1; return handle.close(); },
      };
    },
  };
  const { store } = await fixture(t, { fileSystem });
  const started = await store.start({ mimeType: 'video/webm' });
  await store.append(started.data.id, 0, Uint8Array.of(1, 2));
  const failed = await store.append(started.data.id, 1, Uint8Array.of(3, 4));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'ENOSPC');
  assert.equal(closes, 1);
  assert.equal((await store.append(started.data.id, 1, Uint8Array.of(5))).ok, false);
  assert.equal(writes, 2);
  const finished = await store.finish(started.data.id);
  assert.equal(finished.ok, false);
  assert.equal(finished.code, 'ENOSPC');
  assert.deepEqual(await fs.readFile(finished.recoveryPath), Buffer.from([1, 2]));
  assert.equal(store.isActive(), false);
});

test('rename failure preserves the completed partial file', async t => {
  const { store } = await fixture(t, {
    fileSystem: { ...fs, rename: async () => { throw Object.assign(new Error('fictional rename error'), { code: 'EIO' }); } },
  });
  const started = await store.start({ mimeType: 'video/webm' });
  await store.append(started.data.id, 0, Uint8Array.of(1, 2, 3));
  const finished = await store.finish(started.data.id);
  assert.equal(finished.ok, false);
  assert.match(finished.recoveryPath, /\.partial\.webm$/);
  assert.deepEqual(await fs.readFile(finished.recoveryPath), Buffer.from([1, 2, 3]));
  assert.equal(store.isActive(), false);
});
