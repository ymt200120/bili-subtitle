/*
 * Core data model + track scoring/selection.
 */

function makeVideoContext({ bvid, aid, cid, page, pageCount, title }) {
  return {
    bvid: String(bvid || ''),
    aid: Number(aid) || 0,
    cid: Number(cid) || 0,
    page: Number(page) || 1,
    pageCount: Number(pageCount) || 1,
    title: String(title || '')
  };
}

function makeTrack({ id, lan, lanDoc, url, source, aiType, aiStatus }) {
  return {
    id: id == null ? '' : String(id),
    lan: String(lan || ''),
    lanDoc: String(lanDoc || lan || ''),
    url: BS.normalizeSubtitleUrl(url),
    source: String(source || ''),
    aiType: aiType == null ? null : aiType,
    aiStatus: aiStatus == null ? null : aiStatus
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
BS.normalizeSubtitleUrl = normalizeSubtitleUrl;
BS.languageScore = languageScore;
BS.mergeTracks = mergeTracks;
BS.sortTracks = sortTracks;
