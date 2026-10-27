'use strict';

// Camera recordings are written a chunk at a time, outside the repository. Main
// supplies the directory; the renderer gets only an opaque recording id and never
// chooses a file name or a path. Interrupted files retain their container extension
// so the bytes already saved can still be opened by a video player.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const MAX_RECORDING_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_BYTES = 2 * MAX_RECORDING_CHUNK_BYTES;
const RECORDING_FILE = /^Recording-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webm|mp4)$/;

/** A finished recording's persisted address; no local path goes into a board. */
function recordingSrc(filePath) {
  if (typeof filePath !== 'string') return null;
  const name = path.basename(filePath);
  const match = RECORDING_FILE.exec(name);
  return match && match[0] === name ? 'sbvideo://recording/' + name : null;
}

/** Only finished files made by this recorder are playable through sbvideo://. */
function createRecordingVideoHandler({ directory, net }) {
  return async request => {
    const missing = () => new Response('not found', { status: 404 });
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) return missing();
    let name;
    try {
      const url = new URL(request.url);
      name = url.pathname.slice(1);
      if (url.protocol !== 'sbvideo:' || url.host !== 'recording' || url.username || url.password ||
          url.search || (url.hash && !/^#t=\d+(?:\.\d+)?$/.test(url.hash)) ||
          recordingSrc(name) !== 'sbvideo://recording/' + name ||
          request.url.split('#')[0] !== 'sbvideo://recording/' + name) return missing();
    } catch (_) { return missing(); }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    const file = path.join(directory, name);
    try {
      // A link with a plausible filename must not expose a file outside this folder.
      const stat = await fs.lstat(file);
      if (!stat.isFile()) return missing();
      const resultHeaders = new Headers({
        'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'video/webm',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(stat.size),
      });
      const headers = new Headers();
      const range = request.headers.get('range');
      let status = 200;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const suffix = match && !match[1];
        const start = match && (suffix ? Math.max(0, stat.size - Number(match[2])) : Number(match[1]));
        const end = match && (suffix || !match[2] ? stat.size - 1 : Math.min(Number(match[2]), stat.size - 1));
        if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            start < 0 || end < start || start >= stat.size) {
          resultHeaders.set('Content-Range', `bytes */${stat.size}`);
          resultHeaders.set('Content-Length', '0');
          return new Response(null, { status: 416, headers: resultHeaders });
        }
        status = 206;
        headers.set('Range', `bytes=${start}-${end}`);
        resultHeaders.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        resultHeaders.set('Content-Length', String(end - start + 1));
      }
      if (request.method === 'HEAD') return new Response(null, { status, headers: resultHeaders });
      const response = await net.fetch(pathToFileURL(file).href, { headers, signal: request.signal });
      if (response.status !== 200 && response.status !== 206) return missing();
      // Electron's file loader honors Range but answers 200 without range headers.
      // Supply the standard 206/Content-Range contract so native video can seek.
      return new Response(response.body, { status, headers: resultHeaders });
    } catch (_) { return missing(); }
  };
}

function recordingExtension(mimeType) {
  if (typeof mimeType !== 'string' || mimeType.length > 160) return null;
  const match = /^(video\/(webm|mp4))(?:;\s*codecs=(?:"([a-z0-9., -]+)"|([a-z0-9., -]+)))?$/i.exec(mimeType.trim());
  if (!match) return null;
  const codecs = match[3] || match[4];
  if (codecs) {
    const allowed = match[2].toLowerCase() === 'webm'
      ? /^(?:vp8|vp9|vp09(?:\.[0-9]+)+|av1|av01(?:\.[0-9a-z]+)+|opus)$/i
      : /^(?:h264|avc[13](?:\.[0-9a-f]+)?|aac|mp4a\.40\.[0-9]+)$/i;
    if (!codecs.split(',').every(codec => allowed.test(codec.trim()))) return null;
  }
  return match[2].toLowerCase();
}

function failure(error, fallback = 'Could not save the recording.') {
  if (error && error.code === 'ENOSPC') return { ok: false, error: 'The disk is full. Free some space before recording again.', code: 'ENOSPC' };
  if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
    return { ok: false, error: 'Switchboard cannot write to the recordings folder.', code: error.code };
  }
  return { ok: false, error: fallback, ...(error && error.code ? { code: error.code } : {}) };
}

function createRecordingStore({ directory, fileSystem = fs, now = () => new Date() } = {}) {
  let active = null;
  let pendingBytes = 0;
  let chain = Promise.resolve();
  let recentFinish = null;

  // Even a finish sent before an append has returned waits for that append. Each
  // chunk's promise resolves only when all of its bytes have reached the file.
  function serial(operation) {
    const next = chain.then(operation).catch(error => failure(error));
    chain = next.then(() => {});
    return next;
  }

  function details(recording, filePath = recording.partialPath) {
    return {
      id: recording.id,
      path: filePath,
      mimeType: recording.mimeType,
      bytes: recording.bytes,
      chunks: recording.chunks,
    };
  }

  async function close(recording) {
    if (!recording.handle) return;
    const handle = recording.handle;
    recording.handle = null;
    await handle.close();
  }

  return {
    start(options = {}) {
      return serial(async () => {
        if (active) return { ok: false, error: 'A recording is already in progress.' };
        const mimeType = options && options.mimeType;
        const extension = recordingExtension(mimeType);
        if (!extension) return { ok: false, error: 'This recording format is not supported.' };
        if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
          return { ok: false, error: 'The recordings folder is unavailable.' };
        }
        const id = randomUUID();
        const stamp = now().toISOString().replace(/[:.]/g, '-');
        const base = `Recording-${stamp}-${id}`;
        const partialPath = path.join(directory, `${base}.partial.${extension}`);
        const finalPath = path.join(directory, `${base}.${extension}`);
        await fileSystem.mkdir(directory, { recursive: true });
        const handle = await fileSystem.open(partialPath, 'wx', 0o600);
        active = { id, mimeType, partialPath, finalPath, handle, bytes: 0, chunks: 0, failed: null };
        return { ok: true, data: details(active) };
      });
    },

    append(id, sequence, bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_RECORDING_CHUNK_BYTES) {
        return Promise.resolve({ ok: false, error: 'The recording chunk is empty or too large.' });
      }
      if (pendingBytes + bytes.byteLength > MAX_PENDING_BYTES) {
        return Promise.resolve({ ok: false, error: 'The recording is arriving faster than it can be saved.' });
      }
      // IPC hands us a Uint8Array, not a file. Copy before waiting in the queue so a
      // caller cannot change a chunk after it has passed validation.
      const chunk = Buffer.from(bytes);
      pendingBytes += chunk.length;
      const result = serial(async () => {
        if (!active || typeof id !== 'string' || id !== active.id) {
          return { ok: false, error: 'This recording is no longer active.' };
        }
        if (!Number.isSafeInteger(sequence) || sequence !== active.chunks) {
          return { ok: false, error: 'A recording chunk arrived out of order.' };
        }
        if (active.failed) return active.failed;
        const recording = active;
        try {
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await recording.handle.write(chunk, offset, chunk.length - offset, null);
            if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.length - offset) {
              throw new Error('The recording write did not complete.');
            }
            recording.bytes += bytesWritten;
            offset += bytesWritten;
          }
          recording.chunks += 1;
          return { ok: true, data: { bytes: recording.bytes, chunks: recording.chunks } };
        } catch (error) {
          recording.failed = failure(error);
          try { await close(recording); } catch (_) { /* Keep the original write error. */ }
          return recording.failed;
        }
      });
      return result.finally(() => { pendingBytes -= chunk.length; });
    },

    finish(id) {
      return serial(async () => {
        // A device ending and a Stop click can both request the same finish.
        if (recentFinish && id === recentFinish.id) return recentFinish.result;
        if (!active || typeof id !== 'string' || id !== active.id) {
          return { ok: false, error: 'This recording is no longer active.' };
        }
        const recording = active;
        active = null;
        const remember = result => {
          recentFinish = { id, result };
          return result;
        };
        try {
          if (recording.bytes === 0) {
            await close(recording);
            await fileSystem.unlink(recording.partialPath);
            return remember(recording.failed || { ok: false, error: 'The recording contained no video.' });
          }
          if (recording.handle && !recording.failed) await recording.handle.sync();
          await close(recording);
          if (recording.failed) return remember({ ...recording.failed, recoveryPath: recording.partialPath });
          await fileSystem.rename(recording.partialPath, recording.finalPath);
          return remember({ ok: true, data: { ...details(recording, recording.finalPath), src: recordingSrc(recording.finalPath) } });
        } catch (error) {
          try { await close(recording); } catch (_) { /* The partial file is retained. */ }
          return remember({ ...failure(error), recoveryPath: recording.partialPath });
        }
      });
    },

    isActive() {
      return active !== null;
    },

    // Close after renderer loss or app shutdown. The store can be used again after
    // disposal, for a new window; no interrupted bytes are silently deleted.
    dispose() {
      return serial(async () => {
        if (!active) return { ok: true, data: null };
        const recording = active;
        active = null;
        try {
          await close(recording);
          if (recording.bytes === 0) {
            await fileSystem.unlink(recording.partialPath);
            return { ok: true, data: null };
          }
          return { ok: true, data: details(recording) };
        } catch (error) {
          return { ...failure(error), recoveryPath: recording.partialPath };
        }
      });
    },
  };
}

module.exports = { createRecordingStore, createRecordingVideoHandler, recordingSrc, recordingExtension, MAX_RECORDING_CHUNK_BYTES };
