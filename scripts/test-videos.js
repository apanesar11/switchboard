'use strict';

// npm run test:diagrams — src/main/videos.js, a whiteboard video's main-process half
// (§4.17): the Referer the player's page goes out with, which popups and navigations
// from the player get anywhere, what the default session grants a page from the web, and
// videoInfo, the title asked of YouTube. Plain node, no Electron: the module requires it
// only for net.fetch, which every test here hands a stand-in, and the session and frames
// are stand-ins too. What they stand in for was measured in Electron 44.4.2 (videos.js
// says what). youtube.ts, the bundle's half, is bundled with esbuild, as
// test-youtube.js bundles it, so the two are checked against each other.
//
// Every video id and title here is made up (AGENTS.md).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, after } = require('node:test');
const esbuild = require('esbuild');

const videos = require('../src/main/videos');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-videos-'));
const outfile = path.join(temp, 'youtube.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', 'youtube.ts')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'error',
});
const { isYouTubeVideoId, youTubeEmbedUrl, youTubeWatchUrl } = require(outfile);
const localOutfile = path.join(temp, 'local-videos.js');
esbuild.buildSync({
  stdin: {
    contents: 'export { parseDiagramSpec } from "./validate"; export { layoutDiagram } from "./layout"; export { flowSpecFromCanvas } from "./flow-editor"; export { parseLocalVideoSrc } from "./local-video";',
    resolveDir: path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams'),
  },
  outfile: localOutfile, bundle: true, format: 'cjs', platform: 'node', logLevel: 'error',
});
const { parseDiagramSpec, layoutDiagram, flowSpecFromCanvas, parseLocalVideoSrc } = require(localOutfile);
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const A = 'exampleVid1';
const B = 'exampleVid2';
const PLAYER = 'https://www.youtube-nocookie.com/embed/' + A + '?autoplay=1&rel=0&playsinline=1';
const APP_PAGE = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href;
const LOCAL_NAME = 'Recording-2026-01-02T03-04-05-006Z-01234567-89ab-cdef-0123-456789abcdef.webm';
const LOCAL_SRC = 'sbvideo://recording/' + LOCAL_NAME;

test('a local recording uses only a generated filename, never a path or arbitrary URL', () => {
  assert.equal(parseLocalVideoSrc(LOCAL_SRC), LOCAL_NAME);
  assert.equal(parseLocalVideoSrc(LOCAL_SRC.replace('.webm', '.mp4')), LOCAL_NAME.replace('.webm', '.mp4'));
  for (const value of [undefined, null, '', 'file:///Users/example/recording.webm', 'https://example.com/recording.webm',
    LOCAL_SRC + '\n', LOCAL_SRC + '#t=1', LOCAL_SRC + '?download', LOCAL_SRC.replace('.webm', '.partial.webm'),
    LOCAL_SRC.replace('recording/', 'recording/../'), LOCAL_SRC.replace('Recording-', '%52ecording-')]) {
    assert.equal(parseLocalVideoSrc(value), null, String(value));
  }
});

test('local recording cards keep their source and size through layout and canvas serialization', () => {
  const parsed = parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'recording', shape: 'video', videoSrc: LOCAL_SRC,
    position: { x: 120, y: 140 }, size: { width: 640, height: 390 } }], edges: [] });
  assert.equal(parsed.ok, true, parsed.error);
  const layout = layoutDiagram(parsed.value);
  assert.equal(layout.nodes[0].data.videoSrc, LOCAL_SRC);
  assert.equal(layout.nodes[0].width, 640);
  const saved = flowSpecFromCanvas({}, layout.nodes, layout.edges);
  assert.equal(saved.nodes[0].videoSrc, LOCAL_SRC);
  assert.equal(saved.nodes[0].videoId, undefined);
  assert.equal(saved.nodes[0].label, 'Camera recording');
  assert.deepEqual(saved.nodes[0].size, { width: 640, height: 390 });
  assert.equal(parseDiagramSpec(JSON.parse(JSON.stringify(saved))).ok, true);
});

test('a video names either YouTube or a saved local recording', () => {
  const parse = node => parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'video', shape: 'video', ...node }], edges: [] });
  assert.equal(parse({ videoId: A }).ok, true);
  for (const node of [{ videoSrc: 'file:///Users/example/recording.webm' }, { videoSrc: LOCAL_SRC, videoId: A }, {}]) {
    assert.equal(parse(node).ok, false, JSON.stringify(node));
  }
  const box = parseDiagramSpec({ kind: 'flow', nodes: [{ id: 'box', label: 'Example', videoSrc: LOCAL_SRC }], edges: [] });
  assert.equal(box.ok, true);
  assert.equal(box.value.nodes[0].videoSrc, undefined);
});

// ---------------------------------------------------------------------------
// the id, and the player's address
// ---------------------------------------------------------------------------

test("main's video id is the bundle's, case and all", () => {
  for (const value of [
    A, B, 'exampleShrt', 'EXAMPLEVID1', 'a-b_c-d_e-f', '___________', '-----------',
    'videoseries', 'live_stream', 'Videoseries',
    'exampleVid', 'exampleVid12', 'example Vid', 'example+Vid', 'example/Vid', 'exampleVïd',
    'https://youtu.be/' + A, '', ' ' + A,
  ]) assert.equal(videos.isVideoId(value), isYouTubeVideoId(value), value);
  for (const value of [undefined, null, 11, ['exampleVid1'], { toString: () => A }]) {
    assert.equal(videos.isVideoId(value), false, String(value));
  }
});

test("every player the bundle builds is a player's address, and nothing else is", () => {
  assert.equal(videos.isPlayerUrl(youTubeEmbedUrl({ videoId: A })), true);
  assert.equal(videos.isPlayerUrl(youTubeEmbedUrl({ videoId: B, start: 65 })), true);
  assert.equal(videos.isPlayerUrl('https://www.youtube-nocookie.com/embed/' + A), true);
  for (const refused of [
    'http://www.youtube-nocookie.com/embed/' + A,             // not https
    'https://youtube-nocookie.com/embed/' + A,                // not the player's host
    'https://www.youtube.com/embed/' + A,                     // youtube.com's embed sets cookies
    'https://www.youtube-nocookie.com/watch?v=' + A,          // not under /embed/
    'https://www.youtube-nocookie.com/embedded/' + A,
    'https://www.youtube-nocookie.com/',
    'https://www.youtube-nocookie.com:8443/embed/' + A,
    'https://user@www.youtube-nocookie.com/embed/' + A,
    'https://www.youtube-nocookie.com.evil.test/embed/' + A,
    'https://evil.test/embed/' + A + '#www.youtube-nocookie.com',
    youTubeWatchUrl({ videoId: A }),
    'about:blank',
    '',
    undefined,
  ]) assert.equal(videos.isPlayerUrl(refused), false, String(refused));
});

// ---------------------------------------------------------------------------
// the Referer
// ---------------------------------------------------------------------------

test("the player's own page goes out naming the app, every other header as it was", () => {
  assert.equal(videos.APP_REFERER, 'https://local.switchboard.app/');
  assert.deepEqual(videos.EMBED_URLS, ['https://www.youtube-nocookie.com/embed/*']);
  const requestHeaders = { Accept: 'text/html', 'User-Agent': 'Chrome/152', 'Sec-Fetch-Dest': 'iframe' };
  const sent = videos.embedRequestHeaders({ url: PLAYER, resourceType: 'subFrame', requestHeaders });
  assert.deepEqual(sent, { Accept: 'text/html', 'User-Agent': 'Chrome/152', 'Sec-Fetch-Dest': 'iframe', Referer: 'https://local.switchboard.app/' });
  assert.deepEqual(requestHeaders, { Accept: 'text/html', 'User-Agent': 'Chrome/152', 'Sec-Fetch-Dest': 'iframe' }, 'the request\'s own headers are not changed in place');
  // One Referer, whatever case one came in.
  const again = videos.embedRequestHeaders({ url: PLAYER, resourceType: 'subFrame', requestHeaders: { referer: 'file:///x', Accept: '*/*' } });
  assert.deepEqual(again, { Accept: '*/*', Referer: 'https://local.switchboard.app/' });
});

test('any other request matching the filter is handed back untouched', () => {
  for (const resourceType of ['xhr', 'script', 'image', 'media', 'other', 'mainFrame', undefined]) {
    const requestHeaders = { Accept: '*/*' };
    const sent = videos.embedRequestHeaders({ url: PLAYER, resourceType, requestHeaders });
    assert.equal(sent, requestHeaders, String(resourceType));
    assert.deepEqual(sent, { Accept: '*/*' });
  }
  // A frame that is not a player's address gets nothing, should a filter ever let one by.
  const requestHeaders = { Accept: '*/*' };
  assert.equal(videos.embedRequestHeaders({ url: 'https://www.youtube.com/embed/' + A, resourceType: 'subFrame', requestHeaders }), requestHeaders);
  assert.equal(videos.embedRequestHeaders(undefined), undefined);
});

// ---------------------------------------------------------------------------
// popups
// ---------------------------------------------------------------------------

// The referrers Electron 44 handed the window-open handler, measured.
const FROM_PLAYER = { url: 'https://www.youtube-nocookie.com/', policy: 'strict-origin-when-cross-origin' };
const FROM_APP = { url: '', policy: 'strict-origin-when-cross-origin' };
const HIDDEN = { url: '', policy: 'no-referrer' };

test('a popup is the player\'s, another page\'s from the web, or the app\'s own', () => {
  assert.equal(videos.popupSource(FROM_PLAYER), 'player');
  assert.equal(videos.popupSource({ url: 'https://www.youtube-nocookie.com/embed/' + A, policy: 'unsafe-url' }), 'player');
  assert.equal(videos.popupSource(FROM_APP), 'app');
  assert.equal(videos.popupSource({ url: '', policy: 'default' }), 'app');
  assert.equal(videos.popupSource({ url: 'file:///Applications/Switchboard.app/index.html', policy: 'strict-origin-when-cross-origin' }), 'app');
  assert.equal(videos.popupSource(undefined), 'app');
  assert.equal(videos.popupSource(''), 'app');
  for (const web of [
    { url: 'https://www.youtube.com/', policy: 'strict-origin-when-cross-origin' },
    { url: 'https://googleads.example/', policy: 'strict-origin-when-cross-origin' },
    { url: 'http://www.youtube-nocookie.com/', policy: 'strict-origin-when-cross-origin' },
    'https://www.youtube-nocookie.com.evil.test/',
  ]) assert.equal(videos.popupSource(web), 'web', JSON.stringify(web));
  // No referrer under a policy the app's page never sets: a page that hid where it was.
  for (const policy of ['no-referrer', 'same-origin', 'strict-origin', 'origin', 'no-referrer-when-downgrade']) {
    assert.equal(videos.popupSource({ url: '', policy }), 'web', policy);
  }
});

test("a popup from the player leads to YouTube or Google's help pages, or nowhere", () => {
  for (const ok of [
    youTubeWatchUrl({ videoId: A, start: 42 }),
    'https://youtube.com/watch?v=' + A,
    'https://m.youtube.com/@examplechannel',
    'https://music.youtube.com/watch?v=' + A,
    'https://youtu.be/' + A,
    'https://support.google.com/youtube/answer/0000000',
    'https://policies.google.com/privacy',
  ]) assert.equal(videos.isPlayerPopupUrl(ok), true, ok);
  for (const refused of [
    'http://www.youtube.com/watch?v=' + A,
    'https://www.youtube.com:8443/watch?v=' + A,
    'https://user:pw@www.youtube.com/',
    'https://www.youtube.com.evil.test/',
    'https://gaming.youtube.com/',
    'https://www.google.com/search?q=example',
    'https://ads.example/landing',
    'vnd.youtube://' + A,
    'javascript:alert(1)',
    '',
  ]) assert.equal(videos.isPlayerPopupUrl(refused), false, refused);
});

test("the app's own popups open as they always have", () => {
  const popups = videos.playerPopups(() => 1000);
  for (let i = 0; i < 3; i++) assert.equal(popups.allow({ url: 'https://example.com/pr/' + i, referrer: FROM_APP }), true);
  assert.equal(popups.allow({ url: 'http://localhost:3000/', referrer: FROM_APP }), true);
  assert.equal(popups.allow({ url: 'https://example.com/' }), true, 'no referrer at all');
});

test('the player opens one YouTube tab per quiet second, and a loop opens one', () => {
  let now = 10_000;
  const popups = videos.playerPopups(() => now);
  const watch = { url: youTubeWatchUrl({ videoId: A }), referrer: FROM_PLAYER };
  assert.equal(popups.allow(watch), true, 'Watch on YouTube');
  assert.equal(popups.allow(watch), false, 'the same click opens one tab');
  // window.open in a loop, every 100 ms: each one restarts the second, so none opens.
  for (let i = 0; i < 30; i++) {
    now += 100;
    assert.equal(popups.allow(watch), false, 'loop ' + i);
  }
  // A quiet second later, the next click opens again.
  now += 1000;
  assert.equal(popups.allow(watch), true);
  now += 999;
  assert.equal(popups.allow(watch), false, 'not quite a second');
  // A refused address counts as a popup too.
  now += 1500;
  assert.equal(popups.allow({ url: 'https://ads.example/x', referrer: FROM_PLAYER }), false);
  now += 500;
  assert.equal(popups.allow(watch), false, 'half a second after the refused one');
  now += 1000;
  assert.equal(popups.allow(watch), true);
  // The app's own popups never wait for the player's second, nor use it up.
  assert.equal(popups.allow({ url: 'https://example.com/', referrer: FROM_APP }), true);
  now += 1000;
  assert.equal(popups.allow(watch), true);
});

test('another page from the web, or one that hid its referrer, opens nothing', () => {
  let now = 50_000;
  const popups = videos.playerPopups(() => now);
  const youtube = youTubeWatchUrl({ videoId: B });
  for (const referrer of [HIDDEN, { url: 'https://googleads.example/', policy: 'strict-origin-when-cross-origin' }]) {
    now += 5000;
    assert.equal(popups.allow({ url: youtube, referrer }), false, JSON.stringify(referrer));
  }
  now += 5000;
  assert.equal(popups.allow({ url: 'http://www.youtube.com/watch?v=' + B, referrer: FROM_PLAYER }), false, 'http, from the player');
  assert.equal(popups.allow(undefined), true, 'details Electron never sends: the app\'s');
});

// ---------------------------------------------------------------------------
// navigations
// ---------------------------------------------------------------------------

/** A webContents as far as the predicates ask it: its main frame. */
function contents(mainFrame) {
  return { get mainFrame() { return mainFrame; } };
}
const DISPOSED = 'Render frame was disposed before WebFrameMain could be accessed';
const disposed = () => { throw new Error(DISPOSED); };

test("a top navigation the player starts is refused; the page's own, and a drop's, are not", () => {
  const main = { name: 'main' };
  const player = { name: 'player', parent: main };
  const wc = contents(main);
  assert.equal(videos.startedByAFrame({ url: 'https://example.com/', initiator: player }, wc), true);
  assert.equal(videos.startedByAFrame({ url: 'https://example.com/', initiator: main }, wc), false);
  assert.equal(videos.startedByAFrame({ url: 'https://example.com/', initiator: null }, wc), false, 'a link dropped on the window');
  assert.equal(videos.startedByAFrame({ url: 'https://example.com/' }, wc), false);
  assert.equal(videos.startedByAFrame(undefined, wc), false);
  // The comparison asks the starting frame nothing, so a frame that has gone still counts.
  const gone = Object.defineProperty({}, 'parent', { get: disposed });
  assert.equal(videos.startedByAFrame({ url: 'https://example.com/', initiator: gone }, wc), true);
  // A window that cannot name its main frame cannot say the page started it.
  const broken = Object.defineProperty({}, 'mainFrame', { get: disposed });
  assert.equal(videos.startedByAFrame({ url: 'https://example.com/', initiator: main }, broken), true);
});

test("the player's own frame stays on the player; frames inside it go where they go", () => {
  const main = { name: 'main' };
  const player = { name: 'player', parent: main };
  const inside = { name: 'inside', parent: player };
  const wc = contents(main);
  const nav = (frame, url, isMainFrame = false) => videos.leavesThePlayer({ url, frame, isMainFrame }, wc);
  assert.equal(nav(player, 'https://example.com/elsewhere'), true);
  assert.equal(nav(player, 'https://www.youtube-nocookie.com/robots.txt'), true, 'the same host, not a player');
  assert.equal(nav(player, 'https://www.youtube.com/watch?v=' + A), true);
  assert.equal(nav(player, 'about:blank'), true);
  assert.equal(nav(player, youTubeEmbedUrl({ videoId: B, start: 10 })), false, 'another video, in the same player');
  assert.equal(nav(inside, 'https://example.com/'), false);
  assert.equal(nav(inside, 'about:blank'), false);
  assert.equal(nav(main, 'https://example.com/', true), false, 'the main frame is will-navigate\'s');
  assert.equal(nav(null, 'https://example.com/'), false);
  const gone = Object.defineProperty({}, 'parent', { get: disposed });
  assert.equal(nav(gone, 'https://example.com/'), false, 'a frame torn down navigates nowhere');
  assert.equal(videos.leavesThePlayer(undefined, wc), false);
});

// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------

test('the player gets fullscreen and nothing else', () => {
  for (const url of ['https://www.youtube-nocookie.com/embed/' + A + '?autoplay=1', 'https://www.youtube-nocookie.com/', 'https://www.youtube-nocookie.com']) {
    assert.equal(videos.permissionAllowed('fullscreen', url), true, url);
    for (const permission of ['background-sync', 'notifications', 'storage-access', 'clipboard-sanitized-write', 'clipboard-read',
      'media', 'mediaKeySystem', 'geolocation', 'openExternal', 'pointerLock', 'keyboardLock', 'window-management', 'idle-detection']) {
      assert.equal(videos.permissionAllowed(permission, url), false, permission + ' from ' + url);
    }
  }
});

test('any other page from the web in the window gets nothing at all', () => {
  for (const url of ['https://www.youtube.com/embed/' + A, 'https://www.google.com/', 'https://googleads.example/frame',
    'http://www.youtube-nocookie.com/embed/' + A, 'https://www.youtube-nocookie.com:8443/embed/' + A]) {
    for (const permission of ['fullscreen', 'notifications', 'openExternal', 'clipboard-sanitized-write']) {
      assert.equal(videos.permissionAllowed(permission, url), false, permission + ' from ' + url);
    }
  }
});

test("the app's own page is answered yes, as a session with no handler answers it", () => {
  for (const url of ['file:///Applications/Switchboard.app/Contents/Resources/app/src/renderer/index.html', 'file:///',
    'devtools://devtools/bundled/devtools_app.html', '', undefined]) {
    for (const permission of ['clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'notifications', 'openExternal']) {
      assert.equal(videos.permissionAllowed(permission, url), true, permission + ' from ' + url);
    }
  }
});

test('camera and microphone access needs the exact app main document and explicit audio/video types', () => {
  for (const mediaTypes of [['video'], ['audio'], ['audio', 'video']]) {
    assert.equal(videos.permissionAllowed('media', APP_PAGE, { isMainFrame: true, mediaTypes }), true);
  }
  for (const mediaType of ['video', 'audio']) {
    assert.equal(videos.permissionAllowed('media', APP_PAGE, { isMainFrame: true, mediaType }), true);
    assert.equal(videos.permissionAllowed('media', APP_PAGE + '#whiteboard', { isMainFrame: true, mediaType }), true);
  }
  for (const details of [undefined, null, {}, { mediaTypes: ['video'] }, { isMainFrame: false, mediaTypes: ['video'] },
    { isMainFrame: true }, { isMainFrame: true, mediaTypes: [] }, { isMainFrame: true, mediaType: 'unknown' },
    { isMainFrame: true, mediaTypes: ['video', 'screen'] }, { isMainFrame: true, mediaType: 'display' }]) {
    assert.equal(videos.permissionAllowed('media', APP_PAGE, details), false, JSON.stringify(details));
  }
  for (const url of [undefined, '', 'file:///', 'file:///other/index.html', 'about:blank',
    'devtools://devtools/bundled/devtools_app.html', PLAYER, 'https://www.google.com/',
    APP_PAGE + '?other-document', APP_PAGE + '/extra']) {
    assert.equal(videos.permissionAllowed('media', url, { isMainFrame: true, mediaTypes: ['audio', 'video'] }), false, String(url));
  }
});

test('setupVideoEmbeds installs the Referer and both permission handlers on the session it is given', () => {
  const installed = {};
  const ses = {
    webRequest: { onBeforeSendHeaders: (filter, listener) => { installed.filter = filter; installed.listener = listener; } },
    setPermissionRequestHandler: handler => { installed.request = handler; },
    setPermissionCheckHandler: handler => { installed.check = handler; },
  };
  videos.setupVideoEmbeds(ses);
  assert.deepEqual(installed.filter, { urls: ['https://www.youtube-nocookie.com/embed/*'] });
  let answer = null;
  installed.listener({ url: PLAYER, resourceType: 'subFrame', requestHeaders: { Accept: '*/*' } }, out => { answer = out; });
  assert.deepEqual(answer, { requestHeaders: { Accept: '*/*', Referer: 'https://local.switchboard.app/' } });
  installed.listener({ url: PLAYER, resourceType: 'xhr', requestHeaders: { Accept: '*/*' } }, out => { answer = out; });
  assert.deepEqual(answer, { requestHeaders: { Accept: '*/*' } });

  // A request: the player's fullscreen button, then the app's own clipboard fallback.
  const asked = (permission, requestingUrl, details = {}) => {
    let granted = null;
    installed.request({}, permission, ok => { granted = ok; }, { requestingUrl, isMainFrame: false, ...details });
    return granted;
  };
  assert.equal(asked('fullscreen', PLAYER), true);
  assert.equal(asked('notifications', PLAYER), false);
  assert.equal(asked('clipboard-sanitized-write', 'file:///index.html'), true);
  // A check from the cross-origin player names its origin and no requestingUrl (measured).
  assert.equal(installed.check({}, 'background-sync', 'https://www.youtube-nocookie.com/', { embeddingOrigin: 'file:///' }), false);
  assert.equal(installed.check({}, 'fullscreen', 'https://www.youtube-nocookie.com/', {}), true);
  assert.equal(installed.check({}, 'clipboard-read', 'file:///', { requestingUrl: 'file:///index.html' }), true);
  assert.equal(installed.check({}, 'geolocation', '', { requestingUrl: 'https://googleads.example/' }), false);
  assert.equal(asked('media', APP_PAGE, { isMainFrame: true, mediaTypes: ['audio', 'video'] }), true);
  assert.equal(asked('media', APP_PAGE, { mediaTypes: ['video'] }), false, 'a file iframe gets no capture');
  assert.equal(asked('media', PLAYER, { isMainFrame: true, mediaTypes: ['video'] }), false);
  assert.equal(installed.check({}, 'media', 'file:///', { requestingUrl: APP_PAGE, isMainFrame: true, mediaType: 'video' }), true);
  assert.equal(installed.check({}, 'media', 'file:///', { requestingUrl: APP_PAGE, isMainFrame: true, mediaType: 'audio' }), true);
  assert.equal(installed.check({}, 'media', 'file:///', { isMainFrame: true, mediaType: 'video' }), false, 'an origin alone is insufficient');
  assert.equal(installed.check({}, 'media', 'https://www.youtube-nocookie.com/', {
    requestingUrl: PLAYER, embeddingOrigin: 'file:///', isMainFrame: false, mediaType: 'audio',
  }), false);
});

// ---------------------------------------------------------------------------
// videoInfo, with a stand-in for net.fetch
// ---------------------------------------------------------------------------

/** A net.fetch that answers `respond(url, init)`, and remembers what it was asked. */
function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  fn.calls = calls;
  return fn;
}

const json = (body, init = {}) => new Response(JSON.stringify(body), Object.assign({ status: 200, headers: { 'content-type': 'application/json' } }, init));

test('videoInfo refuses anything but a video id, and asks YouTube nothing', async () => {
  const fetch = fakeFetch(() => json({ title: 'never asked' }));
  for (const id of ['https://youtu.be/' + A, 'exampleVid', 'videoseries', ' ' + A, '', undefined, null, 42, { id: A }]) {
    assert.deepEqual(await videos.videoInfo(id, { fetch }), { ok: false, error: "That isn't the id of a YouTube video" }, String(id));
  }
  assert.equal(fetch.calls.length, 0);
});

test("videoInfo asks oEmbed for the video's watch page and answers its title and channel", async () => {
  const fetch = fakeFetch(() => json({ title: 'A made-up video', author_name: 'An example channel', type: 'video', width: 200, height: 113 }));
  assert.deepEqual(await videos.videoInfo(A, { fetch }), { ok: true, data: { title: 'A made-up video', author: 'An example channel' } });
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D' + A);
  assert.equal(url, videos.oEmbedUrl(A));
  assert.equal(new URL(url).searchParams.get('url'), youTubeWatchUrl({ videoId: A }), 'the page ⌘C copies a video as');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers.Accept, 'application/json');
  assert.ok(init.signal instanceof AbortSignal);
  // The id is asked as YouTube spells it.
  await videos.videoInfo('EXAMPLEvid1', { fetch });
  assert.match(fetch.calls[1].url, /EXAMPLEvid1$/);
});

test('a title comes back plain, on one line, and never too long for a label', async () => {
  const messy = '  Line one\nline\ttwo\r\n\u0007 &amp; <b>three</b>\u2028four  ';
  const fetch = fakeFetch(() => json({ title: messy, author_name: '\n An\u0000example \n' }));
  assert.deepEqual(await videos.videoInfo(A, { fetch }), {
    ok: true,
    // The JSON is not HTML: an &amp; in it is what the title says.
    data: { title: 'Line one line two &amp; <b>three</b> four', author: 'An example' },
  });
  // Cut at 200 characters, never through one: the 200th is an emoji, two UTF-16 units.
  const long = 'x'.repeat(199) + '🎬' + 'y'.repeat(300);
  const cut = await videos.videoInfo(A, { fetch: fakeFetch(() => json({ title: long })) });
  assert.equal(cut.data.title, 'x'.repeat(199) + '🎬');
  assert.equal(cut.data.author, '', 'no channel given');
});

test("an answer with no title says so", async () => {
  for (const body of [{ author_name: 'An example channel' }, { title: '   ' }, { title: 42 }, null, []]) {
    assert.deepEqual(await videos.videoInfo(A, { fetch: fakeFetch(() => json(body)) }),
      { ok: false, error: "YouTube didn't say what that video is called" }, JSON.stringify(body));
  }
  const html = await videos.videoInfo(A, { fetch: fakeFetch(() => new Response('<!doctype html><p>Sorry</p>', { status: 200 })) });
  assert.deepEqual(html, { ok: false, error: "YouTube didn't say what that video is called" });
});

test("YouTube's refusals become sentences, and the answer is not left streaming in", async () => {
  const cases = [
    [400, "That video isn't on YouTube"],          // a made-up id, measured
    [404, "That video isn't on YouTube"],
    [401, "That video can't be embedded"],
    [403, "That video can't be embedded"],
    [500, "YouTube didn't answer (HTTP 500)"],
    [429, "YouTube didn't answer (HTTP 429)"],
  ];
  for (const [status, error] of cases) {
    const fetch = fakeFetch(() => new Response(status === 400 ? 'Bad Request' : 'Nope', { status }));
    assert.deepEqual(await videos.videoInfo(A, { fetch }), { ok: false, error }, String(status));
    assert.equal(fetch.calls[0].init.signal.aborted, true, String(status));
  }
});

test("a network failure is Couldn't reach YouTube", async () => {
  const fetch = fakeFetch(() => { throw new TypeError('net::ERR_INTERNET_DISCONNECTED'); });
  assert.deepEqual(await videos.videoInfo(A, { fetch }), { ok: false, error: "Couldn't reach YouTube" });
});

test('an answer that never comes, or stops half way, is given up on', async () => {
  // fetch never settles, whatever the abort does.
  const silent = fakeFetch(() => new Promise(() => {}));
  const started = Date.now();
  assert.deepEqual(await videos.videoInfo(A, { fetch: silent, timeoutMs: 60 }), { ok: false, error: 'YouTube took too long to answer' });
  assert.ok(Date.now() - started < 2000);
  assert.equal(silent.calls[0].init.signal.aborted, true);
  // Headers, then a body that never ends.
  const stalled = fakeFetch(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"title":')); } }), { status: 200 }));
  assert.deepEqual(await videos.videoInfo(A, { fetch: stalled, timeoutMs: 60 }), { ok: false, error: 'YouTube took too long to answer' });
});

test('an answer past 64 KB is refused, by its length or as it streams', async () => {
  assert.equal(videos.INFO_MAX_BYTES, 64 * 1024);
  const big = fakeFetch(() => new Response('{}', { status: 200, headers: { 'content-length': String(64 * 1024 + 1) } }));
  assert.deepEqual(await videos.videoInfo(A, { fetch: big }), { ok: false, error: "YouTube's answer was too long" });
  assert.equal(big.calls[0].init.signal.aborted, true);
  // No length given, and it keeps coming: cut off once past the cap.
  let pulled = 0;
  let cancelled = false;
  const endless = fakeFetch(() => new Response(new ReadableStream({
    pull(c) { pulled++; c.enqueue(new Uint8Array(16 * 1024).fill(0x20)); },
    cancel() { cancelled = true; },
  }), { status: 200 }));
  assert.deepEqual(await videos.videoInfo(A, { fetch: endless }), { ok: false, error: "YouTube's answer was too long" });
  assert.ok(pulled <= 6, 'read no further than the cap: ' + pulled);
  assert.equal(cancelled, true);
  // Just under the cap is still an answer.
  const padded = JSON.stringify({ title: 'A made-up video', pad: ' '.repeat(64 * 1024 - 60) });
  assert.ok(Buffer.byteLength(padded) <= 64 * 1024);
  const near = await videos.videoInfo(A, { fetch: fakeFetch(() => new Response(padded, { status: 200 })) });
  assert.deepEqual(near, { ok: true, data: { title: 'A made-up video', author: '' } });
});
