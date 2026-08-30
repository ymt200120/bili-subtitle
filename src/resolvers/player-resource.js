/*
 * Strategy C (last resort) - Player resource capture.
 *
 * The player's own subtitle requests (aisubtitle.hdslb.com,
 * subtitle.bilibili.com, /bfs/subtitle/) show up as PerformanceResource
 * entries. Entries are captured event-driven via PerformanceObserver
 * (buffered: true), capped, and cleared on SPA navigation.
 *
 * A captured URL is used only when BOTH constraints hold:
 *  1. navigation epoch: the entry was observed during the current video's
 *     session (entries carry the capture epoch; SPA navigation bumps it,
 *     so late observer callbacks for pre-navigation requests are excluded);
 *  2. ownership: the URL embeds the current cid, or (on single-page
 *     videos, where the aid uniquely identifies the part) the current aid.
 * The resource buffer can hold subtitle URLs of *other* videos (playlist
 * prefetch, script re-injection replays), so URLs without both proofs are
 * never probed. This trades a rare fallback (id-less CC URLs) for never
 * showing another video's subtitles.
 */

const SUBTITLE_URL_RE =
  /aisubtitle\.hdslb\.com|subtitle\.bilibili\.com|\/bfs\/subtitle\//;
const MAX_ENTRIES = 50;
const MAX_PROBES = 8;

const capture = {
  entries: [],
  epoch: 0,
  observer: null,

  remember(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    if (!SUBTITLE_URL_RE.test(rawUrl)) return;
    if (this.entries.some((e) => e.url === rawUrl)) return;
    this.entries.push({ url: rawUrl, time: Date.now(), epoch: this.epoch });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  },

  install() {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.remember(entry.name);
        }
      });
      po.observe({ type: 'resource', buffered: true });
      this.observer = po;
    } catch (e) {
      BS.warn('PerformanceObserver 不可用', e && e.message);
    }
    if (typeof performance !== 'undefined' && performance.getEntriesByType) {
      try {
        for (const entry of performance.getEntriesByType('resource')) {
          this.remember(entry.name);
        }
      } catch (_) { /* ignore */ }
    }
  },

  list() {
    return this.entries.slice().sort((a, b) => b.time - a.time);
  },

  reset() {
    this.entries = [];
    this.epoch++;
  }
};

function matchesNumber(url, number) {
  if (!number) return false;
  return new RegExp(`(^|[^0-9])${number}([^0-9]|$)`).test(String(url));
}

/*
 * Ownership evidence: the URL embeds the current cid, or it embeds the
 * aid on a single-page video. Multi-page videos share one aid across all
 * parts, so an aid-only match could be another part's subtitles.
 */
function ownsUrl(url, ctx) {
  if (!url || !ctx) return false;
  if (matchesNumber(url, ctx.cid)) return true;
  const singlePage = !ctx.pageCount || Number(ctx.pageCount) <= 1;
  return singlePage && matchesNumber(url, ctx.aid);
}

async function probe(ctx, env, item) {
  const data = await env.net.getJson(item.url, { phase: 'player-resource' });
  const cues = BS.parseSubtitleJson(data);
  if (!cues.length) {
    throw new Error('字幕内容为空');
  }
  const track = BS.makeTrack({
    id: 'captured',
    lan: /ai_subtitle|aisubtitle/.test(item.url) ? 'ai-zh' : '',
    lanDoc: '播放器已加载字幕',
    url: item.url,
    source: 'player-resource',
    contextKey: ctx.contextKey,
    trust: BS.trust.CURRENT_PLAYER
  });
  track.cues = cues;
  return track;
}

async function discover(ctx, env) {
  const all = env.getEntries ? env.getEntries() : capture.list();
  // Constraint 1 of 2: only entries observed in the current navigation
  // epoch (this video's session) are considered at all.
  const currentEpoch = capture.epoch;
  const urlMatches = all.filter((e) => SUBTITLE_URL_RE.test(e.url));
  const staleEpochCount = urlMatches.filter((e) => e.epoch !== currentEpoch).length;
  const candidates = urlMatches.filter((e) => e.epoch === currentEpoch);

  if (!candidates.length) {
    if (staleEpochCount > 0) {
      return {
        tracks: [],
        note: `捕获到 ${staleEpochCount} 条字幕 URL，但属于上一次导航会话（与当前视频不匹配），已跳过`
      };
    }
    return {
      tracks: [],
      note: '尚无播放器字幕请求（可在播放器中打开 CC 字幕后重试）',
      soft: true
    };
  }

  const pool = candidates.filter((e) => ownsUrl(e.url, ctx));
  if (!pool.length) {
    return {
      tracks: [],
      note: `捕获到 ${candidates.length} 条字幕 URL，但与当前视频不匹配（已跳过，避免串用其他视频的字幕）`
    };
  }

  const tracks = [];
  for (const item of pool.slice(0, MAX_PROBES)) {
    try {
      tracks.push(await probe(ctx, env, item));
    } catch (e) {
      BS.log('捕获 URL 无效，跳过', BS.sanitizeUrl(item.url), e && e.message);
    }
  }

  if (!tracks.length) {
    return { tracks: [], note: '捕获的 URL 均无法读取（可能已过期）' };
  }
  return { tracks, note: `${tracks.length} 条可读取` };
}

BS.resolvers = BS.resolvers || {};
BS.resolvers.playerResource = { name: 'player-resource', discover, ownsUrl };
BS.resourceCapture = capture;
