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
 * resolver verifies. A URL whose ids are not exactly ours — another part of
 * the same upload, or another video altogether — is rejected: that would
 * silently show the wrong subtitles. URLs with no ids at all
 * (auto-translations, CC files under /bfs/subtitle/) cannot be verified from
 * the URL and are kept as query-bound tracks, labelled as such in the
 * diagnostics.
 */

const DM_VIEW_API = 'https://api.bilibili.com/x/v2/dm/view';

/*
 * AI Chinese tracks live at
 *   .../prod/<aid><cid><digest>?auth_key=…
 * i.e. the object path starts with the decimal concatenation of aid and cid,
 * followed by a hex digest (32 chars for the md5 files observed in practice).
 * A plain substring search cannot split that run: a cid that merely *starts*
 * with the current cid (400656 vs 40065631429) would look like a match, and
 * a response for a completely different video would be trusted as "no ids".
 * Because the digest has a known length, the split is unambiguous: the
 * digits before the digest must equal aid+cid exactly.
 *
 * verified -> prod path is exactly <aid><cid><digest>            => keep
 * foreign  -> prod path belongs to some other id pair            => reject
 * query    -> no ids in the URL (translation / CC hash file)     => query-bound
 */
const PROD_PATH_RE = /\/prod\/([0-9A-Za-z]+)(?=[/?#]|$)/;
const DIGEST_LENGTHS = [16, 32, 40, 64, 128];
const HEX_RE = /^[0-9a-f]+$/i;

function isDigest(s) {
  return DIGEST_LENGTHS.indexOf(s.length) >= 0 && HEX_RE.test(s);
}

function mentionsNumber(url, number) {
  return Boolean(number) &&
    new RegExp(`(^|[^0-9])${number}([^0-9]|$)`).test(String(url));
}

function classifyProdBody(body, aid, cid) {
  const expected = aid + cid;
  if (body.startsWith(expected)) {
    // Exact id prefix. Anything that is not a whole digest after it means the
    // decimal run was longer than aid+cid (prefix collision) => not ours.
    return isDigest(body.slice(expected.length)) ? 'verified' : 'foreign';
  }
  // <some other ids><digest>: well-formed per-video path that is not ours.
  for (const len of DIGEST_LENGTHS) {
    if (body.length <= len) continue;
    const ids = body.slice(0, body.length - len);
    if (/^\d{16,}$/.test(ids) && HEX_RE.test(body.slice(-len))) return 'foreign';
  }
  return 'query';
}

function ownership(url, ctx) {
  const u = String(url || '');
  if (!u || !ctx) return 'query';
  const aid = String(ctx.aid);
  const cid = String(ctx.cid);

  const prod = PROD_PATH_RE.exec(u);
  if (prod) return classifyProdBody(prod[1], aid, cid);

  // Non-prod shapes (CC files) only get a standalone id check, with digit
  // boundaries so a short id cannot match inside a longer number.
  const hasAid = mentionsNumber(u, aid);
  const hasCid = mentionsNumber(u, cid);
  if (hasAid && hasCid) return 'verified';
  if (hasAid) return 'foreign';
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
    // Diagnostics only: a cross-video response is either dropped as foreign
    // (id-bearing prod path) or visible here as query-bound (hash-only file).
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
  if (dropped) notes.push(`${dropped} 条 URL 归属不符（其他分 P / 其他视频），已丢弃`);
  return { tracks, note: notes.join(' · ') };
}

BS.resolvers = BS.resolvers || {};
BS.resolvers.dmView = { name: 'dm-view', discover, ownership };
