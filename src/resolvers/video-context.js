/*
 * VideoContext resolver: URL -> { bvid, aid, cid, page, title }.
 *
 * Prefers the page-embedded __INITIAL_STATE__ (zero extra requests),
 * falls back to the public view API. In SPA state the embedded data can
 * lag behind navigation, so a bvid mismatch sends us to the API.
 */

const VIEW_API = 'https://api.bilibili.com/x/web-interface/view?bvid=';

function pickPage(pages, wanted) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  return (
    pages.find((x) => Number(x && x.page) === wanted) ||
    pages[wanted - 1] ||
    pages[0]
  );
}

function contextFromVideoData(videoData, page) {
  if (!videoData || !videoData.bvid) return null;
  const pages = Array.isArray(videoData.pages) ? videoData.pages : [];
  const selected = pickPage(pages, page);
  const cid = Number((selected && selected.cid) || videoData.cid) || 0;
  if (!cid) return null;
  const base = String(videoData.title || '');
  const multi = pages.length > 1 && selected && selected.part;
  return BS.makeVideoContext({
    bvid: videoData.bvid,
    aid: videoData.aid,
    cid,
    page: Number((selected && selected.page) || page || 1),
    title: multi ? `${base} P${selected.page || page} ${selected.part}` : base
  });
}

async function resolve(env) {
  const parsed = BS.parseVideoUrl(env.href);
  if (!parsed) {
    throw new Error('当前页面不是 B 站视频页（未识别到 BV 号）');
  }

  const inline = contextFromVideoData(
    env.initialState && env.initialState.videoData,
    parsed.page
  );
  if (inline && inline.bvid === parsed.bvid) {
    return inline;
  }

  const data = await env.net.getJson(VIEW_API + encodeURIComponent(parsed.bvid), {
    phase: 'video-context'
  });
  if (!data || data.code !== 0 || !data.data) {
    throw new Error(`视频信息获取失败：code ${data && data.code} ${data && data.message}`);
  }
  const ctx = contextFromVideoData(data.data, parsed.page);
  if (!ctx) throw new Error('视频信息中没有可用的 cid');
  return ctx;
}

BS.resolvers = BS.resolvers || {};
BS.resolvers.videoContext = { name: 'video-context', resolve };
