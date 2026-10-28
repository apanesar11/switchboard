'use strict';

// MediaRecorder emits a streaming WebM, often without Duration or Cues. Finalize
// that container before playback: metadata and a keyframe index go at the front,
// while the encoded audio/video is copied unchanged with bounded memory.
// https://www.webmproject.org/docs/container/#muxer-guidelines
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

const ID = {
  EBML: 0x1a45dfa3, SEGMENT: 0x18538067, INFO: 0x1549a966, TRACKS: 0x1654ae6b,
  CLUSTER: 0x1f43b675, CUES: 0x1c53bb6b, SEEK_HEAD: 0x114d9b74,
  DURATION: 0x4489, SCALE: 0x2ad7b1, CRC: 0xbf,
};
const TOP_LEVEL = new Set([ID.CLUSTER, ID.CUES, ID.INFO, ID.TRACKS, ID.SEEK_HEAD, 0x1254c367]);
const BUFFER_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;

function invalid() { throw new Error('The recorded WebM could not be indexed. Its original file has been kept.'); }

function vint(bytes, offset = 0, identifier = false) {
  const first = bytes[offset];
  if (!first) return invalid();
  let width = 1, marker = 0x80;
  while (!(first & marker)) { width++; marker /= 2; }
  if (width > (identifier ? 4 : 8) || offset + width > bytes.length) return invalid();
  let value = identifier ? first : first & (marker - 1);
  let unknown = !identifier && value === marker - 1;
  for (let i = 1; i < width; i++) {
    value = value * 256 + bytes[offset + i];
    unknown &&= bytes[offset + i] === 255;
  }
  if (!unknown && !Number.isSafeInteger(value)) return invalid();
  return { value: unknown ? Infinity : value, width };
}

function header(bytes, offset, limit) {
  const id = vint(bytes, offset, true);
  const size = vint(bytes, offset + id.width);
  const data = offset + id.width + size.width;
  const end = size.value === Infinity ? limit : data + size.value;
  if (end > limit || end < data) return invalid();
  return { id: id.value, start: offset, data, end, unknown: size.value === Infinity };
}

function children(bytes) {
  const result = [];
  for (let at = 0; at < bytes.length;) {
    const item = header(bytes, at, bytes.length);
    if (item.unknown) return invalid();
    result.push({ ...item, bytes: bytes.subarray(item.data, item.end) });
    at = item.end;
  }
  return result;
}

function uint(bytes) {
  if (!bytes.length || bytes.length > 8) return invalid();
  let result = 0;
  for (const byte of bytes) result = result * 256 + byte;
  if (!Number.isSafeInteger(result)) return invalid();
  return result;
}

function encodedUint(value, width = 8) {
  if (!Number.isSafeInteger(value) || value < 0) return invalid();
  const result = Buffer.alloc(width);
  for (let i = width - 1; i >= 0; i--) { result[i] = value % 256; value = Math.floor(value / 256); }
  if (value) return invalid();
  return result;
}

function encodedSize(value, width = 1) {
  while (value >= 2 ** (7 * width) - 1) width++;
  const result = encodedUint(value, width);
  result[0] |= 2 ** (8 - width);
  return result;
}

function element(id, ...parts) {
  const bytes = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(id, 'hex'), encodedSize(bytes.length), bytes]);
}

function reader(handle, size) {
  let cache = Buffer.alloc(0), start = -1;
  async function read(at, length) {
    if (length < 0 || length > MAX_METADATA_BYTES || at < 0 || at + length > size) return invalid();
    if (at < start || at + length > start + cache.length) {
      cache = Buffer.alloc(Math.min(Math.max(BUFFER_BYTES, length), size - at));
      start = at;
      let offset = 0;
      while (offset < cache.length) {
        const { bytesRead } = await handle.read(cache, offset, cache.length - offset, at + offset);
        if (!bytesRead) return invalid();
        offset += bytesRead;
      }
    }
    return cache.subarray(at - start, at - start + length);
  }
  return {
    read,
    async item(at, limit = size) {
      const bytes = await read(at, Math.min(12, limit - at));
      const item = header(bytes, 0, limit - at);
      return { ...item, start: at, data: at + item.data, end: at + item.end };
    },
  };
}

async function indexWebM(input, size) {
  const source = reader(input, size);
  if (size < 4 || (await source.read(0, 4)).readUInt32BE() !== ID.EBML) return null;
  const ebml = await source.item(0);
  const segment = await source.item(ebml.end);
  if (ebml.unknown || segment.id !== ID.SEGMENT || segment.end !== size) return invalid();
  let info = null, tracks = null, scale = 1_000_000, duration = 0, hasCues = false;
  const trackInfo = new Map(), cues = [], ranges = [];
  let payloadSize = 0;
  for (let at = segment.data; at < segment.end;) {
    const item = await source.item(at, segment.end);
    if (item.id === ID.INFO) {
      info = children(await source.read(item.data, item.end - item.data));
      for (const field of info) {
        if (field.id === ID.SCALE) scale = uint(field.bytes);
        if (field.id === ID.DURATION) {
          duration = field.bytes.length === 8 ? field.bytes.readDoubleBE() : field.bytes.length === 4 ? field.bytes.readFloatBE() : 0;
        }
      }
    } else if (item.id === ID.TRACKS) {
      tracks = Buffer.from(await source.read(item.start, item.end - item.start));
      for (const entry of children(await source.read(item.data, item.end - item.data)).filter(field => field.id === 0xae)) {
        const fields = children(entry.bytes);
        const number = fields.find(field => field.id === 0xd7);
        const type = fields.find(field => field.id === 0x83);
        const interval = fields.find(field => field.id === 0x23e383);
        if (number && type) trackInfo.set(uint(number.bytes), {
          video: uint(type.bytes) === 1, interval: interval ? uint(interval.bytes) : 0,
          last: null, delta: 0, duration: 0,
        });
      }
    } else if (item.id === ID.CUES) {
      hasCues = true;
    } else if (item.id === ID.CLUSTER) {
      // Our output has all metadata before its first cluster; subsequent opens
      // need only those few header bytes, never another scan through the video.
      if (hasCues && Number.isFinite(duration) && duration > 0) return null;
      let time = 0, indexed = false, end = item.end;
      for (let blockAt = item.data; blockAt < item.end;) {
        const block = await source.item(blockAt, item.end);
        if (item.unknown && TOP_LEVEL.has(block.id)) { end = blockAt; break; }
        if (block.unknown) return invalid();
        if (block.id === 0xe7) time = uint(await source.read(block.data, block.end - block.data));
        let frame = block.id === 0xa3 ? block : null;
        let keyframe = null, frameDuration = 0;
        if (block.id === 0xa0) {
          // Chromium can use BlockGroups (with explicit frame durations) as
          // well as SimpleBlocks. A group is a keyframe when it has no reference.
          keyframe = true;
          for (let fieldAt = block.data; fieldAt < block.end;) {
            const field = await source.item(fieldAt, block.end);
            if (field.unknown) return invalid();
            if (field.id === 0xa1) frame = field;
            if (field.id === 0xfb) keyframe = false;
            if (field.id === 0x9b) frameDuration = uint(await source.read(field.data, field.end - field.data));
            fieldAt = field.end;
          }
        }
        if (frame) {
          const bytes = await source.read(frame.data, Math.min(12, frame.end - frame.data));
          const track = vint(bytes);
          if (!Number.isFinite(track.value) || bytes.length < track.width + 3) return invalid();
          const flags = bytes[track.width + 2];
          // Chromium's camera recorder uses unlaced frames. Refuse an
          // unfamiliar layout rather than write an inaccurate index into it.
          if (flags & 0x06) return invalid();
          const timestamp = time + bytes.readInt16BE(track.width);
          const details = trackInfo.get(track.value);
          if (details) {
            if (details.last !== null && timestamp > details.last) details.delta = timestamp - details.last;
            details.last = Math.max(details.last ?? timestamp, timestamp);
            details.duration = frameDuration;
            if (details.video && (keyframe ?? !!(flags & 0x80)) && !indexed && timestamp >= 0) {
              cues.push({ time: timestamp, track: track.value, position: payloadSize, relative: blockAt - item.data });
              indexed = true;
            }
          }
        }
        blockAt = block.end;
      }
      // Close streaming Clusters too: an unknown-sized child inside a finalized
      // finite Segment is rejected by some demuxers. Only its size header changes.
      const prefix = Buffer.concat([Buffer.from('1f43b675', 'hex'), encodedSize(end - item.data, item.data - item.start - 4)]);
      ranges.push({ start: item.data, end, prefix });
      payloadSize += prefix.length + end - item.data;
      at = end;
      continue;
    } else if (item.id !== ID.SEEK_HEAD && item.id !== ID.CRC) {
      if (item.unknown) return invalid();
      ranges.push({ start: item.start, end: item.end });
      payloadSize += item.end - item.start;
    }
    at = item.end;
  }
  if (!info || !tracks || !cues.length || !Number.isFinite(scale) || scale <= 0) return invalid();
  if (!Number.isFinite(duration) || duration <= 0) {
    duration = Math.max(...Array.from(trackInfo.values(), track =>
      track.last === null ? 0 : track.last + (track.duration || track.interval / scale || track.delta || 1)));
  }
  const durationBytes = Buffer.alloc(8);
  durationBytes.writeDoubleBE(duration);
  const newInfo = element('1549a966', Buffer.concat([
    ...info.filter(field => field.id !== ID.DURATION && field.id !== ID.CRC)
      .map(field => element(field.id.toString(16), field.bytes)), element('4489', durationBytes),
  ]));
  const seekHead = positions => element('114d9b74', ...['1549a966', '1654ae6b', '1c53bb6b'].map((id, i) =>
    element('4dbb', element('53ab', Buffer.from(id, 'hex')), element('53ac', encodedUint(positions[i])))));
  const cueIndex = offset => element('1c53bb6b', Buffer.concat(cues.map(cue => element('bb',
    element('b3', encodedUint(cue.time)), element('b7', element('f7', encodedUint(cue.track)),
      element('f1', encodedUint(offset + cue.position)), element('f0', encodedUint(cue.relative)))))));
  const seekLength = seekHead([0, 0, 0]).length;
  const cuesPosition = seekLength + newInfo.length + tracks.length;
  const index = cueIndex(cuesPosition + cueIndex(0).length);
  const metadata = Buffer.concat([seekHead([seekLength, seekLength + newInfo.length, cuesPosition]), newInfo, tracks, index]);
  // Fixed eight-byte Segment size keeps the payload offsets independent of
  // total recording length (including files larger than four gigabytes).
  const segmentSize = encodedUint(metadata.length + payloadSize);
  segmentSize[0] |= 1;
  return {
    prefix: Buffer.concat([await source.read(0, ebml.end), Buffer.from('18538067', 'hex'),
      segmentSize, metadata]),
    ranges,
  };
}

async function writeAll(handle, bytes) {
  for (let at = 0; at < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, at, bytes.length - at, null);
    if (!bytesWritten) return invalid();
    at += bytesWritten;
  }
}

/** Atomic replacement: a failed index/copy never damages the original recording. */
async function finalizeRecordingWebM(file, { fileSystem = fs } = {}) {
  let input, output, temporary;
  try {
    input = await fileSystem.open(file, 'r');
    const { size } = await input.stat();
    const index = await indexWebM(input, size);
    if (!index) return false;
    temporary = file + '.index-' + randomUUID();
    output = await fileSystem.open(temporary, 'wx', 0o600);
    await writeAll(output, index.prefix);
    const buffer = Buffer.alloc(BUFFER_BYTES);
    for (const range of index.ranges) {
      if (range.prefix) await writeAll(output, range.prefix);
      for (let at = range.start; at < range.end;) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, range.end - at), at);
        if (!bytesRead) return invalid();
        await writeAll(output, buffer.subarray(0, bytesRead));
        at += bytesRead;
      }
    }
    await output.sync();
    await output.close(); output = null;
    await input.close(); input = null;
    await fileSystem.rename(temporary, file);
    temporary = null;
    return true;
  } finally {
    await output?.close().catch(() => {});
    await input?.close().catch(() => {});
    if (temporary) await fileSystem.unlink(temporary).catch(() => {});
  }
}

module.exports = { finalizeRecordingWebM };
