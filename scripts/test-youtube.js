'use strict';

// npm run test:diagrams — how a whiteboard reads a YouTube link
// (src/diagrams/lib/diagrams/youtube.ts): which text IS a video, and only that one, so
// a link in a sentence stays words; the id and start it gives; what a drop carries;
// and the poster, player and watch addresses built back from a video. The module is
// TypeScript with no dependencies, so it is bundled here with esbuild, as
// test-image-search.js bundles image-search.ts, and required as CommonJS.
//
// Every video id, channel, playlist and title here is made up (AGENTS.md): 11
// characters of the alphabet a real id is made of, and nothing YouTube has issued.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const esbuild = require('esbuild');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-youtube-'));
const outfile = path.join(temp, 'youtube.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'diagrams', 'lib', 'diagrams', 'youtube.ts')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'error',
});
const {
  isYouTubeVideoId,
  youTubeVideoFromText,
  youTubeVideoFromDrop,
  parseYouTubeTime,
  youTubeEmbedUrl,
  youTubeThumbnailUrl,
  youTubeWatchUrl,
} = require(outfile);

after(() => fs.rmSync(temp, { recursive: true, force: true }));

const A = 'exampleVid1';
const B = 'exampleVid2';
const SHORT = 'exampleShrt';
const LIVE = 'exampleLive';
const LIST = 'PLexampleList-000000000000000000';
const v = (videoId, extra = {}) => ({ videoId, ...extra });

// [text, the video it is] — null: not a video, and the text stays text.
const TABLE = [
  // Every form a link to one video comes in.
  [`https://www.youtube.com/watch?v=${A}`, v(A)],
  [`https://youtube.com/watch?v=${A}`, v(A)],
  [`https://m.youtube.com/watch?v=${A}`, v(A)],
  [`https://music.youtube.com/watch?v=${A}&list=RDAMVM${A}`, v(A)],
  [`https://gaming.youtube.com/watch?v=${A}`, v(A)],
  [`http://www.youtube.com/watch?v=${A}`, v(A)],
  [`www.youtube.com/watch?v=${A}`, v(A)],
  [`youtube.com/watch?v=${A}`, v(A)],
  [`//www.youtube.com/watch?v=${A}`, v(A)],
  [`HTTPS://WWW.YOUTUBE.COM/watch?v=${A}`, v(A)],
  [`https://www.youtube.com/watch?app=desktop&feature=share&v=${A}`, v(A)],
  [`https://www.youtube.com/watch?v=${A}&pp=exampleSearchToken`, v(A)],
  [`https://youtu.be/${A}`, v(A)],
  [`https://youtu.be/${A}?si=Example_Share1`, v(A)],
  [`youtu.be/${A}/`, v(A)],
  [`https://www.youtube.com/shorts/${SHORT}?feature=share`, v(SHORT, { short: true })],
  [`youtube.com/shorts/${SHORT}`, v(SHORT, { short: true })],
  [`https://www.youtube.com/live/${LIVE}?si=example`, v(LIVE)],
  [`https://www.youtube.com/embed/${A}?start=42&rel=0`, v(A, { start: 42 })],
  [`https://www.youtube-nocookie.com/embed/${A}`, v(A)],
  [`https://youtube-nocookie.com/embed/${A}`, v(A)],
  [`https://www.youtube.com/v/${A}?version=3`, v(A)],
  [`http://www.youtube.com/v/${A}&hl=en_US&fs=1&`, v(A)],
  [`https://www.youtube.com/e/${A}`, v(A)],
  [`https://www.youtube.com/watch/${A}`, v(A)],
  // Wrappers round one: YouTube's own, its cookie consent page, Google's outbound links.
  [`https://www.youtube.com/attribution_link?a=example&u=%2Fwatch%3Fv%3D${A}%26feature%3Dshare`, v(A)],
  [`https://www.google.com/url?sa=t&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${A}&ved=example`, v(A)],
  [`https://www.google.co.uk/url?q=https://youtu.be/${A}%3Ft%3D30&sa=U`, v(A, { start: 30 })],
  [`https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${A}%26cbrd%3D1&gl=DE`, v(A)],
  // Where it starts.
  [`https://youtu.be/${A}?t=90`, v(A, { start: 90 })],
  [`https://youtu.be/${A}?si=example&t=90s`, v(A, { start: 90 })],
  [`https://www.youtube.com/watch?v=${A}&t=1m30s`, v(A, { start: 90 })],
  [`https://www.youtube.com/watch?v=${A}&t=1h2m3s`, v(A, { start: 3723 })],
  [`https://www.youtube.com/watch?v=${A}&t=2m`, v(A, { start: 120 })],
  [`https://www.youtube.com/watch?v=${A}#t=90`, v(A, { start: 90 })],
  [`https://www.youtube.com/watch?v=${A}&time_continue=12`, v(A, { start: 12 })],
  [`https://www.youtube.com/watch?v=${A}&t=0`, v(A)],
  [`https://www.youtube.com/watch?v=${A}&t=1:30`, v(A)],
  [`https://www.youtube.com/watch?v=${A}&t=-5`, v(A)],
  [`https://www.youtube.com/watch?v=${A}&t=864001`, v(A)],
  [`https://youtu.be/${A}&t=45`, v(A, { start: 45 })],
  // A playlist: the video, never the list.
  [`https://www.youtube.com/watch?v=${A}&list=${LIST}&index=3`, v(A)],
  [`https://www.youtube.com/playlist?list=${LIST}`, null],
  [`https://www.youtube.com/watch?list=${LIST}`, null],
  [`https://www.youtube.com/embed/videoseries?list=${LIST}`, null],
  [`https://www.youtube.com/embed/live_stream?channel=UCexampleChannel000000`, null],
  // Wrapping, punctuation and whitespace round the one link.
  [`  https://youtu.be/${A} \n`, v(A)],
  [`<https://youtu.be/${A}>`, v(A)],
  [`(https://youtu.be/${A}).`, v(A)],
  [`"https://youtu.be/${A}"`, v(A)],
  [`“https://youtu.be/${A}”`, v(A)],
  [`«https://youtu.be/${A}»`, v(A)],
  [`\`https://youtu.be/${A}\``, v(A)],
  [`https://youtu.be/${A}.`, v(A)],
  [`https://www.youtube.com/watch?v=${A}&t=90),`, v(A, { start: 90 })],
  [`[An example talk](https://youtu.be/${A})`, v(A)],
  [`​https://youtu.be/${A}﻿`, v(A)],
  // Not a video: the text stays text.
  [`Watch this: https://youtu.be/${A}`, null],
  [`https://youtu.be/${A} is the one`, null],
  [`https://youtu.be/${A}\nhttps://youtu.be/${B}`, null],
  ['https://www.youtube.com/@ExampleChannel', null],
  ['https://www.youtube.com/@ExampleChannel/videos', null],
  ['https://www.youtube.com/c/ExampleChannel', null],
  ['https://www.youtube.com/channel/UCexampleChannel000000', null],
  ['https://www.youtube.com/user/ExampleChannel', null],
  ['https://www.youtube.com/results?search_query=example+talk', null],
  ['https://www.youtube.com/feed/subscriptions', null],
  ['https://www.youtube.com/', null],
  ['https://www.youtube.com/watch', null],
  ['https://www.youtube.com/watch?v=exampleVid', null],
  ['https://www.youtube.com/watch?v=exampleVid12', null],
  ['https://www.youtube.com/watch?v=exampleVi!1', null],
  [`https://youtu.be/${A}/extra`, null],
  ['https://www.youtube.com/clip/UgkxExampleClip000000000000000000000', null],
  ['https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.com', null],
  [`https://www.google.com/imgres?imgurl=https://i.ytimg.com/vi/${A}/hqdefault.jpg&imgrefurl=https://www.youtube.com/watch?v%3D${A}`, null],
  [`https://i.ytimg.com/vi/${A}/hqdefault.jpg`, null],
  [`https://www.youtu.be/${A}`, null],
  [`https://y2u.be/${A}`, null],
  [`https://www.youtube.co.uk/watch?v=${A}`, null],
  [`https://youtube.com.example.com/watch?v=${A}`, null],
  [`https://youtube.com@example.com/watch?v=${A}`, null],
  [`https://notyoutube.com/watch?v=${A}`, null],
  ['https://video.example.com/123456', null],
  [`javascript:alert(1)//youtu.be/${A}`, null],
  [`file:///Users/example/youtu.be/${A}`, null],
  [`ftp://youtu.be/${A}`, null],
  [A, null],
  ['hello_world', null],
  ['', null],
  [`https://youtu.be/${A}?si=${'a'.repeat(3000)}`, null],
];

for (const [text, expected] of TABLE) {
  test(`${JSON.stringify(text).slice(0, 110)} is ${expected ? JSON.stringify(expected) : 'not a video'}`, () => {
    assert.deepEqual(youTubeVideoFromText(text), expected);
  });
}

test('an id is 11 characters of base64url, spelt as YouTube spells it — never an embed word', () => {
  assert.equal(isYouTubeVideoId(A), true);
  assert.equal(isYouTubeVideoId('Example-_01'), true);
  // Case matters: two ids that differ only in case are two videos.
  assert.deepEqual(youTubeVideoFromText('https://youtu.be/EXAMPLEVID1'), v('EXAMPLEVID1'));
  for (const not of ['exampleVid', 'exampleVid12', 'exampleVi!1', 'videoseries', 'live_stream', ` ${A}`, '']) {
    assert.equal(isYouTubeVideoId(not), false, JSON.stringify(not));
  }
});

test('a YouTube time is seconds, in any of the forms its links use, and nothing else is', () => {
  const cases = [
    ['90', 90], ['90s', 90], ['1m30s', 90], ['1m30', 90], ['1h2m3s', 3723], ['1h', 3600], ['2m', 120],
    ['90.5', 90], ['0', 0], [' 15 ', 15], ['1H2M3S', 3723], ['864000', 864000],
    ['1:30', null], ['-5', null], ['abc', null], ['', null], ['h', null], ['864001', null],
  ];
  for (const [raw, want] of cases) assert.equal(parseYouTubeTime(raw), want, raw);
});

test('a drop reads its uri-list first, then its plain text; a Google Images result stays a picture', () => {
  assert.deepEqual(youTubeVideoFromDrop({ uriList: `# from a browser\r\nhttps://www.youtube.com/watch?v=${A}&pp=example`, plain: 'An example talk' }), v(A));
  // A thumbnail dragged off YouTube: its address is the watch page, not the picture.
  assert.deepEqual(youTubeVideoFromDrop({ uriList: `https://www.youtube.com/watch?v=${B}`, plain: `https://i.ytimg.com/vi/${B}/hqdefault.jpg` }), v(B));
  assert.deepEqual(youTubeVideoFromDrop({ plain: `https://youtu.be/${A}?t=5` }), v(A, { start: 5 }));
  assert.equal(youTubeVideoFromDrop({ uriList: `https://www.google.com/imgres?imgurl=https://i.ytimg.com/vi/${A}/hqdefault.jpg`, plain: `https://youtu.be/${A}` }), null);
  assert.equal(youTubeVideoFromDrop({ plain: `see https://youtu.be/${A}` }), null);
  // A uri-list of only comments has no address in it: the plain text is read.
  assert.deepEqual(youTubeVideoFromDrop({ uriList: '# only a comment', plain: `https://youtu.be/${A}` }), v(A));
  assert.equal(youTubeVideoFromDrop({}), null);
});

test('the poster, the player and the page are built from the id and the start alone', () => {
  assert.equal(youTubeEmbedUrl(v(A)), `https://www.youtube-nocookie.com/embed/${A}?autoplay=1&rel=0&playsinline=1`);
  assert.equal(youTubeEmbedUrl(v(A, { start: 90 })), `https://www.youtube-nocookie.com/embed/${A}?autoplay=1&start=90&rel=0&playsinline=1`);
  assert.equal(youTubeThumbnailUrl(A), `https://i.ytimg.com/vi/${A}/hqdefault.jpg`);
  assert.equal(youTubeWatchUrl(v(A)), `https://www.youtube.com/watch?v=${A}`);
  assert.equal(youTubeWatchUrl(v(A, { start: 90 })), `https://www.youtube.com/watch?v=${A}&t=90s`);
  // A Short plays on its watch page too: the node keeps no word of being one.
  assert.equal(youTubeWatchUrl(v(SHORT, { short: true })), `https://www.youtube.com/watch?v=${SHORT}`);
});

test('every address built from a video reads back as that video', () => {
  for (const video of [v(A), v(A, { start: 90 }), v(B, { start: 3723 })]) {
    assert.deepEqual(youTubeVideoFromText(youTubeWatchUrl(video)), video);
    assert.deepEqual(youTubeVideoFromText(youTubeEmbedUrl(video)), video);
  }
  // The poster's address is a picture, not the video.
  assert.equal(youTubeVideoFromText(youTubeThumbnailUrl(A)), null);
});
