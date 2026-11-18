/*
 * dm-view resolver: the anonymous subtitle channel
 * GET /x/v2/dm/view?aid=<aid>&oid=<cid>&type=1 -> data.subtitle.subtitles[]
 *
 * Covers URL ownership verification (AI tracks embed "aid cid" in the
 * object path), rejection of other parts of the same upload, and its place
 * in the pipeline (before web-view, after signed-wbi).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSrc, mockNet, makeEnv } from './load.mjs';

const BS = loadSrc();

const AID = 116939846387549;
const CID = 40065631429;
const BVID = 'BV1BbKw6XEWq';

const STATE = {
  videoData: {
    bvid: BVID,
    aid: AID,
    title: '完整版测试视频',
    pages: [{ page: 1, part: '', cid: CID }]
  }
};

const CONTEXT = { aid: AID, cid: CID, contextKey: `${BVID}:${CID}` };

const HASH = '4b6f803738d47df1bdaec174195d9492';
const AI_URL = `https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${AID}${CID}${HASH}?auth_key=K`;
const HASHED_URL = 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/956c3d6a69d54a6e187cf6d6730c4f37';
const FOREIGN_URL = `https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${AID}400999111114${HASH}?auth_key=K`;

const CUES = (n) => ({
  body: Array.from({ length: n }, (_, i) => ({ from: i, to: i + 1, content: `c${i}` }))
});

const NAV = {
  code: -101,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
    }
  }
};

const EMPTY_PLAYER = { code: 0, data: { subtitle: { subtitles: [] } } };

function body(subtitles) {
  return { code: 0, data: { subtitle: { subtitles } } };
}

test('ownership: verified / foreign / query', () => {
  assert.equal(BS.resolvers.dmView.ownership(AI_URL, CONTEXT), 'verified');
  assert.equal(BS.resolvers.dmView.ownership(FOREIGN_URL, CONTEXT), 'foreign');
  assert.equal(BS.resolvers.dmView.ownership(HASHED_URL, CONTEXT), 'query');
  assert.equal(BS.resolvers.dmView.ownership('', CONTEXT), 'query');
});

test('ownership: ids must match exactly, not as a decimal prefix', () => {
  const own = (body) => BS.resolvers.dmView.ownership(
    `https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${body}?auth_key=K`,
    CONTEXT
  );

  // A foreign cid that extends the current cid: the old substring check said
  // "verified" because the URL contained 40065631429 as a prefix.
  assert.equal(own(`${AID}${CID}0${HASH}`), 'foreign');
  // A foreign cid the current cid extends: the digest happens to continue the
  // decimal run (starts with a digit), so the split must use the digest length.
  assert.equal(own(`${AID}4006563142${'9' + HASH.slice(1)}`), 'foreign');
  // A completely different video's prod path used to fall into "query" and be
  // kept; it now carries someone else's ids and is rejected.
  assert.equal(
    own(`11762398764181826037066889${HASH}`),
    'foreign',
    'cross-video response is dropped'
  );
  // The exact pair is still verified, even with a non-md5 digest length.
  assert.equal(own(`${AID}${CID}${'ab'.repeat(20)}`), 'verified');
});

test('ownership: non-prod URLs need standalone decimal runs', () => {
  const own = (url) => BS.resolvers.dmView.ownership(url, CONTEXT);
  assert.equal(
    own(`https://subtitle.bilibili.com/bfs/subtitle/${CID}.json`),
    'query',
    'a cid alone is query-bound'
  );
  assert.equal(
    own(`https://subtitle.bilibili.com/bfs/subtitle/x.json?aid=${AID}&cid=${CID}`),
    'verified'
  );
  assert.equal(
    own(`https://subtitle.bilibili.com/bfs/subtitle/${AID}9x.json`),
    'query',
    'a digit boundary prevents an id from matching inside a longer number'
  );
});

test('discover maps tracks, normalizes urls and rejects other parts', async () => {
  const net = {
    async getJson(url) {
      assert.match(url, new RegExp(`x/v2/dm/view\\?aid=${AID}&oid=${CID}&type=1`));
      return body([
        {
          id: 2065388298645511400,
          id_str: '2065388298645511424',
          lan: 'ai-zh',
          lan_doc: '中文（自动生成）',
          subtitle_url: AI_URL.replace('https://', 'http://'),
          ai_type: 0,
          ai_status: 2
        },
        {
          id: 2,
          lan: 'ai-en',
          lan_doc: '英语（自动翻译）',
          subtitle_url: HASHED_URL
        },
        {
          id: 3,
          lan: 'ai-zh',
          lan_doc: '其他分P',
          subtitle_url: FOREIGN_URL
        }
      ]);
    }
  };

  const r = await BS.resolvers.dmView.discover(CONTEXT, { net });

  assert.equal(r.tracks.length, 2, 'foreign-part track is dropped');
  assert.deepEqual(
    Array.from(r.tracks, (t) => t.lan),
    ['ai-zh', 'ai-en'],
    'verified track sorts first'
  );
  const [zh, en] = r.tracks;
  assert.equal(zh.url, AI_URL, '// and http are normalised to https');
  assert.equal(zh.trust, BS.trust.CURRENT_VIDEO);
  assert.equal(zh.contextKey, CONTEXT.contextKey);
  assert.equal(zh.verifiedBy, 'verified');
  assert.equal(zh.aiStatus, 2);
  assert.equal(en.verifiedBy, 'query');
  assert.match(r.note, /2 条轨道 · 1 条内嵌 aid\+cid 可校验 · 1 条 URL 归属不符（其他分 P \/ 其他视频），已丢弃/);
});

test('discover reports an empty list without failing', async () => {
  const net = { async getJson() { return body([]); } };
  const r = await BS.resolvers.dmView.discover(CONTEXT, { net });
  assert.deepEqual([...r.tracks], []);
  assert.match(r.note, /字幕列表为空/);
});

test('discover surfaces API error codes', async () => {
  const net = { async getJson() { return { code: -400, message: '请求错误' }; } };
  await assert.rejects(BS.resolvers.dmView.discover(CONTEXT, { net }), /code -400/);
});

test('pipeline: dm-view wins anonymously when the signed path is empty', async () => {
  BS.wbi.invalidateKeys();
  const m = mockNet({
    json: {
      'x/web-interface/nav': () => NAV,
      'x/player/v2': () => EMPTY_PLAYER,
      'x/player/wbi/v2': () => EMPTY_PLAYER,
      'x/v2/dm/view': () => body([
        {
          id: 1,
          lan: 'ai-zh',
          lan_doc: '中文（自动生成）',
          subtitle_url: AI_URL
        }
      ]),
      'aisubtitle.hdslb.com': () => CUES(3)
    },
    binary: {}
  });

  const r = await BS.pipeline.extract(makeEnv(m, { initialState: STATE }));

  assert.equal(r.ok, true);
  assert.equal(r.track.source, 'dm-view');
  assert.equal(r.track.trust, BS.trust.CURRENT_VIDEO);
  assert.equal(r.cues.length, 3);
  assert.equal(
    m.calls.some((c) => c.url.includes('x/v2/subtitle/web/view')),
    false,
    'web-view never runs once dm-view produced a body'
  );
  assert.equal(
    m.calls.some((c) => c.url.includes('x/player/wbi/v2')),
    true,
    'signed path still tried first'
  );
});

test('pipeline: dm-view with only unowned tracks still proceeds to web-view', async () => {
  BS.wbi.invalidateKeys();
  // Signed, dm-view and web-view all empty -> pipeline must fail closed, and
  // the diagnostics must show every trusted attempt.
  const m = mockNet({
    json: {
      'x/web-interface/nav': () => NAV,
      'x/player/v2': () => EMPTY_PLAYER,
      'x/player/wbi/v2': () => EMPTY_PLAYER,
      'x/v2/dm/view': () => body([])
    },
    binary: { 'x/v2/subtitle/web/view': () => Uint8Array.from([0x0a, 0x00]) }
  });

  const r = await BS.pipeline.extract(makeEnv(m, { initialState: STATE }));

  assert.equal(r.ok, false);
  assert.match(r.error.message, /语音识别生成字幕/);
  const rendered = r.diag.render().join('\n');
  assert.match(rendered, /dm-view/);
  assert.match(rendered, /web-view/);
});
