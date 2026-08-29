/*
 * Strategy A - Legacy JSON subtitle list.
 *
 * GET /x/player/v2?bvid=&cid=  ->  data.subtitle.subtitles[]
 *
 * Verified behavior: anonymous requests return code 0 with an EMPTY
 * subtitles array for AI-only videos, so an empty list is reported as
 * "ok but empty (possibly login-gated)", not as a hard failure.
 */

async function discover(ctx, env) {
  const url =
    'https://api.bilibili.com/x/player/v2' +
    `?bvid=${encodeURIComponent(ctx.bvid)}` +
    `&cid=${encodeURIComponent(ctx.cid)}`;

  const data = await env.net.getJson(url, { phase: 'legacy-json' });
  if (!data || typeof data.code !== 'number') {
    throw new Error('响应缺少 code 字段');
  }
  if (data.code !== 0) {
    throw new Error(`接口返回 code ${data.code}：${data.message || '未知错误'}`);
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
      source: 'legacy',
      aiType: s.ai_type,
      aiStatus: s.ai_status
    })
  );

  return { tracks: tracks.filter((t) => t.url), note: `${tracks.length} 条轨道` };
}

BS.resolvers.legacy = { name: 'legacy-json', discover };
