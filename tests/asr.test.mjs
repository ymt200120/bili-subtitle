/*
 * ASR fallback tests: audio stream selection, chunked download, the Bcut
 * protocol (mocked), cue conversion and the ASR track's trust/ownership.
 * No network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSrc } from './load.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));

const CTX = {
  bvid: 'BV1aVs267E8Z',
  aid: 117635312394213,
  cid: 43700193240,
  contextKey: 'BV1aVs267E8Z:43700193240'
};

const UTTERANCES = [
  { start_time: 0, end_time: 1100, transcript: '中美俄已经确认' },
  { start_time: 1100, end_time: 3140, transcript: '要在深圳举行元首会晤了' },
  { start_time: 3140, end_time: 4000, transcript: '  ' },
  { start_time: 4000, end_time: 5000, transcript: '[音乐]', music: 1 },
  { start_time: 5000, end_time: 6100, transcript: '那我对这次会晤' }
];

function makeBytes(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
  return bytes;
}

/* Fake transport for the audio download: honours Range requests. */
function rangeNet(bytes, { ignoreRange = false } = {}) {
  const calls = [];
  return {
    calls,
    async request(url, opts = {}) {
      calls.push({ url, range: opts.headers && opts.headers.Range });
      if (ignoreRange) {
        return { status: 200, response: bytes.slice().buffer, headers: {} };
      }
      const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range);
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), bytes.length - 1);
      const part = bytes.slice(start, end + 1);
      return {
        status: 206,
        response: part.buffer,
        headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` }
      };
    }
  };
}

/* Fake transport for Bcut: records every call, answers like the service. */
function bcutNet(log, { createCode = 0, state = 4, runningFirst = 0 } = {}) {
  let polls = 0;
  return {
    async postForm(url, params) {
      log.push({ kind: 'form', url, params });
      if (url.endsWith('/resource/create')) {
        if (createCode) return { code: createCode, message: '账号未登录' };
        return {
          code: 0,
          data: {
            resource_id: 'rid',
            in_boss_key: 'boss-key',
            upload_id: 'upload-id',
            per_size: 400,
            upload_urls: [
              'http://up.example/part0',
              'https://up.example/part1',
              'http://up.example/part2'
            ]
          }
        };
      }
      if (url.endsWith('/resource/create/complete')) {
        return { code: 0, data: { download_url: 'https://dl.example/audio.m4a' } };
      }
      throw new Error(`unexpected form endpoint ${url}`);
    },
    async putBinary(url, data) {
      log.push({ kind: 'put', url, size: data.byteLength });
      return { status: 200, headers: { etag: `"etag-${data.byteLength}"` } };
    },
    async postJson(url, payload) {
      log.push({ kind: 'json', url, payload });
      return { code: 0, data: { task_id: 'task-1' } };
    },
    async getJson(url) {
      log.push({ kind: 'get', url });
      polls += 1;
      const current = polls <= runningFirst ? 1 : state;
      return {
        code: 0,
        data: {
          state: current,
          remark: current === 4 ? 'SUCCESS' : 'RUNNING',
          result: current === 4 ? JSON.stringify({ utterances: UTTERANCES, version: '1.2.0' }) : ''
        }
      };
    }
  };
}

test('pickAudioStream prefers the smallest 64k stream and ignores urlsless entries', () => {
  const BS = loadSrc();
  const picked = BS.audio.pickAudioStream([
    { id: 30280, baseUrl: 'https://cdn/hi.m4s', bandwidth: 192000 },
    { id: 0, baseUrl: '' },
    { id: 30216, baseUrl: 'https://cdn/low.m4s', bandwidth: 66160, mimeType: 'audio/mp4' },
    { id: 30232, baseUrl: 'https://cdn/mid.m4s', bandwidth: 70491 }
  ]);
  assert.equal(picked.url, 'https://cdn/low.m4s');
  assert.equal(picked.id, 30216);
  assert.equal(picked.mimeType, 'audio/mp4');
  assert.equal(BS.audio.pickAudioStream([]), null);
  assert.equal(BS.audio.pickAudioStream(undefined), null);
});

test('pickAudioStream falls back to the smallest bandwidth for unknown ids', () => {
  const BS = loadSrc();
  const picked = BS.audio.pickAudioStream([
    { id: 999, base_url: 'https://cdn/big.m4s', bandwidth: 320000 },
    { id: 998, base_url: 'https://cdn/small.m4s', bandwidth: 48000 }
  ]);
  assert.equal(picked.url, 'https://cdn/small.m4s');
});

test('download assembles Range chunks and reports progress', async () => {
  const BS = loadSrc();
  const bytes = makeBytes(5 * 1024 * 1024 + 77);
  const net = rangeNet(bytes);
  const seen = [];
  const out = await BS.audio.download(
    { url: 'https://cdn/a.m4s', id: 30216 },
    { env: { net }, onProgress: (received, total) => seen.push([received, total]) }
  );

  assert.equal(out.byteLength, bytes.length);
  assert.deepEqual([...out.slice(0, 8)], [...bytes.slice(0, 8)]);
  assert.deepEqual([...out.slice(-4)], [...bytes.slice(-4)]);
  assert.equal(net.calls.length, 3);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0], [2 * 1024 * 1024, bytes.length]);
  assert.deepEqual(seen[2], [bytes.length, bytes.length]);
});

test('download tolerates servers that ignore Range', async () => {
  const BS = loadSrc();
  const bytes = makeBytes(1024);
  const net = rangeNet(bytes, { ignoreRange: true });
  const out = await BS.audio.download({ url: 'https://cdn/a.m4s' }, { env: { net } });
  assert.equal(out.byteLength, 1024);
  assert.equal(net.calls.length, 1);
});

test('download stops when cancelled', async () => {
  const BS = loadSrc();
  const net = rangeNet(makeBytes(10));
  await assert.rejects(
    BS.audio.download({ url: 'https://cdn/a.m4s' }, { env: { net }, isCancelled: () => true }),
    /已取消/
  );
});

test('resolveStream signs playurl and rejects empty audio lists', async () => {
  const BS = loadSrc();
  const nav = {
    code: -101,
    data: {
      wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
      }
    }
  };
  const calls = [];
  const net = {
    async getJson(url) {
      calls.push(url);
      if (url.includes('/x/web-interface/nav')) return nav;
      return { code: 0, data: { dash: { audio: [{ id: 30216, baseUrl: 'https://cdn/a.m4s', bandwidth: 66160 }] } } };
    }
  };
  const stream = await BS.audio.resolveStream(CTX, { net });
  assert.equal(stream.url, 'https://cdn/a.m4s');
  assert.match(calls[1], /playurl\?/);
  assert.match(calls[1], /avid=117635312394213/);
  assert.match(calls[1], /cid=43700193240/);
  assert.match(calls[1], /w_rid=/);

  const emptyNet = {
    async getJson(url) {
      if (url.includes('/nav')) return nav;
      return { code: 0, data: { dash: { audio: [] } } };
    }
  };
  await assert.rejects(BS.audio.resolveStream(CTX, { net: emptyNet }), /没有取到独立音轨/);
});

test('bcut transcribe walks create -> upload -> complete -> task -> poll', async () => {
  const BS = loadSrc();
  const log = [];
  const bytes = makeBytes(1024);
  const stages = [];
  const result = await BS.asrBcut.transcribe(bytes, {
    env: { net: bcutNet(log, { runningFirst: 1 }) },
    fileName: 'BV1aVs267E8Z-43700193240.m4a',
    sleep: async () => {},
    onStage: (name, info) => stages.push([name, info])
  });

  assert.equal(result.taskId, 'task-1');
  assert.equal(result.utterances.length, UTTERANCES.length);

  const create = log.find((c) => c.url.endsWith('/resource/create'));
  assert.equal(create.params.type, 2);
  assert.equal(create.params.size, 1024);
  assert.equal(create.params.resource_file_type, 'm4a');
  assert.equal(create.params.model_id, 7);
  assert.equal(create.params.name, 'BV1aVs267E8Z-43700193240.m4a');

  const puts = log.filter((c) => c.kind === 'put');
  assert.equal(puts.length, 3);
  assert.deepEqual(puts.map((p) => p.size), [400, 400, 224]);
  // plain-http presigned URLs are upgraded, signatures stay valid
  assert.equal(puts[0].url, 'https://up.example/part0');
  assert.equal(puts[1].url, 'https://up.example/part1');

  const complete = log.find((c) => c.url.endsWith('/create/complete'));
  assert.equal(complete.params.in_boss_key, 'boss-key');
  assert.equal(complete.params.upload_id, 'upload-id');
  assert.equal(complete.params.etags, '"etag-400","etag-400","etag-224"');
  assert.equal(complete.params.model_id, 7);

  const task = log.find((c) => c.kind === 'json');
  assert.deepEqual(plain(task.payload), { resource: 'https://dl.example/audio.m4a', model_id: '7' });
  assert.match(log.find((c) => c.kind === 'get').url, /task\/result\?model_id=7&task_id=task-1/);
  assert.deepEqual(stages.map(([name]) => name), [
    'create', 'upload', 'upload', 'upload', 'complete', 'task', 'poll'
  ]);
});

test('bcut transcribe surfaces API error codes and cancellation', async () => {
  const BS = loadSrc();
  await assert.rejects(
    BS.asrBcut.transcribe(makeBytes(2048), {
      env: { net: bcutNet([], { createCode: -101 }) },
      sleep: async () => {}
    }),
    /code -101/
  );

  await assert.rejects(
    BS.asrBcut.transcribe(makeBytes(2048), {
      env: { net: bcutNet([]) },
      isCancelled: () => true,
      sleep: async () => {}
    }),
    /已取消/
  );

  await assert.rejects(
    BS.asrBcut.transcribe(new Uint8Array(10), { env: { net: bcutNet([]) } }),
    /音频过短/
  );
});

test('bcut transcribe turns a 412 challenge into an actionable message', async () => {
  const BS = loadSrc();
  const net = {
    async postForm() {
      const err = new Error('HTTP 412');
      err.status = 412;
      throw err;
    }
  };
  await assert.rejects(
    BS.asrBcut.transcribe(makeBytes(2048), { env: { net }, sleep: async () => {} }),
    /人机验证（HTTP 412）/
  );
});

test('bcut transcribe reports a failed recognition task', async () => {
  const BS = loadSrc();
  await assert.rejects(
    BS.asrBcut.transcribe(makeBytes(2048), {
      env: { net: bcutNet([], { state: 3 }) },
      sleep: async () => {}
    }),
    /语音识别失败/
  );
});

test('toCues converts milliseconds, drops empty and music-only lines', () => {
  const BS = loadSrc();
  const cues = plain(BS.asr.toCues(UTTERANCES));
  assert.deepEqual(cues, [
    { from: 0, to: 1.1, content: '中美俄已经确认' },
    { from: 1.1, to: 3.14, content: '要在深圳举行元首会晤了' },
    { from: 5, to: 6.1, content: '那我对这次会晤' }
  ]);
  assert.deepEqual(plain(BS.asr.toCues(null)), []);
});

test('ASR tracks are selectable when bound to the current context', () => {
  const BS = loadSrc();
  const ctx = BS.makeVideoContext(CTX);
  const track = BS.makeTrack({
    id: 'asr',
    lan: BS.asr.LAN,
    lanDoc: BS.asr.LAN_DOC,
    url: '',
    source: BS.asr.SOURCE,
    contextKey: ctx.contextKey,
    trust: BS.trust.ASR
  });
  track.cues = [{ from: 0, to: 1, content: 'x' }];

  assert.equal(BS.isWinnableTrust(BS.trust.ASR), true);
  assert.equal(BS.pipeline.isSelectableTrack(track, ctx), true);
  // A track without url AND without inline cues is never selectable.
  assert.equal(
    BS.pipeline.isSelectableTrack({ ...track, cues: [] }, ctx),
    false
  );
  // Wrong context is rejected.
  assert.equal(
    BS.pipeline.isSelectableTrack(track, BS.makeVideoContext({ ...CTX, cid: 1 })),
    false
  );
  // Untrusted legacy is still not selectable.
  assert.equal(BS.pipeline.isSelectableTrack({ ...track, trust: BS.trust.UNTRUSTED_LEGACY }, ctx), false);
});

test('generate runs the whole fallback and returns a bound track', async () => {
  const BS = loadSrc();
  const log = [];
  const audio = makeBytes(1024);
  const net = bcutNet(log);
  const nav = {
    code: -101,
    data: {
      wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
      }
    }
  };
  const base = net.getJson;
  net.getJson = async (url) => {
    if (url.includes('/x/web-interface/nav')) return nav;
    if (url.includes('playurl')) {
      return {
        code: 0,
        data: { dash: { audio: [{ id: 30216, baseUrl: 'https://cdn/a.m4s', bandwidth: 66160 }] } }
      };
    }
    return base(url);
  };
  net.request = async () => ({
    status: 200,
    response: audio.buffer,
    headers: {}
  });

  const ctx = BS.makeVideoContext(CTX);
  const progress = [];
  const res = await BS.asr.generate(ctx, { net }, {
    sleep: async () => {},
    onProgress: (p) => progress.push(p)
  });

  assert.equal(res.track.source, 'asr');
  assert.equal(res.track.lan, 'asr-zh');
  assert.equal(res.track.contextKey, ctx.contextKey);
  assert.equal(res.track.trust, BS.trust.ASR);
  assert.deepEqual(plain(res.cues).length, 3);
  assert.equal(res.utterances, UTTERANCES.length);
  assert.equal(progress[0].percent >= 0, true);
  assert.equal(progress[progress.length - 1].percent, 100);
  assert.equal(BS.pipeline.isSelectableTrack(res.track, ctx), true);
});

test('generate fails clearly when nothing is recognised', async () => {
  const BS = loadSrc();
  const nav = {
    code: -101,
    data: {
      wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
      }
    }
  };
  const net = {
    async getJson(url) {
      if (url.includes('/nav')) return nav;
      if (url.includes('playurl')) {
        return {
          code: 0,
          data: { dash: { audio: [{ id: 30216, baseUrl: 'https://cdn/a.m4s', bandwidth: 66160 }] } }
        };
      }
      return { code: 0, data: { state: 4, remark: 'SUCCESS', result: JSON.stringify({ utterances: [] }) } };
    },
    async request() {
      return { status: 200, response: new Uint8Array(1024).buffer, headers: {} };
    },
    async postForm(url) {
      if (url.endsWith('/resource/create')) {
        return {
          code: 0,
          data: {
            resource_id: 'r',
            in_boss_key: 'b',
            upload_id: 'u',
            per_size: 1024,
            upload_urls: ['https://up.example/1']
          }
        };
      }
      return { code: 0, data: { download_url: 'https://dl.example/a.m4a' } };
    },
    async putBinary() {
      return { status: 200, headers: { etag: '"e"' } };
    },
    async postJson() {
      return { code: 0, data: { task_id: 't' } };
    }
  };

  await assert.rejects(
    BS.asr.generate(BS.makeVideoContext(CTX), { net }, { sleep: async () => {} }),
    /没有识别到可用的语音内容/
  );
});
