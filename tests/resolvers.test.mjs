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

// Empty-but-OK responses for the trusted metadata endpoints.
const emptyWbi = () => ({ code: 0, data: { subtitle: { subtitles: [] } } });
const emptyWebViewBinary = () => Uint8Array.from([0x0a, 0x00]);

// The video under test (the "car video").
const STATE = {
  videoData: {
    bvid: 'BV1BbKw6XEWq',
    aid: 116939846387549,
    title: '完整版测试视频',
    pages: [{ page: 1, part: '', cid: 40065631429 }]
  }
};

const STATE_MULTI = {
  videoData: {
    bvid: 'BV1BbKw6XEWq',
    aid: 116939846387549,
    title: '多P测试视频',
    pages: [
      { page: 1, part: 'P1', cid: 40065631429 },
      { page: 2, part: 'P2', cid: 40099911111 }
    ]
  }
};

/*
 * Subtitle fixtures. The iPhone track simulates the real-world bug: a
 * syntactically valid, fetchable subtitle belonging to a DIFFERENT video,
 * returned by the unsigned legacy endpoint.
 */
const CAR_SUB = {
  id: 11,
  lan: 'ai-zh',
  lan_doc: '中文（AI）',
  subtitle_url: 'https://aisubtitle.hdslb.com/bfs/subtitle/car-video.json?auth_key=CARKEY'
};
const IPHONE_SUB = {
  id: 22,
  lan: 'ai-zh',
  lan_doc: '中文（AI）',
  subtitle_url: 'https://aisubtitle.hdslb.com/bfs/subtitle/iphone-video.json?auth_key=IPKEY'
};

const CUES = (n) => ({
  body: Array.from({ length: n }, (_, i) => ({ from: i, to: i + 1, content: `c${i}` }))
});

const AI_TRACK = (url) =>
  makeTrackMessage({ id: 1, lan: 'ai-zh', lanDoc: '中文（AI）', url });

const WEB_VIEW_URL_PART = 'x/v2/subtitle/web/view';

const NAV_RESPONSE = {
  code: -101,
  message: '账号未登录',
  data: {
    isLogin: false,
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
    }
  }
};

// All mocks that run the pipeline must serve nav + legacy probe + signed
// wbi; handlers are substring-matched.
function baseJsonHandlers(overrides = {}) {
  return {
    'x/web-interface/nav': () => NAV_RESPONSE,
    'x/player/v2': () => EMPTY_PLAYER,
    'x/player/wbi/v2': () => emptyWbi(),
    ...overrides
  };
}

function net(json, binary = {}) {
  return mockNet({ json, binary });
}

function currentEpoch() {
  return BS.resourceCapture.epoch;
}

test('signed-wbi success: body loads, later strategies never run', async () => {
  BS.wbi.invalidateKeys();
  const m = net(
    baseJsonHandlers({
      'x/player/wbi/v2': () => ({
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
    }),
    { [WEB_VIEW_URL_PART]: emptyWebViewBinary }
  );

  const r = await BS.pipeline.extract(makeEnv(m, { initialState: STATE }));

  assert.equal(r.ok, true);
  assert.equal(r.track.source, 'signed-wbi');
  assert.equal(r.track.trust, BS.trust.SIGNED);
  assert.equal(r.track.contextKey, r.ctx.contextKey);
  assert.equal(r.cues.length, 2);
  assert.equal(
    m.calls.some((c) => c.url.includes(WEB_VIEW_URL_PART)),
    false,
    'web-view endpoint must not be called after signed-wbi success'
  );
  assert.equal(
    m.calls.some((c) => c.url.includes('x/player/v2?')),
    true,
    'legacy diagnostic probe runs for comparison'
  );

  const lines = r.diag.render();
  assert.ok(lines[0].startsWith('Extract run #'), lines[0]);
  assert.ok(lines.some((l) => l.startsWith('Context · BV1BbKw6XEWq · aid ')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('Winner · signed-wbi')), lines.join('\n'));
  assert.ok(lines.every((l) => !l.startsWith('✗')), lines.join('\n'));
});

test('signed-wbi empty -> protobuf web-view success', async () => {
  BS.wbi.invalidateKeys();
  const m = net(
    baseJsonHandlers({ 'bfs/subtitle/two': () => CUES(3) }),
    {
      [WEB_VIEW_URL_PART]: () =>
        makeWebViewMessage([
          AI_TRACK('https://aisubtitle.hdslb.com/bfs/subtitle/two?auth_key=BBB')
        ])
    }
  );

  const r = await BS.pipeline.extract(makeEnv(m, { initialState: STATE }));

  assert.equal(r.ok, true);
  assert.equal(r.track.source, 'web-view');
  assert.equal(r.track.trust, BS.trust.CURRENT_VIDEO);
  assert.equal(r.track.lan, 'ai-zh');
  assert.equal(r.track.contextKey, r.ctx.contextKey);
  assert.equal(r.cues.length, 3);
});

test('signed-wbi body 404 -> one extra discovery round gets a fresh track', async () => {
  BS.wbi.invalidateKeys();
  let wbiCalls = 0;
  const m = net(
    baseJsonHandlers({
      'x/player/wbi/v2': () => {
        wbiCalls++;
        const url =
          wbiCalls === 1
            ? 'https://aisubtitle.hdslb.com/bfs/subtitle/expired?auth_key=OLD'
            : 'https://aisubtitle.hdslb.com/bfs/subtitle/fresh?auth_key=NEW';
        return {
          code: 0,
          data: {
            subtitle: {
              subtitles: [{ id: 1, lan: 'ai-zh', lan_doc: '中文（AI）', subtitle_url: url }]
            }
          }
        };
      },
      'bfs/subtitle/expired': () => {
        throw new BS.net.NetError('HTTP 404', {
          status: 404,
          endpoint: 'https://aisubtitle.hdslb.com/bfs/subtitle/expired?auth_key=OLD'
        });
      },
      'bfs/subtitle/fresh': () => CUES(4)
    }),
    { [WEB_VIEW_URL_PART]: emptyWebViewBinary }
  );

  const r = await BS.pipeline.extract(makeEnv(m, { initialState: STATE }));

  assert.equal(r.ok, true);
  assert.equal(r.track.url.includes('fresh'), true);
  assert.equal(wbiCalls, 2, 'signed metadata re-queried exactly once');
  assert.ok(
    r.diag.render().some((l) => l.includes('✗ signed-wbi#fetch') && l.includes('HTTP 404'))
  );
});

test('wbi signature rejected (-352): keys invalidated, nav refetched, retried exactly once', async () => {
  BS.wbi.invalidateKeys();
  let wbiCalls = 0;
  const m = net(
    baseJsonHandlers({
      'x/player/wbi/v2': () => {
        wbiCalls++;
        if (wbiCalls === 1) return { code: -352, message: '请求被拦截' };
        return { code: 0, data: { subtitle: { subtitles: [CAR_SUB] } } };
      },
      'car-video.json': () => CUES(7)
    }),
    { [WEB_VIEW_URL_PART]: emptyWebViewBinary }
  );

  const r = await BS.pipeline.extract(makeEnv(m, { initialState: STATE }));

  assert.equal(r.ok, true);
  assert.equal(r.track.source, 'signed-wbi');
  assert.equal(wbiCalls, 2, 'exactly one retry after signature rejection');
  const navCalls = m.calls.filter((c) => c.url.includes('x/web-interface/nav')).length;
  assert.equal(navCalls, 2, 'nav refetched once after invalidation');
});

test('REGRESSION valid-but-wrong legacy: unsigned 200 with iPhone subtitles, signed wbi returns CAR -> CAR wins', async () => {
  BS.wbi.invalidateKeys();
  const m = net(
    baseJsonHandlers({
      'x/player/v2': () => ({
        code: 0,
        data: { subtitle: { subtitles: [IPHONE_SUB] } }
      }),
      'x/player/wbi/v2': () => ({
        code: 0,
        data: { subtitle: { subtitles: [CAR_SUB] } }
      }),
      'car-video.json': () => CUES(7),
      'iphone-video.json': () => CUES(9)
    }),
    { [WEB_VIEW_URL_PART]: emptyWebViewBinary }
  );

  const r = await BS.pipeline.extract(makeEnv(m, { initialState: STATE }));

  assert.equal(r.ok, true);
  assert.equal(r.track.source, 'signed-wbi');
  assert.equal(r.track.url.includes('car-video'), true, 'the car video track wins');
  assert.equal(r.cues.length, 7);
  assert.equal(
    r.tracks.some((t) => t.source === 'legacy'),
    false,
    'untrusted legacy tracks must not enter the selectable list'
  );
  assert.equal(
    r.tracks.some((t) => t.url.includes('iphone-video')),
    false,
    'iPhone track must not be selectable'
  );
  assert.equal(
    m.calls.some((c) => c.url.includes('iphone-video.json')),
    false,
    'legacy track body must never be fetched'
  );
  const lines = r.diag.render();
  assert.ok(
    lines.some((l) => l.includes('legacy-json(诊断)') && l.includes('未采信')),
    lines.join('\n')
  );
  assert.ok(lines.some((l) => l.startsWith('Winner · signed-wbi')));
});

test('REGRESSION valid-but-wrong legacy only: wbi empty + web-view correct -> web-view wins', async () => {
  BS.wbi.invalidateKeys();
  const m = net(
    baseJsonHandlers({
      'x/player/v2': () => ({
        code: 0,
        data: { subtitle: { subtitles: [IPHONE_SUB] } }
      }),
      'wv-track.json': () => CUES(4),
      'iphone-video.json': () => CUES(9)
    }),
    {
      [WEB_VIEW_URL_PART]: () =>
        makeWebViewMessage([
          AI_TRACK('https://aisubtitle.hdslb.com/bfs/subtitle/wv-track.json?auth_key=WV')
        ])
    }
  );

  const r = await BS.pipeline.extract(makeEnv(m, { initialState: STATE }));

  assert.equal(r.ok, true);
  assert.equal(r.track.source, 'web-view');
  assert.equal(r.tracks.some((t) => t.url.includes('iphone-video')), false);
});

test('REGRESSION all trusted resolvers fail but legacy valid -> FAIL, never the untrusted track', async () => {
  BS.wbi.invalidateKeys();
  let wbiCalls = 0;
  const m = net(
    baseJsonHandlers({
      'x/player/v2': () => ({
        code: 0,
        data: { subtitle: { subtitles: [IPHONE_SUB] } }
      }),
      'x/player/wbi/v2': () => {
        wbiCalls++;
        return { code: -352, message: '请求被拦截' };
      },
      'iphone-video.json': () => CUES(9)
    }),
    { [WEB_VIEW_URL_PART]: emptyWebViewBinary }
  );

  const r = await BS.pipeline.extract(
    makeEnv(m, { initialState: STATE, getEntries: () => [] })
  );

  assert.equal(r.ok, false, 'no result is better than a wrong result');
  assert.match(r.error.message, /未能提取到字幕/);
  assert.match(r.error.message, /无法证明字幕归属/);
  assert.equal(wbiCalls, 2, 'signature retry happens exactly once');
  assert.equal(
    m.calls.some((c) => c.url.includes('iphone-video.json')),
    false,
    'untrusted legacy body must never be fetched'
  );
  assert.ok(
    r.diag.render().every((l) => !l.includes('Winner')),
    'no winner may be reported'
  );
});

test('all trusted empty + legacy empty: fail with login hint and diagnostics', async () => {
  BS.wbi.invalidateKeys();
  const m = net(baseJsonHandlers(), { [WEB_VIEW_URL_PART]: emptyWebViewBinary });

  const r = await BS.pipeline.extract(
    makeEnv(m, { initialState: STATE, getEntries: () => [] })
  );

  assert.equal(r.ok, false);
  assert.match(r.error.message, /未能提取到字幕/);
  assert.match(r.error.message, /登录/);
  assert.ok(r.diag.render().length >= 4);
  assert.ok(r.diag.render().some((l) => l.startsWith('○ player-resource')));
});

test('legacy probe disagreeing with trusted result produces a cross-check warning', async () => {
  BS.wbi.invalidateKeys();
  const m = net(
    baseJsonHandlers({
      'x/player/v2': () => ({
        code: 0,
        data: {
          subtitle: {
            subtitles: [
              {
                id: 33,
                lan: 'en',
                lan_doc: 'English',
                subtitle_url: 'https://aisubtitle.hdslb.com/bfs/subtitle/en-track.json?auth_key=EN'
              }
            ]
          }
        }
      }),
      'x/player/wbi/v2': () => ({
        code: 0,
        data: { subtitle: { subtitles: [CAR_SUB] } }
      }),
      'car-video.json': () => CUES(2),
      'en-track.json': () => CUES(2)
    }),
    { [WEB_VIEW_URL_PART]: emptyWebViewBinary }
  );

  const r = await BS.pipeline.extract(makeEnv(m, { initialState: STATE }));

  assert.equal(r.ok, true);
  assert.ok(
    r.diag.render().some((l) => l.includes('cross-check') && l.includes('不一致')),
    r.diag.render().join('\n')
  );
});

test('trusted all empty -> player-resource capture (current epoch + owned) succeeds', async () => {
  BS.resourceCapture.reset();
  BS.wbi.invalidateKeys();
  const capturedUrl =
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/proxy/116939846387549/abcdef012345?auth_key=CCC';
  const m = net(
    baseJsonHandlers({
      'x/player/v2': () => ({
        code: 0,
        data: { subtitle: { subtitles: [IPHONE_SUB] } }
      }),
      [capturedUrl]: () => CUES(5),
      'iphone-video.json': () => CUES(9)
    }),
    { [WEB_VIEW_URL_PART]: emptyWebViewBinary }
  );

  const r = await BS.pipeline.extract(
    makeEnv(m, {
      initialState: STATE,
      getEntries: () => [{ url: capturedUrl, time: 1, epoch: currentEpoch() }]
    })
  );

  assert.equal(r.ok, true);
  assert.equal(r.track.source, 'player-resource');
  assert.equal(r.track.trust, BS.trust.CURRENT_PLAYER);
  assert.equal(r.cues.length, 5);
});

test('captured resources from a previous video are rejected after navigation', async () => {
  BS.resourceCapture.reset();
  BS.wbi.invalidateKeys();

  const staleUrl =
    'https://aisubtitle.hdslb.com/bfs/subtitle/from-old-video?auth_key=DDD';
  const m = net(baseJsonHandlers({ [staleUrl]: () => CUES(1) }), {
    [WEB_VIEW_URL_PART]: emptyWebViewBinary
  });

  const r = await BS.pipeline.extract(
    makeEnv(m, {
      initialState: STATE,
      getEntries: () => [{ url: staleUrl, time: 1, epoch: currentEpoch() }]
    })
  );

  assert.equal(r.ok, false);
  assert.ok(
    r.diag.render().some((l) => l.includes('player-resource') && l.includes('不匹配'))
  );
  assert.equal(
    m.calls.some((c) => c.url === staleUrl),
    false,
    'stale URL must not even be fetched'
  );
});

test('REGRESSION unowned captured URLs are rejected even before any SPA navigation', async () => {
  BS.resourceCapture.reset();
  BS.wbi.invalidateKeys();

  // Regression for v1.0.0/v1.0.1: before any in-tab navigation the resolver
  // probed every captured URL (playlist prefetch, script re-injection
  // replays) and could surface other videos' subtitles.
  const foreignUrl =
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/proxy/99999999999/foreign?auth_key=FFF';
  const m = net(baseJsonHandlers({ [foreignUrl]: () => CUES(1) }), {
    [WEB_VIEW_URL_PART]: emptyWebViewBinary
  });

  const r = await BS.pipeline.extract(
    makeEnv(m, {
      initialState: STATE,
      getEntries: () => [{ url: foreignUrl, time: 1, epoch: currentEpoch() }]
    })
  );

  assert.equal(r.ok, false);
  assert.ok(
    r.diag.render().some((l) => l.includes('player-resource') && l.includes('不匹配'))
  );
  assert.equal(
    m.calls.some((c) => c.url === foreignUrl),
    false,
    'foreign URL must not even be fetched'
  );
});

test('REGRESSION resource entry from a previous navigation epoch is rejected even if owned', async () => {
  BS.resourceCapture.reset();

  const ownedButStale =
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/proxy/40065631429/stale-epoch?auth_key=EEE';
  const m = net(baseJsonHandlers({ [ownedButStale]: () => CUES(3) }), {
    [WEB_VIEW_URL_PART]: emptyWebViewBinary
  });

  const ctx = BS.makeVideoContext({
    bvid: 'BV1BbKw6XEWq',
    aid: 116939846387549,
    cid: 40065631429,
    page: 1,
    pageCount: 1,
    title: 'x'
  });
  const env = makeEnv(m, {
    getEntries: () => [
      { url: ownedButStale, time: 1, epoch: BS.resourceCapture.epoch - 1 }
    ]
  });

  const r = await BS.resolvers.playerResource.discover(ctx, env);

  assert.equal(r.tracks.length, 0);
  assert.match(r.note, /不匹配/);
  assert.equal(
    m.calls.some((c) => c.url === ownedButStale),
    false,
    'stale-epoch URL must not be fetched even when the cid matches'
  );
});

test('multi-page video: aid-only captured URL rejected, cid-matching accepted', async () => {
  BS.resourceCapture.reset();
  BS.wbi.invalidateKeys();

  const aidOnlyUrl =
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/proxy/116939846387549/another-part?auth_key=GGG';
  const cidUrl =
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/proxy/116939846387549-40065631429/current-part?auth_key=HHH';
  const m = net(
    baseJsonHandlers({
      [aidOnlyUrl]: () => CUES(1),
      [cidUrl]: () => CUES(2)
    }),
    { [WEB_VIEW_URL_PART]: emptyWebViewBinary }
  );

  const r = await BS.pipeline.extract(
    makeEnv(m, {
      initialState: STATE_MULTI,
      getEntries: () => [
        { url: aidOnlyUrl, time: 2, epoch: currentEpoch() },
        { url: cidUrl, time: 1, epoch: currentEpoch() }
      ]
    })
  );

  assert.equal(r.ok, true);
  assert.equal(r.track.source, 'player-resource');
  assert.equal(r.track.url.includes('current-part'), true);
  assert.equal(
    m.calls.some((c) => c.url === aidOnlyUrl),
    false,
    'aid-only URL must not be probed on a multi-page video (could be another part)'
  );
});

test('ownsUrl predicate: cid always proves ownership, aid only on single-page videos', () => {
  const owns = BS.resolvers.playerResource.ownsUrl;
  const ctx = { cid: 40065631429, aid: 116939846387549 };
  const base = 'https://aisubtitle.hdslb.com/bfs';

  assert.equal(owns(`${base}/subtitle/noid?auth_key=A`, { ...ctx, pageCount: 1 }), false);
  assert.equal(
    owns(`${base}/ai_subtitle/proxy/116939846387549/h?auth_key=A`, { ...ctx, pageCount: 1 }),
    true
  );
  assert.equal(
    owns(`${base}/ai_subtitle/proxy/116939846387549/h?auth_key=A`, { ...ctx, pageCount: 2 }),
    false
  );
  assert.equal(
    owns(`${base}/ai_subtitle/proxy/116939846387549-40065631429/h?auth_key=A`, { ...ctx, pageCount: 2 }),
    true
  );
  assert.equal(owns(`${base}/subtitle/x?auth_key=A`, null), false);
});

test('isSelectableTrack: contextKey/trust gates (dropdown + track-change safety)', () => {
  const sel = BS.pipeline.isSelectableTrack;
  const ctx = BS.makeVideoContext({
    bvid: 'BV_CAR',
    aid: 111,
    cid: 222,
    page: 1,
    pageCount: 1,
    title: 'car'
  });

  const owned = { url: 'https://x/car.json', trust: BS.trust.CURRENT_VIDEO, contextKey: ctx.contextKey };
  const foreignKey = { url: 'https://x/iphone.json', trust: BS.trust.CURRENT_VIDEO, contextKey: 'BV_IPHONE:999' };
  const untrusted = { url: 'https://x/legacy.json', trust: BS.trust.UNTRUSTED_LEGACY, contextKey: ctx.contextKey };
  const unstamped = { url: 'https://x/x.json', trust: '', contextKey: ctx.contextKey };
  const noUrl = { url: '', trust: BS.trust.SIGNED, contextKey: ctx.contextKey };

  assert.equal(sel(owned, ctx), true);
  assert.equal(sel(foreignKey, ctx), false, 'foreign contextKey must never be selectable');
  assert.equal(sel(untrusted, ctx), false, 'UNTRUSTED_LEGACY must never be selectable');
  assert.equal(sel(unstamped, ctx), false, 'missing trust stamp must fail closed');
  assert.equal(sel(noUrl, ctx), false);
  assert.equal(sel(owned, null), false, 'no context -> fail closed');
});

test('multi-page inline state picks the cid of the requested part', async () => {
  BS.resourceCapture.reset();
  BS.wbi.invalidateKeys();
  const m = net(
    baseJsonHandlers({
      'x/player/wbi/v2': () => ({
        code: 0,
        data: {
          subtitle: {
            subtitles: [
              {
                id: 3,
                lan: 'zh-Hans',
                lan_doc: '中文',
                subtitle_url: 'https://aisubtitle.hdslb.com/bfs/subtitle/p2body?auth_key=III'
              }
            ]
          }
        }
      }),
      'bfs/subtitle/p2body': () => CUES(3)
    }),
    { [WEB_VIEW_URL_PART]: emptyWebViewBinary }
  );

  const r = await BS.pipeline.extract(
    makeEnv(m, {
      initialState: STATE_MULTI,
      href: 'https://www.bilibili.com/video/BV1BbKw6XEWq?p=2'
    })
  );

  assert.equal(r.ok, true);
  assert.equal(r.ctx.cid, 40099911111);
  assert.equal(r.ctx.pageCount, 2);
  assert.equal(r.ctx.contextKey, 'BV1BbKw6XEWq:40099911111');
});

test('video context falls back to view API without initialState', async () => {
  BS.wbi.invalidateKeys();
  const m = net(
    {
      'x/web-interface/nav': () => NAV_RESPONSE,
      'x/web-interface/view': () => VIEW_RESPONSE,
      'x/player/v2': () => EMPTY_PLAYER,
      'x/player/wbi/v2': () => emptyWbi()
    },
    { [WEB_VIEW_URL_PART]: emptyWebViewBinary }
  );

  const r = await BS.pipeline.extract(makeEnv(m));

  assert.equal(r.ctx.bvid, 'BV1BbKw6XEWq');
  assert.equal(r.ctx.cid, 40065631429);
  assert.equal(r.ctx.aid, 116939846387549);
  assert.equal(r.ctx.contextKey, 'BV1BbKw6XEWq:40065631429');
});

test('non-video page fails early with a precise message', async () => {
  const m = mockNet({});
  const r = await BS.pipeline.extract(
    makeEnv(m, { href: 'https://www.bilibili.com/', initialState: null })
  );

  assert.equal(r.ok, false);
  assert.ok(r.diag.render().some((l) => l.includes('video-context') && l.startsWith('✗')));
  assert.equal(m.calls.length, 0, 'no API calls when page is not a video');
});
