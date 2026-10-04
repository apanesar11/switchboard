'use strict';

// Workspace database connections live beside the local configuration. Only the
// main process sees a connection URI; the renderer receives display metadata.
// Queries are deliberately limited to discovering entities and reading records.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_RECORDS = 100000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_CONNECTIONS = 100;
const MAX_ENTITIES = 10000;
const TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 10000;
const BATCH_SIZE = 250;
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const PG_ENTITIES = `SELECT table_schema AS schema, table_name AS name,
  CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS kind
  FROM information_schema.tables
  WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    AND table_schema NOT LIKE 'pg_toast%'
    AND table_type IN ('BASE TABLE', 'VIEW', 'FOREIGN TABLE')
    AND has_table_privilege(quote_ident(table_schema) || '.' || quote_ident(table_name), 'SELECT')
  ORDER BY table_schema, table_name LIMIT ${MAX_ENTITIES + 1}`;
const PG_COLUMNS = `SELECT column_name AS name, data_type AS type
  FROM information_schema.columns
  WHERE table_schema = $1 AND table_name = $2
  ORDER BY ordinal_position`;

function failure(error) { return { ok: false, error }; }
function problem(message) { const err = new Error(message); err.databaseMessage = message; return err; }

// Do not forward driver messages: they may include the URI, credentials, or data.
function errorMessage(err) {
  if (err && err.databaseMessage) return err.databaseMessage;
  const code = err && err.code;
  if (code === 'EACCES' || code === 'EPERM') return 'Permission denied while accessing local database connections.';
  if (code === 'ENOSPC') return 'The disk is full. The database connection could not be saved.';
  if (code === 'EROFS') return 'The local database connections folder is read-only.';
  if (code === '28P01' || code === '28000' || code === 18) return 'Database authentication failed. Check the credentials in your connection URI.';
  if (code === '42501' || code === 13) return 'This database account does not have permission to read that entity.';
  if (code === '3D000' || code === 26) return 'The database or entity no longer exists.';
  if (code === '57014' || code === 50 || code === 'ETIMEDOUT') return 'The database request timed out. Try again or select a smaller entity.';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ECONNRESET') {
    return 'Could not reach the database. Check the host, network access, and connection URI.';
  }
  if (err && /MongoServerSelectionError|MongoNetworkError|MongoNetworkTimeoutError/.test(err.name || '')) {
    return 'Could not reach the database. Check the host, network access, and connection URI.';
  }
  if (err && /certificate|ssl|tls/i.test(err.message || '')) return 'The database TLS connection failed. Check the certificate and TLS options in your URI.';
  return 'The database request failed. Check the connection URI and database permissions, then try again.';
}

function parseUri(provider, value) {
  if (provider !== 'postgres' && provider !== 'mongodb') throw problem('Choose PostgreSQL / Neon or MongoDB.');
  if (typeof value !== 'string' || !value.trim() || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value.trim())) {
    throw problem('Enter a valid database connection URI.');
  }
  const uri = value.trim();
  const match = uri.match(/^([a-z+]+):\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?$/i);
  if (!match) throw problem('Enter a valid database connection URI.');
  const scheme = match[1].toLowerCase();
  if (provider === 'postgres' && scheme !== 'postgres' && scheme !== 'postgresql') throw problem('PostgreSQL / Neon connections need a postgres:// or postgresql:// URI.');
  if (provider === 'mongodb' && scheme !== 'mongodb' && scheme !== 'mongodb+srv') throw problem('MongoDB connections need a mongodb:// or mongodb+srv:// URI.');
  let database;
  try { database = decodeURIComponent((match[3] || '').slice(1)); } catch (_) { throw problem('The database name in the connection URI is invalid.'); }
  if (!database || /[\/\u0000-\u001f\u007f]/.test(database)) throw problem('Include the database name in the connection URI, after the host.');
  const authority = match[2];
  const hostList = authority.slice(authority.lastIndexOf('@') + 1);
  if (!hostList || hostList.includes('@')) throw problem('Enter a valid database host in the connection URI.');
  const hosts = hostList.split(',');
  if (provider === 'postgres' && hosts.length !== 1) throw problem('Use a single PostgreSQL host in the connection URI.');
  if (scheme === 'mongodb+srv' && (hosts.length !== 1 || hosts[0].includes(':'))) throw problem('A MongoDB SRV URI needs one host without a port.');
  for (const host of hosts) {
    try {
      const parsed = new URL('http://' + host);
      if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('host');
    } catch (_) { throw problem('Enter a valid database host in the connection URI.'); }
  }
  // PostgreSQL uses the standard URL parser. MongoDB additionally permits a list
  // of hosts, which the MongoDB driver validates when it establishes the connection.
  if (provider === 'postgres') {
    let parsed;
    try { parsed = new URL(uri); } catch (_) { throw problem('Enter a valid PostgreSQL connection URI.'); }
    if (Array.from(parsed.searchParams.keys()).some(key => ['host', 'port', 'database', 'dbname', 'user', 'password'].includes(key.toLowerCase()))) {
      throw problem('Put PostgreSQL host, database, and credentials directly in the URI, rather than query parameters.');
    }
    // Match pg-connection-string's database decoding so display metadata names
    // exactly the database the driver selects (reserved escapes stay escaped).
    database = decodeURI(parsed.pathname.slice(1));
  }
  return { uri, host: hostList, database };
}

function workspaceFile(directory, wsId) {
  return path.join(directory, crypto.createHash('sha256').update(wsId).digest('hex') + '.json');
}
function metadata(connection) {
  return { id: connection.id, name: connection.name, provider: connection.provider, host: connection.host, database: connection.database, createdAt: connection.createdAt };
}
function entityId(provider, schema, name) {
  return Buffer.from(JSON.stringify(provider === 'postgres' ? [schema, name] : [name])).toString('base64url');
}
function quoteIdentifier(name) { return '"' + name.replace(/"/g, '""') + '"'; }

function valueType(value) {
  if (value === null || value === undefined) return 'null';
  if (value && value._bsontype) return String(value._bsontype);
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (Buffer.isBuffer(value)) return 'binary';
  return typeof value;
}

function normalize(value, seen = new Set(), depth = 0) {
  if (depth > 64) throw problem('This entity contains records nested too deeply to display. No partial results were returned.');
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (Buffer.isBuffer(value)) return { $binary: value.toString('base64') };
  if (value instanceof RegExp) return value.toString();
  if (typeof value !== 'object') return String(value);
  if (value._bsontype) {
    if (value._bsontype === 'Binary' && value.buffer) return { $binary: Buffer.from(value.buffer).subarray(0, value.position === undefined ? value.buffer.length : value.position).toString('base64'), subType: value.sub_type || 0 };
    if (value._bsontype === 'MinKey') return { $minKey: 1 };
    if (value._bsontype === 'MaxKey') return { $maxKey: 1 };
    if (value._bsontype === 'BSONRegExp') return { $regex: value.pattern, $options: value.options };
    if (value._bsontype === 'Timestamp') return { $timestamp: { t: value.high >>> 0, i: value.low >>> 0 } };
    if ((value._bsontype === 'Int32' || value._bsontype === 'Double') && typeof value.value === 'number') return normalize(value.value);
    if (typeof value.toHexString === 'function') return value.toHexString();
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) return value.toString();
  }
  if (seen.has(value)) throw problem('This entity contains a record that cannot be displayed. No partial results were returned.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(v => normalize(v, seen, depth + 1));
    // fromEntries defines own properties, including literal __proto__ columns.
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, normalize(v, seen, depth + 1)]));
  } finally { seen.delete(value); }
}

function collector(limits) {
  const rows = [];
  let bytes = 2;
  return {
    rows,
    add(row) {
      if (rows.length >= limits.records) throw problem(`This entity exceeds the ${limits.records.toLocaleString('en-US')} record limit. No partial results were returned.`);
      const plain = normalize(row);
      bytes += Buffer.byteLength(JSON.stringify(plain), 'utf8') + 1;
      if (bytes > limits.bytes) throw problem('This entity exceeds the 32 MB display limit. No partial results were returned.');
      rows.push(plain);
    },
    finish(columns) {
      if (bytes + Buffer.byteLength(JSON.stringify(columns), 'utf8') > limits.bytes) throw problem('This entity exceeds the 32 MB display limit. No partial results were returned.');
      return { columns, rows, fetchedAt: new Date().toISOString() };
    },
  };
}

function createDatabases({ directory, resolveWorkspace, safeStorage, drivers = {}, limits = {} }) {
  const dir = path.resolve(directory);
  const bounds = { records: limits.records || MAX_RECORDS, bytes: limits.bytes || MAX_BYTES, timeout: limits.timeout || TIMEOUT_MS };
  const writes = new Map();
  const active = new Set();
  const pending = new Set();
  let closed = false;
  let closing = null;
  let sequence = 0;

  async function workspace(wsId) {
    if (closed) throw problem('Database connections are shutting down.');
    if (typeof wsId !== 'string' || !wsId.trim() || wsId !== wsId.trim() || wsId.length > 4096 || !(await resolveWorkspace(wsId))) throw problem('That workspace is not available.');
    return workspaceFile(dir, wsId);
  }
  function keysSafe() {
    try {
      return !!safeStorage && safeStorage.isEncryptionAvailable() && (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text');
    } catch (_) { return false; }
  }
  function encryptionReady() {
    if (!keysSafe()) {
      throw problem('Secure credential storage is unavailable. Enable your operating system keychain before adding a database connection.');
    }
  }
  async function read(file) {
    try {
      const parent = await fs.promises.lstat(dir);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('invalid folder');
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('invalid file');
      const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.connections) || data.connections.length > MAX_CONNECTIONS) throw new Error('invalid connections');
      const ids = new Set();
      for (const c of data.connections) {
        if (!c || !ID_PATTERN.test(c.id) || ids.has(c.id) || !['postgres', 'mongodb'].includes(c.provider) || typeof c.name !== 'string' || !c.name || c.name.length > 80 || typeof c.host !== 'string' || typeof c.database !== 'string' || typeof c.createdAt !== 'string' || typeof c.encryptedUri !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(c.encryptedUri)) throw new Error('invalid connection');
        ids.add(c.id);
      }
      return data.connections;
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      if (err && ['EACCES', 'EPERM'].includes(err.code)) throw err;
      throw problem('The local database connections file could not be read. Restore the file or remove it to start again.');
    }
  }
  async function save(file, connections) {
    if (closed) throw problem('Database connections are shutting down.');
    const tmp = `${file}.${process.pid}.${++sequence}.tmp`;
    try {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const stat = await fs.promises.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('The local database connections path is not a folder.');
      await fs.promises.chmod(dir, 0o700);
      await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, connections }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.promises.rename(tmp, file);
    } catch (err) { await fs.promises.unlink(tmp).catch(() => {}); throw err; }
  }
  function serial(file, task) {
    const before = writes.get(file) || Promise.resolve();
    const run = before.then(task, task);
    const settled = run.catch(() => {});
    writes.set(file, settled);
    settled.then(() => { if (writes.get(file) === settled) writes.delete(file); });
    return run;
  }
  async function getConnection(file, id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw problem('Choose a saved database connection.');
    const connection = (await read(file)).find(c => c.id === id);
    if (!connection) throw problem('That database connection is not available in this workspace.');
    encryptionReady();
    let uri;
    try { uri = safeStorage.decryptString(Buffer.from(connection.encryptedUri, 'base64')); }
    catch (_) { throw problem('This connection could not be unlocked. Remove it and add it again using your connection URI.'); }
    const parsed = parseUri(connection.provider, uri);
    return { ...connection, ...parsed };
  }

  // A dedicated client for each operation keeps transactions isolated, avoids
  // persistent idle connections, and makes shutdown/timeout cleanup explicit.
  async function connected(connection, task) {
    if (closed) throw problem('Database connections are shutting down.');
    if (active.size >= 4) throw problem('Four database requests are already running. Wait for one to finish and try again.');
    let stopping = null;
    let dispose = async () => {};
    const stop = () => { if (!stopping) stopping = Promise.resolve().then(() => dispose()).catch(() => {}); return stopping; };
    let finished;
    const resource = { connectionId: connection.id, client: null, stop, done: new Promise(resolve => { finished = resolve; }) };
    active.add(resource);
    let timer;
    try {
      const operation = (async () => {
        if (connection.provider === 'postgres') {
          const Client = drivers.Client || require('pg').Client;
          const client = resource.client = new Client({ connectionString: connection.uri, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, query_timeout: bounds.timeout, statement_timeout: bounds.timeout, lock_timeout: 5000, idle_in_transaction_session_timeout: bounds.timeout, application_name: 'Switchboard database browser' });
          if (client.on) client.on('error', () => {});
          dispose = () => client.end();
          await client.connect();
          await client.query('BEGIN READ ONLY');
          await client.query(`SET LOCAL statement_timeout = ${bounds.timeout}`);
          await client.query('SET LOCAL lock_timeout = 5000');
          return task(client);
        }
        const MongoClient = drivers.MongoClient || require('mongodb').MongoClient;
        const client = resource.client = new MongoClient(connection.uri, { serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS, connectTimeoutMS: CONNECT_TIMEOUT_MS, socketTimeoutMS: bounds.timeout, maxPoolSize: 1, minPoolSize: 0, appName: 'Switchboard database browser' });
        dispose = () => client.close();
        await client.connect();
        return task(client.db(connection.database));
      })();
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { stop(); reject(problem('The database request timed out. Try again or select a smaller entity.')); }, bounds.timeout);
      });
      const result = await Promise.race([operation, timeout]);
      if (closed) throw problem('The database request was stopped. Try again.');
      return result;
    } finally {
      clearTimeout(timer);
      await stop();
      active.delete(resource);
      finished();
    }
  }

  async function discover(client, provider) {
    if (provider === 'postgres') {
      const result = await client.query(PG_ENTITIES);
      if (result.rows.length > MAX_ENTITIES) throw problem('This database has too many entities to display.');
      return result.rows.map(row => ({ id: entityId(provider, row.schema, row.name), name: row.name, schema: row.schema, kind: row.kind }));
    }
    const cursor = client.listCollections({}, { nameOnly: true, authorizedCollections: true, maxTimeMS: bounds.timeout });
    const entities = [];
    try {
      for await (const collection of cursor) {
        if (!collection.name || collection.name.startsWith('system.')) continue;
        if (entities.length >= MAX_ENTITIES) throw problem('This database has too many entities to display.');
        entities.push({ id: entityId(provider, '', collection.name), name: collection.name, kind: 'collection' });
      }
    } finally { await cursor.close().catch(() => {}); }
    return entities.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function list(wsId) {
    try { return { ok: true, connections: (await read(await workspace(wsId))).map(metadata), keysSafe: keysSafe() }; }
    catch (err) { return failure(errorMessage(err)); }
  }
  async function add(wsId, input) {
    try {
      const file = await workspace(wsId);
      if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(input.name)) throw problem('Give the connection a name of 1 to 80 characters.');
      const parsed = parseUri(input.provider, input.uri);
      encryptionReady();
      const encryptedUri = safeStorage.encryptString(parsed.uri).toString('base64');
      const connection = { id: crypto.randomUUID(), name: input.name.trim(), provider: input.provider, host: parsed.host, database: parsed.database, createdAt: new Date().toISOString(), encryptedUri };
      // A successful Connect verifies the actual account and database before save.
      await connected({ ...connection, uri: parsed.uri }, client => discover(client, connection.provider));
      return await serial(file, async () => {
        const existing = await read(file);
        if (existing.length >= MAX_CONNECTIONS) throw problem('This workspace already has 100 database connections. Remove one before adding another.');
        existing.push(connection);
        await save(file, existing);
        return { ok: true, connection: metadata(connection), connections: existing.map(metadata) };
      });
    } catch (err) { return failure(errorMessage(err)); }
  }
  async function remove(wsId, id) {
    try {
      const file = await workspace(wsId);
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw problem('Choose a saved database connection.');
      return await serial(file, async () => {
        const existing = await read(file);
        if (!existing.some(c => c.id === id)) throw problem('That database connection is not available in this workspace.');
        const connections = existing.filter(c => c.id !== id);
        await save(file, connections);
        await Promise.allSettled(Array.from(active).filter(r => r.connectionId === id).map(r => r.stop()));
        return { ok: true, connections: connections.map(metadata) };
      });
    } catch (err) { return failure(errorMessage(err)); }
  }
  async function entities(wsId, id) {
    try {
      const connection = await getConnection(await workspace(wsId), id);
      return { ok: true, entities: await connected(connection, client => discover(client, connection.provider)) };
    } catch (err) { return failure(errorMessage(err)); }
  }
  async function records(wsId, id, selectedEntityId) {
    try {
      if (typeof selectedEntityId !== 'string' || !selectedEntityId || selectedEntityId.length > 4096) throw problem('Choose an entity from this database.');
      const connection = await getConnection(await workspace(wsId), id);
      const result = await connected(connection, async client => {
        const entity = (await discover(client, connection.provider)).find(e => e.id === selectedEntityId);
        if (!entity) throw problem('That entity is no longer available. Refresh the entity list and select it again.');
        const collected = collector(bounds);
        if (connection.provider === 'postgres') {
          const columns = (await client.query(PG_COLUMNS, [entity.schema, entity.name])).rows.map(c => ({ name: c.name, type: c.type }));
          const Cursor = drivers.Cursor || require('pg-cursor');
          const cursor = client.query(new Cursor(`SELECT * FROM ${quoteIdentifier(entity.schema)}.${quoteIdentifier(entity.name)}`, []));
          try {
            while (true) {
              const rows = await new Promise((resolve, reject) => cursor.read(BATCH_SIZE, (err, batch) => err ? reject(err) : resolve(batch)));
              if (!rows.length) break;
              for (const row of rows) collected.add(row);
            }
          } finally { await new Promise(resolve => cursor.close(() => resolve())).catch(() => {}); }
          return collected.finish(columns);
        }
        const types = new Map();
        const cursor = client.collection(entity.name).find({}, { batchSize: BATCH_SIZE, maxTimeMS: bounds.timeout });
        try {
          for await (const document of cursor) {
            collected.add(document);
            for (const [name, value] of Object.entries(document)) {
              const next = valueType(value);
              if (!types.has(name) || types.get(name) === 'null') types.set(name, next);
              else if (next !== 'null' && types.get(name) !== next) types.set(name, 'mixed');
            }
          }
        } finally { await cursor.close().catch(() => {}); }
        return collected.finish(Array.from(types, ([name, type]) => ({ name, type })));
      });
      return { ok: true, ...result };
    } catch (err) { return failure(errorMessage(err)); }
  }
  function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const running = Array.from(active);
      await Promise.allSettled(running.map(r => r.stop()));
      await Promise.allSettled(running.map(r => r.done));
      await Promise.allSettled(Array.from(writes.values()));
      await Promise.allSettled(Array.from(pending));
      return { ok: true };
    })().finally(() => { closed = false; closing = null; });
    return closing;
  }
  function expose(operation) {
    return (...args) => {
      if (closed) return Promise.resolve(failure('Database connections are shutting down.'));
      const request = Promise.resolve().then(() => operation(...args)).catch(err => failure(errorMessage(err)));
      pending.add(request);
      request.then(() => pending.delete(request));
      return request;
    };
  }
  return { list: expose(list), add: expose(add), remove: expose(remove), entities: expose(entities), records: expose(records), close };
}

module.exports = { createDatabases, MAX_RECORDS, MAX_BYTES };
