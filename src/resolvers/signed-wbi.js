/*
 * Strategy A' (primary) - WBI-signed player metadata.
 *
 * GET /x/player/wbi/v2?aid=<aid>&cid=<cid>&wts=<ts>&w_rid=<md5>
 *   -> data.subtitle.subtitles[]  (same shape as the legacy endpoint)
 *
 * Unlike the unsigned /x/player/v2, a correctly signed request is not
 * subject to the risk-control degradation that has been observed to
 * return HTTP 200 with valid-looking subtitles belonging to a DIFFERENT
 * video. Trust level: SIGNED_METADATA.
 *
 * Signature keys come from /x/web-interface/nav via BS.wbi (short-lived
 * cache). On a signature-related rejection (-352 / -403 / HTTP 412) the
 * keys are invalidated and the request is retried exactly once.
 */

const ENDPOINT = 'https://api.bilibili.com/x/player/wbi/v2';
const SIGNATURE_REJECT_CODES = [-352, -403];

function isSignatureNetError(e) {
  return Boolean(e && e.status === 412);
}

async function fetchMetadata(ctx, env) {
  const signed = await BS.wbi.sign(env.net, {
    aid: ctx.aid,
    cid: ctx.cid
  });
  const url = `${ENDPOINT}?${signed.query}&w_rid=${signed.wRid}`;
  const data = await env.net.getJson(url, { phase: 'signed-wbi' });
  return { url, data };
}

// One signature-related failure invalidates the cached keys and is retried
// exactly once; a second failure propagates (no infinite retry loop).
async function fetchWithSignatureRetry(ctx, env) {
  try {
    return await fetchMetadata(ctx, env);
  } catch (e) {
    if (!isSignatureNetError(e)) throw e;
    BS.wbi.invalidateKeys();
    BS.warn('WBI 请求被拦截（HTTP 412），刷新密钥后重试一次');
    return fetchMetadata(ctx, env);
  }
}

async function discover(ctx, env) {
  let { url, data } = await fetchWithSignatureRetry(ctx, env);

  if (data && SIGNATURE_REJECT_CODES.includes(data.code)) {
    BS.wbi.invalidateKeys();
    BS.warn('WBI 签名被拒绝（code ' + data.code + '），刷新密钥后重试一次');
    ({ url, data } = await fetchMetadata(ctx, env));
  }

  if (!data || typeof data.code !== 'number') {
    throw new Error('响应缺少 code 字段');
  }
  if (data.code !== 0) {
    const e = new Error(`接口返回 code ${data.code}：${data.message || '未知错误'}`);
    e.code = data.code;
    throw e;
  }

  const subs = data.data && data.data.subtitle && data.data.subtitle.subtitles;
  if (!Array.isArray(subs) || subs.length === 0) {
    return { tracks: [], note: '字幕列表为空（AI 轨道通常需要登录）' };
  }

  const tracks = subs.map((s, i) =>
    BS.makeTrack({
      id: s.id != null ? s.id : i,
      lan: s.lan,
      lanDoc: s.lan_doc,
      url: s.subtitle_url,
      source: 'signed-wbi',
      aiType: s.ai_type,
      aiStatus: s.ai_status,
      contextKey: ctx.contextKey,
      trust: BS.trust.SIGNED
    })
  );

  return { tracks: tracks.filter((t) => t.url), note: `${tracks.length} 条轨道` };
}

BS.resolvers = BS.resolvers || {};
BS.resolvers.signedWbi = { name: 'signed-wbi', discover };
