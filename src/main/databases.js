'use strict';

// Workspace database connections live beside the local configuration. Only the
// main process sees a connection URI; the renderer receives display metadata.
// Queries are deliberately limited to discovering entities and reading records.
//
// Whiteboard widgets (§4.17) read a saved connection too, through query(): a batch of
// MongoDB find/aggregate/countDocuments calls or PostgreSQL SELECTs, named by the
// connection's NAME in the board's workspace (widget.json's "database"). The widget
// writes the query, so every part of it is checked here before anything runs, and the
// answer is plain JSON, normalized exactly as the Databases browser's records are.

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
// How long a CancelRequest may take to reach the server before it is given up on.
const CANCEL_TIMEOUT_MS = 3000;
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// The most requests that hold a database client at once — the browser's and widgets'.
const MAX_ACTIVE = 4;

// A widget's batch (query()). The widget SDK documents these numbers; keep them in step.
const WIDGET_MAX_OPS = 20;
const WIDGET_FIND_LIMIT = 1000;
const WIDGET_MAX_ROWS = 10000;
const WIDGET_MAX_BYTES = 8 * 1024 * 1024;
const WIDGET_TIMEOUT_MS = 15000;
const WIDGET_MAX_INPUT_BYTES = 256 * 1024;
const WIDGET_MAX_DEPTH = 64;
const WIDGET_MAX_STAGES = 100;
const WIDGET_SQL_MAX = 100000;
const WIDGET_MAX_PARAMS = 1000;
const WIDGET_APP_NAME = 'Switchboard widget';
// Operators that run JavaScript on the server ($where, $function, $accumulator) or write
// a collection ($out, $merge) — refused wherever they appear, however deep. So is every
// "$_" key: MongoDB's undocumented internals ($_internalJsEmit, $_internalJsReduce, …)
// include server-side JavaScript, and no public operator starts that way.
const WIDGET_BLOCKED_KEYS = new Set(['$where', '$function', '$accumulator', '$out', '$merge']);
const WIDGET_BLOCKED_PREFIX = '$_';
// The aggregation stages a widget may use: all of them only read.
const WIDGET_STAGES = new Set([
  '$match', '$project', '$addFields', '$set', '$unset', '$group', '$sort', '$limit', '$skip',
  '$unwind', '$lookup', '$count', '$facet', '$bucket', '$bucketAuto', '$sortByCount',
  '$replaceRoot', '$replaceWith', '$sample', '$unionWith', '$densify', '$fill',
  '$setWindowFields', '$graphLookup', '$redact',
]);
// The statements a widget may send to PostgreSQL, by their first word. SET, RESET, BEGIN,
// COMMIT, ROLLBACK and everything else fail this, so nothing in a batch can end the
// read-only transaction it runs in.
const WIDGET_SQL_LEADS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE']);
// Functions a SELECT can call that act outside its read-only transaction: dblink opens a
// connection of its own and commits there, the backend signals stop other sessions,
// advisory locks and large-object exports reach past the statement, and set_config can
// switch off the statement's time limit. A text check, so a defence in depth and not a
// wall (SQL built from strings gets past it): the real one is a role with only SELECT.
const WIDGET_SQL_BLOCKED = /\b(dblink(?:_\w+)?|pg_terminate_backend|pg_cancel_backend|pg_(?:try_)?advisory_\w+|lo_(?:import|export|unlink|create|creat|put|from_bytea|truncate)|lowrite|set_config)\b/i;
const WIDGET_OP_KEYS = {
  find: ['find', 'filter', 'projection', 'sort', 'limit', 'skip'],
  aggregate: ['aggregate', 'pipeline'],
  count: ['count', 'filter'],
  sql: ['sql', 'params'],
};

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
// A problem with a widget query's code from the contract: 'needs-connection', 'refused',
// 'too-large', 'timeout' or 'database'.
function widgetProblem(code, message) { const err = problem(message); err.widgetCode = code; return err; }

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

// ── widget queries: the checks, before anything runs ─────────────────────────

function isPlain(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** The first word of a SQL statement, upper-cased, past leading whitespace and comments. */
function sqlLead(text) {
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.startsWith('--', i)) {
      const end = text.slice(i).search(/[\n\r]/);
      if (end === -1) return '';
      i += end + 1;
      continue;
    }
    if (text.startsWith('/*', i)) {
      // PostgreSQL's block comments nest.
      let depth = 1;
      i += 2;
      while (i < text.length && depth) {
        if (text.startsWith('/*', i)) { depth++; i += 2; }
        else if (text.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) return '';
      continue;
    }
    break;
  }
  const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(i));
  return word ? word[0].toUpperCase() : '';
}

/** Refuses a blocked operator anywhere in a filter, projection, sort or pipeline. */
function guardKeys(value, depth = 0) {
  if (depth > WIDGET_MAX_DEPTH) throw widgetProblem('refused', 'That query is nested too deeply.');
  if (Array.isArray(value)) { for (const item of value) guardKeys(item, depth + 1); return; }
  if (!isPlain(value)) return;
  for (const key of Object.keys(value)) {
    if (WIDGET_BLOCKED_KEYS.has(key) || key.startsWith(WIDGET_BLOCKED_PREFIX)) throw widgetProblem('refused', `Widgets can't use ${key}, because it runs code on the server or writes data.`);
    guardKeys(value[key], depth + 1);
  }
}

function guardCollection(name) {
  if (typeof name !== 'string' || !name || name.length > 255 || name.includes('\u0000')) throw widgetProblem('refused', 'Name the collection as text, like "orders".');
  if (name.startsWith('system.')) throw widgetProblem('refused', `Widgets can't read ${name}, one of MongoDB's own collections.`);
  return name;
}

/** Every stage from the allow-list — in $lookup, $unionWith and $facet's pipelines too. */
function guardPipeline(pipeline, depth = 0) {
  if (!Array.isArray(pipeline)) throw widgetProblem('refused', 'A pipeline is an array of stages, like [{ "$match": { … } }].');
  if (pipeline.length > WIDGET_MAX_STAGES) throw widgetProblem('refused', `A pipeline may have at most ${WIDGET_MAX_STAGES} stages.`);
  if (depth > 8) throw widgetProblem('refused', 'That pipeline is nested too deeply.');
  for (const stage of pipeline) {
    const names = isPlain(stage) ? Object.keys(stage) : [];
    if (names.length !== 1) throw widgetProblem('refused', 'Each stage is an object with one stage name, like { "$match": { … } }.');
    const name = names[0];
    if (!WIDGET_STAGES.has(name)) throw widgetProblem('refused', `Widgets can't use the ${name} stage; they may only read.`);
    const body = stage[name];
    if ((name === '$lookup' || name === '$graphLookup') && isPlain(body) && body.from !== undefined) guardCollection(body.from);
    if (name === '$lookup' && isPlain(body) && body.pipeline !== undefined) guardPipeline(body.pipeline, depth + 1);
    if (name === '$unionWith') {
      const coll = typeof body === 'string' ? body : isPlain(body) ? body.coll : undefined;
      if (coll !== undefined) guardCollection(coll);
      if (isPlain(body) && body.pipeline !== undefined) guardPipeline(body.pipeline, depth + 1);
    }
    if (name === '$facet') {
      if (!isPlain(body)) throw widgetProblem('refused', '$facet takes an object of named pipelines.');
      for (const branch of Object.values(body)) guardPipeline(branch, depth + 1);
    }
  }
}

function optionalObject(value, what) {
  if (value === undefined || value === null) return undefined;
  if (!isPlain(value)) throw widgetProblem('refused', `${what} must be an object.`);
  guardKeys(value);
  return value;
}

/** One operation of a batch, checked: { kind, provider, … } — or a 'refused' throw. */
function planOp(op) {
  if (!isPlain(op)) throw widgetProblem('refused', 'Each operation is an object, like { "find": "orders" }.');
  const kinds = Object.keys(WIDGET_OP_KEYS).filter(kind => Object.prototype.hasOwnProperty.call(op, kind));
  if (kinds.length !== 1) throw widgetProblem('refused', 'Each operation names exactly one of find, aggregate, count or sql.');
  const kind = kinds[0];
  const stray = Object.keys(op).find(key => !WIDGET_OP_KEYS[kind].includes(key));
  if (stray !== undefined) throw widgetProblem('refused', `A ${kind} operation has no "${String(stray).slice(0, 40)}"; it takes ${WIDGET_OP_KEYS[kind].join(', ')}.`);
  if (kind === 'sql') {
    const text = op.sql;
    if (typeof text !== 'string' || !text.trim()) throw widgetProblem('refused', 'Give the SQL statement as text.');
    if (text.length > WIDGET_SQL_MAX || text.includes('\u0000')) throw widgetProblem('refused', `A SQL statement may be at most ${WIDGET_SQL_MAX.toLocaleString('en-US')} characters.`);
    if (!WIDGET_SQL_LEADS.has(sqlLead(text))) throw widgetProblem('refused', 'Widgets may only run a SELECT, WITH, VALUES or TABLE statement.');
    const blocked = WIDGET_SQL_BLOCKED.exec(text);
    if (blocked) throw widgetProblem('refused', `Widgets can't call ${blocked[1].toLowerCase()}, because it can act outside the read-only transaction.`);
    const params = op.params === undefined || op.params === null ? [] : op.params;
    if (!Array.isArray(params) || params.length > WIDGET_MAX_PARAMS) throw widgetProblem('refused', `SQL params are an array of at most ${WIDGET_MAX_PARAMS} values.`);
    return { kind, provider: 'postgres', sql: text, params };
  }
  const collection = guardCollection(op[kind]);
  if (kind === 'aggregate') {
    guardKeys(op.pipeline);
    guardPipeline(op.pipeline);
    return { kind, provider: 'mongodb', collection, pipeline: op.pipeline };
  }
  const filter = optionalObject(op.filter, 'A filter') || {};
  if (kind === 'count') return { kind, provider: 'mongodb', collection, filter };
  const projection = optionalObject(op.projection, 'A projection');
  const sort = optionalObject(op.sort, 'A sort');
  let limit = WIDGET_FIND_LIMIT;
  if (op.limit !== undefined && op.limit !== null) {
    if (!Number.isSafeInteger(op.limit) || op.limit < 1) throw widgetProblem('refused', 'A find\'s limit is a whole number of at least 1.');
    limit = Math.min(op.limit, WIDGET_MAX_ROWS);
  }
  let skip = 0;
  if (op.skip !== undefined && op.skip !== null) {
    if (!Number.isSafeInteger(op.skip) || op.skip < 0) throw widgetProblem('refused', 'A find\'s skip is a whole number of 0 or more.');
    skip = op.skip;
  }
  return { kind, provider: 'mongodb', collection, filter, projection, sort, limit, skip };
}

/**
 * A widget's batch, checked before any connection is looked up: plain JSON (a round
 * trip, so nothing but JSON reaches a driver), at most 256 KB and WIDGET_MAX_OPS long.
 */
function planBatch(raw) {
  let text;
  try { text = JSON.stringify(raw); } catch (_) { text = undefined; }
  if (text === undefined) throw widgetProblem('refused', 'The query could not be read as JSON.');
  if (Buffer.byteLength(text, 'utf8') > WIDGET_MAX_INPUT_BYTES) throw widgetProblem('refused', 'The query is larger than 256 KB.');
  const ops = JSON.parse(text);
  if (!Array.isArray(ops) || !ops.length) throw widgetProblem('refused', 'Send at least one operation.');
  if (ops.length > WIDGET_MAX_OPS) throw widgetProblem('refused', `A batch may hold at most ${WIDGET_MAX_OPS} operations.`);
  return ops.map((op, i) => {
    try { return planOp(op); } catch (err) {
      if (ops.length > 1 && err.widgetCode) { err.databaseMessage = `Operation ${i + 1}: ${err.databaseMessage}`; err.message = err.databaseMessage; }
      throw err;
    }
  });
}

/**
 * MongoDB Extended JSON (relaxed) to driver values: {"$oid"} an ObjectId, {"$date"} a Date.
 * A {"$numberLong"} becomes a BigInt, which the driver writes back as a 64-bit integer:
 * relaxed mode alone would round one past 2^53 to the nearest double and match the wrong row.
 */
function fromExtendedJson(value, what) {
  if (value === undefined) return undefined;
  const { EJSON } = require('mongodb').BSON;
  try { return EJSON.deserialize(value, { relaxed: true, useBigInt64: true }); } catch (err) {
    throw widgetProblem('refused', `${what} isn't valid Extended JSON (${String((err && err.message) || 'unreadable').replace(/\s+/g, ' ').slice(0, 160)}).`);
  }
}

/** A server error's own message, on one line, with anything like an address taken out. */
function serverSentence(message) {
  let text = String(message || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address]');
  if (!text) return 'The database returned an error.';
  if (text.length > 300) text = text.slice(0, 299) + '…';
  return `The database returned an error: ${text}${/[.!?…]$/.test(text) ? '' : '.'}`;
}

/** A widget query's failure: { ok: false, code, error } — the code from the contract. */
function widgetFailure(err) {
  if (err && err.widgetCode) return { ok: false, code: err.widgetCode, error: err.databaseMessage || errorMessage(err) };
  if (err && err.databaseMessage) return { ok: false, code: 'database', error: err.databaseMessage };
  const code = err && err.code;
  // A PostgreSQL server error: a five-character SQLSTATE and a severity.
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && err.severity) {
    if (code === '57014') return { ok: false, code: 'timeout', error: 'The query ran too long and the database stopped it.' };
    if (code === '25006') return { ok: false, code: 'refused', error: 'That statement would change data, and widgets may only read.' };
    if (/multiple commands/i.test(String(err.message))) return { ok: false, code: 'refused', error: 'Send one statement per sql operation; a second statement after a semicolon is refused.' };
    if (code.startsWith('28') || code.startsWith('08')) return { ok: false, code: 'database', error: errorMessage(err) };
    return { ok: false, code: 'database', error: serverSentence(err.message) };
  }
  // A MongoDB server error (never a network one, whose message may name the host).
  if (typeof code === 'number' && err && (err.name === 'MongoServerError' || err.errorResponse)) {
    if (code === 50) return { ok: false, code: 'timeout', error: 'The query ran too long and the database stopped it.' };
    if (code === 18) return { ok: false, code: 'database', error: errorMessage(err) };
    return { ok: false, code: 'database', error: serverSentence(err.message) };
  }
  return { ok: false, code: 'database', error: errorMessage(err) };
}

/**
 * The NAMES of the connections saved for workspace `wsId` under `directory`, read from
 * its metadata file and never decrypting anything — for a widget's state and the widget
 * CLI, which only say whether a connection of a name is there. [] when none can be read.
 */
function connectionNames(directory, wsId) {
  if (typeof wsId !== 'string' || !wsId) return [];
  try {
    const file = workspaceFile(path.resolve(directory), wsId);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.version !== 1 || !Array.isArray(data.connections)) return [];
    return data.connections.filter(c => c && typeof c.name === 'string').map(c => c.name);
  } catch (_) {
    return [];
  }
}

/**
 * Ask the server to stop whatever `client` is running: a CancelRequest carrying its process
 * ID and secret key, on a connection of its own, as psql's Ctrl-C sends. Closing a
 * client's socket does not stop a busy backend (it notices only when it next writes), so
 * a statement past its time limit would otherwise run on, holding a connection and a
 * snapshot. Best effort: settles within CANCEL_TIMEOUT_MS whatever happens, never throws.
 */
function cancelStatement(Client, uri, client) {
  if (!client || !client.processID || client.secretKey === null || client.secretKey === undefined) return Promise.resolve();
  return new Promise(resolve => {
    let con = null;
    let timer = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (con && con.stream) con.stream.destroy(); } catch (_) {}
      resolve();
    };
    try {
      const canceller = new Client({ connectionString: uri, connectionTimeoutMillis: CANCEL_TIMEOUT_MS });
      con = canceller.connection;
      timer = setTimeout(done, CANCEL_TIMEOUT_MS);
      con.on('error', done);
      con.once('end', done);
      // The server reads the request, acts on it and closes the connection ('end').
      con.once('connect', () => { try { con.cancel(client.processID, client.secretKey); } catch (_) { done(); } });
      if (canceller.host && canceller.host.indexOf('/') === 0) con.connect(`${canceller.host}/.s.PGSQL.${canceller.port}`);
      else con.connect(canceller.port, canceller.host);
    } catch (_) { done(); }
  });
}

/**
 * The bytes a PostgreSQL client receives while a widget's batch runs, counted as they
 * arrive. The driver buffers a whole row before parsing it, so one row too wide for memory
 * (a value hundreds of MB long) never reaches the per-row byte cap: past `cap` bytes the
 * socket is closed and `over` is set. A client without a socket (a test double) is not watched.
 */
function wireGuard(client, cap) {
  const guard = { over: false, release() {} };
  const stream = client && client.connection && client.connection.stream;
  if (!stream || typeof stream.on !== 'function') return guard;
  let seen = 0;
  const count = chunk => {
    seen += chunk.length;
    if (seen <= cap || guard.over) return;
    guard.over = true;
    try { stream.destroy(); } catch (_) {}
  };
  stream.on('data', count);
  guard.release = () => stream.removeListener('data', count);
  return guard;
}

function createDatabases({ directory, resolveWorkspace, safeStorage, drivers = {}, limits = {} }) {
  const dir = path.resolve(directory);
  const bounds = { records: limits.records || MAX_RECORDS, bytes: limits.bytes || MAX_BYTES, timeout: limits.timeout || TIMEOUT_MS };
  const widgetBounds = { rows: limits.widgetRows || WIDGET_MAX_ROWS, bytes: limits.widgetBytes || WIDGET_MAX_BYTES, timeout: limits.widgetTimeout || WIDGET_TIMEOUT_MS };
  const writes = new Map();
  const active = new Set();
  const pending = new Set();
  // Widget batches waiting for one of the MAX_ACTIVE slots, first come first served.
  const waiters = [];
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

  // A widget's batch waits for a slot rather than failing — a board may hold several
  // widgets that all load at once. turn() is one wait in line (at the front again after a
  // wake that found the slot taken); it resolves when a slot frees or `left` ms pass.
  function turn(left, retry) {
    return new Promise(resolve => {
      const waiter = { wake: null };
      const timer = setTimeout(() => waiter.wake(), left);
      waiter.wake = () => {
        clearTimeout(timer);
        const at = waiters.indexOf(waiter);
        if (at !== -1) waiters.splice(at, 1);
        resolve();
      };
      if (retry) waiters.unshift(waiter); else waiters.push(waiter);
    });
  }

  // A dedicated client for each operation keeps transactions isolated, avoids
  // persistent idle connections, and makes shutdown/timeout cleanup explicit. The
  // Databases browser is refused when every slot is busy; a widget (options.wait) waits.
  async function connected(connection, task, options = {}) {
    if (closed) throw problem('Database connections are shutting down.');
    const timeout = options.timeout || bounds.timeout;
    const appName = options.appName || 'Switchboard database browser';
    if (active.size >= MAX_ACTIVE) {
      if (!options.wait) throw problem('Four database requests are already running. Wait for one to finish and try again.');
      // Checked again after every wait, with nothing awaited between the check and
      // taking the slot below, so the cap holds.
      const until = Date.now() + timeout;
      for (let retry = false; active.size >= MAX_ACTIVE; retry = true) {
        if (closed) throw problem('Database connections are shutting down.');
        const left = until - Date.now();
        if (left <= 0) throw widgetProblem('timeout', `Four database requests were already running and none finished within ${Math.round(timeout / 1000)} seconds.`);
        await turn(left, retry);
      }
      if (closed) throw problem('Database connections are shutting down.');
    }
    let stopping = null;
    let dispose = async () => {};
    // True while the task may have a statement running on the server.
    let busy = false;
    const stop = () => { if (!stopping) stopping = Promise.resolve().then(() => dispose()).catch(() => {}); return stopping; };
    let finished;
    const resource = { connectionId: connection.id, client: null, stop, done: new Promise(resolve => { finished = resolve; }) };
    active.add(resource);
    let timer;
    try {
      const operation = (async () => {
        if (connection.provider === 'postgres') {
          const Client = drivers.Client || require('pg').Client;
          const cancel = drivers.cancel || cancelStatement;
          const client = resource.client = new Client({ connectionString: connection.uri, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, query_timeout: timeout, statement_timeout: timeout, lock_timeout: 5000, idle_in_transaction_session_timeout: timeout, application_name: appName });
          if (client.on) client.on('error', () => {});
          // Stopped mid-task (its time limit, the connection's removal, quitting): cancel
          // on the server too, since ending the client alone leaves a busy backend running
          // — and a widget's SELECT can switch off statement_timeout with set_config.
          dispose = () => Promise.all([
            busy ? cancel(Client, connection.uri, client) : null,
            Promise.resolve().then(() => client.end()),
          ]);
          busy = true;
          try {
            await client.connect();
            await client.query('BEGIN READ ONLY');
            await client.query(`SET LOCAL statement_timeout = ${Math.round(timeout)}`);
            await client.query('SET LOCAL lock_timeout = 5000');
            return await task(client);
          } finally { busy = false; }
        }
        const MongoClient = drivers.MongoClient || require('mongodb').MongoClient;
        const client = resource.client = new MongoClient(connection.uri, { serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS, connectTimeoutMS: CONNECT_TIMEOUT_MS, socketTimeoutMS: timeout, maxPoolSize: 1, minPoolSize: 0, appName });
        dispose = () => client.close();
        await client.connect();
        return task(client.db(connection.database));
      })();
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
          stop();
          const err = problem(options.timeoutMessage || 'The database request timed out. Try again or select a smaller entity.');
          err.widgetCode = 'timeout';
          reject(err);
        }, timeout);
      });
      const result = await Promise.race([operation, expired]);
      if (closed) throw problem('The database request was stopped. Try again.');
      return result;
    } finally {
      clearTimeout(timer);
      await stop();
      active.delete(resource);
      finished();
      if (waiters.length) waiters[0].wake();
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
  /**
   * The saved connection named `name` in workspace `wsId`, unlocked — or a
   * 'needs-connection' throw: no workspace, none of that name, or more than one.
   */
  async function namedConnection(wsId, name) {
    if (closed) throw problem('Database connections are shutting down.');
    if (typeof name !== 'string' || !name) throw widgetProblem('needs-connection', 'This widget names no database connection.');
    if (typeof wsId !== 'string' || !wsId) throw widgetProblem('needs-connection', 'This board has no workspace, so there is no Databases tab to find a connection in.');
    let file;
    try { file = await workspace(wsId); } catch (err) {
      if (closed) throw err;
      throw widgetProblem('needs-connection', 'This board\'s workspace is no longer in the rail, so its connections can\'t be read.');
    }
    let saved;
    try { saved = await read(file); } catch (err) { throw widgetProblem('needs-connection', errorMessage(err)); }
    const matches = saved.filter(c => c.name === name);
    if (!matches.length) throw widgetProblem('needs-connection', `No connection named “${name}” is saved in this workspace's Databases tab.`);
    if (matches.length > 1) throw widgetProblem('needs-connection', `${matches.length} connections in this workspace are named “${name}”, so remove all but one in its Databases tab.`);
    try { return await getConnection(file, matches[0].id); } catch (err) {
      if (!err.widgetCode) err.widgetCode = 'needs-connection';
      throw err;
    }
  }

  // A batch, run in order on one client: rows normalized as the browser's are, at most
  // widgetBounds.rows from any one operation and widgetBounds.bytes in all.
  async function runBatch(client, provider, plan) {
    // Twice the result cap on the wire: a row's text there is no longer than its JSON,
    // bytea's hex aside (1.5 times its base64), so only a result already past the cap trips it.
    const wire = provider === 'postgres' ? wireGuard(client, widgetBounds.bytes * 2) : null;
    try { return await runOps(client, provider, plan, wire); } finally { if (wire) wire.release(); }
  }
  async function runOps(client, provider, plan, wire) {
    let bytes = 2;
    const cap = widgetBounds.bytes >= 1024 * 1024 ? `${Math.round(widgetBounds.bytes / 1024 / 1024)} MB` : `${Math.round(widgetBounds.bytes / 1024)} KB`;
    const passed = () => widgetProblem('too-large', `The results passed ${cap}; ask for fewer rows or fewer fields.`);
    const keep = value => {
      const plain = normalize(value);
      bytes += Buffer.byteLength(JSON.stringify(plain), 'utf8') + 1;
      if (bytes > widgetBounds.bytes) throw passed();
      return plain;
    };
    const tooMany = n => widgetProblem('too-large', `${n} returned more than ${widgetBounds.rows.toLocaleString('en-US')} rows; add a limit or a narrower filter.`);
    const results = [];
    for (let i = 0; i < plan.length; i++) {
      const op = plan[i];
      const which = plan.length > 1 ? `Operation ${i + 1}` : 'The query';
      if (provider === 'postgres') {
        // Through a cursor, BATCH_SIZE rows a read, so the row and byte caps hold as rows
        // arrive rather than after the whole result is in memory. pg-cursor always speaks
        // the extended protocol (Parse/Bind/Execute), so the server refuses a second
        // statement in the text.
        const Cursor = drivers.Cursor || require('pg-cursor');
        const cursor = client.query(new Cursor(op.sql, op.params));
        const rows = [];
        try {
          while (true) {
            const batch = await new Promise((resolve, reject) => cursor.read(BATCH_SIZE, (err, got) => err ? reject(err) : resolve(got)));
            if (!batch.length) break;
            for (const row of batch) {
              if (rows.length >= widgetBounds.rows) throw tooMany(which);
              rows.push(keep(row));
            }
          }
        } catch (err) {
          // The socket closed under it because the answer passed the cap on the wire.
          if (wire && wire.over) throw passed();
          throw err;
        } finally {
          // With the socket gone, a close would wait for a reply that never comes.
          if (!(wire && wire.over)) await new Promise(resolve => cursor.close(() => resolve())).catch(() => {});
        }
        results.push(rows);
        continue;
      }
      const collection = client.collection(op.collection);
      if (op.kind === 'count') {
        results.push(keep(await collection.countDocuments(op.filter, { maxTimeMS: widgetBounds.timeout })));
        continue;
      }
      let cursor;
      if (op.kind === 'find') {
        const options = { maxTimeMS: widgetBounds.timeout, batchSize: Math.min(op.limit, BATCH_SIZE), limit: op.limit, skip: op.skip };
        if (op.projection !== undefined) options.projection = op.projection;
        if (op.sort !== undefined) options.sort = op.sort;
        cursor = collection.find(op.filter, options);
      } else {
        cursor = collection.aggregate(op.pipeline, { maxTimeMS: widgetBounds.timeout, batchSize: BATCH_SIZE, allowDiskUse: false });
      }
      const rows = [];
      try {
        for await (const document of cursor) {
          if (rows.length >= widgetBounds.rows) throw tooMany(which);
          rows.push(keep(document));
        }
      } finally { await Promise.resolve().then(() => cursor.close()).catch(() => {}); }
      results.push(rows);
    }
    return results;
  }

  /**
   * A widget's batch (§4.17): `ops` run in order on one client of the connection named
   * `name` in workspace `wsId` — one read-only transaction for PostgreSQL. `{ ok, results }`
   * (one per op, in order) or `{ ok:false, code, error }`, `code` one of 'needs-connection',
   * 'refused', 'too-large', 'timeout', 'database'; the error is a sentence that never holds
   * the URI or its credentials. Waits for a free slot rather than failing.
   */
  async function query(wsId, name, ops) {
    try {
      const plan = planBatch(ops);
      const connection = await namedConnection(wsId, name);
      const provider = connection.provider;
      if (plan.some(op => op.provider !== provider)) {
        throw widgetProblem('refused', provider === 'postgres'
          ? `“${name}” is a PostgreSQL connection, so use sql rather than find, aggregate or count.`
          : `“${name}” is a MongoDB connection, so use find, aggregate or count rather than sql.`);
      }
      if (provider === 'mongodb') {
        for (const op of plan) {
          op.filter = fromExtendedJson(op.filter, 'The filter');
          op.projection = fromExtendedJson(op.projection, 'The projection');
          op.sort = fromExtendedJson(op.sort, 'The sort');
          op.pipeline = fromExtendedJson(op.pipeline, 'The pipeline');
        }
      }
      const seconds = Math.round(widgetBounds.timeout / 1000);
      const results = await connected(connection, client => runBatch(client, provider, plan), {
        wait: true,
        timeout: widgetBounds.timeout,
        appName: WIDGET_APP_NAME,
        timeoutMessage: `The query took longer than ${seconds} seconds and was stopped.`,
      });
      return { ok: true, results };
    } catch (err) {
      return widgetFailure(err);
    }
  }
  function close() {
    if (closing) return closing;
    closed = true;
    // Widget batches waiting for a slot give up now (connected() sees `closed`).
    for (const waiter of waiters.slice()) waiter.wake();
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
  function expose(operation, fail = failure) {
    return (...args) => {
      if (closed) return Promise.resolve(fail('Database connections are shutting down.'));
      const request = Promise.resolve().then(() => operation(...args)).catch(err => fail(errorMessage(err)));
      pending.add(request);
      request.then(() => pending.delete(request));
      return request;
    };
  }
  const widgetFail = error => ({ ok: false, code: 'database', error });
  return { list: expose(list), add: expose(add), remove: expose(remove), entities: expose(entities), records: expose(records), query: expose(query, widgetFail), close };
}

module.exports = {
  createDatabases,
  connectionNames,
  cancelStatement,
  sqlLead,
  MAX_RECORDS,
  MAX_BYTES,
  WIDGET_MAX_OPS,
  WIDGET_FIND_LIMIT,
  WIDGET_MAX_ROWS,
  WIDGET_MAX_BYTES,
  WIDGET_TIMEOUT_MS,
};
