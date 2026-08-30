/*
 * Core data model + track scoring/selection.
 */

/*
 * Resolver trust levels. Availability (a resolver returned tracks) is
 * separate from authority (the tracks are provably bound to the current
 * video). Only winnable tracks may become the winner or enter the
 * selectable track list.
 *
 * SIGNED_METADATA: metadata requested through a WBI-signed endpoint.
 * CURRENT_VIDEO_METADATA: metadata requested with the current aid+cid in
 *   the query (the endpoint binds the request to the video).
 * CURRENT_PLAYER_RESOURCE: URL captured from the player's own request and
 *   proven to embed the current cid/aid (see player-resource.ownsUrl).
 * UNTRUSTED_LEGACY: unsigned /x/player/v2 — observed in the wild (risk
 *   control degradation) returning HTTP 200 with valid-looking subtitles
 *   that belong to a DIFFERENT video. Diagnostic only; never committable.
 */
const TRUST = {
  SIGNED: 'SIGNED_METADATA',
  CURRENT_VIDEO: 'CURRENT_VIDEO_METADATA',
  CURRENT_PLAYER: 'CURRENT_PLAYER_RESOURCE',
  UNTRUSTED_LEGACY: 'UNTRUSTED_LEGACY'
};

function isWinnableTrust(trust) {
  return (
    trust === TRUST.SIGNED ||
    trust === TRUST.CURRENT_VIDEO ||
    trust === TRUST.CURRENT_PLAYER
  );
}

function makeVideoContext({ bvid, aid, cid, page, pageCount, title }) {
  const bvidStr = String(bvid || '');
  const cidNum = Number(cid) || 0;
  return {
    bvid: bvidStr,
    aid: Number(aid) || 0,
    cid: cidNum,
    page: Number(page) || 1,
    pageCount: Number(pageCount) || 1,
    title: String(title || ''),
    // Stable identity of (video, part). Every track / result / document
    // must carry this to be committable for this context.
    contextKey: `${bvidStr}:${cidNum}`
  };
}

function makeTrack({ id, lan, lanDoc, url, source, aiType, aiStatus, contextKey, trust }) {
  return {
    id: id == null ? '' : String(id),
    lan: String(lan || ''),
    lanDoc: String(lanDoc || lan || ''),
    url: BS.normalizeSubtitleUrl(url),
    source: String(source || ''),
    aiType: aiType == null ? null : aiType,
    aiStatus: aiStatus == null ? null : aiStatus,
    contextKey: String(contextKey || ''),
    trust: String(trust || '')
  };
}

function normalizeSubtitleUrl(url) {
  const u = String(url || '');
  if (!u) return '';
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('http://')) return 'https://' + u.slice(7);
  return u;
}

/*
 * Higher score = better default pick. ai-zh is the usual want;
 * human CC zh beats machine zh; everything else is a fallback.
 */
function languageScore(track) {
  const lan = String(track.lan || '').toLowerCase();
  const doc = String(track.lanDoc || '').toLowerCase();

  if (lan === 'ai-zh') return 100;
  if (lan.startsWith('ai-')) return 80;

  if (lan === 'zh-cn' || lan === 'zh-hans' || lan === 'zh') return 95;
  if (lan.startsWith('zh')) return 90;

  if (doc.includes('中文') || doc.includes('汉语')) return 92;

  if (lan.startsWith('en')) return 60;
  return 10;
}

function compareTracks(a, b) {
  return languageScore(b) - languageScore(a);
}

function sortTracks(tracks) {
  return tracks.slice().sort(compareTracks);
}

function mergeTracks(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const t of list || []) {
      if (!t || !t.url) continue;
      const key = `${t.lan}|${t.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return sortTracks(out);
}

BS.makeVideoContext = makeVideoContext;
BS.makeTrack = makeTrack;
BS.trust = TRUST;
BS.isWinnableTrust = isWinnableTrust;
BS.normalizeSubtitleUrl = normalizeSubtitleUrl;
BS.languageScore = languageScore;
BS.mergeTracks = mergeTracks;
BS.sortTracks = sortTracks;
