'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

let temp, configFile, config, workspaces, previousConfig;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-config-test-'));
  configFile = path.join(temp, 'config.json');
  previousConfig = process.env.SWITCHBOARD_CONFIG;
  process.env.SWITCHBOARD_CONFIG = configFile;
  for (const file of ['../src/main/config', '../src/main/workspaces']) {
    delete require.cache[require.resolve(file)];
  }
  config = require('../src/main/config');
  workspaces = require('../src/main/workspaces');
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.SWITCHBOARD_CONFIG;
  else process.env.SWITCHBOARD_CONFIG = previousConfig;
  fs.rmSync(temp, { recursive: true, force: true });
});

function writeConfig(value) {
  fs.writeFileSync(configFile, JSON.stringify(value));
}

function repo(dir) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

test('fresh installs ship and create an empty config without scanning a directory', async () => {
  assert.deepEqual(require('../src/main/default-config.json'), {});
  const readdir = fs.readdirSync;
  let scans = 0;
  fs.readdirSync = (...args) => { scans++; return readdir(...args); };
  try {
    assert.deepEqual(await workspaces.discover(), []);
    assert.equal(scans, 0);
  } finally {
    fs.readdirSync = readdir;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), {});
  assert.equal(config.get().root, null);
  assert.equal(await workspaces.dirOf('unconfigured-project'), null);
});

test('explicit absolute workspaces and folder terminals work without a root', async () => {
  const folder = repo(path.join(temp, 'actual-folder'));
  writeConfig({ workspaces: { 'demo-app': { dir: folder, devCommand: null } } });
  const found = await workspaces.discover();
  assert.deepEqual(found.map(w => w.id), ['demo-app']);
  assert.equal(found[0].dir, folder);
  assert.equal(await workspaces.dirOf('demo-app'), folder);
  assert.equal(await workspaces.dirOf(folder), folder);
});

test('relative declarations without a root do not resolve against the source checkout', async () => {
  writeConfig({ workspaces: { 'demo-app': { dir: '.' } } });
  assert.deepEqual(await workspaces.discover(), []);
});

test('a configured root discovers multi-repo folders and resolves single-repo aliases', async () => {
  repo(path.join(temp, 'demo-2', 'demo-api-2'));
  repo(path.join(temp, 'demo-2', 'demo-web-2'));
  repo(path.join(temp, 'excluded', 'api'));
  repo(path.join(temp, 'excluded', 'web'));
  const single = repo(path.join(temp, 'single-repo'));
  writeConfig({ root: temp, exclude: ['excluded'], workspaces: { single: { dir: 'single-repo' } } });
  const found = await workspaces.discover();
  assert.deepEqual(found.map(w => w.id).sort(), ['demo-2', 'single']);
  assert.equal(found.find(w => w.id === 'demo-2').project, 'demo');
  assert.equal(await workspaces.dirOf('single'), single);
  assert.equal(workspaces.displayName('demo-api-2', 'demo-2'), 'demo-api');
});

test('preferences preserve existing user configuration without adding workspace presets', () => {
  const original = { root: temp, workspaces: { demo: { dir: 'demo', devCommand: 'pnpm dev' } }, terminal: { appearance: 'dark' } };
  writeConfig(original);
  config.load();
  config.save({ sidebar: { visible: false } });
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { ...original, sidebar: { visible: false } });
  writeConfig({});
  config.load();
  config.save({ grid: { views: [] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { grid: { views: [] } });
});

test('invalid config is preserved and yields no workspaces', async () => {
  fs.writeFileSync(configFile, '{broken');
  const error = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await workspaces.discover(), []);
    assert.match(config.get().configError, /not valid JSON/);
    assert.equal(fs.readFileSync(configFile, 'utf8'), '{broken');
  } finally {
    console.error = error;
  }
});

test('tilde expansion and the legacy root alias remain compatible', () => {
  writeConfig({ appsRoot: '~/Projects' });
  assert.equal(config.load().root, path.join(os.homedir(), 'Projects'));
  writeConfig({ appsRoot: '~/Projects', root: temp });
  assert.equal(config.load().root, temp);
  writeConfig({ root: null, appsRoot: '~/Projects' });
  assert.equal(config.load().root, path.join(os.homedir(), 'Projects'));
});
