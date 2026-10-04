'use strict';

// Fictional drivers exercise the full credential -> discovery -> record lifecycle
// without contacting a database or reading any local workspace configuration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, after } = require('node:test');
const { createDatabases, MAX_RECORDS, MAX_BYTES } = require('../src/main/databases');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-databases-test-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
let fixtureNumber = 0;
const PG_URI = 'postgresql://sample_reader:fictional_password@db.example.test/sample?sslmode=require';
const MONGO_URI = 'mongodb+srv://sample_reader:fictional_password@cluster.example.test/sample?retryWrites=true';

function secretStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-keychain',
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12), { authTagLength: 16 });
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function mocks() {
  const state = { clients: [], mongoClients: [], pgRows: [{ id: '1', name: 'Aster' }], pgEntities: [{ schema: 'public', name: 'customers', kind: 'table' }], pgColumns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'text' }], mongoEntities: [{ name: 'customers' }], mongoRows: [{ _id: 'sample-1', name: 'Aster' }], cursors: [], findCalls: [], failConnect: null, failRead: null, holdRead: false };
  class Cursor {
    constructor(text, values) { this.text = text; this.values = values; this.offset = 0; this.closed = false; state.cursors.push(this); }
    read(count, callback) {
      if (state.holdRead) { this.pending = callback; return; }
      const batch = state.pgRows.slice(this.offset, this.offset + count);
      this.offset += batch.length;
      setImmediate(() => callback(state.failRead, batch));
    }
    close(callback) { this.closed = true; setImmediate(() => callback()); }
  }
  class Client {
    constructor(options) { this.options = options; this.calls = []; this.closed = false; this.closeCount = 0; state.clients.push(this); }
    on() {}
    async connect() { if (state.failConnect) throw state.failConnect; }
    query(text, values) {
      if (text instanceof Cursor) { this.cursor = text; this.calls.push({ text: text.text, values: text.values }); return text; }
      this.calls.push({ text, values });
      if (text.includes('information_schema.tables')) return Promise.resolve({ rows: state.pgEntities });
      if (text.includes('information_schema.columns')) return Promise.resolve({ rows: state.pgColumns });
      return Promise.resolve({ rows: [] });
    }
    async end() {
      this.closed = true;
      this.closeCount++;
      if (this.cursor && this.cursor.pending) {
        const callback = this.cursor.pending;
        this.cursor.pending = null;
        callback(Object.assign(new Error('closed'), { code: 'ECONNRESET' }));
      }
    }
  }
  function mongoCursor(items, mayFail) {
    const cursor = {
      closed: false,
      async *[Symbol.asyncIterator]() {
        for (const item of items) {
          if (mayFail && state.failRead) throw state.failRead;
          yield item;
        }
      },
      async close() { this.closed = true; },
    };
    state.cursors.push(cursor);
    return cursor;
  }
  class MongoClient {
    constructor(uri, options) { this.uri = uri; this.options = options; this.closed = false; this.closeCount = 0; this.calls = []; state.mongoClients.push(this); }
    async connect() { if (state.failConnect) throw state.failConnect; }
    db(name) {
      this.database = name;
      return {
        listCollections: (filter, options) => { this.calls.push({ filter, options }); return mongoCursor(state.mongoEntities, false); },
        collection: collection => ({ find: (filter, options) => { state.findCalls.push({ collection, filter, options }); return mongoCursor(state.mongoRows, true); } }),
      };
    }
    async close() { this.closed = true; this.closeCount++; }
  }
  return { state, drivers: { Client, Cursor, MongoClient } };
}

function fixture(options = {}) {
  const { state, drivers } = mocks();
  const directory = path.join(temporary, 'fixture-' + ++fixtureNumber);
  const safeStorage = options.safeStorage || secretStorage();
  const args = { directory, safeStorage, resolveWorkspace: id => ['sample-workspace', 'other-workspace', '../traversal-workspace'].includes(id), drivers, ...options };
  const database = createDatabases(args);
  return { database, state, args, directory };
}
async function connection(f, provider = 'postgres', workspace = 'sample-workspace') {
  const result = await f.database.add(workspace, { name: provider === 'postgres' ? 'Main database' : 'Document database', provider, uri: provider === 'postgres' ? PG_URI : MONGO_URI });
  assert.equal(result.ok, true, result.error);
  return result.connection;
}
async function selectedEntity(f, c, workspace = 'sample-workspace') {
  const result = await f.database.entities(workspace, c.id);
  assert.equal(result.ok, true, result.error);
  return result.entities[0];
}

test('connections are verified, encrypted, private on disk, and reloadable without exposing credentials', async () => {
  const f = fixture();
  const c = await connection(f);
  assert.deepEqual(Object.keys(c).sort(), ['createdAt', 'database', 'host', 'id', 'name', 'provider']);
  assert.equal(c.host, 'db.example.test');
  assert.equal(c.database, 'sample');
  assert.equal(f.state.clients.length, 1);
  assert.equal(f.state.clients[0].closed, true);
  const files = fs.readdirSync(f.directory);
  assert.equal(files.length, 1);
  const file = path.join(f.directory, files[0]);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(PG_URI), false);
  assert.equal(raw.includes('fictional_password'), false);
  assert.equal(raw.includes('sample_reader'), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  const persisted = JSON.parse(raw).connections[0];
  assert.equal(f.args.safeStorage.decryptString(Buffer.from(persisted.encryptedUri, 'base64')), PG_URI);
  await f.database.close();
  const reopened = createDatabases(f.args);
  const listed = await reopened.list('sample-workspace');
  assert.deepEqual(listed.connections, [c]);
  const entities = await reopened.entities('sample-workspace', c.id);
  assert.equal(entities.ok, true);
  assert.equal(JSON.stringify(entities).includes('fictional_password'), false);
  await reopened.close();
});

test('workspaces isolate connection identities and traversal-like IDs cannot escape the storage folder', async () => {
  const f = fixture();
  const a = await connection(f);
  const b = await connection(f, 'mongodb', 'other-workspace');
  const traversing = await connection(f, 'postgres', '../traversal-workspace');
  assert.equal((await f.database.entities('other-workspace', a.id)).ok, false);
  assert.equal((await f.database.remove('sample-workspace', b.id)).ok, false);
  assert.deepEqual((await f.database.list('sample-workspace')).connections.map(c => c.id), [a.id]);
  assert.deepEqual((await f.database.list('../traversal-workspace')).connections.map(c => c.id), [traversing.id]);
  assert.equal(fs.readdirSync(f.directory).every(name => /^[a-f0-9]{64}\.json$/.test(name)), true);
  assert.equal((await f.database.list('missing-workspace')).ok, false);
  assert.equal((await f.database.list('sample-workspace ')).ok, false);
  assert.equal((await f.database.remove('sample-workspace', '../other-workspace')).ok, false);
  await f.database.close();
});

test('connection persistence serializes concurrent additions and removal never changes remote data', async () => {
  const f = fixture();
  const results = await Promise.all([1, 2, 3].map(i => f.database.add('sample-workspace', { name: 'Database ' + i, provider: 'postgres', uri: PG_URI })));
  assert.equal(results.every(r => r.ok), true);
  assert.equal((await f.database.list('sample-workspace')).connections.length, 3);
  const count = f.state.clients.length;
  const removed = await f.database.remove('sample-workspace', results[1].connection.id);
  assert.equal(removed.ok, true);
  assert.equal(removed.connections.length, 2);
  assert.equal(f.state.clients.length, count);
  await f.database.close();
});

test('unsafe or missing URI inputs fail before connecting or writing a file', async () => {
  const f = fixture();
  const bad = [
    ['postgres', 'postgresql://db.example.test/'],
    ['postgres', 'mongodb://db.example.test/sample'],
    ['mongodb', 'postgresql://db.example.test/sample'],
    ['mongodb', 'mongodb+srv://cluster.example.test:27017/sample'],
    ['postgres', 'postgresql://db.example.test/sample#secret'],
    ['postgres', 'postgresql://db.example.test/sample\u0000'],
    ['postgres', 'postgresql://db.example.test/a%2Fb'],
    ['postgres', 'postgresql://db.example.test/sample?database=unexpected'],
    ['postgres', 'postgresql://db.example.test/sample?host=elsewhere.example.test'],
    ['mysql', 'mysql://db.example.test/sample'],
    ['postgres', 'not a uri'],
    ['postgres', null],
  ];
  for (const [provider, uri] of bad) assert.equal((await f.database.add('sample-workspace', { name: 'Sample', provider, uri })).ok, false);
  assert.equal(f.state.clients.length, 0);
  assert.equal(f.state.mongoClients.length, 0);
  assert.equal(fs.existsSync(f.directory), false);
  assert.equal((await f.database.add('sample-workspace', { name: '', provider: 'postgres', uri: PG_URI })).ok, false);
  await f.database.close();
});

test('a MongoDB replica-set URI supports multiple hosts and uses its explicit database', async () => {
  const f = fixture();
  const uri = 'mongodb://sample_reader:fictional_password@one.example.test:27017,two.example.test:27017/sample?replicaSet=sample-set';
  const added = await f.database.add('sample-workspace', { name: 'Replica database', provider: 'mongodb', uri });
  assert.equal(added.ok, true, added.error);
  assert.equal(added.connection.host, 'one.example.test:27017,two.example.test:27017');
  assert.equal(f.state.mongoClients[0].database, 'sample');
  await f.database.close();
});

test('unavailable secure storage and the Linux plaintext backend never save credentials', async () => {
  for (const safeStorage of [
    { isEncryptionAvailable: () => false },
    { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' },
  ]) {
    const f = fixture({ safeStorage });
    const added = await f.database.add('sample-workspace', { name: 'Sample', provider: 'postgres', uri: PG_URI });
    assert.equal(added.ok, false);
    assert.match(added.error, /Secure credential storage/);
    assert.equal(fs.existsSync(f.directory), false);
    assert.equal(f.state.clients.length, 0);
    await f.database.close();
  }
});

test('failed connection verification leaves nothing saved and redacts driver errors', async () => {
  const f = fixture();
  f.state.failConnect = new Error('Could not connect ' + PG_URI + ' as sample_reader with fictional_password');
  const added = await f.database.add('sample-workspace', { name: 'Sample', provider: 'postgres', uri: PG_URI });
  assert.equal(added.ok, false);
  assert.equal(added.error.includes('fictional_password'), false);
  assert.equal(added.error.includes('sample_reader'), false);
  assert.equal(added.error.includes('postgresql://'), false);
  assert.deepEqual((await f.database.list('sample-workspace')).connections, []);
  assert.equal(f.state.clients[0].closed, true);
  assert.equal(fs.existsSync(f.directory), false);
  await f.database.close();
});

test('PostgreSQL fetch drains multiple cursor batches in a read-only transaction and preserves data types', async () => {
  const f = fixture();
  const c = await connection(f);
  const entity = await selectedEntity(f, c);
  f.state.pgRows = Array.from({ length: 603 }, (_, i) => ({ id: BigInt(i), name: 'Customer ' + i, profile: { active: true }, created_at: new Date('2025-01-01T00:00:00Z') }));
  const result = await f.database.records('sample-workspace', c.id, entity.id);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.rows.length, 603);
  assert.equal(result.rows[602].id, '602');
  assert.deepEqual(result.rows[0].profile, { active: true });
  assert.equal(result.rows[0].created_at, '2025-01-01T00:00:00.000Z');
  assert.deepEqual(result.columns, f.state.pgColumns);
  assert.equal(Number.isFinite(Date.parse(result.fetchedAt)), true);
  const client = f.state.clients.at(-1);
  assert.equal(client.calls[0].text, 'BEGIN READ ONLY');
  assert.equal(client.calls.some(call => call.text === 'SET LOCAL statement_timeout = 30000'), true);
  assert.equal(client.calls.some(call => call.text === 'SET LOCAL lock_timeout = 5000'), true);
  assert.equal(client.calls.some(call => call.text === 'SELECT * FROM "public"."customers"'), true);
  assert.equal(client.closed, true);
  assert.equal(f.state.cursors.at(-1).closed, true);
  assert.doesNotThrow(() => JSON.stringify(result));
  await f.database.close();
});

test('PostgreSQL entity identifiers are checked against metadata and quoted without executing user SQL', async () => {
  const f = fixture();
  f.state.pgEntities = [{ schema: 'unusual"schema', name: 'customers"; DROP TABLE customers; --', kind: 'table' }];
  const c = await connection(f);
  const entity = await selectedEntity(f, c);
  const result = await f.database.records('sample-workspace', c.id, entity.id);
  assert.equal(result.ok, true, result.error);
  const calls = f.state.clients.at(-1).calls;
  assert.equal(calls.at(-1).text, 'SELECT * FROM "unusual""schema"."customers""; DROP TABLE customers; --"');
  const columnQuery = calls.find(call => call.text.includes('information_schema.columns'));
  assert.deepEqual(columnQuery.values, ['unusual"schema', 'customers"; DROP TABLE customers; --']);
  const forged = Buffer.from(JSON.stringify(['public', 'users; DELETE FROM users'])).toString('base64url');
  const rejected = await f.database.records('sample-workspace', c.id, forged);
  assert.equal(rejected.ok, false);
  assert.equal(f.state.clients.at(-1).calls.some(call => call.text.startsWith('SELECT *')), false);
  await f.database.close();
});

test('an empty PostgreSQL entity retains its columns', async () => {
  const f = fixture();
  const c = await connection(f);
  const entity = await selectedEntity(f, c);
  f.state.pgRows = [];
  const result = await f.database.records('sample-workspace', c.id, entity.id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.columns, f.state.pgColumns);
  await f.database.close();
});

test('MongoDB fetch reads every document, unions fields, and normalizes nested BSON without writes', async () => {
  const f = fixture();
  f.state.mongoEntities.push({ name: 'system.profile' });
  const c = await connection(f, 'mongodb');
  const entities = await f.database.entities('sample-workspace', c.id);
  assert.deepEqual(entities.entities.map(e => e.name), ['customers']);
  f.state.mongoRows = [
    { _id: { _bsontype: 'ObjectId', toHexString: () => '0123456789abcdef01234567' }, profile: { joined: new Date('2025-01-01T00:00:00Z'), tags: ['sample', { rank: 1 }] }, balance: { _bsontype: 'Decimal128', toString: () => '123.45' } },
    { _id: { _bsontype: 'ObjectId', toHexString: () => 'fedcba987654321001234567' }, active: true, profile: null },
  ];
  const result = await f.database.records('sample-workspace', c.id, entities.entities[0].id);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]._id, '0123456789abcdef01234567');
  assert.equal(result.rows[0].balance, '123.45');
  assert.deepEqual(result.rows[0].profile.tags, ['sample', { rank: 1 }]);
  assert.equal(result.rows[0].profile.joined, '2025-01-01T00:00:00.000Z');
  assert.deepEqual(result.columns.map(c => c.name), ['_id', 'profile', 'balance', 'active']);
  assert.equal(result.columns[0].type, 'ObjectId');
  assert.deepEqual(f.state.findCalls[0].filter, {});
  assert.equal(f.state.findCalls[0].options.batchSize, 250);
  assert.equal(f.state.findCalls[0].options.maxTimeMS, 30000);
  assert.equal(f.state.mongoClients.every(client => client.closed), true);
  assert.equal(f.state.cursors.every(cursor => cursor.closed), true);
  assert.doesNotThrow(() => JSON.stringify(result));
  await f.database.close();
});

test('record and memory limits fail explicitly without ever returning a partial prefix', async () => {
  assert.equal(MAX_RECORDS, 100000);
  assert.equal(MAX_BYTES, 32 * 1024 * 1024);
  for (const provider of ['postgres', 'mongodb']) {
    const f = fixture({ limits: { records: 2, bytes: 1024 } });
    const c = await connection(f, provider);
    const entity = await selectedEntity(f, c);
    if (provider === 'postgres') f.state.pgRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    else f.state.mongoRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    let result = await f.database.records('sample-workspace', c.id, entity.id);
    assert.equal(result.ok, false);
    assert.match(result.error, /No partial results/);
    assert.equal(result.rows, undefined);
    if (provider === 'postgres') f.state.pgRows = [{ value: 'x'.repeat(1025) }];
    else f.state.mongoRows = [{ value: 'x'.repeat(1025) }];
    result = await f.database.records('sample-workspace', c.id, entity.id);
    assert.equal(result.ok, false);
    assert.match(result.error, /display limit/);
    assert.equal(result.rows, undefined);
    assert.equal(f.state.cursors.every(cursor => cursor.closed), true);
    await f.database.close();
  }
});

test('authentication and record-read failures stay readable, redact secrets, and close cursors', async () => {
  const f = fixture();
  const c = await connection(f);
  const entity = await selectedEntity(f, c);
  f.state.failRead = Object.assign(new Error('password fictional_password URI ' + PG_URI), { code: '28P01' });
  const result = await f.database.records('sample-workspace', c.id, entity.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /authentication failed/);
  assert.equal(result.error.includes('fictional_password'), false);
  assert.equal(f.state.clients.at(-1).closed, true);
  assert.equal(f.state.cursors.at(-1).closed, true);
  await f.database.close();
});

test('removal still works when the keychain is unavailable and corrupt encrypted data cannot escape', async () => {
  const f = fixture();
  const c = await connection(f);
  f.args.safeStorage.isEncryptionAvailable = () => false;
  assert.equal((await f.database.list('sample-workspace')).ok, true);
  assert.equal((await f.database.list('sample-workspace')).keysSafe, false);
  assert.equal((await f.database.entities('sample-workspace', c.id)).ok, false);
  assert.equal((await f.database.remove('sample-workspace', c.id)).ok, true);
  f.args.safeStorage.isEncryptionAvailable = () => true;
  const fresh = await connection(f);
  const file = path.join(f.directory, fs.readdirSync(f.directory)[0]);
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  persisted.connections[0].encryptedUri = Buffer.from('corrupt-fictional-secret').toString('base64');
  fs.writeFileSync(file, JSON.stringify(persisted));
  const result = await f.database.entities('sample-workspace', fresh.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be unlocked/);
  assert.equal(result.error.includes('corrupt-fictional-secret'), false);
  await f.database.close();
});

test('operation timeout and app shutdown terminate active reads, then allow a canceled quit to resume', async () => {
  const f = fixture({ limits: { timeout: 25 } });
  const c = await connection(f);
  const entity = await selectedEntity(f, c);
  f.state.holdRead = true;
  const result = await f.database.records('sample-workspace', c.id, entity.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.equal(f.state.clients.at(-1).closed, true);
  assert.equal(f.state.clients.at(-1).closeCount, 1);
  const pending = f.database.records('sample-workspace', c.id, entity.id);
  await new Promise(resolve => setTimeout(resolve, 5));
  const draining = f.database.close();
  assert.equal((await f.database.list('sample-workspace')).ok, false);
  await draining;
  assert.equal((await pending).ok, false);
  assert.equal(f.state.clients.at(-1).closed, true);
  assert.equal(f.state.clients.at(-1).closeCount, 1);
  assert.equal((await f.database.list('sample-workspace')).ok, true);
  f.state.holdRead = false;
  assert.equal((await f.database.records('sample-workspace', c.id, entity.id)).ok, true);
  await f.database.close();
});

test('four simultaneous reads are allowed and excess requests are refused without another client', async () => {
  const f = fixture();
  const c = await connection(f);
  const entity = await selectedEntity(f, c);
  f.state.holdRead = true;
  const before = f.state.clients.length;
  const requests = Array.from({ length: 4 }, () => f.database.records('sample-workspace', c.id, entity.id));
  await new Promise(resolve => setTimeout(resolve, 10));
  const excess = await f.database.records('sample-workspace', c.id, entity.id);
  assert.equal(excess.ok, false);
  assert.match(excess.error, /already running/);
  assert.equal(f.state.clients.length, before + 4);
  await f.database.close();
  assert.equal((await Promise.all(requests)).every(r => r.ok === false), true);
});

test('literal special property names survive record normalization without prototype changes', async () => {
  const f = fixture();
  const c = await connection(f);
  const entity = await selectedEntity(f, c);
  f.state.pgRows = [JSON.parse('{"__proto__":{"safe":true},"constructor":"value"}')];
  const result = await f.database.records('sample-workspace', c.id, entity.id);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.rows[0]), ['__proto__', 'constructor']);
  assert.equal(Object.getPrototypeOf(result.rows[0]), Object.prototype);
  assert.equal({}.safe, undefined);
  await f.database.close();
});

test('BSON sentinels, binary payloads, timestamps, and numeric wrappers keep their values', async () => {
  const { BSON } = require('mongodb');
  const f = fixture();
  const c = await connection(f, 'mongodb');
  const entity = await selectedEntity(f, c);
  const binary = new BSON.Binary(Buffer.from('sample'));
  binary.buffer = Buffer.concat([binary.buffer, Buffer.from('unused')]);
  f.state.mongoRows = [{
    minimum: new BSON.MinKey(), maximum: new BSON.MaxKey(), binary,
    stamp: new BSON.Timestamp({ t: 100, i: 3 }), regex: new BSON.BSONRegExp('sample', 'i'),
    count: new BSON.Int32(4), fraction: new BSON.Double(1.25),
    precision: BSON.Long.fromString('9007199254740993'),
    code: new BSON.Code('return sample', { sample: { active: true } }),
  }];
  const result = await f.database.records('sample-workspace', c.id, entity.id);
  assert.equal(result.ok, true, result.error);
  const row = result.rows[0];
  assert.deepEqual(row.minimum, { $minKey: 1 });
  assert.deepEqual(row.maximum, { $maxKey: 1 });
  assert.deepEqual(row.binary, { $binary: Buffer.from('sample').toString('base64'), subType: 0 });
  assert.deepEqual(row.stamp, { $timestamp: { t: 100, i: 3 } });
  assert.deepEqual(row.regex, { $regex: 'sample', $options: 'i' });
  assert.equal(row.count, 4);
  assert.equal(row.fraction, 1.25);
  assert.equal(row.precision, '9007199254740993');
  assert.deepEqual(row.code, { code: 'return sample', scope: { sample: { active: true } } });
  await f.database.close();
});

test('close drains requests still resolving a workspace before they can create a client', async () => {
  let resolve;
  const f = fixture({ resolveWorkspace: () => new Promise(done => { resolve = done; }) });
  const requested = f.database.add('sample-workspace', { name: 'Sample', provider: 'postgres', uri: PG_URI });
  await new Promise(done => setImmediate(done));
  const closing = f.database.close();
  resolve(true);
  const result = await requested;
  assert.equal(result.ok, false);
  await closing;
  assert.equal(f.state.clients.length, 0);
  assert.equal(fs.existsSync(f.directory), false);
});
