/*
 * Strategy A2 (anonymous): danmaku-view metadata.
 *
 * GET /x/v2/dm/view?aid=<aid>&oid=<cid>&type=1
 *   -> data.subtitle.subtitles[]   (same shape as /x/player/v2)
 *
 * Why it exists: the player's own subtitle list comes from
 * /x/player/wbi/v2 (or /x/player/v2), which is gated behind
 * `need_login_subtitle` for anonymous visitors — the array is simply empty.
 * The danmaku view payload carries the same subtitle block and does NOT
 * apply that gate, so signed-out users can still reach AI subtitles that
 * Bilibili already generated (verified 2026-11-19: 96 ranking videos,
 * 58 anonymous `ai-zh` tracks, all fetchable).
 *
 * Trust: CURRENT_VIDEO — the request embeds the current aid+cid, and AI
 * subtitle URLs additionally embed "aid cid" in the object path, which the
 * resolver verifies. A URL that embeds this aid but a DIFFERENT cid
 * (another part of the same upload) is rejected: that would silently show
 * the wrong part. URLs with no ids at all (auto-translations, CC files
 * under /bfs/subtitle/) cannot be verified from the URL and are kept as
 * query-bound tracks, labelled as such in the diagnostics.
 */

const DM_VIEW_API = 'https://api.bilibili.com/x/v2/dm/view';

/*
 * verified -> URL embeds aid+cid (AI Chinese track: "prod/<aid><cid><hash>")
 * foreign  -> URL embeds this aid but another cid (wrong part) => reject
 * query    -> no ids in the URL (translation / CC hash file) => query-bound
 */
function ownership(url, ctx) {
  const u = String(url || '');
  if (!u) return 'query';
  const hasAid = u.includes(String(ctx.aid));
  const hasCid = u.includes(String(ctx.cid));
  if (hasAid && hasCid) return 'verified';
  if (hasAid && !hasCid) return 'foreign';
  return 'query';
}

async function discover(ctx, env) {
  const url = `${DM_VIEW_API}?aid=${ctx.aid}&oid=${ctx.cid}&type=1`;
  const data = await env.net.getJson(url, { phase: 'dm-view' });

  if (!data || typeof data.code !== 'number') {
    throw new Error('响应缺少 code 字段');
  }
  if (data.code !== 0) {
    const e = new Error(`接口返回 code ${data.code}：${data.message || '未知错误'}`);
    e.code = data.code;
    e.endpoint = url;
    throw e;
  }

  const subtitle = data.data && data.data.subtitle;
  const list = Array.isArray(subtitle && subtitle.subtitles) ? subtitle.subtitles : [];
  if (!list.length) {
    return {
      tracks: [],
      note: '字幕列表为空（当前视频没有 UP 主开启的 CC / AI 字幕）'
    };
  }

  const tracks = [];
  let verified = 0;
  let dropped = 0;

  for (const s of list) {
    const trackUrl = BS.normalizeSubtitleUrl(s && s.subtitle_url);
    if (!trackUrl) continue;
    const own = ownership(trackUrl, ctx);
    if (own === 'foreign') {
      dropped += 1;
      continue;
    }
    if (own === 'verified') verified += 1;

    const track = BS.makeTrack({
      id: s.id != null ? s.id : s.id_str,
      lan: s.lan,
      lanDoc: s.lan_doc,
      url: trackUrl,
      source: 'dm-view',
      aiType: s.ai_type,
      aiStatus: s.ai_status,
      contextKey: ctx.contextKey,
      trust: BS.trust.CURRENT_VIDEO
    });
    // Diagnostics only: verified tracks embed aid+cid, so a cross-video
    // response would be visible instead of silently trusted.
    track.verifiedBy = own;
    tracks.push(track);
  }

  // Verified tracks first, then the usual language preference.
  tracks.sort((a, b) => {
    const va = a.verifiedBy === 'verified' ? 1 : 0;
    const vb = b.verifiedBy === 'verified' ? 1 : 0;
    return vb - va || BS.languageScore(b) - BS.languageScore(a);
  });

  const notes = [`${tracks.length} 条轨道`, `${verified} 条内嵌 aid+cid 可校验`];
  if (dropped) notes.push(`${dropped} 条属于其他分 P，已丢弃`);
  return { tracks, note: notes.join(' · ') };
}

BS.resolvers = BS.resolvers || {};
BS.resolvers.dmView = { name: 'dm-view', discover, ownership };
