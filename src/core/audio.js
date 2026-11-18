/*
 * Audio stream acquisition for the ASR fallback (videos whose uploader did
 * not enable CC / AI subtitles).
 *
 * GET /x/player/wbi/playurl (WBI-signed, aid+cid bound)
 *   -> data.dash.audio[] : [{ id, baseUrl, bandwidth, mimeType, codecs }]
 *
 * We only ever take a DASH *audio* stream: it is the smallest thing that
 * can be transcribed, and it keeps the uploaded payload small. The stream
 * URL is a signed CDN URL; like subtitle URLs it is never cached.
 *
 * Downloads are done in Range chunks so the UI can show real progress and
 * a failed chunk is retried instead of restarted from zero.
 */

const AUDIO_PLAYURL_API = 'https://api.bilibili.com/x/player/wbi/playurl';
const AUDIO_CHUNK_BYTES = 2 * 1024 * 1024;
const AUDIO_MAX_BYTES = 200 * 1024 * 1024;
const AUDIO_MAX_CHUNK_RETRIES = 2;

/*
 * Preference order: 30216 (64 kbps) first — speech recognition does not
 * benefit from higher bitrates, and the whole file is uploaded. Unknown
 * ids fall back to the smallest bandwidth.
 */
const AUDIO_QUALITY_ORDER = [30216, 30232, 30280];

function pickAudioStream(streams) {
  const list = (Array.isArray(streams) ? streams : []).filter(
    (s) => s && (s.baseUrl || s.base_url)
  );
  if (!list.length) return null;

  const rank = (s) => {
    const at = AUDIO_QUALITY_ORDER.indexOf(Number(s.id));
    return at === -1 ? AUDIO_QUALITY_ORDER.length : at;
  };
  const sorted = list.slice().sort(
    (a, b) => rank(a) - rank(b) || Number(a.bandwidth || 0) - Number(b.bandwidth || 0)
  );
  const picked = sorted[0];
  return {
    url: String(picked.baseUrl || picked.base_url),
    id: Number(picked.id) || 0,
    bandwidth: Number(picked.bandwidth) || 0,
    mimeType: String(picked.mimeType || picked.mime_type || ''),
    codecs: String(picked.codecs || '')
  };
}

async function resolveStream(ctx, env) {
  const signed = await BS.wbi.sign(env.net, {
    avid: ctx.aid,
    cid: ctx.cid,
    fnval: 4048,
    fnver: 0,
    fourk: 1
  });
  const url = `${AUDIO_PLAYURL_API}?${signed.query}&w_rid=${signed.wRid}`;
  const data = await env.net.getJson(url, { phase: 'asr-playurl' });

  if (!data || typeof data.code !== 'number') {
    throw new BS.net.NetError('音频接口响应缺少 code 字段', { endpoint: url, phase: 'asr-playurl' });
  }
  if (data.code !== 0) {
    const e = new BS.net.NetError(
      `音频接口返回 code ${data.code}：${data.message || '未知错误'}`,
      { endpoint: url, phase: 'asr-playurl' }
    );
    e.code = data.code;
    throw e;
  }

  const picked = pickAudioStream(data.data && data.data.dash && data.data.dash.audio);
  if (!picked) {
    throw new BS.net.NetError(
      '没有取到独立音轨：该视频可能是互动/付费内容，或音频流需要登录后才能获取',
      { endpoint: url, phase: 'asr-playurl' }
    );
  }
  return picked;
}

function toUint8(response) {
  if (!response) return new Uint8Array(0);
  // ArrayBuffer.isView is brand-based, so it also recognises views created
  // in another realm (tests, GM response types).
  if (ArrayBuffer.isView(response)) {
    return new Uint8Array(response.buffer, response.byteOffset, response.byteLength);
  }
  if (typeof response.byteLength === 'number' && typeof response.slice === 'function') {
    return new Uint8Array(response);
  }
  return new Uint8Array(0);
}

/*
 * Download the whole audio file in Range chunks.
 * onProgress(receivedBytes, totalBytes) — totalBytes is 0 when unknown.
 */
async function download(stream, { env, onProgress, isCancelled } = {}) {
  const net = (env && env.net) || BS.net;
  const chunks = [];
  let received = 0;
  let total = 0;

  for (;;) {
    if (total > 0 && received >= total) break;
    if (isCancelled && isCancelled()) throw new Error('已取消语音识别');

    const start = received;
    const end = start + AUDIO_CHUNK_BYTES - 1;
    let attempt = 0;
    let part = null;
    let status = 0;
    let headers = {};

    for (;;) {
      try {
        const r = await net.request(stream.url, {
          phase: 'asr-audio',
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: { Range: `bytes=${start}-${end}` }
        });
        part = toUint8(r.response);
        status = r.status;
        headers = r.headers || {};
        break;
      } catch (e) {
        attempt += 1;
        if (attempt > AUDIO_MAX_CHUNK_RETRIES) throw e;
      }
    }

    if (!part.length) break;
    chunks.push(part);
    received += part.length;

    if (!total) {
      const contentRange = headers['content-range'] || '';
      const m = /\/(\d+)\s*$/.exec(contentRange);
      if (m) total = Number(m[1]);
      if (total > AUDIO_MAX_BYTES) {
        throw new Error(`音频过大（${Math.round(total / 1048576)} MB），已超出上限`);
      }
    }
    if (onProgress) onProgress(received, total);

    // 200 = the server ignored Range and sent everything in one response.
    if (status !== 206) {
      total = received;
      break;
    }
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

BS.audio = { pickAudioStream, resolveStream, download, AUDIO_MAX_BYTES };
