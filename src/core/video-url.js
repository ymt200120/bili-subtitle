/*
 * Video URL parsing for www.bilibili.com SPA routes.
 *
 * Supported:
 *   /video/BVxxxxxxxxxx (optionally ?p=N)
 *   /list/BVxxxxxxxxxx?p=N
 *   /list/watchlater?bvid=BVxxxxxxxxxx&p=N
 *   /list/ml123456?bvid=BVxxxxxxxxxx&p=N
 *   /list/<uid>?bvid=BVxxxxxxxxxx&p=N
 *
 * Playlist `oid` is navigation metadata rather than a stable part selector;
 * page identity is therefore still bvid + p, just like the regular routes.
 * Host and route are validated here rather than relying on the current page.
 */

const BILIBILI_ORIGIN_RE = /^(?:https?:)?\/\/(?:www\.)?bilibili\.com(?=\/|\?|$)/i;
const BV_ID_RE = /^BV[0-9A-Za-z]{10}$/;
// Keep the established path-route acceptance shape; query bvids use the
// stricter canonical identifier check above.
const VIDEO_PATH_RE = /^\/(?:video|list)\/(BV[0-9A-Za-z]+)\/?$/;
const PLAYLIST_PATH_RE = /^\/list\/(?:watchlater|ml\d+|\d+)\/?$/;
function parsePage(params) {
  const value = params.get('p');
  if (!/^\d+$/.test(String(value || ''))) return 1;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

function parseVideoUrl(href) {
  const raw = String(href || '');
  if (!raw) return null;

  const url = raw.split('#', 1)[0];
  const originMatch = url.match(BILIBILI_ORIGIN_RE);
  if (!originMatch) return null;

  const routeAndQuery = url.slice(originMatch[0].length);
  const queryStart = routeAndQuery.indexOf('?');
  const path = queryStart < 0 ? routeAndQuery : routeAndQuery.slice(0, queryStart);
  const query = queryStart < 0 ? '' : routeAndQuery.slice(queryStart + 1);
  const params = typeof URLSearchParams === 'function' ? new URLSearchParams(query) : null;
  if (!params) return null;
  const pathMatch = path.match(VIDEO_PATH_RE);

  if (pathMatch) {
    return { bvid: pathMatch[1], page: parsePage(params) };
  }

  if (!PLAYLIST_PATH_RE.test(path)) return null;
  const bvid = params.get('bvid');
  if (!BV_ID_RE.test(String(bvid || ''))) return null;
  return { bvid, page: parsePage(params) };
}

function isVideoPage(href) {
  return parseVideoUrl(href) !== null;
}

BS.parseVideoUrl = parseVideoUrl;
BS.isVideoPage = isVideoPage;
