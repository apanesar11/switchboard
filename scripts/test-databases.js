'use strict';

// Fictional drivers exercise the full credential -> discovery -> record lifecycle
// without contacting a database or reading any local workspace configuration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { test, after } = require('node:test');
const { createDatabases, connectionNames, cancelStatement, sqlLead, MAX_RECORDS, MAX_BYTES } = require('../src/main/databases');

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
  const state = { clients: [], mongoClients: [], pgRows: [{ id: '1', name: 'Aster' }], pgEntities: [{ schema: 'public', name: 'customers', kind: 'table' }], pgColumns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'text' }], mongoEntities: [{ name: 'customers' }], mongoRows: [{ _id: 'sample-1', name: 'Aster' }], cursors: [], findCalls: [], aggregateCalls: [], countCalls: [], mongoCount: 42, failConnect: null, failRead: null, holdRead: false, cancels: [] };
  // What a cursor's statement answers (pg-cursor always uses the extended protocol). Like
  // the server, the extended protocol refuses a second statement after a semicolon (one
  // outside quotes).
  state.pgQuery = async config => {
    if (config.queryMode === 'extended' && /;\s*\S/.test(config.text.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'/g, ''))) {
      throw Object.assign(new Error('cannot insert multiple commands into a prepared statement'), { code: '42601', severity: 'ERROR' });
    }
    return { rows: state.pgRows };
  };
  class Cursor {
    constructor(text, values) { this.text = text; this.values = values; this.offset = 0; this.reads = 0; this.closed = false; state.cursors.push(this); }
    read(count, callback) {
      this.reads++;
      this.pending = callback;
      if (state.holdRead) return;
      if (!this.source) this.source = Promise.resolve().then(() => state.pgQuery({ text: this.text, values: this.values, queryMode: 'extended' }, this.client)).then(result => result.rows);
      const answer = (err, batch) => {
        if (this.pending !== callback) return;
        this.pending = null;
        callback(err, batch);
      };
      this.source.then(rows => {
        const batch = rows.slice(this.offset, this.offset + count);
        this.offset += batch.length;
        setImmediate(() => answer(state.failRead, batch));
      }, err => answer(err));
    }
    close(callback) { this.closed = true; setImmediate(() => callback()); }
  }
  class Client {
    constructor(options) {
      this.options = options; this.calls = []; this.closed = false; this.closeCount = 0;
      this.processID = 4000 + state.clients.length; this.secretKey = 77;
      // The socket the driver reads: emit 'data' on it to stand for bytes from the server.
      const client = this;
      const stream = new EventEmitter();
      stream.destroyed = false;
      stream.destroy = () => { stream.destroyed = true; client.drop(new Error('Connection terminated unexpectedly')); };
      this.connection = { stream };
      state.clients.push(this);
    }
    on() {}
    async connect() { if (state.failConnect) throw state.failConnect; }
    query(text, values) {
      if (text instanceof Cursor) { this.cursor = text; text.client = this; this.calls.push({ text: text.text, values: text.values, cursor: true }); return text; }
      this.calls.push({ text, values });
      if (text.includes('information_schema.tables')) return Promise.resolve({ rows: state.pgEntities });
      if (text.includes('information_schema.columns')) return Promise.resolve({ rows: state.pgColumns });
      return Promise.resolve({ rows: [] });
    }
    // A pending read fails as the driver's does when its socket goes.
    drop(err) {
      if (this.cursor && this.cursor.pending) {
        const callback = this.cursor.pending;
        this.cursor.pending = null;
        callback(err);
      }
    }
    async end() {
      this.closed = true;
      this.closeCount++;
      this.drop(Object.assign(new Error('closed'), { code: 'ECONNRESET' }));
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
        collection: collection => ({
          find: (filter, options) => { state.findCalls.push({ collection, filter, options }); return mongoCursor(state.mongoRows, true); },
          aggregate: (pipeline, options) => { state.aggregateCalls.push({ collection, pipeline, options }); return mongoCursor(state.mongoRows, true); },
          countDocuments: async (filter, options) => { state.countCalls.push({ collection, filter, options }); if (state.failRead) throw state.failRead; return state.mongoCount; },
        }),
      };
    }
    async close() { this.closed = true; this.closeCount++; }
  }
  // Stands for the CancelRequest a stopped PostgreSQL client's statement gets.
  async function cancel(Client, uri, client) { state.cancels.push(client.processID); }
  return { state, drivers: { Client, Cursor, MongoClient, cancel } };
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

// ── widget queries (§4.17): a batch by connection name, read-only, plain JSON back ──

const sql = text => [{ sql: text }];
async function widgetQuery(f, ops, name = 'Main database', workspace = 'sample-workspace') {
  return f.database.query(workspace, name, ops);
}

test('a widget batch finds its connection by name in the board\'s workspace; unknown, duplicate or missing ones need a connection', async () => {
  const f = fixture();
  await connection(f);
  const before = f.state.clients.length;
  for (const [workspace, name] of [['sample-workspace', 'Nope'], [null, 'Main database'], ['', 'Main database'], ['missing-workspace', 'Main database'], ['other-workspace', 'Main database'], ['sample-workspace', '']]) {
    const result = await widgetQuery(f, sql('SELECT 1'), name, workspace);
    assert.equal(result.ok, false, `${workspace} ${name}`);
    assert.equal(result.code, 'needs-connection', `${workspace} ${name}`);
  }
  assert.match((await widgetQuery(f, sql('SELECT 1'), 'Nope')).error, /No connection named “Nope”/);
  assert.equal(f.state.clients.length, before, 'nothing connects without the named connection');
  assert.equal((await widgetQuery(f, sql('SELECT 1'))).ok, true);
  await f.database.add('sample-workspace', { name: 'Main database', provider: 'postgres', uri: PG_URI });
  const twice = await widgetQuery(f, sql('SELECT 1'));
  assert.equal(twice.code, 'needs-connection');
  assert.match(twice.error, /2 connections in this workspace are named “Main database”/);
  assert.deepEqual(connectionNames(f.directory, 'sample-workspace'), ['Main database', 'Main database']);
  assert.deepEqual(connectionNames(f.directory, 'other-workspace'), []);
  await f.database.close();
});

test('PostgreSQL: a SELECT, WITH, VALUES or TABLE statement past comments, in one read-only transaction, over the extended protocol', async () => {
  assert.equal(sqlLead('  -- a note\n/* outer /* nested */ still */ select 1'), 'SELECT');
  assert.equal(sqlLead('\r\n\tWITH x AS (SELECT 1) SELECT * FROM x'), 'WITH');
  assert.equal(sqlLead('/* never closed SELECT 1'), '');
  assert.equal(sqlLead('-- only a comment'), '');
  const f = fixture();
  await connection(f);
  f.state.pgRows = [{ id: BigInt(7), created_at: new Date('2025-01-01T00:00:00Z'), profile: { active: true } }];
  const result = await widgetQuery(f, [
    { sql: '  -- open orders\n/* a /* nested */ comment */ select id, created_at from orders where id = $1', params: [7] },
    { sql: 'WITH x AS (SELECT 1) SELECT * FROM x' },
    { sql: 'VALUES (1)' },
    { sql: 'TABLE orders' },
  ]);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.results.length, 4);
  assert.deepEqual(result.results[0], [{ id: '7', created_at: '2025-01-01T00:00:00.000Z', profile: { active: true } }]);
  const client = f.state.clients.at(-1);
  assert.equal(client.options.application_name, 'Switchboard widget');
  assert.deepEqual(client.calls.slice(0, 3).map(call => call.text), ['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 15000', 'SET LOCAL lock_timeout = 5000']);
  const statements = client.calls.slice(3);
  assert.equal(statements.length, 4, 'every statement on the one client');
  assert.ok(statements.every(call => call.cursor), 'each through a cursor, which speaks the extended protocol');
  assert.deepEqual(statements[0].values, [7]);
  assert.deepEqual(statements[1].values, []);
  assert.equal(client.closed, true);
  assert.ok(f.state.cursors.every(cursor => cursor.closed));
  assert.deepEqual(f.state.cancels, [], 'a batch that finished cancels nothing');
  assert.equal(client.connection.stream.listenerCount('data'), 0, 'the byte count stops with the batch');
  await f.database.close();
});

test('PostgreSQL: SET, COMMIT and every other statement are refused before connecting; a second statement or a write is refused by the server', async () => {
  const f = fixture();
  await connection(f);
  const before = f.state.clients.length;
  for (const text of [
    'SET transaction_read_only = off', 'set local statement_timeout = 0', 'RESET ALL', 'COMMIT', 'ROLLBACK', 'BEGIN',
    'START TRANSACTION READ WRITE', 'DELETE FROM orders', 'INSERT INTO orders VALUES (1)', 'UPDATE orders SET total = 0',
    'DROP TABLE orders', 'COPY orders TO STDOUT', 'CALL refresh()', 'DO $$ BEGIN END $$', '-- SELECT\nDELETE FROM orders',
    '/* SELECT */ UPDATE orders SET total = 0', '(SELECT 1)', 'SELECTED', '/* SELECT 1', '', '   ',
    // Functions that act outside the read-only transaction, however they're written.
    "SELECT dblink_exec('dbname=sample', 'DELETE FROM orders')", "SELECT * FROM dblink('dbname=sample', 'SELECT 1') AS t(x int)",
    'SELECT public."dblink_exec"(1)', 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity', 'select PG_CANCEL_BACKEND(1)',
    'SELECT pg_advisory_lock(1)', 'SELECT pg_try_advisory_xact_lock(1)', "SELECT lo_export(1, 'out.bin')", 'SELECT lo_unlink(1)',
    "SELECT set_config('statement_timeout', '0', true)", "WITH s AS (SELECT set_config ('statement_timeout', '0', true)) SELECT 1",
  ]) {
    const result = await widgetQuery(f, sql(text));
    assert.equal(result.code, 'refused', JSON.stringify(text));
  }
  assert.match((await widgetQuery(f, sql('SELECT dblink_exec(1)'))).error, /can't call dblink_exec, because it can act outside the read-only transaction/);
  // One refused statement refuses the whole batch, before anything runs.
  assert.equal((await widgetQuery(f, [{ sql: 'SELECT 1' }, { sql: 'COMMIT' }])).code, 'refused');
  assert.match((await widgetQuery(f, [{ sql: 'SELECT 1' }, { sql: 'COMMIT' }])).error, /^Operation 2: /);
  assert.equal((await widgetQuery(f, [{ sql: 'SELECT $1', params: 'not an array' }])).code, 'refused');
  assert.equal(f.state.clients.length, before, 'nothing connected for a refused batch');

  // Names that only start like one of those functions are columns like any other.
  for (const text of ['SELECT lo_price, set_configuration, dblinker_id FROM orders', 'SELECT current_setting(\'statement_timeout\')']) {
    assert.equal((await widgetQuery(f, sql(text))).ok, true, text);
  }

  const twoStatements = await widgetQuery(f, sql('SELECT 1; DELETE FROM orders'));
  assert.equal(twoStatements.code, 'refused');
  assert.match(twoStatements.error, /one statement/);
  f.state.pgQuery = async () => { throw Object.assign(new Error('cannot execute DELETE in a read-only transaction'), { code: '25006', severity: 'ERROR' }); };
  const write = await widgetQuery(f, sql('WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone'));
  assert.equal(write.code, 'refused');
  assert.match(write.error, /may only read/);
  f.state.pgQuery = async () => { throw Object.assign(new Error('relation "missing" does not exist at ' + PG_URI), { code: '42P01', severity: 'ERROR' }); };
  const missing = await widgetQuery(f, sql('SELECT * FROM missing'));
  assert.equal(missing.code, 'database');
  assert.match(missing.error, /relation "missing" does not exist/);
  assert.equal(missing.error.includes('fictional_password'), false);
  assert.equal(missing.error.includes('postgresql://'), false);
  await f.database.close();
});

const BLOCKED = ['$where', '$function', '$accumulator', '$out', '$merge'];

test('MongoDB: a blocked operator is refused wherever it sits, and every stage, nested ones too, comes from the allow-list', async () => {
  const f = fixture();
  await connection(f, 'mongodb');
  const before = f.state.mongoClients.length;
  const refused = async (ops, why) => {
    const result = await widgetQuery(f, ops, 'Document database');
    assert.equal(result.code, 'refused', why);
    return result;
  };
  for (const key of BLOCKED) {
    await refused([{ find: 'orders', filter: { [key]: 'return true' } }], `${key} in a filter`);
    await refused([{ find: 'orders', filter: { $expr: { $and: [{ [key]: {} }] } } }], `${key} deep in a filter`);
    await refused([{ count: 'orders', filter: { [key]: 1 } }], `${key} in a count`);
    await refused([{ find: 'orders', projection: { total: { [key]: 1 } } }], `${key} in a projection`);
    await refused([{ find: 'orders', sort: { [key]: 1 } }], `${key} in a sort`);
    await refused([{ aggregate: 'orders', pipeline: [{ $group: { _id: null, all: { [key]: {} } } }] }], `${key} in a stage`);
    await refused([{ aggregate: 'orders', pipeline: [{ $lookup: { from: 'items', as: 'items', pipeline: [{ $match: { $expr: { [key]: {} } } }] } }] }], `${key} in $lookup.pipeline`);
    await refused([{ aggregate: 'orders', pipeline: [{ $facet: { open: [{ $match: { status: 'open' } }], other: [{ $match: { [key]: 1 } }] } }] }], `${key} in a $facet branch`);
    await refused([{ aggregate: 'orders', pipeline: [{ $unionWith: { coll: 'archive', pipeline: [{ $match: { [key]: 1 } }] } }] }], `${key} in $unionWith.pipeline`);
  }
  assert.match((await refused([{ find: 'orders', filter: { $where: 'x' } }])).error, /\$where/);
  await refused([{ aggregate: 'orders', pipeline: [{ $project: { x: { $_internalJsEmit: { eval: 'function () {}', this: {} } } } }] }], '$_internalJsEmit in a $project');
  await refused([{ aggregate: 'orders', pipeline: [{ $group: { _id: null, x: { $_internalJsReduce: { data: '$a', eval: 'function () {}' } } } }] }], '$_internalJsReduce in a $group');
  await refused([{ find: 'orders', filter: { $expr: { $_internalAnything: 1 } } }], 'any $_ internal operator');
  for (const stage of ['$collStats', '$currentOp', '$indexStats', '$listSessions', '$documents', '$planCacheStats']) {
    await refused([{ aggregate: 'orders', pipeline: [{ [stage]: {} }] }], stage);
    await refused([{ aggregate: 'orders', pipeline: [{ $facet: { inner: [{ [stage]: {} }] } }] }], `${stage} in a $facet`);
    await refused([{ aggregate: 'orders', pipeline: [{ $lookup: { from: 'items', as: 'x', pipeline: [{ [stage]: {} }] } }] }], `${stage} in a $lookup`);
  }
  await refused([{ aggregate: 'orders', pipeline: [{ $match: {}, $limit: 1 }] }], 'two stages in one object');
  await refused([{ aggregate: 'orders', pipeline: { $match: {} } }], 'a pipeline that is not an array');
  await refused([{ find: 'system.users' }], 'a system collection');
  await refused([{ aggregate: 'orders', pipeline: [{ $lookup: { from: 'system.users', localField: 'a', foreignField: 'b', as: 'c' } }] }], 'a system collection in $lookup');
  await refused([{ find: '' }], 'an empty collection name');
  await refused([{ find: 'orders', limt: 5 }], 'an unknown key');
  await refused([{ find: 'orders', count: 'orders' }], 'two kinds in one op');
  await refused([{ find: 'orders', limit: 0 }], 'a limit of 0');
  await refused([{ find: 'orders', skip: -1 }], 'a negative skip');
  await refused([], 'no operations');
  await refused(Array.from({ length: 21 }, () => ({ count: 'orders' })), 'more than 20 operations');
  await refused('not an array', 'ops that are not an array');
  assert.equal(f.state.mongoClients.length, before, 'nothing connected for a refused batch');

  const allowed = await widgetQuery(f, [{ aggregate: 'orders', pipeline: [
    { $match: { status: 'open' } }, { $addFields: { n: 1 } }, { $set: { m: 2 } }, { $unset: 'm' }, { $project: { total: 1 } },
    { $lookup: { from: 'items', as: 'items', let: { id: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$order', '$$id'] } } }, { $limit: 5 }] } },
    { $unwind: '$items' }, { $group: { _id: '$status', total: { $sum: '$total' } } }, { $sort: { total: -1 } }, { $skip: 0 }, { $limit: 10 },
    { $facet: { top: [{ $sortByCount: '$status' }], buckets: [{ $bucketAuto: { groupBy: '$total', buckets: 4 } }] } },
    { $unionWith: { coll: 'archive', pipeline: [{ $sample: { size: 1 } }] } }, { $replaceWith: '$$ROOT' }, { $count: 'n' },
  ] }], 'Document database');
  assert.equal(allowed.ok, true, allowed.error);
  assert.equal(f.state.aggregateCalls.length, 1);
  assert.equal(f.state.aggregateCalls[0].options.maxTimeMS, 15000);
  assert.equal(f.state.aggregateCalls[0].options.allowDiskUse, false);
  await f.database.close();
});

test('MongoDB: Extended JSON inputs become ObjectIds and Dates, find defaults and caps its limit, results are normalized, count is a number', async () => {
  const { BSON } = require('mongodb');
  const f = fixture();
  await connection(f, 'mongodb');
  f.state.mongoRows = [{ _id: new BSON.ObjectId('0123456789abcdef01234567'), at: new Date('2025-01-01T00:00:00Z'), big: BSON.Long.fromString('9007199254740993'), nested: { tags: ['a'] } }];
  const result = await widgetQuery(f, [
    { find: 'orders', filter: { _id: { $oid: '0123456789abcdef01234567' }, at: { $gte: { $date: '2025-01-01T00:00:00Z' } } }, projection: { total: 1 }, sort: { at: -1 } },
    { find: 'orders', limit: 50000, skip: 5 },
    { count: 'orders', filter: { owner: { $oid: 'fedcba987654321001234567' }, seq: { $numberLong: '9007199254740993' }, n: 5 } },
    { aggregate: 'orders', pipeline: [{ $match: { at: { $lt: { $date: '2026-01-01T00:00:00Z' } } } }] },
  ], 'Document database');
  assert.equal(result.ok, true, result.error);
  const [first, second] = f.state.findCalls;
  assert.equal(first.collection, 'orders');
  assert.equal(first.filter._id._bsontype, 'ObjectId');
  assert.equal(first.filter._id.toHexString(), '0123456789abcdef01234567');
  assert.ok(first.filter.at.$gte instanceof Date);
  assert.equal(first.filter.at.$gte.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.deepEqual({ limit: first.options.limit, skip: first.options.skip, maxTimeMS: first.options.maxTimeMS, projection: first.options.projection, sort: first.options.sort },
    { limit: 1000, skip: 0, maxTimeMS: 15000, projection: { total: 1 }, sort: { at: -1 } });
  assert.equal(second.options.limit, 10000, 'a limit over 10,000 is capped');
  assert.equal(second.options.skip, 5);
  assert.equal(f.state.countCalls[0].filter.owner._bsontype, 'ObjectId');
  assert.equal(f.state.countCalls[0].filter.seq, 9007199254740993n, 'a $numberLong past 2^53 keeps every digit');
  assert.equal(f.state.countCalls[0].filter.n, 5, 'a plain number stays a number');
  assert.equal(f.state.countCalls[0].options.maxTimeMS, 15000);
  assert.ok(f.state.aggregateCalls[0].pipeline[0].$match.at.$lt instanceof Date);
  assert.deepEqual(result.results[0], [{ _id: '0123456789abcdef01234567', at: '2025-01-01T00:00:00.000Z', big: '9007199254740993', nested: { tags: ['a'] } }]);
  assert.equal(result.results[2], 42);
  assert.equal(f.state.mongoClients.at(-1).options.appName, 'Switchboard widget');
  assert.equal(f.state.mongoClients.length, 2, 'one client for the whole batch (and one for the connection\'s check)');
  assert.ok(f.state.cursors.every(cursor => cursor.closed));
  assert.doesNotThrow(() => JSON.stringify(result));
  const bad = await widgetQuery(f, [{ find: 'orders', filter: { _id: { $oid: 'not-hex' } } }], 'Document database');
  assert.equal(bad.code, 'refused');
  assert.match(bad.error, /Extended JSON/);
  await f.database.close();
});

test('a MongoDB operation on a PostgreSQL connection, or SQL on MongoDB, is refused before connecting', async () => {
  const f = fixture();
  await connection(f);
  await connection(f, 'mongodb');
  const clients = f.state.clients.length;
  const mongoClients = f.state.mongoClients.length;
  for (const op of [{ find: 'orders' }, { aggregate: 'orders', pipeline: [] }, { count: 'orders' }]) {
    const result = await widgetQuery(f, [op]);
    assert.equal(result.code, 'refused');
    assert.match(result.error, /PostgreSQL connection, so use sql/);
  }
  const onMongo = await widgetQuery(f, sql('SELECT 1'), 'Document database');
  assert.equal(onMongo.code, 'refused');
  assert.match(onMongo.error, /MongoDB connection/);
  assert.equal((await widgetQuery(f, [{ sql: 'SELECT 1' }, { count: 'orders' }])).code, 'refused');
  assert.equal(f.state.clients.length, clients);
  assert.equal(f.state.mongoClients.length, mongoClients);
  await f.database.close();
});

test('rows or bytes past the caps are too-large, with no partial results', async () => {
  for (const provider of ['postgres', 'mongodb']) {
    const f = fixture({ limits: { widgetRows: 3, widgetBytes: 2048 } });
    const c = await connection(f, provider);
    const ops = provider === 'postgres' ? sql('SELECT * FROM orders') : [{ find: 'orders' }];
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: i }));
    if (provider === 'postgres') f.state.pgRows = rows; else f.state.mongoRows = rows;
    let result = await widgetQuery(f, ops, c.name);
    assert.equal(result.code, 'too-large', provider);
    assert.match(result.error, /more than 3 rows/);
    assert.equal(result.results, undefined);
    const wide = [{ text: 'x'.repeat(3000) }];
    if (provider === 'postgres') f.state.pgRows = wide; else f.state.mongoRows = wide;
    result = await widgetQuery(f, ops, c.name);
    assert.equal(result.code, 'too-large', provider);
    assert.match(result.error, /passed 2 KB/);
    // The byte cap is across the whole batch.
    f.state.pgRows = f.state.mongoRows = [{ text: 'x'.repeat(800) }];
    assert.equal((await widgetQuery(f, [...ops, ...ops], c.name)).ok, true);
    assert.equal((await widgetQuery(f, [...ops, ...ops, ...ops], c.name)).code, 'too-large');
    assert.ok(f.state.cursors.every(cursor => cursor.closed));
    await f.database.close();
  }
});

test('PostgreSQL: the row and byte caps hold as rows arrive, a cursor read at a time, not after the whole result', async () => {
  const f = fixture({ limits: { widgetRows: 3, widgetBytes: 2048 } });
  await connection(f);
  f.state.pgRows = Array.from({ length: 100000 }, (_, i) => ({ id: i }));
  const many = await widgetQuery(f, sql('SELECT * FROM events'));
  assert.equal(many.code, 'too-large');
  assert.match(many.error, /more than 3 rows/);
  const cursor = f.state.cursors.at(-1);
  assert.equal(cursor.reads, 1, 'it stopped in the first read');
  assert.equal(cursor.offset, 250, 'one read of 250 rows, not 100,000');
  assert.equal(cursor.closed, true);
  f.state.pgRows = Array.from({ length: 100000 }, () => ({ text: 'x'.repeat(1000) }));
  const wide = await widgetQuery(f, sql('SELECT * FROM events'));
  assert.equal(wide.code, 'too-large');
  assert.match(wide.error, /passed 2 KB/);
  assert.equal(f.state.cursors.at(-1).offset, 250);
  await f.database.close();
});

test('PostgreSQL: an answer past twice the byte cap on the wire closes the socket, so one huge row never sits whole in memory', async () => {
  const f = fixture({ limits: { widgetBytes: 2048 } });
  await connection(f);
  // Under the wire cap (4 KB here): counted, and nothing happens.
  f.state.pgQuery = async (config, client) => { client.connection.stream.emit('data', Buffer.alloc(3000)); return { rows: [{ id: 1 }] }; };
  const fine = await widgetQuery(f, sql('SELECT 1'));
  assert.equal(fine.ok, true, fine.error);
  assert.equal(f.state.clients.at(-1).connection.stream.destroyed, false);
  // One row of a value far too wide: its bytes arrive and the driver is still buffering it.
  f.state.pgQuery = (config, client) => {
    client.connection.stream.emit('data', Buffer.alloc(3000));
    client.connection.stream.emit('data', Buffer.alloc(3000));
    return new Promise(() => {});
  };
  const huge = await widgetQuery(f, sql("SELECT repeat('x', 400000000)"));
  assert.equal(huge.code, 'too-large');
  assert.match(huge.error, /passed 2 KB/);
  const client = f.state.clients.at(-1);
  assert.equal(client.connection.stream.destroyed, true, 'the socket was closed');
  assert.equal(client.connection.stream.listenerCount('data'), 0);
  assert.equal(client.closed, true);
  // The count is across the batch, like the byte cap.
  f.state.pgQuery = async (config, client) => { client.connection.stream.emit('data', Buffer.alloc(1500)); return { rows: [{ id: 1 }] }; };
  assert.equal((await widgetQuery(f, [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }])).ok, true);
  assert.equal((await widgetQuery(f, [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }, { sql: 'SELECT 3' }])).code, 'too-large');
  await f.database.close();
});

test('connection and server failures never carry the URI or credentials', async () => {
  const f = fixture();
  await connection(f);
  await connection(f, 'mongodb');
  f.state.failConnect = new Error('Could not connect ' + PG_URI + ' as sample_reader with fictional_password');
  for (const name of ['Main database', 'Document database']) {
    const result = await widgetQuery(f, name === 'Main database' ? sql('SELECT 1') : [{ count: 'orders' }], name);
    assert.equal(result.code, 'database');
    for (const secret of ['fictional_password', 'sample_reader', '://']) assert.equal(result.error.includes(secret), false, secret);
  }
  f.state.failConnect = null;
  f.state.failRead = Object.assign(new Error(`bad $match near ${MONGO_URI}`), { name: 'MongoServerError', code: 2 });
  const server = await widgetQuery(f, [{ count: 'orders' }], 'Document database');
  assert.equal(server.code, 'database');
  assert.match(server.error, /bad \$match/);
  assert.equal(server.error.includes('fictional_password'), false);
  f.state.failRead = Object.assign(new Error('operation exceeded time limit'), { name: 'MongoServerError', code: 50 });
  assert.equal((await widgetQuery(f, [{ count: 'orders' }], 'Document database')).code, 'timeout');
  await f.database.close();
});

test('a widget batch waits for one of the four slots instead of failing, while the browser is still refused', async () => {
  const f = fixture({ limits: { timeout: 80, widgetTimeout: 5000 } });
  const c = await connection(f);
  const entity = await selectedEntity(f, c);
  f.state.holdRead = true;
  const before = f.state.clients.length;
  const browsing = Array.from({ length: 4 }, () => f.database.records('sample-workspace', c.id, entity.id));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match((await f.database.records('sample-workspace', c.id, entity.id)).error, /already running/);
  const waiting = widgetQuery(f, sql('SELECT 1'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.state.clients.length, before + 4, 'the widget waits without a client of its own');
  f.state.holdRead = false; // the held reads stay held; the widget's own read answers
  const result = await waiting;
  assert.equal(result.ok, true, result.error);
  assert.equal(f.state.clients.length, before + 5);
  assert.equal(f.state.clients.at(-1).options.application_name, 'Switchboard widget');
  assert.ok((await Promise.all(browsing)).every(r => r.ok === false), 'the held reads timed out and freed their slots');
  await f.database.close();
});

test('a widget batch that waits too long for a slot, or runs past its time limit, times out', async () => {
  const f = fixture({ limits: { timeout: 5000, widgetTimeout: 60 } });
  const c = await connection(f);
  const entity = await selectedEntity(f, c);
  f.state.holdRead = true;
  const browsing = Array.from({ length: 4 }, () => f.database.records('sample-workspace', c.id, entity.id));
  await new Promise(resolve => setTimeout(resolve, 10));
  const waited = await widgetQuery(f, sql('SELECT 1'));
  assert.equal(waited.code, 'timeout');
  assert.match(waited.error, /already running/);
  await f.database.close();
  await Promise.all(browsing);

  f.state.holdRead = false;
  f.state.pgQuery = () => new Promise(() => {});
  f.state.cancels = [];
  const slow = await widgetQuery(f, sql('SELECT pg_sleep(60)'));
  assert.equal(slow.code, 'timeout');
  assert.match(slow.error, /took longer than/);
  assert.equal(f.state.clients.at(-1).closed, true, 'the timed-out client is closed');
  assert.deepEqual(f.state.cancels, [f.state.clients.at(-1).processID], 'and its statement is cancelled on the server');
  await f.database.close();
});

test('removing a connection or quitting cancels a running statement on the server as well as closing its client', async () => {
  const f = fixture({ limits: { timeout: 5000, widgetTimeout: 5000 } });
  const c = await connection(f);
  f.state.pgQuery = () => new Promise(() => {});
  const running = widgetQuery(f, sql('SELECT pg_sleep(60)'));
  await new Promise(resolve => setTimeout(resolve, 20));
  const client = f.state.clients.at(-1);
  assert.equal((await f.database.remove('sample-workspace', c.id)).ok, true);
  assert.equal((await running).ok, false);
  assert.deepEqual(f.state.cancels, [client.processID]);
  await connection(f);
  const quitting = widgetQuery(f, sql('SELECT pg_sleep(60)'));
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = f.state.clients.at(-1);
  await f.database.close();
  assert.equal((await quitting).ok, false);
  assert.deepEqual(f.state.cancels, [client.processID, second.processID]);
});

test('cancelStatement sends a CancelRequest with the process ID and secret key, and settles quietly when it cannot', async () => {
  const { Client } = require('pg');
  const received = [];
  const server = net.createServer(socket => {
    let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 16) { received.push(data); socket.end(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    for (const query of ['', '?sslmode=verify-full']) {
      await cancelStatement(Client, `postgresql://sample_reader:fictional_password@127.0.0.1:${port}/sample${query}`, { processID: 4242, secretKey: 987654 });
    }
    assert.equal(received.length, 2, 'one request each, plain and with TLS asked for');
    for (const data of received) {
      assert.equal(data.length, 16);
      assert.deepEqual([data.readInt32BE(0), data.readInt32BE(4), data.readInt32BE(8), data.readInt32BE(12)], [16, 80877102, 4242, 987654]);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  // Nobody listening, or a client that never connected: it settles without throwing.
  await cancelStatement(Client, `postgresql://sample_reader:fictional_password@127.0.0.1:${port}/sample`, { processID: 4242, secretKey: 1 });
  await cancelStatement(Client, 'postgresql://sample_reader:fictional_password@127.0.0.1:1/sample', { processID: null, secretKey: null });
  assert.equal(received.length, 2);
});

test('closing the app ends a widget batch waiting for a slot', async () => {
  const f = fixture({ limits: { timeout: 5000, widgetTimeout: 5000 } });
  const c = await connection(f);
  const entity = await selectedEntity(f, c);
  f.state.holdRead = true;
  const browsing = Array.from({ length: 4 }, () => f.database.records('sample-workspace', c.id, entity.id));
  await new Promise(resolve => setTimeout(resolve, 10));
  const waiting = widgetQuery(f, sql('SELECT 1'));
  await new Promise(resolve => setTimeout(resolve, 10));
  const started = Date.now();
  await f.database.close();
  const result = await waiting;
  assert.equal(result.ok, false);
  assert.match(result.error, /shutting down/);
  assert.ok(Date.now() - started < 2000, 'it did not wait out its time limit');
  await Promise.all(browsing);
});
