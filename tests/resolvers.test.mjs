import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadSrc,
  mockNet,
  makeEnv,
  makeTrackMessage,
  makeWebViewMessage,
  VIEW_RESPONSE
} from './load.mjs';

const BS = loadSrc();

const EMPTY_PLAYER = {
  code: 0,
  data: { subtitle: { subtitles: [] } }
};

const AI_TRACK = (url) =>
  makeTrackMessage({ id: 1, lan: 'ai-zh', lanDoc: '中文（AI）', url });

const CUES = (n) => ({
  body: Array.from({ length: n }, (_, i) => ({ from: i, to: i + 1, content: `c${i}` }))
});

const STATE = {
  videoData: {
    bvid: 'BV1BbKw6XEWq',
    aid: 116939846387549,
    title: '完整版测试视频',
    pages: [{ page: 1, part: '', cid: 40065631429 }]
  }
};

const WEB_VIEW_URL_PART = 'x/v2/subtitle/web/view';

test('legacy success: body loads, later strategies never run', async () => {
  const net = mockNet({
    json: {
      'x/player/v2': () => ({
        code: 0,
        data: {
          subtitle: {
            subtitles: [
              {
                id: 7,
                lan: 'zh-hans',
                lan_doc: '中文',
                subtitle_url: 'https://aisubtitle.hdslb.com/bfs/subtitle/one?auth_key=AAA'
              }
            ]
          }
        }
      }),
      'bfs/subtitle/one': () => CUES(2)
    }
  });

  const r = await BS.pipeline.extract(makeEnv(net, { initialState: STATE }));

  assert.equal(r.ok, true);
  assert.equal(r.track.source, 'legacy');
  assert.equal(r.cues.length, 2);
  assert.equal(
    net.calls.some((c) => c.url.includes(WEB_VIEW_URL_PART)),
    false,
    'web-view endpoint must not be called after legacy success'
  );
  assert.ok(r.diag.render().every((l) => !l.startsWith('✗')));
});

test('legacy empty -> protobuf web-view success', async () => {
  const net = mockNet({
    json: {
      'x/player/v2': () => EMPTY_PLAYER,
      'bfs/subtitle/two': () => CUES(3)
    },
    binary: {
      [WEB_VIEW_URL_PART]: () =>
        makeWebViewMessage([
          AI_TRACK('https://aisubtitle.hdslb.com/bfs/subtitle/two?auth_key=BBB')
        ])
    }
  });

  const r = await BS.pipeline.extract(makeEnv(net, { initialState: STATE }));

  assert.equal(r.ok, true);
  assert.equal(r.track.source, 'web-view');
  assert.equal(r.track.lan, 'ai-zh');
  assert.equal(r.cues.length, 3);
});

test('legacy body 404 -> web-view provides fresh track', async () => {
  const net = mockNet({
    json: {
      'x/player/v2': () => ({
        code: 0,
        data: {
          subtitle: {
            subtitles: [
              {
                id: 1,
                lan: 'ai-zh',
                lan_doc: '中文（AI）',
                subtitle_url: 'https://aisubtitle.hdslb.com/bfs/subtitle/expired?auth_key=OLD'
              }
            ]
          }
        }
      }),
      'bfs/subtitle/expired': () => {
        throw new BS.net.NetError('HTTP 404', {
          status: 404,
          endpoint: 'https://aisubtitle.hdslb.com/bfs/subtitle/expired?auth_key=OLD'
        });
      },
      'bfs/subtitle/fresh': () => CUES(4)
    },
    binary: {
      [WEB_VIEW_URL_PART]: () =>
        makeWebViewMessage([
          AI_TRACK('https://aisubtitle.hdslb.com/bfs/subtitle/fresh?auth_key=NEW')
        ])
    }
  });

  const r = await BS.pipeline.extract(makeEnv(net, { initialState: STATE }));

  assert.equal(r.ok, true);
  assert.equal(r.track.url.includes('fresh'), true);
  assert.ok(
    r.diag.render().some((l) => l.includes('✗ legacy-json#fetch') && l.includes('HTTP 404'))
  );
});

test('all metadata empty -> player-resource capture succeeds', async () => {
  const capturedUrl =
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/proxy/116939846387549/abcdef012345?auth_key=CCC';
  const net = mockNet({
    json: {
      'x/player/v2': () => EMPTY_PLAYER,
      [capturedUrl]: () => CUES(5)
    },
    binary: {
      [WEB_VIEW_URL_PART]: () => Uint8Array.from([0x0a, 0x00])
    }
  });

  const r = await BS.pipeline.extract(
    makeEnv(net, {
      initialState: STATE,
      getEntries: () => [{ url: capturedUrl, time: 1 }]
    })
  );

  assert.equal(r.ok, true);
  assert.equal(r.track.source, 'player-resource');
  assert.equal(r.cues.length, 5);
});

test('all strategies fail: precise error with hints and diagnostics', async () => {
  const net = mockNet({
    json: { 'x/player/v2': () => EMPTY_PLAYER },
    binary: { [WEB_VIEW_URL_PART]: () => Uint8Array.from([0x0a, 0x00]) }
  });

  const r = await BS.pipeline.extract(makeEnv(net, { initialState: STATE }));

  assert.equal(r.ok, false);
  assert.match(r.error.message, /未能提取到字幕/);
  assert.match(r.error.message, /登录/);
  assert.ok(r.diag.render().length >= 4);
  assert.ok(r.diag.render().some((l) => l.startsWith('○ player-resource')));
});

test('expired URLs trigger a second discovery round with fresh metadata', async () => {
  let playerCalls = 0;
  const net = mockNet({
    json: {
      'x/player/v2': () => {
        playerCalls++;
        const url =
          playerCalls === 1
            ? 'https://aisubtitle.hdslb.com/bfs/subtitle/expired1?auth_key=X1'
            : 'https://aisubtitle.hdslb.com/bfs/subtitle/fresh2?auth_key=X2';
        return {
          code: 0,
          data: {
            subtitle: {
              subtitles: [{ id: 1, lan: 'ai-zh', lan_doc: '中文（AI）', subtitle_url: url }]
            }
          }
        };
      },
      'bfs/subtitle/expired1': () => {
        throw new BS.net.NetError('HTTP 403', {
          status: 403,
          endpoint: 'https://aisubtitle.hdslb.com/bfs/subtitle/expired1'
        });
      },
      'bfs/subtitle/fresh2': () => CUES(6)
    },
    binary: {
      [WEB_VIEW_URL_PART]: () => Uint8Array.from([0x0a, 0x00])
    }
  });

  const r = await BS.pipeline.extract(
    makeEnv(net, { initialState: STATE, getEntries: () => [] })
  );

  assert.equal(r.ok, true);
  assert.equal(r.track.url.includes('fresh2'), true);
  assert.equal(playerCalls, 2, 'legacy metadata re-queried exactly once');
});

test('captured resources from a previous video are rejected after navigation', async () => {
  BS.resourceCapture.reset();

  const staleUrl =
    'https://aisubtitle.hdslb.com/bfs/subtitle/from-old-video?auth_key=DDD';
  const net = mockNet({
    json: {
      'x/player/v2': () => EMPTY_PLAYER,
      [staleUrl]: () => CUES(1)
    },
    binary: {
      [WEB_VIEW_URL_PART]: () => Uint8Array.from([0x0a, 0x00])
    }
  });

  const r = await BS.pipeline.extract(
    makeEnv(net, {
      initialState: STATE,
      getEntries: () => [{ url: staleUrl, time: 1 }]
    })
  );

  assert.equal(r.ok, false);
  assert.ok(
    r.diag.render().some((l) => l.includes('player-resource') && l.includes('不匹配'))
  );
  assert.equal(
    net.calls.some((c) => c.url === staleUrl),
    false,
    'stale URL must not even be fetched'
  );
});

test('captured resources matching current cid are accepted', async () => {
  BS.resourceCapture.reset();
  const ownedUrl =
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/proxy/40065631429/aaaa?auth_key=EEE';
  const net = mockNet({
    json: {
      'x/player/v2': () => EMPTY_PLAYER,
      [ownedUrl]: () => CUES(2)
    },
    binary: {
      [WEB_VIEW_URL_PART]: () => Uint8Array.from([0x0a, 0x00])
    }
  });

  const r = await BS.pipeline.extract(
    makeEnv(net, {
      initialState: STATE,
      getEntries: () => [{ url: ownedUrl, time: 1 }]
    })
  );

  assert.equal(r.ok, true);
  assert.equal(r.track.source, 'player-resource');
});

test('video context falls back to view API without initialState', async () => {
  const net = mockNet({
    json: {
      'x/web-interface/view': () => VIEW_RESPONSE,
      'x/player/v2': () => EMPTY_PLAYER
    },
    binary: { [WEB_VIEW_URL_PART]: () => Uint8Array.from([0x0a, 0x00]) }
  });

  const r = await BS.pipeline.extract(makeEnv(net));

  assert.equal(r.ctx.bvid, 'BV1BbKw6XEWq');
  assert.equal(r.ctx.cid, 40065631429);
  assert.equal(r.ctx.aid, 116939846387549);
});

test('non-video page fails early with a precise message', async () => {
  const net = mockNet({});
  const r = await BS.pipeline.extract(
    makeEnv(net, { href: 'https://www.bilibili.com/', initialState: null })
  );

  assert.equal(r.ok, false);
  assert.ok(r.diag.render().some((l) => l.includes('video-context') && l.startsWith('✗')));
  assert.equal(net.calls.length, 0, 'no API calls when page is not a video');
});
