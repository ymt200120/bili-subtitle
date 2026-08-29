import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSrc } from './load.mjs';

const BS = loadSrc();

test('BV URL parsing', () => {
  assert.deepEqual({ ...BS.parseVideoUrl('https://www.bilibili.com/video/BV1BbKw6XEWq') }, {
    bvid: 'BV1BbKw6XEWq',
    page: 1
  });
});

test('BV URL with page param', () => {
  assert.deepEqual(
    { ...BS.parseVideoUrl('https://www.bilibili.com/video/BV1BbKw6XEWq?p=2&spm_id_from=1') },
    { bvid: 'BV1BbKw6XEWq', page: 2 }
  );
});

test('list URL with page', () => {
  assert.deepEqual(
    { ...BS.parseVideoUrl('https://www.bilibili.com/list/BV1BbKw6XEWq?p=3') },
    { bvid: 'BV1BbKw6XEWq', page: 3 }
  );
});

test('invalid page params fall back to 1', () => {
  assert.equal(BS.parseVideoUrl('https://www.bilibili.com/video/BV1BbKw6XEWq?p=abc').page, 1);
  assert.equal(BS.parseVideoUrl('https://www.bilibili.com/video/BV1BbKw6XEWq?p=0').page, 1);
  assert.equal(BS.parseVideoUrl('https://www.bilibili.com/video/BV1BbKw6XEWq?p=-4').page, 1);
});

test('hash fragment does not break parsing', () => {
  assert.deepEqual(
    { ...BS.parseVideoUrl('https://www.bilibili.com/video/BV1BbKw6XEWq?p=2#reply1234') },
    { bvid: 'BV1BbKw6XEWq', page: 2 }
  );
});

test('non-video pages return null', () => {
  assert.equal(BS.parseVideoUrl('https://www.bilibili.com/'), null);
  assert.equal(BS.parseVideoUrl('https://www.bilibili.com/bangumi/play/ep123'), null);
  assert.equal(BS.parseVideoUrl('https://example.com/video/BV1BbKw6XEWq'), null);
  assert.equal(BS.parseVideoUrl(''), null);
});

test('isVideoPage', () => {
  assert.equal(BS.isVideoPage('https://www.bilibili.com/video/BV1BbKw6XEWq/'), true);
  assert.equal(BS.isVideoPage('https://www.bilibili.com/opus/123'), false);
});
