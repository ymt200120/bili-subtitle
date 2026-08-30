/*
 * WBI request signing for signed Bilibili web endpoints.
 *
 * Protocol (docs/PROTOCOL.md §WBI, cross-checked against the community
 * reference and validated by deterministic test vectors):
 *  - GET /x/web-interface/nav exposes data.wbi_img.img_url / sub_url even
 *    when not logged in (code -101); the file names are img_key / sub_key.
 *  - mixin_key = first 32 chars of (img_key + sub_key) permuted through
 *    MIXIN_KEY_ENC_TAB.
 *  - w_rid = md5(sorted, url-encoded query including wts, plus mixin_key).
 *    Values are stripped of !'()* before encoding.
 *
 * Keys rotate server-side, so they are cached briefly (TTL 15 min) and
 * invalidated on signature rejections; the caller retries exactly once.
 * Cookie/login state is carried by the browser itself, never read here.
 */

const NAV_API = 'https://api.bilibili.com/x/web-interface/nav';
const KEY_TTL_MS = 15 * 60 * 1000;

// Fixed permutation from the community protocol reference (verified by
// test vector; see docs/PROTOCOL.md §WBI).
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

function getMixinKey(imgKey, subKey) {
  const raw = String(imgKey) + String(subKey);
  let out = '';
  for (const idx of MIXIN_KEY_ENC_TAB) {
    if (idx < raw.length) out += raw[idx];
  }
  return out.slice(0, 32);
}

function encodeWbiValue(value) {
  return encodeURIComponent(String(value).replace(/[!'()*]/g, ''));
}

function signParams(params, mixinKey, wts) {
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeWbiValue(all[key])}`)
    .join('&');
  return { query, wts, wRid: BS.md5(query + mixinKey) };
}

function keyFromUrl(url) {
  const tail = String(url || '').split('?')[0].split('/').pop() || '';
  return tail.replace(/\.[a-z0-9]+$/i, '');
}

const wbiState = { keys: null, fetchedAt: 0, pending: null };

async function fetchKeys(net) {
  // nav returns code -101 when anonymous but still carries wbi_img.
  const data = await net.getJson(NAV_API, { phase: 'wbi-nav' });
  const img = data && data.data && data.data.wbi_img;
  const imgKey = keyFromUrl(img && img.img_url);
  const subKey = keyFromUrl(img && img.sub_url);
  if (!imgKey || !subKey) {
    throw new Error('nav 响应缺少 wbi_img 密钥，无法完成 WBI 签名');
  }
  wbiState.keys = { imgKey, subKey, mixinKey: getMixinKey(imgKey, subKey) };
  wbiState.fetchedAt = Date.now();
  return wbiState.keys;
}

async function getKeys(net) {
  if (wbiState.keys && Date.now() - wbiState.fetchedAt < KEY_TTL_MS) {
    return wbiState.keys;
  }
  if (!wbiState.pending) {
    wbiState.pending = fetchKeys(net).finally(() => {
      wbiState.pending = null;
    });
  }
  return wbiState.pending;
}

function invalidateKeys() {
  wbiState.keys = null;
  wbiState.fetchedAt = 0;
}

// Sign params for one request. `wts` is seconds; injectable via opts for tests.
async function sign(net, params, opts = {}) {
  const keys = await getKeys(net);
  const wts = opts.wts != null ? opts.wts : Math.floor(Date.now() / 1000);
  return { keys, ...signParams(params, keys.mixinKey, wts) };
}

BS.wbi = {
  NAV_API,
  MIXIN_KEY_ENC_TAB,
  getMixinKey,
  signParams,
  sign,
  getKeys,
  invalidateKeys,
  _state: wbiState // exposed for tests (TTL manipulation)
};
