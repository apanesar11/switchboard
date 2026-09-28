'use strict';

// npm run test:noteedit — the markdown half of src/renderer/noteedit.js (M9).
//
// The Notes tab's one promise about the file it owns is that OPENING A NOTE AND SAVING
// IT CHANGES NOTHING. The editor reloads from disk on every window focus and autosaves
// a moment after any keystroke, so a parser that quietly rewrites what it did not
// understand would eat someone's note by being looked at. parseBlocks() checks its own
// work for exactly that reason — a block that does not write back out as the line it
// came from becomes a `raw` block instead — and this is where that is held to.
//
// noteedit.js is a browser file with no module system. It hangs everything off
// window.SB and touches the DOM only inside the editor itself; the four functions
// tested here are pure. A handful of globals is all it takes to load.

const assert = require('node:assert/strict');
const { test } = require('node:test');

global.window = global.window || {};
global.window.SB = { dom: { h: function () { throw new Error('the DOM is not available in this test'); }, clear: function () {} } };
global.document = { addEventListener: function () {} };
global.NodeFilter = { SHOW_TEXT: 4, SHOW_ELEMENT: 1 };

require('../src/renderer/noteedit.js');
const NE = global.window.SB.noteEditor;

/** What getText() writes for the blocks a file parses to. */
function save(md) {
  const lines = NE.parseBlocks(md).map(NE.blockToMd);
  const out = lines.join('\n');
  return out ? out + '\n' : '';
}

function identical(md, why) {
  assert.equal(save(md), md, why || `round trip changed:\n--- in ---\n${md}\n--- out ---\n${save(md)}`);
}

function types(md) {
  return NE.parseBlocks(md).map(b => b.t);
}

// ---------------------------------------------------------------------------
// the invariant: open, save, and the bytes are the same
// ---------------------------------------------------------------------------

const CORPUS = [
  ['an empty note', ''],
  ['one line', 'just a thought\n'],
  ['a blank line is an empty paragraph', 'one\n\ntwo\n'],
  ['several blank lines in a row', 'one\n\n\n\ntwo\n'],
  ['headings, every level', '# one\n## two\n### three\n#### four\n##### five\n###### six\n'],
  ['a bulleted list', '- milk\n- bread\n- jam\n'],
  ['bullets written with a star', '* milk\n* bread\n'],
  ['bullets written with a plus', '+ milk\n+ bread\n'],
  ['a nested list', '- one\n  - one a\n    - one a i\n- two\n'],
  ['an ordered list', '1. first\n2. second\n3. third\n'],
  ['an ordered list that starts at three', '3. third\n4. fourth\n'],
  ['an ordered list that is all ones', '1. a\n1. b\n1. c\n'],
  ['an ordered list with a paren', '1) a\n2) b\n'],
  ['tasks', '- [ ] buy milk\n- [x] ship it\n- [X] shout\n'],
  ['a quote', '> someone said this\n> and then this\n'],
  ['a divider', '***\n'],
  ['a dashed divider', 'above\n\n---\n\nbelow\n'],
  ['a code fence', '```\nconst a = 1;\n```\n'],
  ['a code fence with a language', '```js\nconst a = 1;\n```\n'],
  ['a code fence holding a blank line', '```\na\n\nb\n```\n'],
  ['a tilde fence', '~~~\nstill code\n~~~\n'],
  ['bold, italic and code', 'a **bold** word, an *italic* one and some `code`\n'],
  ['strikethrough', '~~gone~~ but not forgotten\n'],
  ['bold inside italic', '*all **of** it*\n'],
  ['bold and italic together', '***both***\n'],
  ['bold and italic together in a heading', '# a ***b***\n'],
  ['bold and italic together in a list', '- a ***b*** c\n'],
  ['italic spanning a bold run', '*a **b** c*\n'],
  ['an underscored path', 'see /tmp/_x_ for it\n'],
  ['a link', 'see [the docs](https://example.com/docs) for more\n'],
  ['a bare address', 'see https://example.com/docs for more\n'],
  ['an underscore in a word', 'the snake_case_name stays as it is\n'],
  ['underscores are plain text, never emphasis', 'an _italic_ word\n'],
  ['an escaped marker', '\\# not a heading\n'],
  ['an escaped bullet', '\\- not a bullet\n'],
  ['a literal asterisk', 'two \\* three\n'],
  ['a literal backtick', 'a \\` backtick\n'],
  ['code containing a backtick', 'the ``a`b`` span\n'],
  ['a code span of a backslash path', 'run `C:\\temp\\x` there\n'],
  ['an angle bracket is plain text', 'use <br> to break a line\n'],
  ['a bracket that is not a link', 'see [1] in the margin\n'],
  ['a link whose text has a bracket', '[a\\]b](https://example.com)\n'],
  ['a link whose href has a space', '[x](<https://example.com/a b>)\n'],
  ['a non-breaking space between words', 'prix\u00a0: 10\n'],
  ['indented list text', '- one\n   - odd indent\n'],
  ['a mixed document', '# Plan\n\nSome prose with **bold** in it.\n\n- [ ] one thing\n- [x] another\n\n> a quote\n\n```sh\necho hi\n```\n\nlast line\n'],
];

for (const [name, md] of CORPUS) {
  test(`round trip: ${name}`, () => identical(md));
}

// Markdown this editor has no block for. It must not damage it either: every line
// comes back as a RAW block — the source, shown as source and saved as source.
const RAW = [
  ['a table', '| a | b |\n| --- | --- |\n| 1 | 2 |\n', ['raw', 'raw', 'raw']],
  ['an image', '![a shot](shot.png)\n', ['raw']],
  ['an image inside a sentence', 'see ![a shot](shot.png) here\n', ['raw']],
  ['a reference definition', '[badge]: https://img.example.com/x\n', ['raw']],
  ['a footnote definition', '[^1]: the note\n', ['raw']],
  ['a setext underline', 'Title\n=====\n', ['p', 'raw']],
  ['an html block', '<details>\n<summary>more</summary>\nhidden\n</details>\n', ['raw', 'raw', 'p', 'raw']],
  ['an unclosed fence', '```\nstill typing\n', ['raw']],
  // `** bold **` is not bold in any reader — the space after the delimiter — so it is
  // literal text, and writing it back out would put four backslashes in it.
  ['emphasis with spaces inside the delimiters', '** bold **\n', ['raw']],
  // A task written with two spaces after its box: one gap is kept per block, so this
  // one cannot be reproduced and is left alone instead.
  ['a task written with a double gap', '- [x]  done\n', ['raw']],
];

for (const [name, md, want] of RAW) {
  test(`kept verbatim as source: ${name}`, () => {
    identical(md, `${name} was rewritten by being read`);
    assert.deepEqual(types(md), want, `${name} did not become the blocks expected`);
  });
}

// Markdown this editor has no block for either, but which reads correctly as prose —
// so it is drawn as the text it is rather than as source.
const PROSE = [
  ['a four-space code block', '    indented code\n', ['p']],
  ['a footnote reference', 'text[^1]\n', ['p']],
  ['a pipe in a sentence', 'a | b is not a table\n', ['p']],
  ['a heading with seven hashes', '####### seven\n', ['p']],
];

for (const [name, md, want] of PROSE) {
  test(`kept verbatim as prose: ${name}`, () => {
    identical(md, `${name} was rewritten by being read`);
    assert.deepEqual(types(md), want);
  });
}

// ---------------------------------------------------------------------------
// what the blocks actually are
// ---------------------------------------------------------------------------

test('a line becomes the block it looks like', () => {
  assert.deepEqual(types('# h\n- b\n1. n\n- [ ] t\n> q\n***\nplain\n'),
    ['h1', 'ul', 'ol', 'todo', 'quote', 'hr', 'p']);
});

test('a blank line is an empty paragraph, so spacing survives a save', () => {
  const specs = NE.parseBlocks('one\n\ntwo\n');
  assert.deepEqual(specs.map(b => b.t), ['p', 'p', 'p']);
  assert.equal(specs[1].text, '');
});

test('a heading keeps its level, up to six', () => {
  assert.deepEqual(types('#### four\n'), ['h4']);
  // Seven hashes is not a heading in any reader, and is not one here.
  assert.deepEqual(types('####### seven\n'), ['p']);
});

test('a task keeps which box it had', () => {
  const specs = NE.parseBlocks('- [ ] open\n- [x] done\n- [X] shout\n');
  assert.deepEqual(specs.map(b => b.ck), [' ', 'x', 'X']);
});

test('an ordered item keeps its own number and delimiter', () => {
  const specs = NE.parseBlocks('3. third\n4) fourth\n');
  assert.equal(specs[0].n, 3);
  assert.equal(specs[0].dl, '.');
  assert.equal(specs[1].n, 4);
  assert.equal(specs[1].dl, ')');
});

test('a list item keeps its literal indent, however it was written', () => {
  const specs = NE.parseBlocks('- one\n   - three spaces\n');
  assert.equal(specs[1].ind, '   ');
  assert.equal(specs[1].i, 1);
});

test('an unclosed fence is left exactly as it was typed', () => {
  // Closing it would be an edit nobody asked for, so the line stays raw and the
  // bytes are untouched.
  identical('```\nstill typing\n');
});

test('a source form the DOM has to carry is on the block, not only in the parse', () => {
  // These are the fields makeBlock writes as data-* and specOf reads back. The DOM
  // round trip is what the autosave uses, and a field dropped on the way is a byte
  // the user never typed: `>text` came back `> text` before makeBlock stopped
  // treating an empty value as an absent one.
  const quote = NE.parseBlocks('>quick thought\n')[0];
  assert.equal(quote.t, 'quote');
  assert.equal(quote.gap, '');
  assert.equal(NE.blockToMd(quote), '>quick thought');
  assert.equal(NE.blockToMd({ t: 'quote', text: 'quick thought', marks: [], gap: ' ', ind: '' }), '> quick thought');
});

test('a fence only grows past a run of its OWN character', () => {
  // Backticks inside a tilde fence close nothing, so the tilde fence stands.
  const specs = NE.parseBlocks('~~~\n```\n~~~\n');
  assert.equal(specs[0].t, 'code');
  assert.equal(specs[0].text, '```');
  identical('~~~\n```\n~~~\n');
  // Backticks inside a backtick fence do close it, so that one grows.
  assert.equal(NE.blockToMd({ t: 'code', text: '```', fence: '```', lang: '', ind: '' }), '````\n```\n````');
});

test('CRLF is read, and written back as LF', () => {
  assert.equal(save('# a\r\n- b\r\n'), '# a\n- b\n');
});

test('a non-breaking space the FILE carries is left exactly as it is', () => {
  // The author's, not Chromium's: French punctuation, an aligned list. Rewriting it
  // would break the one promise this editor makes about the file.
  identical('prix\u00a0: 10\n');
  identical('a\u00a0b\n');
});

// ---------------------------------------------------------------------------
// inline marks
// ---------------------------------------------------------------------------

function inline(md) {
  const got = NE.parseInline(md);
  return NE.inlineToMd(got.text, got.marks);
}

test('the inline round trip is an identity for everything the editor writes', () => {
  for (const s of [
    'plain', '**bold**', '*em*', '`code`', '~~del~~', '**a *b* c**',
    '[t](https://x.test)', 'https://x.test', 'a **b** c *d* `e`',
    'snake_case_word', 'an _underscored_ word', 'two \\* stars', 'a \\` tick',
    '``a`b``', '\\[not a link](x)', 'use <br> here', 'a ] bracket',
  ]) {
    assert.equal(inline(s), s, `inline round trip changed ${JSON.stringify(s)}`);
  }
});

test('marks land on the right characters', () => {
  const got = NE.parseInline('a **bold** c');
  assert.equal(got.text, 'a bold c');
  assert.deepEqual(got.marks.map(m => [m.s, m.e, m.t]), [[2, 6, 'strong']]);
});

test('code is literal: no rule runs inside it', () => {
  const got = NE.parseInline('`a **b** c`');
  assert.equal(got.text, 'a **b** c');
  assert.deepEqual(got.marks.map(m => m.t), ['code']);
  assert.equal(NE.inlineToMd(got.text, got.marks), '`a **b** c`');
});

test('an underscore is plain text, both read and written', () => {
  // Readers disagree about `_italic_`, and the alternative is escaping every
  // snake_case in the file. So it means nothing here and needs no backslash.
  assert.deepEqual(NE.parseInline('snake_case_name').marks, []);
  assert.deepEqual(NE.parseInline('an _italic_ word').marks, []);
  assert.equal(inline('an _italic_ word'), 'an _italic_ word');
});

test('bold and italic over the same words read back as both', () => {
  // ⌘B then ⌘I writes `***x***`. Without a rule for it the whole line — heading,
  // bullet and all — fell through to a raw source block.
  const got = NE.parseInline('***hello***');
  assert.equal(got.text, 'hello');
  assert.deepEqual(got.marks.map(m => m.t).sort(), ['em', 'strong']);
  assert.equal(inline('***hello***'), '***hello***');
  // …and bold inside italic, which the em pattern has to be able to span.
  const nest = NE.parseInline('*a **b** c*');
  assert.equal(nest.text, 'a b c');
  assert.deepEqual(nest.marks.map(m => [m.s, m.e, m.t]), [[0, 5, 'em'], [2, 3, 'strong']]);
});

test('emphasis is written with an asterisk, which has no word gate', () => {
  assert.equal(NE.inlineToMd('abcd', [{ s: 2, e: 4, t: 'em' }]), 'ab*cd*');
});

test('a mark that starts or ends on a space is pulled in until it does not', () => {
  assert.equal(NE.inlineToMd('a bold c', [{ s: 1, e: 7, t: 'strong' }]), 'a **bold** c');
});

test('a bare url that is its own link keeps no brackets', () => {
  assert.equal(NE.inlineToMd('https://x.test', [{ s: 0, e: 14, t: 'link', href: 'https://x.test' }]), 'https://x.test');
});

test('an href with a space or a paren is wrapped in angle brackets', () => {
  assert.equal(NE.inlineToMd('x', [{ s: 0, e: 1, t: 'link', href: 'https://x.test/a b' }]), '[x](<https://x.test/a b>)');
  assert.equal(NE.inlineToMd('x', [{ s: 0, e: 1, t: 'link', href: 'https://x.test/a(b)' }]), '[x](<https://x.test/a(b)>)');
});

test('a code span picks a delimiter longer than anything inside it', () => {
  assert.equal(NE.inlineToMd('a`b', [{ s: 0, e: 3, t: 'code' }]), '``a`b``');
  assert.equal(NE.inlineToMd('`x`', [{ s: 0, e: 3, t: 'code' }]), '`` `x` ``');
});

test('a paragraph that would read as another block is escaped, and reads back as itself', () => {
  // Where the backslash goes is the escaper's business — in front for `\# heading`,
  // but after the digit for `1\. not a list`, because a digit cannot carry one. What
  // matters is only that the line comes back as the same paragraph.
  for (const text of ['# not a heading', '- not a bullet', '1. not a list', '1) not a list',
    '> not a quote', '---', '```', '- [ ] not a task']) {
    const line = NE.blockToMd({ t: 'p', text: text, marks: [] });
    assert.notEqual(line, text, `${JSON.stringify(text)} was not escaped at all`);
    const back = NE.parseBlocks(line + '\n');
    assert.equal(back.length, 1);
    assert.equal(back[0].t, 'p', `${JSON.stringify(text)} came back as ${back[0].t}`);
    assert.equal(back[0].text, text);
  }
});
