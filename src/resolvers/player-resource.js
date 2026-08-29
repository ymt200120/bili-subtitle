/*
 * Strategy C (last resort) - Player resource capture.
 *
 * The player's own subtitle requests (aisubtitle.hdslb.com,
 * subtitle.bilibili.com, /bfs/subtitle/) show up as PerformanceResource
 * entries. Entries are captured event-driven via PerformanceObserver
 * (buffered: true), capped, and cleared on SPA navigation so a previous
 * video's URLs can never be reused for the current one.
 *
 * Candidates are validated by fetching; only URLs that parse into cues
 * are accepted. Ownership check: subtitle URLs usually embed aid/cid;
 * after an in-tab navigation we only accept URLs that match the current
 * context to avoid cross-video contamination.
 */

const SUBTITLE_URL_RE =
  /aisubtitle\.hdslb\.com|subtitle\.bilibili\.com|\/bfs\/subtitle\//;
const MAX_ENTRIES = 50;
const MAX_PROBES = 8;

const capture = {
  entries: [],
  navigated: false,
  observer: null,

  remember(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    if (!SUBTITLE_URL_RE.test(rawUrl)) return;
    if (this.entries.some((e) => e.url === rawUrl)) return;
    this.entries.push({ url: rawUrl, time: Date.now() });
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
    this.navigated = true;
  }
};

function matchesNumber(url, number) {
  if (!number) return false;
  return new RegExp(`(^|[^0-9])${number}([^0-9]|$)`).test(String(url));
}

async function probe(env, item) {
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
    source: 'player-resource'
  });
  track.cues = cues;
  return track;
}

async function discover(ctx, env) {
  const all = env.getEntries ? env.getEntries() : capture.list();
  const candidates = all.filter((e) => SUBTITLE_URL_RE.test(e.url));

  if (!candidates.length) {
    return {
      tracks: [],
      note: '尚无播放器字幕请求（可在播放器中打开 CC 字幕后重试）',
      soft: true
    };
  }

  const owned = candidates.filter(
    (e) => matchesNumber(e.url, ctx.cid) || matchesNumber(e.url, ctx.aid)
  );

  let pool;
  if (owned.length) {
    pool = owned;
  } else if (capture.navigated) {
    return {
      tracks: [],
      note: '捕获到的字幕 URL 与当前视频不匹配（来自上一个视频，已跳过）'
    };
  } else {
    pool = candidates;
  }

  const tracks = [];
  for (const item of pool.slice(0, MAX_PROBES)) {
    try {
      tracks.push(await probe(env, item));
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
BS.resolvers.playerResource = { name: 'player-resource', discover };
BS.resourceCapture = capture;
