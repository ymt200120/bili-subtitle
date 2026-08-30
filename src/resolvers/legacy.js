/*
 * Legacy JSON subtitle list - DIAGNOSTIC PROBE ONLY since v1.0.2.
 *
 * GET /x/player/v2?bvid=&cid=  ->  data.subtitle.subtitles[]
 *
 * This endpoint is UNSIGNED. It has been independently reported (risk
 * control degradation) to answer HTTP 200 / code 0 with valid-looking
 * subtitles that actually belong to a DIFFERENT video, so its tracks are
 * stamped UNTRUSTED_LEGACY: the pipeline never loads their bodies, never
 * lets one become the winner and never offers them in the track dropdown.
 * It still runs (concurrently, metadata only) so diagnostics can compare
 * it against the trusted resolvers and the login hint stays accurate.
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
      aiStatus: s.ai_status,
      contextKey: ctx.contextKey,
      trust: BS.trust.UNTRUSTED_LEGACY
    })
  );

  return { tracks: tracks.filter((t) => t.url), note: `${tracks.length} 条轨道` };
}

BS.resolvers.legacy = { name: 'legacy-json', discover };
