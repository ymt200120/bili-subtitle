import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSrc } from './load.mjs';

const BS = loadSrc();

test('parses body array and trims content', () => {
  const cues = BS.parseSubtitleJson({
    body: [
      { from: 0, to: 1.2, content: '  你好  ' },
      { from: 'x', to: 2, content: '' },
      null
    ]
  });
  assert.equal(cues.length, 1);
  assert.deepEqual({ ...cues[0] }, { from: 0, to: 1.2, content: '你好' });
});

test('missing or malformed body yields empty list', () => {
  assert.deepEqual([...BS.parseSubtitleJson({})], []);
  assert.deepEqual([...BS.parseSubtitleJson(null)], []);
  assert.deepEqual([...BS.parseSubtitleJson({ body: 'nope' })], []);
});

test('sorts by start time', () => {
  const cues = BS.parseSubtitleJson({
    body: [
      { from: 5, to: 6, content: 'b' },
      { from: 1, to: 2, content: 'a' }
    ]
  });
  assert.deepEqual([...cues.map((c) => c.content)], ['a', 'b']);
});

test('dedupes identical consecutive cues (segmented AI tracks)', () => {
  const cues = BS.parseSubtitleJson({
    body: [
      { from: 1, to: 2, content: 'x' },
      { from: 1, to: 2, content: 'x' },
      { from: 2, to: 3, content: 'y' }
    ]
  });
  assert.equal(cues.length, 2);
});

test('negative from is clamped to 0', () => {
  const cues = BS.parseSubtitleJson({
    body: [{ from: -3, to: 2, content: 'a' }]
  });
  assert.equal(cues[0].from, 0);
});
