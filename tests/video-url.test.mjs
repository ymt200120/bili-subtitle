import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSrc, makeEnv, mockNet } from './load.mjs';

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

test('query playlist routes parse bvid and p, ignoring oid and unrelated keys', () => {
  assert.deepEqual(
    { ...BS.parseVideoUrl(
      'https://www.bilibili.com/list/watchlater?foo=bar&bvid=BV1BbKw6XEWq&oid=40065631429&p=2#part'
    ) },
    { bvid: 'BV1BbKw6XEWq', page: 2 }
  );
  assert.deepEqual(
    { ...BS.parseVideoUrl('https://www.bilibili.com/list/ml123456?bvid=BV1BbKw6XEWq') },
    { bvid: 'BV1BbKw6XEWq', page: 1 }
  );
  assert.deepEqual(
    { ...BS.parseVideoUrl(
      'https://www.bilibili.com/list/946974?sid=12345&bvid=BV1BbKw6XEWq&p=2'
    ) },
    { bvid: 'BV1BbKw6XEWq', page: 2 }
  );
  assert.deepEqual(
    { ...BS.parseVideoUrl('https://www.bilibili.com/list/946974/?bvid=BV1BbKw6XEWq') },
    { bvid: 'BV1BbKw6XEWq', page: 1 }
  );
});

test('query playlist routes require the Bilibili host, intended path, and valid bvid', () => {
  assert.equal(
    BS.parseVideoUrl('https://www.bilibili.com/list/other?bvid=BV1BbKw6XEWq'),
    null
  );
  assert.equal(
    BS.parseVideoUrl('https://www.bilibili.com/list/mlabc?bvid=BV1BbKw6XEWq'),
    null
  );
  assert.equal(
    BS.parseVideoUrl('https://www.bilibili.com/list/946974?sid=12345'),
    null
  );
  assert.equal(
    BS.parseVideoUrl('https://www.bilibili.com.evil/list/ml123?bvid=BV1BbKw6XEWq'),
    null
  );
  assert.equal(
    BS.parseVideoUrl('https://www.bilibili.com/list/ml123?bvid=not-a-bv'),
    null
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

test('playlist resolver follows p even when oid points at another part', async () => {
  const ctx = await BS.resolvers.videoContext.resolve(
    makeEnv(mockNet(), {
      href:
        'https://www.bilibili.com/list/ml2638432613?bvid=BV1BbKw6XEWq&oid=40065631429&p=2',
      initialState: {
        videoData: {
          bvid: 'BV1BbKw6XEWq',
          aid: 116939846387549,
          title: '多 P 测试视频',
          pages: [
            { page: 1, part: 'P1', cid: 40065631429 },
            { page: 2, part: 'P2', cid: 40099911111 }
          ]
        }
      }
    })
  );

  assert.equal(ctx.page, 2);
  assert.equal(ctx.cid, 40099911111);
});

test('stale one-page inline state falls back to the requested playlist page', async () => {
  const net = mockNet({
    json: {
      'x/web-interface/view': () => ({
        code: 0,
        data: {
          bvid: 'BV1BbKw6XEWq',
          aid: 116939846387549,
          title: '多 P 测试视频',
          pages: [
            { page: 1, part: 'P1', cid: 40065631429 },
            { page: 2, part: 'P2', cid: 40099911111 }
          ]
        }
      })
    }
  });
  const ctx = await BS.resolvers.videoContext.resolve(
    makeEnv(net, {
      href: 'https://www.bilibili.com/list/watchlater?bvid=BV1BbKw6XEWq&p=2',
      initialState: {
        videoData: {
          bvid: 'BV1BbKw6XEWq',
          aid: 116939846387549,
          title: '旧 P1 快照',
          cid: 40065631429,
          pages: [{ page: 1, part: 'P1', cid: 40065631429 }]
        }
      }
    })
  );

  assert.equal(ctx.page, 2);
  assert.equal(ctx.cid, 40099911111);
  assert.equal(net.calls.length, 1);
});

test('SPA identity changes when the same playlist bvid changes p', () => {
  const location = {
    href: 'https://www.bilibili.com/list/ml123456?bvid=BV1BbKw6XEWq&oid=one&p=1'
  };
  const listeners = new Map();
  const window = {
    history: {
      pushState(_state, _title, href) {
        location.href = href;
      },
      replaceState(_state, _title, href) {
        location.href = href;
      }
    },
    addEventListener(name, fn) {
      listeners.set(name, fn);
    },
    removeEventListener(name, fn) {
      if (listeners.get(name) === fn) listeners.delete(name);
    }
  };
  const playlistBS = loadSrc({ location, window });
  let navigations = 0;
  const uninstall = playlistBS.installSpaHooks(() => {
    navigations++;
  });

  window.history.pushState(
    {},
    '',
    'https://www.bilibili.com/list/ml123456?bvid=BV1BbKw6XEWq&oid=two&p=2'
  );
  assert.equal(navigations, 1);

  window.history.pushState(
    {},
    '',
    'https://www.bilibili.com/list/ml123456?bvid=BV1BbKw6XEWq&oid=three&p=2'
  );
  assert.equal(navigations, 1, 'oid-only changes do not change video identity');
  uninstall();
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
