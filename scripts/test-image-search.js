'use strict';

// npm run test:diagrams — the Google Images panel's pure half
// (src/diagrams/lib/diagrams/image-search.ts): the page it opens at, the words a page
// is searching for, and which picture's address a drag out of it carries onto the
// canvas. The module is TypeScript with no dependencies, so it is bundled here with
// esbuild, as test-flow-layout.js bundles flow-editor.ts, and required as CommonJS.
// Where it repeats one of main's rules (src/main/images.js), it is checked against
// main's own.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const esbuild = require('esbuild');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-image-search-'));
const outfile = path.join(temp, 'image-search.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', 'image-search.ts')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'error',
});
const {
  GOOGLE_IMAGES_PARTITION,
  GOOGLE_IMAGES_HOME,
  googleImagesUrl,
  queryFromUrl,
  opensInPanel,
  isUrlDrag,
  imageUrlFromDrop,
  imageUrlsFromDrop,
} = require(outfile);
const images = require('../src/main/images');

after(() => fs.rmSync(temp, { recursive: true, force: true }));

const SEARCH = 'https://www.google.com/search?udm=2&q=';

test('the partition is the one main lets a webview attach in', () => {
  assert.equal(GOOGLE_IMAGES_PARTITION, images.PARTITION);
  assert.equal(GOOGLE_IMAGES_PARTITION, 'persist:sb-images');
  assert.equal(GOOGLE_IMAGES_HOME, 'https://www.google.com/imghp');
  assert.ok(images.hardenWebview({}, { partition: GOOGLE_IMAGES_PARTITION, src: GOOGLE_IMAGES_HOME }), 'main lets the home page attach');
});

test('googleImagesUrl searches the Images tab for the words', () => {
  assert.equal(googleImagesUrl('red panda'), `${SEARCH}red%20panda`);
});

test('googleImagesUrl encodes what would break the query string', () => {
  assert.equal(googleImagesUrl('C++ & café?'), `${SEARCH}C%2B%2B%20%26%20caf%C3%A9%3F`);
  assert.equal(googleImagesUrl('a=b#c/d'), `${SEARCH}a%3Db%23c%2Fd`);
});

test('googleImagesUrl folds a label over several lines into one line of words', () => {
  assert.equal(googleImagesUrl('  Payment\n  service\t '), `${SEARCH}Payment%20service`);
});

test('googleImagesUrl with nothing to search for is the Images home page', () => {
  assert.equal(googleImagesUrl(''), GOOGLE_IMAGES_HOME);
  assert.equal(googleImagesUrl('   '), GOOGLE_IMAGES_HOME);
  assert.equal(googleImagesUrl('\n\t \n'), GOOGLE_IMAGES_HOME);
});

test('queryFromUrl reads back what googleImagesUrl searched for', () => {
  for (const words of ['red panda', 'C++ & café?', 'a=b#c/d']) {
    assert.equal(queryFromUrl(googleImagesUrl(words)), words);
  }
});

test('queryFromUrl reads a search Google itself made, on any of its search hosts', () => {
  assert.equal(queryFromUrl('https://www.google.com/search?q=red+panda&udm=2&sa=X&ved=0'), 'red panda');
  assert.equal(queryFromUrl('https://images.google.com/search?q=otter'), 'otter');
  assert.equal(queryFromUrl('https://google.com/search?q=otter'), 'otter');
  assert.equal(queryFromUrl('https://www.google.com/search?q='), '');
});

test('queryFromUrl is null for every page that is not a Google search', () => {
  assert.equal(queryFromUrl(GOOGLE_IMAGES_HOME), null);
  assert.equal(queryFromUrl('https://www.google.com/search?udm=2'), null);
  assert.equal(queryFromUrl('https://www.google.com/imgres?imgurl=https://example.com/a.png&q=x'), null);
  assert.equal(queryFromUrl('https://example.com/search?q=red+panda'), null);
  assert.equal(queryFromUrl('https://www.google.com.example.com/search?q=x'), null);
  assert.equal(queryFromUrl('ftp://www.google.com/search?q=x'), null);
  assert.equal(queryFromUrl('not a url'), null);
  assert.equal(queryFromUrl(''), null);
});

test('opensInPanel is main\'s attach rule: https on www.google.com or images.google.com', () => {
  assert.equal(opensInPanel(googleImagesUrl('otter')), true);
  assert.equal(opensInPanel(GOOGLE_IMAGES_HOME), true);
  assert.equal(opensInPanel('https://images.google.com/'), true);
  assert.equal(opensInPanel('http://www.google.com/imghp'), false);
  assert.equal(opensInPanel('https://google.com/imghp'), false);
  assert.equal(opensInPanel('https://www.google.com:8443/imghp'), false);
  assert.equal(opensInPanel('https://someone@www.google.com/imghp'), false);
  assert.equal(opensInPanel('https://example.com/otters'), false);
  assert.equal(opensInPanel('nonsense'), false);
});

test('opensInPanel and main\'s isGoogleImagesSrc agree on every address', () => {
  for (const url of [
    googleImagesUrl('otter'),
    GOOGLE_IMAGES_HOME,
    'https://images.google.com/',
    'HTTPS://WWW.GOOGLE.COM/imghp',
    'https://www.google.com:443/imghp',
    'http://www.google.com/imghp',
    'https://google.com/imghp',
    'https://www.google.co.uk/imghp',
    'https://www.google.com.evil.test/imghp',
    'https://www.google.com./',
    'https://www.google.com:8443/imghp',
    'https://someone@www.google.com/imghp',
    'https://user:secret@www.google.com/',
    'https://www.google.com@evil.test/',
    'https://evil.test/#www.google.com',
    'https://example.com/otters',
    'javascript:alert(1)',
    'about:blank',
    'nonsense',
    '',
  ]) assert.equal(opensInPanel(url), images.isGoogleImagesSrc(url), url);
});

test('isUrlDrag is any drag carrying an address, markup or text, and nothing else', () => {
  assert.equal(isUrlDrag(['text/uri-list', 'text/html', 'text/plain']), true);
  assert.equal(isUrlDrag(['text/html']), true);
  assert.equal(isUrlDrag(['text/plain']), true);
  assert.equal(isUrlDrag(['Files']), false);
  assert.equal(isUrlDrag(['application/x-flow-shape']), false);
  assert.equal(isUrlDrag([]), false);
});

test('imageUrlFromDrop takes the picture, not the link round it', () => {
  // As Chromium writes a Google result dragged out: the <img> as markup, and the
  // link it sits in as the address.
  const html = '<a href="https://www.google.com/imgres?imgurl=https://example.com/full.jpg">'
    + '<img class="YQ4gaf" src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9Gc&amp;s=10" alt="A red panda"></a>';
  const uriList = 'https://www.google.com/imgres?imgurl=https://example.com/full.jpg';
  assert.equal(
    imageUrlFromDrop({ uriList, html, plain: uriList }),
    'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9Gc&s=10',
  );
});

test('imageUrlFromDrop reads src by attribute, whatever the quoting', () => {
  assert.equal(imageUrlFromDrop({ html: "<img src='https://example.com/a.png'>" }), 'https://example.com/a.png');
  assert.equal(imageUrlFromDrop({ html: '<IMG SRC=https://example.com/a.png?w=1&amp;h=2 />' }), 'https://example.com/a.png?w=1&h=2');
  assert.equal(
    imageUrlFromDrop({ html: '<img data-src="https://example.com/lazy.png" alt="src=https://example.com/alt.png" src="https://example.com/real.png">' }),
    'https://example.com/real.png',
  );
  assert.equal(
    imageUrlFromDrop({ html: '<img alt="a > b" src="https://example.com/after.png">' }),
    'https://example.com/after.png',
  );
});

test('imageUrlFromDrop takes a data: picture as it is', () => {
  const data = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQ==';
  assert.equal(imageUrlFromDrop({ html: `<img src="${data}">`, uriList: 'https://example.com/' }), data);
  assert.equal(imageUrlFromDrop({ uriList: data }), data);
  assert.equal(imageUrlFromDrop({ plain: ` ${data}\n` }), data);
  assert.equal(imageUrlFromDrop({ plain: 'data:text/html;base64,PHNjcmlwdD4=' }), null);
});

test('imageUrlFromDrop takes the first address in a URI list, past its comments', () => {
  assert.equal(
    imageUrlFromDrop({ uriList: '# dragged from a page\r\n\r\nhttps://example.com/one.png\r\nhttps://example.com/two.png' }),
    'https://example.com/one.png',
  );
  assert.equal(imageUrlFromDrop({ uriList: '# only a comment' }), null);
});

test('imageUrlFromDrop falls back from the markup to the list, then to plain text', () => {
  assert.equal(
    imageUrlFromDrop({ html: '<p>no picture here</p>', uriList: 'https://example.com/listed.png', plain: 'https://example.com/plain.png' }),
    'https://example.com/listed.png',
  );
  assert.equal(
    imageUrlFromDrop({ html: '<img src="/relative.png">', uriList: 'javascript:alert(1)', plain: 'https://example.com/plain.png' }),
    'https://example.com/plain.png',
  );
  assert.equal(imageUrlFromDrop({ plain: '  https://example.com/a.png  ' }), 'https://example.com/a.png');
});

test('imageUrlFromDrop refuses javascript:, file: and anything else that is not http(s)', () => {
  assert.equal(imageUrlFromDrop({ html: '<img src="javascript:alert(1)">' }), null);
  assert.equal(imageUrlFromDrop({ uriList: 'JavaScript:alert(1)' }), null);
  assert.equal(imageUrlFromDrop({ uriList: 'file:///Users/someone/picture.png' }), null);
  assert.equal(imageUrlFromDrop({ plain: 'file:///etc/hosts' }), null);
  assert.equal(imageUrlFromDrop({ plain: 'ftp://example.com/a.png' }), null);
  assert.equal(imageUrlFromDrop({ html: '<img src="blob:https://example.com/0b7c">' }), null);
});

test('imageUrlFromDrop refuses an address that is not absolute', () => {
  assert.equal(imageUrlFromDrop({ html: '<img src="/images/a.png">' }), null);
  assert.equal(imageUrlFromDrop({ html: '<img src="a.png">' }), null);
  assert.equal(imageUrlFromDrop({ html: '<img src="//cdn.example.com/a.png">' }), null);
  assert.equal(imageUrlFromDrop({ uriList: 'images/a.png' }), null);
});

test('imageUrlFromDrop refuses words that merely start with an address', () => {
  assert.equal(imageUrlFromDrop({ plain: 'https://example.com/a.png is a nice one' }), null);
  assert.equal(imageUrlFromDrop({ plain: 'a red panda' }), null);
});

// A lazy loader's placeholder: the src a 1px GIF or an empty SVG, the picture the
// srcset's — and Chromium writes the srcset as the page did, relative or not.
const GIF_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const SVG_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='600'%3E%3C/svg%3E";

test('imageUrlFromDrop takes the srcset\'s choice over a placeholder src, out of a link', () => {
  for (const placeholder of [GIF_PLACEHOLDER, SVG_PLACEHOLDER]) {
    // Relative, as most pages write it: the list's address is the only absolute one.
    assert.equal(
      imageUrlFromDrop({
        html: `<img src="${placeholder}" srcset="/photo-400.jpg 400w, /photo-800.jpg 800w" alt="A red panda">`,
        uriList: 'https://site.example/photo-800.jpg',
        plain: 'https://site.example/photo-800.jpg',
      }),
      'https://site.example/photo-800.jpg',
      placeholder,
    );
    // Absolute: the list's address is the one Chromium chose, so that one.
    assert.equal(
      imageUrlFromDrop({
        html: `<img src="${placeholder}" srcset="https://cdn.example/w_400,h_300/photo.jpg 400w, https://cdn.example/w_800,h_600/photo.jpg 800w">`,
        uriList: 'https://cdn.example/w_400,h_300/photo.jpg',
      }),
      'https://cdn.example/w_400,h_300/photo.jpg',
      placeholder,
    );
  }
});

test('imageUrlFromDrop takes the srcset\'s largest absolute choice for a placeholder in a link', () => {
  for (const placeholder of [GIF_PLACEHOLDER, SVG_PLACEHOLDER]) {
    // In a link the list is the link's page, never the picture.
    assert.equal(
      imageUrlFromDrop({
        html: `<img src="${placeholder}" srcset="https://cdn.example/photo-400.jpg 400w,https://cdn.example/photo-1600.jpg 1600w, https://cdn.example/photo-800.jpg 800w">`,
        uriList: 'https://site.example/article',
        plain: 'https://site.example/article',
      }),
      'https://cdn.example/photo-1600.jpg',
      placeholder,
    );
    assert.equal(
      imageUrlFromDrop({
        html: `<img src="${placeholder}" srcset="https://cdn.example/photo.jpg, https://cdn.example/photo@2x.jpg 2x">`,
        uriList: 'https://site.example/article',
      }),
      'https://cdn.example/photo@2x.jpg',
      placeholder,
    );
  }
});

test('imageUrlFromDrop keeps a data: src with no srcset: Google\'s thumbnails are those', () => {
  const thumbnail = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQ==';
  const html = `<img src="${thumbnail}" data-src="https://example.com/lazy.jpg" alt="A red panda">`;
  assert.equal(imageUrlFromDrop({ html, uriList: 'https://www.google.com/imgres?imgurl=https://example.com/full.jpg' }), thumbnail);
  // A src that is no placeholder wins over its srcset as before.
  assert.equal(
    imageUrlFromDrop({ html: '<img src="https://example.com/a.png" srcset="https://example.com/a@2x.png 2x">' }),
    'https://example.com/a.png',
  );
});

test('imageUrlFromDrop reads hostile markup in time that grows with its length, not its square', () => {
  // A page writes its own drag's text/html: runs of "<img" that never close, every
  // way round. Each was minutes of a frozen window before; now all are moments.
  const started = Date.now();
  for (const run of ['<img ', '<img "', "<img '", '<img a="<img "']) {
    assert.equal(imageUrlFromDrop({ html: run.repeat(100000), uriList: 'https://example.com/a.png' }), 'https://example.com/a.png', run);
  }
  // And a placeholder's srcset of nothing but separators, one endless address, or
  // tens of thousands of candidates.
  for (const [piece, expected] of [
    [',', 'https://example.com/b.png'],
    [' ,', 'https://example.com/b.png'],
    ['w_1,', 'https://example.com/b.png'],
    ['https://a.example/x ,', 'https://a.example/x'],
  ]) {
    const html = `<img src="${GIF_PLACEHOLDER}" srcset="${piece.repeat(40000)}">`;
    assert.equal(imageUrlFromDrop({ html, uriList: 'https://example.com/b.png' }), expected, piece);
  }
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test('imageUrlFromDrop with nothing in the drop is null', () => {
  assert.equal(imageUrlFromDrop({}), null);
  assert.equal(imageUrlFromDrop({ uriList: '', html: '', plain: '' }), null);
  assert.equal(imageUrlFromDrop({ html: '<img>', plain: '   ' }), null);
  assert.equal(imageUrlFromDrop({ html: '<img src="">' }), null);
});

test('imageUrlFromDrop hands back http(s) addresses as the URL parser writes them', () => {
  assert.equal(imageUrlFromDrop({ uriList: 'HTTPS://Example.COM/a.png' }), 'https://example.com/a.png');
});

// A drag out of Google's results, as Chromium hands it over (measured on Google's page
// in this Electron): the result's link as the address, its thumbnail as the markup.
const RESULT = 'https://www.google.com/imgres?q=lighthouse&imgurl=https%3A%2F%2Fphotos.example.test%2Fbig%2Flighthouse.jpg&imgrefurl=https%3A%2F%2Fphotos.example.test%2Fcoast%2F&docid=x1';
const THUMB = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcExample&s';

test("imageUrlsFromDrop tries a Google result's full picture first, then its thumbnail", () => {
  const html = `<img alt="A lighthouse" id="dimg_1" src="${THUMB.replace(/&/g, '&amp;')}" data-csiid="x">`;
  assert.deepEqual(imageUrlsFromDrop({ uriList: RESULT, html, plain: RESULT }), [RESULT, THUMB]);
  // main reads the same link the same way
  assert.equal(images.googleOriginal(RESULT), RESULT);
});

test('imageUrlsFromDrop is imageUrlFromDrop alone for anything but a Google result', () => {
  const html = '<a href="https://photos.example.test/coast/"><img src="https://photos.example.test/a.jpg"></a>';
  const uriList = 'https://photos.example.test/coast/';
  assert.deepEqual(imageUrlsFromDrop({ uriList, html }), ['https://photos.example.test/a.jpg']);
  assert.deepEqual(imageUrlsFromDrop({ uriList: 'https://photos.example.test/a.jpg' }), ['https://photos.example.test/a.jpg']);
  // A lookalike host, or a link whose "picture" is no web address, is no result.
  const fake = 'https://www.google.com.evil.test/imgres?imgurl=https%3A%2F%2Fa.test%2Fb.jpg';
  assert.deepEqual(imageUrlsFromDrop({ uriList: fake }), [new URL(fake).href]);
  const script = 'https://www.google.com/imgres?imgurl=javascript%3Aalert(1)';
  assert.deepEqual(imageUrlsFromDrop({ uriList: script, html: `<img src="${THUMB}">` }), [THUMB]);
  assert.deepEqual(imageUrlsFromDrop({}), []);
});

test('imageUrlsFromDrop never lists one address twice', () => {
  assert.deepEqual(imageUrlsFromDrop({ uriList: RESULT, plain: RESULT }), [RESULT])
});
