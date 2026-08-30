/*
 * Strategy B - New web subtitle metadata API (protobuf).
 *
 * GET /x/v2/subtitle/web/view?oid=<cid>&pid=<aid>&type=1
 *     &context_ext={"video_type":1}&cur_production_type=0&playlist_switch=0
 *
 * Verified anonymously (2026-08): HTTP 200, application/octet-stream,
 * an empty protobuf data message when no tracks are visible (e.g. not
 * logged in). Invalid parameters return a JSON error instead, so the
 * response is sniffed before decoding. See docs/PROTOCOL.md.
 */

function buildUrl(ctx) {
  return (
    'https://api.bilibili.com/x/v2/subtitle/web/view' +
    `?oid=${encodeURIComponent(ctx.cid)}` +
    `&pid=${encodeURIComponent(ctx.aid)}` +
    '&type=1' +
    `&context_ext=${encodeURIComponent('{"video_type":1}')}` +
    '&cur_production_type=0' +
    '&playlist_switch=0'
  );
}

function looksLikeJson(bytes) {
  for (let i = 0; i < Math.min(bytes.length, 16); i++) {
    const b = bytes[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    return b === 0x7b || b === 0x5b; // '{' or '['
  }
  return false;
}

async function discover(ctx, env) {
  const url = buildUrl(ctx);
  const buffer = await env.net.getBinary(url, { phase: 'web-view' });
  const bytes = new Uint8Array(buffer);

  if (looksLikeJson(bytes)) {
    let parsed = null;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) { /* fallthrough */ }
    if (parsed && parsed.code !== undefined && parsed.code !== 0) {
      throw new Error(`接口返回 code ${parsed.code}：${parsed.message || '未知错误'}`);
    }
    throw new Error('响应为 JSON 但无法识别');
  }

  const { empty, tracks } = BS.protobuf.decodeWebViewTracks(bytes);
  if (empty) {
    return { tracks: [], note: '接口可达但无轨道（未登录或该视频无 AI 字幕）' };
  }

  return {
    tracks: tracks.map((t) =>
      BS.makeTrack({
        id: t.idStr || t.id,
        lan: t.lan,
        lanDoc: t.lanDoc || t.label,
        url: t.url,
        source: 'web-view',
        contextKey: ctx.contextKey,
        trust: BS.trust.CURRENT_VIDEO
      })
    ),
    note: `${tracks.length} 条轨道`
  };
}

BS.resolvers.webView = { name: 'web-view', discover };
