'use strict';

// npm run test:diagrams — ✦ Answer's settings and requests (src/main/answer.js, M11) and
// the prompt and answer reading the Diagrams bundle shares with it
// (src/diagrams/lib/diagrams/ai.ts, answer.ts). Nothing is asked of a real CLI or API:
// these are the arguments and bodies each provider would be sent, the reading of what
// comes back, and the Claude API's conversation against canned replies.
//
// answer.js requires Electron for net and safeStorage, so `electron` is stubbed: net.fetch
// answers from `replies`, the keychain from a stand-in. SWITCHBOARD_CONFIG is set BEFORE
// anything is required, as test-diagrams.js does, so settings and keys land in a temp
// directory. PATH is emptied so the look for the CLIs that setSettings answers with
// finds neither, at once.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test, after } = require('node:test');
const esbuild = require('esbuild');

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-answer-test-')));
const previousConfig = process.env.SWITCHBOARD_CONFIG;
const previousPath = process.env.PATH;
process.env.SWITCHBOARD_CONFIG = path.join(temp, 'config.json');
process.env.PATH = '';

// net.fetch answers with whatever the test in hand puts in `replies`, and records what
// it was sent; the keychain hands back a stand-in key.
const sent = [];
let replies = [];
const net = {
  fetch: async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    const [status, body] = replies.shift();
    return new Response(JSON.stringify(body), { status });
  },
};
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(s),
  decryptString: () => 'sk-ant-test',
};
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { net, safeStorage };
  return load.call(this, request, ...rest);
};
const answer = require('../src/main/answer');
Module._load = load;

// The bundle's two pure modules, as test-flow-layout.js loads flow-editor.ts.
const outfile = path.join(temp, 'answer-prompt.js');
esbuild.buildSync({
  stdin: {
    contents: "export * from './ai'; export * from './answer'",
    resolveDir: path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams'),
    loader: 'ts',
  },
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'error',
});
const { answerPrompt, parseFlowAiAnswer, FLOW_ANSWER_SCHEMA } = require(outfile);

after(() => {
  if (previousConfig === undefined) delete process.env.SWITCHBOARD_CONFIG;
  else process.env.SWITCHBOARD_CONFIG = previousConfig;
  process.env.PATH = previousPath;
  fs.rmSync(temp, { recursive: true, force: true });
});

const QUESTION = { question: 'What are all of the repos we have?', context: [], existing: [], split: 'auto' };
const REQ = { system: 'SYSTEM', user: 'USER', schema: FLOW_ANSWER_SCHEMA };

function parts(n, detail) {
  return JSON.stringify({ parts: Array.from({ length: n }, (_, i) => ({ label: `Repo ${i + 1}`, detail: detail || '' })) });
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

test('Web access is on and Subtext off until changed, and both are kept', async () => {
  const before = answer.settings();
  assert.equal(before.web, true);
  assert.equal(before.subtext, false);
  await answer.setSettings({ web: false, subtext: true });
  const after = answer.settings();
  assert.equal(after.web, false);
  assert.equal(after.subtext, true);
  const saved = JSON.parse(fs.readFileSync(process.env.SWITCHBOARD_CONFIG, 'utf8')).answer;
  assert.equal(saved.web, false);
  assert.equal(saved.subtext, true);
  await answer.setSettings({ web: 'yes', subtext: 0 });
  assert.equal(answer.settings().web, true);
  assert.equal(answer.settings().subtext, false);
});

// ---------------------------------------------------------------------------
// how many boxes, and their subtext
// ---------------------------------------------------------------------------

test('an answer is not capped at four boxes: six repos are six boxes', () => {
  const { system, user } = answerPrompt(QUESTION, 'api');
  assert.doesNotMatch(system, /at most 4/);
  assert.match(system, /a list of six things is six parts/);
  assert.match(user, /as many parts as the answer has/);
  assert.equal(parseFlowAiAnswer(parts(6), 'auto').length, 6);
  assert.equal(parseFlowAiAnswer(parts(7), 'auto').length, 7);
  assert.equal(parseFlowAiAnswer(parts(7), 'one').length, 1);
});

test('without Subtext the boxes have no second line, whatever the model wrote', () => {
  const off = answerPrompt({ ...QUESTION, subtext: false }, 'cli').system;
  assert.match(off, /"detail": always ""/);
  assert.doesNotMatch(off, /use its "detail" to say where/);
  const on = answerPrompt({ ...QUESTION, subtext: true }, 'cli').system;
  assert.match(on, /one short supporting line/);
  assert.match(on, /use its "detail" to say where/);
  assert.deepEqual(parseFlowAiAnswer(parts(2, 'README.md'), 'auto', false).map(p => p.detail), [undefined, undefined]);
  assert.deepEqual(parseFlowAiAnswer(parts(2, 'README.md'), 'auto', true).map(p => p.detail), ['README.md', 'README.md']);
});

test('links a model left in a box are taken out, keeping a link\'s words', () => {
  const text = JSON.stringify({ parts: [
    { label: 'Electron 44 is current ([releases.electronjs.org](https://releases.electronjs.org/))', detail: '' },
    { label: 'See [the release notes](https://example.com/notes)', detail: '' },
    { label: 'Rust ([en.wikipedia.org](https://en.wikipedia.org/wiki/Rust_(programming_language)?utm_source=openai))', detail: '' },
    { label: 'See [Rust](https://en.wikipedia.org/wiki/Rust_(programming_language))', detail: '' },
    { label: 'arr[0] (first) and [draft] (later)', detail: '' },
  ] });
  assert.deepEqual(parseFlowAiAnswer(text, 'auto').map(p => p.label), [
    'Electron 44 is current', 'See the release notes', 'Rust', 'See Rust', 'arr[0] (first) and [draft] (later)',
  ]);
});

// ---------------------------------------------------------------------------
// web access, provider by provider
// ---------------------------------------------------------------------------

test('what it is told about the web matches what it was given', () => {
  assert.match(answer.webPrompt(true, 'claude-code'), /the diagram and the code/);
  assert.match(answer.webPrompt(true, 'openai-api'), /only when the question needs something the diagram can't/);
  assert.match(answer.webPrompt(false, 'claude-api'), /can't open web pages or search the web/);
});

test('Claude Code sees its web tools only with Web access on', () => {
  const s = { claudeCodeEffort: 'own' };
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  const on = answer.claudeCodeArgs(REQ, s, true);
  assert.equal(value(on, '--tools'), 'Read,Grep,Glob,WebFetch,WebSearch');
  assert.equal(value(on, '--allowedTools'), 'Read,Grep,Glob,WebFetch,WebSearch');
  const off = answer.claudeCodeArgs(REQ, s, false);
  assert.equal(value(off, '--tools'), 'Read,Grep,Glob');
  assert.equal(value(off, '--allowedTools'), 'Read,Grep,Glob');
  assert.deepEqual(answer.claudeStep('/ws', { name: 'WebFetch', input: { url: 'https://www.example.com/docs/intro?x=1' } }),
    { kind: 'fetch', text: 'Opening', target: 'example.com/docs/intro' });
  assert.deepEqual(answer.claudeStep('/ws', { name: 'WebSearch', input: { query: 'electron stable' } }),
    { kind: 'web', text: 'Searching the web for', target: 'electron stable' });
});

test('Codex says live or disabled outright, since its own default is a cached search', () => {
  const on = answer.codexArgs(REQ, true, '/ws', 's.json', 'o.json');
  const off = answer.codexArgs(REQ, false, '/ws', 's.json', 'o.json');
  assert.equal(on[on.indexOf('-c') + 1], 'web_search="live"');
  assert.equal(off[off.indexOf('-c') + 1], 'web_search="disabled"');
  assert.equal(on[on.indexOf('--sandbox') + 1], 'read-only');
  assert.deepEqual(answer.webStep({ type: 'search', query: 'rust async' }, ''), { kind: 'web', text: 'Searched the web for', target: 'rust async' });
  assert.deepEqual(answer.webStep({ type: 'open_page', url: 'https://github.com/openai/codex' }, ''), { kind: 'fetch', text: 'Opened', target: 'github.com/openai/codex' });
  assert.equal(answer.webStep({ type: 'other' }, ''), null);
});

test('the Claude API is asked for the schema\'s JSON, never a forced tool call', () => {
  const s = { claudeApiModel: 'claude-sonnet-5-5' };
  const off = answer.claudeApiBody(REQ, s, false);
  assert.equal(off.tool_choice, undefined);
  assert.equal(off.tools, undefined);
  assert.deepEqual(off.output_config, { format: { type: 'json_schema', schema: FLOW_ANSWER_SCHEMA } });
  const on = answer.claudeApiBody(REQ, s, true);
  assert.equal(on.tool_choice, undefined);
  assert.deepEqual(on.tools.map(t => t.type), ['web_search_20250305', 'web_fetch_20250910']);
});

test('the Claude API\'s answer is the text after its last web block, joined', () => {
  const json = parts(2);
  assert.equal(answer.claudeAnswerText([{ type: 'text', text: json }]), json);
  assert.equal(answer.claudeAnswerText([
    { type: 'text', text: "I'll look that up." },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_fetch', input: { url: 'https://example.com' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: {} },
    { type: 'text', text: json.slice(0, 10) },
    { type: 'text', text: json.slice(10), citations: [] },
  ]), json);
});

test('OpenAI gets web search only with Web access on', () => {
  const s = { openaiModel: 'gpt-5.6-terra', openaiEffort: 'medium' };
  assert.equal(answer.openAiBody(REQ, s, false).tools, undefined);
  const on = answer.openAiBody(REQ, s, true);
  assert.deepEqual(on.tools, [{ type: 'web_search', search_context_size: 'low' }]);
  assert.equal(on.text.format.type, 'json_schema');
});

test('OpenAI\'s answer is its final message, not a word said before searching', async () => {
  const json = parts(3);
  const events = [
    { type: 'response.output_item.added', item: { id: 'msg_a', type: 'message', phase: 'commentary' } },
    { type: 'response.output_text.delta', item_id: 'msg_a', delta: 'Let me check.' },
    { type: 'response.output_item.added', item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' } },
    { type: 'response.output_item.done', item: { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://example.com/a' } } },
    { type: 'response.output_item.added', item: { id: 'msg_b', type: 'message', phase: 'final_answer' } },
    { type: 'response.output_text.delta', item_id: 'msg_b', delta: json.slice(0, 7) },
    { type: 'response.output_text.delta', item_id: 'msg_b', delta: json.slice(7) },
  ];
  const sse = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } });
  const steps = [];
  assert.equal(await answer.readOpenAiStream(body, st => steps.push(st)), json);
  assert.deepEqual(steps, [{ kind: 'fetch', text: 'Opened', target: 'example.com/a' }]);
});

test('an OpenAI answer cut short after only a word of commentary says it stopped early', async () => {
  const events = [
    { type: 'response.output_item.added', item: { id: 'msg_a', type: 'message', phase: 'commentary' } },
    { type: 'response.output_text.delta', item_id: 'msg_a', delta: 'Let me check.' },
    { type: 'response.output_item.added', item: { id: 'msg_b', type: 'message', phase: 'final_answer' } },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
  ];
  const sse = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } });
  await assert.rejects(answer.readOpenAiStream(body), /stopped early \(max_output_tokens\)/);
});

test('should the Claude API refuse web search\'s citations, it answers again with web fetch alone', async () => {
  fs.writeFileSync(answer.keysFile(), JSON.stringify({ version: 1, keys: { 'claude-api': { enc: 'eA==', last4: 'test' } } }));
  await answer.setSettings({ web: true });
  const json = parts(2);
  sent.length = 0;
  replies = [
    [400, { type: 'error', error: { type: 'invalid_request_error', message: 'citations are not supported with output_config.format' } }],
    [200, { content: [{ type: 'text', text: json }], stop_reason: 'end_turn' }],
  ];
  const res = await answer.start('t-cite', { provider: 'claude-api', system: 'S', user: 'U', schema: FLOW_ANSWER_SCHEMA });
  assert.deepEqual(res, { ok: true, text: json });
  assert.deepEqual(sent.map(r => (r.body.tools || []).map(t => t.name)), [['web_search', 'web_fetch'], ['web_fetch']]);
  assert.match(sent[0].body.system, /You can also open a web page or search the web/);
});

test('a paused Claude API turn is sent back as it is, and the answer read from where it ends', async () => {
  const json = parts(3);
  sent.length = 0;
  const paused = [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_fetch', input: { url: 'https://example.com' } },
  ];
  replies = [
    [200, { content: paused, stop_reason: 'pause_turn' }],
    [200, { content: [{ type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: {} }, { type: 'text', text: json }], stop_reason: 'end_turn' }],
  ];
  const res = await answer.start('t-pause', { provider: 'claude-api', system: 'S', user: 'U', schema: FLOW_ANSWER_SCHEMA });
  assert.deepEqual(res, { ok: true, text: json });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].body.messages, [{ role: 'user', content: 'U' }, { role: 'assistant', content: paused }]);
});
