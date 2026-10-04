'use strict';

// npm run test:diagrams — src/main/images.js, the Google Images panel's main-process half
// (§4.17): which <webview> may attach and what it is forced to be, the user agent Google
// is shown, Google's redirect wrappers, data: URLs, what a picture's first bytes say it
// is, its label, its Referer, the panel's right-click menu, when its page may open a tab
// in the browser, and fetchImage itself. Plain node, no Electron: the module requires
// Electron only inside the functions that need it, and here that require gets a stand-in
// whose one session fetches with Node's own fetch, from a server on 127.0.0.1. On macOS
// a conversion runs the real sips, in its real sandbox.
//
// The magic bytes are real ones — the leading bytes of files macOS's sips wrote and of a
// WebP Chromium's canvas encoded — so a sniff that passes here passes on a download.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { after, test } = require('node:test');

// Electron, as far as images.js asks it here: a session whose fetch is Node's. Menu and
// clipboard are only reached from a right-click, which nothing here makes.
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { session: { fromPartition: () => ({ fetch: (url, init) => fetch(url, init) }) } },
};

// Every program images.js runs, to see that sips only ever runs in its sandbox.
const childProcess = require('node:child_process');
const ran = [];
const execFile = childProcess.execFile;
childProcess.execFile = function (file, args, ...rest) {
  ran.push([file, ...(Array.isArray(args) ? args : [])]);
  return execFile.call(this, file, args, ...rest);
};

const images = require('../src/main/images');
const diagrams = require('../src/main/diagrams');

const hex = h => Buffer.from(h, 'hex');
// A 1×1 PNG and a 1×1 GIF, whole files.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const GIF_1PX = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const MAGIC = {
  'image/png': Buffer.from(PNG_1PX, 'base64'),
  'image/jpeg': hex('ffd8ffe000104a46494600010100009000900000ffe100804578696600004d4d002a000000080004'),
  'image/webp': hex('524946461e02000057454250565038580a0000002000000007000007000049434350c80100000000'),
  'image/gif': Buffer.from(GIF_1PX, 'base64'),
  'image/avif': hex('000000206674797061766966000000004d695072617669666d6961666d696631000001e86d657461'),
  'image/heic': hex('000000286674797068656963000000006d6966314d6948454d6950726d6961664d69484268656963'),
  'image/bmp': hex('424d8a400000000000008a0000007c00000040000000c0ffffff0100200003000000004000002516'),
  'image/tiff': hex('4d4d002a000040320003a00100030000000100010000a00200040000000100000040a00300040000'),
};
// 1×1 pictures in each format sips is asked to turn into a PNG, whole — sips wrote them.
const b64 = (...lines) => Buffer.from(lines.join(''), 'base64');
const WHOLE = {
  'image/gif': Buffer.from(GIF_1PX, 'base64'),
  'image/bmp': b64(
    'Qk2OAAAAAAAAAIoAAAB8AAAAAQAAAP////8BACAAAwAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/AAAAAAAA/0JH',
    'UnMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAfw==',
  ),
  'image/tiff': b64(
    'TU0AKgAAACoAAqACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAAAAP9/ABABAAADAAAAAQABAAABAQADAAAAAQABAAABAgAD',
    'AAAABAAAAPABAwADAAAAAQABAAABBgADAAAAAQACAAABCgADAAAAAQABAAABEQAEAAAAAQAAACYBEgADAAAAAQABAAABFQAD',
    'AAAAAQAEAAABFgADAAAAAQABAAABFwAEAAAAAQAAAAQBHAADAAAAAQABAAABKAADAAAAAQACAAABUgADAAAAAQACAAABUwAD',
    'AAAABAAAAPiHaQAEAAAAAQAAAAgAAAAAAAgACAAIAAgAAQABAAEAAQ==',
  ),
  'image/heic': b64(
    'AAAAGGZ0eXBoZWljAAAAAGhlaWNtaWYxAAACrG1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAA',
    'JGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAA',
    'AAABAABodmMxAAAAABVpbmZlAgAAAQACAABodmMxAAAAABppcmVmAAAAAAAAAA5hdXhsAAIAAQABAAABz2lwcnAAAAGkaXBj',
    'bwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAACAAAAAgAAAChjbGFwAAAAAQAAAAEAAAAB',
    'AAAAAf/AAAAAgAAA/8AAAACAAAAAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAADnBpeGkAAAAAAQgAAAA3YXV4QwAAAAB1',
    'cm46bXBlZzpoZXZjOjIwMTU6YXV4aWQ6MQAAAAAMAAAACE4BpQQAAf5AAAAAcmh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAAL',
    'A6AAAQAXQAEMAf//A3AAAAMAsAAAAwAAAwAecCShAAEAJEIBAQNwAAADALAAAAMAAAMAHqAUIEHAoQQYh7kWVTcCAgYAgKIA',
    'AQAJRAHAYXLIRFNkAAAAcWh2Y0MBBAgAAAC/yAAAAAAe8AD8/Pj4AAALA6AAAQAXQAEMAf//BAgAAAMAv8gAAAMAAB4XAkCh',
    'AAEAI0IBAQQIAAADAL/IAAADAAAewFCBBwE/B/iBe5FlU3AgICAIogABAAlEAcBh0shEU2QAAAAjaXBtYQAAAAAAAAACAAEH',
    'gQIDBomEhQACBgMHiIqEhQAAACxpbG9jAAAAAEQAAAIAAQAAAAEAAALUAAAAUQACAAAAAQAAAyUAAAA1AAAAAW1kYXQAAAAA',
    'AAAAlgAAAE0oAa+jZRDUjOkCKCf+gBzWnKn4WR+H2m/0HVgn/Aq1NfXxfRKQFvHb9E/UD4P/14Sb95HxnRvSgBzMczr6NVW/',
    'zbtRvMJbepsLB0BRQAAAADEoAa9F/CceHsWyM7UvkJuAk/dxGDV8P1YWvyVv5XX/+QKnC4VAMjMJvqdpdqpICG+A',
  ),
  'image/avif': b64(
    'AAAAGGZ0eXBhdmlmAAAAAGF2aWZtaWYxAAAB4W1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAA',
    'JGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAA',
    'AAABAABhdjAxAAAAABVpbmZlAgAAAQACAABhdjAxAAAAABppcmVmAAAAAAAAAA5hdXhsAAIAAQABAAABBGlwcnAAAADZaXBj',
    'bwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAACAAAAAgAAAChjbGFwAAAAAQAAAAEAAAAB',
    'AAAAAf/AAAAAgAAA/8AAAACAAAAAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAADnBpeGkAAAAAAQgAAAA3YXV4QwAAAAB1',
    'cm46bXBlZzpoZXZjOjIwMTU6YXV4aWQ6MQAAAAAMAAAACE4BpQQAAf5AAAAADGF2MUOBAAwAAAAADGF2MUOBABwAAAAAI2lw',
    'bWEAAAAAAAAAAgABB4ECAwaJhIUAAgYDB4iKhIUAAAAsaWxvYwAAAABEAAACAAEAAAABAAACCQAAAC4AAgAAAAEAAAI3AAAA',
    'JQAAAAFtZGF0AAAAAAAAAGMSAAoMAAAAAAZ//AgQEDQgMhwQAZIACCCCIAEo0hnwflnnyxHiQAAFScNJQPYIEgAKCAAAAAAG',
    'f/wVMhcQAY4AIIoK0uc9Fxv+iBHvP/P98erdwA==',
  ),
};
const MAC_ONLY = process.platform !== 'darwin' && "sips is macOS's";

// ---------------------------------------------------------------------------
// which <webview> may attach
// ---------------------------------------------------------------------------

test('the panel may start on https www.google.com or images.google.com, and nowhere else', () => {
  for (const ok of [
    'https://www.google.com/search?udm=2&q=golden%20retriever',
    'https://www.google.com/imghp',
    'https://images.google.com/',
    'HTTPS://WWW.GOOGLE.COM/imghp',
    'https://www.google.com:443/imghp',
  ]) assert.equal(images.isGoogleImagesSrc(ok), true, ok);

  for (const refused of [
    'http://www.google.com/imghp',                    // not https
    'https://google.com/imghp',                       // not one of the two hosts
    'https://www.google.co.uk/imghp',
    'https://www.google.com.evil.test/imghp',         // a lookalike: google.com is a prefix
    'https://www.google.com.',                        // trailing dot, a different name
    'https://wwwxgoogle.com/',
    'https://evil.test/?u=https://www.google.com/',
    'https://evil.test/#www.google.com',
    'https://www.google.com@evil.test/',              // credentials, then the real host
    'https://user:secret@www.google.com/',
    'https://www.google.com:8443/',
    'www.google.com/imghp',                           // no scheme at all
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
    'about:blank',
    '',
    undefined,
    null,
  ]) assert.equal(images.isGoogleImagesSrc(refused), false, String(refused));
});

test('hardenWebview refuses another partition or a start that is not Google', () => {
  // The bundle's <webview> names this one (image-search.ts; test-image-search.js checks
  // the two agree), so it is pinned here as well as used.
  assert.equal(images.PARTITION, 'persist:sb-images');
  const src = 'https://www.google.com/imghp';
  assert.equal(images.hardenWebview({}, { partition: 'persist:other', src }), false);
  assert.equal(images.hardenWebview({}, { partition: '', src }), false);
  assert.equal(images.hardenWebview({}, { partition: 'persist:sb-images2', src }), false);
  assert.equal(images.hardenWebview({}, { partition: images.PARTITION, src: 'http://www.google.com/' }), false);
  assert.equal(images.hardenWebview({}, { partition: images.PARTITION, src: 'https://www.google.com.evil.test/' }), false);
  assert.equal(images.hardenWebview({}, { partition: images.PARTITION }), false);
  assert.equal(images.hardenWebview({}, undefined), false);
});

test('hardenWebview lets the panel attach with everything risky forced off', () => {
  // What a hostile page could ask for through the element's attributes.
  const prefs = {
    preload: '/tmp/evil.js',
    nodeIntegration: true,
    nodeIntegrationInSubFrames: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    enableBlinkFeatures: 'Something',
    partition: 'persist:another',              // a `webpreferences` attribute wins over `partition`
    disablePopups: true,
    disableDialogs: false,
    javascript: true,
  };
  const params = { partition: images.PARTITION, src: 'https://www.google.com/search?udm=2&q=cats', preload: 'file:///tmp/evil.js' };
  assert.equal(images.hardenWebview(prefs, params), true);
  assert.equal(prefs.preload, undefined);
  assert.equal(params.preload, undefined);
  assert.equal(prefs.enableBlinkFeatures, undefined);
  assert.equal(prefs.partition, images.PARTITION);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.webviewTag, false);
  // Popups reach the guest's window-open handler, which sends them to the browser.
  assert.equal(prefs.disablePopups, false);
  // No alert() or confirm() sheets on Switchboard's window.
  assert.equal(prefs.disableDialogs, true);
  assert.equal(prefs.javascript, true, 'Google needs its scripts');
});

// ---------------------------------------------------------------------------
// when the panel's page may open a tab in the browser
// ---------------------------------------------------------------------------

test('a click or a key in the page lets it open one tab, for a second', () => {
  let now = 1000;
  const activation = images.userActivation(() => now);
  assert.equal(activation.consume(), false, 'nothing has happened yet');
  for (const type of ['mouseMove', 'mouseWheel', 'mouseEnter', 'mouseUp', 'char', 'keyUp', undefined]) activation.input(type);
  assert.equal(activation.consume(), false, 'moving, scrolling, and letting go with no press, are no click');
  for (const type of ['mouseDown', 'rawKeyDown', 'keyDown']) {
    activation.input(type);
    assert.equal(activation.consume(), true, type);
    assert.equal(activation.consume(), false, type + ' opens one tab, not two');
  }
  // One click is one tab: letting go of the button gives the page no second one.
  activation.input('mouseDown');
  assert.equal(activation.consume(), true);
  activation.input('mouseUp');
  assert.equal(activation.consume(), false);
  // A click held down lasts a second from letting go; a second later it is gone.
  activation.input('mouseDown');
  now += 1500;
  activation.input('mouseUp');
  now += 999;
  assert.equal(activation.consume(), true, 'still that click');
  activation.input('rawKeyDown');
  now += 1000;
  assert.equal(activation.consume(), false, 'a second later it is gone');
});

test('a guest page with no click opens nothing in the browser, and a click opens one tab', () => {
  // A guest webContents, as far as attachGuest wires it.
  const wc = new EventEmitter();
  wc.setWindowOpenHandler = handler => { wc.openHandler = handler; };
  const opened = [];
  images.attachGuest(wc, { openExternal: url => opened.push(url), offerImage() {}, window: () => null });
  const open = url => wc.openHandler({ url });
  // window.open at load, in a loop: every one denied, and none reaches the browser.
  for (let i = 0; i < 5; i++) assert.deepEqual(open('https://ads.example/' + i), { action: 'deny' });
  assert.deepEqual(opened, []);
  // A result clicked "in a new tab": that one tab, and nothing more on the same click.
  wc.emit('input-event', {}, { type: 'mouseDown' });
  wc.emit('input-event', {}, { type: 'mouseUp' });
  assert.deepEqual(open('https://example.com/red-pandas'), { action: 'deny' });
  open('https://ads.example/also');
  assert.deepEqual(opened, ['https://example.com/red-pandas']);
  // Never anything but http(s), click or not.
  wc.emit('input-event', {}, { type: 'mouseDown' });
  open('custom-scheme://launch');
  assert.deepEqual(opened, ['https://example.com/red-pandas']);
});

// ---------------------------------------------------------------------------
// the user agent Google sees
// ---------------------------------------------------------------------------

test('the user agent loses the app and Electron tokens and keeps Chrome', () => {
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36';
  assert.equal(images.cleanUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Switchboard/0.1.0 Chrome/152.0.7977.130 Electron/44.4.2 Safari/537.36'
  ), chrome);
  // A dev run's name has a dash in it; and a run named Electron gets no app token at all.
  assert.equal(images.cleanUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) sample-app/44.4.2 Chrome/152.0.7977.130 Electron/44.4.2 Safari/537.36'
  ), chrome);
  assert.equal(images.cleanUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Electron/44.4.2 Safari/537.36'
  ), chrome);
  assert.equal(images.cleanUserAgent(chrome), chrome, 'a clean one is left alone');
  assert.equal(images.cleanUserAgent(undefined), '');
});

// ---------------------------------------------------------------------------
// Google's redirect wrappers
// ---------------------------------------------------------------------------

test("Google's /imgres and /url wrappers give up the address inside", () => {
  const dog = 'https://cdn.example.test/photos/dog.jpg';
  assert.equal(images.unwrapImageUrl(
    'https://www.google.com/imgres?imgurl=' + encodeURIComponent(dog) + '&imgrefurl=' + encodeURIComponent('https://example.test/dogs') + '&h=600&w=800'
  ), dog);
  assert.equal(images.unwrapImageUrl('https://www.google.com/url?sa=i&url=' + encodeURIComponent(dog) + '&psig=x'), dog);
  assert.equal(images.unwrapImageUrl('https://www.google.com/url?q=' + encodeURIComponent(dog) + '&sa=U'), dog);
  // A country domain wraps the same way; and a wrapper inside a wrapper.
  assert.equal(images.unwrapImageUrl('https://www.google.co.uk/imgres?imgurl=' + encodeURIComponent(dog)), dog);
  const inner = 'https://www.google.com/imgres?imgurl=' + encodeURIComponent(dog);
  assert.equal(images.unwrapImageUrl('https://www.google.com/url?url=' + encodeURIComponent(inner)), dog);
  // A data: picture inside is fine too.
  const data = 'data:image/png;base64,' + PNG_1PX;
  assert.equal(images.unwrapImageUrl('https://www.google.com/imgres?imgurl=' + encodeURIComponent(data)), data);
});

test('anything that is not a Google wrapper around a picture is left as it was', () => {
  const plain = 'https://cdn.example.test/photos/dog.jpg?w=800';
  assert.equal(images.unwrapImageUrl(plain), plain);
  assert.equal(images.unwrapImageUrl('  ' + plain + '  '), plain);
  // The same path on another host is that host's business.
  const elsewhere = 'https://example.test/imgres?imgurl=' + encodeURIComponent(plain);
  assert.equal(images.unwrapImageUrl(elsewhere), elsewhere);
  const lookalike = 'https://www.google.com.evil.test/url?q=' + encodeURIComponent(plain);
  assert.equal(images.unwrapImageUrl(lookalike), lookalike);
  // Something that is not a picture's address stays inside its wrapper.
  const script = 'https://www.google.com/url?q=' + encodeURIComponent('javascript:alert(1)');
  assert.equal(images.unwrapImageUrl(script), script);
  const empty = 'https://www.google.com/imgres?imgrefurl=' + encodeURIComponent('https://example.test/');
  assert.equal(images.unwrapImageUrl(empty), empty);
  assert.equal(images.unwrapImageUrl('not a url'), 'not a url');
  assert.equal(images.unwrapImageUrl(undefined), '');
});

// ---------------------------------------------------------------------------
// data: URLs
// ---------------------------------------------------------------------------

test('a base64 image data: URL gives its bytes and the type it claims', () => {
  const parsed = images.parseDataUrl('data:image/png;base64,' + PNG_1PX);
  assert.deepEqual(parsed.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.equal(parsed.type, 'image/png');
  // Parameters before ;base64, line breaks inside it, and a percent-encoded body.
  assert.equal(images.parseDataUrl('data:image/gif;charset=binary;base64,' + GIF_1PX).type, 'image/gif');
  assert.deepEqual(images.parseDataUrl('data:image/png;base64,' + PNG_1PX.replace(/(.{20})/g, '$1\n')).bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.deepEqual(images.parseDataUrl('data:IMAGE/PNG;BASE64,' + encodeURIComponent(PNG_1PX)).bytes, Buffer.from(PNG_1PX, 'base64'));
});

test('a data: URL that is not a base64 image is not one', () => {
  assert.equal(images.parseDataUrl('data:text/html;base64,PGgxPmhpPC9oMT4='), null);
  assert.equal(images.parseDataUrl('data:application/octet-stream;base64,' + PNG_1PX), null);
  assert.equal(images.parseDataUrl('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'), null);
  assert.equal(images.parseDataUrl('data:image/png;base64,not*base64!'), null);
  assert.equal(images.parseDataUrl('data:image/png;base64,'), null);
  assert.equal(images.parseDataUrl('https://example.test/a.png'), null);
  assert.equal(images.parseDataUrl(undefined), null);
});

test('a data: URL past the cap is refused from its length, before it is decoded', () => {
  // Exactly at a small cap, and one byte past it.
  const nine = Buffer.alloc(9, 7).toString('base64');             // 12 characters, no padding
  assert.equal(images.parseDataUrl('data:image/png;base64,' + nine, 9).bytes.length, 9);
  assert.deepEqual(images.parseDataUrl('data:image/png;base64,' + Buffer.alloc(10, 7).toString('base64'), 9), { tooLarge: true });
  // The real cap, 25 MB: just past it is refused without a 25 MB Buffer being made.
  const cap = images.IMAGE_MAX_BYTES;
  assert.equal(cap, 25 * 1024 * 1024);
  const over = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((cap + 3) / 3) * 4);
  assert.deepEqual(images.parseDataUrl(over), { tooLarge: true });
});

// ---------------------------------------------------------------------------
// what the bytes say a picture is
// ---------------------------------------------------------------------------

test('every format is recognised from its real first bytes', () => {
  for (const [type, bytes] of Object.entries(MAGIC)) {
    assert.equal(images.sniffImageType(bytes), type, type);
    // A Uint8Array view, the way bytes cross IPC, reads the same.
    assert.equal(images.sniffImageType(new Uint8Array(bytes)), type, type + ' as Uint8Array');
  }
  // Little-endian TIFF, and HEIF whose major brand is the generic mif1.
  assert.equal(images.sniffImageType(hex('49492a0008000000')), 'image/tiff');
  assert.equal(images.sniffImageType(hex('0000001c667479706d69663100000000' + '6d696631' + '68656963' + '00000000')), 'image/heic');
  // AVIF sometimes leads with mif1 and names avif among the compatible brands.
  assert.equal(images.sniffImageType(hex('0000001c667479706d69663100000000' + '6d696631' + '61766966' + '6d696166')), 'image/avif');
  assert.equal(images.sniffImageType(hex('00000018667479706176697300000000' + '61766973' + '6d696631')), 'image/avif');
});

test('a header is never taken for a picture it is not', () => {
  const text = s => Buffer.from(s, 'latin1');
  assert.equal(images.sniffImageType(text('<!doctype html><html><body>Forbidden</body></html>')), null);
  assert.equal(images.sniffImageType(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(images.sniffImageType(text('BMW 330i, low mileage, one owner')), null, 'BM alone is not a bitmap');
  assert.equal(images.sniffImageType(hex('0000001c6674797069736f6d0000020069736f6d69736f32')), null, 'an MP4 is ftyp too');
  assert.equal(images.sniffImageType(hex('89504e47')), null, 'half a PNG signature');
  assert.equal(images.sniffImageType(text('RIFF\x24\x00\x00\x00WAVEfmt ')), null, 'RIFF but a WAV');
  assert.equal(images.sniffImageType(Buffer.alloc(0)), null);
  assert.equal(images.sniffImageType(null), null);
  assert.equal(images.sniffImageType('GIF89a'), null, 'a string is not bytes');
});

test('every type fetchImage answers is one saveImage keeps', async () => {
  // Whatever it is handed it answers PNG, JPEG or WebP, or nothing — never a type
  // saveImage() would then refuse. (MAGIC's convertible ones are no whole picture, so
  // sips refuses those; WHOLE's convert.)
  for (const [claimed, bytes] of [...Object.entries(MAGIC), ...Object.entries(WHOLE)]) {
    const fetched = await images.fetchImage(`data:${claimed};base64,${bytes.toString('base64')}`);
    if (fetched.ok) assert.ok(diagrams.IMAGE_TYPES[fetched.type], `${claimed} came back as ${fetched.type}`);
  }
});

test('fetchImage takes a data: picture for what its bytes are, not what it claims', async () => {
  const png = await images.fetchImage('data:image/jpeg;base64,' + PNG_1PX);
  assert.equal(png.ok, true);
  assert.equal(png.type, 'image/png');
  assert.equal(png.name, 'Image');
  assert.ok(png.bytes instanceof Uint8Array);
  assert.deepEqual(Buffer.from(png.bytes), Buffer.from(PNG_1PX, 'base64'));
  // The same inside Google's wrapper, which is never fetched itself.
  const wrapped = await images.fetchImage('https://www.google.com/imgres?imgurl=' + encodeURIComponent('data:image/png;base64,' + PNG_1PX));
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.type, 'image/png');
});

test('fetchImage refuses a data: URL that is no picture, or too big a one', async () => {
  const page = Buffer.from('<!doctype html><title>Forbidden</title>').toString('base64');
  assert.deepEqual(await images.fetchImage('data:image/png;base64,' + page), { ok: false, error: "That picture's format can't be used here" });
  assert.deepEqual(await images.fetchImage("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"), { ok: false, error: "That picture's format can't be used here" });
  const over = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((images.IMAGE_MAX_BYTES + 3) / 3) * 4);
  assert.deepEqual(await images.fetchImage(over), { ok: false, error: 'That image is over 25 MB' });
  assert.deepEqual(await images.fetchImage('javascript:alert(1)'), { ok: false, error: "That isn't the address of a picture" });
});

test('on macOS every other format comes back a PNG, through sips in its sandbox', { skip: MAC_ONLY }, async () => {
  ran.length = 0;
  for (const [type, bytes] of Object.entries(WHOLE)) {
    const fetched = await images.fetchImage(`data:${type};base64,${bytes.toString('base64')}`);
    assert.equal(fetched.ok, true, `${type}: ${fetched.error}`);
    assert.equal(fetched.type, 'image/png', type);
    assert.equal(images.sniffImageType(fetched.bytes), 'image/png', type);
  }
  const sips = ran.filter(command => command.includes('/usr/bin/sips'));
  assert.equal(sips.length, Object.keys(WHOLE).length);
  for (const command of sips) assert.deepEqual(command.slice(0, 3), ['/usr/bin/sandbox-exec', '-p', images.SIPS_PROFILE]);
});

test('sips runs in a sandbox that denies everything it is not given', () => {
  const profile = images.SIPS_PROFILE;
  assert.match(profile, /^\(version 1\)\(deny default\)/);
  assert.doesNotMatch(profile, /network/, 'no network');
  assert.doesNotMatch(profile, /\(allow mach-lookup\)/, 'no service but the one named');
  assert.doesNotMatch(profile, /\(allow process-exec\*?\)/, 'no program but sips');
  assert.doesNotMatch(profile, /\(allow file-write\*\)/, 'writes only in the folders it is given');
});

test('on macOS that sandbox runs sips and no other program', { skip: MAC_ONLY }, () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const fs = require('node:fs');
  const dir = fs.realpathSync(os.tmpdir());
  const run = (...command) => spawnSync('/usr/bin/sandbox-exec', ['-p', images.SIPS_PROFILE, '-D', 'WORK=' + dir, '-D', 'TEMP=' + dir, ...command]);
  assert.equal(run('/usr/bin/sips', '--version').status, 0);
  assert.notEqual(run('/usr/bin/curl', '--version').status, 0);
});

// ---------------------------------------------------------------------------
// a picture's label, and its Referer
// ---------------------------------------------------------------------------

test("a picture's name is the last part of its path, or Image", () => {
  assert.equal(images.imageName('https://cdn.example.test/photos/golden-retriever.jpg?w=800#top'), 'golden-retriever.jpg');
  assert.equal(images.imageName('https://cdn.example.test/photos/sunset%20over%20water.png'), 'sunset over water.png');
  assert.equal(images.imageName('https://cdn.example.test/photos/dog/'), 'dog');
  assert.equal(images.imageName('https://cdn.example.test/before%2Fafter%3A.webp'), 'before after .webp', 'no path separators survive');
  assert.equal(images.imageName('https://cdn.example.test/%E0%A4%A.jpg'), '%E0%A4%A.jpg', 'a bad escape is kept as written');
  assert.equal(images.imageName('https://cdn.example.test/'), 'Image');
  assert.equal(images.imageName('https://cdn.example.test/---/'), 'Image');
  assert.equal(images.imageName('data:image/png;base64,' + PNG_1PX), 'Image');
  // Google's own grid thumbnails, whose path says only "images".
  assert.equal(images.imageName('https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQabc&s'), 'Image');
  assert.equal(images.imageName('https://encrypted-tbn3.gstatic.com/images?q=tbn:ANd9GcQxyz&usqp=CAU'), 'Image');
  assert.equal(images.imageName('not a url'), 'Image');
  assert.equal(images.imageName(undefined), 'Image');
  const long = images.imageName('https://cdn.example.test/' + 'a'.repeat(200) + '.jpeg');
  assert.equal(long.length, 60);
  assert.ok(long.endsWith('.jpeg'), 'a long name keeps its extension');
});

test('the Referer is what a browser would send', () => {
  const page = 'https://www.google.com/search?udm=2&q=dogs#frag';
  assert.equal(images.refererFor('https://cdn.example.test/dog.jpg', page), 'https://www.google.com/');
  assert.equal(images.refererFor('https://www.google.com/logo.png', page), 'https://www.google.com/search?udm=2&q=dogs');
  assert.equal(images.refererFor('http://cdn.example.test/dog.jpg', page), '', 'never from https down to http');
  assert.equal(images.refererFor('https://cdn.example.test/dog.jpg', ''), '');
  assert.equal(images.refererFor('https://cdn.example.test/dog.jpg', 'about:blank'), '');
});

// ---------------------------------------------------------------------------
// the right-click menu
// ---------------------------------------------------------------------------

const labels = items => items.map(i => (i.type === 'separator' ? '—' : i.label));
const NAV = ['Back', 'Forward', 'Reload'];

test('an image result offers Add Image to Diagram first, then its link, then the page', () => {
  const items = images.contextMenuItems({
    mediaType: 'image',
    hasImageContents: true,
    srcURL: 'data:image/jpeg;base64,' + MAGIC['image/jpeg'].toString('base64'),
    linkURL: 'https://www.google.com/imgres?imgurl=x',
    editFlags: {},
  }, { canGoBack: true, canGoForward: false });
  assert.deepEqual(labels(items), [
    'Add Image to Diagram', 'Copy Image', 'Copy Image Address', 'Open Image in Browser', '—',
    'Open Link in Browser', 'Copy Link Address', '—',
    ...NAV,
  ]);
  const byLabel = Object.fromEntries(items.filter(i => i.label).map(i => [i.label, i]));
  assert.equal(byLabel['Add Image to Diagram'].enabled, true);
  assert.equal(byLabel['Open Image in Browser'].enabled, false, 'a data: thumbnail cannot go to the browser');
  assert.equal(byLabel.Back.enabled, true);
  assert.equal(byLabel.Forward.enabled, false);
});

test('a picture the app cannot fetch cannot be added', () => {
  const items = images.contextMenuItems({ mediaType: 'image', srcURL: 'blob:https://www.google.com/1234' }, {});
  assert.equal(items.find(i => i.id === 'addImage').enabled, false);
  const web = images.contextMenuItems({ mediaType: 'image', srcURL: 'https://cdn.example.test/dog.jpg' }, {});
  assert.equal(web.find(i => i.id === 'addImage').enabled, true);
  assert.equal(web.find(i => i.id === 'openImage').enabled, true);
});

test('a field gets Cut, Copy, Paste and Select All as the page allows them', () => {
  const items = images.contextMenuItems({
    isEditable: true,
    selectionText: 'golden',
    editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true },
  }, {});
  assert.deepEqual(labels(items), ['Cut', 'Copy', 'Paste', 'Select All', '—', ...NAV]);
  assert.equal(items[0].enabled, false);
  assert.equal(items[2].enabled, true);
});

test('a selection gets Copy; a bare page, a javascript: link or a blank selection only the page', () => {
  assert.deepEqual(labels(images.contextMenuItems({ selectionText: 'retrievers', editFlags: {} }, {})), ['Copy', '—', ...NAV]);
  assert.deepEqual(labels(images.contextMenuItems({ selectionText: '   ' }, {})), NAV);
  assert.deepEqual(labels(images.contextMenuItems({ linkURL: 'javascript:void(0)' }, {})), NAV);
  assert.deepEqual(labels(images.contextMenuItems({}, {})), NAV);
  assert.deepEqual(labels(images.contextMenuItems(undefined, undefined)), NAV);
});

// A Google result's link, as a right-click or a drag on one carries it: its thumbnail
// is the picture, and the full picture is inside the link.
const RESULT = 'https://www.google.com/imgres?q=lighthouse&imgurl=https%3A%2F%2Fphotos.example.test%2Fbig%2Flighthouse.jpg&imgrefurl=https%3A%2F%2Fphotos.example.test%2Fcoast%2F&docid=x1';
const THUMB = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcExample&s';

test("a Google result's link leads to its full picture, and says what page that is on", () => {
  assert.equal(images.googleOriginal(RESULT), RESULT);
  assert.equal(images.unwrapImageUrl(images.googleOriginal(RESULT)), 'https://photos.example.test/big/lighthouse.jpg');
  assert.equal(images.sourcePageOf(RESULT), 'https://photos.example.test/coast/');
  // Not a result: another host, another path, a picture that is no web address, no picture.
  assert.equal(images.googleOriginal('https://www.google.com.evil.test/imgres?imgurl=https%3A%2F%2Fa.test%2Fb.jpg'), '');
  assert.equal(images.googleOriginal('https://www.google.com/search?imgurl=https%3A%2F%2Fa.test%2Fb.jpg'), '');
  assert.equal(images.googleOriginal('https://www.google.com/imgres?imgurl=javascript%3Aalert(1)'), '');
  assert.equal(images.googleOriginal('https://www.google.com/imgres?q=x'), '');
  assert.equal(images.googleOriginal(''), '');
  assert.equal(images.sourcePageOf('https://www.google.com/imgres?imgurl=https%3A%2F%2Fa.test%2Fb.jpg&imgrefurl=file%3A%2F%2F%2Fetc'), '');
  assert.equal(images.sourcePageOf('https://photos.example.test/coast/'), '');
});

test('Add Image to Diagram on a result offers the full picture, then its thumbnail', () => {
  const page = 'https://www.google.com/search?udm=2&q=lighthouse';
  assert.deepEqual(images.imageOffer(7, { srcURL: THUMB, linkURL: RESULT, pageURL: page, frameURL: page }), {
    guestId: 7, url: RESULT, fallback: THUMB, referrer: page,
  });
  // A picture in no result is offered as it is, with nothing to fall back on.
  assert.deepEqual(images.imageOffer(7, { srcURL: 'https://photos.example.test/a.png', linkURL: '', pageURL: page }), {
    guestId: 7, url: 'https://photos.example.test/a.png', fallback: '', referrer: page,
  });
  // A thumbnail the app can't fetch (blob:) is no fallback, but the full picture still is.
  const blob = images.imageOffer(7, { srcURL: 'blob:https://www.google.com/1234', linkURL: RESULT, pageURL: page });
  assert.equal(blob.url, RESULT);
  assert.equal(blob.fallback, '');
  assert.equal(images.contextMenuItems({ mediaType: 'image', srcURL: 'blob:https://www.google.com/1234', linkURL: RESULT }, {})
    .find(i => i.id === 'addImage').enabled, true);
});

// ---------------------------------------------------------------------------
// fetchImage's downloads, from 127.0.0.1
// ---------------------------------------------------------------------------

const seen = {};
const closed = {};
const server = http.createServer((req, res) => {
  seen[req.url] = { referer: req.headers.referer || null };
  req.socket.on('close', () => { closed[req.url] = true; });
  if (req.url === '/forbidden') {
    // A hotlink guard's error page that never ends.
    res.writeHead(403, { 'content-type': 'text/html' });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const timer = setInterval(() => res.write(chunk), 5);
    req.socket.on('close', () => clearInterval(timer));
    return;
  }
  if (req.url === '/photo?id=7') {
    res.writeHead(302, { location: '/photos/red-panda.png' });
    return res.end();
  }
  if (req.url === '/photos/red-panda.png' || req.url === '/plain.png') {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(Buffer.from(PNG_1PX, 'base64'));
  }
  if (req.url === '/photos/party.gif') {
    res.writeHead(200, { 'content-type': 'image/gif' });
    return res.end(WHOLE['image/gif']);
  }
  res.writeHead(404);
  res.end();
});
const listening = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = async () => { await listening; return `http://127.0.0.1:${server.address().port}`; };
after(() => { server.closeAllConnections(); server.close(); });

test('an error page is refused, and the download cut off rather than left streaming in', async () => {
  const url = (await base()) + '/forbidden';
  assert.deepEqual(await images.fetchImage(url), { ok: false, error: "That picture couldn't be downloaded (HTTP 403)" });
  for (let i = 0; i < 40 && !closed['/forbidden']; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(closed['/forbidden'], true, 'the connection is closed');
});

test('a picture is named for where it ended up, past a redirect, when the session says', async () => {
  // Node's fetch says; Electron 44's does not yet, so there the name is the address asked for.
  const fetched = await images.fetchImage((await base()) + '/photo?id=7');
  assert.equal(fetched.ok, true);
  assert.equal(fetched.name, 'red-panda.png');
});

test('the Referer goes out only with the page the picture was on', async () => {
  const origin = await base();
  // Add Image to Diagram knows the page; same origin, so all of it.
  assert.equal((await images.fetchImage(origin + '/plain.png', origin + '/results?q=red+panda#top')).ok, true);
  assert.equal(seen['/plain.png'].referer, origin + '/results?q=red+panda');
  // A drop does not, and sends none.
  assert.equal((await images.fetchImage(origin + '/plain.png')).ok, true);
  assert.equal(seen['/plain.png'].referer, null);
});

test("a Google result's full picture goes out with its own page as the Referer", async () => {
  const origin = await base();
  const result = 'https://www.google.com/imgres?q=red+panda&imgurl=' + encodeURIComponent(origin + '/photos/red-panda.png') +
    '&imgrefurl=' + encodeURIComponent(origin + '/gallery/pandas?page=2');
  const fetched = await images.fetchImage(result, 'https://www.google.com/search?udm=2&q=red+panda');
  assert.equal(fetched.ok, true);
  assert.equal(seen['/photos/red-panda.png'].referer, origin + '/gallery/pandas?page=2', 'the picture\'s own page, not the results');
});

test('on macOS a GIF comes back a PNG, and its name says so', { skip: MAC_ONLY }, async () => {
  const fetched = await images.fetchImage((await base()) + '/photos/party.gif');
  assert.equal(fetched.ok, true, fetched.error);
  assert.equal(fetched.type, 'image/png');
  assert.equal(fetched.name, 'party.png');
});
