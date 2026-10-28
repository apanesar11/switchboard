'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { finalizeRecordingWebM } = require('../src/main/recording-webm');
const { createRecordingStore, createRecordingVideoHandler, recordingSrc } = require('../src/main/recordings');

// Small synthetic containers exercise timestamps, offsets and large frame payloads;
// the browser test separately verifies real MediaRecorder output and decoded seeks.
function element(hex, data) {
  const length = data.length;
  const size = length < 127 ? Buffer.from([0x80 | length]) : Buffer.from([0x20 | (length >> 16), (length >> 8) & 255, length & 255]);
  return Buffer.concat([Buffer.from(hex, 'hex'), size, data]);
}

function recording({ unknown = true, duration = null, payload = 100, groups = false } = {}) {
  const ebml = element('1a45dfa3', element('4282', Buffer.from('webm')));
  const infoFields = [element('2ad7b1', Buffer.from('0f4240', 'hex'))];
  if (duration !== null) {
    const value = Buffer.alloc(8); value.writeDoubleBE(duration);
    infoFields.push(element('4489', value));
  }
  const info = element('1549a966', Buffer.concat(infoFields));
  const tracks = element('1654ae6b', element('ae', Buffer.concat([
    element('d7', Buffer.from([1])), element('83', Buffer.from([1])),
    element('86', Buffer.from('V_VP8')),
  ])));
  const clusters = [0, 4000, 8000].map(time => {
    const timestamp = Buffer.alloc(2); timestamp.writeUInt16BE(time);
    const block = (offset, keyframe) => {
      const header = Buffer.from([0x81, 0, offset, keyframe ? 0x80 : 0]);
      const frame = Buffer.concat([header, Buffer.alloc(payload, keyframe ? 11 : 22)]);
      if (!groups) return element('a3', frame);
      frame[3] = 0; // BlockGroup keyframes are identified by the absence of ReferenceBlock.
      return element('a0', Buffer.concat([element('a1', frame), element('9b', Buffer.from([35])),
        ...(keyframe ? [] : [element('fb', Buffer.from([0xd8]))])]));
    };
    const contents = Buffer.concat([element('e7', timestamp), block(0, true), block(40, false)]);
    return unknown ? Buffer.concat([Buffer.from('1f43b67501ffffffffffffff', 'hex'), contents]) : element('1f43b675', contents);
  });
  const finalizedClusters = clusters.map(cluster => {
    const bytes = Buffer.from(cluster);
    if (unknown) bytes.writeBigUInt64BE(BigInt(cluster.length - 12) | (1n << 56n), 4);
    return bytes;
  });
  return { bytes: Buffer.concat([ebml, Buffer.from('1853806701ffffffffffffff', 'hex'), info, tracks, ...clusters]), clusters: finalizedClusters, tracks };
}

function decode(bytes, at = 0) {
  const width = first => { let length = 1; for (let bit = 0x80; !(first & bit); bit >>= 1) length++; return length; };
  const idWidth = width(bytes[at]), sizeWidth = width(bytes[at + idWidth]);
  const id = bytes.subarray(at, at + idWidth).toString('hex');
  let length = bytes[at + idWidth] & ((1 << (8 - sizeWidth)) - 1);
  for (let i = 1; i < sizeWidth; i++) length = length * 256 + bytes[at + idWidth + i];
  const data = at + idWidth + sizeWidth, end = data + length;
  return { id, start: at, data, end, bytes: bytes.subarray(data, end) };
}

function fields(bytes) {
  const values = [];
  for (let at = 0; at < bytes.length;) {
    const item = decode(bytes, at); values.push(item); at = item.end;
  }
  return values;
}

function number(bytes) { return Number(BigInt('0x' + bytes.toString('hex'))); }

function inspect(bytes) {
  const segment = decode(bytes, decode(bytes).end);
  assert.equal(segment.id, '18538067');
  assert.equal(segment.end, bytes.length, 'The finalized Segment has an exact, finite size');
  const metadata = [];
  for (let at = segment.data; at < bytes.length;) {
    const item = decode(bytes, at);
    if (item.id === '1f43b675') return { segment, metadata, payload: bytes.subarray(at) };
    metadata.push(item); at = item.end;
  }
  assert.fail('Missing video clusters');
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-webm-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'example.webm') };
}

for (const unknown of [false, true]) test(`finalizes ${unknown ? 'streaming' : 'sized'} clusters with duration and a front keyframe index`, async t => {
  const { file } = await fixture(t), original = recording({ unknown });
  await fs.writeFile(file, original.bytes);
  assert.equal(await finalizeRecordingWebM(file), true);
  const saved = await fs.readFile(file), { segment, metadata, payload } = inspect(saved);
  assert.deepEqual(payload, Buffer.concat(original.clusters), 'Encoded media is unchanged');
  assert.deepEqual(metadata.map(item => item.id), ['114d9b74', '1549a966', '1654ae6b', '1c53bb6b']);
  const duration = fields(metadata[1].bytes).find(item => item.id === '4489').bytes.readDoubleBE();
  assert.equal(duration, 8080, 'Duration includes the final frame interval');
  assert.deepEqual(saved.subarray(metadata[2].start, metadata[2].end), original.tracks);
  for (const seek of fields(metadata[0].bytes)) {
    const values = fields(seek.bytes);
    const id = values.find(item => item.id === '53ab').bytes.toString('hex');
    const position = number(values.find(item => item.id === '53ac').bytes);
    assert.equal(decode(saved, segment.data + position).id, id, 'SeekHead points to the correct metadata');
  }
  const points = fields(metadata[3].bytes);
  assert.equal(points.length, 3);
  for (const [i, point] of points.entries()) {
    const values = fields(point.bytes);
    assert.equal(number(values.find(item => item.id === 'b3').bytes), i * 4000);
    const positions = fields(values.find(item => item.id === 'b7').bytes);
    assert.equal(number(positions.find(item => item.id === 'f7').bytes), 1);
    const cluster = decode(saved, segment.data + number(positions.find(item => item.id === 'f1').bytes));
    assert.equal(cluster.id, '1f43b675');
    const block = decode(saved, cluster.data + number(positions.find(item => item.id === 'f0').bytes));
    assert.equal(block.id, 'a3');
    assert.equal(block.bytes[3] & 0x80, 0x80, 'Every cue targets a video keyframe');
  }
  const before = await fs.stat(file);
  assert.equal(await finalizeRecordingWebM(file), false, 'Reopening an indexed file does not rewrite it');
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readFile(file), saved);
});

test('preserves a duration already provided by the recorder while adding missing Cues', async t => {
  const { file } = await fixture(t);
  await fs.writeFile(file, recording({ duration: 8500 }).bytes);
  await finalizeRecordingWebM(file);
  const { metadata } = inspect(await fs.readFile(file));
  assert.equal(fields(metadata[1].bytes).find(item => item.id === '4489').bytes.readDoubleBE(), 8500);
});

test('BlockGroup durations and references produce accurate timing and keyframe cues', async t => {
  const { file } = await fixture(t), original = recording({ groups: true });
  await fs.writeFile(file, original.bytes);
  assert.equal(await finalizeRecordingWebM(file), true);
  const saved = await fs.readFile(file), { segment, metadata, payload } = inspect(saved);
  assert.deepEqual(payload, Buffer.concat(original.clusters));
  assert.equal(fields(metadata[1].bytes).find(item => item.id === '4489').bytes.readDoubleBE(), 8075);
  for (const point of fields(metadata[3].bytes)) {
    const positions = fields(fields(point.bytes).find(item => item.id === 'b7').bytes);
    const cluster = decode(saved, segment.data + number(positions.find(item => item.id === 'f1').bytes));
    const group = decode(saved, cluster.data + number(positions.find(item => item.id === 'f0').bytes));
    assert.equal(group.id, 'a0');
    assert.equal(fields(group.bytes).some(field => field.id === 'fb'), false, 'Cues omit dependent frames');
  }
});

test('large recordings use bounded reads and copies, including short disk writes', async t => {
  const { file } = await fixture(t), original = recording({ payload: 400_000 });
  await fs.writeFile(file, original.bytes);
  let largestRead = 0, largestWrite = 0;
  const fileSystem = { ...fs, async open(...args) {
    const handle = await fs.open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === 'read') return (buffer, offset, length, position) => {
        largestRead = Math.max(largestRead, length); return handle.read(buffer, offset, length, position);
      };
      if (property === 'write') return (buffer, offset, length, position) => {
        largestWrite = Math.max(largestWrite, length); return handle.write(buffer, offset, Math.min(length, 8192), position);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  await finalizeRecordingWebM(file, { fileSystem });
  assert.ok(largestRead <= 65536 && largestWrite <= 65536);
  assert.deepEqual(inspect(await fs.readFile(file)).payload, Buffer.concat(original.clusters));
});

test('a failed index write retains the complete original and removes its scratch file', async t => {
  const { directory, file } = await fixture(t), original = recording().bytes;
  await fs.writeFile(file, original);
  const fileSystem = { ...fs, async open(...args) {
    const handle = await fs.open(...args);
    if (args[1] !== 'wx') return handle;
    return { close: () => handle.close(), write: async () => { throw Object.assign(new Error('fictional full disk'), { code: 'ENOSPC' }); } };
  } };
  await assert.rejects(finalizeRecordingWebM(file, { fileSystem }), { code: 'ENOSPC' });
  assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual(await fs.readdir(directory), ['example.webm']);
  assert.equal(await finalizeRecordingWebM(file), true, 'A subsequent repair can succeed');
});

test('malformed WebM is preserved and non-WebM data is left alone', async t => {
  const { directory, file } = await fixture(t);
  const truncated = recording().bytes.subarray(0, 50);
  await fs.writeFile(file, truncated);
  await assert.rejects(finalizeRecordingWebM(file), /original file has been kept/);
  assert.deepEqual(await fs.readFile(file), truncated);
  for (const bytes of [Buffer.alloc(0), Buffer.from('fictional non-WebM data')]) {
    await fs.writeFile(file, bytes);
    assert.equal(await finalizeRecordingWebM(file), false);
    assert.deepEqual(await fs.readFile(file), bytes);
  }
  assert.deepEqual(await fs.readdir(directory), ['example.webm']);
});

test('Stop finishes the seekable container before publishing its video address', async t => {
  const { directory } = await fixture(t), store = createRecordingStore({ directory });
  t.after(() => store.dispose());
  const started = await store.start({ mimeType: 'video/webm;codecs=vp8,opus' });
  const original = recording().bytes;
  for (let at = 0, sequence = 0; at < original.length; at += 37) {
    assert.equal((await store.append(started.data.id, sequence++, original.subarray(at, at + 37))).ok, true);
  }
  const saved = await store.finish(started.data.id);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.data.bytes, (await fs.stat(saved.data.path)).size);
  inspect(await fs.readFile(saved.data.path));
  assert.deepEqual(await fs.readdir(directory), [path.basename(saved.data.path)]);
});

test('an indexing failure during Stop reports the error and retains every original byte for recovery', async t => {
  const { directory } = await fixture(t), original = recording().bytes;
  const fileSystem = { ...fs, async open(...args) {
    const handle = await fs.open(...args);
    if (!args[0].includes('.index-')) return handle;
    return { close: () => handle.close(), write: async () => { throw Object.assign(new Error('fictional full disk'), { code: 'ENOSPC' }); } };
  } };
  const store = createRecordingStore({ directory, fileSystem });
  t.after(() => store.dispose());
  const started = await store.start({ mimeType: 'video/webm' });
  await store.append(started.data.id, 0, original);
  const saved = await store.finish(started.data.id);
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'ENOSPC');
  assert.match(saved.recoveryPath, /\.partial\.webm$/);
  assert.deepEqual(await fs.readFile(saved.recoveryPath), original);
  assert.deepEqual(await fs.readdir(directory), [path.basename(saved.recoveryPath)]);
});

test('concurrent first-open requests repair an older recording and serve ranges from the finalized bytes', async t => {
  const { directory } = await fixture(t);
  const file = path.join(directory, 'Recording-2025-01-01T00-00-00-000Z-12345678-1234-4123-8123-123456789abc.webm');
  await fs.writeFile(file, recording().bytes);
  const handle = createRecordingVideoHandler({ directory, net: { async fetch(url, { headers }) {
    const bytes = await fs.readFile(new URL(url)), range = /bytes=(\d+)-(\d+)/.exec(headers.get('range'));
    return new Response(range ? bytes.subarray(Number(range[1]), Number(range[2]) + 1) : bytes);
  } } });
  const responses = await Promise.all(Array.from({ length: 4 }, () => handle(new Request(recordingSrc(file), { headers: { Range: 'bytes=0-63' } }))));
  const finalized = await fs.readFile(file); inspect(finalized);
  for (const response of responses) {
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), `bytes 0-63/${finalized.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), finalized.subarray(0, 64));
  }
  assert.deepEqual(await fs.readdir(directory), [path.basename(file)]);
});
