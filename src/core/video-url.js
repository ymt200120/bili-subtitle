/*
 * Video URL parsing for www.bilibili.com SPA routes.
 *
 * Supported: /video/BVxxxxxxxxxx (optionally ?p=N) and /list/BVxxxxxxxxxx?p=N.
 * Host is validated (www.bilibili.com); pure string logic so it also runs
 * in the vm test sandbox.
 */

const BV_URL_RE = /^(?:https?:)?\/\/(?:www\.)?bilibili\.com\/(?:video|list)\/(BV[0-9A-Za-z]+)/;
const P_RE = /[?&]p=(\d+)/;

function parseVideoUrl(href) {
  const raw = String(href || '');
  if (!raw) return null;

  const url = raw.split('#', 1)[0];
  const match = url.match(BV_URL_RE);
  if (!match) return null;

  let page = 1;
  const pMatch = url.match(P_RE);
  if (pMatch) {
    const n = Number(pMatch[1]);
    if (Number.isFinite(n) && n >= 1) page = Math.floor(n);
  }

  return { bvid: match[1], page };
}

function isVideoPage(href) {
  return parseVideoUrl(href) !== null;
}

BS.parseVideoUrl = parseVideoUrl;
BS.isVideoPage = isVideoPage;
